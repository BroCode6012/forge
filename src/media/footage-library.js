'use strict';

/**
 * The cross-video footage library.
 *
 * `media-memory-bank.js` already remembers every source one video saw — the
 * queries that found it, the vision scores it earned, the scenes it served, and
 * for accepted clips the file itself. That memory then dies with the project,
 * so every new video re-discovers, re-downloads and re-judges the same footage.
 * On a 346-scene build that meant 11,492 candidates examined and 1,605 rejected,
 * almost all of it repeated work.
 *
 * This promotes that per-video memory into a library shared by every video in a
 * NICHE, living in Studio next to the assets it describes:
 *
 *     Studio/_footage-library/<niche>/index.json   every source ever seen
 *     Studio/_footage-library/<niche>/assets/      files kept for winners only
 *
 * Three rules the creator chose, and the reasoning behind each:
 *
 *  - INDEX ALWAYS, FILES FOR WINNERS. Remembering a source costs a couple of KB;
 *    keeping its file costs megabytes, and one video's winners came to 1.1 GB.
 *    So every source is remembered and only accepted, well-scored clips keep
 *    their bytes. A remembered-but-not-kept source still saves the search.
 *
 *  - SAME NICHE, ANY CHANNEL. A good "honey being poured" clip serves any food
 *    channel he runs, so the library is keyed by niche rather than by channel.
 *
 *  - REMEMBER THE REJECTS. A source the judge threw out is worth as much as one
 *    it kept: it stops the next video paying the download and the vision call to
 *    reach the same verdict. Negative memory needs no new shape — a reject is
 *    simply a record with `accepted: 0` and a `lastReason`.
 *
 * Nothing here may ever break a build. Every export is best-effort and returns
 * empty rather than throwing: no Studio folder, no niche, an unreadable index or
 * a full disk all mean Forge behaves exactly as it did before the library existed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { tokenizeMediaText, deUrlMediaText } = require('./media-memory-bank');

const STUDIO_ROOT = process.env.STUDIO_ROOT || 'D:\\Youtube\\Studio';
const LIBRARY_DIRNAME = '_footage-library';
const INDEX_FILE = 'index.json';
const ASSET_DIRNAME = 'assets';
const VERSION = 1;

/** Keep an asset's bytes only when the judge actually accepted it this well. */
const KEEP_ASSET_MIN_SCORE = _num(process.env.FOOTAGE_LIBRARY_KEEP_MIN_SCORE, 7, 1, 10);
/** Hard ceiling on remembered sources per niche, oldest-and-least-useful pruned first. */
const MAX_SOURCES = _num(process.env.FOOTAGE_LIBRARY_MAX_SOURCES, 20000, 500, 200000);
/** Hard ceiling on kept asset files per niche. */
const MAX_ASSETS = _num(process.env.FOOTAGE_LIBRARY_MAX_ASSETS, 4000, 50, 100000);
/** How many of a channel's own videos must pass before a clip may repeat on it. */
const CHANNEL_REPEAT_GAP = _num(process.env.FOOTAGE_LIBRARY_CHANNEL_GAP, 10, 0, 500);
/** A retrieved candidate must share at least this many meaningful words. */
const MIN_ANCHOR_HITS = _num(process.env.FOOTAGE_LIBRARY_MIN_ANCHORS, 2, 1, 8);
const DEFAULT_LIMIT = _num(process.env.FOOTAGE_LIBRARY_LIMIT, 6, 1, 40);
/** Per-channel video history kept for the repeat guard. */
const CHANNEL_SEQ_MAX = 400;

function _num(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function _enabled() {
    return process.env.FOOTAGE_LIBRARY !== '0';
}

function _nowIso() {
    return new Date().toISOString();
}

/**
 * A niche id is a path segment, so it has to be safe to put in a folder name.
 * `explainer.food` is fine as-is; anything stranger is flattened rather than
 * rejected, because a library that quietly stops working is worse than one
 * filed under a slightly odd name.
 */
function _nicheSlug(niche) {
    const clean = String(niche || '').trim().toLowerCase();
    if (!clean) return '';
    return clean.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * Where this niche's library lives. Returns null when there is no niche to key
 * on — an unfiled library would mix every subject together and poison retrieval.
 */
function resolveLibrary({ niche } = {}) {
    if (!_enabled()) return null;
    const slug = _nicheSlug(niche);
    if (!slug) return null;
    const dir = path.join(STUDIO_ROOT, LIBRARY_DIRNAME, slug);
    return {
        niche: slug,
        dir,
        indexPath: path.join(dir, INDEX_FILE),
        assetDir: path.join(dir, ASSET_DIRNAME),
    };
}

function _emptyIndex(niche) {
    return {
        version: VERSION,
        niche,
        createdAt: _nowIso(),
        updatedAt: _nowIso(),
        // Per-channel video order, so the repeat guard can ask "how many of this
        // channel's videos have gone by since this clip last appeared on it".
        channels: {},
        sources: {},
    };
}

function readIndex({ niche } = {}) {
    const lib = resolveLibrary({ niche });
    if (!lib) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(lib.indexPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.sources) return _emptyIndex(lib.niche);
        parsed.channels = parsed.channels || {};
        return parsed;
    } catch (_) {
        return _emptyIndex(lib.niche);
    }
}

/** Write via a temp file + rename so an interrupted build cannot leave a torn index. */
function _writeIndex(lib, index) {
    try {
        fs.mkdirSync(lib.dir, { recursive: true });
        index.updatedAt = _nowIso();
        const tmp = `${lib.indexPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
        fs.renameSync(tmp, lib.indexPath);
        return true;
    } catch (err) {
        console.warn(`[Footage Library] could not save the index: ${err.message}`);
        return false;
    }
}

/** Tokens that describe a URL rather than a picture. See _sourceWords. */
const URL_NOISE = new Set([
    'http', 'https', 'www', 'com', 'net', 'org', 'html', 'htm', 'cdn', 'static',
    'pexels', 'pixabay', 'unsplash', 'storyblocks', 'youtube', 'youtu', 'reddit',
    'bing', 'brave', 'google', 'imgur', 'wikimedia', 'wikipedia',
    'video', 'videos', 'photo', 'photos', 'image', 'images', 'watch', 'embed',
    'download', 'preview', 'thumb', 'thumbs', 'orig', 'original', 'large', 'small',
]);

/**
 * The words that describe what a source SHOWS.
 *
 * Uses the bank's own tokenizer so the library and the per-video memory always
 * agree on what a clip is about. `tags` on a bank record is a count map, and a
 * word the source earned repeatedly is a stronger claim than one it earned once.
 */
function _sourceWords(source = {}) {
    const fromTags = Object.entries(source.tags || {})
        .sort((a, b) => (b[1] || 0) - (a[1] || 0))
        .map(([word]) => word)
        // Banks written before the URL fix tagged sources with {https, www, pexels,
        // com}, which matches every other source from the same host and would make
        // retrieval return noise. Drop that legacy debris on the way in rather than
        // rewriting old banks.
        .filter((word) => !URL_NOISE.has(word));
    if (fromTags.length) return fromTags.slice(0, 60);
    const text = [source.title, ...(source.queries || [])].filter(Boolean).join(' ');
    return tokenizeMediaText(deUrlMediaText(text), 60);
}

/** How much a source is worth keeping when the library is over its cap. */
function _sourceValue(source = {}) {
    const best = Number(source.bestPostScore || source.bestScore || 0) || 0;
    const accepted = Number(source.accepted || 0) || 0;
    const rejected = Number(source.rejected || 0) || 0;
    // A confident reject is genuinely useful — it saves a future download — but a
    // proven winner is worth more, and a kept file more still.
    return (accepted * 6) + (best * 2) + (rejected > 0 ? 2 : 0) + (source.assetPath ? 5 : 0);
}

function _prune(index, lib) {
    const entries = Object.entries(index.sources || {});
    if (entries.length <= MAX_SOURCES) return;
    entries.sort((a, b) => _sourceValue(b[1]) - _sourceValue(a[1]));
    const keep = entries.slice(0, MAX_SOURCES);
    const drop = entries.slice(MAX_SOURCES);
    for (const [, source] of drop) {
        if (!source.assetPath) continue;
        try { fs.unlinkSync(path.join(lib.assetDir, source.assetPath)); } catch (_) {}
    }
    index.sources = Object.fromEntries(keep);
    console.log(`[Footage Library] pruned ${drop.length} low-value source(s) from ${lib.niche}`);
}

function _pruneAssets(index, lib) {
    const withAsset = Object.values(index.sources || {}).filter((s) => s.assetPath);
    if (withAsset.length <= MAX_ASSETS) return;
    withAsset.sort((a, b) => _sourceValue(b) - _sourceValue(a));
    for (const source of withAsset.slice(MAX_ASSETS)) {
        try { fs.unlinkSync(path.join(lib.assetDir, source.assetPath)); } catch (_) {}
        source.assetPath = '';
        source.assetSize = 0;
    }
}

function _copyAsset(lib, absSource, key) {
    try {
        if (!absSource || !fs.existsSync(absSource)) return null;
        const stat = fs.statSync(absSource);
        if (!stat.isFile() || stat.size < 1024) return null;
        fs.mkdirSync(lib.assetDir, { recursive: true });
        const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
        const name = `${hash}${path.extname(absSource).toLowerCase() || '.bin'}`;
        const dest = path.join(lib.assetDir, name);
        if (!fs.existsSync(dest) || fs.statSync(dest).size !== stat.size) {
            fs.copyFileSync(absSource, dest);
        }
        return { name, size: stat.size };
    } catch (_) {
        return null;
    }
}

function _noteChannelVideo(index, channelSlug, videoId) {
    if (!channelSlug || !videoId) return;
    const entry = index.channels[channelSlug] || { seq: [] };
    if (!entry.seq.includes(videoId)) {
        entry.seq.push(videoId);
        if (entry.seq.length > CHANNEL_SEQ_MAX) entry.seq = entry.seq.slice(-CHANNEL_SEQ_MAX);
    }
    index.channels[channelSlug] = entry;
}

/**
 * Fold one finished video's memory bank into the niche library.
 *
 * Deliberately runs at the END of a build rather than replacing the per-video
 * bank: the download path is the most crash-sensitive code in the pipeline, and
 * a library that only ever reads finished state cannot destabilise it.
 */
function mergeVideoBank({ bankPath, assetDir, niche, channelSlug, vaultId, videoId } = {}) {
    const lib = resolveLibrary({ niche });
    if (!lib || !bankPath) return null;

    let bank;
    try {
        bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
    } catch (_) {
        return null;
    }
    const incoming = Object.entries(bank.sources || {});
    if (!incoming.length) return null;

    const index = readIndex({ niche });
    if (!index) return null;
    _noteChannelVideo(index, channelSlug, videoId);

    let added = 0;
    let updated = 0;
    let filesKept = 0;

    for (const [key, source] of incoming) {
        if (!key || !source) continue;
        const existing = index.sources[key];
        const bestPost = Number(source.bestPostScore || 0) || 0;
        const accepted = Number(source.accepted || 0) || 0;

        const record = existing || {
            key,
            providerKey: source.providerKey || '',
            providerName: source.providerName || '',
            mediaType: source.mediaType || '',
            title: source.title || '',
            url: source.url || '',
            directUrl: source.directUrl || '',
            duration: Number(source.duration || 0) || 0,
            width: Number(source.width || 0) || 0,
            height: Number(source.height || 0) || 0,
            firstSeenAt: _nowIso(),
            tags: {},
            queries: [],
            windows: [],
            seen: 0,
            accepted: 0,
            rejected: 0,
            bestScore: 0,
            bestPostScore: 0,
            lastReason: '',
            assetPath: '',
            assetSize: 0,
            // Which of his videos have already used this clip, and on which
            // channel — this is what the repeat guard reads.
            uses: {},
        };

        record.seen = (Number(record.seen) || 0) + (Number(source.seen) || 0);
        record.accepted = (Number(record.accepted) || 0) + accepted;
        record.rejected = (Number(record.rejected) || 0) + (Number(source.rejected) || 0);
        record.bestScore = Math.max(Number(record.bestScore) || 0, Number(source.bestScore) || 0);
        record.bestPostScore = Math.max(Number(record.bestPostScore) || 0, bestPost);
        record.lastReason = source.lastReason || record.lastReason;
        record.lastSeenAt = _nowIso();
        record.title = record.title || source.title || '';
        record.url = record.url || source.url || '';
        record.directUrl = record.directUrl || source.directUrl || '';
        if (Array.isArray(source.windows) && source.windows.length) {
            record.windows = (record.windows || []).concat(source.windows).slice(-12);
        }
        for (const q of source.queries || []) {
            if (q && !record.queries.includes(q)) record.queries.push(q);
        }
        record.queries = record.queries.slice(-24);
        for (const [word, count] of Object.entries(source.tags || {})) {
            record.tags[word] = (Number(record.tags[word]) || 0) + (Number(count) || 0);
        }

        if (accepted > 0 && channelSlug) {
            record.uses[channelSlug] = { videoId: videoId || '', at: _nowIso() };
        }

        // Files only for winners — this is the whole disk budget in one condition.
        if (!record.assetPath && accepted > 0 && bestPost >= KEEP_ASSET_MIN_SCORE) {
            const abs = source.assetPath && path.isAbsolute(source.assetPath)
                ? source.assetPath
                : (source.assetPath && assetDir ? path.join(assetDir, path.basename(source.assetPath)) : '');
            const copied = _copyAsset(lib, abs, key);
            if (copied) {
                record.assetPath = copied.name;
                record.assetSize = copied.size;
                filesKept++;
            }
        }

        if (existing) updated++; else added++;
        index.sources[key] = record;
    }

    _prune(index, lib);
    _pruneAssets(index, lib);
    if (!_writeIndex(lib, index)) return null;

    const total = Object.keys(index.sources).length;
    console.log(`[Footage Library] ${lib.niche}: +${added} new, ${updated} updated, `
        + `${filesKept} file(s) kept — ${total} source(s) known`);
    return { niche: lib.niche, added, updated, filesKept, total };
}

/**
 * Has this clip been on THIS channel too recently to use again?
 *
 * Reuse across his channels is deliberate and allowed; reuse inside one channel
 * is what a returning viewer would notice, so a clip has to wait out a number of
 * that channel's own videos before it can come back.
 */
function _tooRecentOnChannel(record, index, channelSlug) {
    if (!channelSlug || CHANNEL_REPEAT_GAP <= 0) return false;
    const use = (record.uses || {})[channelSlug];
    if (!use || !use.videoId) return false;
    const seq = ((index.channels || {})[channelSlug] || {}).seq || [];
    const at = seq.indexOf(use.videoId);
    if (at < 0) return false;
    return (seq.length - 1 - at) < CHANNEL_REPEAT_GAP;
}

/**
 * Find library sources that match what a scene is asking for.
 *
 * Returns both winners and known rejects. A caller uses the winners to skip
 * searching entirely, and the rejects to avoid re-downloading something this
 * niche has already judged and thrown out.
 */
function findLibraryCandidates(scene = {}, opts = {}) {
    const niche = opts.niche;
    const lib = resolveLibrary({ niche });
    if (!lib) return { winners: [], rejects: [], known: 0 };

    const index = readIndex({ niche });
    if (!index) return { winners: [], rejects: [], known: 0 };

    const wanted = new Set(tokenizeMediaText(deUrlMediaText([
        scene.visualIntent,
        scene.keyword,
        scene.searchKeyword,
        scene.stockQuery,
        scene.webQuery,
        opts.query,
    ].filter(Boolean).join(' ')), 40));
    if (!wanted.size) return { winners: [], rejects: [], known: 0 };

    const channelSlug = opts.channelSlug || '';
    const limit = _num(opts.limit, DEFAULT_LIMIT, 1, 40);
    const winners = [];
    const rejects = [];

    for (const record of Object.values(index.sources || {})) {
        const words = _sourceWords(record);
        let hits = 0;
        for (const w of words) if (wanted.has(w)) hits++;
        if (hits < MIN_ANCHOR_HITS) continue;

        const overlap = hits / Math.max(3, wanted.size);
        const entry = {
            key: record.key,
            providerKey: record.providerKey,
            providerName: record.providerName,
            mediaType: record.mediaType,
            title: record.title,
            url: record.url,
            directUrl: record.directUrl,
            duration: record.duration,
            width: record.width,
            height: record.height,
            windows: record.windows || [],
            bestPostScore: record.bestPostScore,
            accepted: record.accepted,
            rejected: record.rejected,
            lastReason: record.lastReason,
            anchorHits: hits,
            matchScore: Number((overlap + (record.bestPostScore || 0) / 20).toFixed(4)),
            assetPath: record.assetPath ? path.join(lib.assetDir, record.assetPath) : '',
        };

        if (record.accepted > 0) {
            if (_tooRecentOnChannel(record, index, channelSlug)) continue;
            if (entry.assetPath && !fs.existsSync(entry.assetPath)) entry.assetPath = '';
            winners.push(entry);
        } else if (record.rejected > 0) {
            rejects.push(entry);
        }
    }

    winners.sort((a, b) => b.matchScore - a.matchScore);
    rejects.sort((a, b) => b.anchorHits - a.anchorHits);
    return {
        winners: winners.slice(0, limit),
        rejects: rejects.slice(0, limit * 4),
        known: Object.keys(index.sources || {}).length,
    };
}

function summarizeLibrary({ niche } = {}) {
    const lib = resolveLibrary({ niche });
    if (!lib) return null;
    const index = readIndex({ niche });
    if (!index) return null;
    const sources = Object.values(index.sources || {});
    const withAsset = sources.filter((s) => s.assetPath);
    return {
        niche: lib.niche,
        dir: lib.dir,
        sources: sources.length,
        winners: sources.filter((s) => s.accepted > 0).length,
        rejects: sources.filter((s) => s.accepted === 0 && s.rejected > 0).length,
        assets: withAsset.length,
        assetBytes: withAsset.reduce((n, s) => n + (Number(s.assetSize) || 0), 0),
        channels: Object.keys(index.channels || {}).length,
    };
}

module.exports = {
    resolveLibrary,
    readIndex,
    mergeVideoBank,
    findLibraryCandidates,
    summarizeLibrary,
};
