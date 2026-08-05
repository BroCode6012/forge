/**
 * Thumbnail Vision
 *
 * Post-Title-Sanity AI gate that SEES the candidate thumbnails like a human
 * would when browsing YouTube. Catches packaged-content footage that titles
 * alone don't reveal:
 *   - news anchor desk shots (channel logo, lower-third banners)
 *   - "BREAKING NEWS" / countdown / cartoon thumbnails
 *   - reaction-style framed channel intros
 *   - illustration/animation thumbnails when scene needs raw footage
 *
 * Two backends:
 *   - judgeYouTubeSERP(): Puppeteer-core screenshots the real youtube.com/results
 *     SERP page. One screenshot covers all visible candidates for that query.
 *   - judgeThumbnailGrid(): @napi-rs/canvas composes a synthetic grid from a list
 *     of thumbnail URLs (used by non-YouTube providers).
 *
 * Cached:
 *   - SERP screenshot cached by query (across scenes that re-use the query).
 *   - Per-candidate verdict cached by (sceneKey | videoId/urlKey).
 * Budgeted: skipped when scene-budget is tight.
 * Fail-safe: any failure → keep all (no false rejects).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { requestSafeBuffer } = require('../security/safe-download');
const { callVisionAI } = require('../brain/ai-provider');
const { normalizeUrlForDedup } = require('../util/url-utils');

const _verdictCache = new Map(); // `${sceneKey}|${urlKey}` -> { keep, reason }
// Deliberately NOT shared with _verdictCache. A gate verdict ("is this
// packaged content?") and a screen verdict ("does this picture show the
// subject?") answer different questions; letting one populate the other would
// turn a ranking hint into a silent rejection, or vice versa.
const _screenCache = new Map();  // `screen|${sceneKey}|${urlKey}` -> 'yes'|'no'|'unsure'
const _serpCache = new Map();    // `yt|${normalizedQuery}` -> { buffer, mime, ts }
const _SERP_TTL_MS = 30 * 60 * 1000;

const MAX_CANDIDATES_IN_PROMPT = 25;
const MAX_REASON_LEN = 120;
const SERP_VIEWPORT = { width: 1280, height: 1600 };

// ───── Chrome/Edge discovery (Windows-first, cross-platform fallback) ─────

function _findSystemBrowser() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const candidates = [];
    if (process.platform === 'win32') {
        const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
        const PF86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const LOCAL = process.env['LOCALAPPDATA'] || '';
        candidates.push(
            path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'),
            LOCAL && path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe'),
            path.join(PF86, 'Microsoft\\Edge\\Application\\msedge.exe'),
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        );
    } else {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/microsoft-edge',
        );
    }
    for (const p of candidates.filter(Boolean)) {
        try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return null;
}

// ───── Puppeteer browser lifecycle (lazy, reused) ─────

let _browserPromise = null;
let _puppeteer = null;
let _lastBrowserUseAt = 0;
const _BROWSER_IDLE_MS = 5 * 60 * 1000;

async function _getBrowser() {
    if (!_puppeteer) {
        try { _puppeteer = require('puppeteer-core'); }
        catch (e) { throw new Error(`puppeteer-core not installed: ${e.message}`); }
    }
    if (_browserPromise) {
        _lastBrowserUseAt = Date.now();
        return _browserPromise;
    }
    const exe = _findSystemBrowser();
    if (!exe) throw new Error('No system Chrome/Edge found for thumbnail vision');

    _browserPromise = _puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: [
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--mute-audio',
            '--lang=en-US,en',
            '--hide-scrollbars',
        ],
        defaultViewport: SERP_VIEWPORT,
    }).then(b => {
        _lastBrowserUseAt = Date.now();
        b.on('disconnected', () => { _browserPromise = null; });
        return b;
    }).catch(err => {
        _browserPromise = null;
        throw err;
    });
    return _browserPromise;
}

async function closeThumbnailVisionBrowser() {
    if (!_browserPromise) return;
    try {
        const b = await _browserPromise;
        await b.close();
    } catch (_) {}
    _browserPromise = null;
}

// Idle timer — close the browser after N minutes of disuse, to free Chrome RAM.
setInterval(() => {
    if (!_browserPromise) return;
    if (Date.now() - _lastBrowserUseAt > _BROWSER_IDLE_MS) closeThumbnailVisionBrowser();
}, 60_000).unref?.();

// ───── Helpers shared with Title Sanity ─────

function _sceneKey(scene) {
    if (scene?.index != null) return `s${scene.index}`;
    if (scene?.sceneIndex != null) return `s${scene.sceneIndex}`;
    const txt = String(scene?.text || scene?.transcript || '').slice(0, 80);
    let h = 0;
    for (let i = 0; i < txt.length; i++) h = ((h << 5) - h + txt.charCodeAt(i)) | 0;
    return `h${h}`;
}

function _resultTitle(result) {
    return String(
        result?.title
        || result?._cachedMeta?.title
        || result?._meta?.title
        || ''
    ).replace(/\s+/g, ' ').trim();
}

function _resultUrlKey(result) {
    const url = result?._directVideoUrl
        || result?._fallbackUrl
        || result?._cachedMeta?._fallbackUrl
        || result?.url
        || '';
    return normalizeUrlForDedup(url);
}

function _youtubeVideoId(result) {
    if (result?.id && /^[A-Za-z0-9_-]{8,15}$/.test(result.id)) return result.id;
    const url = result?.url || result?._directVideoUrl || '';
    const m = String(url).match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{8,15})/);
    return m ? m[1] : null;
}

function _normalizeQuery(q) {
    return String(q || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function _parseResponse(text, count) {
    const out = new Map();
    if (!text) return out;
    const lines = String(text).split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^\s*(\d+)\s*[|:\-]\s*(KEEP|REJECT)\b\s*[|:\-]?\s*(.*)$/i);
        if (!m) continue;
        const idx = Number(m[1]);
        if (!Number.isFinite(idx) || idx < 1 || idx > count) continue;
        const keep = m[2].toUpperCase() === 'KEEP';
        const reason = String(m[3] || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LEN) || (keep ? 'thumbnail ok' : 'packaged content');
        if (!out.has(idx)) out.set(idx, { keep, reason });
    }
    return out;
}

// ───── YouTube SERP screenshot ─────

async function _screenshotYouTubeSERP(query) {
    const key = `yt|${_normalizeQuery(query)}`;
    const cached = _serpCache.get(key);
    if (cached && (Date.now() - cached.ts) < _SERP_TTL_MS) return cached;

    const browser = await _getBrowser();
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        // Prevent consent/region pop-ups blocking the screenshot
        await page.setCookie(
            { name: 'CONSENT', value: 'YES+', domain: '.youtube.com', path: '/' },
            { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' },
        );

        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
        // sp=EgIQAQ%3D%3D filters to videos only (no channels/playlists)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });

        // Wait for at least a few video tiles to load
        try {
            await page.waitForSelector('ytd-video-renderer, ytd-rich-item-renderer', { timeout: 12_000 });
        } catch (_) {
            // No selector — page may still have rendered enough; carry on.
        }

        // Let lazy thumbnails settle.
        await new Promise(r => setTimeout(r, 1200));

        const buffer = await page.screenshot({
            type: 'jpeg',
            quality: 78,
            fullPage: false, // viewport-height is enough (top results)
            clip: { x: 0, y: 0, width: SERP_VIEWPORT.width, height: SERP_VIEWPORT.height },
        });
        const entry = { buffer, mime: 'image/jpeg', ts: Date.now() };
        _serpCache.set(key, entry);
        return entry;
    } finally {
        try { await page.close(); } catch (_) {}
    }
}

// ───── Prompt builders ─────

function _buildPrompt(scene, contract, items, niche = '', kind = 'serp') {
    const sceneText = String(scene?.text || scene?.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 320);
    const target = String(contract.target || '').slice(0, 200);
    const mustShow = (contract.mustShow || []).slice(0, 8).join(', ') || '(any)';
    const mustAvoid = (contract.mustNotShow || []).slice(0, 6).join(', ') || '(none)';
    const acceptance = String(contract.acceptanceTest || '').slice(0, 200);
    const nicheStr = String(niche || contract.niche || scene?.niche || '').trim();
    const mandatoryIdentity = (contract.mandatoryIdentity || []).slice(0, 6).join(', ') || '(none)';
    const mandatoryVisible = (contract.mandatoryVisible || contract.hardVisibleEntities || []).slice(0, 6).join(', ') || '(none)';
    const genericBrollNote = mandatoryIdentity === '(none)' && mandatoryVisible === '(none)'
        ? 'This scene has no mandatory identity/visible entity. For generic/context B-roll, keep same-environment or same-product-family footage if it would visually support the narration, even when it is adjacent rather than exact.'
        : 'This scene has mandatory identity/visible-entity requirements; only keep thumbnails that plausibly show those required things.';

    const list = items.map((it, i) => `${i + 1}. "${it.title}"`).join('\n');

    const screenshotIntro = kind === 'serp'
        ? `You are looking at a real YouTube search-results screenshot. Use the visible thumbnails (NOT the titles — the titles are repeated below for matching) to judge each candidate.`
        : `You are looking at a grid of candidate thumbnails. Each tile is numbered. Use the visible imagery to judge each candidate.`;

    return `${screenshotIntro}

SCENE NARRATION: "${sceneText}"
${nicheStr ? `NICHE: ${nicheStr}\n` : ''}TARGET FOOTAGE: ${target}
${acceptance ? `EDITOR ACCEPTANCE TEST: ${acceptance}\n` : ''}
MANDATORY IDENTITY: ${mandatoryIdentity}
MANDATORY VISIBLE ENTITY: ${mandatoryVisible}
MUST SHOW (any of): ${mustShow}
MUST AVOID: ${mustAvoid}
${genericBrollNote}

CANDIDATE TITLES (matched to thumbnails visible in the image):
${list}

For each candidate, decide based on THUMBNAIL IMAGERY:

REJECT HARD when the thumbnail shows packaged-content footage instead of raw footage of the scene's subject:
- News anchor / studio desk shots (visible anchor face, lower-third banner, channel logo overlay).
- "BREAKING NEWS", countdown, big red banner overlays.
- Cartoon, illustration, 3D-rendered, or AI-art thumbnails when scene needs real footage.
- Reaction-style framed thumbnails (face in corner, arrows, text bubbles).
- Thumbnail subject is clearly a different topic (e.g. submarine when scene wants surface cargo).

KEEP when the thumbnail plausibly shows the scene's subject in raw form — even if not perfect.

Output EXACTLY one line per candidate, format (no extra text):
N|KEEP|<short reason ≤8 words>
or
N|REJECT|<short reason ≤8 words>`;
}

// ───── Public: YouTube SERP judgment ─────

async function judgeYouTubeSERP(results, query, contract, scene, opts = {}) {
    const empty = { kept: results || [], rejected: [], log: '' };
    if (!Array.isArray(results) || results.length === 0) return empty;
    if (!contract?.enabled || !contract?.strictRaw) return { kept: results, rejected: [], log: '' };
    if (!query || typeof query !== 'string') return empty;

    const sceneKey = _sceneKey(scene);
    const providerName = opts.providerName || 'YouTube';

    // Resolve cache + pending. Skip candidates with no matchable identity.
    const decisions = new Map();
    const pending = [];
    for (const result of results) {
        const title = _resultTitle(result);
        if (!title) {
            decisions.set(result, { keep: true, reason: 'no title' });
            continue;
        }
        const urlKey = _resultUrlKey(result) || `t:${title.toLowerCase().slice(0, 80)}`;
        const cacheKey = `${sceneKey}|${urlKey}`;
        if (_verdictCache.has(cacheKey)) {
            decisions.set(result, _verdictCache.get(cacheKey));
            continue;
        }
        pending.push({ result, title, cacheKey, videoId: _youtubeVideoId(result) });
    }

    if (pending.length === 0) {
        return _buildReturn(results, decisions, providerName, 'cached');
    }

    // Cap candidates sent to vision so prompt stays parseable.
    const batch = pending.slice(0, MAX_CANDIDATES_IN_PROMPT);

    let screenshot;
    try {
        screenshot = await _screenshotYouTubeSERP(query);
    } catch (e) {
        // No screenshot → keep all, do not cache (try again next time).
        for (const item of pending) decisions.set(item.result, { keep: true, reason: 'serp screenshot failed' });
        return _buildReturn(results, decisions, providerName, `screenshot error: ${e.message}`);
    }

    const prompt = _buildPrompt(scene, contract, batch.map(b => ({ title: b.title })), opts.niche, 'serp');

    let parsed = new Map();
    try {
        const respText = await callVisionAI(
            prompt,
            screenshot.buffer.toString('base64'),
            screenshot.mime,
            { maxTokens: 80 + batch.length * 28 }
        );
        parsed = _parseResponse(respText, batch.length);
    } catch (e) {
        for (const item of pending) decisions.set(item.result, { keep: true, reason: 'vision unavailable' });
        return _buildReturn(results, decisions, providerName, `vision error: ${e.message}`);
    }

    for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const verdict = parsed.get(j + 1);
        if (verdict) {
            _verdictCache.set(item.cacheKey, verdict);
            decisions.set(item.result, verdict);
        } else {
            decisions.set(item.result, { keep: true, reason: 'no AI verdict' });
        }
    }
    // Any pending items beyond the prompt cap → keep (couldn't judge in this batch).
    for (let j = batch.length; j < pending.length; j++) {
        decisions.set(pending[j].result, { keep: true, reason: 'over prompt cap' });
    }

    return _buildReturn(results, decisions, providerName, 'judged');
}

// ───── Public: synthetic-grid judgment (non-YouTube providers) ─────

async function _fetchImageBuffer(url, timeoutMs = 8000) {
    const resp = await requestSafeBuffer(url, {
        timeout: timeoutMs,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/*,*/*;q=0.8',
        },
    }, { maxRedirects: 4, maxBytes: 20 * 1024 * 1024 });
    return Buffer.from(resp.data);
}

async function _composeGrid(items) {
    let canvasLib;
    try { canvasLib = require('@napi-rs/canvas'); }
    catch (e) { throw new Error(`@napi-rs/canvas not installed: ${e.message}`); }

    const cols = 4;
    const rows = Math.ceil(items.length / cols);
    const tileW = 320, tileH = 180, pad = 12, labelH = 22;
    const W = cols * tileW + (cols + 1) * pad;
    const H = rows * (tileH + labelH) + (rows + 1) * pad;

    const canvas = canvasLib.createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < items.length; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        const x = pad + c * (tileW + pad);
        const y = pad + r * (tileH + labelH + pad);

        try {
            // Sniff BEFORE decoding — a TIFF segfaults @napi-rs/canvas outright,
            // which this catch could never see. Thumbnails are arbitrary remote
            // bytes, so treat an unknown format as a missing thumb, not a crash.
            const { isCanvasSafeImage } = require('../util/image-bytes');
            if (!isCanvasSafeImage(items[i].thumbBuffer)) throw new Error('unsafe image bytes');

            const img = await canvasLib.loadImage(items[i].thumbBuffer);
            ctx.drawImage(img, x, y, tileW, tileH);
        } catch (_) {
            ctx.fillStyle = '#222';
            ctx.fillRect(x, y, tileW, tileH);
            ctx.fillStyle = '#888';
            ctx.font = '14px sans-serif';
            ctx.fillText('(no thumb)', x + 8, y + tileH / 2);
        }

        // Big number badge top-left
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(x, y, 36, 28);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText(String(i + 1), x + 10, y + 20);

        // Title strip
        ctx.fillStyle = '#fff';
        ctx.font = '13px sans-serif';
        const title = String(items[i].title || '').slice(0, 64);
        ctx.fillText(title, x, y + tileH + 16);
    }

    return canvas.encode('jpeg', 80);
}

async function judgeThumbnailGrid(results, contract, scene, opts = {}) {
    const empty = { kept: results || [], rejected: [], log: '' };
    if (!Array.isArray(results) || results.length === 0) return empty;
    if (!contract?.enabled || !contract?.strictRaw) return { kept: results, rejected: [], log: '' };

    const sceneKey = _sceneKey(scene);
    const providerName = opts.providerName || 'provider';

    const decisions = new Map();
    const pending = [];
    for (const result of results) {
        const title = _resultTitle(result);
        const thumbUrl = opts.getThumbUrl ? opts.getThumbUrl(result) : (result?._thumbUrl || result?.thumbUrl || '');
        if (!thumbUrl || !title) {
            decisions.set(result, { keep: true, reason: 'no thumb to judge' });
            continue;
        }
        const urlKey = _resultUrlKey(result) || `t:${title.toLowerCase().slice(0, 80)}`;
        const cacheKey = `${sceneKey}|${urlKey}`;
        if (_verdictCache.has(cacheKey)) {
            decisions.set(result, _verdictCache.get(cacheKey));
            continue;
        }
        pending.push({ result, title, thumbUrl, cacheKey });
    }

    if (pending.length === 0) {
        return _buildReturn(results, decisions, providerName, 'cached');
    }

    const batch = pending.slice(0, MAX_CANDIDATES_IN_PROMPT);

    // Download thumbnails (best-effort; missing buffers render as gray tiles).
    await Promise.all(batch.map(async item => {
        try { item.thumbBuffer = await _fetchImageBuffer(item.thumbUrl); }
        catch (_) { item.thumbBuffer = null; }
    }));
    const haveAtLeastOne = batch.some(b => b.thumbBuffer);
    if (!haveAtLeastOne) {
        for (const item of pending) decisions.set(item.result, { keep: true, reason: 'thumbs unavailable' });
        return _buildReturn(results, decisions, providerName, 'thumbs unavailable');
    }

    let gridBuf;
    try { gridBuf = await _composeGrid(batch); }
    catch (e) {
        for (const item of pending) decisions.set(item.result, { keep: true, reason: 'grid render failed' });
        return _buildReturn(results, decisions, providerName, `grid error: ${e.message}`);
    }

    const prompt = _buildPrompt(scene, contract, batch.map(b => ({ title: b.title })), opts.niche, 'grid');
    let parsed = new Map();
    try {
        const respText = await callVisionAI(
            prompt,
            Buffer.from(gridBuf).toString('base64'),
            'image/jpeg',
            { maxTokens: 80 + batch.length * 28 }
        );
        parsed = _parseResponse(respText, batch.length);
    } catch (e) {
        for (const item of pending) decisions.set(item.result, { keep: true, reason: 'vision unavailable' });
        return _buildReturn(results, decisions, providerName, `vision error: ${e.message}`);
    }

    for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const verdict = parsed.get(j + 1);
        if (verdict) {
            _verdictCache.set(item.cacheKey, verdict);
            decisions.set(item.result, verdict);
        } else {
            decisions.set(item.result, { keep: true, reason: 'no AI verdict' });
        }
    }
    for (let j = batch.length; j < pending.length; j++) {
        decisions.set(pending[j].result, { keep: true, reason: 'over prompt cap' });
    }

    return _buildReturn(results, decisions, providerName, 'judged');
}

// ───── Public: pre-download thumbnail SCREEN (ranking, never a gate) ─────

/**
 * Look at every candidate's free preview picture in ONE grid, ONE vision call,
 * and race the ones that visibly show the subject first.
 *
 * WHY THIS IS A RANKING AND NOT A GATE. The scene only ever downloads the top
 * few candidates, so re-ordering is the whole lever: promoting three good clips
 * to the front is worth exactly as much as deleting the twenty bad ones behind
 * them, and it cannot lose footage. A grid of 25 numbered tiles is also the
 * shape where vision models mis-bind a verdict to the wrong tile number (the
 * Storyboard Scout measured 2/8 on "which cell shows X", against 17/17 on
 * plain presence). Under a gate, one mis-bound number silently deletes a good
 * clip. Under a ranking, the worst case is a slightly wrong order.
 *
 * THE NO-POSITIVES GUARD is the other half of that reasoning. The screen earns
 * its keep by promoting winners, so if it names no winner at all we do not
 * trust its losers either — the list is returned exactly as it arrived. That
 * makes the screen strictly non-destructive: it either helps or does nothing.
 *
 * Same one-call-per-grid economics as every other grid pass in the app: the
 * cost is the call, not the pictures inside it.
 */
async function screenThumbnailGrid(results, contract, scene, opts = {}) {
    const unchanged = { ranked: results || [], confirmed: [], saw: 0, missed: 0, unsure: 0, screened: 0, log: '' };
    if (!Array.isArray(results) || results.length < 2) return unchanged;
    if (String(process.env.MEDIA_THUMBNAIL_SCREEN || '').trim() === '0') return unchanged;
    // No visual contract means no agreed target to compare a picture against.
    if (!contract?.enabled) return unchanged;

    const sceneKey = _sceneKey(scene);
    const providerName = opts.providerName || 'provider';
    const getThumbUrl = opts.getThumbUrl || ((r) => r?._thumbUrl || r?.thumbUrl || '');

    const verdicts = new Map(); // result -> 'yes' | 'no' | 'unsure'
    const pending = [];
    for (const result of results) {
        const thumbUrl = getThumbUrl(result);
        if (!thumbUrl) continue; // unscreened — stays in the neutral band
        const urlKey = _resultUrlKey(result) || `t:${_resultTitle(result).toLowerCase().slice(0, 80)}`;
        const cacheKey = `screen|${sceneKey}|${urlKey}`;
        if (_screenCache.has(cacheKey)) {
            verdicts.set(result, _screenCache.get(cacheKey));
            continue;
        }
        pending.push({ result, title: _resultTitle(result), thumbUrl, cacheKey });
    }

    if (pending.length > 0) {
        const batch = pending.slice(0, _screenGridSize());

        await Promise.all(batch.map(async item => {
            try { item.thumbBuffer = await _fetchImageBuffer(item.thumbUrl, 6000); }
            catch (_) { item.thumbBuffer = null; }
        }));
        if (!batch.some(b => b.thumbBuffer)) return unchanged;

        let gridBuf;
        try { gridBuf = await _composeGrid(batch); }
        catch (_) { return unchanged; }

        let parsed = new Map();
        try {
            const respText = await callVisionAI(
                _buildScreenPrompt(scene, contract, batch, opts.niche),
                Buffer.from(gridBuf).toString('base64'),
                'image/jpeg',
                { maxTokens: 60 + batch.length * 22 }
            );
            parsed = _parseScreenResponse(respText, batch.length);
        } catch (_) {
            return unchanged; // vision unavailable — behave exactly as before
        }

        for (let j = 0; j < batch.length; j++) {
            const verdict = parsed.get(j + 1);
            if (!verdict) continue; // no answer → neutral, never a demotion
            _screenCache.set(batch[j].cacheKey, verdict);
            verdicts.set(batch[j].result, verdict);
        }
    }

    let saw = 0, missed = 0, unsure = 0;
    for (const v of verdicts.values()) {
        if (v === 'yes') saw++;
        else if (v === 'no') missed++;
        else unsure++;
    }

    // The guard: no confirmed winner → no reordering at all.
    if (saw === 0) {
        return {
            ranked: results,
            confirmed: [],
            saw, missed, unsure,
            screened: verdicts.size,
            log: verdicts.size
                ? `  👁️ [Thumbnail Screen] [${providerName}] looked at ${verdicts.size} preview(s) before downloading, none clearly showed "${_screenTarget(contract)}" — order unchanged`
                : '',
        };
    }

    //   0  the preview shows it
    //   1  unscreened, unsure, or unanswered — no evidence either way
    //   2  looked and it shows something else
    // Stable within each band, so every ranker that ran before this still
    // decides ties.
    const band = (r) => {
        const v = verdicts.get(r);
        if (v === 'yes') return 0;
        if (v === 'no') return 2;
        return 1;
    };
    const order = new Map(results.map((r, i) => [r, i]));
    const ranked = [...results].sort((a, b) => (band(a) - band(b)) || (order.get(a) - order.get(b)));

    const topTitle = _resultTitle(ranked[0]) || String(ranked[0]?.url || '');
    // Handed back explicitly rather than left for the caller to infer from
    // position: "the first `saw` entries" only holds while the banding above
    // stays exactly as written, and a caller that marks the wrong candidates
    // hands the race a confidence bonus it never earned.
    const confirmed = [];
    for (const [result, verdict] of verdicts) {
        if (verdict === 'yes') confirmed.push(result);
    }
    return {
        ranked,
        confirmed,
        saw, missed, unsure,
        screened: verdicts.size,
        log: `  👁️ [Thumbnail Screen] [${providerName}] looked at ${verdicts.size} preview(s) before downloading: ${saw} show "${_screenTarget(contract)}", ${missed} don't${unsure ? `, ${unsure} unclear` : ''} — racing "${topTitle.slice(0, 60)}" first`,
    };
}

function _screenGridSize() {
    const raw = parseInt(process.env.MEDIA_THUMBNAIL_SCREEN_GRID || '', 10);
    if (Number.isFinite(raw) && raw >= 2) return Math.min(raw, MAX_CANDIDATES_IN_PROMPT);
    return MAX_CANDIDATES_IN_PROMPT;
}

function _screenTarget(contract) {
    const target = String(contract?.target || '').replace(/\s+/g, ' ').trim();
    if (target) return target.slice(0, 60);
    const first = (contract?.mustShow || [])[0];
    return String(first || 'the subject').slice(0, 60);
}

function _buildScreenPrompt(scene, contract, batch, niche = '') {
    const sceneText = String(scene?.text || scene?.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const target = String(contract.target || '').slice(0, 200);
    const mustShow = (contract.mustShow || []).slice(0, 8).join(', ') || '(any)';
    const mustAvoid = (contract.mustNotShow || []).slice(0, 6).join(', ') || '(none)';
    const nicheStr = String(niche || contract.niche || scene?.niche || '').trim();
    const list = batch.map((it, i) => `${i + 1}. "${String(it.title || '').slice(0, 64)}"`).join('\n');

    return `You are looking at a numbered grid of candidate preview pictures. Each tile is one candidate clip or photo for ONE shot in a video.

SCENE NARRATION: "${sceneText}"
${nicheStr ? `NICHE: ${nicheStr}\n` : ''}TARGET FOOTAGE: ${target}
MUST SHOW (any of): ${mustShow}
MUST AVOID: ${mustAvoid}

CANDIDATE LABELS (matched to the numbered tiles):
${list}

For EACH numbered tile, judge ONLY what the picture itself shows.

YES    — the picture plausibly shows the target subject. Related or adjacent
         framing of the same subject/environment still counts as YES.
NO     — the picture clearly shows a different subject, or something in MUST AVOID.
UNSURE — too small, dark, cropped or ambiguous to tell.

Prefer UNSURE over NO when you are not certain. A wrong NO costs a good shot.

Output EXACTLY one line per tile, no other text:
N|YES|<reason ≤6 words>
N|NO|<reason ≤6 words>
N|UNSURE|<reason ≤6 words>`;
}

function _parseScreenResponse(text, count) {
    const out = new Map();
    if (!text) return out;
    for (const raw of String(text).split(/\r?\n/)) {
        const m = raw.trim().match(/^\s*(\d+)\s*[|:\-]\s*(YES|NO|UNSURE)\b/i);
        if (!m) continue;
        const idx = Number(m[1]);
        if (!Number.isFinite(idx) || idx < 1 || idx > count) continue;
        if (out.has(idx)) continue;
        out.set(idx, m[2].toLowerCase());
    }
    return out;
}

// ───── Shared return-builder ─────

function _buildReturn(results, decisions, providerName, statusTag) {
    const kept = [];
    const rejected = [];
    for (const result of results) {
        const verdict = decisions.get(result) || { keep: true, reason: 'no verdict' };
        if (verdict.keep) kept.push(result);
        else rejected.push({ result, reason: verdict.reason });
    }

    let log = '';
    if (rejected.length > 0) {
        const sample = rejected.slice(0, 2).map(r => {
            const t = _resultTitle(r.result);
            return `"${t.slice(0, 50)}${t.length > 50 ? '…' : ''}" — ${r.reason}`;
        }).join(' | ');
        log = `  Thumbnail Vision: [${providerName}] ${results.length} -> ${kept.length} kept (AI rejected ${rejected.length}: ${sample})`;
    } else if (statusTag === 'judged') {
        log = `  Thumbnail Vision: [${providerName}] all ${results.length} thumbnails passed`;
    }
    return { kept, rejected, log };
}

function resetThumbnailVisionCache() {
    _verdictCache.clear();
    _screenCache.clear();
    _serpCache.clear();
}

module.exports = {
    judgeYouTubeSERP,
    judgeThumbnailGrid,
    screenThumbnailGrid,
    closeThumbnailVisionBrowser,
    resetThumbnailVisionCache,
};
