/**
 * Media Memory Bank
 *
 * Project-scoped source memory for the media downloader. This is different
 * from the file cache: it remembers sources, search lanes, candidate verdicts,
 * and useful windows so later scenes can reuse promising sources even when
 * they were not perfect for the scene that discovered them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../settings/config');
const { normalizeUrlForDedup } = require('../util/url-utils');

const VERSION = 1;
const MAX_SOURCES = Math.max(100, Math.min(5000, parseInt(process.env.MEDIA_MEMORY_MAX_SOURCES || '900', 10) || 900));
const DEFAULT_LIMIT = Math.max(1, Math.min(12, parseInt(process.env.MEDIA_MEMORY_RETRIEVE_LIMIT || '5', 10) || 5));
const MIN_RETRIEVE_SCORE = Math.max(0.08, Math.min(0.9, Number(process.env.MEDIA_MEMORY_MIN_SCORE || 0.34)));
const MIN_ANCHOR_HITS = Math.max(1, Math.min(6, parseInt(process.env.MEDIA_MEMORY_MIN_ANCHOR_HITS || '2', 10) || 2));
const STOP_WORDS = new Set(String(process.env.MEDIA_MEMORY_STOP_WORDS || `
the a an and or of to in on for with without from into onto about this that these those your our their its it is are was were be been being as at by before after over under not no yes
scene video footage image clip shot shots close up close-up full frame fullscreen background template card graphic text bold editorial showing shows show visual intent media source provider search query
agentic setting environment standard generic context theme lane mode role domain authority provider need mission brief target accepted rejected usable result candidate scout hunter memory
`).split(/\s+/).map(s => s.trim().toLowerCase()).filter(Boolean));

// Path segments that are how a provider organises its site, not what a clip shows.
// These come free with every URL from that host, so they carry zero signal and
// would otherwise match every source from the same provider.
const PROVIDER_PATH_WORDS = new Set(String(process.env.MEDIA_MEMORY_URL_STOP_WORDS || `
video videos photo photos image images clip clips stock footage watch embed media file files
download preview thumb thumbs large medium small orig original content upload uploads assets
www com net org html htm jpg jpeg png webp mp4 mov webm search result results page
`).split(/\s+/).map(s => s.trim().toLowerCase()).filter(Boolean));

let _bank = null;
let _filePath = '';
let _dirty = false;

function _nowIso() {
    return new Date().toISOString();
}

function _safeMkdir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function _bankPath(opts = {}) {
    if (opts.filePath) return opts.filePath;
    const dir = opts.tempDir || config.paths?.temp || process.cwd();
    return path.join(dir, 'media-source-memory-bank.json');
}

function _assetDir(opts = {}) {
    if (opts.assetDir) return opts.assetDir;
    const bankFile = _filePath || _bankPath(opts);
    return path.join(path.dirname(bankFile), 'media-memory-assets');
}

function _emptyBank(scriptContext = {}) {
    return {
        version: VERSION,
        createdAt: _nowIso(),
        updatedAt: _nowIso(),
        project: {
            title: scriptContext.title || scriptContext.videoTitle || scriptContext.topic || '',
            nicheId: scriptContext.nicheId || '',
        },
        sources: {},
    };
}

function initMediaMemoryBank(scriptContext = {}, opts = {}) {
    _filePath = _bankPath(opts);
    _bank = null;
    try {
        if (fs.existsSync(_filePath)) {
            const parsed = JSON.parse(fs.readFileSync(_filePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.sources && typeof parsed.sources === 'object') {
                _bank = parsed;
            }
        }
    } catch (_) {
        _bank = null;
    }
    if (!_bank) _bank = _emptyBank(scriptContext);
    _bank.version = VERSION;
    _bank.updatedAt = _nowIso();
    _bank.project = {
        ...(typeof _bank.project === 'object' && _bank.project ? _bank.project : {}),
        title: scriptContext.title || scriptContext.videoTitle || scriptContext.topic || _bank.project?.title || '',
        nicheId: scriptContext.nicheId || _bank.project?.nicheId || '',
    };
    _dirty = true;
    saveMediaMemoryBank();
    return _bank;
}

function ensureBank(scriptContext = {}) {
    if (!_bank) initMediaMemoryBank(scriptContext);
    return _bank;
}

function saveMediaMemoryBank() {
    if (!_bank || !_filePath || !_dirty) return;
    try {
        _bank.updatedAt = _nowIso();
        _prune();
        _safeMkdir(path.dirname(_filePath));
        fs.writeFileSync(_filePath, JSON.stringify(_bank, null, 2));
        _dirty = false;
    } catch (_) {}
}

function getMediaMemoryPath() {
    return _filePath || _bankPath();
}

function _clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function _short(value, max = 180) {
    const text = _clean(value);
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _tokens(value, max = 64) {
    const text = _clean(value).toLowerCase();
    const raw = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{1,}/gu) || [];
    const out = [];
    const seen = new Set();
    for (const token of raw) {
        const t = token.replace(/^[-']+|[-']+$/g, '');
        if (t.length < 3 || STOP_WORDS.has(t) || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= max) break;
    }
    return out;
}

function _candidateUrl(result = {}) {
    return _clean(
        result.url
        || result._cachedMeta?.url
        || result._meta?.url
        || result._sourcePage
        || result._cachedMeta?._sourcePage
        || result._meta?._sourcePage
        || result._directVideoUrl
        || result._fallbackUrl
        || result._cachedMeta?._fallbackUrl
        || result._meta?._fallbackUrl
    );
}

function _candidateDirectUrl(result = {}) {
    return _clean(
        result._directVideoUrl
        || result._fallbackUrl
        || result._cachedMeta?._fallbackUrl
        || result._meta?._fallbackUrl
    );
}

function _candidateTitle(result = {}) {
    return _short(
        result.title
        || result._cachedMeta?.title
        || result._meta?.title
        || result.description
        || result.alt
        || result.url
        || '',
        220
    );
}

function _sourceKey(result = {}, providerKey = '') {
    const url = _candidateUrl(result);
    const normalized = normalizeUrlForDedup(url);
    if (normalized) return `url:${normalized}`;
    const title = _candidateTitle(result).toLowerCase();
    return title ? `title:${providerKey}:${title.slice(0, 160)}` : '';
}

function _hashText(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function _assetExtension(filePath = '', result = {}, opts = {}) {
    const ext = path.extname(String(opts.ext || filePath || '')).toLowerCase();
    if (ext) return ext;
    const mediaType = String(opts.mediaType || result.mediaType || '').toLowerCase();
    if (mediaType === 'image') return '.jpg';
    if (mediaType === 'video') return '.mp4';
    return '.bin';
}

function _copyAcceptedAssetToMemory(source, result = {}, opts = {}) {
    const src = String(opts.path || result.path || '').trim();
    if (!src || !fs.existsSync(src)) return null;
    let stat = null;
    try { stat = fs.statSync(src); } catch (_) { return null; }
    if (!stat || !stat.isFile() || stat.size <= 0) return null;

    const dir = _assetDir(opts);
    _safeMkdir(dir);
    const ext = _assetExtension(src, result, opts);
    const sceneIndex = Number.isFinite(Number(opts.sceneIndex)) ? Number(opts.sceneIndex) : null;
    const start = Number.isFinite(Number(opts.startTime)) ? Math.max(0, Math.round(Number(opts.startTime))) : null;
    const keyHash = _hashText(source.key || source.url || source.title || src);
    const startLabel = start !== null ? `s${start}` : 'full';
    const sceneLabel = sceneIndex !== null ? `scene${sceneIndex}` : 'sceneX';
    const basename = `${source.providerKey || 'source'}-${keyHash}-${startLabel}-${sceneLabel}${ext}`;
    const dest = path.join(dir, basename);

    try {
        if (path.resolve(src).toLowerCase() !== path.resolve(dest).toLowerCase()) {
            fs.copyFileSync(src, dest);
        }
        const copied = fs.statSync(dest);
        return {
            path: dest,
            basename,
            size: copied.size,
            ext,
            copiedAt: _nowIso(),
        };
    } catch (_) {
        return null;
    }
}

function _sceneIndex(scene) {
    scene = scene || {}; // tolerate an explicit null (default params only catch undefined)
    const value = scene.originalIndex ?? scene.index;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function _contextText(scene = {}, scriptContext = {}, opts = {}) {
    const agent = opts.mediaAgent || {};
    const hunter = opts.mediaHunter || {};
    const contract = opts.visualContract || {};
    return [
        scriptContext.title,
        scriptContext.videoTitle,
        scriptContext.topic,
        scene.text,
        scene.keyword,
        scene.searchKeyword,
        scene.webQuery,
        scene.stockQuery,
        scene.templateBgQuery,
        scene.visualIntent,
        agent.assetClass,
        agent.viewerNeed,
        agent.target,
        agent.minimumAcceptable,
        agent.acceptanceTest,
        ...(Array.isArray(agent.mustShow) ? agent.mustShow : []),
        ...(Array.isArray(agent.mandatoryIdentity) ? agent.mandatoryIdentity : []),
        ...(Array.isArray(agent.mandatoryVisible) ? agent.mandatoryVisible : []),
        hunter.targetDescription,
        hunter.domain,
        ...(Array.isArray(hunter.prefer) ? hunter.prefer : []),
        ...(Array.isArray(contract.mustShow) ? contract.mustShow : []),
        opts.query,
    ].filter(Boolean).join(' ');
}

/**
 * Turn a URL into the words a human would use for it.
 *
 * Several providers hand back no title at all, so _candidateTitle falls through
 * to the raw URL — which used to tokenise into {https, www, pexels, com} and
 * swamp a source's tags with noise that matches every other source from the same
 * host. The slug is usually the only real description a stock clip has
 * ("a-woman-shopping-for-fresh-vegetables-8027660"), so keep that and drop the
 * scheme, the host, the provider's structural path segments and the numeric id.
 */
function _deUrl(value) {
    const text = _clean(value);
    if (!/^https?:\/\//i.test(text)) return text;
    let rest;
    try {
        const u = new URL(text);
        rest = `${u.pathname} ${u.searchParams.get('q') || ''}`;
    } catch (_) {
        rest = text.replace(/^https?:\/\/[^/]+/i, '');
    }
    return rest
        .replace(/\.[a-z0-9]{2,4}$/i, '')
        .split(/[/_\-.+%\s]+/)
        .filter((part) => part && !/^\d+$/.test(part) && !PROVIDER_PATH_WORDS.has(part.toLowerCase()))
        .join(' ');
}

function _sourceTags(result = {}, scene = {}, scriptContext = {}, opts = {}) {
    const agent = opts.mediaAgent || {};
    const hunter = opts.mediaHunter || {};
    const text = [
        _deUrl(_candidateTitle(result)),
        result.description,
        result.alt,
        result._sourceSearchQuery,
        opts.query,
        _deUrl(result.description),
        scene.keyword,
        scene.searchKeyword,
        scene.templateBgQuery,
        agent.assetClass,
        agent.viewerNeed,
        agent.target,
        ...(Array.isArray(agent.mustShow) ? agent.mustShow : []),
        ...(Array.isArray(agent.mandatoryIdentity) ? agent.mandatoryIdentity : []),
        hunter.targetDescription,
        hunter.domain,
    ].filter(Boolean).join(' ');
    return _tokens(text, 80);
}

function _mergeCountMap(target = {}, tokens = [], amount = 1) {
    for (const token of tokens || []) {
        if (!token) continue;
        target[token] = (Number(target[token]) || 0) + amount;
    }
    return target;
}

function rememberMediaSource(result = {}, scene = {}, scriptContext = {}, opts = {}) {
    if (process.env.MEDIA_MEMORY_BANK === '0') return null;
    const providerKey = _clean(opts.providerKey || result._provider || result._topicScout?.providerKey).toLowerCase();
    const key = _sourceKey(result, providerKey);
    if (!key) return null;
    const bank = ensureBank(scriptContext);
    const now = _nowIso();
    const sceneIndex = _sceneIndex(scene);
    const title = _candidateTitle(result);
    const url = _candidateUrl(result);
    const directUrl = _candidateDirectUrl(result);
    const score = Number(opts.score ?? result._candidateFinalistScore ?? result._mediaScoutScore ?? result.score ?? 0) || 0;
    const tags = _sourceTags(result, scene, scriptContext, opts);
    const existing = bank.sources[key] || {
        key,
        providerKey,
        providerName: opts.providerName || result.provider || providerKey,
        mediaType: opts.mediaType || result.mediaType || '',
        title,
        url,
        directUrl,
        duration: Number(result.duration || result._cachedMeta?.duration || result._meta?.duration || 0) || 0,
        width: Number(result.width || result._cachedMeta?.width || result._meta?.width || 0) || 0,
        height: Number(result.height || result._cachedMeta?.height || result._meta?.height || 0) || 0,
        firstSeenAt: now,
        lastSeenAt: now,
        firstScene: sceneIndex,
        lastScene: sceneIndex,
        queries: [],
        tags: {},
        sceneUses: [],
        windows: [],
        seen: 0,
        accepted: 0,
        rejected: 0,
        bestScore: 0,
        bestPostScore: 0,
        bestDeepScore: 0,
        lastReason: '',
    };

    existing.providerKey = providerKey || existing.providerKey;
    existing.providerName = opts.providerName || existing.providerName || providerKey;
    existing.mediaType = opts.mediaType || existing.mediaType || result.mediaType || '';
    existing.title = title || existing.title;
    existing.url = url || existing.url;
    existing.directUrl = directUrl || existing.directUrl;
    existing.duration = Number(result.duration || result._cachedMeta?.duration || result._meta?.duration || existing.duration || 0) || 0;
    existing.width = Number(result.width || result._cachedMeta?.width || result._meta?.width || existing.width || 0) || 0;
    existing.height = Number(result.height || result._cachedMeta?.height || result._meta?.height || existing.height || 0) || 0;
    existing.lastSeenAt = now;
    existing.lastScene = sceneIndex;
    existing.seen += 1;
    if (opts.status === 'accepted') existing.accepted += 1;
    if (opts.status === 'rejected') existing.rejected += 1;
    existing.bestScore = Math.max(Number(existing.bestScore || 0), score);
    existing.bestPostScore = Math.max(Number(existing.bestPostScore || 0), Number(opts.postScore || 0));
    existing.bestDeepScore = Math.max(Number(existing.bestDeepScore || 0), Number(opts.deepScore || 0));
    existing.lastReason = _short(opts.reason || result._scoutRejectReason || existing.lastReason || '', 240);
    existing.queries = Array.from(new Set([...(existing.queries || []), opts.query, result._sourceSearchQuery].filter(Boolean).map(_clean))).slice(-24);
    _mergeCountMap(existing.tags, tags, 1);
    let copiedAsset = null;
    if (opts.status === 'accepted' && opts.path) {
        copiedAsset = _copyAcceptedAssetToMemory(existing, result, { ...opts, sceneIndex });
        if (copiedAsset) {
            existing.assetPath = copiedAsset.path;
            existing.assetBasename = copiedAsset.basename;
            existing.assetSize = copiedAsset.size;
            existing.assetExt = copiedAsset.ext;
            existing.assetCopiedAt = copiedAsset.copiedAt;
            existing.assets = [...(existing.assets || []), {
                path: copiedAsset.path,
                basename: copiedAsset.basename,
                size: copiedAsset.size,
                ext: copiedAsset.ext,
                scene: sceneIndex,
                startTime: Number.isFinite(Number(opts.startTime)) ? Number(opts.startTime) : null,
                duration: Number(opts.duration || 0) || 0,
                score,
                reason: _short(opts.reason || '', 160),
                at: copiedAsset.copiedAt,
            }].slice(-12);
        }
    }
    const sceneUse = {
        scene: sceneIndex,
        query: _short(opts.query || result._sourceSearchQuery || '', 120),
        status: opts.status || 'seen',
        score,
        reason: _short(opts.reason || '', 160),
        at: now,
    };
    existing.sceneUses = [...(existing.sceneUses || []), sceneUse].slice(-40);
    if (opts.window || Number.isFinite(Number(opts.startTime))) {
        existing.windows = [...(existing.windows || []), {
            scene: sceneIndex,
            startTime: Number(opts.startTime ?? opts.window?.startTime ?? result._smartStartTime ?? result._smartStartTimeUsed ?? 0) || 0,
            duration: Number(opts.duration ?? opts.window?.duration ?? 0) || 0,
            score,
            postScore: Number(opts.postScore || 0) || 0,
            deepScore: Number(opts.deepScore || 0) || 0,
            accepted: opts.status === 'accepted',
            reason: _short(opts.reason || '', 180),
            assetPath: copiedAsset?.path || '',
            at: now,
        }].slice(-30);
    }

    bank.sources[key] = existing;
    _dirty = true;
    if (opts.save !== false) saveMediaMemoryBank();
    return existing;
}

function rememberMediaSources(results = [], scene = {}, scriptContext = {}, opts = {}) {
    if (!Array.isArray(results) || results.length === 0) return 0;
    const limit = Math.max(1, Math.min(80, Number(opts.limit || 30)));
    let count = 0;
    for (const result of results.slice(0, limit)) {
        if (rememberMediaSource(result, scene, scriptContext, { ...opts, save: false })) count++;
    }
    if (count > 0) saveMediaMemoryBank();
    return count;
}

function _scoreSource(source = {}, scene = {}, scriptContext = {}, opts = {}) {
    const providerKey = _clean(opts.providerKey).toLowerCase();
    const mediaType = _clean(opts.mediaType).toLowerCase();
    if (providerKey && source.providerKey && source.providerKey !== providerKey) return null;
    if (mediaType && source.mediaType && source.mediaType !== mediaType) return null;
    const sceneIndex = _sceneIndex(scene);
    if (sceneIndex !== null && Number.isFinite(Number(source.lastScene)) && Math.abs(Number(source.lastScene) - sceneIndex) <= 1) {
        return null;
    }
    const wanted = _tokens(_contextText(scene, scriptContext, opts), 96);
    if (wanted.length === 0) return null;
    const sourceTokens = new Set([
        ...Object.keys(source.tags || {}),
        ..._tokens([source.title, source.queries?.join(' '), source.lastReason].filter(Boolean).join(' '), 64),
    ]);
    let hit = 0;
    const matched = [];
    for (const token of wanted) {
        if (sourceTokens.has(token)) {
            hit++;
            if (matched.length < 8) matched.push(token);
        }
    }
    if (hit < Math.min(MIN_ANCHOR_HITS, wanted.length)) return null;
    const coverage = hit / Math.max(8, Math.min(48, wanted.length));
    const quality = Math.min(0.35, (Math.max(Number(source.bestScore || 0), Number(source.bestPostScore || 0), Number(source.bestDeepScore || 0)) / 10) * 0.25);
    const acceptedBonus = Number(source.accepted || 0) > 0 ? 0.12 : 0;
    const queryBonus = (source.queries || []).some(q => wanted.some(t => _clean(q).toLowerCase().includes(t))) ? 0.06 : 0;
    const score = coverage + quality + acceptedBonus + queryBonus;
    if (score < MIN_RETRIEVE_SCORE) return null;
    return { score, matched };
}

function findMediaMemoryCandidates(scene = {}, scriptContext = {}, opts = {}) {
    if (process.env.MEDIA_MEMORY_BANK === '0') return [];
    const bank = ensureBank(scriptContext);
    const limit = Math.max(1, Math.min(24, Number(opts.limit || DEFAULT_LIMIT)));
    const scored = [];
    for (const source of Object.values(bank.sources || {})) {
        const verdict = _scoreSource(source, scene, scriptContext, opts);
        if (!verdict) continue;
        scored.push({ source, ...verdict });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ source, score, matched }) => {
        const assetPath = source.assetPath && fs.existsSync(source.assetPath) ? source.assetPath : '';
        const bestWindow = (source.windows || [])
            .slice()
            .sort((a, b) => {
                const qa = (Number(a.accepted || 0) ? 20 : 0) + Number(a.score || 0) + Number(a.postScore || 0) + Number(a.deepScore || 0);
                const qb = (Number(b.accepted || 0) ? 20 : 0) + Number(b.score || 0) + Number(b.postScore || 0) + Number(b.deepScore || 0);
                return qb - qa;
            })[0] || null;
        const candidate = {
            title: source.title,
            url: source.url,
            duration: source.duration || 0,
            width: source.width || 0,
            height: source.height || 0,
            _provider: source.providerKey,
            _sourceSearchQuery: (source.queries || [])[source.queries.length - 1] || opts.query || '',
            _mediaMemory: {
                key: source.key,
                score,
                matched,
                accepted: source.accepted || 0,
                seen: source.seen || 0,
                bestScore: source.bestScore || 0,
                assetPath,
                assetBasename: assetPath ? (source.assetBasename || path.basename(assetPath)) : '',
                assetSize: assetPath ? (source.assetSize || 0) : 0,
                startTime: Number.isFinite(Number(bestWindow?.startTime)) ? Number(bestWindow.startTime) : null,
                windowDuration: Number(bestWindow?.duration || 0) || 0,
                reason: `memory match ${Math.round(score * 100)}% (${matched.slice(0, 5).join(', ') || 'source context'})`,
            },
            _cachedMeta: {
                title: source.title,
                url: source.url,
                duration: source.duration || 0,
                width: source.width || 0,
                height: source.height || 0,
                _sourcePage: source.url,
                _fallbackUrl: source.directUrl || undefined,
            },
        };
        if (!assetPath && Number.isFinite(Number(bestWindow?.startTime))) {
            candidate._smartStartTime = Number(bestWindow.startTime);
            candidate._previewScoutSegment = {
                startTime: Number(bestWindow.startTime),
                confidence: Math.max(0.6, Math.min(0.95, Number(bestWindow.score || bestWindow.postScore || bestWindow.deepScore || 7) / 10)),
                reason: bestWindow.reason || 'remembered useful media window',
            };
            candidate._previewScoutReason = candidate._previewScoutSegment.reason;
            candidate._previewScoutScore = candidate._previewScoutSegment.confidence;
        }
        if (source.directUrl) candidate._fallbackUrl = source.directUrl;
        return candidate;
    });
}

function _prune() {
    if (!_bank?.sources) return;
    const entries = Object.entries(_bank.sources);
    if (entries.length <= MAX_SOURCES) return;
    entries.sort(([, a], [, b]) => {
        const qa = (Number(a.accepted || 0) * 100) + Number(a.bestScore || 0) + Number(a.seen || 0);
        const qb = (Number(b.accepted || 0) * 100) + Number(b.bestScore || 0) + Number(b.seen || 0);
        if (qb !== qa) return qb - qa;
        return String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''));
    });
    _bank.sources = Object.fromEntries(entries.slice(0, MAX_SOURCES));
}

function summarizeMediaMemoryBank() {
    const bank = ensureBank();
    const sources = Object.values(bank.sources || {});
    const byProvider = {};
    let assetCount = 0;
    for (const source of sources) {
        const key = source.providerKey || 'unknown';
        byProvider[key] = (byProvider[key] || 0) + 1;
        if (source.assetPath && fs.existsSync(source.assetPath)) assetCount++;
    }
    return {
        path: getMediaMemoryPath(),
        count: sources.length,
        assetCount,
        assetDir: _assetDir(),
        byProvider,
    };
}

module.exports = {
    // Exported so the cross-video footage library tags sources with exactly the
    // same words this bank does — one tokenizer, no drift between the two.
    tokenizeMediaText: _tokens,
    deUrlMediaText: _deUrl,
    initMediaMemoryBank,
    saveMediaMemoryBank,
    getMediaMemoryPath,
    rememberMediaSource,
    rememberMediaSources,
    findMediaMemoryCandidates,
    summarizeMediaMemoryBank,
};
