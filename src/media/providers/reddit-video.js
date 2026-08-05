const axios = require('axios');
const path = require('path');
const fs = require('fs');
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
// Uses Reddit's public JSON API (no keys needed).
// Self-throttles to ~1 request per 4 seconds to stay under rate limits.
// Strategy: UI-like media search first, then search.json fallback.

// Domains yt-dlp can download from (found in Reddit posts)
const VIDEO_DOMAINS = new Set([
    'youtube.com', 'youtu.be', 'streamable.com', 'gfycat.com',
    'v.redd.it', 'clips.twitch.tv', 'vimeo.com', 'dailymotion.com',
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
        this._requestCount = 0;
        // Strict rate limiting — 1 request per 4 seconds = 15/min (under Reddit's ~30/min limit)
        this._lastRequestTime = 0;
        this._minRequestGap = 4000;
        this._rateLimited = false;
        this._rateLimitUntil = 0;
        this._cookieJar = '';
        this._searchCache = new Map();
        this._lastCooldownLogAt = 0;
        this._jsonBlockedUntil = 0;
        this._jsonBlockedReason = '';
        this._lastJsonBlockedLogAt = 0;
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
        if (this._cooldownRemainingMs() > 0) return false;

        // Enforce gap between requests
        const elapsed = Date.now() - this._lastRequestTime;
        if (elapsed < this._minRequestGap) {
            await new Promise(r => setTimeout(r, this._minRequestGap - elapsed));
        }
        this._lastRequestTime = Date.now();
        return true;
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

    _onJsonBlocked(status, message = '') {
        const cooldownMs = Math.max(60_000, parseInt(process.env.REDDIT_JSON_BLOCK_COOLDOWN_MS || String(10 * 60_000), 10) || (10 * 60_000));
        this._jsonBlockedUntil = Date.now() + cooldownMs;
        this._jsonBlockedReason = `HTTP ${status}${message ? `: ${message}` : ''}`;
        this._minRequestGap = Math.max(this._minRequestGap, 8000);
        console.log(`  [Reddit] search.json blocked (${this._jsonBlockedReason}); cooling JSON fallback for ${Math.ceil(cooldownMs / 1000)}s`);
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

    _onRateLimited() {
        const configuredCooldown = parseInt(process.env.REDDIT_RATE_LIMIT_COOLDOWN_MS || '20000', 10);
        const cooldownMs = Math.max(10_000, Number.isFinite(configuredCooldown) ? configuredCooldown : 20_000);
        this._rateLimited = true;
        this._rateLimitUntil = Date.now() + cooldownMs;
        this._minRequestGap = Math.min(12000, this._minRequestGap + 2000);
        console.log(`  [Reddit] 429 rate limited — ${Math.ceil(cooldownMs / 1000)}s cooldown, gap now ${this._minRequestGap / 1000}s`);
    }

    // ─── Search ─────────────────────────────────────────────────────────

    /**
     * Global search, then a small relaxed-query ladder.
     * Reddit's browser search is semantic/media-focused; search.json is literal.
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

            // Primary: imitate the new Reddit UI Media-tab search via HTML scrape.
            const htmlResults = await this._searchHtml(query);
            if (htmlResults && htmlResults.length > 0) {
                this._setCachedSearch(query, htmlResults);
                return this._cloneResults(htmlResults);
            }
            if (this._cooldownRemainingMs() > 0) {
                this._logCooldownSkip('fallback search');
                continue;
            }
            // Fallback: classic search.json — runs when HTML returns null/empty.
            const results = await this._searchOnce(query);
            if (results.length > 0) {
                this._setCachedSearch(query, results);
                return this._cloneResults(results);
            }
            if (this._cooldownRemainingMs() > 0) {
                this._logCooldownSkip('relaxed searches');
                continue;
            }
        }
        return [];
    }

    // ─── UI-imitating HTML search ───────────────────────────────────────
    // Mirrors what the user sees at reddit.com/search/?q=...&type=media.
    // Returns null when the path was unusable (cooldown / blocked / 0 permalinks /
    // too many resolve failures) so the caller falls through to search.json.

    async _searchHtml(keyword) {
        const HTML_TIMEOUT_MS = 8000;
        const POST_JSON_TIMEOUT_MS = 7000;
        const PERMALINK_LIMIT = 5;
        const TOTAL_BUDGET_MS = 25000;
        const EARLY_STOP_AT = 5;
        const RESOLVE_CONCURRENCY = 1;
        const INTER_BATCH_DELAY_MS = 700;

        const fail = (reason) => {
            console.log(`  [Reddit] UI scrape → fallback (${reason})`);
            return null;
        };

        const canProceed = await this._throttle();
        if (!canProceed) {
            this._logCooldownSkip('UI scrape');
            return null;
        }

        const budgetStart = Date.now();
        const overBudget = () => Date.now() - budgetStart > TOTAL_BUDGET_MS;
        const ua = USER_AGENTS[this._requestCount++ % USER_AGENTS.length];

        const baseParams = { q: keyword, type: 'media', sort: 'relevance', t: 'all' };
        const htmlHeaders = (cookie = '') => ({
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(cookie ? { Cookie: cookie } : {}),
        });

        let html;
        try {
            const response = await axios.get('https://www.reddit.com/search/', {
                params: baseParams,
                headers: htmlHeaders(this._cookieJar),
                timeout: HTML_TIMEOUT_MS,
                maxRedirects: 3,
            });
            this._mergeCookies(response.headers?.['set-cookie']);
            html = typeof response.data === 'string' ? response.data : '';
            const challenge = this._extractVerificationChallenge(html);
            if (challenge && !overBudget()) {
                console.log(`  [Reddit] UI verification challenge — solving once`);
                const solved = await axios.get('https://www.reddit.com/search/', {
                    params: {
                        ...baseParams,
                        solution: challenge.solution,
                        js_challenge: '1',
                        token: challenge.token,
                        jsc_orig_r: '',
                    },
                    headers: htmlHeaders(this._cookieJar),
                    timeout: HTML_TIMEOUT_MS,
                    maxRedirects: 5,
                });
                this._mergeCookies(solved.headers?.['set-cookie']);
                html = typeof solved.data === 'string' ? solved.data : '';
                if (this._extractVerificationChallenge(html)) return fail('verification unsolved');
            }
        } catch (e) {
            if (e.response?.status === 429) this._onRateLimited();
            return fail(`html ${e.message}`);
        }

        const permalinks = this._extractPermalinks(html);
        if (permalinks.length === 0) return fail('no permalinks');
        const limited = permalinks.slice(0, PERMALINK_LIMIT);

        // Parallel resolve in small batches — we already paid one throttle for HTML;
        // the resolve burst is short and bounded by PERMALINK_LIMIT.
        const queue = [...limited];
        const children = [];
        let failures = 0;
        let stopReason = '';

        while (queue.length > 0) {
            if (overBudget()) { stopReason = 'budget-25s'; break; }
            const batch = queue.splice(0, RESOLVE_CONCURRENCY);
            const settled = await Promise.allSettled(
                batch.map(p => this._resolveRedditPermalink(p, POST_JSON_TIMEOUT_MS))
            );
            let hit429 = false;
            for (const s of settled) {
                if (s.status === 'fulfilled' && s.value) children.push(s.value);
                else {
                    failures++;
                    if (s.reason?.response?.status === 429) hit429 = true;
                }
            }
            if (hit429) { this._onRateLimited(); stopReason = '429'; break; }
            // Early stop: enough usable video posts already?
            const usableSoFar = this._parseResults(children).length;
            if (usableSoFar >= EARLY_STOP_AT) { stopReason = `early@${usableSoFar}`; break; }
            if (queue.length > 0 && !overBudget()) {
                await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
            }
        }

        // Stamp shared throttle so subsequent outer Reddit calls wait correctly.
        this._lastRequestTime = Date.now();

        const attempted = children.length + failures;
        if (attempted > 0 && children.length === 0 && failures === attempted) {
            return fail(`${failures}/${attempted} resolves failed`);
        } else if (attempted > 0 && failures > 0) {
            console.log(`  [Reddit] UI scrape kept partial resolve success (${children.length}/${attempted})`);
        }

        const allResults = this._parseResults(children);
        const nonVideoRejected = children.length - allResults.length;
        const afterReject = allResults;
        // Trust Reddit's Media-tab ranking — semantic, not literal-title.
        const scored = this._scoreUiResults(afterReject, keyword);

        const elapsed = ((Date.now() - budgetStart) / 1000).toFixed(1);
        const stopNote = stopReason ? ` [${stopReason}]` : '';
        console.log(`  [Reddit] UI scrape ${elapsed}s: ${permalinks.length} permalinks → ${children.length} resolved → ${allResults.length} videos → ${scored.length} kept (reject: ${nonVideoRejected} non-video)${stopNote}`);

        if (scored.length === 0) return fail('0 final candidates');
        return scored.slice(0, 10);
    }

    async _resolveRedditPermalink(permalink, timeoutMs) {
        const hosts = ['www.reddit.com', 'old.reddit.com'];
        let lastError = null;
        let rateLimitError = null;
        for (const host of hosts) {
            const ua = USER_AGENTS[this._requestCount++ % USER_AGENTS.length];
            try {
                const r = await axios.get(`https://${host}${permalink}.json`, {
                    headers: {
                        'User-Agent': ua,
                        'Accept': 'application/json',
                        'Accept-Language': 'en-US,en;q=0.9',
                        ...(this._cookieJar ? { Cookie: this._cookieJar } : {}),
                    },
                    timeout: timeoutMs,
                    maxRedirects: 3,
                    params: { raw_json: 1 },
                });
                this._mergeCookies(r.headers?.['set-cookie']);
                const post = r.data?.[0]?.data?.children?.[0];
                if (post?.data) return post;
            } catch (err) {
                lastError = err;
                if (err.response?.status === 429) rateLimitError = err;
            }
        }
        throw rateLimitError || lastError || new Error('reddit permalink resolve failed');
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

    _extractPermalinks(html) {
        if (!html) return [];
        const normalized = String(html)
            .replace(/\\u002[fF]/g, '/')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/&#x2F;/gi, '/')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        // Match comment permalinks regardless of host prefix:
        //   href="/r/sub/comments/abc123/slug/"
        //   href="https://www.reddit.com/r/sub/comments/abc123/slug/"
        // Preserve UI order; first occurrence wins.
        const re = /(?:href=["'](?:https?:\/\/(?:www|old|new)\.reddit\.com)?|(https?:\/\/(?:www|old|new)\.reddit\.com)?)(\/r\/[A-Za-z0-9_]+\/comments\/[a-z0-9]+\/[^"'<>\s?#\\]+\/?)/gi;
        const seen = new Set();
        const out = [];
        let m;
        while ((m = re.exec(normalized)) !== null) {
            let path = m[2];
            if (!path.endsWith('/')) path += '/';
            if (seen.has(path)) continue;
            seen.add(path);
            out.push(path);
            if (out.length >= 50) break;
        }
        return out;
    }

    _extractVerificationChallenge(html) {
        if (!html || !/Please wait for verification|js_challenge|namedItem\(["']solution["']\)/i.test(html)) {
            return null;
        }
        const seedMatch = html.match(/async\s+e\s*=>\s*e\s*\+\s*e\s*\)\(["']([^"']+)["']\)/i)
            || html.match(/\)\(["']([a-f0-9]{8,})["']\)/i);
        const tokenMatch = html.match(/name=["']token["']\s+value=["']([^"']+)["']/i);
        if (!seedMatch?.[1] || !tokenMatch?.[1]) return null;
        return {
            solution: `${seedMatch[1]}${seedMatch[1]}`,
            token: tokenMatch[1],
        };
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

    async _searchOnce(keyword) {
        const jsonBlockedRemaining = this._jsonBlockedUntil - Date.now();
        if (jsonBlockedRemaining > 0) {
            const now = Date.now();
            if (now - this._lastJsonBlockedLogAt > 10000) {
                this._lastJsonBlockedLogAt = now;
                console.log(`  [Reddit] Skipping search.json fallback (${this._jsonBlockedReason || 'blocked'}; ${Math.ceil(jsonBlockedRemaining / 1000)}s left)`);
            }
            return [];
        }

        const canProceed = await this._throttle();
        if (!canProceed) {
            console.log(`  [Reddit] Skipping search — in cooldown`);
            return [];
        }

        const ua = USER_AGENTS[this._requestCount++ % USER_AGENTS.length];
        const url = `https://www.reddit.com/search.json`;

        let data;
        try {
            const response = await axios.get(url, {
                params: {
                    q: keyword,
                    sort: 'relevance',
                    t: 'all',
                    type: 'link',
                    limit: 100,  // max allowed — get as many as possible in 1 request
                },
                headers: {
                    'User-Agent': ua,
                    'Accept': 'application/json',
                    'Accept-Language': 'en-US,en;q=0.9',
                    ...(this._cookieJar ? { Cookie: this._cookieJar } : {}),
                },
                timeout: 12000,
                maxRedirects: 3,
            });
            data = response.data;
        } catch (e) {
            const status = e.response?.status;
            if (status === 429) {
                this._onRateLimited();
            } else if (status === 401 || status === 403) {
                this._onJsonBlocked(status, e.message);
            } else {
                console.log(`  [Reddit] Search error: ${e.message}`);
            }
            return [];
        }

        const children = data?.data?.children || [];
        if (children.length === 0) {
            console.log(`  [Reddit] No posts for "${keyword}"`);
            return [];
        }

        // Parse — extract videos from all posts
        const allResults = this._parseResults(children);

        // Keep content filtering permissive; vision handles the real verdict.
        const afterReject = allResults;

        // Relevance scoring
        const filtered = this._scoreAndFilterByRelevance(afterReject, keyword);

        if (filtered.length > 0) {
            console.log(`  [Reddit] ${filtered.length} videos from ${children.length} posts for "${keyword}"`);
        } else {
            // Debug: show what posts we got but couldn't use
            const videoCount = allResults.length;
            const sample = children.slice(0, 3).map(c => {
                const d = c.data;
                return `[${d.is_video ? 'VIDEO' : d.post_hint || d.domain || 'text'}] "${(d.title || '').substring(0, 40)}"`;
            });
            console.log(`  [Reddit] ${children.length} posts, ${videoCount} videos, 0 relevant for "${keyword}" | ${sample.join(', ')}`);
        }

        return filtered.slice(0, 10);
    }

    // ─── Parse & filter ─────────────────────────────────────────────────

    _parseResults(children) {
        const results = [];
        let verticalCount = 0;

        for (const child of children) {
            const d = child.data || child;
            if (!d) continue;

            // Detect video posts: Reddit-hosted, external video domains, or rich:video hint
            const isRedditVideo = d.is_video && d.media?.reddit_video?.fallback_url;
            const isExternalVideo = d.post_hint === 'rich:video'
                || VIDEO_DOMAINS.has(d.domain)
                || (d.url && d.url.includes('v.redd.it'));

            if (!isRedditVideo && !isExternalVideo) continue;

            // Skip NSFW
            if (d.over_18) continue;

            // Skip very low-engagement posts
            if ((d.ups || 0) < 3) continue;

            // Always prefer the Reddit permalink for Reddit-hosted videos —
            // bare v.redd.it URLs return 403 to yt-dlp.
            // For external videos (YouTube etc.), use the direct URL but fix HTML entities.
            let videoUrl = d.url;
            if (videoUrl) videoUrl = videoUrl.replace(/&amp;/g, '&');
            let duration = 0;
            let width = 0;
            let height = 0;

            if (isRedditVideo || (d.url && d.url.includes('v.redd.it'))) {
                // Always use permalink for Reddit-hosted video — v.redd.it direct links get 403
                videoUrl = `https://www.reddit.com${d.permalink}`;
                const rv = d.media?.reddit_video || {};
                duration = rv.duration || 0;
                width = rv.width || 0;
                height = rv.height || 0;

                // Allow vertical videos — renderer can crop/zoom to fit
                // Just track count for sorting preference (landscape first)
                if (width && height && height > width) {
                    verticalCount++;
                }
                // Skip very short clips
                if (duration && duration < 3) continue;
            }

            // Store fallback_url for direct download when yt-dlp merge fails
            const fallbackUrl = d.media?.reddit_video?.fallback_url || null;

            results.push({
                id: `reddit-${d.id}`,
                url: videoUrl,
                title: (d.title || '').substring(0, 200),
                width: width || 1920,
                height: height || 1080,
                duration: duration || 0,
                _duration: duration,
                _subreddit: d.subreddit || '',
                _score: d.ups || 0,
                _isRedditHosted: isRedditVideo,
                _permalink: d.permalink,
                _fallbackUrl: fallbackUrl,
                _cachedMeta: (width && height && duration) ? { duration, width, height, title: (d.title || ''), _fallbackUrl: fallbackUrl } : null,
            });

            if (results.length >= 12) break;
        }

        return results;
    }

    _scoreAndFilterByRelevance(results, keyword) {
        const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'with', 'from', 'by', 'this', 'that', 'it', 'its', 'as', 'be', 'has', 'had', 'have', 'been', 'will', 'would', 'could', 'should', 'not', 'no', 'so', 'if', 'just', 'about', 'up', 'out', 'all', 'one', 'two', 'how', 'why', 'what', 'when', 'who', 'which', 'do', 'does', 'did', 'can', 'new']);

        const extractWords = (text) => {
            return (text || '').toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 2 && !STOP_WORDS.has(w));
        };

        const keywordWords = new Set(extractWords(keyword));
        const topicWords = new Set(extractWords(this._scriptContext?.summary || ''));
        const entityWords = new Set();
        for (const entity of (this._scriptContext?.entities || [])) {
            for (const w of extractWords(entity)) entityWords.add(w);
        }

        const scored = results.map(r => {
            const titleWords = extractWords(r.title);
            let relevance = 0;

            for (const word of titleWords) {
                if (keywordWords.has(word)) relevance += 3;
                else if (entityWords.has(word)) relevance += 2;
                else if (topicWords.has(word)) relevance += 1;
            }

            const engagementBonus = Math.min(2, Math.log10(Math.max(1, r._score || 0)));
            return { ...r, _relevance: relevance + engagementBonus };
        });

        scored.sort((a, b) => (b._relevance - a._relevance) || (b._score - a._score));
        return scored;
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
