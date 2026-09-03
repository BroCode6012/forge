/**
 * Storyboard Scout — locate the right 5-15s window inside a LONG YouTube video.
 *
 * The problem: the richest, most specific B-roll lives in hour-long tours, walking
 * videos and documentaries. Downloading one of those to find a 10-second shot is
 * hopeless, and guessing a start offset (the heuristic rung) throws away the whole
 * point of picking that video.
 *
 * Prior art in this repo and why it isn't enough:
 *   - transcript-scout.js reads captions. Great when the narrator says the thing.
 *     Useless on the videos that matter most — measured on a 68-min Amish country
 *     drive, the caption track is 1484 events of driving directions over music and
 *     the entire subject vocabulary (tunnel/foundation/farmhouse/stone/cellar)
 *     scores zero.
 *   - the vision smart-segment rung resolves the stream URL and vision-scans frames
 *     of EVERY candidate. Minutes per scene. It is off by default for that reason.
 *
 * What this does instead: YouTube publishes free storyboards — sprite sheets that
 * are a visual index of the entire video at roughly one frame per 10 seconds. One
 * small download (~3MB for an hour), no stream resolution, no remote seeking.
 * We re-pack those frames into contact sheets and let the vision model narrow down
 * where the subject appears, coarse to fine.
 *
 * THE LOAD-BEARING RULE — ask presence, never ask for a cell number.
 * Measured on the build's own Qwen VL:
 *   "which numbered cell shows X?"  -> 2/8 at 25 cells, 5/8 at 16, unstable at 9.
 *                                      The model SEES the subject and mis-maps it
 *                                      to the printed number (positional bias).
 *   "does ANY thumbnail show X?"    -> 17/17 sheets, zero false positives, zero
 *                                      misses. It misses rather than inventing.
 * So we binary-search with yes/no questions: wide sheets -> strip -> single frame.
 *
 * Contract, same shape as transcript-scout: ONE call, resolves to a plain object
 * or null. It never throws and never blocks a download — a null just means the
 * caller falls through to whatever rung it would have used anyway.
 *
 * Kill switch: YOUTUBE_STORYBOARD_SCOUT=0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { isCanvasSafeImage } = require('../util/image-bytes');

let _canvasMod = null;
function canvasLib() {
    if (_canvasMod === null) {
        try { _canvasMod = require('@napi-rs/canvas'); } catch (_) { _canvasMod = false; }
    }
    return _canvasMod;
}

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.YOUTUBE_STORYBOARD_SCOUT || '').trim());
}

function envInt(name, def) {
    const n = parseInt(String(process.env[name] || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : def;
}

function envFloat(name, def) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : def;
}

// ── The clock ───────────────────────────────────────────────────────────────
//
// A deadline that is only checked BETWEEN videos is not a deadline. The caller
// budgets ~45s for a scene's pre-download screening, but the old loop tested the
// clock only when claiming the next video — so a single slow one (up to a 90s
// yt-dlp fetch, then a chain of vision calls, each of which can fall back
// through a second provider) ran to completion regardless. Measured on a real
// build: one 45s budget took 215.7s, and the scene's remaining providers
// (Reddit) and ~30 of its 45 candidates never got their turn.
//
// So the deadline travels DOWN: it caps the fetch timeout and it stops the
// vision loop from starting new calls. At most `concurrency` already-issued
// vision calls can outlive it, because an HTTP call in flight cannot be
// recalled — that is bounded and small, unlike the old unbounded overrun.

/** Absolute deadline in ms from either opts.deadline (absolute) or opts.deadlineMs (relative). 0 = none. */
function _deadlineOf(opts) {
    const abs = Number(opts && opts.deadline);
    if (Number.isFinite(abs) && abs > 0) return abs;
    const rel = Number(opts && opts.deadlineMs);
    if (Number.isFinite(rel) && rel > 0) return Date.now() + rel;
    return 0;
}

const _leftMs = (deadline) => (deadline ? deadline - Date.now() : Infinity);
const _expired = (deadline) => deadline > 0 && Date.now() >= deadline;

// ── Storyboard fetch ────────────────────────────────────────────────────────
// One yt-dlp invocation gets us both the sprite sheets (as .mhtml with the JPEGs
// inlined as base64) and the info json, which carries the EXACT tile geometry
// (rows/columns/width/height) and per-sheet fragment durations. Inferring the
// grid from the sheet pixel dimensions is ambiguous — 960x540 is a valid 3x3 of
// 320x180 AND a valid 1x1 of 960x540 — so we always read it from yt-dlp.

function _run(bin, args, signal, timeout) {
    return new Promise((resolve, reject) => {
        // `signal` must be OMITTED, not passed as null. _sceneAbortSignal() returns
        // null (not undefined) for a scene with no controller — the per-scene Retry
        // path deletes scene._abortSignal — and execFile throws ERR_INVALID_ARG_TYPE
        // on a null signal. That throw lands in _fetchStoryboard's catch, so the
        // whole storyboard system would switch itself off with no log line.
        execFile(bin, args, { timeout, windowsHide: true, ...(signal ? { signal } : {}), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

/**
 * Pull the JPEG parts out of yt-dlp's .mhtml storyboard bundle, in order.
 *
 * Must work on a Buffer, not a string: despite the MIME wrapper, yt-dlp writes
 * the sheets as RAW BINARY with a Content-length header and no transfer encoding.
 * Decoding the file as text and base64-ing the body yields 46 pieces of garbage.
 */
function _parseMhtmlImages(raw) {
    const head = raw.toString('latin1', 0, Math.min(raw.length, 2048));
    const bMatch = head.match(/boundary="([^"]+)"/);
    if (!bMatch) return [];
    const bnd = Buffer.from(`--${bMatch[1]}`, 'latin1');

    const marks = [];
    for (let i = raw.indexOf(bnd, 0); i !== -1; i = raw.indexOf(bnd, i + bnd.length)) marks.push(i);

    const out = [];
    for (let m = 0; m < marks.length - 1; m++) {
        const start = marks[m] + bnd.length;
        const end = marks[m + 1];
        const headEnd = raw.indexOf('\r\n\r\n', start, 'latin1');
        if (headEnd < 0 || headEnd >= end) continue;
        const headers = raw.toString('latin1', start, headEnd);
        if (!/content-type:\s*image\/jpeg/i.test(headers)) continue;

        const bodyStart = headEnd + 4;
        const lenM = headers.match(/content-length:\s*(\d+)/i);
        let bodyEnd = lenM ? Math.min(bodyStart + parseInt(lenM[1], 10), end) : end;
        // Without a length header the trailing CRLF before the next boundary is ours to trim.
        if (!lenM) while (bodyEnd > bodyStart && (raw[bodyEnd - 1] === 0x0a || raw[bodyEnd - 1] === 0x0d)) bodyEnd--;

        let buf = raw.subarray(bodyStart, bodyEnd);
        if (/content-transfer-encoding:\s*base64/i.test(headers)) {
            try { buf = Buffer.from(buf.toString('latin1').replace(/\s+/g, ''), 'base64'); } catch (_) { continue; }
        }
        if (buf.length > 1024) out.push(buf);
    }
    return out;
}

/**
 * Read the true tile geometry for the board we downloaded.
 * `requested_downloads` comes back empty for storyboard-only pulls, so identify
 * the format by matching its fragment count against the sheets we actually
 * parsed — that is self-validating, unlike trusting a format id.
 */
function _geometryFromInfo(info, sheetCount) {
    const formats = Array.isArray(info && info.formats) ? info.formats : [];
    const boards = formats.filter(f => f && /^sb\d+$/.test(String(f.format_id || '')));
    const sb = boards.find(f => Array.isArray(f.fragments) && f.fragments.length === sheetCount)
        || boards.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (!sb) return null;
    const cols = parseInt(sb.columns, 10) || 0;
    const rows = parseInt(sb.rows, 10) || 0;
    const tw = parseInt(sb.width, 10) || 0;
    const th = parseInt(sb.height, 10) || 0;
    if (!cols || !rows || !tw || !th) return null;
    const fragments = Array.isArray(sb.fragments) ? sb.fragments : [];
    return { cols, rows, tw, th, perSheet: cols * rows, fragments, duration: Number(info.duration) || 0 };
}

const _boardCache = new Map(); // videoId -> { sheets:[Buffer], geom } | null

async function _fetchStoryboard(videoId, opts) {
    if (_boardCache.has(videoId)) return _boardCache.get(videoId);

    // The download is the single longest step in a screening (a flat 90s ceiling),
    // so it is the one that most needs to respect the scene's remaining time.
    const deadline = _deadlineOf(opts);
    const budget = _leftMs(deadline);
    if (budget <= 0) return null; // out of time — and NOT cached, see below
    const timeoutMs = Math.max(1, Math.min(envInt('YOUTUBE_STORYBOARD_TIMEOUT_MS', 90000), budget));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbscout-'));
    let board = null;
    let ranOutOfTime = false;
    let fetchOk = false;
    try {
        // The provider hands us its resolved binary; standalone callers get the
        // house resolver, which knows about the vendored copy next to the repo.
        let bin = opts.ytdlpPath;
        if (!bin) {
            try { bin = require('./providers/ytdlp-utils').findYtdlp({ logPrefix: 'Storyboard Scout' }); } catch (_) { bin = 'yt-dlp'; }
        }
        // sb0 is the highest-resolution board; fall through if a video only has coarser ones.
        const fmt = process.env.YOUTUBE_STORYBOARD_FORMAT || 'sb0/sb1/sb2/sb3';
        const outTpl = path.join(tmpDir, 'sb.%(ext)s');
        await _run(bin, [
            `https://www.youtube.com/watch?v=${videoId}`,
            '-f', fmt,
            '--write-info-json',
            '--no-playlist', '--no-warnings', '--no-check-certificates',
            '-o', outTpl,
        ], opts.signal, timeoutMs);
        // yt-dlp itself came back clean. Everything that fails from here down is a
        // fact about the VIDEO ("it has no usable board"); everything above is a
        // fact about the ATTEMPT (429 / bot check / network / bad signal arg).
        fetchOk = true;

        const files = fs.readdirSync(tmpDir);
        const mhtmlFile = files.find(f => /\.mhtml$/i.test(f));
        const infoFile = files.find(f => /\.info\.json$/i.test(f));
        if (!mhtmlFile || !infoFile) throw new Error('storyboard artifacts missing');

        const sheets = _parseMhtmlImages(fs.readFileSync(path.join(tmpDir, mhtmlFile)));
        if (!sheets.length) throw new Error('no storyboard sheets');

        const info = JSON.parse(fs.readFileSync(path.join(tmpDir, infoFile), 'utf8'));
        const geom = _geometryFromInfo(info, sheets.length);
        if (!geom) throw new Error('no storyboard geometry');

        board = { sheets, geom };
    } catch (_) {
        board = null;
        // Did we fail because the video has no usable board, or because WE cut it
        // short? Only the first is a fact about the video.
        if (timeoutMs < envInt('YOUTUBE_STORYBOARD_TIMEOUT_MS', 90000) && _expired(deadline)) ranOutOfTime = true;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    }

    // A miss caused by US must NOT be remembered — only a miss caused by the VIDEO.
    // _boardCache is module-level and read first, so a cached null is permanent for
    // the process: it would send every later look at this video (including the deep
    // scout, locateWindow, which runs with a far bigger budget) straight to the weak
    // cover-only path. A rate-limit or a network blip on one cheap screen must not
    // cost the video its unhurried second look.
    if (!board && (ranOutOfTime || !fetchOk)) return null;

    // Bound the cache — a build touches a handful of long videos, not hundreds.
    if (_boardCache.size >= 6) _boardCache.delete(_boardCache.keys().next().value);
    _boardCache.set(videoId, board);
    return board;
}

// ── Frame timing ────────────────────────────────────────────────────────────

/**
 * Wall-clock timestamp of global frame `idx`. Fragment durations are the truth
 * when yt-dlp gives them (each fragment == one sheet); otherwise fall back to
 * spreading the video duration evenly, which is what YouTube does anyway.
 */
function _frameTime(geom, idx, totalFrames) {
    const { perSheet, fragments, duration } = geom;
    const sheetIdx = Math.floor(idx / perSheet);
    const withinSheet = idx % perSheet;
    if (fragments.length > sheetIdx && Number(fragments[sheetIdx].duration) > 0) {
        let base = 0;
        for (let i = 0; i < sheetIdx; i++) base += Number(fragments[i].duration) || 0;
        return base + (Number(fragments[sheetIdx].duration) / perSheet) * withinSheet;
    }
    if (duration > 0 && totalFrames > 0) return (duration / totalFrames) * idx;
    return idx * 10;
}

// ── Tile / contact-sheet assembly ───────────────────────────────────────────

/**
 * Draw an arbitrary run of global frame indices into one contact sheet.
 * Source sheets are decoded lazily with a 1-entry cache: an hour-long board is
 * ~46 sheets and holding them all decoded would cost ~95MB of RGBA.
 */
async function _packSheet(board, indices, cols, scale = 1) {
    const C = canvasLib();
    if (!C) return null;
    const { geom, sheets } = board;
    const tw = Math.round(geom.tw * scale);
    const th = Math.round(geom.th * scale);
    const rows = Math.ceil(indices.length / cols);
    const canvas = C.createCanvas(cols * tw, rows * th);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let cachedIdx = -1, cachedImg = null;
    for (let i = 0; i < indices.length; i++) {
        const g = indices[i];
        const sheetIdx = Math.floor(g / geom.perSheet);
        const within = g % geom.perSheet;
        if (sheetIdx >= sheets.length) continue;
        if (sheetIdx !== cachedIdx) {
            // @napi-rs/canvas SEGFAULTS on formats it cannot decode (exit 139, no
            // exception) — one odd sheet would kill the whole build silently.
            if (!isCanvasSafeImage(sheets[sheetIdx])) continue;
            try { cachedImg = await C.loadImage(sheets[sheetIdx]); cachedIdx = sheetIdx; }
            catch (_) { continue; }
        }
        const sx = (within % geom.cols) * geom.tw;
        const sy = Math.floor(within / geom.cols) * geom.th;
        // The final sheet is usually short — skip tiles that fall off its bottom.
        if (sy + geom.th > cachedImg.height + 1) continue;
        const dx = (i % cols) * tw;
        const dy = Math.floor(i / cols) * th;
        try { ctx.drawImage(cachedImg, sx, sy, geom.tw, geom.th, dx, dy, tw, th); } catch (_) { /* skip tile */ }
    }
    return canvas.toBuffer('image/jpeg', envInt('YOUTUBE_STORYBOARD_JPEG_QUALITY', 82));
}

// ── The presence question ───────────────────────────────────────────────────
// Wording is deliberately frozen: this exact phrasing scored 17/17 with zero
// false positives on the validation sweep. "If unsure, answer no" is what makes
// the cascade safe — the model declines instead of inventing a location.

function _presencePrompt(desc, single) {
    const subject = single
        ? 'This is a single frame sampled from a video.'
        : 'This is a contact sheet of thumbnails sampled from one video.';
    const question = single
        ? `QUESTION: does this frame show: "${desc}"?`
        : `QUESTION: does ANY thumbnail on this sheet show: "${desc}"?`;
    return `${subject}

${question}

Answer only about what is visibly present. If unsure, answer no.
Reply with ONLY: {"present":true|false,"confidence":<0-1>,"why":"<8 words max>"}`;
}

// ── Turning a search query into something answerable ────────────────────────
//
// Measured, and the single biggest determinant of whether this works at all:
// the presence question must name ONE concrete thing in a handful of words.
// On the identical contact sheet containing an obvious roadside farm store —
//   "a store or shop"                                            -> yes (correct)
//   "Amish farm store roadside stand Ohio"                       -> no  ("No text visible")
//   "a roadside farm store with a sign, produce/pumpkins out front" -> no
// A compound description reads as a conjunction the model must satisfy in a
// 320x180 thumbnail, so it declines; a place name reads as text to find on
// screen. Pipeline search keywords are exactly the failing shape, so distil
// first. One tiny cached text call, with a crude mechanical floor behind it.

const _probeCache = new Map();

function _floorProbes(query) {
    // Deliberately dumb: first few words of the query. Only reached when the
    // brain call fails, and a bad probe costs a miss, never a wrong answer.
    const words = String(query || '').split(/\s+/).filter(Boolean);
    return words.length ? [words.slice(0, 4).join(' ')] : [];
}

async function _visualProbes(ai, query, sceneText) {
    const key = String(query || '').toLowerCase().trim();
    if (_probeCache.has(key)) return _probeCache.get(key);

    let probes = null;
    try {
        const prompt = `A search query was used to find B-roll footage. I now need to SPOT that subject in tiny, blurry video thumbnails, so I need the plainest possible name for the thing.

QUERY: "${query}"${sceneText ? `\nSCENE: "${String(sceneText).slice(0, 200)}"` : ''}

Pick the ONE main physical subject and name it three times, from plainest to most specific.

Rules:
- #1 must be the PLAINEST name for it, written as "a NOUN or SYNONYM" — an
  indefinite phrase offering two words for the same object, and NO adjectives.
  "a store or shop", "a barn or stable", "a buggy or horse cart", "a bridge or overpass"
  A bare noun on its own ("store") reads as a word to find written on screen. Don't.
- Plainest means fewest adjectives, NOT a broader category. Never climb up to a
  generic class: a store is not "a building", a buggy is not "a vehicle", a barn
  is not "a structure". The noun must still say WHAT IT IS.
- #2 and #3 may add ONE distinguishing word, and must still be the same object.
  Good: ["a store or shop","a farm store","a roadside shop building"]
  Bad:  ["a store or shop","wooden shelves","a horse and buggy"]  <- shelves are indoors, a buggy is a different object
- NEVER use words about age, material or wear — weathered, rustic, wooden, old,
  worn, historic. Those are invisible at thumbnail size and only cause a "no".
  DO keep a word that changes what the whole frame looks like — snow-covered,
  burning, flooded, at night. Those are the easiest things to see at that size.
- 2 to 5 words each, naming something you could point at in a photo.
- NO place names, dates, or abstract ideas — a thumbnail cannot show "Ohio" or "history".

Reply with ONLY: {"probes":["...","...","..."]}`;
        const raw = await ai.callAI(prompt, { maxTokens: 160, taskType: 'utility', temperature: 0.2 });
        const m = String(raw || '').replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
        if (m) {
            const j = JSON.parse(m[0]);
            if (Array.isArray(j.probes)) {
                probes = j.probes
                    .map(p => String(p || '').trim())
                    .filter(p => p.length >= 3 && p.split(/\s+/).length <= 6)
                    .slice(0, 3);
            }
        }
    } catch (_) { /* fall through to the floor */ }

    if (!probes || !probes.length) probes = _floorProbes(query);
    if (_probeCache.size >= 200) _probeCache.clear();
    _probeCache.set(key, probes);
    return probes;
}

function _parsePresence(text) {
    const m = String(text || '').replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const j = JSON.parse(m[0]);
        if (typeof j.present !== 'boolean') return null;
        return { present: j.present, confidence: Number(j.confidence) || 0, why: String(j.why || '').slice(0, 80) };
    } catch (_) { return null; }
}

/**
 * Run the presence question over a batch of prepared images, bounded concurrency.
 *
 * `deadline` (absolute ms, 0 = none) stops workers from CLAIMING new images. Calls
 * already issued are allowed to finish: a vision request in flight has already been
 * paid for — abandoning it still burns the GPU and still lands in the vision cache,
 * so we'd get the cost without the answer. Overrun is therefore capped at `limit`
 * outstanding calls rather than the whole remaining batch.
 */
async function _ask(ai, images, desc, single, minConf, limit, deadline = 0) {
    const out = new Array(images.length).fill(null);
    // How many vision calls were actually ISSUED. When the clock runs out before the
    // first claim, every worker returns immediately and `out` is all-null — which is
    // indistinguishable from "we looked and saw nothing" unless we count. A verdict
    // built from zero looks is not a verdict; callers check this before saying "no".
    out.asked = 0;
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const i = cursor++;
            if (i >= images.length) return;
            if (_expired(deadline)) return;
            if (!images[i]) continue;
            let raw = '';
            try {
                out.asked++;
                raw = await ai.callVisionAI(_presencePrompt(desc, single), images[i].toString('base64'), 'image/jpeg', {
                    maxTokens: 200,
                    maxSide: envInt('YOUTUBE_STORYBOARD_MAX_SIDE', 1600),
                    logVisionCompression: false,
                });
            } catch (_) { continue; }
            const j = _parsePresence(raw);
            if (j && j.present && j.confidence >= minConf) out[i] = j;
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, images.length) }, worker));
    return out;
}

function _bestHit(hits) {
    let bestI = -1, bestC = -1;
    for (let i = 0; i < hits.length; i++) {
        if (hits[i] && hits[i].confidence > bestC) { bestC = hits[i].confidence; bestI = i; }
    }
    return bestI < 0 ? null : { index: bestI, ...hits[bestI] };
}

// ── Self-measured cost ──────────────────────────────────────────────────────
//
// A caller working inside a per-candidate budget has to know what a scout run
// costs BEFORE paying for one, or it spends its whole budget picking a perfect
// window and has nothing left to download with. That is exactly what happened on
// the Aug-5 build: 47s of a 56s YouTube budget went here, the download started
// with 9s left, and all four candidates were aborted mid-transfer.
//
// The answer is not a hard-coded number — that would be wrong on a different
// machine, network or GPU queue, and it would go stale silently. The scout
// remembers what its OWN completed runs took during THIS build and answers from
// that. Before it has evidence it answers with its configured ceiling: the honest
// "I don't know yet, assume the worst", which stops a tight scene from gambling.
// One roomy scene is enough to bootstrap a real number for every scene after it.
const _runMs = [];
const _RUN_SAMPLE_MAX = 12;

function _recordRunMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    _runMs.push(ms);
    if (_runMs.length > _RUN_SAMPLE_MAX) _runMs.shift();
}

/**
 * What one full deep-scout run costs, from this build's own evidence.
 *
 * p75 of completed runs, not the mean: the question a caller is asking is "will
 * this fit", and being wrong is asymmetric — an overrun costs the download, a
 * conservative skip costs only a blind window the post-download judge still
 * checks. Two samples is the minimum that makes a p75 mean anything.
 *
 * @returns {number} milliseconds
 */
function estimatedRunMs() {
    const ceiling = Math.max(1, envInt('YOUTUBE_STORYBOARD_TIMEOUT_MS', 90000));
    if (_runMs.length < 2) return ceiling;
    const sorted = [..._runMs].sort((a, b) => a - b);
    const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
    return Math.max(1, Math.min(ceiling, p75));
}

/** Test hook — drop the measured samples. */
function _resetRunMs() { _runMs.length = 0; }

/** Test hook — feed a completed-run sample without doing a real scout run. */
function _seedRunMs(ms) { _recordRunMs(ms); }

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {string} visualQuery  what the shot needs to LOOK like (search keyword /
 *                              visual intent — not the narration line).
 * @param {string} videoId      YouTube video id.
 * @param {object} opts         { ytdlpPath, signal, minDuration, clipDuration,
 *                                deadline|deadlineMs }
 * @returns {Promise<{startTime:number,confidence:number,frameIndex:number,calls:number,evidence:string}|null>}
 */
async function locateWindow(visualQuery, videoId, opts = {}) {
    if (isDisabled()) return null;

    const desc = String(visualQuery || '').trim();
    const vid = String(videoId || '').trim();
    if (!desc || desc.length < 4 || !vid) return null;
    if (!canvasLib()) return null;

    const cacheKey = `${vid}::${desc.toLowerCase().replace(/\s+/g, ' ')}`;
    if (locateWindow._results.has(cacheKey)) return locateWindow._results.get(cacheKey);

    // Budget guard — the real spend ceiling, since the caller's length gate is about
    // payoff rather than cost. A run is ~30-45 vision calls / ~90s, and it lands inside
    // Step 5 where the box is already warm, so the marginal cost is queue time on a GPU
    // we are paying for anyway. 15 keeps the worst case near 20 minutes of a multi-hour
    // build. First-come, so it is spent on whichever qualifying scenes download first;
    // say so out loud when it trips rather than degrading quietly.
    const maxVideos = envInt('YOUTUBE_STORYBOARD_MAX_VIDEOS', 15);
    if (!locateWindow._videos.has(vid) && locateWindow._videos.size >= maxVideos) {
        console.log(`  🗺️ [Storyboard Scout] budget reached (${maxVideos} videos this run) — skipping, falling back to the heuristic window`);
        return null;
    }
    locateWindow._videos.add(vid);

    let result = null;
    const t0 = Date.now();
    let calls = 0;
    let probesUsed = [];
    // The deep scout is the expensive one (~40 vision calls). It used to run with no
    // clock at all, so a scene whose time was already spent could still sit here for
    // minutes. Absolute, resolved once, and handed to every step below.
    const deadline = _deadlineOf(opts);
    const outOfTime = () => { if (_expired(deadline)) throw new Error('scene ran out of time'); };

    try {
        const ai = require('../brain/ai-provider');
        const board = await _fetchStoryboard(vid, { ...opts, deadline });
        if (!board) throw new Error('no storyboard');

        const { geom, sheets } = board;
        const totalFrames = sheets.length * geom.perSheet;
        if (totalFrames < 12) throw new Error('board too small to be worth searching');

        const minConf = envFloat('YOUTUBE_STORYBOARD_MIN_CONFIDENCE', 0.5);
        const limit = envInt('YOUTUBE_STORYBOARD_CONCURRENCY', 3);

        const probes = await _visualProbes(ai, desc, opts.sceneText);
        if (!probes.length) throw new Error('nothing concrete to look for');
        probesUsed = probes;
        const probe = probes[0];

        // PASS 1 — wide sweep. 5x5 sheets were the validated layout. If the video
        // is long enough that 25-tile sheets would blow the call budget, widen the
        // grid rather than sampling: skipping frames is how you miss the shot.
        const maxSweep = envInt('YOUTUBE_STORYBOARD_MAX_SWEEP_CALLS', 20);
        let perContact = 25;
        while (Math.ceil(totalFrames / perContact) > maxSweep && perContact < 64) perContact += 11;
        const contactCols = Math.round(Math.sqrt(perContact));

        const groups = [];
        for (let i = 0; i < totalFrames; i += perContact) {
            groups.push(Array.from({ length: Math.min(perContact, totalFrames - i) }, (_, k) => i + k));
        }
        const contactImgs = [];
        for (const g of groups) contactImgs.push(await _packSheet(board, g, contactCols));
        calls += contactImgs.length;
        outOfTime();
        const sweep = await _ask(ai, contactImgs, probe, false, minConf, limit, deadline);
        let ranked = sweep.map((h, i) => (h ? { index: i, score: h.confidence, why: h.why } : null)).filter(Boolean);
        if (!ranked.length) throw new Error('subject not present anywhere in the video');

        // A short probe is deliberately broad, so several blocks fire and confidence
        // comes back flat (0.95 everywhere). Corroborate with an alternative wording
        // of the SAME subject to rank them — a block that answers yes to two ways of
        // describing the thing is a better bet than one that answers yes to one.
        if (ranked.length > 1 && probes.length > 1 && !_expired(deadline)) {
            const imgs = ranked.map(r => contactImgs[r.index]);
            calls += imgs.length;
            const votes = await _ask(ai, imgs, probes[1], false, minConf, limit, deadline);
            for (let k = 0; k < ranked.length; k++) {
                if (votes[k]) { ranked[k].score += votes[k].confidence; ranked[k].why += ` + ${votes[k].why}`; }
            }
        }
        ranked.sort((a, b) => b.score - a.score);

        // Drill down, and treat the drill as a VERIFIER rather than just a narrower
        // search. Broad-then-strict: the wide passes use the plain probe so nothing
        // is missed, then the single-frame pass — the biggest, clearest image we
        // ever show — must confirm the SPECIFIC wording. A block that only ever
        // satisfied the plain noun is dropped and the next-best block is tried.
        //
        // That last gate is what stops the obvious failure: "snowy alpine pass"
        // distils to "a forest or woods", every wooded video says yes, and without
        // it we would confidently hand back a green summer forest. Refusing to
        // answer is safe — the heuristic rung below still catches us.
        const verifyProbe = probes[probes.length - 1] || probe;
        const maxDrills = envInt('YOUTUBE_STORYBOARD_MAX_DRILLS', 3);
        let frameIndex = null, confidence = 0, evidence = '';

        for (const cand of ranked.slice(0, maxDrills)) {
            outOfTime();
            const block = groups[cand.index];

            // PASS 2 — split the candidate block into strips of 5.
            const strips = [];
            for (let i = 0; i < block.length; i += 5) strips.push(block.slice(i, i + 5));
            const stripImgs = [];
            for (const s of strips) stripImgs.push(await _packSheet(board, s, 5));
            calls += stripImgs.length;
            const stripWinner = _bestHit(await _ask(ai, stripImgs, probe, false, minConf, limit, deadline));
            if (!stripWinner) continue; // unconfirmed — that block was noise
            outOfTime();

            // PASS 3 — single upscaled frames from the winning strip, asked strictly.
            const finalists = strips[stripWinner.index];
            const frameImgs = [];
            for (const f of finalists) frameImgs.push(await _packSheet(board, [f], 1, envFloat('YOUTUBE_STORYBOARD_FRAME_SCALE', 2)));
            calls += frameImgs.length;
            const frameWinner = _bestHit(await _ask(ai, frameImgs, verifyProbe, true, minConf, limit, deadline));
            if (!frameWinner) continue; // narrowed to a frame and it wasn't the thing

            frameIndex = finalists[frameWinner.index];
            confidence = frameWinner.confidence;
            evidence = frameWinner.why;
            break;
        }

        if (frameIndex === null) throw new Error('wide hits never confirmed on drill-down');

        // A storyboard frame is a ~10s sample, so the subject may have entered just
        // before it. Back off a beat so the clip opens on the approach, not mid-shot.
        const lead = envFloat('YOUTUBE_STORYBOARD_LEAD_IN', 2);
        const t = Math.max(0, _frameTime(geom, frameIndex, totalFrames) - lead);

        result = { startTime: t, confidence, frameIndex, totalFrames, calls, evidence, probe, probes };
    } catch (e) {
        // Graceful — the caller falls through to its next rung. Say WHY though:
        // a miss is usually the probe wording, and that is only diagnosable if the
        // thing we actually asked about appears in the log next to the reason.
        result = null;
        console.log(`  🗺️ [Storyboard Scout] no window — ${e.message}${probesUsed.length ? ` (looked for ${JSON.stringify(probesUsed)})` : ''}`);
    }

    if (result) {
        result.elapsedMs = Date.now() - t0;
        // Only COMPLETED runs are sampled. A run we cut short says nothing about
        // what a real one costs, and feeding the short ones back would make the
        // estimate shrink every time we were in a hurry — the same self-serving
        // feedback loop that killed YouTube on the Aug-5 build.
        _recordRunMs(result.elapsedMs);
    }
    // "We ran out of time" is a fact about this moment, not about the video, so it
    // must not be remembered as "there is no window here" — same reasoning as the
    // board cache above. Also give the video its budget slot back.
    if (!result && _expired(deadline)) {
        locateWindow._videos.delete(vid);
        return null;
    }
    if (locateWindow._results.size >= 200) locateWindow._results.clear();
    locateWindow._results.set(cacheKey, result);
    return result;
}

locateWindow._results = new Map();
locateWindow._videos = new Set();

// ── Pre-download screening ──────────────────────────────────────────────────
//
// locateWindow answers "WHERE in this video is the shot" and is only worth its
// ~40 calls on a video we have already decided to download. The question one
// step earlier is cheaper and far more valuable: "is this video even ABOUT the
// thing?" Today that is answered by the TITLE alone — a string an uploader typed
// for humans, which is why a build can spend three minutes downloading and
// scoring "Duplex Villa Design Ideas 4K" for a root-cellar scene.
//
// The storyboard answers it by LOOKING, for the price of one ~2MB sprite-sheet
// fetch and 2-3 vision calls. Same frozen presence question as the cascade
// above, same "if unsure, say no" safety.
//
// DELIBERATE DIFFERENCE FROM locateWindow: the screen SAMPLES evenly across the
// whole video instead of covering every frame. It is answering a topic question,
// and a video that is about the subject shows it throughout — so an even spread
// is enough, and it keeps the cost flat whether the video is 3 minutes or 3
// hours. The cost of that choice is a genuine miss on a 10-second cameo inside
// an unrelated video, which is why this is a RANKING signal and not a hard gate:
// `present:false` demotes a candidate, it does not delete it. Full coverage
// still happens in locateWindow once a video is actually chosen — and it reuses
// the same cached board, so the fetch here is not paid twice.
//
// Kill switch: YOUTUBE_STORYBOARD_SCREEN=0 (also off when the master
// YOUTUBE_STORYBOARD_SCOUT=0).

function _screenDisabled() {
    return isDisabled() || /^(0|false|off|no)$/i.test(String(process.env.YOUTUBE_STORYBOARD_SCREEN || '').trim());
}

// videoId -> the packed contact sheets from its screening pass. Kept so the
// tiebreak below can ask a second, sharper question about the SAME pictures for
// the price of one vision call — no refetch, no redraw.
const _screenSheets = new Map();

// ── Last resort: the cover picture ───────────────────────────────────────────
//
// A minority of videos publish no storyboard at all (live-stream VODs, very new
// or very short uploads). Without one there is no way to look inside before
// downloading — but every video still has a cover image, derivable from its id
// for free, no key and no quota.
//
// One frame is much weaker evidence than 75: a cover is a picture the uploader
// CHOSE, so it over-represents the best moment and says nothing about the other
// 20 minutes. It is marked `source:'cover'` for exactly that reason and ranks
// below any storyboard verdict. Still better than the alternative, which is
// downloading a video having seen nothing of it.
async function _screenCover(ai, vid, probe, minConf, deadline = 0) {
    const { requestSafeBuffer } = require('../security/safe-download');
    const res = await requestSafeBuffer(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, {
        timeout: Math.max(1, Math.min(12_000, _leftMs(deadline))),
        headers: { 'User-Agent': 'Mozilla/5.0' },
    }, { maxBytes: 2 * 1024 * 1024 });
    const buf = Buffer.from(res.data);
    if (buf.length < 2000) throw new Error('cover too small');
    const answers = await _ask(ai, [buf], probe, true, minConf, 1, deadline);
    const hit = _bestHit(answers);
    // Same rule as the storyboard path: the clock can expire while the cover is
    // downloading, and a "not present" nobody actually looked for is worse than
    // saying nothing — it ranks the video below one that was never screened.
    if (!hit && !answers.asked) throw new Error('scene ran out of time');
    return hit;
}

/** Evenly spread `count` indices across [0, total-1], endpoints included. */
function _evenSample(total, count) {
    if (total <= count) return Array.from({ length: total }, (_, i) => i);
    const out = [];
    const step = (total - 1) / (count - 1);
    for (let i = 0; i < count; i++) out.push(Math.round(i * step));
    return Array.from(new Set(out));
}

/**
 * Does this video visibly contain the subject, judged before downloading it?
 *
 * @returns {Promise<{videoId,present,confidence,why,probe,frames,sheets,calls,elapsedMs}|null>}
 *          null means COULD NOT SCREEN (disabled, no storyboard, no canvas, budget
 *          spent) — the caller must treat that as "no opinion", never as a no.
 */
async function screenVideo(visualQuery, videoId, opts = {}) {
    if (_screenDisabled()) return null;

    const desc = String(visualQuery || '').trim();
    const vid = String(videoId || '').trim();
    if (!desc || desc.length < 4 || !vid) return null;
    if (!canvasLib()) return null;

    const cacheKey = `${vid}::${desc.toLowerCase().replace(/\s+/g, ' ')}`;
    if (screenVideo._results.has(cacheKey)) return screenVideo._results.get(cacheKey);

    // Whole-run vision budget, spent first-come. It therefore runs out on
    // whichever scenes are screened first, and every scene after that silently
    // loses the pre-download look — measured on the 47-scene "300$ Test" plan,
    // the budget was gone by scene 31 and the last five scenes (root cellar,
    // spring house, clay pipe) were never looked at at all.
    //
    // Say so, once, the way locateWindow already does. A capability that
    // switches off partway through a build must not do it quietly: the scenes
    // that lose it look identical in the log to scenes that had nothing to find.
    const maxVideos = envInt('YOUTUBE_STORYBOARD_SCREEN_MAX_VIDEOS', 60);
    if (!screenVideo._videos.has(vid) && screenVideo._videos.size >= maxVideos) {
        if (!screenVideo._budgetWarned) {
            screenVideo._budgetWarned = true;
            console.log(`  🗺️ [Storyboard Screen] vision budget spent (${maxVideos} videos this run) — later scenes download without the pre-download look. Raise YOUTUBE_STORYBOARD_SCREEN_MAX_VIDEOS to extend it.`);
        }
        return null;
    }
    // The scene's clock, resolved once. Every blocking step below gets it, so the
    // budget the caller asked for is the budget this actually takes.
    const deadline = _deadlineOf(opts);
    if (_expired(deadline)) return null;

    screenVideo._videos.add(vid);

    let result = null;
    const t0 = Date.now();
    try {
        const ai = require('../brain/ai-provider');

        // Work out what we are looking for BEFORE fetching anything — the answer
        // is cached per query, and the cover fallback needs it too.
        const probes = await _visualProbes(ai, desc, opts.sceneText);
        if (!probes.length) throw new Error('nothing concrete to look for');
        const probe = probes[0];
        const strictProbe = probes[probes.length - 1] || probe;
        const minConf = envFloat('YOUTUBE_STORYBOARD_SCREEN_MIN_CONFIDENCE', 0.5);
        const limit = envInt('YOUTUBE_STORYBOARD_CONCURRENCY', 3);

        const board = await _fetchStoryboard(vid, { ...opts, deadline });
        const totalFrames = board ? board.sheets.length * board.geom.perSheet : 0;
        if (_expired(deadline)) throw new Error('scene ran out of time');

        if (totalFrames < 4) {
            const hit = await _screenCover(ai, vid, probe, minConf, deadline);
            result = {
                videoId: vid,
                present: !!hit,
                confidence: hit ? hit.confidence : 0,
                why: hit ? hit.why : '',
                probe, strictProbe,
                source: 'cover',
                frames: 1, sheets: 1, calls: 1,
            };
        } else {
            // 25 tiles per sheet is the validated density — at 320x180 tiles that is
            // a 1600x900 image, which survives the vision downscale intact. Going
            // wider to save a call shrinks every tile and is how the subject stops
            // being visible at all.
            const perSheet = 25;
            const maxCalls = Math.max(1, envInt('YOUTUBE_STORYBOARD_SCREEN_CALLS', 3));
            const frameBudget = Math.max(perSheet, envInt('YOUTUBE_STORYBOARD_SCREEN_FRAMES', 75));
            const wanted = Math.min(frameBudget, perSheet * maxCalls, totalFrames);
            const picked = _evenSample(totalFrames, wanted);

            const groups = [];
            for (let i = 0; i < picked.length; i += perSheet) groups.push(picked.slice(i, i + perSheet));

            const imgs = [];
            for (const g of groups) imgs.push(await _packSheet(board, g, 5));
            // Hold the packed sheets so the strict confirm pass below can re-ask a
            // sharper question without re-fetching or re-drawing anything.
            if (_screenSheets.size >= 8) _screenSheets.delete(_screenSheets.keys().next().value);
            _screenSheets.set(vid, imgs);

            const answers = await _ask(ai, imgs, probe, false, minConf, limit, deadline);
            const best = _bestHit(answers);
            // Packing the contact sheets takes ~1s of real decode/re-encode work, so
            // the clock can expire between the check above and the first vision call.
            // Every worker then bails at its claim guard and we'd be holding a
            // zero-evidence "not present" — which the caller ranks BELOW a video
            // nobody screened at all, and which would be cached for the whole run.
            // No looks, no opinion.
            if (!best && !answers.asked) throw new Error('scene ran out of time');

            result = {
                videoId: vid,
                present: !!best,
                confidence: best ? best.confidence : 0,
                why: best ? best.why : '',
                probe, strictProbe,
                source: 'storyboard',
                frames: picked.length,
                sheets: imgs.length,
                calls: answers.asked,
            };
        }
    } catch (e) {
        result = null;   // no opinion — never a "no"
        // Silent by design (a screening failure must never be loud enough to look
        // like a footage problem), but findable when something is actually wrong.
        if (process.env.YOUTUBE_STORYBOARD_DEBUG === '1') {
            console.log(`  [Storyboard Screen] ${vid} could not be screened: ${e.message}`);
        }
    }

    if (result) result.elapsedMs = Date.now() - t0;
    // Out of time is not a verdict. Don't remember it, and hand the video's budget
    // slot back so a later scene with room to spare can still look inside it.
    if (!result && _expired(deadline)) {
        screenVideo._videos.delete(vid);
        return null;
    }
    if (screenVideo._results.size >= 300) screenVideo._results.clear();
    screenVideo._results.set(cacheKey, result);
    return result;
}

screenVideo._results = new Map();
screenVideo._videos = new Set();

/**
 * Screen several candidate videos for one scene, bounded concurrency, with a
 * wall-clock deadline. Whatever has finished when the clock runs out is what the
 * caller gets — screening must never become the thing that makes a scene late.
 *
 * @returns {Promise<Map<string, object|null>>} videoId -> screen result / null
 */
async function screenVideos(visualQuery, videoIds, opts = {}) {
    const out = new Map();
    if (_screenDisabled()) return out;

    const ids = Array.from(new Set((videoIds || []).map(v => String(v || '').trim()).filter(Boolean)));
    if (!ids.length) return out;

    const deadline = _deadlineOf(opts);
    const limit = Math.max(1, Math.min(ids.length, envInt('YOUTUBE_STORYBOARD_SCREEN_CONCURRENCY', 3)));
    // Resolved to an absolute instant ONCE and handed down, so every step inside a
    // screening shares the same clock. Checking it only here — between videos — is
    // what let one slow video (a 90s fetch plus a chain of vision calls) run a 45s
    // budget out to 215.7s and starve the rest of the scene's providers.
    const childOpts = { ...opts, deadline, deadlineMs: 0 };

    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const i = cursor++;
            if (i >= ids.length) return;
            if (_expired(deadline)) return;
            try { out.set(ids[i], await screenVideo(visualQuery, ids[i], childOpts)); }
            catch (_) { out.set(ids[i], null); }
        }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    await _tiebreak(out, opts, deadline);
    return out;
}

/**
 * Broad-then-strict, the cascade this project already validated.
 *
 * The screening question above is deliberately the PLAINEST name for the subject
 * ("a buggy or cart"), because a plain question is what a 320x180 thumbnail can
 * actually answer. The cost of plain is that it is generous: a red boring machine
 * measured as a yes for "a buggy or cart". Harmless when one video says yes —
 * it was going to be raced first anyway. Wasteful when several do, because then
 * the screen has told us nothing about WHICH.
 *
 * So only in that case, ask the tied videos the most specific phrasing of the
 * same subject ("a horse-drawn buggy"). Recall came from the broad pass; this is
 * purely to separate. It re-uses the sheets already in memory, so a tiebreak is
 * one vision call per tied video and never any network.
 *
 * Failing it is not a rejection — the video keeps `present:true` and is still
 * ranked above everything unscreened. It simply stops outranking a video that
 * answered both questions.
 */
async function _tiebreak(results, opts, deadline) {
    const tied = [...results.entries()].filter(([, r]) => r && r.present && _screenSheets.has(r.videoId));
    if (tied.length < 2) return;
    if (_expired(deadline)) return;

    const strict = tied[0][1].strictProbe;
    if (!strict || strict === tied[0][1].probe) return;

    const ai = require('../brain/ai-provider');
    const minConf = envFloat('YOUTUBE_STORYBOARD_SCREEN_MIN_CONFIDENCE', 0.5);
    const limit = envInt('YOUTUBE_STORYBOARD_CONCURRENCY', 3);

    await Promise.all(tied.map(async ([, r]) => {
        try {
            const answers = await _ask(ai, _screenSheets.get(r.videoId), strict, false, minConf, limit, deadline);
            const hit = _bestHit(answers);
            // Same rule as every other verdict in this file: the clock can expire
            // between the check above and the first vision call, and then every
            // worker bails at its claim guard and `hit` is falsy for a video nobody
            // asked. Halving a genuine yes on that basis would demote a confirmed
            // video below another confirmed one for a question we never posed.
            if (!hit && !answers.asked) return;
            r.strictConfirmed = !!hit;
            if (hit) {
                r.confidence = Math.max(r.confidence, hit.confidence);
                if (hit.why) r.why = hit.why;
            } else {
                // Still a yes on the plain question, just a weaker one.
                r.confidence = r.confidence * 0.5;
            }
        } catch (_) { /* no opinion — leave the broad verdict standing */ }
    }));
}

module.exports = { locateWindow, screenVideo, screenVideos, estimatedRunMs, _resetRunMs, _seedRunMs };
