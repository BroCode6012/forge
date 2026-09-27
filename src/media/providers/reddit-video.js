const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const BaseProvider = require('./base-provider');
const config = require('../../settings/config');
const { createByteLimitTransform, requestSafeStream } = require('../../security/safe-download');
const {
    findYtdlp,
    execYtdlpWithRetry,
    isPermanentYtdlpError,
    summarizeYtdlpError,
    normalizeMaxHeight,
    buildBestVideoFormat,
    buildBestVideoOnlyFormat,
    describeMaxHeight,
} = require('./ytdlp-utils');

// ─── Reddit Video Provider ──────────────────────────────────────────
// Keyless source: scrapes old.reddit.com's server-rendered search results.
// One HTML response includes the post permalink, target URL, duration, score,
// subreddit, and title, so discovery does not depend on Reddit's blocked JSON
// endpoints or on one follow-up request per candidate.

// Domains yt-dlp can download from (found in Reddit posts)
const VIDEO_DOMAINS = new Set([
    'youtube.com', 'youtu.be', 'streamable.com', 'gfycat.com',
    'v.redd.it', 'clips.twitch.tv', 'vimeo.com', 'dailymotion.com',
    'imgur.com', 'i.imgur.com', 'redgifs.com',
]);

// Do not reject Reddit candidates by title/subreddit before vision. Reddit
// titles are often jokes, shorthand, or repost commentary while the media is
// still usable B-roll. Non-video extraction remains structural; content quality
// is handled by ranking, download, and vision scoring.

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];
const REDDIT_SEARCH_VARIANTS = Math.max(1, Math.min(5, parseInt(process.env.REDDIT_SEARCH_VARIANTS || '3', 10) || 3));
const REDDIT_SEARCH_CACHE_TTL_MS = Math.max(60_000, Math.min(30 * 60_000, parseInt(process.env.REDDIT_SEARCH_CACHE_TTL_MS || String(10 * 60_000), 10) || 10 * 60_000));
const REDDIT_SEARCH_CACHE_MAX = Math.max(20, Math.min(200, parseInt(process.env.REDDIT_SEARCH_CACHE_MAX || '80', 10) || 80));
const REDDIT_SOFT_TERMS = new Set([
    'global', 'trade', 'maritime', 'logistics', 'route', 'routes', 'shipping',
    'security', 'crisis', 'risk', 'risks', 'critical', 'chokepoint', 'choke',
    'point', 'backup', 'alternative', 'around', 'nearly', 'world', 'footage',
    'broll', 'roll', 'video',
]);

class RedditVideoProvider extends BaseProvider {
    constructor() {
        super('Reddit Videos', 'video');
        this._ytdlpPath = null;
        this._ytdlpChecked = false;
        this._ytdlpAvailable = false;
        this._lastYtdlpCheckAt = 0;
        this._ytdlpCheckCooldownMs = 30000;
        this._scriptContext = null;
        this._userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        // Reddit silently strips post results from otherwise-200 old.reddit
        // responses when requests arrive in a burst. The promise tail makes the
        // read/wait/write sequence atomic across parallel scene searches.
        this._lastRequestTime = 0;
        this._minRequestGap = Math.max(
            2000,
            Math.min(30000, parseInt(process.env.REDDIT_REQUEST_GAP_MS || '4000', 10) || 4000)
        );
        this._requestTail = Promise.resolve();
        this._rateLimited = false;
        this._rateLimitUntil = 0;
        this._cookieJar = '';
        this._searchCache = new Map();
        this._lastCooldownLogAt = 0;
    }

    setContext(scriptContext) {
        this._scriptContext = scriptContext;
    }

    isAvailable() {
        const shouldCheck = !this._ytdlpChecked
            || (!this._ytdlpAvailable && (Date.now() - this._lastYtdlpCheckAt) > this._ytdlpCheckCooldownMs);

        if (shouldCheck) {
            this._ytdlpChecked = true;
            this._ytdlpAvailable = false;
            this._lastYtdlpCheckAt = Date.now();

            this._ytdlpPath = findYtdlp({ logPrefix: 'Reddit' });
            this._ytdlpAvailable = !!this._ytdlpPath;
        }
        return this._ytdlpAvailable;
    }

    // ─── Rate limiting ──────────────────────────────────────────────────

    async _throttle() {
        let release;
        const previous = this._requestTail;
        this._requestTail = new Promise(resolve => { release = resolve; });

        await previous.catch(() => {});
        try {
            if (this._cooldownRemainingMs() > 0) return false;

            const elapsed = Date.now() - this._lastRequestTime;
            if (elapsed < this._minRequestGap) {
                await new Promise(r => setTimeout(r, this._minRequestGap - elapsed));
            }
            if (this._cooldownRemainingMs() > 0) return false;

            this._lastRequestTime = Date.now();
            return true;
        } finally {
            release();
        }
    }

    _cooldownRemainingMs() {
        if (!this._rateLimited) return 0;
        const remaining = this._rateLimitUntil - Date.now();
        if (remaining > 0) return remaining;
        this._rateLimited = false;
        this._minRequestGap = 6000; // after 429, use 6s gap going forward
        console.log(`  [Reddit] Cooldown expired, resuming with ${this._minRequestGap / 1000}s gap`);
        return 0;
    }

    _logCooldownSkip(context) {
        const remaining = this._cooldownRemainingMs();
        if (remaining <= 0) return;
        const now = Date.now();
        if (now - this._lastCooldownLogAt < 5000) return;
        this._lastCooldownLogAt = now;
        console.log(`  [Reddit] Skipping ${context} — cooldown ${Math.ceil(remaining / 1000)}s left`);
    }

    _cacheKey(keyword) {
        return this._cleanQuery(keyword).toLowerCase();
    }

    _cloneResults(results) {
        return (results || []).map(r => ({ ...r }));
    }

    _getCachedSearch(keyword) {
        const key = this._cacheKey(keyword);
        if (!key) return null;
        const cached = this._searchCache.get(key);
        if (!cached) return null;
        if (Date.now() - cached.at > REDDIT_SEARCH_CACHE_TTL_MS) {
            this._searchCache.delete(key);
            return null;
        }
        console.log(`  [Reddit] Search cache hit for "${keyword}" (${cached.results.length} result(s))`);
        return this._cloneResults(cached.results);
    }

    _setCachedSearch(keyword, results) {
        const key = this._cacheKey(keyword);
        if (!key || !Array.isArray(results) || results.length === 0) return;
        this._searchCache.set(key, { at: Date.now(), results: this._cloneResults(results) });
        if (this._searchCache.size <= REDDIT_SEARCH_CACHE_MAX) return;
        const oldestKey = this._searchCache.keys().next().value;
        if (oldestKey) this._searchCache.delete(oldestKey);
    }

    _onRateLimited(status = 429) {
        const configuredCooldown = parseInt(process.env.REDDIT_RATE_LIMIT_COOLDOWN_MS || '20000', 10);
        const baseCooldown = Number.isFinite(configuredCooldown) ? configuredCooldown : 20_000;
        const cooldownMs = Math.max(status === 403 ? 60_000 : 10_000, baseCooldown);
        this._rateLimited = true;
        this._rateLimitUntil = Date.now() + cooldownMs;
        this._minRequestGap = Math.min(12000, this._minRequestGap + 2000);
        console.log(`  [Reddit] HTTP ${status} — ${Math.ceil(cooldownMs / 1000)}s cooldown, gap now ${this._minRequestGap / 1000}s`);
    }

    _onSilentRateLimited() {
        const configured = parseInt(process.env.REDDIT_SILENT_RATE_LIMIT_COOLDOWN_MS || '20000', 10);
        const cooldownMs = Math.max(10_000, Number.isFinite(configured) ? configured : 20_000);
        this._rateLimited = true;
        this._rateLimitUntil = Date.now() + cooldownMs;
        this._minRequestGap = Math.max(this._minRequestGap, 6000);
        console.log(`  [Reddit] old.reddit posts stayed stripped after a paced retry — ${Math.ceil(cooldownMs / 1000)}s cooldown`);
    }

    // ─── Search ─────────────────────────────────────────────────────────

    /**
     * Global old.reddit search, then a small relaxed-query ladder.
     */
    async search(keyword) {
        const queries = this._buildSearchQueries(keyword);
        for (let i = 0; i < queries.length; i++) {
            const query = queries[i];
            if (i > 0) {
                console.log(`  [Reddit] Relaxed search ${i + 1}/${queries.length}: "${query}"`);
            }
            const cached = this._getCachedSearch(query);
            if (cached) return cached;
            if (this._cooldownRemainingMs() > 0) {
                this._logCooldownSkip('search');
                continue;
            }

            const htmlResults = await this._searchHtml(query);
            if (htmlResults && htmlResults.length > 0) {
                this._setCachedSearch(query, htmlResults);
                return this._cloneResults(htmlResults);
            }
            if (this._cooldownRemainingMs() > 0) {
                this._logCooldownSkip('relaxed searches');
                continue;
            }
        }
        return [];
    }

    // ─── old.reddit HTML search ─────────────────────────────────────────
    // The modern search page is a JavaScript shell. old.reddit still renders
    // complete post cards on the server, including enough metadata to build
    // candidates without touching the blocked *.json endpoints.

    async _searchHtml(keyword) {
        const timeoutMs = Math.max(
            5000,
            Math.min(30000, parseInt(process.env.REDDIT_SEARCH_TIMEOUT_MS || '12000', 10) || 12000)
        );
        const startedAt = Date.now();
        let pacedRetry = false;

        for (let attempt = 0; attempt < 2; attempt++) {
            const canProceed = await this._throttle();
            if (!canProceed) {
                this._logCooldownSkip('old.reddit scrape');
                return null;
            }

            const ua = this._userAgent;
            let html = '';
            try {
                const response = await axios.get('https://old.reddit.com/search', {
                    params: {
                        q: keyword,
                        sort: 'relevance',
                        t: 'all',
                        type: 'link',
                        include_over_18: 'off',
                    },
                    headers: {
                        'User-Agent': ua,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Cache-Control': 'no-cache',
                        'Referer': 'https://old.reddit.com/',
                        ...(this._cookieJar ? { Cookie: this._cookieJar } : {}),
                    },
                    timeout: timeoutMs,
                    maxRedirects: 5,
                    maxContentLength: 2 * 1024 * 1024,
                });
                this._mergeCookies(response.headers?.['set-cookie']);
                html = typeof response.data === 'string' ? response.data : '';
            } catch (error) {
                const status = Number(error.response?.status || 0);
                if (status === 429 || status === 403) this._onRateLimited(status);
                else console.log(`  [Reddit] old.reddit search error: ${error.message}`);
                return null;
            }

            const inspection = this._inspectOldRedditHtml(html);
            if (!inspection.isSearchPage) {
                if (/blocked|verification|whoa there|try again later/i.test(html)) {
                    this._onRateLimited(403);
                } else {
                    console.log(`  [Reddit] old.reddit returned an unusable HTML page (${Buffer.byteLength(html)} bytes)`);
                }
                return null;
            }

            // Silent throttling is a 200 response with subreddit cards intact but
            // the posts group emptied. Retry once through the serialized throttle;
            // a legitimate no-results query simply remains empty after that retry.
            if (inspection.looksStripped && attempt === 0) {
                pacedRetry = true;
                this._minRequestGap = Math.max(this._minRequestGap, 6000);
                console.log(`  [Reddit] old.reddit returned an empty posts group with subreddit results — paced retry`);
                continue;
            }
            if (inspection.looksStripped) {
                this._onSilentRateLimited();
                return null;
            }

            if (inspection.postBlocks.length === 0) {
                const retryNote = pacedRetry ? ' after paced retry' : '';
                console.log(`  [Reddit] No old.reddit posts for "${keyword}"${retryNote}`);
                return [];
            }

            const parsed = this._parseOldRedditResults(inspection.postBlocks);
            const scored = this._scoreUiResults(parsed, keyword);
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            const rejected = inspection.postBlocks.length - parsed.length;
            const retryNote = pacedRetry ? ' [paced retry]' : '';
            console.log(`  [Reddit] old.reddit ${elapsed}s: ${inspection.postBlocks.length} posts → ${parsed.length} videos → ${scored.length} kept (reject: ${rejected})${retryNote}`);
            return scored.slice(0, 10);
        }

        return [];
    }

    _scoreUiResults(results, keyword) {
        if (results.length === 0) return [];
        const STOP_WORDS = new Set(['the','a','an','is','are','was','were','in','on','at','to','for','of','and','or','but','with','from','by','this','that','it','its','as','be','has','had','have','been','will','would','could','should','not','no','so','if','just','about','up','out','all','one','two','how','why','what','when','who','which','do','does','did','can','new']);
        const extractWords = (text) => (text || '').toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOP_WORDS.has(w));
        const keywordWords = new Set(extractWords(keyword));
        const topicWords = new Set(extractWords(this._scriptContext?.summary || ''));
        const entityWords = new Set();
        for (const entity of (this._scriptContext?.entities || [])) {
            for (const w of extractWords(entity)) entityWords.add(w);
        }
        // Annotate with score + original UI index, then stable-sort by score.
        // UI order wins ties — that's the whole reason we scraped the page.
        return results.map((r, idx) => {
            const titleWords = extractWords(r.title);
            let relevance = 0;
            for (const word of titleWords) {
                if (keywordWords.has(word)) relevance += 3;
                else if (entityWords.has(word)) relevance += 2;
                else if (topicWords.has(word)) relevance += 1;
            }
            const engagementBonus = Math.min(2, Math.log10(Math.max(1, r._score || 0)));
            return { ...r, _relevance: relevance + engagementBonus, _uiIndex: idx };
        }).sort((a, b) => (b._relevance - a._relevance) || (a._uiIndex - b._uiIndex));
    }

    _inspectOldRedditHtml(html) {
        const source = String(html || '');
        const postStarts = [];
        let subredditCount = 0;
        const divRe = /<div\b([^>]*)>/gi;
        let match;

        while ((match = divRe.exec(source)) !== null) {
            const attrs = match[1] || '';
            const classes = new Set(this._classTokens(this._getHtmlAttribute(attrs, 'class')));
            if (classes.has('search-result-subreddit')) subredditCount++;
            if (!classes.has('search-result-link')) continue;

            const fullname = this._getHtmlAttribute(attrs, 'data-fullname');
            if (!/^t3_[a-z0-9]+$/i.test(fullname)) continue;
            postStarts.push({
                index: match.index,
                openingTag: match[0],
                fullname,
            });
        }

        const postBlocks = postStarts.map((start, index) => ({
            openingTag: start.openingTag,
            fullname: start.fullname,
            html: source.slice(start.index, postStarts[index + 1]?.index || source.length),
        }));
        const hasPostsHeading = /class=["'][^"']*\bsearch-header-label\b[^"']*["'][^>]*>\s*posts\s*</i.test(source);
        const emptyPostsGroup = /class=["'][^"']*\bsearch-header-label\b[^"']*["'][^>]*>\s*posts\s*<[\s\S]{0,7000}?<div\s+class=["']contents["']>\s*<\/div>/i.test(source);

        return {
            isSearchPage: /\bcombined-search-page\b/i.test(source)
                && /\bsearch-result-listing\b/i.test(source),
            postBlocks,
            subredditCount,
            looksStripped: postBlocks.length === 0
                && subredditCount > 0
                && hasPostsHeading
                && emptyPostsGroup,
        };
    }

    _parseOldRedditResults(postBlocks) {
        const results = [];
        const seen = new Set();

        for (const post of postBlocks || []) {
            const block = String(post?.html || '');
            const fullname = String(post?.fullname || '');
            const id = fullname.replace(/^t3_/i, '');
            if (!id || seen.has(id)) continue;
            seen.add(id);

            if (/\b(?:over18|nsfw)\b/i.test(post.openingTag || '')
                || /class=["'][^"']*\bnsfw-stamp\b/i.test(block)) {
                continue;
            }

            const titleAnchor = this._findElementByClass(block, 'a', 'search-title');
            const permalink = this._normalizeRedditPermalink(
                this._getHtmlAttribute(titleAnchor?.attrs || '', 'href')
            );
            if (!permalink) continue;

            const title = this._stripHtml(titleAnchor?.inner || '').substring(0, 200);
            const targetAnchor = this._findElementByClass(block, 'a', 'search-link');
            const targetUrl = this._decodeHtml(
                this._getHtmlAttribute(targetAnchor?.attrs || '', 'href')
            ).trim();
            const durationElement = this._findElementByClass(block, 'div', 'duration-overlay');
            const scoreElement = this._findElementByClass(block, 'span', 'search-score');
            const subredditElement = this._findElementByClass(block, 'a', 'search-subreddit-link');
            const duration = this._parseDuration(this._stripHtml(durationElement?.inner || ''));
            const score = this._parseScore(this._stripHtml(scoreElement?.inner || ''));

            if (score !== null && score < 3) continue;
            if (duration > 0 && duration < 3) continue;

            const targetHost = this._hostname(targetUrl);
            const isRedditHosted = targetHost === 'v.redd.it';
            const isExternalVideo = this._isSupportedVideoUrl(targetUrl);
            if (!isRedditHosted && !isExternalVideo && duration <= 0) continue;

            // A duration overlay means old.reddit rendered a playable video. If
            // its target host is unfamiliar, let yt-dlp resolve the Reddit post
            // instead of handing an unknown outbound URL to the downloader.
            const usePermalink = isRedditHosted || (duration > 0 && !isExternalVideo);
            const canonicalPermalink = `https://www.reddit.com${permalink}`;
            const videoUrl = usePermalink ? canonicalPermalink : targetUrl;
            if (!videoUrl) continue;

            let subreddit = this._stripHtml(subredditElement?.inner || '').replace(/^r\//i, '');
            if (!subreddit) subreddit = (permalink.match(/^\/r\/([^/]+)/i) || [])[1] || '';

            const cachedMeta = duration > 0 ? {
                duration,
                width: 0,
                height: 0,
                title,
                _redditVideoUrl: isRedditHosted ? targetUrl : null,
            } : null;

            results.push({
                id: `reddit-${id}`,
                url: videoUrl,
                title,
                width: 1920,
                height: 1080,
                duration,
                _duration: duration,
                _subreddit: subreddit,
                _score: score || 0,
                _isRedditHosted: isRedditHosted,
                _permalink: permalink,
                _redditVideoUrl: isRedditHosted ? targetUrl : null,
                _fallbackUrl: null,
                _cachedMeta: cachedMeta,
            });

            if (results.length >= 12) break;
        }

        return results;
    }

    _findElementByClass(html, tagName, className) {
        const escapedTag = String(tagName || '').replace(/[^a-z0-9]/gi, '');
        if (!escapedTag) return null;
        const source = String(html || '');
        const re = new RegExp(`<${escapedTag}\\b([^>]*)>`, 'gi');
        let match;
        while ((match = re.exec(source)) !== null) {
            const classes = this._classTokens(this._getHtmlAttribute(match[1], 'class'));
            if (classes.includes(className)) {
                const closeAt = source.indexOf(`</${escapedTag}>`, re.lastIndex);
                return {
                    attrs: match[1] || '',
                    inner: closeAt >= 0 ? source.slice(re.lastIndex, closeAt) : '',
                };
            }
        }
        return null;
    }

    _getHtmlAttribute(attrs, name) {
        const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = String(attrs || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
        return match?.[2] || '';
    }

    _classTokens(value) {
        return String(value || '').split(/\s+/).map(v => v.trim()).filter(Boolean);
    }

    _decodeHtml(value) {
        const named = {
            amp: '&', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
            lt: '<', gt: '>', ndash: '\u2013', mdash: '\u2014',
            lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
            hellip: '\u2026',
        };
        return String(value || '')
            .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
                const code = parseInt(hex, 16);
                return Number.isFinite(code) ? String.fromCodePoint(code) : _;
            })
            .replace(/&#(\d+);/g, (_, decimal) => {
                const code = parseInt(decimal, 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : _;
            })
            .replace(/&([a-z]+|#39);/gi, (whole, key) => named[key.toLowerCase()] ?? whole);
    }

    _stripHtml(value) {
        return this._decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();
    }

    _parseDuration(value) {
        const parts = String(value || '').trim().split(':').map(Number);
        if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) {
            return 0;
        }
        if (parts.length === 2) return (parts[0] * 60) + parts[1];
        return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    }

    _parseScore(value) {
        const text = String(value || '').trim().toLowerCase();
        if (!text || /hidden|unavailable/.test(text)) return null;
        const match = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([km]?)/i);
        if (!match) return null;
        const multiplier = match[2].toLowerCase() === 'm' ? 1_000_000
            : match[2].toLowerCase() === 'k' ? 1_000
            : 1;
        return Math.round(Number(match[1]) * multiplier);
    }

    _normalizeRedditPermalink(value) {
        const href = this._decodeHtml(value).trim();
        if (!href) return '';
        try {
            const parsed = new URL(href, 'https://old.reddit.com');
            const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
            if (host !== 'reddit.com' && host !== 'old.reddit.com' && host !== 'new.reddit.com') return '';
            const match = parsed.pathname.match(/^(\/r\/[^/]+\/comments\/[a-z0-9]+\/[^/?#]*\/?)/i);
            if (!match) return '';
            return match[1].endsWith('/') ? match[1] : `${match[1]}/`;
        } catch (_) {
            return '';
        }
    }

    _hostname(value) {
        try {
            return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
        } catch (_) {
            return '';
        }
    }

    _isSupportedVideoUrl(value) {
        const url = String(value || '');
        const host = this._hostname(url);
        if (!host) return false;
        if (host === 'imgur.com' || host === 'i.imgur.com') {
            return /\.(?:gifv|mp4|webm)(?:$|[?#])/i.test(url);
        }
        if (Array.from(VIDEO_DOMAINS).some(domain => host === domain || host.endsWith(`.${domain}`))) {
            return true;
        }
        return /\.(?:mp4|webm|mov|m3u8)(?:$|[?#])/i.test(url);
    }

    _mergeCookies(setCookie) {
        if (!Array.isArray(setCookie) || setCookie.length === 0) return '';
        const jar = new Map();
        for (const part of String(this._cookieJar || '').split(';')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) jar.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
        }
        for (const cookie of setCookie) {
            const pair = String(cookie).split(';')[0].trim();
            const idx = pair.indexOf('=');
            if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
        }
        this._cookieJar = Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
        return this._cookieJar;
    }

    _buildSearchQueries(keyword) {
        const original = this._cleanQuery(keyword);
        const variants = [];
        const add = (value) => {
            const cleaned = this._cleanQuery(value);
            if (!cleaned) return;
            const key = cleaned.toLowerCase();
            if (!variants.some(v => v.toLowerCase() === key)) variants.push(cleaned);
        };

        add(original);

        const geo = this._extractGeoPhrase(original);
        const concrete = this._extractConcreteVisualPhrase(original);
        if (geo && concrete) add(`${geo} ${concrete}`);
        if (concrete) add(concrete);

        const words = original
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
        const deduped = [];
        for (const word of words) {
            const normalized = word.replace(/-/g, '');
            if (REDDIT_SOFT_TERMS.has(word) || REDDIT_SOFT_TERMS.has(normalized)) continue;
            if (!deduped.includes(word)) deduped.push(word);
        }
        if (deduped.length >= 2) add(`${deduped.slice(0, 5).join(' ')} footage`);

        return variants.slice(0, REDDIT_SEARCH_VARIANTS);
    }

    _cleanQuery(value) {
        return String(value || '')
            .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _extractGeoPhrase(text) {
        const value = String(text || '').toLowerCase();
        if (/\bbab[-\s]*(el|al)[-\s]*mandeb\b/.test(value)) return 'Bab el Mandeb';
        if (/\bstrait\s+of\s+hormuz\b|\bhormuz\b/.test(value)) return 'Strait of Hormuz';
        if (/\bsuez\b/.test(value)) return 'Suez Canal';
        if (/\bred\s+sea\b/.test(value)) return 'Red Sea';
        if (/\brotterdam\b/.test(value)) return 'Rotterdam';
        if (/\bshanghai\b/.test(value)) return 'Shanghai';
        return '';
    }

    _extractConcreteVisualPhrase(text) {
        const value = String(text || '').toLowerCase();
        if (/\b(container|cargo)\b/.test(value) && /\b(ship|ships|vessel|vessels)\b/.test(value)) {
            return 'container ship footage';
        }
        if (/\bcontainer\b/.test(value) && /\b(port|terminal|logistics)\b/.test(value)) {
            return 'container port cargo ship footage';
        }
        if (/\b(oil|tanker|tankers)\b/.test(value)) return 'oil tanker footage';
        if (/\b(port|terminal|crane|cranes)\b/.test(value)) return 'container port cargo ship footage';
        if (/\b(canal|strait|chokepoint|shipping|maritime|route|trade)\b/.test(value)) return 'cargo ship footage';
        if (/\b(ship|ships|vessel|vessels)\b/.test(value)) return 'ship footage';
        return '';
    }

    // ─── Download ───────────────────────────────────────────────────────

    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        // Same 1080p default the YouTube provider already applies. Uncapped, yt-dlp pulls
        // the source resolution and the render transcode immediately throws everything
        // above 1080p away (scale=1920:1080 in hyperframes-bridge). An explicit
        // MAX_VIDEO_HEIGHT (config.youtube.maxHeight) still wins; YOUTUBE_DOWNLOAD_MAX_HEIGHT
        // overrides the default (set it to 0 to truly uncap).
        let maxHeight = normalizeMaxHeight(config.youtube?.maxHeight);
        if (maxHeight === null) {
            const envCap = process.env.YOUTUBE_DOWNLOAD_MAX_HEIGHT;
            maxHeight = (envCap !== undefined && envCap !== '') ? normalizeMaxHeight(envCap) : 1080;
        }

        const metadata = options._cachedMeta || await this._getVideoMetadata(url);

        if (metadata) {
            // Allow vertical videos — renderer crops/zooms to fit landscape output
            if (metadata.duration && metadata.duration < 3) {
                throw new Error('Video too short (< 3s)');
            }
        }

        const videoDuration = metadata?.duration || 30;
        const neededDuration = Math.ceil(duration) + 2;

        // Use Omni smart trim if available, otherwise dumb heuristic
        let startTime = 0;
        if (options._smartStartTime != null && options._smartStartTime >= 0) {
            startTime = options._smartStartTime;
            console.log(`  🎯 [Reddit] Using external smart trim start: ${Math.round(startTime)}s (video ${Math.round(videoDuration)}s)`);
        } else if (videoDuration > neededDuration + 5) {
            startTime = Math.min(5, Math.floor(videoDuration * 0.1));
            console.log(`  📐 [Reddit] Using dumb trim start: ${startTime}s (no smart trim available)`);
        }

        const args = [
            url,
            '-f', buildBestVideoFormat(maxHeight),
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-warnings',
            '--no-check-certificates',
            '-o', outputPath,
            '--force-overwrites',
        ];

        if (videoDuration > neededDuration + 3) {
            const endTime = startTime + neededDuration;
            args.push('--download-sections', `*${startTime}-${endTime}`);
            console.log(`  [Reddit] Trimming to ${startTime}s-${endTime}s (video is ${Math.round(videoDuration)}s)`);
        }

        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                args.push('--ffmpeg-location', path.dirname(ffmpegPath));
            }
        } catch (e) {}

        const cleanupYtdlpOutputs = () => {
            try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

        };

        console.log(`  [Reddit] Downloading (${describeMaxHeight(maxHeight)}) from ${url}`);

        try {
            await execYtdlpWithRetry(this._ytdlpPath, args, {
                timeout: 120000,
                windowsHide: true,
                signal: options.abortSignal || undefined,
            }, {
                label: 'Reddit download',
                attempts: 3,
                delays: [2000, 6000, 15000],
                beforeAttempt: cleanupYtdlpOutputs,
                signal: options.abortSignal || undefined,
            });
        } catch (error) {
            cleanupYtdlpOutputs();
            const kind = isPermanentYtdlpError(error) ? 'permanent failure' : 'failed';
            throw new Error(`yt-dlp download ${kind}: ${summarizeYtdlpError(error)}`);
        }

                if (!fs.existsSync(outputPath)) {
                    const dir = path.dirname(outputPath);
                    const base = path.basename(outputPath, '.mp4');
                    try {
                        const files = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.mp4'));
                        if (files.length > 0) {
                            fs.renameSync(path.join(dir, files[0]), outputPath);
                        }
                    } catch (e) {}
                }

                if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
                    throw new Error('yt-dlp produced empty or missing file');
                }

                // Verify the file has a video stream (not audio-only)
                // Reddit sometimes serves audio-only when video+audio merge fails
                const hasVideo = this._checkHasVideoStream(outputPath);
                if (hasVideo === false) {
                    console.log(`  [Reddit] Audio-only file detected — trying fallback methods`);
                    try { fs.unlinkSync(outputPath); } catch (e) {}

                    // Fallback chain for audio-only files:
                    // 1. Direct fallback_url download (Reddit's raw DASH video stream)
                    // 2. yt-dlp video-only format
                    try {
                        await this._downloadFallback(url, outputPath, maxHeight, startTime, neededDuration, videoDuration, options);
                        console.log(`  [Reddit] Downloaded (fallback): ${path.basename(outputPath)}`);
                        return outputPath;
                    } catch (fallbackErr) {
                        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                        throw new Error(`All download methods failed: ${fallbackErr.message}`);
                    }
                }

                console.log(`  [Reddit] Downloaded: ${path.basename(outputPath)}`);
                return outputPath;
    }

    /**
     * Fallback download chain when yt-dlp merge produces audio-only.
     * 1. Direct axios download of Reddit's fallback_url (DASH video stream)
     * 2. yt-dlp with video-only format selector
     */
    async _downloadFallback(url, outputPath, maxHeight, startTime, neededDuration, videoDuration, options) {
        // Method 1: Direct download of Reddit's DASH video URL (fallback_url)
        // This is the raw video stream — no merge needed, no yt-dlp needed
        const fallbackUrl = options._fallbackUrl || options._cachedMeta?._fallbackUrl;
        if (fallbackUrl) {
            console.log(`  [Reddit] Trying direct DASH download: ${fallbackUrl.substring(0, 80)}...`);
            try {
                await this._downloadDirect(fallbackUrl, outputPath);
                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
                    const hasVid = this._checkHasVideoStream(outputPath);
                    if (hasVid !== false) {
                        // Got a valid video file — trim with ffmpeg if needed
                        if (videoDuration > neededDuration + 3) {
                            await this._trimWithFfmpeg(outputPath, startTime, neededDuration);
                        }
                        return;
                    }
                }
                try { fs.unlinkSync(outputPath); } catch (e) {}
            } catch (e) {
                console.log(`  [Reddit] Direct download failed: ${e.message}`);
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e2) {}
            }
        }

        // Method 2: yt-dlp with video-only format (no audio merge)
        console.log(`  [Reddit] Trying yt-dlp video-only format`);
        const videoOnlyArgs = [
            url,
            '-f', buildBestVideoOnlyFormat(maxHeight),
            '--no-playlist',
            '--no-warnings',
            '--no-check-certificates',
            '-o', outputPath,
            '--force-overwrites',
        ];
        if (videoDuration > neededDuration + 3) {
            videoOnlyArgs.push('--download-sections', `*${startTime}-${startTime + neededDuration}`);
        }
        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) videoOnlyArgs.push('--ffmpeg-location', path.dirname(ffmpegPath));
        } catch (e) {}

        try {
            await execYtdlpWithRetry(this._ytdlpPath, videoOnlyArgs, {
                timeout: 120000,
                windowsHide: true,
                signal: options.abortSignal || undefined,
            }, {
                label: 'Reddit video-only fallback',
                attempts: 2,
                delays: [2000, 6000],
                signal: options.abortSignal || undefined,
                beforeAttempt: () => {
                    try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                },
            });
        } catch (error) {
            throw new Error(`video-only yt-dlp failed: ${summarizeYtdlpError(error)}`);
        }

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
            throw new Error('video-only yt-dlp produced empty file');
        }
        const hasVid = this._checkHasVideoStream(outputPath);
        if (hasVid === false) {
            try { fs.unlinkSync(outputPath); } catch (e) {}
            throw new Error('video-only still produced audio-only');
        }
    }

    /**
     * Direct HTTP download of a video URL via axios (no yt-dlp).
     * Used for Reddit's fallback_url (raw DASH video streams).
     */
    async _downloadDirect(url, outputPath) {
        const maxBytes = 2 * 1024 * 1024 * 1024;
        const response = await requestSafeStream(url, {
            method: 'get',
            timeout: 60000,
            headers: {
                'User-Agent': USER_AGENTS[0],
            },
        }, { maxRedirects: 5, maxBytes });

        const writer = fs.createWriteStream(outputPath);
        const limiter = createByteLimitTransform(maxBytes);
        response.data.pipe(limiter).pipe(writer);
        limiter.on('error', (error) => writer.destroy(error));

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    /**
     * Trim a video file in-place using ffmpeg.
     */
    async _trimWithFfmpeg(filePath, startTime, duration) {
        const tmpPath = filePath + '.trim.mp4';
        const ffmpegCandidates = ['C:\\ffmg\\bin\\ffmpeg.exe', 'ffmpeg'];
        try {
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic) ffmpegCandidates.unshift(ffmpegStatic);
        } catch (e) {}

        for (const ffmpeg of ffmpegCandidates) {
            try {
                execFileSync(ffmpeg, [
                    '-y', '-ss', String(startTime), '-i', filePath,
                    '-t', String(duration), '-c', 'copy', tmpPath
                ], { timeout: 30000, windowsHide: true });
                if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                    fs.unlinkSync(filePath);
                    fs.renameSync(tmpPath, filePath);
                    return;
                }
            } catch (e) { continue; }
        }
        // Trim failed — keep original (untrimmed but still valid)
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    }

    /**
     * Check if a downloaded file contains a video stream.
     * Returns true (has video), false (audio-only), or null (ffprobe unavailable).
     */
    _checkHasVideoStream(filePath) {
        const probeCandidates = [
            'C:\\ffmg\\bin\\ffprobe.exe',
            'ffprobe',
        ];
        try {
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic) {
                probeCandidates.unshift(
                    path.join(path.dirname(ffmpegStatic), 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''))
                );
            }
        } catch (e) {}

        for (const probe of probeCandidates) {
            try {
                const result = execFileSync(probe, [
                    '-v', 'error', '-select_streams', 'v:0',
                    '-show_entries', 'stream=codec_type',
                    '-of', 'csv=p=0', filePath
                ], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
                return result.trim().includes('video');
            } catch (e) { continue; }
        }
        return null; // ffprobe not available
    }

    async _getVideoMetadata(url) {
        if (!this._ytdlpPath) return null;

        try {
            const { stdout } = await execYtdlpWithRetry(this._ytdlpPath, [
                url,
                '--dump-json',
                '--no-download',
                '--no-warnings',
                '--no-check-certificates',
                '--no-playlist',
            ], {
                timeout: 15000,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024,
            }, {
                label: 'Reddit metadata',
                attempts: 2,
                delays: [1500, 5000],
            });
            const result = JSON.parse(stdout);

            return {
                duration: result.duration || 0,
                width: result.width || 0,
                height: result.height || 0,
                title: result.title || '',
            };
        } catch (e) {
            const kind = isPermanentYtdlpError(e) ? 'permanent failure' : 'failed';
            console.log(`  [Reddit] Metadata fetch ${kind}: ${summarizeYtdlpError(e)}`);
            return null;
        }
    }
}

module.exports = RedditVideoProvider;
