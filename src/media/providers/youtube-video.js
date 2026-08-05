const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');
const { selectBestSegment } = require('../../agents/smart-segment');
const {
    findYtdlp,
    execYtdlpWithRetry,
    isPermanentYtdlpError,
    summarizeYtdlpError,
    normalizeMaxHeight,
    buildBestVideoFormat,
    describeMaxHeight,
} = require('./ytdlp-utils');

// ── YouTube player-client ladder (403 / PO-token bypass) ─────────────────────
// Empirically probed against the live extractor (yt-dlp 2026.03):
//   • bare `web` / `web_safari` → "Requested format is not available" (PO-token wall)
//   • `tv` / `ios` lead         → "This video is DRM protected" (SABR)
//   • mobile (`android`,`mweb`)  → downloads, but ONLY a 360p progressive format
//   • `default` (yt-dlp-curated) → full formats incl. 1080p, and dodges the 403/PO wall
// So the DOWNLOAD leads with `default` (high quality, rarely 403s on its own). If it
// still fails with a client-switchable error (403 / no-formats / DRM), we re-invoke with
// the mobile set — low-res (360p) but it gets SOMETHING through when `default` is walled.
// Override either rung via env. NOTE: _resolveStreamUrl deliberately stays on `web` — it
// needs the legacy progressive itags 18/22 that the other clients don't expose.
const YT_CLIENT_LADDER = [
    process.env.YTDLP_PLAYER_CLIENTS || 'default',
    process.env.YTDLP_PLAYER_CLIENTS_FALLBACK || 'android,ios,web',
];

// ── Cover picture ────────────────────────────────────────────────────────────
// Every YouTube video's cover image is derivable from its 11-char id, with no
// key, no quota and no extra request to find it. The API path had these in hand
// (item.snippet.thumbnails) and threw them away; the yt-dlp path never asked.
// Publishing them as `_thumbUrl` — the field name every other provider already
// uses — is what lets the cheap pre-download visual checks see a YouTube result
// at all. hqdefault is the size that exists for every video ever uploaded;
// maxres does not.
function _coverUrl(videoId) {
    const id = String(videoId || '').trim();
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

// ── Search duration guard ────────────────────────────────────────────────────
// Lower bound only. Shorts/intros under 10s can't yield a 10-15s window, so they
// stay filtered. There is deliberately NO upper bound: hour-long tours, walking
// videos and documentaries are the RICHEST source of specific raw B-roll, and an
// upper cap silently discarded exactly those. Finding the right window inside a
// long video is the localizer's job, not the search filter's.
// Override with YOUTUBE_SEARCH_DURATION_FILTER (raw yt-dlp --match-filter expr).
const SEARCH_DURATION_FILTER = process.env.YOUTUBE_SEARCH_DURATION_FILTER || 'duration > 10';

function _ytErrorText(error) {
    return [error?.message || '', error?.stderr || '', error?.stdout || '']
        .filter(Boolean).join('\n').toLowerCase()
        .replace(/[‘’]/g, "'");
}

// Errors a DIFFERENT player client may resolve: CDN 403/forbidden, missing/locked
// formats, or extractor breakage. Bot-sign-in walls are EXCLUDED — switching clients
// rarely clears them and isPermanentYtdlpError already bails fast so the loop moves to
// the next candidate instead of burning the per-scene deadline.
function _isClientSwitchableYtError(error) {
    const text = _ytErrorText(error);
    if (/confirm you'?re not a bot|confirm you are not a bot|sign in to confirm/.test(text)) return false;
    return [
        'http error 403', 'forbidden',
        'requested format is not available', 'no video formats', 'no formats',
        'unable to extract', 'nsig', 'failed to extract any player response',
        'precondition check failed',
    ].some(p => text.includes(p));
}

// Chapter titles that indicate intro/outro segments to skip
const SKIP_CHAPTER_PATTERNS = [
    'intro', 'introduction', 'opening', 'welcome', 'sponsor',
    'outro', 'end screen', 'credits', 'subscribe', 'like and subscribe',
    'disclaimer', 'teaser', 'preview', 'bumper',
];

// Do not reject YouTube results by title/channel before vision sees frames.
// Archival clips often live under music, documentary, live-performance, or
// channel-branded uploads. Keep recall high; downstream transcript, thumbnail,
// smart-trim, and post-download vision decide actual usability.

// Theme-specific query strategies for YouTube
const QUERY_STRATEGIES = {
    politics:      (kw) => [`${kw} footage`, `${kw} aerial drone`, `${kw} raw video`],
    finance:       (kw) => [`${kw} footage`, `${kw} stock exchange`, `${kw} trading floor`],
    business:      (kw) => [`${kw} footage`, `${kw} corporate`, `${kw} aerial`],
    technology:    (kw) => [`${kw} demo`, `${kw} tech review`, `${kw} footage`],
    history:       (kw) => [`${kw} documentary`, `${kw} historical footage`, `${kw} archive`],
    entertainment: (kw) => [`${kw} clip`, `${kw} highlights`, `${kw} footage`],
    sports:        (kw) => [`${kw} highlights`, `${kw} game footage`, `${kw} sports`],
    nature:        (kw) => [`${kw} nature documentary`, `${kw} wildlife`, `${kw} stock footage`],
    travel:        (kw) => [`${kw} travel`, `${kw} aerial`, `${kw} stock footage`],
    science:       (kw) => [`${kw} explained`, `${kw} experiment`, `${kw} documentary`],
    health:        (kw) => [`${kw} medical`, `${kw} footage`, `${kw} stock footage`],
    education:     (kw) => [`${kw} explained`, `${kw} lecture`, `${kw} educational`],
    explainer:     (kw) => [`${kw} explained`, `${kw} how it works`, `${kw} documentary`, `${kw} process`],
    crime:         (kw) => [`${kw} footage`, `${kw} surveillance`, `${kw} raw video`],
    documentary:   (kw) => [`${kw} documentary`, `${kw} real footage`, `${kw} investigation`],
    motivation:    (kw) => [`${kw} motivational`, `${kw} inspirational`, `${kw} stock footage`],
};

const SELECTIVE_CHANNEL_NICHES = new Set([
    'news.politics',
    'news.military',
    'explainer.politics',
    'explainer.military',
]);

const SELECTIVE_CHANNELS = [
    {
        label: 'Kanal13AZ',
        url: 'https://www.youtube.com/@Kanal13AZ',
    },
];

const POLITICS_MILITARY_ACTOR_RE = /\b(houthi|houthis|yemen|iran|iranian|israel|israeli|gaza|hamas|hezbollah|idf|russia|russian|ukraine|ukrainian|nato|pentagon|navy|naval|military|army|troops?|soldiers?|forces?|warship|destroyer|missile|drone|uav)\b/i;
const REAL_EVENT_ACTION_RE = /\b(attack|attacks|attacked|strike|strikes|struck|airstrike|missile launch|drone launch|drone strike|explosion|blast|shelling|war|battle|conflict|invasion|blockade|seizure|hijack|hijacking|shootdown|shot down|intercept|intercepts|warning|operation|retaliation|sanction|sanctions|protest|riot|coup|election)\b/i;

// ── Multi-key YouTube Data API rotation ──────────────────────────────────────
// YOUTUBE_API_KEY can be comma-separated (one key per Google Cloud project). Each
// project carries its own ~100 searches/day quota, so multiple keys multiply daily
// capacity. On 403 quotaExceeded we bench that key until the daily reset (~Pacific
// midnight) and rotate to the next. In-memory: a fresh build re-probes a benched key
// once (one wasted call/key — cheap). Non-quota errors propagate (caller falls to yt-dlp).
const _ytApiKeyExhaustedUntil = new Map(); // key -> epoch ms when usable again
function _ytNextQuotaResetMs() {
    // YouTube quota resets at midnight Pacific (~08:00 UTC; DST ignored — close enough).
    const now = new Date();
    const reset = new Date(now);
    reset.setUTCHours(8, 0, 0, 0);
    if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
    return reset.getTime();
}
function _ytMarkKeyExhausted(key) { _ytApiKeyExhaustedUntil.set(key, _ytNextQuotaResetMs()); }
function _ytKeyAvailable(key) {
    const until = _ytApiKeyExhaustedUntil.get(key);
    return !until || Date.now() >= until;
}
function _ytAvailableApiKeys() {
    const keys = (config.youtube?.apiKeys && config.youtube.apiKeys.length)
        ? config.youtube.apiKeys
        : (config.youtube?.apiKey ? [config.youtube.apiKey] : []);
    return keys.filter(_ytKeyAvailable);
}
function _ytIsQuotaError(err) {
    // Daily quota exhaustion comes back as EITHER 403 (reason "quotaExceeded") OR 429
    // (message "Quota exceeded for ... 'Search Queries per day'"). Both mean the key is
    // spent for the day → bench + rotate. We key off the "quota" wording so a transient
    // per-second rate limit (429 without "quota") is NOT mistaken for daily exhaustion.
    const status = err?.response?.status;
    if (status !== 403 && status !== 429) return false;
    const reason = err?.response?.data?.error?.errors?.[0]?.reason || '';
    const msg = String(err?.response?.data?.error?.message || '').toLowerCase();
    return /quota|dailylimit/i.test(reason) || /quota/.test(msg);
}

class YouTubeVideoProvider extends BaseProvider {
    constructor() {
        super('YouTube Videos', 'video');
        this._ytdlpPath = null;
        this._ytdlpChecked = false;
        this._ytdlpAvailable = false;
        this._lastYtdlpCheckAt = 0;
        this._ytdlpCheckCooldownMs = 30000;
        this._scriptContext = null;
        this._searchContext = null;
    }

    /**
     * Set script context for theme-aware search queries
     */
    setContext(scriptContext) {
        this._scriptContext = scriptContext;
    }

    setSearchContext(searchContext) {
        this._searchContext = searchContext || null;
    }

    isAvailable() {
        const shouldCheck = !this._ytdlpChecked
            || (!this._ytdlpAvailable && (Date.now() - this._lastYtdlpCheckAt) > this._ytdlpCheckCooldownMs);

        if (shouldCheck) {
            this._ytdlpChecked = true;
            this._ytdlpAvailable = false;
            this._lastYtdlpCheckAt = Date.now();

            this._ytdlpPath = findYtdlp({ logPrefix: 'YouTube' });
            this._ytdlpAvailable = !!this._ytdlpPath;
            if (!this._ytdlpAvailable) {
                console.log('  [YouTube] yt-dlp not found. Install from: https://github.com/yt-dlp/yt-dlp/releases');
            }
        }
        return this._ytdlpAvailable;
    }

    /**
     * Build context-aware search queries based on video theme
     */
    _buildSearchQueries(keyword) {
        const queries = [];
        const words = keyword.trim().split(/\s+/);
        const isSpecific = words.length >= 4; // 4+ words = already specific, don't pollute

        // Specific queries (entities, proper nouns, long phrases): raw keyword first
        if (isSpecific) {
            queries.push(keyword);
        }

        const theme = (this._scriptContext?.theme || '').toLowerCase();

        // Use theme-specific strategies if available (skip for specific queries)
        if (!isSpecific && theme && QUERY_STRATEGIES[theme]) {
            queries.push(...QUERY_STRATEGIES[theme](keyword));
        }

        // Tone-based additions (skip for specific queries)
        const tone = (this._scriptContext?.tone || '').toLowerCase();
        if (!isSpecific && (tone === 'urgent' || tone === 'dramatic' || tone === 'serious')) {
            queries.push(`${keyword} breaking news`);
        }

        // Generic fallbacks
        if (!isSpecific) {
            queries.push(`${keyword} stock footage`);
        }
        queries.push(keyword); // raw keyword always included

        // Deduplicate while preserving order
        return [...new Set(queries)];
    }

    /**
     * Keep YouTube search permissive. Only structural formats known unusable for
     * the 16:9 renderer are removed here; content quality is judged later.
     */
    _filterByTitle(results) {
        return results.filter(r => {
            // Reject YouTube Shorts URLs (vertical video, unusable for 1920x1080 canvas)
            if (r.url && r.url.includes('/shorts/')) return false;
            // ...but search does not hand them to us that way. `ytsearch` returns
            // Shorts as ordinary /watch?v= URLs, so the check above passed every
            // one of them through: the "300$ Test" scenes came back holding
            // "Feeding Bees A Banana! #shorts" and "#homeinspo" clips. Fall back
            // to the two signals search does give us — the self-declared tag and
            // portrait dimensions.
            //
            // Matches the whole hashtag family, not just the bare word: uploaders
            // write #shortsfeed, #shortsviral, #ytshorts, #shortvideo far more
            // often than a lone #shorts, and `(?:^|\W)#shorts?(?:\W|$)` let every
            // one of those through.
            //
            // EVERY tail is an allowlist — including the ones after the `s`. A bare
            // `s\w*` reads as "narrow" but is a `\w*` in disguise the moment the
            // next letter is an s, and it threw away long-form videos tagged
            // #shortswords, #shortselling, #shortstop, #shortstories, #shortsleeve.
            // With the allowlist, #shortfilm / #shorthair / #shortstack survive too
            // (a short film is usable 16:9 footage and losing that lane would cost
            // more than the odd Short costs), and a plain "denim shorts" title never
            // had a hash at all.
            if (/#(?:yt)?shorts?(?:feed|viral|video|vid|vertical|clip)?\b/i.test(String(r.title || ''))) return false;

            // Dimensions are the weaker half of the pair and currently inert:
            // both search parsers stamp a placeholder 1920x1080 because a flat
            // yt-dlp/API search does not report a real frame size, so `h > w` can
            // only fire if some caller hands us metadata-enriched results. Left in
            // because it is correct when the numbers are real — but the hashtag
            // test above is what actually keeps Shorts out today.
            const w = Number(r.width) || 0;
            const h = Number(r.height) || 0;
            if (w > 0 && h > 0 && h > w) return false;
            return true;
        });
    }

    /**
     * Fetch video metadata (duration, chapters) via yt-dlp --dump-json
     */
    async _getVideoMetadata(url) {
        const args = [
            url,
            '--dump-json',
            '--no-download',
            '--extractor-args', `youtube:player_client=${YT_CLIENT_LADDER[0]}`,
            '--no-warnings',
            '--no-check-certificates',
        ];

        try {
            const { stdout } = await execYtdlpWithRetry(this._ytdlpPath, args, {
                timeout: 20000,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024, // 5MB buffer for large JSON
            }, {
                label: 'YouTube metadata',
                attempts: 2,
                delays: [1500, 5000],
            });

            const data = JSON.parse(stdout);
            return {
                duration: data.duration || 0,
                chapters: data.chapters || [],
                title: data.title || '',
                description: data.description || '',
                width: data.width || 0,
                height: data.height || 0,
            };
        } catch (error) {
            const kind = isPermanentYtdlpError(error) ? 'permanent failure' : 'failed';
            console.log(`  [YouTube] Metadata fetch ${kind}: ${summarizeYtdlpError(error)}`);
            return null;
        }
    }

    /**
     * Calculate the best start time to skip intros/logos.
     * Uses chapters if available, otherwise skips a percentage of the video.
     */
    _calculateBestStartTime(metadata, neededDuration) {
        if (!metadata || !metadata.duration) {
            // No metadata — skip a fixed 15s to avoid most intros
            return 15;
        }

        const totalDuration = metadata.duration;

        // Very short video (< 30s) — don't skip, it's already concise
        if (totalDuration < 30) {
            return 0;
        }

        // Short video (30-60s) — skip just a few seconds
        if (totalDuration < 60) {
            return Math.min(5, Math.floor(totalDuration * 0.1));
        }

        // Try chapter-based selection first
        if (metadata.chapters && metadata.chapters.length > 1) {
            const startTime = this._pickChapterStartTime(metadata.chapters, neededDuration, totalDuration);
            if (startTime !== null) {
                // (caller records options._smartStartTimeUsed from the return value —
                // `options` is not in scope here; referencing it threw a ReferenceError
                // on any video with usable chapters.)
                return startTime;
            }
        }

        // No usable chapters — skip intro percentage
        // Skip 15-20% of video, minimum 10s, maximum 90s
        const skipPercent = 0.15;
        let skipSeconds = Math.floor(totalDuration * skipPercent);
        skipSeconds = Math.max(10, Math.min(skipSeconds, 90));

        // Make sure we don't overshoot — leave room for our clip
        const maxStart = totalDuration - neededDuration - 2;
        if (maxStart <= 0) return 0;

        return Math.min(skipSeconds, maxStart);
    }

    /**
     * Pick the best chapter start time, skipping intro/outro chapters.
     */
    _pickChapterStartTime(chapters, neededDuration, totalDuration) {
        // Find content chapters (not intro/outro)
        const contentChapters = chapters.filter(ch => {
            const title = (ch.title || '').toLowerCase();
            for (const pattern of SKIP_CHAPTER_PATTERNS) {
                if (title.includes(pattern)) return false;
            }
            return true;
        });

        if (contentChapters.length === 0) return null;

        // Pick the first content chapter that's long enough for our clip
        for (const ch of contentChapters) {
            const chStart = ch.start_time || 0;
            const chEnd = ch.end_time || totalDuration;
            const chDuration = chEnd - chStart;

            if (chDuration >= neededDuration) {
                // Start a few seconds into the chapter (skip chapter title cards)
                const offset = Math.min(3, Math.floor(chDuration * 0.1));
                const startTime = chStart + offset;
                // Ensure we have room
                if (startTime + neededDuration <= totalDuration) {
                    console.log(`  [YouTube] Using chapter "${ch.title}" starting at ${Math.round(startTime)}s`);
                    return Math.floor(startTime);
                }
            }
        }

        // No chapter long enough, just use the first content chapter's start
        const first = contentChapters[0];
        const startTime = first.start_time || 0;
        if (startTime + neededDuration <= totalDuration) {
            console.log(`  [YouTube] Using chapter "${first.title}" starting at ${Math.round(startTime)}s`);
            return Math.floor(startTime);
        }

        return null;
    }

    /**
     * Resolve the direct stream URL for a YouTube video using yt-dlp.
     * Returns the URL that ffmpeg can seek into directly (no full download needed).
     */
    async _resolveStreamUrl(url) {
        // ffmpeg needs a seekable, single-file progressive stream — not a DASH
        // manifest. YouTube increasingly serves DASH-only, especially to logged-in
        // sessions, so we explicitly target the legacy progressive itags first:
        //   18 = 360p mp4 progressive (smallest, almost always available)
        //   22 = 720p mp4 progressive (sometimes still served)
        // Fall through to any progressive http stream, then any video stream.
        // player_client=web forces the desktop web extractor which still
        // exposes progressive itags; mobile/tv clients are DASH-only.
        const args = [
            url,
            '-f', '18/22/worst[protocol^=http][vcodec!=none][acodec!=none]/worst[ext=mp4][vcodec!=none]/worst[vcodec!=none]/worst',
            '--extractor-args', 'youtube:player_client=web,default',
            '--get-url',
            '--no-playlist',
            '--no-warnings',
            '--no-check-certificates',
        ];

        const { stdout } = await execYtdlpWithRetry(this._ytdlpPath, args, {
            timeout: 20000,
            windowsHide: true,
        }, {
            label: 'YouTube stream URL',
            attempts: 2,
            delays: [1500, 5000],
        });

        const streamUrl = stdout.trim().split('\n')[0];
        if (!streamUrl || !streamUrl.startsWith('http')) {
            throw new Error('No valid stream URL returned');
        }
        return streamUrl;
    }

    async getStreamUrl(url) {
        return this._resolveStreamUrl(url);
    }

    /**
     * Find the best segment of a video by sampling frames and scoring with vision AI.
     * Resolves YouTube stream URL first, then delegates to shared smart-segment module.
     * @returns {number|null} best start time in seconds, or null if analysis fails
     */
    async _findBestSegment(url, keyword, metadata, neededDuration, context = {}) {
        const totalDuration = metadata.duration;
        const mediaHunter = context.mediaHunter || null;
        const segment = mediaHunter?.segment || {};
        const allowShortSource = context.allowShortSource === true;
        const minDuration = allowShortSource
            ? Math.max(12, Math.ceil(Number(neededDuration) || 0) + 4)
            : 60;
        if (totalDuration < minDuration) return null;

        // Resolve direct stream URL so smart-segment can seek without full download
        let streamUrl;
        try {
            console.log(`  [YouTube] Resolving stream URL for frame sampling...`);
            streamUrl = await this._resolveStreamUrl(url);
        } catch (e) {
            console.log(`  [YouTube] Could not resolve stream URL: ${e.message}, using heuristic`);
            return null;
        }

        // Delegate to shared smart-segment module
        return selectBestSegment(streamUrl, {
            neededDuration,
            keyword,
            context,
            totalDuration,
            numSamples: segment.numSamples || 6,
            batchSize: segment.batchSize || 3,
            scoreThreshold: segment.scoreThreshold,
            startMargin: segment.startMargin,
            endMargin: segment.endMargin,
            minDuration,
            providerTag: 'YouTube',
            returnAlternates: true,
        });
    }

    async search(keyword) {
        const queries = this._buildSearchQueries(keyword);
        const channelOnly = this._useSelectiveChannelSearch(keyword);

        for (const query of queries) {
            if (channelOnly) {
                try {
                    const results = await this._searchSelectiveChannels(query);
                    const filtered = this._filterByTitle(results);
                    if (filtered.length > 0) return filtered;
                } catch (error) {
                    console.log(`  [YouTube] selective channel search failed for "${query}": ${error.message}`);
                }
                console.log(`  [YouTube] No good channel-scoped results for "${query}", trying next query...`);
                continue;
            }

            // Try YouTube Data API v3 first (if API key available)
            if (config.youtube?.apiKey) {
                try {
                    const results = await this._searchAPI(query);
                    const filtered = this._filterByTitle(results);
                    if (filtered.length > 0) return filtered;
                } catch (error) {
                    console.log(`  [YouTube] API search failed for "${query}": ${error.message}`);
                }
            }

            // Fallback: yt-dlp search (no API key needed)
            try {
                const results = await this._searchYtdlp(query);
                const filtered = this._filterByTitle(results);
                if (filtered.length > 0) return filtered;
            } catch (error) {
                console.log(`  [YouTube] yt-dlp search failed for "${query}": ${error.message}`);
            }

            console.log(`  [YouTube] No good results for "${query}", trying next query...`);
        }

        return [];
    }

    _useSelectiveChannelSearch(keyword = '') {
        const nicheId = (this._scriptContext?.nicheId || '').toLowerCase();

        // Real breaking footage — a named actor AND a conflict action in the
        // scene's full context (e.g. "Houthi missile strike on Red Sea ship")
        // — always prefers the curated channel, in any niche.
        if (this._isPoliticsMilitaryRealEventQuery(keyword)) return true;

        // Inside a politics/military niche the bar is lower: a softer signal
        // (a named actor OR a conflict action) in the SEARCH QUERY also routes
        // to the channel. But a query with NO politics/military signal at all —
        // generic B-roll like ships, ports, maps, factories — must fall through
        // to OPEN YouTube search. Locking every scene of a politics-niche build
        // to a single channel that only carries war footage starves all the
        // generic-footage scenes (the Bab el-Mandeb build's shipping/map/cargo
        // scenes all failed this way). The query-only scope keeps the decision
        // tied to what we are actually searching for visually, not to a scene
        // whose narration merely mentions a conflict actor in passing.
        if (SELECTIVE_CHANNEL_NICHES.has(nicheId)) {
            const { hasActor, hasAction } = this._politicsMilitarySignals(keyword, { queryOnly: true });
            return hasActor || hasAction;
        }

        return false;
    }

    /**
     * Extract politics/military signals from the scene context.
     * @param {string} keyword
     * @param {{queryOnly?: boolean}} [opts] - queryOnly restricts the scan to
     *        the actual search query + protected terms (what we're hunting for
     *        visually), excluding the full narration / prose visual intent.
     * @returns {{hasActor: boolean, hasAction: boolean}}
     */
    _politicsMilitarySignals(keyword = '', opts = {}) {
        const scene = this._searchContext?.scene || {};
        const queryOnly = !!opts.queryOnly;
        const parts = [
            keyword,
            this._searchContext?.searchQuery,
            this._searchContext?.baseQuery,
            scene?.keyword,
            scene?.searchKeyword,
            scene?.webQuery,
            ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ];
        if (!queryOnly) {
            // Broad scope (real-event gate): also weigh the prose visual intent
            // and narration so an unmistakably war-themed scene still prefers
            // the curated channel even when the bare keyword is neutral.
            parts.push(scene?.visualIntent, scene?.text);
        }
        const text = parts.filter(Boolean).join(' ');
        if (!text) return { hasActor: false, hasAction: false };
        return {
            hasActor: POLITICS_MILITARY_ACTOR_RE.test(text),
            hasAction: REAL_EVENT_ACTION_RE.test(text),
        };
    }

    _isPoliticsMilitaryRealEventQuery(keyword = '') {
        const { hasActor, hasAction } = this._politicsMilitarySignals(keyword);
        return hasActor && hasAction;
    }

    async _searchSelectiveChannels(keyword) {
        const all = [];
        for (const channel of SELECTIVE_CHANNELS) {
            const url = `${channel.url.replace(/\/+$/, '')}/search?query=${encodeURIComponent(keyword)}`;
            console.log(`  [YouTube] Channel-only search (${channel.label}): "${keyword}"`);
            const results = await this._searchYtdlpChannelUrl(url, channel);
            all.push(...results);
        }
        return this._dedupeResults(all);
    }

    // Rotating wrapper: tries each available API key, benching any that hits the daily
    // quota (403 quotaExceeded) until the Pacific-midnight reset, then rotating to the
    // next. Non-quota errors propagate so the caller falls back to yt-dlp search.
    async _searchAPI(keyword) {
        const keys = _ytAvailableApiKeys();
        if (!keys.length) throw new Error('No YouTube API key available (all exhausted for today)');
        let lastErr = null;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            try {
                return await this._searchAPIWithKey(keyword, key);
            } catch (err) {
                if (_ytIsQuotaError(err)) {
                    _ytMarkKeyExhausted(key);
                    console.log(`  [YouTube] API key …${key.slice(-6)} hit daily quota — rotating (${i + 1}/${keys.length} keys tried)`);
                    lastErr = err;
                    continue;
                }
                throw err;
            }
        }
        throw lastErr || new Error('YouTube API: all keys exhausted for today');
    }

    async _searchAPIWithKey(keyword, key) {
        const params = {
            part: 'snippet',
            type: 'video',
            q: keyword,
            key,
            maxResults: 50,
            videoEmbeddable: 'true',
            order: 'relevance',
        };

        if (config.youtube?.creativeCommonsOnly) {
            params.videoLicense = 'creativeCommon';
        }

        const response = await axios.get(
            'https://www.googleapis.com/youtube/v3/search',
            { params, timeout: 15000 }
        );

        if (!response.data.items || response.data.items.length === 0) {
            return [];
        }

        const items = response.data.items;

        // Fetch view counts + duration for sorting (1 extra API call)
        let viewCounts = {};
        let durations = {};
        try {
            const ids = items.map(i => i.id.videoId).join(',');
            const statsResponse = await axios.get(
                'https://www.googleapis.com/youtube/v3/videos',
                {
                    params: { part: 'statistics,contentDetails', id: ids, key },
                    timeout: 10000
                }
            );
            for (const vid of (statsResponse.data.items || [])) {
                viewCounts[vid.id] = parseInt(vid.statistics.viewCount || '0');
                // Parse ISO 8601 duration (PT1M20S → 80 seconds)
                const match = (vid.contentDetails?.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                if (match) {
                    durations[vid.id] = (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
                }
            }
        } catch (e) {
            // Non-critical — continue without view counts
        }

        const nicheId = (this._scriptContext?.nicheId || '').toLowerCase();
        return items
            .map(item => ({
                id: item.id.videoId,
                url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                title: item.snippet.title,
                channelTitle: item.snippet.channelTitle || '',
                width: 1920,
                height: 1080,
                viewCount: viewCounts[item.id.videoId] || 0,
                duration: durations[item.id.videoId] || 0,
                _thumbUrl: _coverUrl(item.id.videoId),
            }))
            .sort((a, b) => {
                // news.politics: prioritize short videos (under 3 min) first, then by views
                if (nicheId === 'news.politics') {
                    const aShort = a.duration > 0 && a.duration <= 180 ? 1 : 0;
                    const bShort = b.duration > 0 && b.duration <= 180 ? 1 : 0;
                    if (aShort !== bShort) return bShort - aShort; // short first
                }
                return b.viewCount - a.viewCount;
            });
    }

    async _searchYtdlp(keyword) {
        const args = [
            `ytsearch50:${keyword}`,
            '--get-id',
            '--get-title',
            '--get-duration',
            '--no-download',
            '--no-warnings',
            '--flat-playlist',
        ];

        args.push('--match-filter', SEARCH_DURATION_FILTER);

        try {
            const { stdout } = await execYtdlpWithRetry(this._ytdlpPath, args, {
                timeout: 30000,
                windowsHide: true,
            }, {
                label: 'YouTube search',
                attempts: 2,
                delays: [1500, 5000],
            });
            return this._parseYtdlpOutput(stdout);
        } catch (error) {
            const fallbackArgs = args.filter(a => a !== '--match-filter' && a !== SEARCH_DURATION_FILTER);
            if (summarizeYtdlpError(error).includes('match-filter')) {
                try {
                    const { stdout } = await execYtdlpWithRetry(this._ytdlpPath, fallbackArgs, {
                        timeout: 30000,
                        windowsHide: true,
                    }, {
                        label: 'YouTube search fallback',
                        attempts: 2,
                        delays: [1500, 5000],
                    });
                    return this._parseYtdlpOutput(stdout);
                } catch (fallbackError) {
                    console.log(`  [YouTube] yt-dlp search fallback failed: ${summarizeYtdlpError(fallbackError)}`);
                    return [];
                }
            }
            console.log(`  [YouTube] yt-dlp search error: ${summarizeYtdlpError(error)}`);
            return [];
        }
    }

    async _searchYtdlpChannelUrl(url, channel = {}) {
        const args = [
            url,
            '--get-id',
            '--get-title',
            '--get-duration',
            '--no-download',
            '--no-warnings',
            '--flat-playlist',
            '--playlist-end',
            '50',
        ];

        // Keep the same duration guard as global YouTube search.
        args.push('--match-filter', SEARCH_DURATION_FILTER);

        try {
            const { stdout } = await execYtdlpWithRetry(this._ytdlpPath, args, {
                timeout: 30000,
                windowsHide: true,
            }, {
                label: `YouTube channel search ${channel.label || ''}`.trim(),
                attempts: 2,
                delays: [1500, 5000],
            });
            return this._parseYtdlpOutput(stdout).map(result => ({
                ...result,
                channel: channel.label || '',
                _channelScoped: true,
            }));
        } catch (error) {
            const fallbackArgs = args.filter(a => a !== '--match-filter' && a !== SEARCH_DURATION_FILTER);
            if (summarizeYtdlpError(error).includes('match-filter')) {
                try {
                    const { stdout } = await execYtdlpWithRetry(this._ytdlpPath, fallbackArgs, {
                        timeout: 30000,
                        windowsHide: true,
                    }, {
                        label: `YouTube channel search fallback ${channel.label || ''}`.trim(),
                        attempts: 2,
                        delays: [1500, 5000],
                    });
                    return this._parseYtdlpOutput(stdout).map(result => ({
                        ...result,
                        channel: channel.label || '',
                        _channelScoped: true,
                    }));
                } catch (fallbackError) {
                    console.log(`  [YouTube] channel search fallback failed (${channel.label || 'channel'}): ${summarizeYtdlpError(fallbackError)}`);
                    return [];
                }
            }
            console.log(`  [YouTube] channel search error (${channel.label || 'channel'}): ${summarizeYtdlpError(error)}`);
            return [];
        }
    }

    _dedupeResults(results) {
        const out = [];
        const seen = new Set();
        for (const result of results || []) {
            const key = result?.id || result?.url || result?.title;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(result);
        }
        return out;
    }

    /**
     * Parse yt-dlp search output (alternating title/id lines)
     */
    _parseYtdlpOutput(stdout) {
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const results = [];
        // yt-dlp outputs: title, id, duration, title, id, duration, ...
        for (let i = 0; i < lines.length - 2; i += 3) {
            const title = lines[i].trim();
            const videoId = lines[i + 1].trim();
            const durStr = lines[i + 2].trim();
            if (videoId && videoId.length === 11) {
                // Parse duration string (e.g. "1:20" → 80, "5:30" → 330, "01:02:03" → 3723)
                const parts = durStr.split(':').map(Number);
                let durSec = 0;
                if (parts.length === 3) durSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
                else if (parts.length === 2) durSec = parts[0] * 60 + parts[1];
                else if (parts.length === 1) durSec = parts[0];

                results.push({
                    id: videoId,
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    title: title,
                    width: 1920,
                    height: 1080,
                    duration: durSec,
                    _thumbUrl: _coverUrl(videoId),
                });
            }
        }
        // news.politics: sort short videos (under 3 min) first
        const nicheId = (this._scriptContext?.nicheId || '').toLowerCase();
        if (nicheId === 'news.politics') {
            results.sort((a, b) => {
                const aShort = a.duration > 0 && a.duration <= 180 ? 1 : 0;
                const bShort = b.duration > 0 && b.duration <= 180 ? 1 : 0;
                if (aShort !== bShort) return bShort - aShort;
                return 0; // keep yt-dlp relevance order otherwise
            });
        }
        return results;
    }

    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        const downloadDuration = Math.ceil(duration) + 2;
        // Cap YouTube downloads at 1080p by default. Uncapped, the `default` client pulls
        // SOURCE resolution — often 4K/8K (~57MB for a 6s section vs ~3MB at 1080p) — which
        // silently bloats the media phase for zero benefit on a 1080p canvas. An explicit
        // MAX_VIDEO_HEIGHT (config.youtube.maxHeight) still wins; YOUTUBE_DOWNLOAD_MAX_HEIGHT
        // overrides the default (set it to 0 to truly uncap).
        let maxHeight = normalizeMaxHeight(config.youtube?.maxHeight);
        if (maxHeight === null) {
            const envCap = process.env.YOUTUBE_DOWNLOAD_MAX_HEIGHT;
            maxHeight = (envCap !== undefined && envCap !== '') ? normalizeMaxHeight(envCap) : 1080;
        }
        const keyword = options.keyword || '';

        // Fetch metadata to find the best start time (skip intros/logos).
        // If the search step already handed us a duration (YouTube Data API result),
        // synthesize metadata and SKIP the yt-dlp --dump-json call entirely — that call
        // is the single biggest source of per-candidate failures + latency in the media
        // phase. Width/height are unknown here, so the vertical-aspect guard below is a
        // no-op and the post-download clip-prescreen aspect gate catches portrait clips.
        let metadata;
        const apiDuration = Number(options.sourceDuration);
        if (Number.isFinite(apiDuration) && apiDuration > 0) {
            metadata = { duration: apiDuration, title: options.sourceTitle || '', width: 0, height: 0, chapters: [] };
            console.log(`  [YouTube] Using API duration (${Math.round(apiDuration)}s) — skipping yt-dlp metadata fetch`);
        } else {
            console.log(`  [YouTube] Fetching metadata for smart clip selection...`);
            metadata = await this._getVideoMetadata(url);
        }

        // Reject vertical videos (Shorts, phone recordings) — unusable on 1920x1080 canvas
        if (metadata && metadata.width && metadata.height && metadata.height > metadata.width) {
            console.log(`  [YouTube] Rejecting vertical video (${metadata.width}x${metadata.height})`);
            throw new Error('Vertical video (portrait aspect ratio)');
        }

        let startTime = null;

        if (options._smartStartTime != null && Number.isFinite(Number(options._smartStartTime))) {
            startTime = Math.max(0, Number(options._smartStartTime));
            options._smartStartTimeUsed = startTime;
            console.log(`  🔍 [YouTube Smart Trim] Using external segment hunt start=${Math.round(startTime)}s`);
        }

        // Try vision-based segment selection (most accurate) — uses smart-segment.js + callVisionAI
        const mediaHunter = options.mediaHunter || null;
        const allowShortSource = !!(mediaHunter?.strictRaw && !mediaHunter.allowGraphics
            && metadata?.duration
            && metadata.duration > Math.max(downloadDuration + 4, 18));
        const strictSmartTrimRequired = !!(mediaHunter?.strictRaw && !mediaHunter.allowGraphics
            && keyword
            && metadata?.duration
            && metadata.duration > downloadDuration + 4);
        let attemptedVisionTrim = false;

        // Transcript Scout: if this video has captions, semantically LOCATE the moment where
        // the scene's subject is actually discussed (richer + cheaper than blind vision frame
        // sampling, and great at finding a buried clip in a long documentary). Niche-free —
        // pure semantic similarity. Only high-confidence matches are allowed to bypass the
        // pre-download vision scan; weaker matches are recorded as evidence and vision still
        // chooses the actual window.
        if (startTime === null && metadata && metadata.duration >= 60) {
            try {
                const vid = (url.match(/[?&]v=([^&]+)/) || [])[1] || '';
                const sceneLine = (options.sceneText && options.sceneText.length > 20) ? options.sceneText : keyword;
                if (vid && sceneLine) {
                    const { locateSegment } = require('../transcript-scout');
                    const loc = await locateSegment(sceneLine, vid, { ytdlpPath: this._ytdlpPath, signal: options.abortSignal });
                    if (loc) {
                        // Use the captioned segment as the download window directly — the ONE
                        // post-download vision score confirms the actual clip, so we don't pay
                        // the expensive per-candidate stream-resolve + vision frame-scan just to
                        // pick a start point. Cheap + niche-free.
                        options._transcriptScout = loc;
                        startTime = Math.max(0, loc.startTime - 1); // small lead-in
                        options._smartStartTimeUsed = startTime;
                        const conf = Number(loc.score || 0) >= (Number(process.env.TRANSCRIPT_SCOUT_COMMIT_SCORE) || 0.60) ? 'high-confidence' : 'best-guess';
                        console.log(`  📝 [Transcript Scout] ${conf} segment @ ${Math.round(loc.startTime)}s (score ${loc.score}) — "${loc.text.slice(0, 60)}" — vision confirms the clip`);
                    }
                }
            } catch (_) { /* graceful — fall through to the vision smart-trim */ }
        }

        // Storyboard Scout: the transcript rung above only fires when the narrator actually
        // SAYS the thing. On the videos that matter most for B-roll — drives, walking
        // tours, silent documentaries — captions are ambient noise, and a weak "best-guess"
        // match lands no better than the heuristic. YouTube publishes free sprite-sheet
        // storyboards that visually index the whole video, so we can LOOK for the shot
        // instead of guessing: one small download, no stream resolve, no remote seeking —
        // which is exactly the cost that forced the smart-segment rung below to be off.
        //
        // The duration gate is about PAYOFF, not feasibility. Measured across the 52
        // YouTube clips of a real 64-scene build, every single candidate had a usable
        // storyboard — even a 22s one (100 frames) — and boards get DENSER as videos get
        // shorter (4m53s -> 150 frames @ 2s; 22m -> 135 frames @ 10s), so cost tracks
        // frame count, not length. What length buys is the odds: on a 30s clip a blind
        // start is already on the shot, on a 4-minute one it is a 1-in-24 guess. Hence a
        // few minutes, not "long videos only" — an earlier 600s gate would have fired on
        // 2 of those 52 clips while all 52 took the blind `window via heuristic start`.
        //
        // The per-run video budget in the scout is the actual spend guard. This yields to
        // a high-confidence transcript hit, and a null changes nothing below.
        const storyboardEnabled = !/^(0|false|off|no)$/i.test(String(process.env.YOUTUBE_STORYBOARD_SCOUT || '').trim());
        const storyboardMinDuration = Number(process.env.YOUTUBE_STORYBOARD_MIN_DURATION) || 180;
        const transcriptCommitScore = Number(process.env.TRANSCRIPT_SCOUT_COMMIT_SCORE) || 0.60;
        const transcriptWeak = !!options._transcriptScout
            && Number(options._transcriptScout.score || 0) < transcriptCommitScore;
        if (storyboardEnabled && keyword && metadata && metadata.duration >= storyboardMinDuration
            && (startTime === null || transcriptWeak)) {
            try {
                const vid = (url.match(/[?&]v=([^&]+)/) || [])[1] || '';
                if (vid) {
                    const { locateWindow } = require('../storyboard-scout');
                    const win = await locateWindow(keyword, vid, {
                        ytdlpPath: this._ytdlpPath,
                        signal: options.abortSignal,
                        sceneText: options.sceneText || '',
                        // The scene's own clock. Without it the deep scout (~40 vision
                        // calls) ran to completion no matter how little time was left,
                        // which is how one candidate could eat the whole scene and
                        // leave later providers with nothing. Absent (0) = no limit,
                        // exactly as before for callers that don't set one.
                        deadline: Number(options.deadlineAt) > 0 ? Number(options.deadlineAt) : 0,
                    });
                    if (win) {
                        options._storyboardScout = win;
                        startTime = win.startTime;
                        options._smartStartTimeUsed = startTime;
                        const mm = Math.floor(startTime / 60);
                        const ss = String(Math.round(startTime % 60)).padStart(2, '0');
                        console.log(`  🗺️ [Storyboard Scout] found "${win.probe}" at ${mm}m${ss}s of a ${Math.round(metadata.duration / 60)}min video (conf ${win.confidence.toFixed(2)}, ${win.calls} looks, ${Math.round((win.elapsedMs || 0) / 1000)}s) — "${win.evidence}"`);
                    } else if (transcriptWeak) {
                        console.log(`  🗺️ [Storyboard Scout] subject never visible in the storyboard — keeping the transcript best-guess`);
                    }
                }
            } catch (_) { /* graceful — keep whatever window we already had */ }
        }

        // Per-candidate vision SMART-SEGMENT is OFF by default. It resolved the stream URL and
        // vision-scanned frames of EVERY YouTube candidate just to pick a start point — minutes
        // per scene (the reason YouTube clips never finished before a cancel). We now pick the
        // window from the transcript hint (above) or the heuristic (below) and let the single
        // post-download vision score judge the result. Re-enable precise picking with
        // YOUTUBE_SMART_SEGMENT=1.
        const smartSegmentEnabled = process.env.YOUTUBE_SMART_SEGMENT === '1';
        if (smartSegmentEnabled && startTime === null && keyword && metadata && (metadata.duration >= 60 || allowShortSource)) {
            attemptedVisionTrim = true;
            console.log(`  🔍 [YouTube Smart Trim] Using smart-segment.js (callVisionAI) for ${Math.round(metadata.duration)}s video | keyword="${keyword}"${allowShortSource && metadata.duration < 60 ? ' | short exact-source scan' : ''}`);
            const segmentPick = await this._findBestSegment(url, keyword, metadata, downloadDuration, {
                sceneText: options.sceneText || '',
                niche: options.niche || '',
                videoTopic: options.videoTopic || '',
                theme: options.theme || '',
                entities: options.entities || [],
                mediaAgent: options.mediaAgent || null,
                mediaHunter: options.mediaHunter || null,
                sourceTitle: options.sourceTitle || metadata?.title || '',
                sourceUrl: url,
                allowShortSource,
            });
            if (segmentPick && segmentPick.rejectedAll) {
                // The model examined every frame and rejected the whole clip
                // (burned-in news banners, off-topic, presenter). A human
                // editor drops the clip — so do we. Null/parse failures still
                // fall back to heuristic below; THIS is an explicit verdict.
                console.log(`  🚫 [YouTube Smart Trim] Vision rejected ALL frames — dropping candidate (no heuristic rescue)`);
                return null;
            }
            if (segmentPick && typeof segmentPick === 'object' && Number.isFinite(Number(segmentPick.startTime))) {
                startTime = Math.max(0, Number(segmentPick.startTime));
                options._smartSegmentPick = segmentPick;
                options._smartSegmentAlternates = Array.isArray(segmentPick.alternatives) ? segmentPick.alternatives : [];
            } else if (segmentPick && typeof segmentPick === 'object') {
                startTime = null;
            } else {
                startTime = segmentPick;
            }
            if (startTime !== null) {
                options._smartStartTimeUsed = startTime;
                console.log(`  🎯 [YouTube Smart Trim] Vision picked start=${Math.round(startTime)}s`);
            } else {
                console.log(`  ⚠️ [YouTube Smart Trim] Vision returned null — falling back to heuristic`);
            }
        } else if (startTime !== null) {
            console.log(`  🔍 [YouTube Smart Trim] Skipped internal scan — start already selected (transcript hint or external)`);
        } else if (!smartSegmentEnabled) {
            // Smart-segment off by default — the heuristic window below is logged there. No-op here.
        } else {
            const minDuration = allowShortSource ? Math.max(12, Math.ceil(downloadDuration) + 4) : 60;
            console.log(`  🔍 [YouTube Smart Trim] Skipped — ${!keyword ? 'no keyword' : `video too short (${Math.round(metadata?.duration || 0)}s < ${minDuration}s)`}`);
        }

        // Fall back to chapter/percentage-based heuristic
        if (startTime === null) {
            if (strictSmartTrimRequired && attemptedVisionTrim) {
                throw new Error('Strict raw smart trim found no clean segment');
            }
            startTime = this._calculateBestStartTime(metadata, downloadDuration);
            options._smartStartTimeUsed = startTime;
            console.log(`  ⏱️ [YouTube] window via heuristic start=${Math.round(startTime)}s (fast path — no per-candidate vision scan; post-download score judges the clip)`);
        }

        const endTime = startTime + downloadDuration;

        if (metadata) {
            console.log(`  [YouTube] Video duration: ${Math.round(metadata.duration)}s → Extracting ${startTime}s-${endTime}s`);
        }

        const baseArgs = [
            url,
            '-f', buildBestVideoFormat(maxHeight),
            '--download-sections', `*${startTime}-${endTime}`,
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-warnings',
            '--no-check-certificates',
            '-o', outputPath,
            '--force-overwrites',
        ];

        // Use ffmpeg-static if available (so yt-dlp can merge streams)
        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                baseArgs.push('--ffmpeg-location', path.dirname(ffmpegPath));
            }
        } catch (e) {
            // ffmpeg-static not available, rely on system ffmpeg
        }

        const cleanupYtdlpOutputs = () => {
            try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
        };

        console.log(`  [YouTube] Downloading ${downloadDuration}s clip (${describeMaxHeight(maxHeight)}) from ${url} [${startTime}s-${endTime}s]`);

        // Player-client fallback ladder: a 403 on the googlevideo CDN is almost always
        // client-specific (PO-token / nsig wall), so on a client-switchable failure we
        // re-download under a DIFFERENT client set instead of hammering the same one into
        // the same 403. Permanent errors (unavailable / bot wall) bail immediately.
        let downloaded = false;
        let lastError = null;
        for (let ci = 0; ci < YT_CLIENT_LADDER.length; ci++) {
            const clients = YT_CLIENT_LADDER[ci];
            const hasNextClient = ci < YT_CLIENT_LADDER.length - 1;
            const args = [...baseArgs, '--extractor-args', `youtube:player_client=${clients}`];
            try {
                await execYtdlpWithRetry(this._ytdlpPath, args, {
                    timeout: 120000,
                    windowsHide: true,
                    signal: options.abortSignal || undefined,
                }, {
                    label: `YouTube download [${clients}]`,
                    // With a fallback set still in reserve, keep per-set retries short
                    // (CDN 403s don't self-heal) so the ladder switches fast; the LAST set
                    // gets the full transient-retry budget.
                    attempts: hasNextClient ? 2 : 3,
                    delays: [2000, 6000, 15000],
                    beforeAttempt: cleanupYtdlpOutputs,
                    signal: options.abortSignal || undefined,
                });
                downloaded = true;
                break;
            } catch (error) {
                cleanupYtdlpOutputs();
                lastError = error;
                if (options.abortSignal?.aborted) throw error;
                if (hasNextClient && _isClientSwitchableYtError(error)) {
                    console.log(`  [YouTube] client "${clients}" failed (${summarizeYtdlpError(error, 90)}) — switching to "${YT_CLIENT_LADDER[ci + 1]}"`);
                    continue;
                }
                const kind = isPermanentYtdlpError(error) ? 'permanent failure' : 'failed';
                throw new Error(`yt-dlp download ${kind}: ${summarizeYtdlpError(error)}`);
            }
        }
        if (!downloaded) {
            const kind = isPermanentYtdlpError(lastError) ? 'permanent failure' : 'failed';
            throw new Error(`yt-dlp download ${kind}: ${summarizeYtdlpError(lastError)}`);
        }

        // yt-dlp --download-sections may append section suffix to filename
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

        console.log(`  [YouTube] Downloaded: ${path.basename(outputPath)} (from ${startTime}s)`);
        return outputPath;
    }
}

module.exports = YouTubeVideoProvider;
