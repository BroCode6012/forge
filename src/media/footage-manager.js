const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('../settings/config');
const uiLog = require('../util/logger'); // structured Build Log events (uiLog.sceneEvt)
const { getBackgroundSource } = require('../data/themes');
const { getNiche, rewriteQuery, getFallbackKeywords, getSearchPolicy } = require('../data/niches');
const { scoreDownloadedVideo } = require('../agents/smart-segment');
const clipAnalyzer = require('./clip-analyzer');
const {
    buildMediaHunterProfile,
    buildProviderQueries,
    rankResultsForHunter,
    getHunterFallbackKeywords,
    summarizeMediaHunter,
} = require('./media-hunter');
const {
    allowsRelevantPersonFootage,
    classifyStrictRawVisual,
    isSmallNonBlockingWatermark,
    isCroppableCornerWatermark,
    isTopicAccurateMapFromPremiumStock,
} = require('./relevant-person-rules');
const {
    buildVisualContract,
    summarizeVisualContract,
    scoutMediaResults,
} = require('./media-scout');
const {
    buildMediaAgentPlan,
    buildMediaAgentRepairPlan,
    fallbackPlan: buildFallbackMediaAgentPlan,
    summarizeMediaAgentPlan,
    getMediaAgentProviderOrder,
    getMediaAgentProviderLock,
    getMediaAgentProviderSkipReason,
} = require('./media-agent');
const { normalizeUrlForDedup } = require('../util/url-utils');
const visionCache = require('../vision/vision-cache');
const { prescreenClip } = require('./clip-prescreen');
const { judgeTitles: _titleSanityJudge } = require('./title-sanity');
const { applyVisionScoreSanity } = require('../vision/vision-score-sanity');
const {
    judgeYouTubeSERP: _thumbnailVisionYouTube,
    judgeThumbnailGrid: _thumbnailVisionGrid,
    screenThumbnailGrid: _thumbnailScreen,
} = require('../vision/thumbnail-vision');
const {
    rankCandidateFinalists,
} = require('./candidate-finalist-scout');
const { runCandidateRace, getProviderConcurrency } = require('./candidate-race');
const providerScoreboard = require('./provider-scoreboard');
const downloadPatience = require('./download-patience');
const {
    initMediaMemoryBank,
    rememberMediaSource,
    rememberMediaSources,
    findMediaMemoryCandidates,
    summarizeMediaMemoryBank,
} = require('./media-memory-bank');
const {
    applySearchKeywordSplit,
    buildSearchKeywordVariants,
    buildYouTubeQueryLadder,
    normalizeEntityContext,
    repairDisplaySearchQuery,
    trimSearchKeyword,
    observeScenes: observePhraseScenes,
    rememberPhraseWin,
} = require('./search-keywords');
const { DISABLED_VIDEO_PROVIDER_KEYS, sanitizeSourceHint } = require('./source-policy');

// Temporary development switch: keep search/download/final vision, but bypass
// pre-download relevance gates and hard media-intent locks so we can compare
// what the raw provider pool would have produced.
const OPEN_MEDIA_GATES = /^(1|true|yes|on)$/i.test(String(
    process.env.MEDIA_OPEN_GATES
    || process.env.MEDIA_GAUNTLET_OPEN
    || process.env.OPEN_MEDIA_GATES
    || ''
).trim());

// ─── Scene-scoped log buffering ──────────────────────────────────────
// When downloading scenes in parallel, logs from different scenes interleave
// making output unreadable. AsyncLocalStorage tracks which scene each async
// call belongs to, buffering output per-scene and flushing as clean blocks.
const _logStorage = new AsyncLocalStorage();
// Mutable so the Scout Lab (single-scene test harness) can redirect scene-buffer
// flushes into its UI bridge instead of the real terminal. Default = real stdout.
let _originalConsoleLog = console.log.bind(console);
function setLogSink(fn) {
    if (typeof fn === 'function') {
        _originalConsoleLog = (...args) => {
            try { fn(...args); } catch (_) {}
        };
    } else {
        _originalConsoleLog = console.log.bind(console);
    }
}

// Import all providers
const YouTubeVideoProvider = require('./providers/youtube-video');
const RedditVideoProvider = require('./providers/reddit-video');
const StoryblocksVideoProvider = require('./providers/storyblocks-video');
const PexelsVideoProvider = require('./providers/pexels-video');
const PixabayVideoProvider = require('./providers/pixabay-video');
const PexelsImageProvider = require('./providers/pexels-image');
const PixabayImageProvider = require('./providers/pixabay-image');
const BingImageProvider = require('./providers/bing-image');
const BraveImageProvider = require('./providers/brave-image');
const veoProvider = require('./providers/veo-video'); // opt-in AI-video, Veo backend (dormant without VEO_API_KEY)
const klingVideoProvider = require('./providers/kling-video-browser'); // opt-in AI-video, Kling backend (browser bridge, uses account credits — no key)

// Provider type sets (mirrors niches.js for query routing)
const STOCK_PROVIDERS = new Set(['pexels', 'pixabay']);
const WEB_PROVIDERS = new Set(['reddit', 'bing']);

// ── AI-video helpers (shared by the Kling + Veo backends) ───────────────────
// Build a descriptive, text-free generation prompt from the scene's visual intent.
function _buildAiVideoPrompt(scene, keyword) {
    const base = [scene?.visualIntent, scene?.stockQuery, keyword]
        .map(s => String(s || '').trim())
        .filter(Boolean)[0] || 'cinematic documentary b-roll';
    return `${base}. Cinematic, realistic, high detail, natural lighting, no on-screen text, no captions, no logos.`;
}
function _veoAspect(scriptContext) {
    const fmt = String(scriptContext?.format || scriptContext?.aspectRatio || process.env.BUILD_FORMAT || '').toLowerCase();
    if (/9:16|vertical|short|reel|tiktok/.test(fmt)) return '9:16';
    return '16:9';
}
// Nominal output dims (renderer re-probes actual media; this just seeds non-zero).
function _aiVideoDims(aspect, backend) {
    const resEnv = backend === 'veo'
        ? (process.env.VEO_RESOLUTION || '720p')
        : (process.env.KLING_VIDEO_RESOLUTION || '1080p');
    const hi = String(resEnv).trim().toLowerCase() === '1080p';
    const [w, h] = hi ? [1920, 1080] : [1280, 720];
    return aspect === '9:16' ? { w: h, h: w } : { w, h };
}
const YOUTUBE_PROVIDERS = new Set(['youtube']);
// Providers that do their own pre-download smart segment scoring (via smart-segment.js).
// These skip the post-download segment quality check (but still get relevance scoring).
const PRESCORE_PROVIDERS = new Set(['youtube']);

function _queryKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _uniqueQueryLanes(values, max = 3) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const key = _queryKey(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
}

const LOW_BANDWIDTH_MODE = config.network?.lowBandwidth === true;
function _readSceneConcurrencySetting() {
    const fallback = LOW_BANDWIDTH_MODE ? 1 : 3;
    const entries = [
        ['MEDIA_SCENE_CONCURRENCY', process.env.MEDIA_SCENE_CONCURRENCY],
        ['SCENE_DOWNLOAD_CONCURRENCY', process.env.SCENE_DOWNLOAD_CONCURRENCY],
        ['DOWNLOAD_CONCURRENCY', process.env.DOWNLOAD_CONCURRENCY],
    ];
    const picked = entries.find(([, value]) => String(value || '').trim() !== '');
    const raw = picked ? picked[1] : String(fallback);
    const parsed = parseInt(raw, 10);
    return {
        value: Math.max(1, Math.min(8, Number.isFinite(parsed) ? parsed : fallback)),
        source: picked ? picked[0] : 'default',
        raw,
    };
}
const DOWNLOAD_CONCURRENCY_SETTING = _readSceneConcurrencySetting();
const DOWNLOAD_CONCURRENCY = DOWNLOAD_CONCURRENCY_SETTING.value;
const SCENE_DOWNLOAD_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.SCENE_DOWNLOAD_TIMEOUT_MS || String((LOW_BANDWIDTH_MODE ? 6 : 3) * 60 * 1000), 10) || ((LOW_BANDWIDTH_MODE ? 6 : 3) * 60 * 1000));
const STRICT_RAW_TIMEOUT_EXPLICIT = Boolean(process.env.STRICT_RAW_SCENE_TIMEOUT_MS);
const STRICT_RAW_PRIMARY_TIMEOUT_MS = Math.max(120_000, parseInt(process.env.STRICT_RAW_SCENE_TIMEOUT_MS || String((LOW_BANDWIDTH_MODE ? 10 : 6) * 60 * 1000), 10) || ((LOW_BANDWIDTH_MODE ? 10 : 6) * 60 * 1000));
const STRICT_RAW_LARGE_BUILD_TIMEOUT_MS = Math.max(90_000, parseInt(process.env.STRICT_RAW_LARGE_BUILD_TIMEOUT_MS || '180000', 10) || 180_000);
const STRICT_RAW_LARGE_BUILD_SCENES = Math.max(8, Math.min(40, parseInt(process.env.STRICT_RAW_LARGE_BUILD_SCENES || '16', 10) || 16));
const ENABLE_LARGE_BUILD_STRICT_CAP = process.env.MEDIA_ENABLE_LARGE_BUILD_STRICT_CAP === '1';
const STRICT_RAW_BACKUP_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.STRICT_RAW_BACKUP_TIMEOUT_MS || String((LOW_BANDWIDTH_MODE ? 4 : 2) * 60 * 1000), 10) || ((LOW_BANDWIDTH_MODE ? 4 : 2) * 60 * 1000));
// Lowered May 20, 2026 from 0.84 → 0.70: when scene Omni cap is tight, segments
// that the multi-frame Preview Scout marked confident were being thrown out
// because they couldn't clear an extra exact-window check. Trusting scout-
// confident (>=0.70) segments to skip exact-window validation lets later
// candidates survive instead of dying to "scene Omni cap blocked".
const STRICT_RAW_SEGMENT_DEADLINE_ACCEPT_CONFIDENCE = Math.max(0.7, Math.min(0.95, Number(process.env.STRICT_RAW_SEGMENT_DEADLINE_ACCEPT_CONFIDENCE || 0.70)));
const STRICT_RAW_STOCK_RESERVE_MS = Math.max(35_000, parseInt(process.env.STRICT_RAW_STOCK_RESERVE_MS || '90000', 10) || 90_000);
const STRICT_RAW_STOCK_MIN_ATTEMPT_MS = Math.max(18_000, parseInt(process.env.STRICT_RAW_STOCK_MIN_ATTEMPT_MS || '20000', 10) || 20_000);
const STRICT_RAW_STOCK_VARIANTS = Math.max(1, Math.min(8, parseInt(process.env.STRICT_RAW_STOCK_VARIANTS || '5', 10) || 5));
const SCENE_TIMEOUT_GRACE_MS = Math.max(0, Math.min(300_000, parseInt(process.env.SCENE_TIMEOUT_GRACE_MS || '180000', 10) || 180_000));
const RACE_INFLIGHT_GRACE_MS = Math.max(30_000, Math.min(300_000, parseInt(process.env.MEDIA_RACE_INFLIGHT_GRACE_MS || '120000', 10) || 120_000));
const RACE_INFLIGHT_MAX_EXTENSION_MS = Math.max(RACE_INFLIGHT_GRACE_MS, Math.min(600_000, parseInt(process.env.MEDIA_RACE_INFLIGHT_MAX_EXTENSION_MS || '240000', 10) || 240_000));
const DEAD_URL_CACHE_TTL_MS = Math.max(60_000, parseInt(process.env.DEAD_MEDIA_URL_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10) || (7 * 24 * 60 * 60 * 1000));
const SEARCH_GUARD_PROVIDERS = new Set(['youtube', 'reddit']);
const TEMP_SCENE_MEDIA_EXTS = ['.mp4', '.webm', '.mov', '.mkv', '.jpg', '.jpeg', '.png', '.webp'];
const STOCK_VIDEO_PROVIDER_KEYS = new Set(['pexels', 'pixabay']);
const PREVIEW_SCOUT_PROVIDER_KEYS = new Set(['youtube', 'reddit', 'pexels', 'pixabay']);

function _preferredStockVideoProviderKey() {
    return Array.from(STOCK_VIDEO_PROVIDER_KEYS)[0] || 'pexels';
}

function _getMediaAgentStockProviderSkipReason(agentPlan) {
    for (const providerKey of STOCK_VIDEO_PROVIDER_KEYS) {
        const reason = getMediaAgentProviderSkipReason(agentPlan, providerKey);
        if (reason) return `${providerKey}: ${reason}`;
    }
    return getMediaAgentProviderSkipReason(agentPlan, 'stock');
}
// Lowered 2026-05-19 from 4 → 2: preview scout was burning the entire 180s
// scene budget on candidates 3-4; first 2 picks already find the right clip
// in practice. Higher value left available via env override for builds with
// plenty of vision quota.
const PREVIEW_SCOUT_MAX_CANDIDATES = Math.max(0, Math.min(8, parseInt(process.env.MEDIA_PREVIEW_SCOUT_TOP_N || '4', 10) || 4));
const PREVIEW_SCOUT_BANK_MAX_CANDIDATES = Math.max(0, Math.min(PREVIEW_SCOUT_MAX_CANDIDATES, parseInt(process.env.MEDIA_PREVIEW_SCOUT_BANK_TOP_N || '4', 10) || 4));
const PREVIEW_SCOUT_FRAMES = Math.max(3, Math.min(9, parseInt(process.env.MEDIA_PREVIEW_SCOUT_FRAMES || '5', 10) || 5));
const PREVIEW_SCOUT_MIN_DURATION = Math.max(30, parseInt(process.env.MEDIA_PREVIEW_SCOUT_MIN_DURATION || '60', 10) || 60);
// Raised 2026-05-19 from 55s → 90s: leaves a real ~30s reserve for actual
// download after preview scout accepts. With 55s, a candidate could start
// with 55s left, run ~50s, leaving 5s — not enough to download the clip.
const PREVIEW_SCOUT_MIN_BUDGET_MS = Math.max(30_000, parseInt(process.env.MEDIA_PREVIEW_SCOUT_MIN_BUDGET_MS || '90000', 10) || 90_000);
const PREVIEW_SCOUT_APPROVED_ONLY = process.env.MEDIA_PREVIEW_SCOUT_APPROVED_ONLY !== '0';
const PREVIEW_SCOUT_WINDOW_VALIDATION = process.env.MEDIA_PREVIEW_SCOUT_WINDOW_VALIDATION !== '0';
const PREVIEW_SCOUT_WINDOW_MIN_BUDGET_MS = Math.max(18_000, parseInt(process.env.MEDIA_PREVIEW_SCOUT_WINDOW_MIN_BUDGET_MS || '26000', 10) || 26_000);
const PREVIEW_SCOUT_KEEP_REJECTED = process.env.MEDIA_PREVIEW_SCOUT_KEEP_REJECTED === '1';
const LIGHTWEIGHT_TRIM_PROVIDER_KEYS = new Set(['reddit']);
const DUMB_TRIM_MIN_SCORE = Math.max(1, Math.min(10, parseInt(process.env.DUMB_TRIM_MIN_SCORE || '5', 10) || 5));
const DUMB_TRIM_PROBE_MIN_BUDGET_MS = Math.max(18_000, parseInt(process.env.DUMB_TRIM_PROBE_MIN_BUDGET_MS || '32000', 10) || 32_000);
const IMAGE_SEARCH_MIN_BUDGET_MS = Math.max(3_000, parseInt(process.env.IMAGE_SEARCH_MIN_BUDGET_MS || '3000', 10) || 3_000);
const IMAGE_ATTEMPT_MIN_BUDGET_MS = Math.max(4_000, parseInt(process.env.IMAGE_ATTEMPT_MIN_BUDGET_MS || '4000', 10) || 4_000);
const IMAGE_DOWNLOAD_MIN_BUDGET_MS = Math.max(3_000, parseInt(process.env.IMAGE_DOWNLOAD_MIN_BUDGET_MS || '3000', 10) || 3_000);
const IMAGE_VISION_BUDGET_MS = Math.max(4_000, parseInt(process.env.IMAGE_VISION_BUDGET_MS || '4000', 10) || 4_000);
const IMAGE_MAX_TRIES = Math.max(3, Math.min(12, parseInt(process.env.IMAGE_MAX_TRIES || '8', 10) || 8));
const FINALIST_SCOUT_MIN_BUDGET_MS = Math.max(4_000, parseInt(process.env.MEDIA_FINALIST_SCOUT_MIN_BUDGET_MS || '7000', 10) || 7_000);
// One vision call plus a handful of thumbnail fetches. Deliberately cheaper
// than the finalist scout's floor: this pass runs BEFORE any download, so on a
// tight scene it is the pass most worth affording — skipping it is what makes
// the rest of the scene expensive.
const THUMBNAIL_SCREEN_MIN_BUDGET_MS = Math.max(4_000, parseInt(process.env.MEDIA_THUMBNAIL_SCREEN_MIN_BUDGET_MS || '9000', 10) || 9_000);

// ── ONE VISION LAYER (default ON) ──────────────────────────────────────────
// Keep ONLY the post-download merged vision score (clipAnalyzer.analyzeClip) — the actual
// accept/reject verdict on the downloaded clip. Skip the REDUNDANT vision passes that
// re-judge the same thing: the Preview Scout (a pre-download multi-frame Omni scan of the
// top candidates) and the extra post-score Deep Analysis. Those add ~2-4 extra vision calls
// per candidate × up to 32 candidates per scene — the single biggest driver of the Qwen
// rate-limit cascade and the per-scene slowness. One verdict, applied once. Set
// MEDIA_ONE_VISION_LAYER=0 to restore the full multi-pass gauntlet.
const ONE_VISION_LAYER = process.env.MEDIA_ONE_VISION_LAYER !== '0';
const FINALIST_COMPARE_MAX = Math.max(1, Math.min(5, parseInt(process.env.MEDIA_FINALIST_COMPARE_MAX || '4', 10) || 4));
// A clip scoring >= this is ACCEPTED IMMEDIATELY (never held for comparison). The vision
// PASS bar is 6 (anything below 6 is rejected), so setting this to 6 means "the FIRST clip
// that clears the bar wins, right now" — nothing is ever held. This was 9 (unreachable →
// everything held → deadline killed held clips → AI fallback even with real footage in hand),
// then 7 (a bare-pass 6 still got held + discarded — observed Scene 3 threw away a 6/10 and
// fell back). At 6 the held-then-discarded-at-deadline failure mode is GONE, and scenes
// accept sooner so they don't burn the budget. 7+ is rare anyway (≈7 clips in a 240-scene
// build). Override via env (set 7/8 to re-enable comparison for higher quality at the risk
// of deadline discards).
const FINALIST_FAST_ACCEPT_SCORE = Math.max(6, Math.min(10, parseInt(process.env.MEDIA_FINALIST_FAST_ACCEPT_SCORE || '6', 10) || 6));
const FINALIST_COMPARE_MIN_BUDGET_MS = Math.max(12_000, parseInt(process.env.MEDIA_FINALIST_COMPARE_MIN_BUDGET_MS || '20000', 10) || 20_000);
const MEDIA_AGENT_REPAIR_MIN_BUDGET_MS = Math.max(20_000, parseInt(process.env.MEDIA_AGENT_REPAIR_MIN_BUDGET_MS || '55000', 10) || 55_000);
const STRICT_RAW_DEADLINE_SEGMENT_ACCEPT_SCORE = Math.max(6, Math.min(10, parseInt(process.env.STRICT_RAW_DEADLINE_SEGMENT_ACCEPT_SCORE || '7', 10) || 7));
// Per-scene Omni frame caps raised May 20, 2026: previous caps (24/14/12 with 1
// grant) starved hard scenes like S22 — Preview Scout would burn the cap on
// candidates #1-3, then candidates #4-N would die to "scene Omni cap blocked
// exact-window validation" before vision could even run. Doubled the base caps
// and raised grants from 1 → 3 so the scout can validate the full candidate
// pool when title-sanity has already trimmed obvious junk.
const SCENE_OMNI_FRAME_CAP = Math.max(8, Math.min(48, parseInt(process.env.SCENE_OMNI_FRAME_CAP || '48', 10) || 48));
const SCENE_OMNI_FRAME_CAP_TOPIC_BANK = Math.max(6, Math.min(36, parseInt(process.env.SCENE_OMNI_FRAME_CAP_TOPIC_BANK || '28', 10) || 28));
const SCENE_OMNI_FRAME_CAP_BACKUP = Math.max(6, Math.min(32, parseInt(process.env.SCENE_OMNI_FRAME_CAP_BACKUP || '24', 10) || 24));
const SCENE_OMNI_GRANT_FRAMES = Math.max(4, Math.min(24, parseInt(process.env.SCENE_OMNI_GRANT_FRAMES || '12', 10) || 12));
const SCENE_OMNI_GRANTS_MAX = Math.max(0, Math.min(3, parseInt(process.env.SCENE_OMNI_GRANTS_MAX || '3', 10) || 3));

function _needsStrictRawSceneBudget(scene) {
    if (!scene || (scene.mediaType || 'video') !== 'video') return false;
    if (scene.fullscreenMG || scene.mediaIntent?.policy?.download === 'skip') return false;
    if (scene.mediaIntent?.policy?.download === 'template') return false;
    // Media intent lanes are best-effort planner metadata. Older/AI-repaired
    // scenes can still be normal real footage with no lane set, and those were
    // falling back to the generic 3-minute cap. Treat every downloadable video
    // scene as strict enough to deserve the real media budget; graphic/template
    // skips are filtered above.
    return true;
}

function _effectiveSceneTimeoutMs(scene, baseTimeoutMs, label = '') {
    if (!_needsStrictRawSceneBudget(scene)) return baseTimeoutMs;
    const isBackup = /template backup/i.test(String(label || '')) || scene.mediaIntent?.lane === 'videoBackup';
    const primaryTimeout = ENABLE_LARGE_BUILD_STRICT_CAP && scene?._largeBuildStrictTimeout
        ? Math.min(STRICT_RAW_PRIMARY_TIMEOUT_MS, STRICT_RAW_LARGE_BUILD_TIMEOUT_MS)
        : STRICT_RAW_PRIMARY_TIMEOUT_MS;
    return Math.max(baseTimeoutMs, isBackup ? STRICT_RAW_BACKUP_TIMEOUT_MS : primaryTimeout);
}

function cleanupSceneTempMedia(filenameBase) {
    if (!filenameBase) return 0;
    let removed = 0;
    for (const ext of TEMP_SCENE_MEDIA_EXTS) {
        const file = path.join(config.paths.temp, `${filenameBase}${ext}`);
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
                removed++;
            }
        } catch (_) {
            // Best effort only. The public copy step still requires sourceProvider.
        }
    }
    return removed;
}

function cleanupSceneRaceTempMedia(filenameBase, keepPath = '') {
    if (!filenameBase) return 0;
    let removed = 0;
    const tempDir = config.paths.temp;
    const keepResolved = keepPath ? path.resolve(keepPath) : '';
    const racePrefixes = [
        `${filenameBase}.race-`,
        `${filenameBase}-race-`,
    ];
    try {
        if (!fs.existsSync(tempDir)) return 0;
        for (const entry of fs.readdirSync(tempDir)) {
            if (!racePrefixes.some(prefix => entry.startsWith(prefix))) continue;
            const fullPath = path.join(tempDir, entry);
            if (keepResolved && path.resolve(fullPath) === keepResolved) continue;
            try {
                if (!fs.statSync(fullPath).isFile()) continue;
                fs.unlinkSync(fullPath);
                removed++;
            } catch (_) {
                // Best effort cleanup; active downloads may still own a scratch file.
            }
        }
    } catch (_) {
        // Best effort only. Stale scratch files are annoying, not build-critical.
    }
    return removed;
}

function _mediaIntentPolicy(scene) {
    return scene?.mediaIntent?.policy || {};
}

function _hasHardVisualEntityRequirement(contract = {}) {
    return [
        contract.mandatoryVisible,
        contract.hardVisibleEntities,
        contract.mandatoryIdentity,
    ].some(values => Array.isArray(values) && values.length > 0);
}

function _isPlannerExactImageReference(scene) {
    if (!scene) return false;
    const policy = _mediaIntentPolicy(scene);
    const type = String(policy.mediaType || scene.mediaType || '').toLowerCase();
    const source = sanitizeSourceHint(policy.sourceHint || scene.sourceHint || '', 'youtube') || '';
    const lane = String(scene.mediaIntent?.lane || '').toLowerCase();
    return type === 'image' && (source === 'web-image' || lane === 'mapimage');
}

function _mediaAgentHasAuthority(scene) {
    return Boolean(scene?._mediaAgentPlan?.enabled);
}

function _mediaAgentAllowsType(scene, mediaType) {
    const agent = scene?._mediaAgentPlan || {};
    if (!agent?.enabled) return false;
    const requestedType = String(mediaType || '').toLowerCase();
    const plannedType = String(agent.mediaType || agent.assetMediaType || agent.searchStrategy?.mediaType || '').toLowerCase();
    if (plannedType && plannedType === requestedType) return true;
    const providerOrder = getMediaAgentProviderOrder(agent, requestedType, scene?.sourceHint || '');
    if (providerOrder.length > 0) return true;
    const agentText = [
        agent.role,
        agent.viewerNeed,
        agent.target,
        agent.minimumAcceptable,
        agent.acceptanceTest,
        agent.assetClass,
        ...(Array.isArray(agent.providerOrder) ? agent.providerOrder : []),
        ...(Array.isArray(agent.providerReality) ? agent.providerReality : []),
        ...(Array.isArray(agent.providerEvidence) ? agent.providerEvidence : []),
        ...(Array.isArray(agent.searchStrategy?.queryLanes) ? agent.searchStrategy.queryLanes.map(lane => `${lane?.provider || ''} ${lane?.query || ''}`) : []),
    ].filter(Boolean).join(' ');
    if (requestedType === 'image') {
        return /\b(bing|web[-\s]?image|image|photo|still|screenshot|reference)\b/i.test(agentText);
    }
    if (requestedType === 'video') {
        return /\b(youtube|reddit|pexels|pixabay|stock|video|footage|clip|b[-\s]?roll|motion)\b/i.test(agentText);
    }
    return false;
}

function _mediaIntentAllowsType(scene, mediaType) {
    if (OPEN_MEDIA_GATES) return true;
    const policy = _mediaIntentPolicy(scene);
    const agentAllowsType = _mediaAgentAllowsType(scene, mediaType);
    if (!agentAllowsType && mediaType === 'video' && _isPlannerExactImageReference(scene)) {
        return false;
    }
    if (!agentAllowsType && mediaType === 'image' && String(scene?.mediaType || '').toLowerCase() === 'video' && _sceneRequiresMotionVideo(scene)) {
        return false;
    }
    if (!agentAllowsType && Array.isArray(policy.allowedMediaTypes) && policy.allowedMediaTypes.length > 0) {
        return policy.allowedMediaTypes.includes(mediaType);
    }
    if (!agentAllowsType && policy.allowTypeFallback === false && policy.mediaType && mediaType !== policy.mediaType) {
        return false;
    }
    return true;
}

function _sceneRequiresMotionVideo(scene) {
    const agent = scene?._mediaAgentPlan || {};
    const hunter = scene?._mediaHunterProfile || {};
    const text = [
        agent.role,
        agent.viewerNeed,
        agent.target,
        agent.acceptanceTest,
        ...(Array.isArray(agent.mustShow) ? agent.mustShow : []),
        ...(Array.isArray(agent.mustAvoid) ? agent.mustAvoid : []),
        hunter.targetDescription,
        ...(Array.isArray(hunter.prefer) ? hunter.prefer : []),
        ...(Array.isArray(hunter.avoid) ? hunter.avoid : []),
        scene?.visualIntent,
        scene?.keyword,
    ].filter(Boolean).join(' ');
    const forbidsStill = /\b(still images?|static images?|screenshots?|photo only|image only)\b/i.test(text)
        && /\b(avoid|reject|instead of video|not|no)\b/i.test(text);
    const needsMotion = /\b(motion|moving|active|actively|action|churning|spinning|splashing|running|operating|working|cycle|forceful|aggressive|violent|tumbling|rotating)\b/i.test(text);
    return forbidsStill || needsMotion;
}

function _mediaIntentAllowedSources(scene, mediaType, opts = {}) {
    if (OPEN_MEDIA_GATES) return null;
    if (_mediaAgentHasAuthority(scene)) {
        return null;
    }
    const policy = _mediaIntentPolicy(scene);
    const controlledStockFallback = mediaType === 'video'
        && opts.allowStockFallback === true
        && policy.allowProviderFallback !== false;
    const typedSources = policy.allowedSourcesByType && Array.isArray(policy.allowedSourcesByType[mediaType])
        ? policy.allowedSourcesByType[mediaType]
        : null;
    let allowed = Array.isArray(typedSources) && typedSources.length > 0
        ? new Set(typedSources)
        : Array.isArray(policy.allowedSources) && policy.allowedSources.length > 0
        ? new Set(policy.allowedSources)
        : null;

    if (controlledStockFallback) {
        allowed = allowed || new Set(['youtube', 'reddit']);
        for (const key of STOCK_VIDEO_PROVIDER_KEYS) allowed.add(key);
    } else if (mediaType === 'video' && policy.allowStockFallback === false) {
        allowed = allowed || new Set(['youtube', 'reddit']);
        for (const key of STOCK_VIDEO_PROVIDER_KEYS) allowed.delete(key);
    }

    if (allowed && mediaType === 'video') {
        for (const key of DISABLED_VIDEO_PROVIDER_KEYS) allowed.delete(key);
    }

    return allowed;
}

function _filterProvidersByMediaIntent(providers, mediaType, scene, opts = {}) {
    if (OPEN_MEDIA_GATES) return providers;
    const allowed = _mediaIntentAllowedSources(scene, mediaType, opts);
    let filtered = allowed
        ? providers.filter(provider => allowed.has(getProviderKey(provider)))
        : providers;

    if (opts.stockOnly && mediaType === 'video') {
        filtered = filtered.filter(provider => STOCK_VIDEO_PROVIDER_KEYS.has(getProviderKey(provider)));
    }
    if (filtered.length !== providers.length) {
        const kept = filtered.map(p => getProviderKey(p) || p.name).join(' -> ') || 'none';
        const label = opts.stockOnly ? 'controlled stock fallback' : `provider lane=${mediaType}`;
        console.log(`  [Media Lock] ${label} allowed=${kept}`);
    }
    return filtered;
}

function _ensureMediaDiagnostics(scene) {
    if (!scene) return null;
    if (!scene.mediaDiagnostics) {
        scene.mediaDiagnostics = { planner: {}, intent: scene.mediaIntent || null, mediaAgent: null, hunter: null, providers: [], final: null };
    }
    if (!Array.isArray(scene.mediaDiagnostics.providers)) scene.mediaDiagnostics.providers = [];
    if (!scene.mediaDiagnostics.intent) scene.mediaDiagnostics.intent = scene.mediaIntent || null;
    return scene.mediaDiagnostics;
}

function _recordMediaProvider(scene, event) {
    const diag = _ensureMediaDiagnostics(scene);
    if (!diag) return;
    const selected = _summarizeMediaCandidate(event.selected);
    const row = {
        provider: event.provider || null,
        key: event.key || null,
        mediaType: event.mediaType || null,
        query: event.query || null,
        status: event.status || 'info',
        reason: event.reason || null,
        resultCount: Number.isFinite(event.resultCount) ? event.resultCount : undefined,
        attempt: Number.isFinite(event.attempt) ? event.attempt : undefined,
        url: event.url || selected?.url || selected?.pageUrl || selected?.streamUrl || null,
        path: event.path || null,
        score: Number.isFinite(Number(event.score)) ? Number(event.score) : undefined,
        postScore: Number.isFinite(Number(event.postScore)) ? Number(event.postScore) : undefined,
        deepScore: Number.isFinite(Number(event.deepScore)) ? Number(event.deepScore) : undefined,
        race: event.race || undefined,
    };
    const candidates = _summarizeMediaCandidates(event.candidates, event.candidateLimit || 24);
    if (candidates.length) row.candidates = candidates;
    if (selected) row.selected = selected;
    diag.providers.push(row);
}

function _summarizeMediaCandidate(result) {
    if (!result) return null;
    const pageUrl = String(result.url || result._cachedMeta?.url || result._meta?.url || '').trim();
    const directUrl = String(result._directVideoUrl || result._fallbackUrl || result._cachedMeta?._fallbackUrl || result._meta?._fallbackUrl || '').trim();
    const url = pageUrl || directUrl;
    const title = _short(
        result.title
        || result._cachedMeta?.title
        || result._meta?.title
        || result.description
        || result.alt
        || result.url
        || result._directVideoUrl
        || '',
        180
    );
    if (!url && !title) return null;
    const duration = Number(result.duration || result._cachedMeta?.duration || result._meta?.duration || 0);
    const topicScout = result._topicScout || null;
    const candidateReason = String(result._scoutRejectReason || '').trim();
    return {
        title,
        url,
        pageUrl: pageUrl || undefined,
        streamUrl: directUrl && directUrl !== pageUrl ? directUrl : undefined,
        duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
        width: Number(result.width || result._cachedMeta?.width || result._meta?.width || 0) || undefined,
        height: Number(result.height || result._cachedMeta?.height || result._meta?.height || 0) || undefined,
        score: Number.isFinite(Number(result.score)) ? Number(result.score) : undefined,
        source: topicScout ? 'topic-scout' : undefined,
        topicQuery: topicScout?.query ? _short(topicScout.query, 100) : undefined,
        reason: candidateReason ? _short(candidateReason, 180) : undefined,
    };
}

function _summarizeMediaCandidates(results, limit = 24) {
    if (!Array.isArray(results) || results.length === 0) return [];
    const seen = new Set();
    const out = [];
    for (const result of results) {
        const item = _summarizeMediaCandidate(result);
        if (!item) continue;
        const identityKeys = _candidateIdentityKeys(result);
        const key = identityKeys[0]
            || normalizeUrlForDedup(item.url || item.pageUrl || item.streamUrl || '')
            || `${item.title}|${item.duration || ''}`;
        if (seen.has(key)) continue;
        for (const identityKey of identityKeys.length ? identityKeys : [key]) seen.add(identityKey);
        out.push(item);
        if (out.length >= limit) break;
    }
    return out;
}

function _buildMediaRepairFailureContext(scene, opts = {}) {
    const diag = scene?.mediaDiagnostics || {};
    const providers = Array.isArray(diag.providers)
        ? diag.providers
            .filter(row => row && row.status !== 'searching')
            .slice(-48)
        : [];
    const rejected = providers.filter(row => /reject|fail|timeout|no usable|no winner/i.test(`${row.status || ''} ${row.reason || ''}`)).length;
    const searched = providers.filter(row => row.query || row.resultCount !== undefined).length;
    return {
        keyword: opts.keyword || '',
        mediaType: opts.mediaType || '',
        sourceHint: opts.sourceHint || '',
        nicheId: opts.nicheId || '',
        summary: `${providers.length} provider event(s), ${searched} search/scout event(s), ${rejected} rejection/failure signal(s)`,
        final: diag.final || null,
        providers,
    };
}

function _planLanePreview(plan, max = 8) {
    const lanes = Array.isArray(plan?.searchStrategy?.queryLanes) ? plan.searchStrategy.queryLanes : [];
    return lanes
        .slice(0, max)
        .map(lane => `${lane.provider || 'any'}:"${_short(lane.query || '', 58)}"`)
        .filter(Boolean)
        .join(' | ');
}

function _setMediaFinal(scene, final) {
    const diag = _ensureMediaDiagnostics(scene);
    if (!diag) return;
    diag.final = { ...(diag.final || {}), ...final };
}

function _short(value, max = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _assertDownloadedFile(finalPath, mediaType = 'video', providerName = 'provider') {
    if (!finalPath || !fs.existsSync(finalPath)) {
        throw new Error(`${providerName} returned missing file: ${finalPath || '(empty path)'}`);
    }
    const stat = fs.statSync(finalPath);
    const minBytes = mediaType === 'image' ? 1000 : 5000;
    if (!stat.isFile() || stat.size < minBytes) {
        try { fs.unlinkSync(finalPath); } catch (_) {}
        throw new Error(`${providerName} returned invalid ${mediaType} file (${stat.size || 0} bytes)`);
    }
    return stat;
}

function _getReusableMediaMemoryAsset(selected = {}) {
    const assetPath = String(selected?._mediaMemory?.assetPath || '').trim();
    if (!assetPath) return '';
    try {
        const stat = fs.existsSync(assetPath) ? fs.statSync(assetPath) : null;
        return stat && stat.isFile() && stat.size > 0 ? assetPath : '';
    } catch (_) {
        return '';
    }
}

function _copyReusableMediaMemoryAsset(selected = {}, outputPath = '', mediaType = 'video') {
    const assetPath = _getReusableMediaMemoryAsset(selected);
    if (!assetPath) return '';
    fs.copyFileSync(assetPath, outputPath);
    _assertDownloadedFile(outputPath, mediaType, 'Media Memory');
    return outputPath;
}

function _sceneLabel(scene) {
    const index = scene?.originalIndex ?? scene?.index;
    return Number.isFinite(index) ? `scene ${index}` : 'scene';
}

function _sceneOmniBaseCap(scene, opts = {}) {
    if (scene?.mediaIntent?.lane === 'videoBackup' || opts.allowOmniReserve) {
        return SCENE_OMNI_FRAME_CAP_BACKUP;
    }
    if (Array.isArray(scene?._topicFootageCandidates) && scene._topicFootageCandidates.length > 0) {
        return SCENE_OMNI_FRAME_CAP_TOPIC_BANK;
    }
    return SCENE_OMNI_FRAME_CAP;
}

function _sceneOmniFrameCap(scene, opts = {}) {
    const base = _sceneOmniBaseCap(scene, opts);
    const grants = Math.max(0, Number(scene?._omniGrantsUsed || 0));
    return base + (grants * SCENE_OMNI_GRANT_FRAMES);
}

function _tryGrantSceneOmni(scene, opts = {}) {
    if (!scene) return false;
    const used = Math.max(0, Number(scene._omniGrantsUsed || 0));
    if (used >= SCENE_OMNI_GRANTS_MAX) return false;
    if (clipAnalyzer.hasOmniBudget && !clipAnalyzer.hasOmniBudget(SCENE_OMNI_GRANT_FRAMES, { allowReserve: opts.allowOmniReserve === true })) {
        return false;
    }
    scene._omniGrantsUsed = used + 1;
    const newCap = _sceneOmniFrameCap(scene, opts);
    console.log(`  [Omni Scene Budget] ${_sceneLabel(scene)} starvation grant +${SCENE_OMNI_GRANT_FRAMES} frames (cap now ${newCap}, grant ${used + 1}/${SCENE_OMNI_GRANTS_MAX})`);
    return true;
}

function _segmentWindowFrameNeed() {
    return Math.max(
        3,
        Math.min(8, Number(config.clipAnalyzer?.segmentWindowFrames || clipAnalyzer.DEFAULTS?.segmentWindowFrames || 8) || 8)
    );
}

function _segmentScanFrameNeed(totalDuration, context = {}, scene = null, opts = {}) {
    let need = clipAnalyzer.getSegmentFrameNeed
        ? clipAnalyzer.getSegmentFrameNeed(totalDuration, context)
        : (context.mediaHunter?.segment?.omniFrames || clipAnalyzer.DEFAULTS?.segmentFrames || 3);

    if (scene && opts.reserveWindowFrames) {
        const cap = _sceneOmniFrameCap(scene, opts);
        const planned = Math.max(0, Number(scene._omniFramesPlanned || 0));
        const remainingForScan = cap - planned - _segmentWindowFrameNeed();
        if (remainingForScan < 3) return 0;
        need = Math.min(need, remainingForScan);
    }

    return Math.max(0, Math.ceil(Number(need) || 0));
}

function _topicScoutResultsForProvider(scene, providerKey, mediaType) {
    if (mediaType !== 'video' || !Array.isArray(scene?._topicFootageCandidates)) return [];
    const seen = new Set();
    return scene._topicFootageCandidates
        .filter(result => result?._topicScout?.providerKey === providerKey && result.url)
        .sort((a, b) => Number(b?._topicScout?.sceneScore || 0) - Number(a?._topicScout?.sceneScore || 0))
        .filter(result => {
            const urlKey = normalizeUrlForDedup(result._directVideoUrl || result._fallbackUrl || result.url || '');
            if (!urlKey || seen.has(urlKey)) return false;
            seen.add(urlKey);
            return !_candidateMemoryRejectReason(result, scene, providerKey, {
                skipAccepted: !PRESCORE_PROVIDERS.has(providerKey),
            });
        })
        .map(result => ({
            ...result,
            _topicScoutInjected: true,
        }));
}

function _logMediaTrace(scene) {
    const diag = scene?.mediaDiagnostics;
    if (!diag) return;

    const planner = diag.planner || {};
    const intent = diag.intent || scene.mediaIntent || {};
    const mediaAgent = diag.mediaAgent || null;
    const hunter = diag.hunter || null;
    const policy = intent.policy || {};
    const providers = (diag.providers || []).filter(e => e.status !== 'searching');
    const tried = providers.length
        ? providers.slice(-8).map(e => {
            const query = e.query ? ` "${_short(e.query, 55)}"` : '';
            const reason = e.reason ? ` (${_short(e.reason, 60)})` : '';
            const url = e.url ? ` → ${_short(e.url, 90)}` : '';
            return `${e.provider || e.key || '?'}:${e.status}${query}${reason}${url}`;
        }).join(' | ')
        : 'none';
    const final = diag.final || {};
    let finalFileInfo = '';
    if (final.path) {
        try {
            const stat = fs.existsSync(final.path) ? fs.statSync(final.path) : null;
            finalFileInfo = stat ? ` [file=yes ${Math.round(stat.size / 1024)}KB]` : ' [file=missing]';
        } catch (_) {
            finalFileInfo = ' [file=unreadable]';
        }
    }
    const finalText = final.status === 'accepted' || final.status === 'cached' || final.status === 'resumed'
        ? `${final.status} via ${final.provider || 'unknown'} -> ${path.basename(final.path || '')}${finalFileInfo}`
        : `${final.status || 'unknown'}${final.reason ? ` (${_short(final.reason, 80)})` : ''}`;

    // ── Clean, readable per-scene MEDIA REPORT (shared by the real build AND retry) ──
    const _idx = scene?.originalIndex ?? scene?.index ?? '?';
    const _mt = planner.mediaType || scene?.mediaType || '-';
    const _icon = (st) => {
        const s = String(st || '').toLowerCase();
        if (/accept|cached|resum|winner/.test(s)) return '✅';
        if (/reject|fail|no usable|no winner|timeout|error|skip|unavailable/.test(s)) return '❌';
        if (/scout|search|found|result|kept/.test(s)) return '🔍';
        return '·';
    };
    const _score = (e) => {
        const v = [e.postScore, e.deepScore, e.score].find(n => Number.isFinite(Number(n)));
        return Number.isFinite(Number(v)) ? ` ${Number(v)}/10` : '';
    };
    const _rep = [];
    const _out = (s) => { console.log(s); _rep.push(s); };
    const L = (s) => _out(`  │ ${s}`);
    _out('');
    _out(`  ┌──── 🎬 MEDIA REPORT · Scene ${_idx} (${_mt}) ────────────────────────`);
    if (mediaAgent?.viewerNeed) L(`need : ${_short(mediaAgent.viewerNeed, 95)}`);
    L(`plan : keyword="${_short(planner.searchKeyword || planner.keyword || '-', 60)}" source=${planner.sourceHint || (mediaAgent?.providerOrder || [])[0] || '-'}`);
    if ((mediaAgent?.providerOrder || []).length) L(`order: ${mediaAgent.providerOrder.slice(0, 6).join(' › ')}`);
    if (providers.length) {
        L(`tried ${providers.length} step(s):`);
        for (const e of providers.slice(-16)) {
            const prov = e.provider || e.key || '?';
            const q = e.query ? ` "${_short(e.query, 46)}"` : '';
            const rs = e.reason ? ` — ${_short(e.reason, 68)}` : '';
            L(`  ${_icon(e.status)} [${prov}] ${e.status}${_score(e)}${q}${rs}`);
            if (e.url) L(`       ${_short(e.url, 108)}`);
            // Show the actual rejected candidate links so a failure is diagnosable at a glance.
            if (Array.isArray(e.candidates) && /reject|fail|no usable|no winner/i.test(`${e.status} ${e.reason || ''}`)) {
                for (const c of e.candidates.slice(0, 3)) {
                    const cu = c.url || c.pageUrl || c.streamUrl || '';
                    if (cu) L(`         ✗ ${_short(cu, 96)}${c.reason ? ` (${_short(c.reason, 48)})` : ''}`);
                }
            }
        }
    } else {
        L('tried: (no provider events recorded)');
    }
    const _win = /accept|cached|resum/.test(String(final.status || '').toLowerCase());
    const _fscore = [final.score, final.visionScore, final.postScore].find(n => Number.isFinite(Number(n)));
    L(`${_win ? '✅ WINNER' : '⚠️ RESULT'}: ${finalText}${Number.isFinite(Number(_fscore)) ? ` (${Number(_fscore)}/10)` : ''}`);
    _out(`  └────────────────────────────────────────────────────────────`);
    // Stash the formatted report on the scene so the retry path can forward it to the
    // in-app Media Log panel (the build runs in a child process and just uses the console).
    try { diag.reportLines = _rep; } catch (_) {}
}

// ============ MEDIA CACHE (CLIP REUSE) ============

/**
 * In-build media cache — maps keywords to downloaded+scored files.
 * Allows later scenes to reuse already-downloaded media without re-downloading
 * or wasting vision API credits. Especially useful for listicle videos where
 * similar keywords appear across different list items.
 *
 * Key: normalized keyword (lowercase, trimmed)
 * Value: { path, ext, provider, mediaType, mediaWidth, mediaHeight, visionScore, keyword, sceneIndices }
 */
const _mediaCache = new Map();
let _lastCacheHitSceneIndex = -999; // prevent back-to-back reuse
let _canvasLibForFallback = undefined;

function _getCanvasLibForFallback() {
    if (_canvasLibForFallback !== undefined) return _canvasLibForFallback;
    try {
        _canvasLibForFallback = require('@napi-rs/canvas');
    } catch (err) {
        _canvasLibForFallback = null;
    }
    return _canvasLibForFallback;
}

function _fallbackText(value, max = 140) {
    const text = String(value || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _hashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function _wrapCanvasText(ctx, text, maxWidth, maxLines = 4) {
    const words = _fallbackText(text, 420).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth || !line) {
            line = test;
            continue;
        }
        lines.push(line);
        line = word;
        if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (words.length > 0 && lines.length === maxLines) {
        const last = lines[lines.length - 1];
        if (words.join(' ').length > lines.join(' ').length) lines[lines.length - 1] = `${last.replace(/\.*$/, '')}...`;
    }
    return lines;
}

function createAgenticGraphicFallback(scene, opts = {}) {
    const filenameBase = opts.filenameBase || `scene-${Number.isFinite(scene?.index) ? scene.index : Date.now()}`;
    const outPath = path.join(config.paths.temp, `${filenameBase}.png`);
    const keyword = _fallbackText(opts.keyword || scene?.searchKeyword || scene?.keyword || scene?.visualIntent || 'documentary context', 120);
    const title = _fallbackText(
        scene?.ideaLowerThird
        || scene?.overlayText
        || scene?.keyword
        || scene?.visualIntent
        || keyword,
        90
    );
    // `reason` is a DIAGNOSTIC ("scene download timed out after 15.2 min"). It
    // belongs in the log and in the scene record, never on the canvas — this
    // card is shipped in the finished video, and engineering text on screen is
    // worse than the blank it replaced. Body falls back to the keyword, so a
    // scene with no text still gets its subject rather than an error message.
    const body = _fallbackText(scene?.text || scene?.visualIntent || keyword, 240);
    const reason = _fallbackText(opts.reason || 'all media providers exhausted', 120);
    const canvasLib = _getCanvasLibForFallback();
    if (!canvasLib?.createCanvas) {
        console.log('  [Agentic Fallback] Canvas renderer unavailable; scene remains missing');
        return null;
    }

    try {
        fs.mkdirSync(config.paths.temp, { recursive: true });
        cleanupSceneTempMedia(filenameBase);
        const canvas = canvasLib.createCanvas(1920, 1080);
        const ctx = canvas.getContext('2d');
        const seed = _hashText(`${keyword}|${body}|${scene?.startTime || 0}`);
        const hue = seed % 360;
        const accent = `hsl(${hue}, 78%, 56%)`;
        const accent2 = `hsl(${(hue + 38) % 360}, 82%, 48%)`;
        const dark = `hsl(${(hue + 210) % 360}, 30%, 12%)`;
        const mid = `hsl(${(hue + 210) % 360}, 24%, 20%)`;

        const bg = ctx.createLinearGradient(0, 0, 1920, 1080);
        bg.addColorStop(0, '#101014');
        bg.addColorStop(0.55, dark);
        bg.addColorStop(1, '#07080b');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, 1920, 1080);

        ctx.globalAlpha = 0.16;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(1580, 170, 420, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = accent2;
        ctx.beginPath();
        ctx.arc(250, 900, 360, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        for (let i = 0; i < 9; i++) {
            const x = 170 + ((seed >>> (i % 16)) % 1180) + i * 21;
            const y = 155 + ((seed >>> ((i + 5) % 16)) % 680);
            ctx.globalAlpha = 0.07 + (i % 3) * 0.025;
            ctx.fillStyle = i % 2 ? '#ffffff' : accent;
            ctx.fillRect(x % 1700, y % 880, 260 + (i % 4) * 62, 10);
        }
        ctx.globalAlpha = 1;

        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(150, 170, 1620, 740);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 2;
        ctx.strokeRect(150, 170, 1620, 740);

        ctx.fillStyle = accent;
        ctx.fillRect(190, 220, 12, 640);

        // There used to be a fixed eyebrow reading "DOCUMENTARY CONTEXT" above
        // the title. It said nothing about the scene, appeared on every card in
        // every video, and was the single clearest tell that the viewer was
        // looking at generated filler rather than a shot. The title below is
        // already the scene's subject, so the label was pure noise — dropped,
        // and the title starts where it used to sit.
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 82px Arial, sans-serif';
        const titleLines = _wrapCanvasText(ctx, title, 1110, 3);
        let y = 330;
        for (const line of titleLines) {
            ctx.fillText(line, 235, y);
            y += 92;
        }

        ctx.fillStyle = 'rgba(255,255,255,0.76)';
        ctx.font = '400 38px Arial, sans-serif';
        const bodyLines = _wrapCanvasText(ctx, body, 1160, 3);
        y += 28;
        for (const line of bodyLines) {
            ctx.fillText(line, 235, y);
            y += 52;
        }

        // Deliberately NOT including `reason` — see the note where it is built.
        //
        // Two chips used to be painted unconditionally, and in practice both were
        // noise. The first was the keyword, which is usually the same string as
        // the title directly above it — the card said "inflation" twice. The
        // second fell back to `sourceHint` ("stock") or the literal "contextual
        // visual": an internal lane name and a fixed label, neither of which
        // means anything to a viewer. That is the same defect as the eyebrow
        // removed above, so it gets the same treatment: a chip has to carry
        // something the title does not already say, or it is not drawn. If
        // nothing qualifies, the card shows no chips at all.
        const titleKey = String(title || '').trim().toLowerCase();
        const chips = [];
        for (const raw of [keyword, scene?._mediaAgentPlan?.viewerNeed]) {
            const label = _fallbackText(raw, 44);
            if (!label) continue;
            const key = label.trim().toLowerCase();
            if (!key || key === titleKey) continue;
            if (chips.some(c => c.trim().toLowerCase() === key)) continue;
            chips.push(label);
        }
        ctx.font = '600 28px Arial, sans-serif';
        let chipX = 235;
        const chipY = 805;
        for (const chip of chips.slice(0, 3)) {
            const label = _fallbackText(chip, 42);
            const w = Math.min(560, Math.max(170, ctx.measureText(label).width + 48));
            ctx.fillStyle = mid;
            ctx.fillRect(chipX, chipY, w, 56);
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.strokeRect(chipX, chipY, w, 56);
            ctx.fillStyle = chipX === 235 ? accent : 'rgba(255,255,255,0.82)';
            ctx.fillText(label, chipX + 24, chipY + 37);
            chipX += w + 18;
            if (chipX > 1500) break;
        }

        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(1500, 280, 180, 14);
        ctx.fillRect(1500, 330, 110, 14);
        ctx.fillRect(1500, 380, 230, 14);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(1470, 620);
        ctx.lineTo(1620, 490);
        ctx.lineTo(1730, 590);
        ctx.stroke();

        fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
        const stat = fs.statSync(outPath);
        if (!stat.isFile() || stat.size < 1000) throw new Error('generated fallback image was empty');
        return {
            path: outPath,
            ext: '.png',
            provider: 'Agentic Visual Fallback',
            mediaType: 'image',
            mediaWidth: 1920,
            mediaHeight: 1080,
            visionScore: 0,
            noCache: true,
            agenticFallback: true,
            reason,
        };
    } catch (err) {
        console.log(`  [Agentic Fallback] failed to create scene plate: ${err.message}`);
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
        return null;
    }
}

/**
 * Add a successfully downloaded media file to the cache.
 */
function _cacheMedia(keyword, result, visionScore, sceneIndex) {
    const key = keyword.toLowerCase().trim();
    _mediaCache.set(key, {
        ...result,
        visionScore: visionScore || 0,
        keyword,
        sceneIndices: [sceneIndex],
    });
}

/**
 * Try to find a cached media file for the given keyword.
 * Checks exact match first, then looks for partial/similar matches.
 * Returns null if no suitable cache hit, or the cached result + copy path.
 *
 * @param {string} keyword
 * @param {string} mediaType
 * @param {number} sceneIndex - current scene index (to prevent consecutive reuse)
 * @param {string} filenameBase - e.g. 'scene-5'
 * @returns {Object|null} { path, ext, provider, mediaType, mediaWidth, mediaHeight, fromCache: true }
 */
function _checkMediaCache(keyword, mediaType, sceneIndex, filenameBase) {
    if (_mediaCache.size === 0) return null;

    // Prevent back-to-back reuse (consecutive scenes shouldn't show same clip)
    if (Math.abs(sceneIndex - _lastCacheHitSceneIndex) <= 1) return null;

    const keyLower = keyword.toLowerCase().trim();
    const keyWords = keyLower.split(/\s+/).filter(w => w.length > 2);

    let bestMatch = null;
    let bestScore = 0;

    for (const [cachedKey, cached] of _mediaCache) {
        // Must match media type
        if (cached.mediaType !== mediaType) continue;

        // Must still exist on disk and be readable media.
        try {
            _assertDownloadedFile(cached.path, cached.mediaType || mediaType, cached.provider || 'cache');
        } catch (_) {
            continue;
        }

        // Don't reuse in the immediately previous or next scene
        if (cached.sceneIndices.some(si => Math.abs(si - sceneIndex) <= 1)) continue;

        // Exact keyword match = best
        if (cachedKey === keyLower) {
            bestMatch = cached;
            bestScore = 100;
            break;
        }

        // Partial match: check word overlap (Jaccard-like)
        const cachedWords = cachedKey.split(/\s+/).filter(w => w.length > 2);
        if (cachedWords.length === 0 || keyWords.length === 0) continue;

        const intersection = keyWords.filter(w => cachedWords.includes(w)).length;
        const union = new Set([...keyWords, ...cachedWords]).size;
        const similarity = intersection / union;

        // Images are visually static, so loose reuse is much more obvious than
        // clip reuse. Keep image cache hits near-exact to avoid repeated PNGs
        // across different scenes that share broad topic words.
        const minSimilarity = mediaType === 'image' ? 0.75 : 0.6;
        if (similarity >= minSimilarity && similarity > bestScore) {
            bestMatch = cached;
            bestScore = similarity;
        }
    }

    if (!bestMatch) return null;

    // Copy the cached file to the new scene's filename
    try {
        const ext = bestMatch.ext;
        const destPath = path.join(config.paths.temp, filenameBase + ext);

        // If source and dest are same, just return
        if (destPath === bestMatch.path) return null;

        fs.copyFileSync(bestMatch.path, destPath);
        bestMatch.sceneIndices.push(sceneIndex);
        _lastCacheHitSceneIndex = sceneIndex;

        return {
            path: destPath,
            ext: ext,
            provider: bestMatch.provider + ' (cached)',
            mediaType: bestMatch.mediaType,
            mediaWidth: bestMatch.mediaWidth,
            mediaHeight: bestMatch.mediaHeight,
            fromCache: true,
        };
    } catch {
        return null;
    }
}

const CONCRETE_VIDEO_TOPIC_RE = /\b(ship|ships|shipping|vessel|vessels|tanker|tankers|cargo|container|containers|convoy|port|canal|strait|chokepoint|choke point|sea|gulf|route|corridor|traffic|factory|assembly|workers?|officials?|briefing|control room|aerial|drone|footage|documentary)\b/i;
const IMAGE_FIRST_TOPIC_RE = /\b(map|chart|graph|diagram|infographic|satellite|locator|portrait|photo|image|thumbnail|logo|document|article)\b/i;

function _shouldUpgradeImageToVideo(scene, scriptContext = {}) {
    if (!scene || scene.mediaType !== 'image') return false;
    if (scene.fullscreenMG) return false;
    if (scene.sourceHint === 'web-image') return false;
    if (scene.templateHint && !scene._templateBackupFootage) return false;

    const nicheId = String(scriptContext?.nicheId || '').toLowerCase();
    const factualNiche = /^(news|explainer\.(politics|military|economy|business|history|crime))/.test(nicheId);
    if (!factualNiche) return false;

    const text = [
        scene.keyword,
        scene.stockQuery,
        scene.webQuery,
        scene.visualIntent,
        scene.text,
    ].filter(Boolean).join(' ');

    if (!CONCRETE_VIDEO_TOPIC_RE.test(text)) return false;
    if (IMAGE_FIRST_TOPIC_RE.test(String(scene.keyword || '')) && !/\bship|shipping|vessel|tanker|container|traffic|factory|officials?\b/i.test(text)) {
        return false;
    }
    return true;
}

/**
 * Clear the media cache (call at start of each build).
 */
function _clearMediaCache() {
    _mediaCache.clear();
    _lastCacheHitSceneIndex = -999;
    _urlBlacklist.clear();
    _urlUseCount.clear();
    _acceptedMediaHashes.clear();
    _acceptedDescriptions.clear();
    _acceptedUrls.clear();
    _previewScoutSegmentCache.clear();
    _previewScoutRejectedUrls.clear();
    _structuralRejectedUrls.clear();
    _sceneRejectedUrls.clear();
    _providerSearchCache.clear();
    _deadUrlCacheLoaded = false;
    _loadPersistentDeadUrls();
}

// ============ URL BLACKLIST ============
// Remembers URLs that scored poorly so we don't re-download and re-score them
// across different scenes. Key: URL string, Value: { score, description }
const _urlBlacklist = new Map();

function _blacklistUrl(url, score, description) {
    if (!url) return;
    // Use normalized key: preserves YouTube ?v=ID, strips HLS/tracking params
    const key = normalizeUrlForDedup(url);
    if (!key) return;
    _urlBlacklist.set(key, { score, description });
}

function _isBlacklisted(url) {
    if (!url) return null;
    const key = normalizeUrlForDedup(url);
    if (!key) return null;
    return _urlBlacklist.get(key) || null;
}

// ============ URL REUSE LIMITER ============
// Tracks how many scenes used each base URL. Doesn't block — signals to try others first.
const MAX_URL_REUSE = 2; // after this many uses, URL is "overused" (deprioritized, not blocked)
const _urlUseCount = new Map(); // key (base URL) → number of scenes it was used in
const _acceptedMediaHashes = new Map(); // sha256 → { sceneIndex, provider, file }

function _trackUrlUse(url) {
    if (!url) return;
    const key = normalizeUrlForDedup(url);
    if (!key) return;
    _urlUseCount.set(key, (_urlUseCount.get(key) || 0) + 1);
}

function _getUrlUseCount(url) {
    if (!url) return 0;
    const key = normalizeUrlForDedup(url);
    if (!key) return 0;
    return _urlUseCount.get(key) || 0;
}

function _hashMediaFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    // Hash normal scene assets, but avoid blocking the event loop on huge files.
    if (!stat.isFile() || stat.size <= 0 || stat.size > 500 * 1024 * 1024) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function _checkAcceptedMediaDuplicate(filePath) {
    const hash = _hashMediaFile(filePath);
    if (!hash) return { hash: null, duplicate: null };
    return { hash, duplicate: _acceptedMediaHashes.get(hash) || null };
}

// CLIP visual/tag embedding for one scene (OPENMONTAGE-BORROW-PLAN #20). Caches
// on the scene; returns null (and degrades) if the optional CLIP dep is absent.
async function _computeSceneVisualVec(scene) {
    try {
        if (!scene || !scene.mediaFile || !fs.existsSync(scene.mediaFile)) return null;
        const clipEmbedder = require('./clip-embedder');
        const isVid = /\.(mp4|webm|mov|mkv|m4v)$/i.test(scene.mediaFile);
        let frames = [];
        if (isVid) {
            const dur = Math.max(1, (Number(scene.endTime) || 0) - (Number(scene.startTime) || 0) || 3);
            const out = await clipAnalyzer.extractFrames(scene.mediaFile, dur, 3, { scale: 224 });
            frames = (out || []).map((f) => f && f.base64).filter(Boolean);
        } else {
            frames = [fs.readFileSync(scene.mediaFile).toString('base64')];
        }
        scene._clipVisualVec = await clipEmbedder.embedImageBase64List(frames);
        scene._clipTagVec = await clipEmbedder.embedText(scene.searchKeyword || scene.keyword || '');
        return scene._clipVisualVec;
    } catch (_) { return null; }
}

function _rememberAcceptedMediaHash(hash, sceneIndex, provider, filePath) {
    if (!hash) return;
    _acceptedMediaHashes.set(hash, {
        sceneIndex,
        provider,
        file: filePath ? path.basename(filePath) : '',
    });
}

// ============ SEMANTIC DUPLICATE DETECTION ============
// Byte-hash dedup misses visually-similar clips encoded differently (e.g. two
// different reddit reposts of cargo-ship-bow-in-rough-seas POV footage). Compare
// Omni clip descriptions via word-overlap ratio so near-identical content gets
// rejected even when bytes differ.
const _acceptedDescriptions = new Map(); // sceneIndex → { description, provider }
const _acceptedUrls = new Set(); // base URLs (no query) of clips already kept this build
const _previewScoutSegmentCache = new Map(); // URL+keyword+duration -> accepted/rejected preview scout decision
const _previewScoutRejectedUrls = new Map(); // canonical URL -> { reason } — structural rejections that apply across all scenes/keywords this build
const _structuralRejectedUrls = new Map(); // canonical URL -> { reason, providerKey, at, permanent, strikes }
const _sceneRejectedUrls = new Map(); // sceneKey -> Map(canonical URL -> reason)
const _providerSearchCache = new Map(); // provider|mediaType|query -> { at, results }
let _deadUrlCacheLoaded = false;
const TIMEOUT_STRIKE_LIMIT = Math.max(1, parseInt(process.env.DEAD_MEDIA_URL_STRIKES || '2', 10) || 2);
// Timestamp marking start of this process — used to distinguish in-build
// rejections (always block) from cross-build struck entries (only block when
// promoted to permanent). Captured at module load.
const _PROCESS_STARTED_AT = Date.now();
// Semantic descriptions are useful for surfacing visual repetition, but they
// are too fuzzy to hard-reject good clips. Exact URL/file-hash dedup remains
// the hard blocker by default. Set SEMANTIC_DUPE_MODE=reject to restore hard
// semantic rejection when visual variety is more important than completion.
const SEMANTIC_DUPE_THRESHOLD = Math.max(0.5, Math.min(0.98, Number(process.env.SEMANTIC_DUPE_THRESHOLD || 0.7) || 0.7));
const SEMANTIC_DUPE_MODE = String(process.env.SEMANTIC_DUPE_MODE || 'warn').toLowerCase();
const _SEMANTIC_STOPWORDS = new Set([
    'this', 'that', 'with', 'from', 'into', 'over', 'have', 'their', 'they',
    'them', 'there', 'where', 'when', 'what', 'which', 'while', 'shot', 'clip',
    'video', 'scene', 'footage', 'shows', 'showing', 'show', 'view', 'angle',
    'point', 'pointofview', 'features', 'depicts', 'visible', 'frame', 'seen',
]);

function _deadUrlCachePath() {
    return path.join(config.paths?.temp || process.cwd(), 'dead-media-urls.json');
}

function _loadPersistentDeadUrls() {
    if (_deadUrlCacheLoaded) return;
    _deadUrlCacheLoaded = true;
    try {
        const file = _deadUrlCachePath();
        if (!fs.existsSync(file)) return;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const items = Array.isArray(parsed) ? parsed : (parsed.items || []);
        const now = Date.now();
        for (const item of items) {
            const key = String(item?.url || '').trim();
            const at = Number(item?.at || 0);
            if (!key || (at && now - at > DEAD_URL_CACHE_TTL_MS)) continue;
            const strikes = Math.max(0, parseInt(item.strikes || 0, 10) || 0);
            const permanent = item.permanent === true || strikes >= TIMEOUT_STRIKE_LIMIT;
            _structuralRejectedUrls.set(key, {
                reason: item.reason || 'previous permanent media failure',
                providerKey: item.providerKey || '',
                at: at || now,
                permanent,
                strikes,
            });
        }
    } catch (_) {}
}

function _savePersistentDeadUrls() {
    try {
        const now = Date.now();
        const items = [];
        for (const [url, info] of _structuralRejectedUrls.entries()) {
            if (!info) continue;
            const strikes = Math.max(0, parseInt(info.strikes || 0, 10) || 0);
            if (!info.permanent && strikes < 1) continue;
            const at = Number(info.at || now);
            if (now - at > DEAD_URL_CACHE_TTL_MS) continue;
            items.push({
                url,
                reason: info.reason || 'permanent media failure',
                providerKey: info.providerKey || '',
                at,
                permanent: info.permanent === true,
                strikes,
            });
        }
        fs.mkdirSync(config.paths?.temp || process.cwd(), { recursive: true });
        fs.writeFileSync(_deadUrlCachePath(), JSON.stringify({ items }, null, 2));
    } catch (_) {}
}

function _candidateUrlValues(result) {
    return [
        result?._directVideoUrl,
        result?._fallbackUrl,
        result?._cachedMeta?._fallbackUrl,
        result?._cachedMeta?.url,
        result?._cachedMeta?._sourcePage,
        result?._meta?._fallbackUrl,
        result?._meta?.url,
        result?._meta?._sourcePage,
        result?._sourcePage,
        result?.url,
    ].filter(Boolean).map(value => String(value).trim()).filter(Boolean);
}

function _candidateUrlKeys(result) {
    const seen = new Set();
    const keys = [];
    for (const url of _candidateUrlValues(result)) {
        const key = normalizeUrlForDedup(url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }
    return keys;
}

function _storyblocksIdentityKeysFromValue(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    const keys = [];
    const stockId = raw.match(/\bSBV[-_\s]?(\d{4,})\b/i);
    if (stockId) keys.push(`storyblocks:id:${stockId[1]}`);
    try {
        const parsed = new URL(raw);
        if (/storyblocks\.com$/i.test(parsed.hostname) || /(^|\.)storyblocks\.com$/i.test(parsed.hostname)) {
            const pathName = decodeURIComponent(parsed.pathname || '');
            const pathId = pathName.match(/\/(?:all-video|video)(?:\/stock)?\/[^/?#]*?-(\d{4,})(?:\/|$)/i);
            if (pathId) keys.push(`storyblocks:id:${pathId[1]}`);
            const slug = pathName.match(/\/(?:all-video|video)(?:\/stock)?\/([^/?#]+?-\d{4,})(?:\/|$)/i);
            if (slug) keys.push(`storyblocks:slug:${slug[1].toLowerCase()}`);
        }
    } catch (_) {
        const pathId = raw.match(/\/(?:all-video|video)(?:\/stock)?\/[^/?#]*?-(\d{4,})(?:\/|$|\?)/i);
        if (pathId) keys.push(`storyblocks:id:${pathId[1]}`);
    }
    return [...new Set(keys)];
}

function _candidateIdentityKeys(result, opts = {}) {
    const keys = [];
    const add = (key) => {
        const value = String(key || '').trim();
        if (value && !keys.includes(value)) keys.push(value);
    };
    for (const key of _candidateUrlKeys(result)) add(`url:${key}`);

    const providerKey = String(opts.providerKey || result?._provider || result?._topicScout?.providerKey || '').toLowerCase();
    if (providerKey === 'storyblocks' || /storyblocks/i.test(String(result?._provider || result?.provider || ''))) {
        const values = [
            result?.id,
            result?.stockId,
            result?._cachedMeta?.id,
            result?._cachedMeta?.stockId,
            result?._meta?.id,
            result?._meta?.stockId,
            ..._candidateUrlValues(result),
        ];
        for (const value of values) {
            for (const key of _storyblocksIdentityKeysFromValue(value)) add(key);
        }
    }

    return keys;
}

function _sceneRejectKey(scene) {
    return String(scene?.originalIndex ?? scene?.index ?? scene?.id ?? 'unknown');
}

function _rememberSceneRejectedResult(scene, result, reason) {
    const sceneKey = _sceneRejectKey(scene);
    if (!sceneKey) return;
    let rejected = _sceneRejectedUrls.get(sceneKey);
    if (!rejected) {
        rejected = new Map();
        _sceneRejectedUrls.set(sceneKey, rejected);
    }
    for (const key of _candidateUrlKeys(result)) {
        rejected.set(key, reason || 'rejected for this scene');
    }
}

function _rememberStructuralRejectedResult(result, reason, opts = {}) {
    const keys = _candidateUrlKeys(result);
    if (!keys.length) return;
    const now = Date.now();
    const strikeMode = opts.strike === true;
    let promotedToPermanent = opts.permanent === true;
    for (const key of keys) {
        const existing = _structuralRejectedUrls.get(key);
        let strikes = Math.max(0, parseInt(existing?.strikes || 0, 10) || 0);
        let permanent = existing?.permanent === true || opts.permanent === true;
        if (strikeMode && !permanent) {
            strikes += 1;
            if (strikes >= TIMEOUT_STRIKE_LIMIT) {
                permanent = true;
                promotedToPermanent = true;
            }
        }
        _structuralRejectedUrls.set(key, {
            reason: reason || existing?.reason || 'structural media failure',
            providerKey: opts.providerKey || existing?.providerKey || '',
            at: now,
            permanent,
            strikes,
        });
    }
    if (promotedToPermanent || strikeMode) _savePersistentDeadUrls();
}

function _isTimeoutMediaFailure(errorOrMessage) {
    const text = String(errorOrMessage?.message || errorOrMessage || '').toLowerCase();
    return [
        'aborted',
        'etimedout',
        'esockettimedout',
        'econnreset',
        'econnaborted',
        'aborterror',
        'network timeout',
        'request timeout',
        'socket hang up',
        'yt-dlp aborted',
        'yt-dlp timeout',
        'yt-dlp timed out',
        'killed by timeout',
        'operation was aborted',
    ].some(pattern => text.includes(pattern));
}

function _isPermanentMediaFailure(errorOrMessage) {
    const text = String(errorOrMessage?.message || errorOrMessage || '').toLowerCase();
    return [
        'video unavailable',
        'this video is unavailable',
        'private video',
        'has been removed',
        'removed for violating',
        'does not exist',
        'video not found',
        'http error 404',
        'status code 404',
        'http 410',
        'status code 410',
        'unsupported url',
        'sign in to confirm your age',
        'age-restricted',
        'members-only',
        'copyright',
        'blocked in your country',
        'premiere has not begun',
        'no video formats found',
        // 'requested format is not available' deliberately OMITTED here:
        // the Preview Scout probe and Smart Trim use narrow "worst progressive"
        // format selectors that often don't match modern DASH-only YouTube
        // responses, but the actual download path uses broader selectors
        // (bestvideo+bestaudio/best) and can still succeed. yt-dlp's internal
        // retry classifier still treats it as permanent (no retry), but the
        // candidate must not be marked structurally dead at the media layer.
        'unable to extract uploader id',
    ].some(pattern => text.includes(pattern));
}

function _candidateMemoryRejectReason(result, scene, providerKey, opts = {}) {
    _loadPersistentDeadUrls();
    const keys = _candidateUrlKeys(result);
    if (!keys.length) return '';
    const storyblocksMapPassthrough = String(providerKey || '').toLowerCase() === 'storyblocks'
        && opts.allowStoryblocksMapPassthrough !== false
        && _isCandidateTopicAccurateMap(result, scene, scene?._mediaHunterProfile || {}, {
            providerKey,
            providerName: opts.providerName || 'Storyblocks',
            query: opts.query || '',
        });

    for (const key of keys) {
        const dead = _structuralRejectedUrls.get(key);
        if (dead) {
            const isFromThisBuild = (dead.at || 0) >= _PROCESS_STARTED_AT;
            if (storyblocksMapPassthrough && dead.permanent !== true) {
                continue;
            }
            if (dead.permanent === true || isFromThisBuild) {
                return `known-dead URL: ${dead.reason || 'structural media failure'}`;
            }
            // Cross-build struck entry below promotion threshold — let it through
            // so this build can confirm or clear it.
        }
        const previewReject = _previewScoutRejectedUrls.get(key);
        if (!storyblocksMapPassthrough && previewReject) return `preview-rejected URL: ${previewReject.reason || 'preview scout rejected'}`;
    }

    if (!storyblocksMapPassthrough) {
        const rejected = _sceneRejectedUrls.get(_sceneRejectKey(scene));
        if (rejected) {
            for (const key of keys) {
                const reason = rejected.get(key);
                if (reason) return `already rejected for this scene: ${reason}`;
            }
        }
    }

    if (!storyblocksMapPassthrough && opts.skipAccepted !== false) {
        for (const key of keys) {
            if (_acceptedUrls.has(key)) return 'already accepted by earlier scene';
        }
    }

    return '';
}

function _filterKnownBadResults(results, scene, providerName, providerKey, opts = {}) {
    if (!Array.isArray(results) || results.length === 0) return results || [];
    const kept = [];
    const counts = new Map();
    for (const result of results) {
        const reason = _candidateMemoryRejectReason(result, scene, providerKey, opts);
        if (reason) {
            const label = reason.split(':')[0];
            counts.set(label, (counts.get(label) || 0) + 1);
            continue;
        }
        kept.push(result);
    }
    if (counts.size > 0) {
        const summary = Array.from(counts.entries()).map(([reason, count]) => `${count} ${reason}`).join(', ');
        console.log(`  Candidate memory: [${providerName || providerKey}] skipped ${summary}`);
    }
    return kept;
}

function _mergeSearchResults(primary = [], secondary = []) {
    const out = [];
    const seen = new Set();
    for (const result of [...(primary || []), ...(secondary || [])]) {
        if (!result) continue;
        const keys = _candidateIdentityKeys(result);
        const key = keys[0]
            || `${String(result.title || result._cachedMeta?.title || '').toLowerCase()}|${String(result.url || result._sourcePage || '').toLowerCase()}`;
        const identityKeys = keys.length ? keys : (key ? [key] : []);
        const duplicate = identityKeys.some(identityKey => seen.has(identityKey));
        if (duplicate) continue;
        if (key) {
            for (const identityKey of identityKeys) seen.add(identityKey);
        }
        out.push(result);
    }
    return out;
}

const SEARCH_CACHE_ENABLED = process.env.MEDIA_SEARCH_CACHE !== '0';
const SEARCH_CACHE_TTL_MS = Math.max(30_000, parseInt(process.env.MEDIA_SEARCH_CACHE_TTL_MS || '1800000', 10) || 1_800_000);
const SEARCH_CACHE_MAX_ENTRIES = Math.max(20, Math.min(500, parseInt(process.env.MEDIA_SEARCH_CACHE_MAX || '160', 10) || 160));

function _searchCacheKey(providerKey, mediaType, query, opts = {}) {
    const q = _queryKey(query);
    if (!providerKey || !q) return '';
    const scope = opts.scope ? String(opts.scope).toLowerCase() : '';
    return `${String(providerKey).toLowerCase()}|${String(mediaType || '').toLowerCase()}|${scope}|${q}`;
}

function _cloneSearchResults(results = []) {
    return (Array.isArray(results) ? results : []).map(result => {
        if (!result || typeof result !== 'object') return result;
        return {
            ...result,
            _cachedMeta: result._cachedMeta && typeof result._cachedMeta === 'object' ? { ...result._cachedMeta } : result._cachedMeta,
            _meta: result._meta && typeof result._meta === 'object' ? { ...result._meta } : result._meta,
            _topicScout: result._topicScout && typeof result._topicScout === 'object' ? { ...result._topicScout } : result._topicScout,
        };
    });
}

function _getProviderSearchCache(providerKey, mediaType, query, opts = {}) {
    if (!SEARCH_CACHE_ENABLED) return null;
    const key = _searchCacheKey(providerKey, mediaType, query, opts);
    if (!key) return null;
    const hit = _providerSearchCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
        _providerSearchCache.delete(key);
        return null;
    }
    return _cloneSearchResults(hit.results);
}

function _setProviderSearchCache(providerKey, mediaType, query, results, opts = {}) {
    if (!SEARCH_CACHE_ENABLED || !Array.isArray(results)) return;
    if (results.length === 0) return;
    const key = _searchCacheKey(providerKey, mediaType, query, opts);
    if (!key) return;
    _providerSearchCache.set(key, { at: Date.now(), results: _cloneSearchResults(results) });
    while (_providerSearchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
        const oldest = _providerSearchCache.keys().next().value;
        if (!oldest) break;
        _providerSearchCache.delete(oldest);
    }
}

function _dedupeRaceCandidates(candidates = [], opts = {}) {
    const out = [];
    const seen = new Set();
    let duplicates = 0;
    const duplicateSamples = [];
    for (const candidate of candidates || []) {
        const keys = _candidateIdentityKeys(candidate, opts);
        const duplicate = keys.some(key => seen.has(key));
        if (duplicate) {
            duplicates++;
            if (duplicateSamples.length < 5) duplicateSamples.push(candidate);
            continue;
        }
        for (const key of keys) seen.add(key);
        out.push(candidate);
    }
    return { results: out, duplicates, duplicateSamples };
}

function _trimRacePoolByFinalistPriority(candidates = [], opts = {}) {
    const pool = Array.isArray(candidates) ? candidates : [];
    const minPriority = Math.max(1, Math.min(8, Number(opts.minPriority || process.env.MEDIA_RACE_FINALIST_MIN_PRIORITY || 5)));
    const minKeep = Math.max(1, Math.min(pool.length || 1, Number(opts.minKeep || 2)));
    const scored = pool.filter(c => Number.isFinite(Number(c?._candidateFinalistScore)));
    if (scored.length < Math.max(3, Math.ceil(pool.length * 0.5))) {
        return { results: pool, skipped: [] };
    }
    const strongEnough = pool.filter(c => Number(c?._candidateFinalistScore) >= minPriority);
    if (strongEnough.length < minKeep) return { results: pool, skipped: [] };
    const kept = [];
    const skipped = [];
    for (const candidate of pool) {
        const score = Number(candidate?._candidateFinalistScore);
        if (Number.isFinite(score) && score < minPriority) {
            skipped.push(candidate);
        } else {
            kept.push(candidate);
        }
    }
    if (kept.length < minKeep) return { results: pool, skipped: [] };
    return { results: kept, skipped };
}

function _raceNumeric(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function _hasSceneLocalMandatoryNeed(mediaAgentPlan, visualContract) {
    return [
        mediaAgentPlan?.mandatoryIdentity,
        mediaAgentPlan?.mandatoryVisible,
        visualContract?.mandatoryIdentity,
        visualContract?.mandatoryVisible,
        visualContract?.mustShow,
    ].some(values => Array.isArray(values) && values.length > 0);
}

function _maxCandidateSignal(candidates = []) {
    let finalist = 0;
    let mediaScout = 0;
    let thumbnail = 0;
    for (const candidate of candidates || []) {
        finalist = Math.max(finalist, _raceNumeric(candidate?._candidateFinalistScore, 0));
        mediaScout = Math.max(mediaScout, _raceNumeric(candidate?._mediaScoutScore, 0));
        if (candidate?._thumbnailVisionPassed === true) thumbnail++;
    }
    return { finalist, mediaScout, thumbnail };
}

function _adaptiveSearchLaneLimit(opts = {}) {
    const mediaType = opts.mediaType || 'video';
    const lockStrength = String(opts.lockStrength || 'open').toLowerCase();
    const isProviderLocked = !!opts.isProviderLocked;
    const strictRaw = !!(opts.strictRaw || opts.hunterProfile?.strictRaw || opts.visualContract?.strictRaw);
    const mandatoryNeed = _hasSceneLocalMandatoryNeed(opts.mediaAgentPlan, opts.visualContract);
    const base = mediaType === 'image' ? 2 : (strictRaw ? 3 : 2);
    if (lockStrength === 'hard' || lockStrength === 'reference' || mandatoryNeed) return Math.max(base, 4);
    if (isProviderLocked || strictRaw) return Math.max(base, 3);
    return base;
}

function _isSelfHostedQwenVisionEndpoint() {
    const baseUrl = String(config.qwen?.baseUrl || process.env.QWEN_BASE_URL || '').trim();
    return !!baseUrl && !/dashscope/i.test(baseUrl);
}

function _imageRaceConcurrencyCap() {
    const raw = parseInt(process.env.IMAGE_RACE_CONCURRENCY_CAP || process.env.QWEN_IMAGE_RACE_CONCURRENCY_CAP || '', 10);
    if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.min(6, raw));
    return _isSelfHostedQwenVisionEndpoint() ? 3 : 4;
}

function _adaptiveRacePlan(opts = {}) {
    const mediaType = opts.mediaType || 'video';
    const providerKey = String(opts.providerKey || '').toLowerCase();
    const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
    const lockStrength = String(opts.lockStrength || 'open').toLowerCase();
    const hardLocked = !!opts.hardLocked;
    const softLocked = !!opts.softLocked;
    const locked = hardLocked || softLocked;
    const mandatoryNeed = _hasSceneLocalMandatoryNeed(opts.mediaAgentPlan, opts.visualContract);
    const strictRaw = !!(opts.hunterProfile?.strictRaw || opts.visualContract?.strictRaw);
    const templateBg = opts.mediaAgentPlan?.role === 'template-background' || opts.hunterProfile?.templateBackground === true;
    const signal = _maxCandidateSignal(candidates);
    const strongPreEvidence = signal.finalist >= 8 || signal.mediaScout >= 10 || signal.thumbnail >= 2;
    const baseConcurrency = Math.max(1, Number(opts.baseConcurrency || getProviderConcurrency(providerKey)));
    const providerConcurrencyCap = mediaType === 'image'
        ? _imageRaceConcurrencyCap()
        : providerKey === 'youtube'
            ? 4
            : providerKey === 'reddit'
                ? 4
                : 6;
    const canBoostConcurrency = providerKey !== 'storyblocks';
    const concurrency = canBoostConcurrency && (hardLocked || mandatoryNeed || strictRaw)
        ? Math.min(providerConcurrencyCap, baseConcurrency + 2)
        : canBoostConcurrency && softLocked
            ? Math.min(providerConcurrencyCap, baseConcurrency + 1)
            : baseConcurrency;

    let difficulty = 'normal';
    if (hardLocked || mandatoryNeed || strictRaw) difficulty = 'hard';
    else if (softLocked || templateBg || providerKey === 'storyblocks') difficulty = 'focused';
    if (strongPreEvidence && !mandatoryNeed && !hardLocked) difficulty = difficulty === 'focused' ? 'focused-strong' : 'strong';

    let maxBatches = Math.max(1, Number(opts.defaultMaxBatches || 2));
    if (difficulty === 'hard') {
        // Real builds accept ZERO candidates in ~86% of batches: the best-ranked
        // clips land in batches 1-3, and a scene with no match falls back to
        // continuity either way — so batches 4-5 mostly burned the per-scene
        // deadline for nothing. Cap hard scenes at 3 (was 5). FOOTAGE_HARD_MAX_BATCHES
        // overrides if you want the old depth back.
        const hardBatches = parseInt(process.env.FOOTAGE_HARD_MAX_BATCHES, 10) || 3;
        maxBatches = Math.max(maxBatches, providerKey === 'storyblocks' ? Math.min(3, hardBatches) : hardBatches);
    } else if (difficulty === 'focused') {
        maxBatches = Math.max(maxBatches, 3);
    } else if (difficulty === 'focused-strong') {
        maxBatches = Math.max(maxBatches, 2);
    } else if (difficulty === 'strong') {
        maxBatches = Math.min(maxBatches, 2);
    }
    if (mediaType === 'image') {
        maxBatches = Math.min(maxBatches, difficulty === 'hard' ? 4 : 3);
    }
    maxBatches = Math.max(1, Math.min(12, maxBatches));

    // Decide after ONE batch when the scout was already confident (strong
    // pre-evidence) — collecting extra batches there just burned the per-scene
    // deadline and the held winner got discarded. Only genuinely weak/ambiguous
    // hard scenes collect a 2nd batch.
    const refereeCollectBatches = difficulty === 'hard'
        ? Math.min(strongPreEvidence ? 1 : 2, maxBatches)
        : difficulty === 'focused'
            ? Math.min(2, maxBatches)
            : 1;
    const finalistMinPriority = difficulty === 'hard' ? 4 : strongPreEvidence ? 6 : 5;
    const finalistMinKeep = difficulty === 'hard'
        ? Math.min(candidates.length || concurrency, concurrency * 2)
        : Math.min(candidates.length || concurrency, concurrency);
    // Graceful degradation (global, all niches): a relevant 7/10 clip beats a
    // reused continuity clip every time. "Hard" scenes used to demand 8/10 and
    // hold for up to 4.5 min — the exact behaviour that produced the timeout →
    // continuity cascade (most real-footage scenes are strictRaw ⇒ "hard"). So
    // we accept 7/10 everywhere and FORCE the race to commit its best-held
    // candidate within a tight budget instead of holding for perfection.
    const earlyAcceptScore = 7;
    const earlyAcceptQualityGap = difficulty === 'hard' ? 140 : strongPreEvidence ? 95 : 120;
    // Per-provider collection budget (force-commit best / bail if 0 accepted). The
    // hard-video ceiling was 130s; with the batch cap above and the YouTube timeout
    // fix, a tighter 95s ends doomed scenes ~35s sooner per provider — and a scene
    // tries several providers, so that compounds. FOOTAGE_HARD_COLLECT_MS overrides.
    const hardCollectMs = parseInt(process.env.FOOTAGE_HARD_COLLECT_MS, 10) || 95_000;
    const maxCollectMs = mediaType === 'image'
        ? (difficulty === 'hard' ? 60_000 : 45_000)
        : difficulty === 'hard'
            ? (strongPreEvidence ? Math.min(80_000, hardCollectMs) : hardCollectMs)
            : difficulty === 'focused'
                ? 110_000
                : 90_000;
    const refereeNowScore = 7;
    // Commit as soon as TWO solid candidates exist. Requiring 4 (old "hard"
    // setting) made strong-footage scenes keep collecting batches and blow the
    // per-scene deadline, then get discarded → no media. Two good 7/10s is plenty
    // to pick a winner; the budget ceiling above catches the 1-candidate case.
    const refereeNowMinCandidates = 2;

    return {
        difficulty,
        concurrency,
        maxBatches,
        refereeCollectBatches,
        finalistMinPriority,
        finalistMinKeep,
        earlyAcceptScore,
        earlyAcceptQualityGap,
        maxCollectMs,
        refereeNowScore,
        refereeNowMinCandidates,
        strongPreEvidence,
        reason: [
            lockStrength !== 'open' ? `lock=${lockStrength}` : '',
            mandatoryNeed ? 'scene-local mandatory visual' : '',
            strictRaw ? 'strict raw' : '',
            strongPreEvidence ? `strong scout signal f${signal.finalist}/m${signal.mediaScout}/t${signal.thumbnail}` : '',
        ].filter(Boolean).join(', ') || 'default',
    };
}

function _extendSceneDeadline(scene, minRemainingMs, reason) {
    if (!scene || !Number.isFinite(Number(scene._deadlineAt))) return;
    const cap = Number(scene._maxDeadlineAt || scene._deadlineAt);
    if (!Number.isFinite(cap) || Date.now() >= cap) return;
    const target = Math.min(cap, Date.now() + Math.max(0, Number(minRemainingMs) || 0));
    if (target <= scene._deadlineAt + 1000) return;
    scene._deadlineAt = target;
    if (!scene._deadlineGraceReasons) scene._deadlineGraceReasons = new Set();
    const key = String(reason || 'promising media operation');
    if (!scene._deadlineGraceReasons.has(key)) {
        scene._deadlineGraceReasons.add(key);
        console.log(`  [Deadline Grace] extended ${Math.round((target - Date.now()) / 1000)}s for ${key}`);
    }
}

// In-flight candidate hold: when a candidate is actively being downloaded or
// scored, the scene-level timeout should defer the abort until that operation
// finishes (accept or reject). The timeout fire path checks _inFlightCandidate
// and pushes _deadlineAt forward up to _maxDeadlineAt, then re-arms.
function _beginInFlight(scene, reason, opts = {}) {
    if (!scene) return;
    const reasonText = String(reason || 'in-flight candidate');
    const currentCount = Number(scene._inFlightCandidateCount || 0);
    scene._inFlightCandidateCount = (Number.isFinite(currentCount) ? Math.max(0, currentCount) : 0) + 1;
    if (!Array.isArray(scene._inFlightCandidateReasons)) scene._inFlightCandidateReasons = [];
    scene._inFlightCandidateReasons.push(reasonText);
    scene._inFlightCandidate = true;
    scene._inFlightCandidateReason = reasonText;
    scene._inFlightCandidateSince = scene._inFlightCandidateSince || Date.now();
    const minRemainingMs = Math.max(0, Number(opts.minRemainingMs || 0));
    if (minRemainingMs > 0 && Number.isFinite(Number(scene._deadlineAt))) {
        const now = Date.now();
        const extraCapMs = Math.max(minRemainingMs, Number(opts.extraCapMs || minRemainingMs));
        const target = now + minRemainingMs;
        const capTarget = now + extraCapMs;
        if (!Number.isFinite(Number(scene._maxDeadlineAt)) || scene._maxDeadlineAt < target) {
            scene._maxDeadlineAt = Math.max(Number(scene._maxDeadlineAt || 0), capTarget);
        }
        if (scene._deadlineAt < target) {
            scene._deadlineAt = target;
            const key = `${reasonText}:finish-grace`;
            if (!scene._deadlineGraceReasons) scene._deadlineGraceReasons = new Set();
            if (!scene._deadlineGraceReasons.has(key)) {
                scene._deadlineGraceReasons.add(key);
                console.log(`  [Deadline Grace] protected ${Math.round(minRemainingMs / 1000)}s for ${reasonText}`);
            }
        }
    }
}

function _endInFlight(scene, reason) {
    if (!scene) return;
    const currentCount = Number(scene._inFlightCandidateCount || 0);
    const nextCount = Math.max(0, (Number.isFinite(currentCount) ? currentCount : 0) - 1);
    scene._inFlightCandidateCount = nextCount;
    if (Array.isArray(scene._inFlightCandidateReasons)) {
        const reasonText = reason == null ? null : String(reason);
        if (reasonText) {
            const idx = scene._inFlightCandidateReasons.lastIndexOf(reasonText);
            if (idx >= 0) scene._inFlightCandidateReasons.splice(idx, 1);
            else scene._inFlightCandidateReasons.pop();
        } else {
            scene._inFlightCandidateReasons.pop();
        }
    }
    if (nextCount > 0) {
        scene._inFlightCandidate = true;
        const reasons = Array.isArray(scene._inFlightCandidateReasons) ? scene._inFlightCandidateReasons : [];
        scene._inFlightCandidateReason = reasons[reasons.length - 1] || 'in-flight candidate';
        return;
    }
    scene._inFlightCandidate = false;
    scene._inFlightCandidateReason = null;
    scene._inFlightCandidateReasons = [];
    scene._inFlightCandidateSince = 0;
}

function _descriptionTokens(description) {
    if (!description || typeof description !== 'string') return new Set();
    return new Set(
        description
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !_SEMANTIC_STOPWORDS.has(w))
    );
}

function _checkSemanticDuplicate(description) {
    const aTokens = _descriptionTokens(description);
    if (aTokens.size < 4) return null; // too short to compare reliably
    for (const [sceneIndex, entry] of _acceptedDescriptions.entries()) {
        const bTokens = _descriptionTokens(entry.description);
        if (bTokens.size < 4) continue;
        let overlap = 0;
        for (const tok of aTokens) if (bTokens.has(tok)) overlap++;
        const ratio = overlap / Math.min(aTokens.size, bTokens.size);
        if (ratio >= SEMANTIC_DUPE_THRESHOLD) {
            return { sceneIndex, ratio, provider: entry.provider, prior: entry.description };
        }
    }
    return null;
}

function _shouldRejectSemanticDuplicate() {
    return ['reject', 'hard', 'true', '1', 'on'].includes(SEMANTIC_DUPE_MODE);
}

function _rememberAcceptedDescription(description, sceneIndex, provider) {
    if (!description || typeof description !== 'string' || description.length < 20) return;
    _acceptedDescriptions.set(sceneIndex, { description, provider });
}

// ============ MISMATCH PENALTIES ============
// Vision models are too willing to score "contextually related" footage highly
// (e.g. giving 10/10 to a Kyiv living-room clip for an air-defense scene, just
// because both are set in Ukraine). These rules apply textual penalties on top
// of the vision score by comparing what the keyword/scene asks for against what
// the vision model reports seeing.
const _TARGET_OBJECTS = [
    { tokens: ['drone', 'drones', 'uav', 'quadcopter'], label: 'drone' },
    { tokens: ['missile', 'missiles', 'rocket', 'rockets', 'ballistic', 'cruise'], label: 'missile' },
    { tokens: ['interceptor', 'interceptors', 'interception', 'intercept', 'intercepting'], label: 'interceptor' },
    { tokens: ['tank', 'tanks', 'armored', 'armor'], label: 'tank' },
    { tokens: ['jet', 'jets', 'fighter', 'warplane', 'aircraft', 'airplane'], label: 'aircraft' },
    { tokens: ['helicopter', 'helicopters', 'chopper'], label: 'helicopter' },
    { tokens: ['warship', 'destroyer', 'cruiser', 'frigate', 'carrier', 'battleship'], label: 'warship' },
    { tokens: ['submarine', 'submarines'], label: 'submarine' },
    { tokens: ['explosion', 'explosions', 'blast', 'detonation', 'detonating'], label: 'explosion' },
    { tokens: ['fire', 'flames', 'burning', 'ablaze', 'wildfire'], label: 'fire' },
    { tokens: ['launch', 'launching', 'liftoff', 'launched'], label: 'launch' },
    { tokens: ['wreckage', 'debris', 'crashed', 'crash'], label: 'wreckage' },
    { tokens: ['air defense', 'air-defense', 'sam', 'patriot', 'iron dome', 'flak'], label: 'air defense' },
];

const _OUTDOOR_KW_RE = /\b(sky|skies|airspace|airborne|flying|overflight|launch|liftoff|battlefield|frontline|field|desert|ocean|sea|aerial|drone shot|overhead|above|strike|strikes|attack|raid)\b/i;
const _INDOOR_DESC_RE = /\b(living room|bedroom|sofa|couch|kitchen|office|studio|desk|interior|indoor|indoors|carpet|curtain|curtains|wall|walls|ceiling|hallway|hotel room|bathroom)\b/i;
const _OVERLAY_DESC_RE = /\b(watermark|watermarks|logo|united24|timestamped|overlaid with|overlay|overlays|caption|captions|ticker|lower.third|lower-third|waveform|visualizer|audio bar|burn.?in|subtitle|subtitles|channel logo|press logo|agency stamp)\b/i;
const _EDITORIAL_TEXT_OVERLAY_DESC_RE = /\b(editorial text overlay|title banner|headline banner|headline|thumbnail caption|thumbnail text|text overlay|overlaid text|caption bar|black title bar|black bar|lower.third|lower-third|article graphic|blog graphic|article header|article cover|seo (?:cover|header|graphic)|infographic header|promo(?:tional)? graphic|text box|text strip|baked.in (?:title|headline)|rendered (?:title|headline|caption))\b/i;
// Hard prefix the vision prompt is told to emit when an editorial overlay is present.
// Matching this is a hard short-circuit — penalty applied unconditionally.
const _EDITORIAL_OVERLAY_PREFIX_RE = /^\s*editorial text overlay\s*:/i;
const _EXPECTED_SUBJECT_LOGO_RE = /\b(logo|brand|branded|branding|label|sticker|product name|model|identifier|recognizable|specific branded)\b/i;
const _REACTION_DESC_RE = /\b(person (sitting|watching|listening|reacting|speaking|talking|standing)|people (watching|listening|reacting|standing|sitting)|audience|reporter interview|interviewee|crowd (listening|watching)|family (sitting|watching|in))\b/i;
const _SUBJECT_KW_RE = /\b(footage|strike|strikes|attack|attacks|explosion|explosions|intercept|interception|launch|combat|raid|raids|blast|battlefield|incoming|outgoing|bomb|bombing|shelling|firing)\b/i;
const _STRICT_RAW_GOOD_DESC_RE = /\b(cargo ship|container ship|oil tanker|tanker|vessel|ship|ships|port|harbor|harbour|crane|cranes|sea|ocean|strait|canal|shipping lane|open water|aerial|drone|factory|warehouse|refinery|pipeline|street|crowd|vehicle|aircraft|airport|hospital|stadium|appliance|appliances|washer|washing machine|front[-\s]?load|front[-\s]?loader|dryer|dishwasher|refrigerator|oven|range|stove|control panel|touchscreen|touch screen|glass door|store aisle|retail aisle|laundromat|showroom)\b/i;
const _STRICT_RAW_HARD_BAD_DESC_RE = /\b(anchor|presenter|talking head|studio|podcast|interview|webinar|lecture|panel discussion|roundtable|cartoon|animated|animation|infographic|slideshow|thumbnail|chart|graph|map graphic|screen full of text|lower third|ticker|headline banner)\b/i;

function _isReferenceImageContext(context = null) {
    const hunter = context?.mediaHunter || null;
    const mediaType = String(context?.mediaType || '').toLowerCase();
    const sourceHint = String(context?.sourceHint || '').toLowerCase();
    const agentRole = String(context?.mediaAgent?.role || '').toLowerCase();
    const hunterMode = String(hunter?.mode || '').toLowerCase();
    return mediaType === 'image'
        || sourceHint === 'web-image'
        || /image|still|reference/.test(`${agentRole} ${hunterMode}`);
}

async function _detectReferenceImageTitleBanner(filePath, context = null) {
    if (!_isReferenceImageContext(context)) return null;
    try {
        // Sniff BEFORE decoding. @napi-rs/canvas segfaults on a TIFF — no
        // exception, so this try/catch would never see it and the whole build
        // would die silently. A web-image URL ending .jpg can serve anything.
        const { isCanvasSafeImage } = require('../util/image-bytes');
        if (!isCanvasSafeImage(filePath)) return null;   // banner check is optional; skip, never crash

        const { createCanvas, loadImage } = require('@napi-rs/canvas');
        const image = await loadImage(filePath);
        const srcW = Number(image.width || 0);
        const srcH = Number(image.height || 0);
        if (!srcW || !srcH) return null;

        const w = 180;
        const h = Math.max(60, Math.min(140, Math.round(srcH / srcW * w)));
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;

        const lumAt = (x, y) => {
            const i = (y * w + x) * 4;
            return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        };
        const isDarkAt = (x, y) => lumAt(x, y) < 72;
        const isBrightOrYellowAt = (x, y) => {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const yellow = r > 145 && g > 115 && b < 95 && (r - b) > 65;
            return lum > 168 || yellow;
        };

        const rowDark = [];
        for (let y = 0; y < h; y++) {
            let dark = 0;
            for (let x = 0; x < w; x++) if (isDarkAt(x, y)) dark++;
            rowDark.push(dark / w);
        }

        const rowGroups = [];
        let start = -1;
        for (let y = 0; y < h; y++) {
            const active = rowDark[y] >= 0.18;
            if (active && start < 0) start = y;
            if ((!active || y === h - 1) && start >= 0) {
                const end = active && y === h - 1 ? y : y - 1;
                if ((end - start + 1) / h >= 0.055) rowGroups.push([start, end]);
                start = -1;
            }
        }

        // Second branch — light-background article-header detector.
        // The original branch above catches dark-bar / bright-text editorial
        // overlays (e.g. black title bars). It MISSES the inverse: a light
        // background with large bold colored title text rendered across the
        // upper third — typical of SEO blog/article headers like the
        // "JENN-AIR OVEN / RANGE ERROR CODES" red-on-white cover image.
        //
        // Heuristic: examine the top 35% of the frame. If it has high horizontal
        // edge density (lots of text strokes) AND the background (the non-edge
        // pixels) is mostly a near-uniform light tone, that's an editorial
        // header on a light card — reject. Keep tight enough to avoid hitting
        // genuine close-up product photos that happen to have edges.
        const upperBandH = Math.max(8, Math.floor(h * 0.35));
        let strongEdges = 0;
        let totalEdges = 0;
        let totalBgSamples = 0;
        let bgLumSum = 0;
        let bgLumMin = 255;
        let bgLumMax = 0;
        const bgLumBuckets = new Array(16).fill(0);
        for (let y = 1; y < upperBandH; y++) {
            for (let x = 1; x < w; x++) {
                totalEdges++;
                const lum = lumAt(x, y);
                const dx = Math.abs(lum - lumAt(x - 1, y));
                const dy = Math.abs(lum - lumAt(x, y - 1));
                if (dx > 75 || dy > 75) {
                    strongEdges++;
                } else {
                    // count near-edge-free samples as background pixels
                    totalBgSamples++;
                    bgLumSum += lum;
                    if (lum < bgLumMin) bgLumMin = lum;
                    if (lum > bgLumMax) bgLumMax = lum;
                    bgLumBuckets[Math.min(15, Math.max(0, Math.floor(lum / 16)))]++;
                }
            }
        }
        if (totalEdges > 0 && totalBgSamples > 0) {
            const edgeRatio = strongEdges / totalEdges;
            const bgMean = bgLumSum / totalBgSamples;
            // Dominant-bucket share: what fraction of bg pixels share a single
            // luminance bucket. High share => near-uniform background tone
            // (the article card behind the title).
            const dominantShare = Math.max(...bgLumBuckets) / totalBgSamples;
            const lightBg = bgMean > 175 && dominantShare > 0.42;
            // Strong-edge density above ~9% in the upper band is well above
            // what a normal product/close-up photo produces; 4-6% is typical
            // for real photos. The JENN-AIR header sits around 15-22%.
            const heavyText = edgeRatio > 0.085;
            if (lightBg && heavyText) {
                return {
                    reject: true,
                    reason: `article-header upper-band text on light card (edge=${Math.round(edgeRatio * 100)}%, bg=${Math.round(bgMean)}, share=${Math.round(dominantShare * 100)}%)`,
                };
            }
        }

        for (const [y0, y1] of rowGroups) {
            const gh = y1 - y0 + 1;
            const colDark = [];
            for (let x = 0; x < w; x++) {
                let dark = 0;
                for (let y = y0; y <= y1; y++) if (isDarkAt(x, y)) dark++;
                colDark.push(dark / gh);
            }

            let xStart = -1;
            for (let x = 0; x < w; x++) {
                const active = colDark[x] >= 0.35;
                if (active && xStart < 0) xStart = x;
                if ((!active || x === w - 1) && xStart >= 0) {
                    const xEnd = active && x === w - 1 ? x : x - 1;
                    const rw = xEnd - xStart + 1;
                    const widthRatio = rw / w;
                    const heightRatio = gh / h;
                    const areaRatio = widthRatio * heightRatio;
                    const touchesEdge = xStart <= 4
                        || xEnd >= w - 5
                        || ((y0 <= 4 || y1 >= h - 5) && widthRatio >= 0.45);

                    const upperOrLowerBannerZone = (y1 / h <= 0.48) || (y0 / h >= 0.42 && y1 / h <= 0.94);
                    const interiorEditorialBanner = widthRatio >= 0.22
                        && heightRatio >= 0.05
                        && heightRatio <= 0.28
                        && areaRatio <= 0.32
                        && upperOrLowerBannerZone;

                    if (widthRatio >= 0.18 && heightRatio >= 0.055 && areaRatio <= 0.38 && (touchesEdge || interiorEditorialBanner)) {
                        let bright = 0;
                        let dark = 0;
                        let edge = 0;
                        let total = 0;
                        for (let yy = y0; yy <= y1; yy++) {
                            for (let xx = xStart; xx <= xEnd; xx++) {
                                total++;
                                if (isDarkAt(xx, yy)) dark++;
                                if (isBrightOrYellowAt(xx, yy)) bright++;
                                if (xx > xStart && Math.abs(lumAt(xx, yy) - lumAt(xx - 1, yy)) > 85) edge++;
                                if (yy > y0 && Math.abs(lumAt(xx, yy) - lumAt(xx, yy - 1)) > 85) edge++;
                            }
                        }
                        const darkRatio = dark / Math.max(1, total);
                        const brightRatio = bright / Math.max(1, total);
                        const edgeRatio = edge / Math.max(1, total);
                        if (darkRatio >= 0.52 && brightRatio >= 0.012 && edgeRatio >= 0.025) {
                            return {
                                reject: true,
                                reason: `${touchesEdge ? 'edge-attached' : 'interior'} title/banner text block (${Math.round(widthRatio * 100)}%w x ${Math.round(heightRatio * 100)}%h)`,
                            };
                        }
                    }
                    xStart = -1;
                }
            }
        }
    } catch (_) {
        return null;
    }
    return null;
}

function _literalVisionRequirementText(keyword, sceneText, context = null) {
    const agent = context?.mediaAgent || null;
    const hunter = context?.mediaHunter || null;
    const literalObjects = [
        ...(Array.isArray(context?.literalRequiredObjects) ? context.literalRequiredObjects : []),
        ...(Array.isArray(agent?.literalRequiredObjects) ? agent.literalRequiredObjects : []),
    ];

    // When the Media Agent/Hunter exists, it owns the interpretation of the
    // scene. Do not scan raw narration/card text for literal objects: words
    // like "Laundry Tank", "crushing it", or "battle" can be metaphors or
    // display text while the actual footage target is something else.
    if (agent || hunter) {
        return [
            ...literalObjects,
            hunter?.targetDescription,
            agent?.target,
            agent?.viewerNeed,
            ...(Array.isArray(context?.mustShow) ? context.mustShow : []),
            ...(Array.isArray(agent?.mustShow) ? agent.mustShow : []),
        ].filter(Boolean).join(' ');
    }

    return `${String(keyword || '')} ${String(sceneText || '')}`;
}

function _hasAgenticAcceptanceContract(context = null) {
    const agent = context?.mediaAgent || null;
    if (!agent) return false;
    return Boolean(
        String(agent.minimumAcceptable || '').trim()
        || String(agent.searchStrategy?.minimumAcceptable || '').trim()
        || String(agent.acceptanceTest || '').trim()
        || String(agent.viewerNeed || '').trim()
    );
}

// Entity types a vision model can actually CONFIRM from the pixels alone.
// Mirrors the Director's universal entity taxonomy (person|place|org|event) and
// the media-agent MANDATORY_VISIBLE_ENTITY_TYPES. This is the niche-agnostic key
// to "is this entity frame-verifiable?": a person's face, a brand logo, a
// product, an org's signage CAN be read off a frame. A place/event/date/era
// CANNOT — open water is open water, a desert is a desert, "the 1800s" has no
// look — so generic-but-truthful footage can never PROVE them in-frame.
const _FRAME_VERIFIABLE_ENTITY_TYPES = new Set([
    'org', 'organization', 'company', 'brand', 'product', 'person', 'model',
]);

// True when an entity may legitimately gate the frame-visible penalty. Uses the
// Director's entity-type tags (scriptContextRef.entityTypes) — so it generalizes
// across every niche without hardcoded geographic/topic word lists. A KNOWN
// non-verifiable type (place, event, …) is excluded; an unknown/untagged type
// falls through (it could be an untagged brand/product we still want proven).
function _isFrameVerifiableEntity(entity) {
    const types = scriptContextRef?.entityTypes || {};
    const key = String(entity || '').toLowerCase();
    const type = String(types[key] || types[entity] || '').toLowerCase();
    return !type || _FRAME_VERIFIABLE_ENTITY_TYPES.has(type);
}

function _mandatoryVisibleEntities(context = null) {
    const agent = context?.mediaAgent || null;
    const hunter = context?.mediaHunter || null;
    const identityMode = String(agent?.identityEvidenceMode || hunter?.identityEvidenceMode || '').toLowerCase();
    return [
        ...(Array.isArray(context?.mandatoryVisible) ? context.mandatoryVisible : []),
        ...(Array.isArray(agent?.mandatoryVisible) ? agent.mandatoryVisible : []),
        ...(Array.isArray(hunter?.mandatoryVisible) ? hunter.mandatoryVisible : []),
        ...(!/source-proven/.test(identityMode) && Array.isArray(context?.mandatoryIdentity) ? context.mandatoryIdentity : []),
        ...(!/source-proven/.test(identityMode) && Array.isArray(agent?.mandatoryIdentity) ? agent.mandatoryIdentity : []),
        ...(!/source-proven/.test(identityMode) && Array.isArray(hunter?.mandatoryIdentity) ? hunter.mandatoryIdentity : []),
    ]
        .map(v => String(v || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        // Drop entities a vision model can't confirm in-frame (places, events,
        // eras). They stay as search/context hints elsewhere, but they must not
        // gate the frame-visible penalty or every honest B-roll candidate fails.
        .filter(_isFrameVerifiableEntity)
        .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
}

function _textMentionsPhrase(text, phrase) {
    const needle = String(phrase || '').replace(/\s+/g, ' ').trim();
    if (!needle || needle.length < 3) return false;
    const pattern = needle
        .split(/\s+/)
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s-]+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}($|[^\\p{L}\\p{N}])`, 'iu').test(String(text || ''));
}

function _descriptionMentionsMandatoryVisible(description, context = null) {
    return _mandatoryVisualCoverage(description, context, {
        includeMandatory: true,
        includeMustShow: false,
    }).ok;
}

const _ANCHOR_STOP_WORDS = new Set([
    'background', 'footage', 'video', 'clip', 'scene', 'visual', 'viewer',
    'audience', 'show', 'shows', 'showing', 'visible', 'clean', 'real',
    'genuine', 'generic', 'context', 'target', 'setting', 'subject',
    'fullscreen', 'card', 'template', 'with', 'where', 'that', 'this',
    'from', 'into', 'about', 'under', 'over', 'need', 'needs',
]);

const _MANDATORY_VISUAL_STOP_WORDS = new Set([
    ..._ANCHOR_STOP_WORDS,
    'angle', 'basic', 'camera', 'cinematic', 'clear', 'close', 'closeup',
    'close-up', 'displayed', 'establishing', 'extreme', 'frame', 'framing',
    'full', 'genuine', 'glossy', 'gritty', 'high', 'lighting', 'macro',
    'massive', 'multiple', 'normal', 'photo', 'plain', 'row', 'rows',
    'simple', 'tight', 'visible', 'wide',
]);

function _anchorTokenForm(token) {
    const value = String(token || '').toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '').trim();
    if (!value || value.length < 4 || /^\d+$/.test(value) || _ANCHOR_STOP_WORDS.has(value)) return '';
    if (value.endsWith('ies') && value.length > 5) return `${value.slice(0, -3)}y`;
    if (value.endsWith('ches') || value.endsWith('shes') || value.endsWith('xes')) return value.slice(0, -2);
    if (value.endsWith('s') && !value.endsWith('ss') && value.length > 4) return value.slice(0, -1);
    return value;
}

function _anchorTokens(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(_anchorTokenForm)
        .filter(Boolean);
}

function _mandatoryTokenForm(token) {
    const value = String(token || '').toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '').trim();
    if (!value || value.length < 3 || /^\d+$/.test(value) || _MANDATORY_VISUAL_STOP_WORDS.has(value)) return '';
    if (value.endsWith('ies') && value.length > 5) return `${value.slice(0, -3)}y`;
    if (value.endsWith('ches') || value.endsWith('shes') || value.endsWith('xes')) return value.slice(0, -2);
    if (value.endsWith('s') && !value.endsWith('ss') && value.length > 4) return value.slice(0, -1);
    return value && !_MANDATORY_VISUAL_STOP_WORDS.has(value) ? value : '';
}

function _mandatoryVisualTokens(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(_mandatoryTokenForm)
        .filter(Boolean);
}

const _NEGATED_VISUAL_WORDS = new Set([
    'without', 'lack', 'lacks', 'lacking', 'missing', 'absent', 'never',
]);

const _NEGATED_VISUAL_SUPPORT_WORDS = new Set([
    'show', 'shows', 'shown', 'showing', 'display', 'displays', 'displayed',
    'visible', 'seen', 'present', 'include', 'includes', 'included',
    'contain', 'contains', 'contained', 'have', 'has', 'had',
]);

function _expandedMandatoryWords(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\bdoesn['’]?t\b/g, 'does not')
        .replace(/\bdon['’]?t\b/g, 'do not')
        .replace(/\bdidn['’]?t\b/g, 'did not')
        .replace(/\bcan['’]?t\b/g, 'can not')
        .replace(/\bwon['’]?t\b/g, 'will not')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(word => word.replace(/^[-_]+|[-_]+$/g, ''))
        .filter(Boolean);
}

function _mandatoryWordEntries(value) {
    return _expandedMandatoryWords(value).map(raw => ({
        raw,
        form: _mandatoryTokenForm(raw),
    }));
}

function _visualNegationBefore(entries, index) {
    const start = Math.max(0, index - 8);
    const before = entries.slice(start, index);
    const raws = before.map(entry => entry.raw);
    if (raws.some(word => _NEGATED_VISUAL_WORDS.has(word))) return true;

    const noIndex = raws.lastIndexOf('no');
    if (noIndex >= 0 && raws.length - noIndex <= 4) {
        const afterNo = raws[noIndex + 1] || '';
        if (!/^(people|person|man|woman|men|women|one|body)$/.test(afterNo)) return true;
    }

    const notIndex = raws.lastIndexOf('not');
    if (notIndex >= 0) {
        const afterNot = raws.slice(notIndex + 1);
        if (afterNot.length <= 6 && (afterNot.length === 0 || afterNot.some(word => _NEGATED_VISUAL_SUPPORT_WORDS.has(word)))) {
            return true;
        }
    }

    return false;
}

function _visualNegationAfter(entries, index) {
    const after = entries.slice(index + 1, index + 7).map(entry => entry.raw).join(' ');
    return /\b(not visible|not shown|not seen|not present|missing|absent|lacking)\b/.test(after);
}

function _mandatoryTermIsNegated(description, tokens, hits = []) {
    const relevant = hits.length ? hits : tokens;
    if (!relevant.length) return false;
    const wanted = new Set(relevant);
    const entries = _mandatoryWordEntries(description);
    for (let i = 0; i < entries.length; i++) {
        if (!wanted.has(entries[i].form)) continue;
        if (_visualNegationBefore(entries, i) || _visualNegationAfter(entries, i)) return true;
    }
    return false;
}

function _mandatoryVisualTerms(context = null, options = {}) {
    const agent = context?.mediaAgent || null;
    const hunter = context?.mediaHunter || null;
    const terms = [];
    if (options.includeMandatory !== false) {
        terms.push(..._mandatoryVisibleEntities(context));
    }
    if (options.includeMustShow) {
        if (Array.isArray(context?.literalRequiredObjects)) terms.push(...context.literalRequiredObjects);
        if (Array.isArray(context?.mustShow)) terms.push(...context.mustShow);
        if (Array.isArray(agent?.literalRequiredObjects)) terms.push(...agent.literalRequiredObjects);
        if (Array.isArray(agent?.mustShow)) terms.push(...agent.mustShow);
        if (Array.isArray(hunter?.hardVisibleEntities)) terms.push(...hunter.hardVisibleEntities);
    }
    return terms
        .map(v => String(v || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
}

function _hardMandatoryVisualTerms(context = null) {
    // Hard rejection is only for scene-local entities that must be visible in
    // the actual frame. Literal scene objects still guide scoring, but they
    // must not become "perfect footage or fail" blockers for generic/template
    // backgrounds.
    return _mandatoryVisibleEntities(context);
}

function _negatedHardMandatoryVisual(description, context = null) {
    const descTokens = new Set(_mandatoryVisualTokens(description));
    for (const term of _hardMandatoryVisualTerms(context)) {
        const tokens = _mandatoryVisualTokens(term);
        if (tokens.length < 2) continue;
        const hits = tokens.filter(token => descTokens.has(token));
        if (hits.length >= Math.min(2, tokens.length) && _mandatoryTermIsNegated(description, tokens, hits)) {
            return term;
        }
    }
    return '';
}

function _mandatoryVisualCoverage(description, context = null, options = {}) {
    const terms = _mandatoryVisualTerms(context, options);
    if (terms.length === 0) return { ok: true, terms: [], matched: [], missing: [] };

    const descTokens = new Set(_mandatoryVisualTokens(description));
    const required = [];
    const matched = [];
    for (const term of terms) {
        const tokens = _mandatoryVisualTokens(term);
        if (tokens.length < 2) continue;
        const hits = tokens.filter(token => descTokens.has(token));
        const need = tokens.length <= 3
            ? Math.min(2, tokens.length)
            : Math.min(4, Math.max(2, Math.ceil(tokens.length * 0.45)));
        const negated = hits.length > 0 && _mandatoryTermIsNegated(description, tokens, hits);
        const item = { term, tokens, hits, need, negated };
        required.push(item);
        if (!negated && (hits.length >= need || _textMentionsPhrase(description, term))) matched.push(item);
    }

    if (required.length === 0) return { ok: true, terms, matched: [], missing: [] };
    const primaryRequired = options.requirePrimary && required.some(item => item.tokens.length >= 3)
        ? required.filter(item => item.tokens.length >= 3)
        : required;
    const primaryMatched = matched.filter(hit => primaryRequired.some(item => item.term.toLowerCase() === hit.term.toLowerCase()));
    const missing = primaryRequired.filter(item => !primaryMatched.some(hit => hit.term.toLowerCase() === item.term.toLowerCase()));
    return {
        ok: primaryMatched.length > 0,
        terms,
        matched: primaryMatched,
        missing,
    };
}

function _mandatoryCoverageForTerms(description, terms = [], options = {}) {
    const uniqueTerms = (terms || [])
        .map(v => String(v || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
    if (uniqueTerms.length === 0) return { ok: true, terms: [], matched: [], missing: [] };

    const descTokens = new Set(_mandatoryVisualTokens(description));
    const required = [];
    const matched = [];
    for (const term of uniqueTerms) {
        const tokens = _mandatoryVisualTokens(term);
        if (tokens.length < 2) continue;
        const hits = tokens.filter(token => descTokens.has(token));
        const need = tokens.length <= 3
            ? Math.min(2, tokens.length)
            : Math.min(4, Math.max(2, Math.ceil(tokens.length * 0.45)));
        const negated = hits.length > 0 && _mandatoryTermIsNegated(description, tokens, hits);
        const item = { term, tokens, hits, need, negated };
        required.push(item);
        if (!negated && (hits.length >= need || _textMentionsPhrase(description, term))) matched.push(item);
    }

    if (required.length === 0) return { ok: true, terms: uniqueTerms, matched: [], missing: [] };
    const primaryRequired = options.requirePrimary && required.some(item => item.tokens.length >= 3)
        ? required.filter(item => item.tokens.length >= 3)
        : required;
    const primaryMatched = matched.filter(hit => primaryRequired.some(item => item.term.toLowerCase() === hit.term.toLowerCase()));
    const missing = primaryRequired.filter(item => !primaryMatched.some(hit => hit.term.toLowerCase() === item.term.toLowerCase()));
    return {
        ok: primaryMatched.length > 0,
        terms: uniqueTerms,
        matched: primaryMatched,
        missing,
    };
}

function _candidateIndependentEvidenceText(candidate = null, keyword = '') {
    if (!candidate) return String(keyword || '');
    return [
        keyword,
        candidate.title,
        candidate.description,
        candidate.alt,
        candidate.snippet,
        candidate.url,
        candidate._sourcePage,
        candidate._directVideoUrl,
        candidate._fallbackUrl,
        candidate._cachedMeta?.title,
        candidate._meta?.title,
        candidate._candidateFinalistReason,
        candidate._thumbnailVisionReason,
        candidate._mediaScoutReason,
        candidate._scoutRejectReason,
        Array.isArray(candidate._mediaScoutReasons) ? candidate._mediaScoutReasons.join(' ') : '',
    ].filter(Boolean).join(' ');
}

function _mandatoryAcceptanceConfirmation({ postDescription = '', deepDescription = '', context = null, candidate = null, keyword = '' } = {}) {
    const hardTerms = _hardMandatoryVisualTerms(context);
    if (hardTerms.length === 0) return { ok: true, reason: '', hardTerms: [] };

    const postText = String(postDescription || '');
    const deepText = String(deepDescription || '');
    const independentText = _candidateIndependentEvidenceText(candidate, keyword);
    const combinedVisionText = [postText, deepText].filter(Boolean).join(' ');
    const negativeTerm = _negatedHardMandatoryVisual([postText, deepText, independentText].filter(Boolean).join(' '), context);
    if (negativeTerm) {
        return {
            ok: false,
            reason: `mandatory object contradicted: ${negativeTerm}`,
            hardTerms,
        };
    }

    const coverageOptions = {
        requirePrimary: true,
    };
    const postCoverage = _mandatoryCoverageForTerms(postText, hardTerms, coverageOptions);
    const deepCoverage = _mandatoryCoverageForTerms(deepText, hardTerms, coverageOptions);
    const sourceCoverage = _mandatoryCoverageForTerms(independentText, hardTerms, coverageOptions);
    const anyCoverage = postCoverage.ok || deepCoverage.ok || sourceCoverage.ok;
    if (!anyCoverage) {
        const missing = (postCoverage.missing || deepCoverage.missing || sourceCoverage.missing || [])
            .map(item => item.term)
            .slice(0, 3);
        return {
            ok: false,
            reason: `mandatory object not confirmed${missing.length ? `: ${missing.join(', ')}` : ''}`,
            hardTerms,
        };
    }

    // For video candidates, a single post-download frame is not enough when
    // there is no independent source/title evidence. Require the deeper clip
    // read to agree, otherwise a lucky/hallucinated frame can win the race.
    if (deepText && !deepCoverage.ok && !sourceCoverage.ok) {
        const missing = (deepCoverage.missing || [])
            .map(item => item.term)
            .slice(0, 3);
        return {
            ok: false,
            reason: `mandatory object not confirmed by clip/source${missing.length ? `: ${missing.join(', ')}` : ''}`,
            hardTerms,
        };
    }

    return {
        ok: true,
        reason: sourceCoverage.ok ? 'source/title confirms mandatory object'
            : deepCoverage.ok ? 'clip confirms mandatory object'
            : 'frame confirms mandatory object',
        hardTerms,
    };
}

function _sceneAnchorTokens(context = null) {
    const agent = context?.mediaAgent || null;
    const hunter = context?.mediaHunter || null;
    const values = [
        ...(Array.isArray(context?.literalRequiredObjects) ? context.literalRequiredObjects : []),
        ...(Array.isArray(context?.subjectAnchors) ? context.subjectAnchors : []),
        ...(Array.isArray(context?.mustShow) ? context.mustShow : []),
        ...(Array.isArray(agent?.literalRequiredObjects) ? agent.literalRequiredObjects : []),
        ...(Array.isArray(agent?.subjectAnchors) ? agent.subjectAnchors : []),
        ...(Array.isArray(agent?.mustShow) ? agent.mustShow : []),
        ...(Array.isArray(hunter?.prefer) ? hunter.prefer : []),
        agent?.target,
        agent?.viewerNeed,
        hunter?.targetDescription,
    ].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const value of values) {
        for (const token of _anchorTokens(value)) {
            if (seen.has(token)) continue;
            seen.add(token);
            out.push(token);
            if (out.length >= 28) return out;
        }
    }
    return out;
}

function _isTemplateBackgroundContext(context = null) {
    const hunter = context?.mediaHunter || null;
    const agentRole = String(context?.mediaAgent?.role || '').toLowerCase();
    const hunterMode = String(hunter?.mode || '').toLowerCase();
    return Boolean(hunter?.templateBackground)
        || /template-background|generic-broll|background/.test(`${agentRole} ${hunterMode}`);
}

function _sceneAnchorCoverage(description, context = null) {
    const anchors = _sceneAnchorTokens(context);
    if (anchors.length === 0) return { anchors, matched: [] };
    const descTokens = new Set(_anchorTokens(description));
    const matched = anchors.filter(token => descTokens.has(token));
    return { anchors, matched };
}

/**
 * Apply post-hoc mismatch penalties to a vision score. The vision model often
 * gives loosely-related footage a perfect score; this catches the common classes
 * of mismatch (missing target object, indoor vs outdoor, overlays, reaction
 * footage masquerading as subject footage) and subtracts from the score.
 *
 * @returns { score, penalty, reasons }
 */
function _applyMismatchPenalty(score, description, keyword, sceneText, clipAnalysis, context = null) {
    if (!description) return { score, penalty: 0, reasons: [] };
    const desc = String(description).toLowerCase();
    const combined = _literalVisionRequirementText(keyword, sceneText, context).toLowerCase();
    const reasons = [];
    let penalty = 0;
    let capScore = null;
    const hunter = context?.mediaHunter || null;
    // Priority-channel scope (e.g. Kanal13AZ for politics/military): the channel's
    // own logo/bug is intrinsic to a source we explicitly preferred. Treat any
    // watermark mention as "small non-blocking" and skip the strict-raw score cap —
    // vision still rejects large/centered overlays via the description regex tests
    // and the hard-source-change rule below.
    const priorityChannel = !!context?.priorityChannel;
    const mediaType = String(context?.mediaType || '').toLowerCase();
    const sourceHint = String(context?.sourceHint || '').toLowerCase();
    const agentRole = String(context?.mediaAgent?.role || '').toLowerCase();
    const hunterMode = String(hunter?.mode || '').toLowerCase();
    // Template-background scenes: a fullscreen statCard/factCard/imageShowcase/etc
    // overlay covers most of the underlying clip. Text overlays, captions, and
    // corner watermarks in the background footage will be hidden behind the
    // template UI, so the strictRaw cap-4 should not fire on those signals.
    const templateBackground = !!hunter?.templateBackground
        || /template-background/i.test(agentRole);
    // Media Agent declared this scene's subject IS a textual object (book/album/poster
    // cover, sign, document). Its own cover/title text is the subject, not an editorial
    // defect — so the deterministic editorial-text cap below is skipped (vision is told the
    // same, and still penalizes an EXTERNAL article header layered on top of the object).
    const allowEditorialText = !!hunter?.allowEditorialText;
    const strictRawCap = hunter?.strictRaw && !hunter.allowGraphics && !templateBackground;
    const mandatoryEntities = _mandatoryVisibleEntities(context);
    const agenticAcceptanceContract = _hasAgenticAcceptanceContract(context) && mandatoryEntities.length === 0;
    const mandatoryCoverage = _mandatoryVisualCoverage(description, context, {
        includeMandatory: true,
        includeMustShow: false,
        requirePrimary: true,
    });
    const mandatoryEntityVisible = mandatoryCoverage.ok;
    const negatedMandatoryVisual = _negatedHardMandatoryVisual(description, context);
    const mustShowCoverage = _mandatoryVisualCoverage(description, context, {
        includeMandatory: false,
        includeMustShow: true,
        requirePrimary: true,
    });
    const templateCompositionOk = templateBackground
        && mandatoryEntities.length > 0
        && mandatoryEntityVisible
        && /\b(split[-\s]?screen|side[-\s]?by[-\s]?side|comparison|text overlay|caption|watermark|logo)\b/i.test(desc)
        && !/\b(news anchor|anchor desk|presenter|host|talking to camera|studio desk|podcast|webcam)\b/i.test(desc);
    const isReferenceImage = mediaType === 'image'
        || sourceHint === 'web-image'
        || /image|still|reference/.test(`${agentRole} ${hunterMode}`);
    const expectedSubjectLogo = /\blogo\b/i.test(desc)
        && _EXPECTED_SUBJECT_LOGO_RE.test(combined)
        && /\b(on|printed on|attached to|visible on|sticker on|label on|branded)\b.*\b(product|appliance|device|screen|display|control panel|panel|package|packaging|label|sticker|storefront|vehicle|machine)\b/i.test(desc)
        && !/\b(watermark|agency stamp|channel logo|press logo|overlay|overlaid|thumbnail)\b/i.test(desc);

    if (mandatoryEntities.length > 0 && !mandatoryEntityVisible) {
        penalty += 4;
        const missingMandatory = (mandatoryCoverage.missing || [])
            .map(item => item.term)
            .slice(0, 3);
        reasons.push(`mandatory visible entity missing: ${(missingMandatory.length ? missingMandatory : mandatoryEntities).slice(0, 3).join(', ')}`);
        capScore = Math.min(capScore ?? 10, 4);
    }

    if (negatedMandatoryVisual) {
        penalty += 4;
        reasons.push(`mandatory visual negated: ${negatedMandatoryVisual}`);
        capScore = Math.min(capScore ?? 10, 4);
    }

    if ((mustShowCoverage.missing || []).length > 0
        && !mustShowCoverage.ok
        && Number(score || 0) >= 6) {
        const missingMustShow = mustShowCoverage.missing
            .map(item => item.term)
            .slice(0, 3);
        if (agenticAcceptanceContract) {
            penalty += 1;
            reasons.push(`thin agentic evidence for: ${missingMustShow.join(', ')}`);
            capScore = Math.min(capScore ?? 10, 6);
        } else {
            penalty += 3;
            reasons.push(`required scene visual detail missing: ${missingMustShow.join(', ')}`);
            capScore = Math.min(capScore ?? 10, 5);
        }
    }

    // Missing target object: keyword asks for a specific thing, description never mentions it.
    for (const obj of _TARGET_OBJECTS) {
        const kwHas = obj.tokens.some(t => _textMentionsPhrase(combined, t));
        if (!kwHas) continue;
        const descHas = obj.tokens.some(t => _textMentionsPhrase(desc, t));
        if (!descHas) {
            penalty += 3;
            reasons.push(`missing target "${obj.label}"`);
            break; // one target mismatch is sufficient evidence
        }
    }

    if (templateBackground && Number(score || 0) >= 7) {
        const coverage = _sceneAnchorCoverage(description, context);
        if (coverage.anchors.length >= 3) {
            if (coverage.matched.length === 0) {
                penalty += 2;
                reasons.push(`missing direct scene anchors: ${coverage.anchors.slice(0, 4).join(', ')}`);
                capScore = Math.min(capScore ?? 10, 6);
            } else if (Number(score || 0) >= 8 && coverage.matched.length === 1) {
                penalty += 1;
                reasons.push(`thin scene-anchor match: ${coverage.matched[0]}`);
                capScore = Math.min(capScore ?? 10, 7);
            }
        }
    }

    // Indoor/outdoor mismatch: outdoor subject, indoor scene.
    if (_OUTDOOR_KW_RE.test(combined) && _INDOOR_DESC_RE.test(desc)) {
        penalty += 3;
        reasons.push('indoor footage for outdoor subject');
    }

    // Overlays / watermarks / audio-visualizer chrome — from the vision description…
    const smallWatermark = isSmallNonBlockingWatermark(desc);
    const croppableWatermark = isCroppableCornerWatermark(desc);
    // Hard-prefix short-circuit: vision was told to start with "EDITORIAL TEXT OVERLAY:"
    // when an article-header / on-image headline is present. Matching the prefix is
    // a deterministic editorial-overlay signal — apply the same cap-4 as the regex
    // path, independent of mediaType (some overlay calls don't have isReferenceImage).
    if (allowEditorialText) {
        // Textual-object scene: the object's own cover/title text is the subject. Vision
        // owns the external-header-vs-native-text distinction here; no deterministic cap.
    } else if (_EDITORIAL_OVERLAY_PREFIX_RE.test(description)) {
        if (templateBackground) {
            penalty += 1;
            reasons.push('editorial text overlay (covered by template — small penalty)');
        } else if (templateCompositionOk) {
            penalty += 1;
            reasons.push(`${strictRawVisual.reason} (mandatory entity visible; template/background tolerance)`);
        } else {
            penalty += 4;
            reasons.push('vision flagged EDITORIAL TEXT OVERLAY prefix');
            capScore = Math.min(capScore ?? 10, 4);
        }
    } else if (isReferenceImage && _EDITORIAL_TEXT_OVERLAY_DESC_RE.test(desc)) {
        if (templateBackground) {
            penalty += 1;
            reasons.push('web-image editorial/text overlay (covered by template)');
        } else {
            penalty += 4;
            reasons.push('web-image editorial/text overlay');
            capScore = Math.min(capScore ?? 10, 4);
        }
    }
    if (_OVERLAY_DESC_RE.test(desc)) {
        if (expectedSubjectLogo) {
            // Product/brand labels can be the actual subject of a reference image.
            // Do not treat the required logo itself as a watermark.
        } else if (croppableWatermark) {
            // Corner/side watermark — compositor can crop it via a small scale/zoom
            // at render time, so no penalty (accept as if clean).
            reasons.push('corner/side watermark (croppable — no penalty)');
        } else if (smallWatermark || priorityChannel) {
            penalty += 1;
            reasons.push(priorityChannel && !smallWatermark
                ? 'priority-channel logo (treated as small)'
                : 'small non-blocking watermark/logo');
        } else {
            // Watermark policy (May 21, 2026): only corner/croppable or small non-
            // blocking watermarks are tolerated. Anything bigger is hard-capped to
            // 4/10 across the whole build — template-background scenes no longer
            // get a free pass because the on-source watermark stacks with our own
            // template overlay and produces visual noise.
            const overlayPenalty = isReferenceImage ? 3 : 2;
            penalty += overlayPenalty;
            reasons.push('overlay/watermark in frame');
            capScore = Math.min(capScore ?? 10, 4);
        }
    }
    // …and from the deep clip analyzer's issues list, which is more reliable.
    if (clipAnalysis?.issues?.length) {
        const issuesStr = clipAnalysis.issues.join(' ').toLowerCase();
        if (/watermark|logo|channel|stamp|agency/.test(issuesStr)) {
            const combinedDesc = `${desc} ${issuesStr}`;
            const croppable = isCroppableCornerWatermark(combinedDesc);
            const small = isSmallNonBlockingWatermark(combinedDesc);
            if (croppable) {
                reasons.push('clip-analysis: corner/side watermark (croppable — no penalty)');
            } else if (small || priorityChannel) {
                penalty += 1;
                reasons.push(priorityChannel && !small
                    ? 'clip-analysis: priority-channel logo (treated as small)'
                    : 'clip-analysis: small non-blocking watermark/logo');
            } else {
                // See watermark policy comment above — template-background tolerance
                // removed; non-corner, non-small watermarks always cap to 4/10.
                penalty += 2;
                reasons.push('clip-analysis: watermark/logo');
                capScore = Math.min(capScore ?? 10, 4);
            }
        }
        if (/text overlay|caption|ticker|lower.third|burn.?in|subtitle/.test(issuesStr)) {
            if (templateBackground) {
                penalty += 1;
                reasons.push('clip-analysis: text overlay (covered by template)');
            } else {
                penalty += 2;
                reasons.push('clip-analysis: text overlay');
                if (strictRawCap) capScore = Math.min(capScore ?? 10, 4);
            }
        }
        if (/waveform|visualizer|audio bar/.test(issuesStr)) {
            penalty += 2;
            reasons.push('clip-analysis: audio visualizer');
        }
        if (/hard scene|source change|scene change|inconsistent content|abrupt transition|stitched|switches? from|cuts? from/.test(issuesStr)
            && !/(same[-\s]?subject|same (ship|vessel|tanker|container ship|port|harbor|canal|strait|location|scene|event)|camera angle|angle changes?|different angles?|perspective changes?|closer shot|wide shot|aerial to closer|zoom)/.test(issuesStr)) {
            penalty += 4;
            reasons.push('clip-analysis: hard source/content change');
            if (strictRawCap) capScore = Math.min(capScore ?? 10, 4);
        }
    }

    // Reaction footage: keyword asks for the SUBJECT (strike/attack/explosion),
    // description shows people reacting to it instead.
    if (_SUBJECT_KW_RE.test(combined)
        && _REACTION_DESC_RE.test(desc)
        && !allowsRelevantPersonFootage(desc, keyword, sceneText, context)) {
        penalty += 3;
        reasons.push('reaction footage instead of subject');
    }

    const strictRawVisual = hunter?.strictRaw && !hunter.allowGraphics
        ? classifyStrictRawVisual(desc, keyword, sceneText, context)
        : null;
    if (strictRawVisual?.reject) {
        // Template-background scenes: the statCard/factCard/etc UI covers the
        // central frame, so a "text-packaged" rejection driven purely by
        // watermark/logo/caption text doesn't matter — the template hides those
        // exact pixels. We still hard-reject GRAPHIC (diagrams, infographics)
        // and PRESENTER (anchor desks, talking heads) because those still bleed
        // around the template edges.
        const buckets = Array.isArray(strictRawVisual.buckets) ? strictRawVisual.buckets : [];
        const onlyTextBucket = templateBackground
            && buckets.length > 0
            && buckets.every(b => b === 'text');
        if (onlyTextBucket) {
            penalty += 1;
            reasons.push(`${strictRawVisual.reason} (text-only — template covers)`);
        } else {
            penalty += 4;
            reasons.push(strictRawVisual.reason);
            capScore = Math.min(capScore ?? 10, 3);
        }
    }

    const penalizedScore = Math.max(1, score - penalty);
    const newScore = capScore !== null ? Math.min(capScore, penalizedScore) : penalizedScore;
    return { score: newScore, penalty, reasons };
}

function _segmentWindowIsVerified(windowValidation) {
    if (!windowValidation || !windowValidation.ok) return false;
    if (windowValidation.skipped) return false;
    const score = Number(windowValidation.score || 0);
    return !Number.isFinite(score) || score <= 0 || score >= 7;
}

function _clipTextHasHardVisualProblem(text, context = {}) {
    const value = String(text || '').toLowerCase();
    if (!value.trim()) return false;
    if (isTopicAccurateMapFromPremiumStock(value, context)) return false;
    if (_STRICT_RAW_HARD_BAD_DESC_RE.test(value)) return true;
    if (_OVERLAY_DESC_RE.test(value) && !isSmallNonBlockingWatermark(value)) return true;
    return /\b(unrelated|wrong subject|different topic|different video topic|not relevant|does not match|black frame|blank frame|corrupt|webpage|website screenshot|hard source|source\/content change|content change|different clip|different source)\b/i.test(value);
}

function _segmentLockBlockReason(description, hunterProfile, context = {}) {
    const text = String(description || '').trim();
    if (!text) return 'empty final vision';
    if (_clipTextHasHardVisualProblem(text, context)) return 'final vision reported a hard visual problem';
    const discontinuity = _strictRawDiscontinuityRejectReason({
        description: text,
        issues: [],
        raw: text,
        motion: '',
    }, hunterProfile);
    if (discontinuity) return discontinuity;
    return '';
}

function _canVerifiedSegmentLockLowVision(description, keyword, sceneText, hunterProfile, smartSegmentResult, windowValidation = null) {
    if (!hunterProfile?.strictRaw || hunterProfile.allowGraphics || !smartSegmentResult) return false;
    const confidence = Number(smartSegmentResult.confidence || 0.75);
    const exactWindowVerified = _segmentWindowIsVerified(windowValidation);
    // Low final vision is allowed to be rescued only by an exact-window pass.
    // A single strong frame or metadata/title confidence cannot overrule the
    // actual downloaded clip once final vision has inspected it.
    if (!exactWindowVerified) return false;
    if (!Number.isFinite(confidence) || confidence < 0.55) return false;

    const text = `${description || ''} ${smartSegmentResult.reason || ''}`.toLowerCase();
    if (!text.trim()) return false;
    if (_segmentLockBlockReason(text, hunterProfile, { keyword, sceneText, mediaHunter: hunterProfile })) return false;

    const strictRawVisual = classifyStrictRawVisual(text, keyword, sceneText, { mediaHunter: hunterProfile });
    if (strictRawVisual?.reject) return false;
    const avoidHit = (hunterProfile.avoid || []).some(term => {
        const cleanTerm = String(term || '').toLowerCase().trim();
        if (cleanTerm.length < 3) return false;
        if (text.includes(cleanTerm)) return true;
        const firstClause = cleanTerm.split(/[;,.()]/)[0].trim();
        if (firstClause.length >= 4 && text.includes(firstClause)) return true;
        const normalizedText = text.replace(/[-\s]+/g, ' ');
        const normalizedClause = firstClause.replace(/[-\s]+/g, ' ');
        if (normalizedClause.length >= 4 && normalizedText.includes(normalizedClause)) return true;
        const words = normalizedClause.split(/\s+/).filter(w => w.length >= 4 && !/^(machine|machines|footage|scene|setting|brand|branding|visible|clearly)$/.test(w));
        return words.length > 0 && words.slice(0, 2).every(w => normalizedText.includes(w));
    });
    if (avoidHit) return false;

    const preferredHit = (hunterProfile.prefer || []).some(term => {
        const cleanTerm = String(term || '').toLowerCase().trim();
        return cleanTerm.length >= 3 && text.includes(cleanTerm);
    });
    return exactWindowVerified && (preferredHit || _STRICT_RAW_GOOD_DESC_RE.test(text));
}

function _strictRawDiscontinuityRejectReason(clipAnalysis, hunterProfile) {
    if (!hunterProfile?.strictRaw || hunterProfile.allowGraphics || !clipAnalysis) return null;

    const issues = (clipAnalysis.issues || []).join(' ').toLowerCase();
    const text = `${clipAnalysis.description || ''} ${issues} ${clipAnalysis.motion || ''} ${clipAnalysis.raw || ''}`.toLowerCase();
    if (!/(jump cut|jump cuts|scene change|scene changes|inconsistent content|abrupt transition|hard scene|source change|stitched|cuts? to|transitions? between|switches? to|followed by)/i.test(text)) {
        return null;
    }

    // Allowed: same real subject/location/event, only the camera angle,
    // perspective, crop, zoom, or shot size changes.
    const sameSubjectAngleChange = /(same[-\s]?subject|same (ship|vessel|tanker|container ship|port|harbor|canal|strait|location|scene|event)|camera angle|angle changes?|different angles?|perspective changes?|closer shot|wide shot|aerial to closer|zoom)/i.test(text)
        && !/(presenter|commentator|talking head|studio|interview|anchor|map|graphic|infographic|chart|collage|ai-generated|illustrated|animation|thumbnail|lower third|ticker|headline|text overlay|unrelated|wrong subject)/i.test(text);
    if (sameSubjectAngleChange) return null;

    if (/(presenter|commentator|talking head|studio|interview|anchor|podcast)/i.test(text)) {
        return 'hard scene/source change to presenter or interview';
    }
    if (/(map|graphic|infographic|chart|collage|ai-generated|illustrated|animation|thumbnail|route graphic)/i.test(text)) {
        return 'hard scene/source change to graphic, map, collage, or AI/illustrated content';
    }
    if (/(unrelated|wrong subject|different source|different scene|different clip|inconsistent content|abrupt transition|stitched)/i.test(text)) {
        return 'hard scene/source change inside clip';
    }
    if (/transitions? between/i.test(text) && !sameSubjectAngleChange) {
        return 'multiple source/scene transitions inside clip';
    }
    if (/(?:cuts? to|followed by|switches? to|then shows|then cuts? to)/i.test(text) && !sameSubjectAngleChange) {
        return 'hard scene/source change inside clip';
    }

    return null;
}

// ============ INLINE VISION SCORING ============

let _visionEnabled = false;
let _scoreVideoFrame = null;
let _verifyEditorialTextOverlay = null;

function enableInlineVision() {
    try {
        const {
            scoreVideoFrame,
            verifyEditorialTextOverlay,
            isVisionAvailable,
        } = require('../vision/ai-vision');
        if (isVisionAvailable()) {
            _visionEnabled = true;
            _scoreVideoFrame = scoreVideoFrame;
            _verifyEditorialTextOverlay = verifyEditorialTextOverlay;
            console.log(`  👁️ Inline vision scoring enabled`);
        }
    } catch {}
}

/**
 * Merged video scoring — ONE batched analyzeClip call returns score +
 * description + motion + issues. Replaces the 3-5 sequential per-frame
 * vision calls plus the later deep-clip call. Attaches the full clip
 * analysis as `_clipAnalysis` so the candidate loop can skip the deep block.
 */
async function _scoreVideoMerged(filePath, keyword, context) {
    try {
        const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
        const { probeDuration: _probe } = require('../agents/smart-segment');
        const dur = (await _probe(ffmpegPath, filePath)) || 8;

        const clipAnalysis = await clipAnalyzer.analyzeClip(filePath, dur, keyword, {
            sceneText: context?.sceneText || '',
            niche: context?.niche || '',
            videoTopic: context?.videoTopic || '',
            theme: context?.theme || '',
            entities: context?.entities || [],
            entityContext: context?.entityContext || [],
            tone: context?.tone || '',
            mood: context?.mood || '',
            mediaAgent: context?.mediaAgent || null,
            mediaHunter: context?.mediaHunter || null,
            sourceProvider: context?.sourceProvider || '',
            visualIntent: context?.visualIntent || '',
        });
        if (!clipAnalysis || typeof clipAnalysis.score !== 'number') return null;

        const baseScore = Math.max(0, Math.min(10, Number(clipAnalysis.score) || 0));
        const description = clipAnalysis.description || '';

        // Topic-map rescue (same logic as the per-frame path).
        const topicMapCandidate = isTopicAccurateMapFromPremiumStock(description, context);
        let mapRescued = topicMapCandidate;
        let finalScore = baseScore;
        if (topicMapCandidate && finalScore < 7) {
            finalScore = 7;
            console.log(`    🗺️  Topic-map rescue (merged): bumping ${baseScore} → 7/10`);
        }

        let sanityRescued = false;
        if (!mapRescued) {
            const sanity = applyVisionScoreSanity(
                { score: finalScore, description, parseError: !!clipAnalysis.parseError },
                keyword,
                context,
                { floor: 5 }
            );
            if (sanity?.scoreSanity?.adjusted) {
                console.log(`    [Score Sanity] merged clip: ${sanity.scoreSanity.from}/10 -> ${sanity.scoreSanity.to}/10 (${sanity.scoreSanity.reason})`);
                finalScore = sanity.score;
                sanityRescued = true;
            }
        }

        // The model answered, but we could not read a score out of it, and the
        // description was not enough to rescue it either. That is "not judged",
        // never "judged bad" — returning 0 here would bin a clip nobody rejected.
        // Fall through to the per-frame path, exactly as the caller below already
        // documents; before the parser signalled parseError this branch was
        // unreachable, so an unreadable answer silently became a 0.
        if (clipAnalysis.parseError && !mapRescued && !sanityRescued) {
            console.log(`    ↺ [Merged] score unreadable in the model's reply — re-scoring per-frame instead of binning`);
            return null;
        }

        // Mismatch penalty (same as per-frame path).
        const penaltyCheck = mapRescued
            ? { score: finalScore, penalty: 0, reasons: [] }
            : _applyMismatchPenalty(finalScore, description, keyword, context?.sceneText, clipAnalysis, context);
        if (penaltyCheck.penalty > 0) {
            console.log(`    ⛔ Merged mismatch penalty -${penaltyCheck.penalty} (${penaltyCheck.reasons.join('; ')}) → ${finalScore} → ${penaltyCheck.score}`);
        }

        return {
            score: penaltyCheck.score,
            description,
            rawScore: baseScore,
            penaltyReasons: penaltyCheck.reasons,
            mapRescued,
            _clipAnalysis: clipAnalysis,
        };
    } catch (err) {
        console.log(`  ⚠️ Merged scoring failed (${path.basename(filePath)}): ${String(err?.message || err).slice(0, 140)}`);
        return null;
    }
}

/**
 * Score a downloaded image or extract frames from video and score them.
 * For videos: extracts 3 frames (at 20%, 50%, 80% of clip) and uses the
 * MINIMUM score — if any frame shows an anchor/person/bad content, reject.
 * Returns { score, description } or null on failure.
 */
async function _scoreDownloadedMedia(filePath, ext, keyword, context) {
    if (!_scoreVideoFrame) return null;
    try {
        const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext.toLowerCase());
        const isVideo = ['.mp4', '.webm', '.mkv', '.mov'].includes(ext.toLowerCase());

        let base64, mimeType;

        // ── Merged-scoring fast path (videos only) ──
        // One batched analyzeClip call replaces the 3-5 sequential per-frame
        // vision calls AND the later deep-clip call. Result is also surfaced
        // as `_clipAnalysis` so the candidate loop can reuse it and skip the
        // duplicate deep block. Toggle via MERGED_CLIP_SCORING=off.
        const mergedScoringEnabled = String(process.env.MERGED_CLIP_SCORING || 'on').toLowerCase() !== 'off';
        if (isVideo && mergedScoringEnabled && clipAnalyzer && (clipAnalyzer.isClipAnalysisAvailable ? clipAnalyzer.isClipAnalysisAvailable() : (clipAnalyzer.isAvailable && clipAnalyzer.isAvailable()))) {
            const mergedResult = await _scoreVideoMerged(filePath, keyword, context);
            if (mergedResult) return mergedResult;
            // If merged call fails (AI unavailable / parse error), fall through to
            // the per-frame path so we don't drop the clip silently.
        }

        if (isImage) {
            const buf = fs.readFileSync(filePath);
            base64 = buf.toString('base64');
            mimeType = ext.toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
        } else if (isVideo) {
            // Extract 3 frames from the downloaded clip to catch mid-clip cuts
            // (e.g., scene starts with ships but cuts to anchor at second 4)
            const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
            const { execFile: _execFile } = require('child_process');
            const { probeDuration: _probe } = require('../agents/smart-segment');

            // Get clip duration
            const clipDuration = await _probe(ffmpegPath, filePath);
            const dur = clipDuration || 8; // fallback 8s for short clips

            // Strict raw-footage scenes get extra checks so packaged videos that
            // cut from B-roll to anchors/charts are caught before acceptance.
            const rawHunter = context?.mediaHunter?.strictRaw && !context?.mediaHunter?.allowGraphics;
            // Storyblocks fast-path: subscribed Storyblocks clips are curated
            // single-subject stock B-roll, mostly <60s and one continuous shot
            // (no anchor cuts, no scene changes). Scoring 3-5 frames of the
            // same shot is wasted Qwen budget and produces the [7,3,2,2,2]
            // median-drag bug. For Storyblocks short clips, a single mid-frame
            // is enough to decide. Long Storyblocks clips (>=60s) still get
            // multi-frame because they're rarer and may have cuts.
            const isStoryblocksClip = /storyblocks/i.test(String(context?.sourceProvider || ''));
            const sampleRatios = (isStoryblocksClip && dur < 60)
                ? [0.4]
                : rawHunter
                    ? [0.12, 0.3, 0.5, 0.7, 0.88]
                    : [0.2, 0.5, 0.8];
            const sampleTimes = dur >= 4
                ? sampleRatios.map(r => Math.max(1, Math.min(Math.floor(dur - 1), Math.floor(dur * r))))
                : [1]; // very short clip: just 1 frame

            const framePaths = [];
            const extractFailures = [];
            const frameTempDir = config.paths?.temp || path.dirname(filePath);
            try { fs.mkdirSync(frameTempDir, { recursive: true }); } catch (_) {}
            const frameBase = path.basename(filePath, path.extname(filePath)).replace(/[^a-z0-9_-]+/gi, '_') || 'media';
            const frameUid = `${Date.now().toString(36)}_${process.pid}`;
            for (let fi = 0; fi < sampleTimes.length; fi++) {
                const framePath = path.join(frameTempDir, `${frameBase}_vision_${frameUid}_${fi}.jpg`);
                framePaths.push(framePath);
                await new Promise((resolve) => {
                    const attempts = [
                        ['-hide_banner', '-loglevel', 'error', '-ss', String(sampleTimes[fi]), '-i', filePath, '-vf', 'scale=512:-2', '-frames:v', '1', '-q:v', '3', '-y', framePath],
                        ['-hide_banner', '-loglevel', 'error', '-ss', String(sampleTimes[fi]), '-i', filePath, '-frames:v', '1', '-q:v', '3', '-y', framePath],
                    ];
                    let attemptIndex = 0;
                    let lastErr = '';
                    const runAttempt = () => {
                        try { if (fs.existsSync(framePath)) fs.unlinkSync(framePath); } catch (_) {}
                        _execFile(ffmpegPath, attempts[attemptIndex], { timeout: 10000, windowsHide: true }, (err, _stdout, stderr) => {
                            const ok = !err && fs.existsSync(framePath);
                            if (ok) return resolve();
                            lastErr = String(stderr || err?.message || '').trim().split('\n').slice(-1)[0] || 'no output';
                            attemptIndex++;
                            if (attemptIndex < attempts.length) return runAttempt();
                            extractFailures.push(`f${fi}@${sampleTimes[fi]}s: ${lastErr.slice(0, 120)}`);
                            resolve();
                        });
                    };
                    runAttempt();
                });
            }
            if (extractFailures.length === sampleTimes.length) {
                console.log(`  ⚠️ Vision frame extract failed for all ${sampleTimes.length} samples (${path.basename(filePath)}): ${extractFailures[0]}`);
            } else if (extractFailures.length > 0) {
                console.log(`  ⚠️ Vision frame extract failed ${extractFailures.length}/${sampleTimes.length}: ${extractFailures.join(' | ')}`);
            }

            // Score each frame
            let worstScore = 10;
            let worstDesc = '';
            let bestScore = 0;
            let bestDesc = '';
            let scoredCount = 0;
            const allFrameScores = [];

            const scoreFailures = [];
            for (let fi = 0; fi < framePaths.length; fi++) {
                const fp = framePaths[fi];
                if (!fs.existsSync(fp)) {
                    scoreFailures.push(`f${fi}: frame file missing`);
                    continue;
                }
                try {
                    const stat = fs.statSync(fp);
                    if (stat.size < 500) {
                        scoreFailures.push(`f${fi}: frame too small (${stat.size}B)`);
                        continue;
                    }
                    const buf = fs.readFileSync(fp);
                    const b64 = buf.toString('base64');
                    const rawResult = await _scoreVideoFrame(b64, 'image/jpeg', keyword, context);
                    const result = applyVisionScoreSanity(rawResult, keyword, context, { floor: 5 });
                    if (result?.scoreSanity?.adjusted) {
                        console.log(`    [Score Sanity] frame ${fi + 1}: ${result.scoreSanity.from}/10 -> ${result.scoreSanity.to}/10 (${result.scoreSanity.reason})`);
                    }
                    scoredCount++;
                    allFrameScores.push(result.score);

                    if (sampleTimes.length > 1) {
                        console.log(`    👁️ Clip frame ${fi + 1}/${sampleTimes.length} (${sampleTimes[fi]}s): ${result.score}/10 → ${result.description || ''}`);
                    }

                    if (result.score < worstScore) {
                        worstScore = result.score;
                        worstDesc = result.description || '';
                    }
                    if (result.score > bestScore) {
                        bestScore = result.score;
                        bestDesc = result.description || '';
                    }

                    // Fast fail: if this frame scores 0, vision is broken
                    if (fi === 0 && result.score === 0) break;
                } catch (e) {
                    scoreFailures.push(`f${fi}: scoring threw — ${String(e?.message || e).slice(0, 140)}`);
                }
                finally {
                    try { fs.unlinkSync(fp); } catch {}
                }
            }
            if (scoredCount === 0 && scoreFailures.length > 0) {
                console.log(`  ⚠️ Vision scoring produced 0 results (${path.basename(filePath)}): ${scoreFailures.join(' | ')}`);
            }

            // Cleanup any remaining frames
            for (const fp of framePaths) {
                try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
            }

            if (scoredCount === 0) return null;

            // Scoring strategy: use MEDIAN instead of minimum.
            // One bad frame (e.g., a text overlay or transition) shouldn't kill a good clip.
            // If 2 of 3 frames score well, the clip is usable.
            let finalScore;
            if (allFrameScores.length >= 3) {
                const sorted = [...allFrameScores].sort((a, b) => a - b);
                finalScore = sorted[Math.floor(sorted.length / 2)]; // median
            } else if (allFrameScores.length === 2) {
                // 2 frames: use lower of the two (conservative)
                finalScore = Math.min(...allFrameScores);
            } else {
                finalScore = worstScore;
            }

            const mergedDesc = worstScore === bestScore
                ? worstDesc
                : `worst: ${worstDesc} (${worstScore}/10) | best: ${bestDesc} (${bestScore}/10) → median: ${finalScore}/10`;

            // Topic-accurate map rescue: Qwen's strict-raw prompt scores every
            // map frame ≤2, but a route map from Storyblocks that actually
            // depicts the scene's topic is a usable visual (e.g. Bab el-Mandeb
            // shipping lane scene → 3D route map of Bab el-Mandeb). Bump such
            // clips to a passing floor BEFORE the penalty step so they don't
            // get killed by the same packaged-graphic rule that the carve-out
            // in hasHardPackagedVisual already exempts.
            const combinedDesc = `${worstDesc} | ${bestDesc}`;
            const topicMapCandidate = isTopicAccurateMapFromPremiumStock(combinedDesc, context);
            let mapRescued = topicMapCandidate;
            // Demoted 7→5 (below the acceptance bar): the in-house map system
            // (map-hf-builder) now renders better maps than any stock map
            // clip, so a rescued stock map should only ship under true
            // scarcity (force-decide), never beat real footage. The old
            // 7/10 bump put illustrated/labeled map clips straight into
            // scenes as primary footage.
            if (topicMapCandidate && finalScore < 5) {
                console.log(`    🗺️  Topic-map rescue: ${context?.sourceProvider || 'stock'} map shows topic → bumping ${finalScore} → 5/10 (scarcity-only)`);
                finalScore = 5;
            }

            // Best-frame rescue: median can be dragged down by 3-4 weak sample
            // frames even when the clip has a clearly on-topic moment (e.g.
            // Storyblocks "big box store appliance aisle" — frame 1 was the
            // exact subject at 7/10, frames 2-5 sampled into machine close-ups
            // at 2/10 → median=2 reject, but the clip was usable from start
            // and Smart Trim downstream can place playback at the strong
            // segment). Bump such clips to a passing floor so they survive
            // the score-too-low gate. Strict-raw mode stays cautious — needs
            // a higher best-frame bar.
            const strictRawScoring = context?.mediaHunter?.strictRaw && !context?.mediaHunter?.allowGraphics;
            const bestFrameBar = strictRawScoring ? 8 : 7;
            const bestFrameFloor = strictRawScoring ? 5 : 6;
            let bestFrameRescued = false;
            if (!mapRescued
                && finalScore <= 4
                && bestScore >= bestFrameBar
                && allFrameScores.length >= 3) {
                console.log(`    🎬 Best-frame rescue: median ${finalScore}/10 but best=${bestScore}/10 → bumping to ${bestFrameFloor}/10 (Smart Trim will place playback)`);
                finalScore = bestFrameFloor;
                bestFrameRescued = true;
            }

            // Apply hard mismatch penalties before returning — the vision model often
            // inflates scores for contextually-related-but-literally-wrong footage.
            // EXCEPTION: topic-accurate map rescue exempts this penalty entirely.
            // Route-map descriptions contain "text overlay / packaged graphic /
            // AI-generated" — exactly the tokens the penalty hunts. Without this
            // skip, 7 → 0 immediately on the very same call that just rescued it.
            const penaltyCheck = mapRescued
                ? { score: finalScore, penalty: 0, reasons: [] }
                : _applyMismatchPenalty(finalScore, combinedDesc, keyword, context?.sceneText, null, context);
            if (penaltyCheck.penalty > 0) {
                console.log(`    ⛔ Mismatch penalty -${penaltyCheck.penalty} (${penaltyCheck.reasons.join('; ')}) → ${finalScore} → ${penaltyCheck.score}`);
            }
            return {
                score: penaltyCheck.score,
                description: mergedDesc,
                rawScore: finalScore,
                penaltyReasons: penaltyCheck.reasons,
                mapRescued,
                bestFrameRescued,
            };
        } else {
            return null;
        }

        // Image path — single-frame scoring. Apply the same mismatch penalty
        // we use post-video so decorative graphics that match thematic words
        // ("instability", "speed") in the narration but don't actually depict
        // the subject (shipping lane, cargo ship, port, map) get rejected.
        // Without this, an abstract red motion-blur PNG scored 5/10 simply
        // because Qwen pattern-matched the word "instability" from the scene.
        let rawImgResult = await _scoreVideoFrame(base64, mimeType, keyword, context);
        let overlayVerification = null;
        if (_EDITORIAL_OVERLAY_PREFIX_RE.test(String(rawImgResult?.description || ''))) {
            overlayVerification = _verifyEditorialTextOverlay
                ? await _verifyEditorialTextOverlay(base64, mimeType)
                : null;
            if (overlayVerification?.present) {
                console.log(`    [Overlay OCR] confirmed "${_short(overlayVerification.text, 70)}" (${overlayVerification.confidence}/10)`);
            } else {
                console.log('    [Overlay OCR] vision overlay claim was not confirmed from pixels; rescoring without source metadata');
                const rescored = await _scoreVideoFrame(base64, mimeType, keyword, {
                    ...(context || {}),
                    sourceTitle: '',
                    overlayVerifiedAbsent: true,
                });
                if (rescored) rawImgResult = rescored;
                if (_EDITORIAL_OVERLAY_PREFIX_RE.test(String(rawImgResult?.description || ''))) {
                    rawImgResult = {
                        ...rawImgResult,
                        description: 'Pixel-only text check was unconfirmed; candidate judged on visual fit only.',
                    };
                }
            }
        }
        const imgResult = applyVisionScoreSanity(rawImgResult, keyword, context, { floor: 5 });
        if (!imgResult) return null;
        if (imgResult?.scoreSanity?.adjusted) {
            console.log(`    [Score Sanity] image: ${imgResult.scoreSanity.from}/10 -> ${imgResult.scoreSanity.to}/10 (${imgResult.scoreSanity.reason})`);
        }
        const imgPenalty = _applyMismatchPenalty(
            imgResult.score,
            imgResult.description,
            keyword,
            context?.sceneText,
            null,
            context
        );
        if (imgPenalty.penalty > 0) {
            console.log(`    ⛔ Image mismatch penalty -${imgPenalty.penalty} (${imgPenalty.reasons.join('; ')}) → ${imgResult.score} → ${imgPenalty.score}`);
        }
        const bannerSuspect = imgPenalty.score > 4
            ? await _detectReferenceImageTitleBanner(filePath, context)
            : null;
        let bannerArtifact = null;
        if (bannerSuspect?.reject) {
            const confirmation = overlayVerification
                || (_verifyEditorialTextOverlay
                    ? await _verifyEditorialTextOverlay(base64, mimeType)
                    : null);
            if (confirmation?.present) {
                bannerArtifact = {
                    ...bannerSuspect,
                    reason: `${bannerSuspect.reason}; OCR "${_short(confirmation.text, 70)}" (${confirmation.confidence}/10)`,
                };
            } else {
                console.log(`    Image artifact guard ignored (${bannerSuspect.reason}) — no pixel/OCR text confirmation`);
            }
        }
        const finalScore = bannerArtifact?.reject ? Math.min(4, imgPenalty.score) : imgPenalty.score;
        const penaltyReasons = [...imgPenalty.reasons];
        let description = imgResult.description;
        if (bannerArtifact?.reject) {
            penaltyReasons.push(`web-image title/banner artifact: ${bannerArtifact.reason}`);
            console.log(`    Image artifact guard (${bannerArtifact.reason}) -> ${imgPenalty.score} -> ${finalScore}`);
            description = `${description} [Rejected: ${bannerArtifact.reason}]`;
        }
        return {
            score: finalScore,
            description,
            rawScore: imgResult.score,
            penaltyReasons,
            parseError: !!imgResult.parseError,
            scoreSanity: imgResult.scoreSanity || null,
        };
    } catch {
        return null;
    }
}

/**
 * When vision rejects all attempts, ask AI to suggest a better search keyword.
 * Returns { keyword, switchToVideo } or null.
 */
async function _visionSuggestKeyword(failedDescriptions, originalKeyword, context) {
    try {
        const { callAI } = require('../brain/ai-provider');
        const descList = failedDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n');
        const wantsReferenceImage = String(context.mediaType || '').toLowerCase() === 'image'
            || String(context.sourceHint || '').toLowerCase() === 'web-image'
            || String(context.mediaHunter?.domain || '').toLowerCase() === 'reference-image';

        // Build rich context so AI can suggest a DIFFERENT angle, not a synonym
        let contextBlock = '';
        if (context.videoTopic) contextBlock += `Video topic: "${context.videoTopic}"\n`;
        if (context.sceneText) contextBlock += `Scene narration: "${context.sceneText}"\n`;
        if (context.eventAnchor) contextBlock += `Specific event: "${context.eventAnchor}"\n`;
        if (context.entities && context.entities.length > 0) contextBlock += `Key entities: ${context.entities.join(', ')}\n`;
        if (context.niche) contextBlock += `Content niche: ${context.niche}\n`;
        if (context.mediaAgent?.viewerNeed) contextBlock += `Media agent viewer need: ${context.mediaAgent.viewerNeed}\n`;
        if (context.mediaAgent?.minimumAcceptable || context.mediaAgent?.searchStrategy?.minimumAcceptable) contextBlock += `Media agent minimum acceptable: ${context.mediaAgent.minimumAcceptable || context.mediaAgent.searchStrategy.minimumAcceptable}\n`;
        if (context.mediaAgent?.acceptanceTest) contextBlock += `Media agent acceptance test: ${context.mediaAgent.acceptanceTest}\n`;
        if (context.mediaAgent?.mandatoryVisible?.length) contextBlock += `Mandatory visible entity: ${context.mediaAgent.mandatoryVisible.slice(0, 8).join(', ')}\n`;
        if (context.mediaAgent?.mustShow?.length) contextBlock += `Media agent must show: ${context.mediaAgent.mustShow.slice(0, 8).join(', ')}\n`;
        if (context.mediaAgent?.mustAvoid?.length) contextBlock += `Media agent must avoid: ${context.mediaAgent.mustAvoid.slice(0, 8).join(', ')}\n`;
        if (context.mediaHunter?.targetDescription) contextBlock += `Desired visual target: ${context.mediaHunter.targetDescription}\n`;
        if (context.mediaHunter?.avoid?.length) contextBlock += `Avoid visuals: ${context.mediaHunter.avoid.slice(0, 8).join(', ')}\n`;

        // Include previously tried keywords so AI avoids them
        const triedList = context.triedKeywords && context.triedKeywords.length > 0
            ? `\nKeywords already tried (DO NOT repeat or rephrase these): ${context.triedKeywords.map(k => `"${k}"`).join(', ')}`
            : '';

        const response = await callAI(
            `${wantsReferenceImage
                ? `I'm searching for an exact/reference still image for a scene, but ALL downloaded image results were wrong.`
                : `I'm searching for B-roll footage for a scene but ALL results were wrong.`}

Failed keyword: "${originalKeyword}"
What the search returned:
${descList}
${triedList}

CONTEXT:
${contextBlock}
TASK: ${wantsReferenceImage
                ? `Suggest a better web-image search phrase for the SAME viewer need. Use the Media Agent acceptance test: search for visible evidence/proxy details when the perfect literal shot failed. Preserve exact named brands, products, people, labels, documents, UI/screenshots, or places only when they are truly mandatory. Do not drift to unrelated generic stock B-roll.`
                : `Think about what DIFFERENT visible evidence could communicate this scene. Don't just rephrase the same concept — suggest a different concrete angle, proxy detail, setting, process, object detail, or related action that still satisfies the Media Agent acceptance test.`}

Examples of good agentic repair:
- Direct scene proof fails -> search for visible evidence that communicates the same viewer need.
- Exact artifact unavailable -> search for a label, marking, document, screen, setting, process, object detail, or same-category action.
- Abstract phrase fails -> search for hands-on concrete visual evidence the audience can read immediately.
${wantsReferenceImage ? `
Examples for exact/reference still repair:
- "YouTube comment section angry consumers" fails → try "negative YouTube comments screenshot"
- "Honda engine model plate" fails → try "Honda GX engine serial plate photo"
` : ''}

Suggest a ${wantsReferenceImage ? '3-8 word web-image search phrase' : '3-5 word search keyword that approaches the scene from a DIFFERENT visual angle'}.
Also say VIDEO if this would work better as a video clip, or IMAGE for a still.

Reply format (exactly 2 lines):
[new search keyword]
[VIDEO or IMAGE]`,
            {
                maxTokens: 60,
                systemPrompt: wantsReferenceImage
                    ? 'You repair failed web-image search phrases for exact/reference stills. Preserve the scene target and exact entities. Output ONLY the keyword and media type.'
                    : 'You suggest creative alternative search keywords for B-roll footage. Think laterally — find a DIFFERENT visual that still fits the scene context. Be specific and literal. Output ONLY the keyword and media type.',
                taskType: 'utility',
            }
        );

        const lines = response.trim().split('\n').filter(l => l.trim());
        if (lines.length === 0) return null;

        const newKeyword = lines[0].replace(/^["']|["']$/g, '').trim();
        const switchToVideo = lines.length > 1 && lines[1].trim().toUpperCase().includes('VIDEO');

        if (!newKeyword || newKeyword.length < 3 || newKeyword.toLowerCase() === originalKeyword.toLowerCase()) return null;

        return { keyword: newKeyword, switchToVideo };
    } catch {
        return null;
    }
}

// ============ CONCURRENCY UTILITY ============

/**
 * Execute async tasks with a concurrency limit.
 * @param {Array<() => Promise>} tasks - Array of async task functions
 * @param {number} limit - Max concurrent tasks
 * @returns {Promise<Array>} Results in original order
 */
async function parallelWithLimit(tasks, limit) {
    const results = new Array(tasks.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < tasks.length) {
            const i = nextIndex++;
            results[i] = await tasks[i]();
        }
    }

    const workers = [];
    for (let w = 0; w < Math.min(limit, tasks.length); w++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

// Map source keys (from UI) to provider classes
const VIDEO_SOURCE_MAP = {
    pexels: PexelsVideoProvider,
    pixabay: PixabayVideoProvider,
    storyblocks: StoryblocksVideoProvider,
    youtube: YouTubeVideoProvider,
    reddit: RedditVideoProvider,
};

// Pexels/Pixabay cover free stock imagery. Storyblocks is kept only for old
// project compatibility and is disabled in source-policy while suspended.
// Bing + Brave are REAL web-image search (news/real-world photos), not stock.
const IMAGE_SOURCE_MAP = {
    pexels: PexelsImageProvider,
    pixabay: PixabayImageProvider,
    storyblocks: StoryblocksVideoProvider,
    bing: BingImageProvider,
    brave: BraveImageProvider,
};

// Default provider priority order (when no smart hint available).
// Real web-image sources (bing scraper + brave API) race first, stock last.
const VIDEO_PRIORITY = ['pexels', 'pixabay', 'youtube', 'reddit'];
const IMAGE_PRIORITY = ['bing', 'brave', 'pexels', 'pixabay'];

// ============ SMART SOURCE PRIORITY ============

const POLITICS_MILITARY_EVENT_ACTOR_RE = /\b(houthi|houthis|yemen|iran|iranian|israel|israeli|gaza|hamas|hezbollah|idf|russia|russian|ukraine|ukrainian|nato|pentagon|navy|naval|military|army|troops?|soldiers?|forces?|warship|destroyer|missile|drone|uav)\b/i;
const REAL_EVENT_ACTION_RE = /\b(attack|attacks|attacked|strike|strikes|struck|airstrike|missile launch|drone launch|drone strike|explosion|blast|shelling|war|battle|conflict|invasion|blockade|seizure|hijack|hijacking|shootdown|shot down|intercept|intercepts|warning|operation|retaliation|sanction|sanctions|protest|riot|coup|election)\b/i;

function _isPoliticsMilitaryRealEventScene(scene = {}, keyword = '', scriptContext = {}) {
    const nicheId = String(scriptContext?.nicheId || '').toLowerCase();
    const isScopedNiche = /^(news|explainer)\.(politics|military)$/.test(nicheId);
    const text = [
        keyword,
        scene?.keyword,
        scene?.searchKeyword,
        scene?.webQuery,
        scene?.stockQuery,
        scene?.visualIntent,
        scene?.text,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
    ].filter(Boolean).join(' ');
    const hasActor = POLITICS_MILITARY_EVENT_ACTOR_RE.test(text);
    const hasAction = REAL_EVENT_ACTION_RE.test(text);
    return hasActor && hasAction && (isScopedNiche || /\b(news|politics|geopolitics|military|war|conflict)\b/i.test(`${nicheId} ${scriptContext?.theme || ''} ${text}`));
}

function _isPoliticsMilitaryYouTubeChannelScope(scene = {}, keyword = '', scriptContext = {}) {
    // Channel-scoped YouTube is only for actual politics/military events.
    // Generic B-roll inside a military/politics explainer (cargo ships, canals,
    // ports, factories) needs normal YouTube search or it will never find the
    // broad documentary/canal footage available on public YouTube.
    return _isPoliticsMilitaryRealEventScene(scene, keyword, scriptContext);
}

function _shouldPromoteYouTubeForMaritimeBroll(scene = {}, keyword = '', hunterProfile = null) {
    if (!hunterProfile?.strictRaw || hunterProfile.allowGraphics) return false;
    if (hunterProfile.domain !== 'maritime') return false;
    if (scene?.mediaIntent?.lane === 'videoBackup') return false;
    const text = [
        keyword,
        scene?.keyword,
        scene?.searchKeyword,
        scene?.webQuery,
        scene?.stockQuery,
        scene?.visualIntent,
        scene?.text,
    ].filter(Boolean).join(' ');
    if (/\b(map|route map|locator|satellite|chart|infographic|diagram)\b/i.test(text)) return false;
    return /\b(container ship|cargo ship|oil tanker|tanker|vessel|freighter|canal|suez|panama canal|strait|red sea|bab[-\s]?el[-\s]?mandeb|shipping lane|port)\b/i.test(text);
}

// AI source hint → provider order (reorders, never adds unchecked sources).
// Includes Bing for exact/reference still images behind sourceHint="web-image".
const SOURCE_PRIORITY_MAP = {
    'stock':     { video: ['pexels', 'pixabay', 'youtube', 'reddit'], image: ['pexels', 'pixabay'] },
    'web-image': { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    'youtube':   { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    'reddit':    { video: ['reddit', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    'news':      { video: ['reddit', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
};

// Theme-level fallback when AI source hint is missing
const THEME_PRIORITY_MAP = {
    // Factual/news themes → prefer real footage (YouTube, Reddit)
    politics:      { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    finance:       { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    business:      { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    technology:    { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    crime:         { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    documentary:   { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    military:      { video: ['reddit', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    war:           { video: ['reddit', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    geopolitics:   { video: ['reddit', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    celebrity:     { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    // Aesthetic/organic themes → prefer stock footage
    nature:        { video: ['pexels', 'pixabay', 'youtube', 'reddit'], image: ['pexels', 'pixabay'] },
    travel:        { video: ['pexels', 'pixabay', 'youtube', 'reddit'], image: ['pexels', 'pixabay'] },
    lifestyle:     { video: ['pexels', 'pixabay', 'youtube', 'reddit'], image: ['pexels', 'pixabay'] },
    food:          { video: ['pexels', 'pixabay', 'youtube', 'reddit'], image: ['pexels', 'pixabay'] },
    health:        { video: ['pexels', 'pixabay', 'youtube', 'reddit'], image: ['pexels', 'pixabay'] },
    // Other
    history:       { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    entertainment: { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    sports:        { video: ['reddit', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
    diy:           { video: ['youtube', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'brave', 'pexels', 'pixabay'] },
};

/**
 * Get smart provider priority order based on AI source hint and video theme.
 * Resolution: source hint → theme fallback → default order.
 * Only reorders — never adds providers that weren't enabled.
 */
function getSmartPriority(sourceHint, mediaType, scriptContext) {
    let order;
    const nicheId = scriptContext?.nicheId;

    // Priority 1: AI per-scene source hint
    if (sourceHint && SOURCE_PRIORITY_MAP[sourceHint]) {
        order = SOURCE_PRIORITY_MAP[sourceHint][mediaType];
    }

    // Priority 2: Niche-based provider priority
    if (!order) {
        if (nicheId) {
            const niche = getNiche(nicheId);
            if (niche.footagePriority && niche.footagePriority[mediaType]) {
                order = niche.footagePriority[mediaType];
            }
        }
    }

    // Priority 3: Legacy theme-based fallback
    if (!order) {
        const theme = (scriptContext?.theme || '').toLowerCase();
        if (theme && THEME_PRIORITY_MAP[theme]) {
            order = THEME_PRIORITY_MAP[theme][mediaType];
        }
    }

    // Priority 4: Default hardcoded order
    if (!order) {
        order = mediaType === 'video' ? VIDEO_PRIORITY : IMAGE_PRIORITY;
    }

    // Make a copy so we don't mutate source arrays
    order = [...order];

    // === POST-FILTERS ===

    // Completeness tail: whichever tier above produced the order, it was a
    // *preference list*, not the set of providers that exist. When the niche
    // supplied it (tier 2) the order literally IS the niche's two or three
    // favourites — so every other provider was unreachable through the
    // deterministic path no matter how badly the favourites were doing.
    //
    // Every remaining provider for this media type is appended at the tail, in
    // the app's default order. Nothing that led before leads any less; we only
    // stop the ladder from ending early. The rungs added here are the ones the
    // scene reaches after its preferred sources have already failed it — which
    // is exactly the moment a scene used to ship with no footage at all.
    const universe = mediaType === 'video' ? VIDEO_PRIORITY : IMAGE_PRIORITY;
    for (const p of universe) {
        if (!order.includes(p)) order.push(p);
    }

    // Niche preference: providers the topic asks for come FIRST — but the ones
    // it does not ask for are demoted, never deleted.
    //
    // This used to be a hard allowlist (`order.filter(...)`), which turned a
    // preference into a capability ceiling. Because every niche lists only
    // `pexels, pixabay` for images, Brave was removed from every topic in the
    // app and could never be reached deterministically no matter how badly the
    // first two were doing; Bing only survived through a hardcoded rescue right
    // here. A topic saying "I like stock best" must not mean "I would rather
    // ship a scene with no footage than open anything else".
    //
    // Real bans still delete: `excludeVideoProviders` below, the disabled-
    // provider list, and whatever the user switched off in the UI.
    if (nicheId) {
        const niche = getNiche(nicheId);
        const nichePreferred = niche.footagePriority?.[mediaType];
        if (nichePreferred && nichePreferred.length > 0) {
            const preferredSet = new Set(nichePreferred);
            const preferred = order.filter(p => preferredSet.has(p));
            const demoted = order.filter(p => !preferredSet.has(p));
            order = [...preferred, ...demoted];
        }
    }

    // Niche exclusions: remove providers the niche explicitly bans
    if (nicheId && mediaType === 'video') {
        const niche = getNiche(nicheId);
        if (niche.excludeVideoProviders && niche.excludeVideoProviders.length > 0) {
            const excluded = new Set(niche.excludeVideoProviders);
            order = order.filter(p => !excluded.has(p));
        }
    }

    if (mediaType === 'video') {
        order = order.filter(p => !DISABLED_VIDEO_PROVIDER_KEYS.has(p));
    }

    // Exact/reference stills should hit Bing first. Generic stock images use Pexels/Pixabay.
    if (mediaType === 'image' && sourceHint !== 'stock' && order.includes('bing')) {
        order = ['bing', ...order.filter(p => p !== 'bing')];
    }

    return order;
}

// ============ PROVIDER MANAGEMENT ============

// Active provider instances (persisted across scenes for duplicate tracking)
let videoProviders = [];
let imageProviders = [];
let scriptContextRef = null;
/** Get video topic string — title + summary for best AI context */
function _videoTopic() {
    const title = scriptContextRef?.videoTitle || '';
    const summary = scriptContextRef?.summary || '';
    return title ? `${title} — ${summary}` : summary;
}

function getEnabledSources() {
    const defaults = { storyblocks: false, pexels: true, pixabay: true, youtube: true, reddit: true, bing: true, brave: true };
    try {
        const raw = process.env.FOOTAGE_SOURCES;
        if (raw) return { ...defaults, ...JSON.parse(raw) };
    } catch (e) { }
    // Bing is enabled by default for sourceHint="web-image".
    // Default: storyblocks (stock), youtube, reddit — all other providers are disabled
    return defaults;
}

function initProviders(scriptContext) {
    const enabled = getEnabledSources();
    scriptContextRef = scriptContext || null;

    // Build filtered provider lists based on UI toggles.
    // Defensive filter: drop providers whose declared mediaType doesn't match
    // the lane — e.g. IMAGE_SOURCE_MAP.storyblocks resolves to the Storyblocks
    // *Videos* class, which would otherwise leak MP4 downloads into image
    // scenes (saved with .jpg extension → corrupted-looking files).
    videoProviders = VIDEO_PRIORITY
        .filter(key => enabled[key] && !DISABLED_VIDEO_PROVIDER_KEYS.has(key) && VIDEO_SOURCE_MAP[key])
        .map(key => new VIDEO_SOURCE_MAP[key]())
        .filter(p => p && p.mediaType === 'video');

    imageProviders = IMAGE_PRIORITY
        .filter(key => enabled[key] && IMAGE_SOURCE_MAP[key])
        .map(key => new IMAGE_SOURCE_MAP[key]())
        .filter(p => p && p.mediaType === 'image');

    // Set context on providers that support it (e.g., YouTube for theme-aware queries)
    for (const p of videoProviders) {
        if (p.setContext) p.setContext(scriptContext);
    }

    // Log what's active
    console.log('  📦 Video providers:');
    if (videoProviders.length === 0) console.log('     (none enabled)');
    videoProviders.forEach(p => {
        const status = p.isAvailable() ? '✅' : '⚠️ (no API key)';
        console.log(`     ${status} ${p.name}`);
    });
    console.log('  📦 Image providers:');
    if (imageProviders.length === 0) console.log('     (none enabled)');
    imageProviders.forEach(p => {
        const status = p.isAvailable() ? '✅' : '⚠️ (no API key)';
        console.log(`     ${status} ${p.name}`);
    });

    // Log active search policy
    const nicheId = scriptContext?.nicheId;
    if (nicheId && nicheId !== 'general') {
        const policy = getSearchPolicy(nicheId);
        console.log(`  🔍 Search policy (${nicheId}):`);
        if (policy.contextTerms?.length) console.log(`     context: +${policy.contextTerms.join(', +')}`);
        if (policy.avoidTerms?.length) console.log(`     avoid: -${policy.avoidTerms.join(', -')}`);
        console.log(`     stock max words: ${policy.stockMaxWords || 3} | entity boost: ${policy.entityBoost ? 'on' : 'off'}`);
    }

    // Enable inline vision scoring
    enableInlineVision();

    // Pre-warm Storyblocks browser to absorb the Cloudflare cold-start cost
    // out-of-band, so the first real scene search doesn't time out.
    if (enabled.storyblocks) {
        try {
            const { prewarmStoryblocksBrowser } = require('./providers/storyblocks-video');
            // Fire-and-forget — runs in parallel with Director/Visual Planner.
            Promise.resolve(prewarmStoryblocksBrowser()).catch(() => {});
        } catch (_) {}
    }
}

// ============ PROVIDER KEY LOOKUP ============

// Reverse map: provider class → key string (for search policy rewriting)
const PROVIDER_CLASS_TO_KEY = new Map();
for (const [key, cls] of Object.entries(VIDEO_SOURCE_MAP)) PROVIDER_CLASS_TO_KEY.set(cls, key);
for (const [key, cls] of Object.entries(IMAGE_SOURCE_MAP)) PROVIDER_CLASS_TO_KEY.set(cls, key);

function getProviderKey(provider) {
    return PROVIDER_CLASS_TO_KEY.get(provider.constructor) || '';
}

// ============ KEYWORD VARIANTS ============

// Common visual synonyms for retry — maps generic terms to more searchable alternatives
const VISUAL_SYNONYMS = {
    'person': ['man', 'woman', 'people'], 'people': ['crowd', 'group', 'audience'],
    'building': ['architecture', 'skyscraper', 'structure'], 'house': ['home', 'residence', 'property'],
    'car': ['vehicle', 'automobile', 'driving'], 'money': ['currency', 'cash', 'finance'],
    'water': ['ocean', 'river', 'waves'], 'city': ['urban', 'downtown', 'skyline'],
    'road': ['highway', 'street', 'path'], 'forest': ['woods', 'trees', 'woodland'],
    'fight': ['conflict', 'battle', 'confrontation'], 'danger': ['risk', 'warning', 'emergency'],
    'police': ['law enforcement', 'officers', 'patrol'], 'crime': ['investigation', 'evidence', 'forensic'],
    'technology': ['digital', 'innovation', 'computing'], 'data': ['analytics', 'statistics', 'graph'],
    'meeting': ['conference', 'discussion', 'boardroom'], 'doctor': ['medical', 'hospital', 'healthcare'],
    'food': ['cuisine', 'cooking', 'restaurant'], 'night': ['dark', 'evening', 'nighttime'],
    'old': ['vintage', 'historic', 'ancient'], 'fast': ['speed', 'racing', 'rapid'],
    'explosion': ['blast', 'detonation', 'debris'], 'fire': ['flames', 'blaze', 'burning'],
    'storm': ['hurricane', 'thunderstorm', 'tempest'], 'mountain': ['peak', 'summit', 'highland'],
    'rich': ['luxury', 'wealth', 'affluent'], 'poor': ['poverty', 'deprived', 'struggling'],
};

/**
 * Generate keyword variants for retry with smarter strategies:
 * 1-4: Mechanical word dropping (original)
 * 5: Longest meaningful word
 * 6: Synonym substitution
 * 7: Broadest 2-word distillation
 */
function getKeywordVariants(keyword, scene = {}) {
    const smart = buildSearchKeywordVariants(keyword, scene, { max: 10 });
    if (smart.length > 0) return smart;

    const variants = [];
    const words = String(keyword || '').trim().split(/\s+/).filter(Boolean);

    if (words.length <= 1) return variants;

    // 1. Drop last word
    if (words.length >= 3) variants.push(words.slice(0, -1).join(' '));

    // 2. Drop first word
    if (words.length >= 3) variants.push(words.slice(1).join(' '));

    // 3. Keep only first 2 words
    if (words.length >= 3) variants.push(words.slice(0, 2).join(' '));

    // 4. (removed) "Last 2 words" produced orphan tail fragments like
    //   "shipping route Red Sea Suez Canal" → "Suez Canal" was useful but
    //   "Red Sea Suez Canal" already collapses to "Sea Canal"/"Canal" via
    //   the other variants, and tail slicing keyword="oil tanker shipping
    //   route Red" gave bare "route Red" which searches as noise.

    // 5. Single most meaningful word (longest = most specific)
    const sorted = [...words].sort((a, b) => b.length - a.length);
    if (!variants.includes(sorted[0])) variants.push(sorted[0]);

    // 6. Synonym substitution — swap first matchable word with a visual synonym
    const lowerWords = words.map(w => w.toLowerCase());
    for (let i = 0; i < lowerWords.length; i++) {
        const syns = VISUAL_SYNONYMS[lowerWords[i]];
        if (syns) {
            const synVariant = [...words];
            synVariant[i] = syns[0];
            const v = synVariant.slice(0, 3).join(' ');
            if (!variants.includes(v)) { variants.push(v); break; }
        }
    }

    // 7. Broadest 2-word distillation — the 2 longest non-stop words
    if (words.length >= 4) {
        const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were']);
        const meaningful = words.filter(w => !STOP.has(w.toLowerCase()) && w.length > 2);
        if (meaningful.length >= 2) {
            const broad = meaningful.sort((a, b) => b.length - a.length).slice(0, 2).join(' ');
            if (!variants.includes(broad)) variants.push(broad);
        }
    }

    return variants;
}

// ============ DIMENSION PROBING ============

const { execFileSync } = require('child_process');

/**
 * Detect dimensions of a media file using ffprobe (derived from ffmpeg-static).
 * Used as fallback when providers don't report width/height (YouTube, some web scrapers).
 */
function probeMediaDimensions(filePath) {
    try {
        let ffprobePath = 'ffprobe';
        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
                if (!fs.existsSync(ffprobePath)) ffprobePath = 'ffprobe';
            }
        } catch (e) { /* use system ffprobe */ }

        const result = execFileSync(ffprobePath, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'json', filePath
        ], { timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

        const data = JSON.parse(result.toString());
        const stream = data.streams?.[0];
        if (stream && stream.width && stream.height) {
            return { width: stream.width, height: stream.height };
        }
    } catch (e) { /* ffprobe not available or failed */ }
    return null;
}

// ============ KEYWORD VALIDATION ============

/**
 * Clean visual subject from a scene's own structured anchors — planner visual
 * fields, then the scene's entities, then the video topic. NEVER narration prose.
 * This replaces the old "3 longest words from scene.text" fallback, which produced
 * fragment garbage ("supposed scenario economy", "disrupted supposed Because").
 * Fully data-driven (no niche/keyword hardcoding).
 */
function _cleanSubjectFromAnchors(scene = {}, scriptContext = {}) {
    const direct = String(
        scene?.searchKeyword || scene?.stockQuery || scene?.webQuery
        || scene?.bgQuery || scene?.templateBgQuery || scene?.visualIntent || ''
    ).trim();
    if (direct) return direct.split(/\s+/).slice(0, 7).join(' ');
    const plan = scene?._sceneEntityPlan || {};
    const ents = [
        ...(Array.isArray(plan.requiredEntities) ? plan.requiredEntities : []),
        ...(Array.isArray(plan.visibleEntities) ? plan.visibleEntities : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
    ].map(s => String(s || '').trim()).filter(Boolean);
    const topic = String(scriptContext?.topic || scriptContext?.title || scriptContext?.videoTitle || '').trim();
    const merged = [[...new Set(ents)].slice(0, 3).join(' '), topic].filter(Boolean).join(' ').trim();
    return merged ? merged.split(/\s+/).slice(0, 7).join(' ') : '';
}

/**
 * Validate and fix AI-generated keywords before searching.
 * Catches common AI mistakes that waste API calls.
 */
function validateKeyword(keyword, scene, scriptContext = {}) {
    if (!keyword || typeof keyword !== 'string') {
        // No keyword: derive from the scene's OWN anchors (entities + topic),
        // never from narration prose. _extractFromText only as absolute last resort.
        return _cleanSubjectFromAnchors(scene, scriptContext) || _extractFromText(scene?.text || '');
    }

    let kw = keyword.trim();

    // Strip quotes the AI might wrap around the keyword
    kw = kw.replace(/^["']|["']$/g, '').trim();

    // Strip common AI prefixes/suffixes
    kw = kw.replace(/^(keyword:|search:|query:|find:|look for:)\s*/i, '').trim();

    // Strip markdown formatting
    kw = kw.replace(/\*\*/g, '').replace(/\*/g, '').trim();

    // Reject if too short (single char or empty)
    if (kw.length < 3) {
        console.log(`  ⚠️ Keyword too short ("${kw}"), deriving from scene anchors`);
        return _cleanSubjectFromAnchors(scene, scriptContext) || _extractFromText(scene?.text || '') || kw;
    }

    // Reject if too long (AI sometimes dumps entire sentences)
    if (kw.split(/\s+/).length > 10) {
        console.log(`  ⚠️ Keyword too long (${kw.split(/\s+/).length} words), truncating`);
        // Keep the most meaningful 5 words
        const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'that', 'this', 'it']);
        const words = kw.split(/\s+/).filter(w => !STOP.has(w.toLowerCase()));
        kw = words.slice(0, 5).join(' ');
    }

    // Reject if it's just a description instead of a search term
    const DESCRIPTION_PATTERNS = [
        /^(a|an|the)\s+(scene|shot|clip|view|image|video)\s+(of|showing|depicting|featuring)/i,
        /^(close-?up|wide|aerial|overhead)\s+(shot|view|angle)\s+(of|showing)/i,
    ];
    for (const pattern of DESCRIPTION_PATTERNS) {
        if (pattern.test(kw)) {
            // Strip the description prefix, keep the subject
            kw = kw.replace(pattern, '').trim();
            if (kw.length < 3) kw = keyword.trim();
        }
    }

    const displayRepair = repairDisplaySearchQuery(kw, scene, scriptContext, {
        maxWords: String(scene?.mediaType || '').toLowerCase() === 'image' ? 8 : 6,
    });
    if (displayRepair.changed) {
        console.log(`  Search keyword repair: "${displayRepair.before}" -> "${displayRepair.after}" (${displayRepair.reason})`);
        kw = displayRepair.after;
    }

    return kw;
}

/**
 * Extract a searchable keyword from scene text as last resort.
 */
function _extractFromText(text) {
    if (!text) return 'abstract background';
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'that', 'this', 'it', 'but', 'not', 'so', 'if', 'be', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may']);
    // Strip punctuation BEFORE splitting — naive split keeps "scenario," "disrupted." attached
    // and providers see literal commas/periods in their search query (junk results).
    const cleaned = text.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = cleaned.split(/\s+/).filter(w => w.length > 3 && !STOP.has(w.toLowerCase()));
    // Take 2-4 of the longest words (most likely to be nouns/subjects)
    const sorted = words.sort((a, b) => b.length - a.length);
    return sorted.slice(0, 3).join(' ') || cleaned.split(/\s+/).slice(0, 3).join(' ') || 'abstract background';
}

const QUERY_STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
    'is', 'are', 'was', 'were', 'that', 'this', 'it', 'as', 'be', 'been', 'being', 'into',
    'near', 'around', 'about', 'after', 'before', 'during', 'while', 'view', 'shot', 'scene',
    'video', 'clip', 'footage', 'image', 'photo', 'real', 'actual', 'showing', 'featuring',
]);
const STORY_ONLY_PROTECTED_WORDS = new Set([
    'news', 'breaking', 'live', 'report', 'reports', 'update', 'updates',
    'analysis', 'explained', 'global', 'trade', 'economy', 'economic',
    'disruption', 'disruptions', 'security', 'efficiency', 'efficient',
    'backup', 'risk', 'risks', 'threat', 'threats', 'pressure',
    'problem', 'problems', 'issue', 'issues', 'impact', 'impacts',
    'reason', 'reasons', 'flow', 'flows', 'moving', 'keeps', 'keep',
    'critical', 'important',
    'system', 'systems', 'scenario', 'worst', 'case', 'matter', 'matters',
    'defines', 'define', 'assumption', 'unstable', 'instability', 'time',
    'supply', 'chain', 'chains', 'plan', 'plans', 'cost', 'costs',
    'save', 'saving', 'understand', 'understanding',
    'alternative', 'alternatives', 'backup', 'instability', 'decline',
    'declines', 'significance', 'overview', 'geopolitical',
]);
// Generic, cross-niche editorial filler — non-visual prose that should be stripped from
// search queries regardless of topic. (Single-video shipping/geopolitics remnants like
// "global maritime trade" / "bab el-mandeb" were removed — they were hardcoded vocabulary
// from one old video, inert and embarrassing on every other niche.)
const STORY_SEARCH_PHRASE_RE = /\b(worst case|best case|save time|just save time|backup plan|breaking news|the bottom line|key takeaway)\b/gi;
const VISUAL_SEARCH_TERM_RE = /\b(ship|ships|shipping|vessel|vessels|cargo|container|containers|tanker|tankers|port|ports|harbor|harbour|crane|cranes|sea|ocean|strait|canal|lane|lanes|route|routes|chokepoint|choke point|corridor|aerial|drone|factory|warehouse|refinery|pipeline|truck|train|road|street|city|crowd|protest|soldier|military|missile|fire|flood|hospital|doctor|kitchen|stadium|athlete|screen|device|server|lab)\b/i;
// Title-only strict-raw blocking is disabled. Titles are useful for ranking and
// logging, but not reliable enough to veto candidate footage before vision.

function _queryTokens(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^-+|-+$/g, '').trim())
        .filter(t => t.length > 2 && !QUERY_STOP_WORDS.has(t));
}

function _isVisualSearchProtectedTerm(term) {
    const text = String(term || '').trim();
    if (!text) return false;
    if (VISUAL_SEARCH_TERM_RE.test(text)) return true;

    const tokens = _queryTokens(text);
    if (tokens.length === 0) return false;
    return !tokens.every(t => STORY_ONLY_PROTECTED_WORDS.has(t));
}

function _stripStorySearchTermNoise(term) {
    return String(term || '')
        .replace(STORY_SEARCH_PHRASE_RE, ' ')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .filter(word => {
            const key = word.toLowerCase().replace(/^-+|-+$/g, '');
            return key && !QUERY_STOP_WORDS.has(key) && !STORY_ONLY_PROTECTED_WORDS.has(key);
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _normalizeVisualSearchProtectedTerm(term) {
    const text = String(term || '').trim();
    if (!text || !_isVisualSearchProtectedTerm(text)) return '';
    const stripped = _stripStorySearchTermNoise(text);
    if (!stripped && new RegExp(STORY_SEARCH_PHRASE_RE.source, 'i').test(text)) return '';
    return stripped && _isVisualSearchProtectedTerm(stripped) ? stripped : text;
}

function _sceneProtectedTerms(scene, opts = {}) {
    if (!scene) return [];
    const agent = scene?._mediaAgentPlan || null;
    if (agent?.enabled) {
        const sceneEntities = agent.sceneEntities || scene?._sceneEntityPlan || {};
        const required = [
            ...(Array.isArray(sceneEntities.requiredEntities) ? sceneEntities.requiredEntities : []),
            ...(Array.isArray(sceneEntities.visibleEntities) ? sceneEntities.visibleEntities : []),
            ...(Array.isArray(agent.mandatoryIdentity) ? agent.mandatoryIdentity : []),
            ...(Array.isArray(agent.mandatoryVisible) ? agent.mandatoryVisible : []),
        ];
        return Array.from(new Set(required.map(t => String(t || '').trim()).filter(Boolean))).slice(0, 5);
    }
    const seen = new Set();
    let terms = [
        ...(Array.isArray(scene.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scene.protectedTerms) ? scene.protectedTerms : []),
    ]
        .map(t => String(t || '').trim())
        .filter(t => t && !/^none$/i.test(t))
        .filter(t => {
            const key = t.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

    if (opts.searchGuard && scene?._mediaHunterProfile?.strictRaw) {
        const visualSeen = new Set();
        const visualTerms = terms
            .map(_normalizeVisualSearchProtectedTerm)
            .filter(Boolean)
            .filter(term => {
                const key = term.toLowerCase();
                if (visualSeen.has(key)) return false;
                visualSeen.add(key);
                return true;
            });
        if (visualTerms.length !== terms.length || visualTerms.some((term, index) => term !== terms[index])) {
            const kept = new Set(visualTerms.map(t => t.toLowerCase()));
            const skipped = terms.filter(t => !kept.has(t.toLowerCase()));
            const logKey = `protected:${skipped.join('|')}`;
            if (skipped.length && scene._searchGuardSkippedTermsKey !== logKey) {
                scene._searchGuardSkippedTermsKey = logKey;
                console.log(`  Search guard: ignored story-only protected term(s) for raw footage: ${skipped.join(', ')}`);
            }
        }
        terms = visualTerms;
    }

    return terms.slice(0, 5);
}

function _sceneEntityContext(scene, scriptContext = {}) {
    const agent = scene?._mediaAgentPlan || null;
    if (agent?.enabled) {
        const sceneEntities = agent.sceneEntities || scene?._sceneEntityPlan || {};
        return Array.from(new Set([
            ...(Array.isArray(sceneEntities.requiredEntities) ? sceneEntities.requiredEntities : []),
            ...(Array.isArray(sceneEntities.visibleEntities) ? sceneEntities.visibleEntities : []),
            ...(Array.isArray(sceneEntities.contextualEntities) ? sceneEntities.contextualEntities : []),
            ...(Array.isArray(agent.mandatoryIdentity) ? agent.mandatoryIdentity : []),
            ...(Array.isArray(agent.mandatoryVisible) ? agent.mandatoryVisible : []),
        ].map(t => String(t || '').trim()).filter(Boolean))).slice(0, 12);
    }
    return normalizeEntityContext(scene, scriptContext).slice(0, 12);
}

function _protectedCoverage(query, protectedTerms) {
    const tokens = new Set(_queryTokens(query));
    const missing = [];
    const covered = [];

    for (const term of protectedTerms) {
        const termTokens = _queryTokens(term);
        if (termTokens.length === 0) continue;
        const strongTokens = termTokens.filter(t => t.length > 3);
        const required = strongTokens.length > 0 ? strongTokens : termTokens;
        const hits = required.filter(t => tokens.has(t));
        const isCovered = required.length > 1 ? hits.length === required.length : hits.length > 0;
        if (isCovered) covered.push(term);
        else missing.push(term);
    }

    return { covered, missing };
}

function _compactQueryWords(query, maxWords = 9) {
    const words = String(query || '').replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);

    const out = [];
    const seen = new Set();
    for (const w of words) {
        const key = w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(w);
        if (out.length >= maxWords) break;
    }
    return out.join(' ');
}

function _appendMissingProtectedTerms(baseQuery, protectedTerms) {
    let query = String(baseQuery || '').trim();
    const prefix = [];
    for (const term of protectedTerms) {
        const termTokens = _queryTokens(term);
        const queryTokens = new Set(_queryTokens(query));
        const strongTokens = termTokens.filter(t => t.length > 3);
        const required = strongTokens.length > 0 ? strongTokens : termTokens;
        const hits = required.filter(t => queryTokens.has(t));
        const alreadyCovered = required.length > 1 ? hits.length === required.length : hits.length > 0;
        if (!alreadyCovered) prefix.push(term);
    }
    return _compactQueryWords(`${prefix.join(' ')} ${query}`.trim(), 9);
}

function _guardProviderQuery(baseQuery, keyword, scene, providerKey) {
    // Protected/entity terms are scoring context, not search terms. Keep provider
    // queries short; title sanity, result ranking, and clip analysis still receive
    // entityContext/protectedTerms to judge relevance after search.
    return baseQuery;
}

function _resultAnchorText(result) {
    return [
        result?.title,
        result?.description,
        result?._cachedMeta?.title,
        result?._meta?.title,
        result?.url,
    ].filter(Boolean).join(' ');
}

function _scoreResultAgainstProtectedTerms(result, protectedTerms) {
    if (!protectedTerms.length) return 0;
    const text = _resultAnchorText(result).toLowerCase();
    const textTokens = new Set(_queryTokens(text));
    let score = 0;

    for (const term of protectedTerms) {
        const termLower = term.toLowerCase();
        const termTokens = _queryTokens(term);
        if (termTokens.length === 0) continue;
        if (text.includes(termLower)) {
            score += 4;
            continue;
        }
        const hits = termTokens.filter(t => textTokens.has(t)).length;
        if (hits > 0) score += hits;
    }

    return score;
}

/**
 * Re-apply the small-image reserve tail AFTER every title-based ranker has run.
 *
 * Size is a RANKING, never a reject: a sub-1280x720 photo is kept so a scene can
 * never end up empty, but it must lose to any full-size photo that exists.
 * filterResults() expresses that by appending the small ones with _undersized,
 * and then _rankResultsByProtectedTerms / rankResultsForHunter each re-sort the
 * whole array on their own title score — which puts a keyword-rich 640x427 back
 * ahead of a plain-titled 1920x1280. This is a stable partition, so the rankers'
 * work is fully preserved WITHIN each group; only the big-beats-small split is
 * restored on top. No-op unless the list actually mixes both.
 */
function _reserveUndersizedTail(results, providerName) {
    if (!Array.isArray(results) || results.length < 2) return results;
    const big = [];
    const small = [];
    for (const r of results) (r && r._undersized ? small : big).push(r);
    if (!small.length || !big.length) return results;
    console.log(`  📐 [${providerName}] ${small.length} under-size image(s) held behind ${big.length} full-size one(s)`);
    return big.concat(small);
}

function _rankResultsByProtectedTerms(results, scene, providerName) {
    const protectedTerms = _sceneProtectedTerms(scene, { searchGuard: true });
    if (!protectedTerms.length || results.length < 2) return results;

    const ranked = results.map((result, index) => ({
        result,
        index,
        score: _scoreResultAgainstProtectedTerms(result, protectedTerms),
    }));
    const useful = ranked.filter(r => r.score > 0).length;
    if (useful < 2) return results;

    ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const moved = ranked.some((r, idx) => r.index !== idx);
    if (moved) {
        const top = ranked[0];
        const title = String(top.result.title || top.result.url || '').replace(/\s+/g, ' ').slice(0, 80);
        console.log(`  Result guard: [${providerName}] ranked protected-term matches first (${top.score} pts): ${title}`);
    }
    return ranked.map(r => r.result);
}

function _sceneMapTitleContext(scene, hunterProfile, opts = {}) {
    return {
        sourceProvider: opts.providerName || opts.providerKey || '',
        keyword: opts.query || scene?.searchKeyword || scene?.researchKeyword || scene?.keyword || hunterProfile?.keyword || '',
        sceneText: [
            scene?.text,
            scene?.visualIntent,
            scene?.webQuery,
            scene?.stockQuery,
            ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
            ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ].filter(Boolean).join(' '),
        videoTopic: opts.videoTopic || '',
        entities: Array.isArray(scene?.entityContext) ? scene.entityContext : [],
        mediaHunter: hunterProfile || {},
    };
}

// True when the candidate is a topic-accurate map from premium stock (title
// mentions the scene's geography). Such URLs are valid map assets for
// map-needing scenes downstream — even when a non-map scene rejects them for
// "not real footage", we must NOT globally blacklist them, or later map
// scenes will starve. Falls back to URL slug pattern for cases where the
// title field is missing.
function _isCandidateTopicAccurateMap(selected, scene, hunterProfile, opts = {}) {
    if (!selected) return false;
    const title = String(selected?.title || selected?._cachedMeta?.title || selected?._meta?.title || '').trim();
    const url = String(selected?.url || '');
    const context = _sceneMapTitleContext(scene, hunterProfile, opts);
    if (title && isTopicAccurateMapFromPremiumStock(title, context)) return true;
    // URL slug fallback: storyblocks topic-map URLs encode the place name in
    // the path (e.g. /zoom-in-to-the-map-of-bab-al-mandab-strait...).
    if (url && /\/(?:zoom-in-to-the-map-of|map-of-|map-animation|locator-map)/i.test(url)) {
        return isTopicAccurateMapFromPremiumStock(url.replace(/[-_/]/g, ' '), context);
    }
    return false;
}

// Niche-agnostic "is this scene about geography?" — true when any Director
// place-tagged entity (person|place|org|event taxonomy in
// scriptContextRef.entityTypes) is actually referenced by THIS scene. No topic
// word list, so it works for any niche: a history battlefield, a nature region,
// a war chokepoint all light up the same way.
function _sceneHasGeographicContext(scene) {
    const types = scriptContextRef?.entityTypes || {};
    const places = Object.keys(types).filter(k => String(types[k] || '').toLowerCase() === 'place');
    if (places.length === 0) return false;
    const blob = [
        scene?.text, scene?.keyword, scene?.searchKeyword, scene?.researchKeyword,
        scene?.webQuery, scene?.visualIntent, scene?.templateBgQuery,
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
    ].filter(Boolean).join(' ').toLowerCase();
    if (!blob) return false;
    return places.some(p => p && blob.includes(p));
}

// Loose detector for a map/geographic-graphic candidate (title, url slug, or the
// thumbnail-vision reject reason that flagged it as a map). Pairs with
// _sceneHasGeographicContext so a regionally-relevant map that doesn't echo the
// exact place-name in its title still survives the vision-stage cut and is
// judged on its actual content by the vision SCORE (wrong-region maps lose
// there). Mirrors the scout-stage softening in media-scout.js.
function _looksLikeMapCandidate(selected, rejectReason = '') {
    const text = [
        selected?.title, selected?._cachedMeta?.title, selected?._meta?.title,
        selected?.url, rejectReason,
    ].filter(Boolean).join(' ').toLowerCase();
    return /\b(map|maps|locator|satellite|globe|route map|geographic)\b/.test(text)
        || /\/(?:zoom-in-to-the-map-of|map-of-|map-animation|locator-map)/i.test(String(selected?.url || ''));
}

function _filterResultsByHunterTitle(results, hunterProfile, providerName, scene, mediaType, providerKey, query) {
    return Array.isArray(results) ? results : [];
}

function _shouldTryControlledStockVideoFallback(scene, mediaType) {
    const profile = scene?._mediaHunterProfile;
    if (mediaType !== 'video') return false;
    if (!profile?.strictRaw || profile.allowGraphics) return false;
    if (profile.domain === 'event' || profile.domain === 'history') return false;

    return videoProviders.some(provider => {
        const key = getProviderKey(provider);
        return STOCK_VIDEO_PROVIDER_KEYS.has(key) && provider.isAvailable();
    });
}

function _providerSearchTimeoutMs(providerKey) {
    const scale = LOW_BANDWIDTH_MODE ? 1.5 : 1;
    if (providerKey === 'youtube') return Math.round(45_000 * scale);
    // Reddit runs UI scrape (hard-capped 25s) then search.json fallback (~30s).
    if (providerKey === 'reddit') return Math.round(60_000 * scale);
    if (STOCK_VIDEO_PROVIDER_KEYS.has(providerKey)) return Math.round(35_000 * scale);
    // Storyblocks subscribed mode opens up to 6 clip pages sequentially
    // (~12s each) to capture clean download URLs. Anonymous preview mode
    // only scrapes the search page → much faster. Give subscribed mode
    // a 120s budget; preview mode keeps the 35s default.
    if (providerKey === 'storyblocks') {
        return Math.round((process.env.STORYBLOCKS_SUBSCRIBED === '1' ? 120_000 : 35_000) * scale);
    }
    return Math.round(35_000 * scale);
}

function _previewScoutCacheKey(result, keyword, sceneDuration) {
    // Preserve the full URL incl. query params. YouTube identifies videos via
    // ?v=ID, so split('?')[0] would collapse every YouTube candidate to
    // https://www.youtube.com/watch and one rejection would poison the cache
    // for every later YouTube clip on the same scene shape.
    const url = result?._directVideoUrl
        || result?._fallbackUrl
        || result?._cachedMeta?._fallbackUrl
        || result?.url
        || '';
    if (!url) return '';
    const baseUrl = String(url).trim();
    const kw = String(keyword || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 90);
    const dur = Math.max(1, Math.round(Number(sceneDuration || 0)));
    return `${baseUrl}|${kw}|${dur}`;
}

function _canonicalSourceUrl(result) {
    // Preserve query params (YouTube ?v=ID) — canonical URL is the stable identifier across scenes
    const u = result?.url || result?._cachedMeta?.url || result?._directVideoUrl || result?._fallbackUrl || '';
    return u ? String(u).trim() : '';
}

async function _previewScoutResults(results, opts = {}) {
    const {
        provider,
        providerKey,
        keyword,
        scene,
        sceneDuration,
        nicheId,
        hunterProfile,
        scriptContext,
        hasSceneBudget,
        reserveSceneOmni,
        maxCandidates,
        allowOmniReserve = false,
        priorityChannel = false,
    } = opts;

    if (!Array.isArray(results) || results.length === 0) {
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }
    if (PREVIEW_SCOUT_MAX_CANDIDATES <= 0 || ONE_VISION_LAYER) {
        // ONE_VISION_LAYER: skip the pre-download vision scan entirely — the post-download
        // merged score is the single verdict. Pass results through untouched.
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }
    if (!hunterProfile?.strictRaw || hunterProfile.allowGraphics) {
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }
    if (!PREVIEW_SCOUT_PROVIDER_KEYS.has(providerKey)) {
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }
    // Scout Lab uses the same preview-scout gate as the real build so single
    // scene tests expose provider/candidate choice problems before download.
    if (clipAnalyzer.hasOmniBudget && !clipAnalyzer.hasOmniBudget(PREVIEW_SCOUT_FRAMES, { allowReserve: allowOmniReserve })) {
        const info = clipAnalyzer.getFramesBudgetInfo ? clipAnalyzer.getFramesBudgetInfo({ allowReserve: allowOmniReserve }) : 'budget unavailable';
        console.log(`  Media Preview Scout (pre-download): skipped (Omni budget protected: ${info})`);
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }
    if (!clipAnalyzer.hasOmniBudget && !clipAnalyzer.isAvailable({ allowReserve: allowOmniReserve, framesNeeded: PREVIEW_SCOUT_FRAMES })) {
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }
    if (hasSceneBudget && !hasSceneBudget(PREVIEW_SCOUT_MIN_BUDGET_MS, `${provider?.name || providerKey} preview scout`)) {
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }

    const limit = Number.isFinite(Number(maxCandidates))
        ? Math.max(0, Math.min(PREVIEW_SCOUT_MAX_CANDIDATES, Number(maxCandidates)))
        : PREVIEW_SCOUT_MAX_CANDIDATES;
    if (limit <= 0) {
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: 0, log: '' };
    }
    const head = results.slice(0, limit);
    const tail = results.slice(limit);
    const accepted = [];
    const rejected = [];
    const skipped = [];
    let windowRejected = 0;
    const previewHunterProfile = hunterProfile
        ? {
            ...hunterProfile,
            segment: {
                ...(hunterProfile.segment || {}),
                omniFrames: PREVIEW_SCOUT_FRAMES,
            },
        }
        : hunterProfile;

    for (let i = 0; i < head.length; i++) {
        const result = head[i];
        const title = _short(result.title || result._cachedMeta?.title || result.url || `candidate ${i + 1}`, 90);
        const totalDuration = Number(result._cachedMeta?.duration || result._meta?.duration || result.duration || 0);
        const cacheKey = _previewScoutCacheKey(result, keyword, sceneDuration);
        const canonicalUrl = _canonicalSourceUrl(result);
        const canonicalUrlKey = canonicalUrl ? normalizeUrlForDedup(canonicalUrl) : '';
        const globalReject = canonicalUrl ? (_previewScoutRejectedUrls.get(canonicalUrlKey) || _previewScoutRejectedUrls.get(canonicalUrl)) : null;
        if (globalReject) {
            rejected.push({
                result,
                reason: globalReject.reason || 'previously rejected this build',
                title,
            });
            console.log(`  Media Preview Scout (pre-download): URL already rejected this build for "${title}" (${_short(globalReject.reason || 'rejected', 80)})`);
            continue;
        }
        const cached = cacheKey ? _previewScoutSegmentCache.get(cacheKey) : null;

        if (cached) {
            if (cached.status === 'accepted') {
                accepted.push({
                    ...result,
                    ...cached.fields,
                });
                console.log(`  Media Preview Scout (pre-download): reused cached clean segment for "${title}" at ${Math.round(cached.fields?._smartStartTime || 0)}s`);
            } else {
                rejected.push({
                    result,
                    reason: cached.reason || 'cached preview rejection',
                    title,
                });
                console.log(`  Media Preview Scout (pre-download): reused cached rejection for "${title}" (${_short(cached.reason || 'rejected', 80)})`);
            }
            continue;
        }

        if (!Number.isFinite(totalDuration) || totalDuration < PREVIEW_SCOUT_MIN_DURATION) {
            skipped.push(result);
            continue;
        }
        if (hasSceneBudget && !hasSceneBudget(PREVIEW_SCOUT_MIN_BUDGET_MS, `${provider?.name || providerKey} preview scout candidate ${i + 1}`)) {
            skipped.push(...head.slice(i));
            break;
        }
        let segmentFrameNeed = _segmentScanFrameNeed(
            totalDuration,
            { mediaAgent: scene?._mediaAgentPlan || null, mediaHunter: previewHunterProfile, fromPreviewScout: true },
            scene,
            { allowOmniReserve, reserveWindowFrames: PREVIEW_SCOUT_WINDOW_VALIDATION }
        );
        if (segmentFrameNeed < 3 && _tryGrantSceneOmni(scene, { allowOmniReserve })) {
            segmentFrameNeed = _segmentScanFrameNeed(
                totalDuration,
                { mediaAgent: scene?._mediaAgentPlan || null, mediaHunter: previewHunterProfile, fromPreviewScout: true },
                scene,
                { allowOmniReserve, reserveWindowFrames: PREVIEW_SCOUT_WINDOW_VALIDATION }
            );
        }
        if (segmentFrameNeed < 3) {
            console.log(`  Media Preview Scout (pre-download): stopping before "${title}" (scene Omni cap must keep room for exact-window validation)`);
            skipped.push(...head.slice(i));
            break;
        }
        if (clipAnalyzer.hasOmniBudget && !clipAnalyzer.hasOmniBudget(segmentFrameNeed, { allowReserve: allowOmniReserve })) {
            const info = clipAnalyzer.getFramesBudgetInfo ? clipAnalyzer.getFramesBudgetInfo({ allowReserve: allowOmniReserve }) : 'budget unavailable';
            console.log(`  Media Preview Scout (pre-download): stopping before "${title}" (needs ${segmentFrameNeed} Omni frames; ${info})`);
            skipped.push(...head.slice(i));
            break;
        }

        let segUrl = result._directVideoUrl || result._fallbackUrl || result._cachedMeta?._fallbackUrl || null;
        try {
            if (!segUrl && provider?.getStreamUrl) {
                console.log(`  Media Preview Scout (pre-download): resolving stream for "${title}"...`);
                try {
                    segUrl = await provider.getStreamUrl(result.url);
                } catch (streamErr) {
                    // Preview Scout uses a narrow "worst progressive" format selector
                    // to find a seekable URL for vision frame sampling. The actual
                    // download uses a broader selector (bestvideo+bestaudio/best),
                    // so a probe failure here doesn't mean the candidate is dead —
                    // skip Preview Scout for this one and let the download attempt
                    // run normally. Do NOT mark structurally rejected.
                    console.log(`  Media Preview Scout (pre-download): stream-URL probe failed for "${title}" (${_short(streamErr.message, 100)}); deferring to download attempt`);
                    skipped.push(result);
                    continue;
                }
            }
            if (!segUrl) {
                skipped.push(result);
                continue;
            }
            if (reserveSceneOmni && !reserveSceneOmni(segmentFrameNeed, `${provider?.name || providerKey} preview scout candidate ${i + 1}`)) {
                skipped.push(result);
                skipped.push(...head.slice(i + 1));
                break;
            }

            console.log(`  Media Preview Scout (pre-download): candidate ${i + 1}/${head.length} [${provider?.name || providerKey}] "${title}" (${segmentFrameNeed} Omni scan frames)`);
            console.log(`  Media Preview Scout (pre-download): inspecting "${title}" (${Math.round(totalDuration)}s)`);
            const segResult = await clipAnalyzer.findBestSegment(
                segUrl,
                totalDuration,
                sceneDuration,
                keyword,
                {
                    sceneText: scene?.text || '',
                    niche: nicheId || '',
                    videoTopic: scriptContext?.summary || '',
                    theme: scriptContext?.themeId || scriptContext?.theme || '',
                    tone: scriptContext?.tone || '',
                    mood: scriptContext?.mood || '',
                    entities: scriptContext?.entities || [],
                    mediaAgent: scene?._mediaAgentPlan || null,
                    mediaHunter: previewHunterProfile,
                    fromPreviewScout: true,
                    maxSegmentFrames: segmentFrameNeed,
                    allowOmniReserve,
                    priorityChannel,
                }
            );

            if (segResult && Number.isFinite(Number(segResult.startTime))) {
                let windowValidation = null;
                if (PREVIEW_SCOUT_WINDOW_VALIDATION && clipAnalyzer.validateSegmentWindow) {
                    const windowFrameNeed = _segmentWindowFrameNeed();
                    const segmentConfidence = Number(segResult.confidence || 0);
                    let skipWindowReason = '';
                    if (hasSceneBudget && !hasSceneBudget(PREVIEW_SCOUT_WINDOW_MIN_BUDGET_MS, `${provider?.name || providerKey} preview scout exact window candidate ${i + 1}`)) {
                        skipWindowReason = 'scene deadline';
                    } else if (reserveSceneOmni && !reserveSceneOmni(windowFrameNeed, `${provider?.name || providerKey} preview scout exact window candidate ${i + 1}`)) {
                        skipWindowReason = 'scene Omni cap';
                    } else if (clipAnalyzer.hasOmniBudget && !clipAnalyzer.hasOmniBudget(windowFrameNeed, { allowReserve: allowOmniReserve })) {
                        const info = clipAnalyzer.getFramesBudgetInfo ? clipAnalyzer.getFramesBudgetInfo({ allowReserve: allowOmniReserve }) : 'budget unavailable';
                        skipWindowReason = `global Omni budget protected: ${info}`;
                    }
                    if (skipWindowReason) {
                        if (segmentConfidence >= STRICT_RAW_SEGMENT_DEADLINE_ACCEPT_CONFIDENCE) {
                            windowValidation = {
                                ok: true,
                                skipped: true,
                                score: 0,
                                reason: skipWindowReason,
                            };
                            console.log(`  Media Preview Scout (pre-download): exact window skipped for "${title}" (${skipWindowReason}); allowing high-confidence segment (${segmentConfidence.toFixed(2)}) to final vision`);
                        } else {
                            skipped.push(result);
                            console.log(`  Media Preview Scout (pre-download): deferred "${title}" at ${Math.round(segResult.startTime)}s (${skipWindowReason}; confidence ${segmentConfidence.toFixed(2)})`);
                            continue;
                        }
                    }

                    if (!windowValidation) {
                        windowValidation = await clipAnalyzer.validateSegmentWindow(
                            segUrl,
                            totalDuration,
                            Number(segResult.startTime),
                            sceneDuration,
                            keyword,
                            {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: scriptContext?.summary || '',
                                theme: scriptContext?.themeId || scriptContext?.theme || '',
                                tone: scriptContext?.tone || '',
                                mood: scriptContext?.mood || '',
                                entities: scriptContext?.entities || [],
                                mediaAgent: scene?._mediaAgentPlan || null,
                                mediaHunter: previewHunterProfile,
                                sourceTitle: title,
                                sourceUrl: result?.url || result?._cachedMeta?.url || result?._directVideoUrl || '',
                                sourceProvider: provider?.name || '',
                                allowOmniReserve,
                                priorityChannel,
                            }
                        );
                    }

                    if (!windowValidation || !windowValidation.ok) {
                        windowRejected++;
                        const reason = windowValidation?.reason || 'exact window did not validate';
                        rejected.push({
                            result,
                            reason: `exact-window rejected: ${reason}`,
                            title,
                        });
                        if (cacheKey) {
                            _previewScoutSegmentCache.set(cacheKey, {
                                status: 'rejected',
                                reason: `exact-window rejected: ${reason}`,
                            });
                        }
                        if (canonicalUrlKey) {
                            _previewScoutRejectedUrls.set(canonicalUrlKey, {
                                reason: `exact-window rejected: ${_short(reason, 120)}`,
                            });
                        }
                        _rememberSceneRejectedResult(scene, result, `exact-window rejected: ${_short(reason, 120)}`);
                        console.log(`  Media Preview Scout (pre-download): rejected "${title}" at ${Math.round(segResult.startTime)}s (exact window failed: ${_short(reason, 90)})`);
                        continue;
                    }

                    if (windowValidation.skipped) {
                        console.log(`  Media Preview Scout (pre-download): exact window deferred for "${title}" at ${Math.round(segResult.startTime)}s (${windowValidation.reason})`);
                    } else {
                        console.log(`  Media Preview Scout (pre-download): exact window passed for "${title}" at ${Math.round(segResult.startTime)}s (${windowValidation.score || '?'} / 10)`);
                    }
                }

                const acceptedResult = {
                    ...result,
                    _smartStartTime: Number(segResult.startTime),
                    _previewScoutSegment: segResult,
                    _previewScoutScore: Number(segResult.confidence || 0.75),
                    _previewScoutReason: segResult.reason || 'preview-approved segment',
                    _previewScoutWindowValidation: windowValidation,
                };
                accepted.push(acceptedResult);
                if (cacheKey) {
                    _previewScoutSegmentCache.set(cacheKey, {
                        status: 'accepted',
                        fields: {
                            _smartStartTime: acceptedResult._smartStartTime,
                            _previewScoutSegment: acceptedResult._previewScoutSegment,
                            _previewScoutScore: acceptedResult._previewScoutScore,
                            _previewScoutReason: acceptedResult._previewScoutReason,
                            _previewScoutWindowValidation: acceptedResult._previewScoutWindowValidation,
                        },
                    });
                }
                console.log(`  Media Preview Scout (pre-download): accepted "${title}" at ${Math.round(segResult.startTime)}s (${segResult.reason || 'clean segment'})`);
            } else {
                rejected.push({
                    result,
                    reason: 'no clean preview segment',
                    title,
                });
                if (cacheKey) {
                    _previewScoutSegmentCache.set(cacheKey, {
                        status: 'rejected',
                        reason: 'no clean preview segment',
                    });
                }
                if (canonicalUrlKey) {
                    _previewScoutRejectedUrls.set(canonicalUrlKey, {
                        reason: 'no clean preview segment',
                    });
                }
                _rememberSceneRejectedResult(scene, result, 'no clean preview segment');
                console.log(`  Media Preview Scout (pre-download): rejected "${title}" (no clean preview segment)`);
            }
        } catch (err) {
            console.log(`  Media Preview Scout (pre-download): skipped "${title}" (${err.message})`);
            if (_isPermanentMediaFailure(err)) {
                _rememberStructuralRejectedResult(result, err.message, {
                    providerKey,
                    permanent: true,
                });
            } else if (_isTimeoutMediaFailure(err)) {
                _rememberStructuralRejectedResult(result, `timeout: ${err.message}`, {
                    providerKey,
                    strike: true,
                });
            }
            skipped.push(result);
        }
    }

    const inspected = accepted.length + rejected.length;
    if (inspected === 0) {
        return { results, inspected: 0, accepted: 0, rejected: 0, skipped: skipped.length, log: '' };
    }

    let finalResults;
    let policyNote;
    if (accepted.length > 0) {
        // Preview-approved candidates are the quality gate. By default, do not
        // spend scene budget on uninspected tail results after Omni already
        // found clean raw footage. Set MEDIA_PREVIEW_SCOUT_APPROVED_ONLY=0 to
        // keep the older fallback behavior for experiments.
        finalResults = PREVIEW_SCOUT_APPROVED_ONLY ? accepted : [...accepted, ...skipped, ...tail];
        policyNote = PREVIEW_SCOUT_APPROVED_ONLY ? 'preview-approved only' : 'preview-approved first';
    } else {
        // If preview could not find a clean segment in inspected candidates,
        // keep skipped/uninspected candidates available but do not download
        // candidates the scout explicitly rejected. Set
        // MEDIA_PREVIEW_SCOUT_KEEP_REJECTED=1 only for debugging old behavior.
        finalResults = PREVIEW_SCOUT_KEEP_REJECTED
            ? [...skipped, ...tail, ...rejected.map(r => r.result)]
            : [...skipped, ...tail];
        policyNote = PREVIEW_SCOUT_KEEP_REJECTED
            ? 'no clean preview, demoted inspected candidates'
            : 'no clean preview, blocked rejected candidates';
    }

    return {
        results: finalResults,
        inspected,
        accepted: accepted.length,
        rejected: rejected.length,
        skipped: skipped.length,
        windowRejected,
        log: `Media Preview Scout (pre-download): [${provider?.name || providerKey}] inspected ${inspected}, accepted ${accepted.length}, rejected ${rejected.length}, windowRejected ${windowRejected}, skipped ${skipped.length} (${policyNote})`,
    };
}

async function _withStepTimeout(promise, timeoutMs, label) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timeoutId = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

function _isAbortSignalLike(signal) {
    return !!signal
        && typeof signal === 'object'
        && typeof signal.addEventListener === 'function'
        && typeof signal.removeEventListener === 'function'
        && 'aborted' in signal;
}

function _sceneAbortSignal(scene) {
    return _isAbortSignalLike(scene?._abortSignal) ? scene._abortSignal : null;
}

/**
 * Merge several abort signals into one, so a download can be stopped by
 * whichever authority gives up first: the scene (the whole scene ran out of
 * time) or this one race soldier (only THIS candidate was abandoned).
 *
 * Before this existed only the scene signal was passed down, which meant an
 * abandoned soldier kept downloading at full speed — competing with the live
 * batch for the same bandwidth and the same rented GPU.
 *
 * @param {...(AbortSignal|null|undefined)} signals
 * @returns {AbortSignal|null} null when nothing real was passed
 */
function _combineAbortSignals(...signals) {
    const real = signals.filter(_isAbortSignalLike);
    if (real.length === 0) return null;
    if (real.length === 1) return real[0];
    // Node 20+ / Electron: one line, and it cleans up its own listeners.
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        try { return AbortSignal.any(real); } catch (_) { /* fall through */ }
    }
    const ctl = new AbortController();
    for (const signal of real) {
        if (signal.aborted) {
            try { ctl.abort(signal.reason); } catch (_) { ctl.abort(); }
            return ctl.signal;
        }
        signal.addEventListener('abort', () => {
            try { ctl.abort(signal.reason); } catch (_) { ctl.abort(); }
        }, { once: true });
    }
    return ctl.signal;
}

// ============ DOWNLOAD LOGIC ============

/**
 * Reorder provider instances by smart priority order.
 * Only includes providers that are already in the allProviders list (enabled + initialized).
 */
function reorderProviders(allProviders, priorityOrder, sourceMap, excludedKeys = null) {
    const ordered = [];
    const exclSet = excludedKeys instanceof Set
        ? excludedKeys
        : Array.isArray(excludedKeys)
            ? new Set(excludedKeys.map(k => String(k || '').toLowerCase()).filter(Boolean))
            : null;
    for (const key of priorityOrder) {
        const providerClass = sourceMap[key];
        if (!providerClass) continue;
        const match = allProviders.find(p => p instanceof providerClass);
        if (match) ordered.push(match);
    }
    // Append any providers not in the priority list (safety net),
    // but never re-add providers the Media Agent explicitly excluded —
    // otherwise the safety net silently revives stock for exact-brand scenes.
    for (const p of allProviders) {
        if (ordered.includes(p)) continue;
        const key = String(getProviderKey(p) || '').toLowerCase();
        if (exclSet && key && exclSet.has(key)) continue;
        ordered.push(p);
    }
    return ordered;
}

async function downloadMedia(keyword, mediaType, filenameBase, sceneDuration = 10, sourceHint = '', nicheId = '', scene = null, options = {}) {
    if (filenameBase && options.cleanupRaceScratch !== false) {
        const removedRaceScratch = cleanupSceneRaceTempMedia(filenameBase);
        if (removedRaceScratch > 0) {
            console.log(`  [Temp Cleanup] removed ${removedRaceScratch} stale race scratch file(s) for ${filenameBase}`);
        }
    }
    const safeSourceHint = sanitizeSourceHint(sourceHint || '', 'youtube') || '';
    if (safeSourceHint !== (sourceHint || '')) {
        console.log(`  [Source Policy] source hint "${sourceHint}" disabled -> "${safeSourceHint || 'default'}"`);
        sourceHint = safeSourceHint;
        if (scene) scene.sourceHint = sourceHint;
    }
    // What we ACTUALLY want to see, in full, before any shortening. The query we
    // send a provider has to be short; the judge that decides if a clip is right
    // must not be graded against that short version. Captured once, up front.
    const fullVisualIntent = _fallbackText(
        scene?.visualIntent || scene?.searchKeyword || scene?.keyword || keyword || '',
        220,
    );
    if (scene) {
        if (options.forceKeywordQuery === true) {
            // Forced retry/repair queries are deliberate exploration. Trim only
            // the query itself; do not let the original scene context collapse a
            // repaired query back into the first failed keyword.
            keyword = trimSearchKeyword(keyword, { searchKeyword: keyword, _forcedSearchKeyword: keyword }, {
                maxWords: mediaType === 'image' ? 8 : 7,
            });
            scene._forcedSearchKeyword = keyword;
            if (keyword) {
                console.log(`  Search keyword override: using retry query "${keyword}"`);
            }
        } else {
            delete scene._forcedSearchKeyword;
            const split = applySearchKeywordSplit(scene, scriptContextRef || {});
            if (split.changed) {
                console.log(`  Search keyword trim: "${split.before}" -> "${split.after}" (entity context kept separate)`);
            }
            keyword = trimSearchKeyword(scene.searchKeyword || keyword, scene);
            scene.searchKeyword = keyword;
        }
    }
    const earlyRemainingMs = () => {
        if (!scene?._deadlineAt) return Infinity;
        return Math.max(0, scene._deadlineAt - Date.now());
    };
    const deadlineRescue = options.deadlineRescue === true;
    const reuseExistingMediaAgent = scene
        && scene._mediaAgentPlan?.enabled
        && options.rebuildMediaAgent !== true
        && (deadlineRescue || options.skipMediaAgent === true || options.forceKeywordQuery === true);
    const skipMediaAgent = deadlineRescue
        || options.skipMediaAgent === true
        || reuseExistingMediaAgent;
    const missionMinBudgetMs = Math.max(12_000, parseInt(process.env.MEDIA_AGENT_MISSION_MIN_BUDGET_MS || (mediaType === 'image' ? '18000' : '30000'), 10) || (mediaType === 'image' ? 18_000 : 30_000));
    if (scene && !skipMediaAgent && (options.forceKeywordQuery === true || options.repairAttempt === true || options.repairPlan?.enabled) && Number.isFinite(earlyRemainingMs()) && earlyRemainingMs() < missionMinBudgetMs) {
        console.log(`  Scene deadline: ${Math.round(earlyRemainingMs() / 1000)}s left, skipping retry mission "${_short(keyword, 70)}"`);
        return null;
    }
    let entityContext = _sceneEntityContext(scene, scriptContextRef || {});
    if (scene) {
        console.log(`  [Media Agent] ${skipMediaAgent ? 'using fast provider mission' : 'building provider mission'} (VP hint=${sourceHint || 'none'}, mediaType=${mediaType})`);
    }
    let mediaAgentPlan = null;
    if (reuseExistingMediaAgent) {
        mediaAgentPlan = scene._mediaAgentPlan;
        console.log(`  [Media Agent] reusing existing mission for retry/rescue (no extra AI timeout)`);
    } else if (skipMediaAgent && scene) {
        mediaAgentPlan = buildFallbackMediaAgentPlan(scene, scriptContextRef || {}, {
            keyword,
            mediaType,
            sourceHint,
            nicheId,
        });
        scene._mediaAgentPlan = mediaAgentPlan;
        console.log(`  [Media Agent] fallback mission only (deadline-safe; AI skipped)`);
    } else {
        mediaAgentPlan = scene ? await buildMediaAgentPlan(scene, scriptContextRef || {}, {
            keyword,
            mediaType,
            sourceHint,
            nicheId,
        }) : null;
    }
    if (options.repairPlan?.enabled) {
        mediaAgentPlan = options.repairPlan;
        if (scene) {
            scene._mediaAgentPlan = mediaAgentPlan;
            console.log(`  [Media Repair] using repaired mission${mediaAgentPlan.repairReason ? ` (${_short(mediaAgentPlan.repairReason, 100)})` : ''}`);
        }
    }
    if (scene && mediaAgentPlan?.enabled) {
        scene._mediaAgentPlan = mediaAgentPlan;
    }
    entityContext = _sceneEntityContext(scene, scriptContextRef || {});
    let hunterProfile = buildMediaHunterProfile(scene, scriptContextRef || {}, {
        keyword,
        mediaType,
        sourceHint,
        nicheId,
        agentPlan: mediaAgentPlan,
    });
    let visualContract = buildVisualContract(scene, scriptContextRef || {}, {
        keyword,
        mediaType,
        sourceHint,
        nicheId,
        hunterProfile,
    });
    if (OPEN_MEDIA_GATES) {
        hunterProfile = {
            ...(hunterProfile || {}),
            strictRaw: false,
            allowGraphics: true,
            avoid: [],
            mandatoryVisible: [],
            mandatoryIdentity: [],
        };
        visualContract = {
            ...(visualContract || {}),
            enabled: false,
            strictRaw: false,
            mandatoryVisible: [],
            hardVisibleEntities: [],
            mandatoryIdentity: [],
            mustNotShow: [],
        };
        console.log('  🧪 [Open Media Gates] pre-download relevance gates and media-intent locks are bypassed for this search');
    }
    const allowOmniReserve = options.allowOmniReserve === true
        || scene?.mediaIntent?.lane === 'videoBackup'
        || scene?._allowOmniReserve === true;
    if (scene && hunterProfile?.enabled) {
        scene._mediaHunterProfile = hunterProfile;
        scene._visualContract = visualContract;
        const diag = _ensureMediaDiagnostics(scene);
        if (diag) diag.mediaAgent = summarizeMediaAgentPlan(mediaAgentPlan);
        if (diag) diag.hunter = summarizeMediaHunter(hunterProfile);
        if (diag) diag.contract = summarizeVisualContract(visualContract);
        const logKey = `${mediaType}|${sourceHint}|${keyword}|${hunterProfile.mode}|${hunterProfile.domain}|${mediaAgentPlan?.viewerNeed || ''}|repair=${mediaAgentPlan?.repair ? '1' : '0'}|${mediaAgentPlan?.repairReason || ''}`;
        if (scene._lastMediaHunterLogKey !== logKey) {
            scene._lastMediaHunterLogKey = logKey;
            if (mediaAgentPlan?.enabled) {
                console.log(`  Media Agent: ${mediaAgentPlan.ai ? 'AI' : 'fallback'} role=${mediaAgentPlan.role || '-'} need="${_short(mediaAgentPlan.viewerNeed || '-', 140)}"`);
                if (mediaAgentPlan.assetClass || mediaAgentPlan.searchStrategy?.assetClass) console.log(`  Media Agent: asset class ${mediaAgentPlan.assetClass || mediaAgentPlan.searchStrategy?.assetClass}`);
                if (mediaAgentPlan.minimumAcceptable || mediaAgentPlan.searchStrategy?.minimumAcceptable) console.log(`  Media Agent: minimum acceptable "${_short(mediaAgentPlan.minimumAcceptable || mediaAgentPlan.searchStrategy?.minimumAcceptable, 140)}"`);
                if (mediaAgentPlan.providerOrder?.length) console.log(`  Media Agent: providers ${mediaAgentPlan.providerOrder.slice(0, 5).join(' > ')}`);
                if (mediaAgentPlan.searchStrategy?.providerReasoning) console.log(`  Media Agent: provider reasoning ${_short(mediaAgentPlan.searchStrategy.providerReasoning, 160)}`);
                if (mediaAgentPlan.searchStrategy?.queryLanes?.length) {
                    const lanes = mediaAgentPlan.searchStrategy.queryLanes
                        .slice(0, 6)
                        .map(lane => `${lane.provider || 'any'}:"${_short(lane.query, 58)}"`)
                        .join(' | ');
                    console.log(`  Media Agent: query lanes ${lanes}`);
                }
                const providerLock = getMediaAgentProviderLock(mediaAgentPlan, mediaType);
                if (providerLock && providerLock.strength && providerLock.strength !== 'open') {
                    console.log(`  Media Agent: provider lock ${providerLock.strength}${providerLock.providers?.length ? ` -> ${providerLock.providers.join(' > ')}` : ''}${providerLock.reason ? ` (${_short(providerLock.reason, 120)})` : ''}`);
                }
                if (mediaAgentPlan.providerExclusions?.length) console.log(`  Media Agent: exclude ${mediaAgentPlan.providerExclusions.map(e => `${e.provider}: ${_short(e.reason || 'provider cannot satisfy scene', 90)}`).join(' | ')}`);
                if (mediaAgentPlan.mandatoryIdentity?.length) console.log(`  Media Agent: mandatory identity ${mediaAgentPlan.mandatoryIdentity.slice(0, 6).join(', ')} (${mediaAgentPlan.identityEvidenceMode || 'frame-visible'})`);
                if (mediaAgentPlan.mandatoryVisible?.length) console.log(`  Media Agent: mandatory visible ${mediaAgentPlan.mandatoryVisible.slice(0, 6).join(', ')}`);
                if (mediaAgentPlan.mustShow?.length) console.log(`  Media Agent: must show ${mediaAgentPlan.mustShow.slice(0, 6).join(', ')}`);
            }
            console.log(`  Media Hunter: mode=${hunterProfile.mode} domain=${hunterProfile.domain} strictRaw=${hunterProfile.strictRaw} target="${_short(hunterProfile.targetDescription, 120)}"`);
            if (hunterProfile.prefer?.length) console.log(`  Media Hunter: prefer ${hunterProfile.prefer.slice(0, 6).join(', ')}`);
            if (hunterProfile.strictRaw && hunterProfile.avoid?.length) console.log(`  Media Hunter: avoid ${hunterProfile.avoid.slice(0, 6).join(', ')}`);
            if (hunterProfile.allowRelevantPeople) console.log(`  Media Hunter: relevant subject/person footage allowed when clean`);
            if (visualContract?.strictRaw) {
                if (visualContract.mandatoryIdentity?.length) console.log(`  Media Scout Contract: mandatory identity ${visualContract.mandatoryIdentity.slice(0, 5).join(', ')} (${visualContract.identityEvidenceMode || 'frame-visible'})`);
                if (visualContract.mandatoryVisible?.length) console.log(`  Media Scout Contract: mandatory visible ${visualContract.mandatoryVisible.slice(0, 5).join(', ')}`);
                console.log(`  Media Scout Contract: must show ${visualContract.mustShow.slice(0, 5).join(', ') || 'literal scene target'} | must avoid ${visualContract.mustNotShow.slice(0, 5).join(', ') || 'packaged visuals'}`);
            }
        }
    }

    // Media Agent is the provider authority. VP/sourceHint and Topic Scout are
    // context/evidence only; the base priority is just a fallback tail.
    const mediaAgentProviderLock = getMediaAgentProviderLock(mediaAgentPlan, mediaType);
    let priorityOrder = getSmartPriority('', mediaType, scriptContextRef);
    const mediaAgentSourceMap = mediaType === 'video' ? VIDEO_SOURCE_MAP : IMAGE_SOURCE_MAP;
    const mediaAgentProviderOrder = getMediaAgentProviderOrder(mediaAgentPlan, mediaType, sourceHint)
        .filter(k => mediaAgentSourceMap[k]);
    if (mediaAgentProviderOrder.length > 0) {
        priorityOrder = [
            ...mediaAgentProviderOrder,
            ...priorityOrder.filter(k => !mediaAgentProviderOrder.includes(k)),
        ];
        console.log(`  [Media Agent] provider mission draft -> ${priorityOrder.slice(0, 6).join(' > ')}${priorityOrder.length > 6 ? ' > ...' : ''}`);
    }
    const agentSoftExcludedProviders = [];
    const agentPreferredProviders = [];
    const agentFallbackProviders = [];
    const hardProviderExclusions = !OPEN_MEDIA_GATES && process.env.MEDIA_AGENT_HARD_PROVIDER_EXCLUSIONS === '1';
    if (!OPEN_MEDIA_GATES) {
        priorityOrder = priorityOrder.filter((key) => {
            const skipReason = getMediaAgentProviderSkipReason(mediaAgentPlan, key);
            if (skipReason) {
                agentSoftExcludedProviders.push(`${key}: ${skipReason}`);
                if (hardProviderExclusions) return false;
                agentFallbackProviders.push(key);
                return false;
            }
            agentPreferredProviders.push(key);
            return false;
        });
        priorityOrder = [...agentPreferredProviders, ...agentFallbackProviders];
        if (agentSoftExcludedProviders.length > 0) {
            const label = hardProviderExclusions ? 'skipped' : 'deprioritized';
            console.log(`  [Media Agent] provider realism ${label} ${agentSoftExcludedProviders.join(' | ')}`);
            _recordMediaProvider(scene, {
                mediaType,
                status: 'info',
                reason: `provider realism ${label} ${agentSoftExcludedProviders.join(' | ')}`,
            });
        }
    } else if (mediaAgentPlan?.providerExclusions?.length) {
        console.log('  🧪 [Open Media Gates] Media Agent provider exclusions ignored');
    }

    // Topic Scout is now evidence for the Media Agent, not a second authority.
    // The agent prompt receives the same scoreboard and can incorporate it
    // into providerOrder; downloader no longer rewrites the final mission here.
    const scoutOrder = mediaType === 'video' && Array.isArray(scene?._scoutProviderOrder)
        ? scene._scoutProviderOrder.filter(k => priorityOrder.includes(k))
        : [];
    if (scoutOrder.length > 0) {
        const sceneTag = _sceneLabel ? _sceneLabel(scene) : `scene ${scene?.originalIndex ?? '?'}`;
        console.log(`  [Topic Footage Scout] ${sceneTag} provider evidence -> ${scoutOrder.slice(0, 6).join(' > ')}${scoutOrder.length > 6 ? ' > ...' : ''} (Media Agent keeps final authority)`);
    }

    const youtubeChannelScope = mediaType === 'video'
        && _isPoliticsMilitaryYouTubeChannelScope(scene, keyword, scriptContextRef || {});
    const youtubeRealEventPriority = mediaType === 'video'
        && _isPoliticsMilitaryRealEventScene(scene, keyword, scriptContextRef || {});

    if (youtubeRealEventPriority) {
        console.log(`  [YouTube Channel Scout] politics/military real-event signal noted (Media Agent keeps provider authority)`);
    } else if (_shouldPromoteYouTubeForMaritimeBroll(scene, keyword, hunterProfile) && priorityOrder.includes('youtube')) {
        console.log(`  [YouTube B-roll] maritime/canal signal noted (Media Agent keeps provider authority)`);
    }
    // Live evidence correction. The Media Agent keeps authority over WHICH
    // providers make sense for this scene; this only re-ranks what it chose,
    // using what those same providers have actually delivered in THIS build.
    // A provider with several openings and no wins sinks; a provider that keeps
    // winning rises. Bounded to a couple of places and never removes anything,
    // so one lucky or unlucky scene cannot hijack the ordering.
    if (priorityOrder.length > 1) {
        const adjusted = providerScoreboard.adjustOrder(priorityOrder, mediaType);
        if (adjusted.moved.length > 0) {
            priorityOrder = adjusted.order;
            const detail = adjusted.moved
                .map(m => `${m.provider} ${m.from + 1}->${m.to + 1} (${m.winRate} win rate over ${m.opens})`)
                .join(', ');
            console.log(`  [Provider Scoreboard] this build's record re-ranked the mission: ${detail}`);
        }
    }
    if (priorityOrder.length > 0) {
        console.log(`  [Media Agent] final provider mission -> ${priorityOrder.slice(0, 6).join(' > ')}${priorityOrder.length > 6 ? ' > ...' : ''}`);
    }

    const allProviders = mediaType === 'video' ? videoProviders : imageProviders;
    const sourceMap = mediaType === 'video' ? VIDEO_SOURCE_MAP : IMAGE_SOURCE_MAP;
    const agentExcludedKeys = hardProviderExclusions ? new Set(
        ((mediaAgentPlan && mediaAgentPlan.providerExclusions) || [])
            .map(e => String(e?.provider || '').toLowerCase())
            .filter(Boolean)
    ) : new Set();
    const providers = _filterProvidersByMediaIntent(
        reorderProviders(allProviders, priorityOrder, sourceMap, agentExcludedKeys),
        mediaType,
        scene,
        {
            allowStockFallback: options.allowStockFallback === true,
            stockOnly: options.stockOnly === true,
        }
    );
    // Provider lane ext (used when no provider-specific override exists).
    // The per-provider loop further derives ext from `provider.mediaType` so
    // a video provider running on an image lane (e.g. controlled stock-video
    // fallback after intent upgrade) writes .mp4, not .jpg.
    const ext = mediaType === 'video' ? '.mp4' : '.jpg';
    const abortSignal = _sceneAbortSignal(scene);
    const isAborted = () => scene?._aborted || abortSignal?.aborted;
    const remainingMs = () => {
        if (!scene?._deadlineAt) return Infinity;
        return Math.max(0, scene._deadlineAt - Date.now());
    };
    const hasSceneBudget = (minMs, step) => {
        if (isAborted()) return false;
        const left = remainingMs();
        if (Number.isFinite(left) && left < minMs) {
            console.log(`  Scene deadline: ${Math.round(left / 1000)}s left, skipping ${step}`);
            return false;
        }
        return true;
    };
    const providerStartMinBudgetMs = deadlineRescue && mediaType === 'image' ? 1_500 : 8_000;
    const searchMinBudgetMs = deadlineRescue && mediaType === 'image'
        ? 1_500
        : (mediaType === 'image' ? IMAGE_SEARCH_MIN_BUDGET_MS : 12_000);
    const searchLaneMinBudgetMs = deadlineRescue && mediaType === 'image'
        ? 1_500
        : (mediaType === 'image' ? IMAGE_SEARCH_MIN_BUDGET_MS : 9_000);
    const searchTimeoutFloorMs = deadlineRescue && mediaType === 'image' ? 2_000 : 8_000;
    const searchLaneTimeoutFloorMs = deadlineRescue && mediaType === 'image' ? 2_000 : 6_000;
    const imageAttemptBudgetMs = deadlineRescue ? 1_500 : IMAGE_ATTEMPT_MIN_BUDGET_MS;
    const imageDownloadBudgetMs = deadlineRescue ? 1_500 : IMAGE_DOWNLOAD_MIN_BUDGET_MS;
    const imageVisionBudgetMs = deadlineRescue ? Math.min(IMAGE_VISION_BUDGET_MS, 3_000) : IMAGE_VISION_BUDGET_MS;
    const reserveSceneOmni = (framesNeeded, step) => {
        const needed = Math.max(1, Math.ceil(Number(framesNeeded) || 1));
        if (!scene || needed <= 0) return true;
        let cap = _sceneOmniFrameCap(scene, { allowOmniReserve });
        const planned = Math.max(0, Number(scene._omniFramesPlanned || 0));
        if (planned + needed > cap && _tryGrantSceneOmni(scene, { allowOmniReserve })) {
            cap = _sceneOmniFrameCap(scene, { allowOmniReserve });
        }
        if (planned + needed > cap) {
            console.log(`  [Omni Scene Budget] ${_sceneLabel(scene)} has ${planned}/${cap} planned frames; skipping ${step} (${needed} more)`);
            _recordMediaProvider(scene, {
                mediaType,
                status: 'info',
                reason: `scene Omni cap skipped ${step} (${planned}/${cap}, need ${needed})`,
            });
            return false;
        }
        scene._omniFramesPlanned = planned + needed;
        if (planned === 0) {
            console.log(`  [Omni Scene Budget] ${_sceneLabel(scene)} cap=${cap} frames (${Array.isArray(scene._topicFootageCandidates) && scene._topicFootageCandidates.length ? 'topic bank' : (scene.mediaIntent?.lane || 'normal')})`);
        }
        return true;
    };
    const strictRawWebSearch = mediaType === 'video'
        && hunterProfile?.strictRaw
        && !hunterProfile.allowGraphics
        && !options.stockOnly;
    const shouldReserveForControlledStock = () => {
        if (!strictRawWebSearch) return false;
        if (!_shouldTryControlledStockVideoFallback(scene, mediaType)) return false;
        // If the Media Agent excluded storyblocks, the stock-video fallback
        // will be skipped anyway — do not reserve deadline for a fallback
        // that cannot run, or it starves the real candidates.
        if (Array.from(STOCK_VIDEO_PROVIDER_KEYS).every(key => agentExcludedKeys.has(key))) return false;
        const left = remainingMs();
        return Number.isFinite(left) && left <= STRICT_RAW_STOCK_RESERVE_MS;
    };

    if (providers.length === 0) {
        const reason = `no providers allowed by media intent for ${mediaType}`;
        console.log(`  [Media Lock] ${reason}`);
        _recordMediaProvider(scene, { mediaType, status: 'rejected', reason });
        return null;
    }

    let providersStarted = 0;
    // When the ladder stops before the bottom, say so and say what was left.
    // A scene that ends with no footage while three providers were never opened
    // is a very different bug from one that genuinely ran out of options, and
    // until now the log could not tell them apart.
    let ladderIndex = -1;
    const bailOut = (why) => {
        const untried = providers.slice(Math.max(0, ladderIndex)).map(p => getProviderKey(p));
        if (untried.length > 0) {
            console.log(`  [Provider Ladder] stopped at rung ${ladderIndex + 1}/${providers.length} — ${why}. `
                + `Never opened: ${untried.join(', ')}`);
        }
        return null;
    };
    for (const provider of providers) {
        ladderIndex++;
        if (isAborted()) {
            console.log(`  ⏱️ Scene aborted — stopping provider loop`);
            return bailOut('scene aborted');
        }
        if (providersStarted > 0 && shouldReserveForControlledStock()) {
            console.log(`  [Deadline Reserve] ${Math.round(remainingMs() / 1000)}s left; reserving time for controlled stock-video fallback`);
            return bailOut('reserving time for controlled stock-video fallback');
        }
        if (!hasSceneBudget(providerStartMinBudgetMs, 'next provider')) {
            return bailOut(`scene budget exhausted (${Math.round(remainingMs() / 1000)}s left)`);
        }
        if (!provider.isAvailable()) continue;

        try {
            // Smart query selection: use stockQuery for stock, webQuery for web/youtube
            const providerKey = getProviderKey(provider);
            const activeLockStrength = mediaAgentProviderLock?.strength || 'open';
            const activeLockedProviders = new Set((mediaAgentProviderLock?.providers || []).map(k => String(k || '').toLowerCase()));
            const providerMatchesHardLock = activeLockedProviders.size === 0 || activeLockedProviders.has(providerKey);
            if ((activeLockStrength === 'hard' || activeLockStrength === 'reference')
                && activeLockedProviders.size > 0
                && !providerMatchesHardLock) {
                console.log(`  [Media Agent] skipping ${provider.name}: provider hard lock -> ${[...activeLockedProviders].join(' > ')}`);
                _recordMediaProvider(scene, {
                    provider: provider.name,
                    key: providerKey,
                    mediaType,
                    status: 'skipped',
                    reason: `provider hard lock -> ${[...activeLockedProviders].join(' > ')}`,
                });
                continue;
            }
            providersStarted++;
            providerScoreboard.recordOpen(mediaType, providerKey);
            const isStock = STOCK_PROVIDERS.has(providerKey);
            const isWeb = WEB_PROVIDERS.has(providerKey);
            const isYouTube = YOUTUBE_PROVIDERS.has(providerKey);
            const forceProviderQuery = options.forceKeywordQuery === true;
            const forceExactWebImageQuery = forceProviderQuery
                && mediaType === 'image';
            const keywordKey = String(keyword || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const sceneKeywordKey = String(scene?.searchKeyword || scene?.researchKeyword || scene?.keyword || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const usePlannerOptimizedQuery = scene
                && !options.forceKeywordQuery
                && (!sceneKeywordKey || keywordKey === sceneKeywordKey);

            // Pick the best pre-optimized query for this provider type
            let baseQuery = keyword;
            if (!forceExactWebImageQuery && usePlannerOptimizedQuery) {
                if (isStock && scene.stockQuery) {
                    baseQuery = trimSearchKeyword(scene.stockQuery, scene);
                    // Safety: if stock query lost specificity (e.g. "Abqaiq oil field" → "oil field"),
                    // fall back to original keyword to avoid garbage results like flowers for "oil field"
                    const stockWords = scene.stockQuery.toLowerCase().split(/\s+/).length;
                    const kwWords = keyword.toLowerCase().split(/\s+/).length;
                    if (stockWords <= 2 && kwWords > stockWords) {
                        baseQuery = keyword; // original keyword is more specific
                    }
                } else if ((isWeb || isYouTube) && scene.webQuery) {
                    baseQuery = trimSearchKeyword(scene.webQuery, scene);
                }
            }

            baseQuery = trimSearchKeyword(
                baseQuery,
                forceProviderQuery ? { searchKeyword: baseQuery, _forcedSearchKeyword: baseQuery } : scene,
                { maxWords: mediaType === 'image' ? 8 : 7 }
            );

            baseQuery = _guardProviderQuery(baseQuery, keyword, scene, providerKey);

            // Then apply niche search policy on top. Forced web-image retries
            // must remain exact: this is the path that should actually search
            // retry terms like "container ship canal" instead of collapsing back
            // to the scene's Red Sea anchor.
            let searchQuery = baseQuery;
            let providerQueryPlan = [];
            if (!forceProviderQuery) {
                searchQuery = nicheId ? rewriteQuery(baseQuery, nicheId, providerKey, scene) : baseQuery;
                searchQuery = trimSearchKeyword(searchQuery, scene);
                searchQuery = _guardProviderQuery(searchQuery, keyword, scene, providerKey);
                const hunterQueryPlan = buildProviderQueries(searchQuery, keyword, scene, hunterProfile, providerKey);
                providerQueryPlan = hunterQueryPlan;
                if (hunterQueryPlan.length && hunterQueryPlan[0] !== searchQuery) {
                    const oldQuery = searchQuery;
                    searchQuery = _guardProviderQuery(trimSearchKeyword(hunterQueryPlan[0], scene), keyword, scene, providerKey);
                    console.log(`  Media Hunter: ${provider.name} query "${oldQuery}" -> "${searchQuery}"${hunterQueryPlan.length > 1 ? ` (alt: ${hunterQueryPlan.slice(1).join(' | ')})` : ''}`);
                }
            } else {
                providerQueryPlan = buildProviderQueries(searchQuery, keyword, scene, hunterProfile, providerKey);
                if (providerQueryPlan.length > 1) {
                    console.log(`  Media Hunter: forced retry keeps "${searchQuery}"${providerQueryPlan.length > 1 ? ` (alt: ${providerQueryPlan.slice(1).join(' | ')})` : ''}`);
                }
            }

            // YouTube dialect. Everything above was tuned for stock/image APIs,
            // where a query is a tag lookup — so by this point the chain has
            // handed YouTube a string authored for Bing image search, deleted the
            // words uploaders actually title with ("footage", "raw", "clip"),
            // withheld the place name, and clamped the remainder to ~5 words.
            // On a tag API that is correct. On YouTube it removes the signal.
            //
            // Rebuild lane 1 in the uploader-title dialect and demote the
            // stock-shaped string to a later lane rather than discarding it —
            // two differently-phrased searches are strictly better evidence than
            // one, and the loop below now credits videos that appear in both.
            // Forced retries are exempt: those must search exactly what was asked.
            let ytLadderLanes = 0;
            if (isYouTube && !forceProviderQuery) {
                const ytLadder = buildYouTubeQueryLadder(keyword, scene, {
                    protectedTerms: _sceneProtectedTerms(scene, { searchGuard: true }),
                });
                const ytQuery = ytLadder[0];
                if (ytQuery) {
                    const sameAsStock = ytQuery.toLowerCase() === String(searchQuery || '').toLowerCase();
                    // Rung 2 outranks the stock-shaped string: it is still the
                    // YouTube dialect, just broader. The stock phrasing stays as
                    // a later lane rather than being dropped.
                    //
                    // Queued even when rung 1 happens to equal the stock string:
                    // the broad rung is the half that found the root cellar and
                    // the natural spring, and it does not stop being useful just
                    // because the narrow rung came out identical to what the
                    // stock cleaner produced.
                    if (ytLadder.length > 1) {
                        providerQueryPlan = [...ytLadder.slice(1), searchQuery, ...providerQueryPlan];
                        ytLadderLanes = ytLadder.length - 1;
                    }
                    if (!sameAsStock) {
                        console.log(`  [YouTube Query] "${searchQuery}" -> ${ytLadder.map(q => `"${q}"`).join(' + ')} (uploader-title dialect)`);
                        searchQuery = ytQuery;
                    }
                }
            }

            let topicScoutResults = _topicScoutResultsForProvider(scene, providerKey, mediaType);
            if (providerKey === 'youtube' && youtubeChannelScope && topicScoutResults.length > 0) {
                console.log(`  [YouTube Channel Scout] ignoring ${topicScoutResults.length} global YouTube scout candidate(s); using Kanal13AZ channel search`);
                topicScoutResults = [];
            }
            let memoryResults = findMediaMemoryCandidates(scene, scriptContextRef || {}, {
                providerKey,
                providerName: provider.name,
                mediaType,
                query: searchQuery,
                mediaAgent: mediaAgentPlan,
                mediaHunter: hunterProfile,
                visualContract,
                limit: 6,
            });
            memoryResults = _filterKnownBadResults(memoryResults, scene, provider.name, providerKey, {
                skipAccepted: false,
            });
            if (memoryResults.length > 0) {
                const topMemory = memoryResults[0]._mediaMemory || {};
                const localAssets = memoryResults.filter(r => r?._mediaMemory?.assetPath).length;
                console.log(`  [Media Memory] ${provider.name} recalled ${memoryResults.length} source(s) for this scene${localAssets ? ` (${localAssets} local asset${localAssets === 1 ? '' : 's'})` : ''}${topMemory.reason ? `; top ${topMemory.reason}` : ''}`);
                _recordMediaProvider(scene, {
                    provider: provider.name,
                    key: providerKey,
                    mediaType,
                    query: searchQuery,
                    status: 'info',
                    reason: `media memory recalled ${memoryResults.length} source(s)`,
                    resultCount: memoryResults.length,
                    candidates: memoryResults,
                });
            }
            const queryChanged = searchQuery !== keyword;
            _recordMediaProvider(scene, {
                provider: provider.name,
                key: providerKey,
                mediaType,
                query: searchQuery,
                status: 'searching',
                reason: topicScoutResults.length
                    ? 'topic footage scout bank'
                    : memoryResults.length
                    ? 'media memory bank'
                    : 'provider search',
            });
            console.log(`  🔍 [${provider.name}] Searching: "${searchQuery}"${queryChanged ? ` (from: "${keyword}")` : ''}...`);
            if (topicScoutResults.length > 0) {
                const topScout = topicScoutResults[0]._topicScout || {};
                console.log(`  [Topic Footage Scout] using ${topicScoutResults.length} bank candidate(s) as starter evidence for ${provider.name}${topScout.query ? ` (top query: "${_short(topScout.query, 80)}")` : ''}`);
            }
            if (!hasSceneBudget(searchMinBudgetMs, `${provider.name} search`)) {
                if (topicScoutResults.length === 0 && memoryResults.length === 0) break;
            }
            const reserveFloorMs = strictRawWebSearch
                && providersStarted > 1
                && _shouldTryControlledStockVideoFallback(scene, mediaType)
                ? STRICT_RAW_STOCK_MIN_ATTEMPT_MS
                : deadlineRescue
                    ? 0
                    : 8_000;
            const searchTimeoutMs = Math.min(_providerSearchTimeoutMs(providerKey), Math.max(searchTimeoutFloorMs, remainingMs() - reserveFloorMs));
            let liveResults = [];
            const providerLockedForSearch = activeLockStrength === 'soft'
                ? (activeLockedProviders.size === 0 || activeLockedProviders.has(providerKey))
                : providerMatchesHardLock;
            const searchLaneLimit = _adaptiveSearchLaneLimit({
                mediaType,
                providerKey,
                lockStrength: activeLockStrength,
                isProviderLocked: providerLockedForSearch,
                strictRaw: strictRawWebSearch,
                hunterProfile,
                visualContract,
                mediaAgentPlan,
            })
                // Each ladder rung the block above queued needs a lane of its own,
                // otherwise the cap eats the broad rung and the stock phrasing the
                // comment there promises to keep. Only widens for YouTube, and only
                // by however many rungs were actually added.
                + ytLadderLanes;
            const searchLanes = _uniqueQueryLanes([
                searchQuery,
                ...providerQueryPlan,
                baseQuery,
                keyword,
                isStock ? scene?.stockQuery : scene?.webQuery,
                scene?.templateBgQuery,
            ], searchLaneLimit);
            if (searchLanes.length > 1) {
                console.log(`  [Media Agent] search lanes for ${provider.name}: ${searchLanes.map(q => `"${_short(q, 60)}"`).join(' -> ')}`);
            }
            // Cross-lane agreement. A video that surfaces under two differently
            // worded searches is far more likely to genuinely be about the
            // subject than one that only matches a single phrasing — the second
            // lane is an independent vote, and it is free (the search already
            // ran). Counted here rather than after the merge because
            // _mergeSearchResults DISCARDS the duplicate, so by then the
            // agreement is gone.
            const laneAgreement = new Map();
            // YouTube must hear at least a second phrasing before the
            // "enough results" shortcut fires. Elsewhere the shortcut is right:
            // stock lanes return near-identical tag results, so lane 2 is
            // redundant. On YouTube the lanes are different dialects of the same
            // request and disagree constantly, which is exactly the point.
            const minLanesBeforeEarlyStop = isYouTube ? Math.min(2, Math.max(1, searchLanes.length)) : 1;
            if (hasSceneBudget(searchMinBudgetMs, `${provider.name} live search`)) {
                for (let laneIndex = 0; laneIndex < Math.max(1, searchLanes.length); laneIndex++) {
                    const laneQuery = searchLanes[laneIndex] || searchQuery;
                    if (laneIndex > 0 && !hasSceneBudget(searchLaneMinBudgetMs, `${provider.name} search lane ${laneIndex + 1}`)) {
                        break;
                    }
                    if (typeof provider.setSearchContext === 'function') {
                        provider.setSearchContext({
                            scene,
                            keyword,
                            baseQuery,
                            searchQuery: laneQuery,
                            queryLanes: searchLanes,
                            sourceHint,
                            nicheId,
                            mediaAgent: mediaAgentPlan,
                            mediaHunter: hunterProfile,
                            visualContract,
                        });
                    }
                    try {
                        const laneTimeoutMs = Math.min(searchTimeoutMs, Math.max(searchLaneTimeoutFloorMs, remainingMs() - reserveFloorMs));
                        const cacheScope = youtubeChannelScope ? `channel:${youtubeChannelScope}` : '';
                        let laneResults = _getProviderSearchCache(providerKey, mediaType, laneQuery, { scope: cacheScope });
                        if (laneResults) {
                            console.log(`  [Search Cache] ${provider.name} reused ${laneResults.length} result(s) for "${laneQuery}"`);
                        } else {
                            laneResults = await _withStepTimeout(
                                provider.search(laneQuery),
                                laneTimeoutMs,
                                `${provider.name} search${laneIndex > 0 ? ` lane ${laneIndex + 1}` : ''}`
                            );
                            _setProviderSearchCache(providerKey, mediaType, laneQuery, laneResults || [], { scope: cacheScope });
                        }
                        for (const result of laneResults || []) {
                            if (result && typeof result === 'object' && !result._sourceSearchQuery) {
                                result._sourceSearchQuery = laneQuery;
                            }
                            const identityKeys = result ? _candidateIdentityKeys(result) : [];
                            for (const identityKey of identityKeys) {
                                if (!identityKey) continue;
                                let lanesSeen = laneAgreement.get(identityKey);
                                if (!lanesSeen) laneAgreement.set(identityKey, (lanesSeen = new Set()));
                                lanesSeen.add(laneIndex);
                            }
                        }
                        liveResults = _mergeSearchResults(liveResults, laneResults || []);
                        if (laneIndex > 0 && laneResults?.length) {
                            console.log(`  [Media Agent] ${provider.name} lane ${laneIndex + 1} added ${laneResults.length} result(s) for "${laneQuery}"`);
                        }
                    } catch (searchErr) {
                        if (topicScoutResults.length > 0 || laneIndex > 0) {
                            console.log(`  [Topic Footage Scout] ${provider.name} live search failed for "${laneQuery}" (${searchErr.message}); continuing with available evidence`);
                        } else {
                            throw searchErr;
                        }
                    }
                    if (!strictRawWebSearch && liveResults.length >= 20 && (laneIndex + 1) >= minLanesBeforeEarlyStop) break;
                }
            }
            // Stamp the agreement count onto the surviving (merged) results so
            // ranking can use it.
            //
            // YouTube only. Stamping every provider was the mistake: the ranker
            // reads `_laneHits`, so stock and web results silently started being
            // re-ordered by it too — and their lanes are near-identical tag
            // queries, where agreeing twice means "the tag matched twice", not
            // "two different phrasings independently found this". That is a
            // behaviour change in lanes this work was supposed to leave alone.
            if (isYouTube && laneAgreement.size > 0) {
                let agreeing = 0;
                for (const result of liveResults) {
                    if (!result || typeof result !== 'object') continue;
                    let hits = 1;
                    for (const identityKey of _candidateIdentityKeys(result)) {
                        const lanesSeen = laneAgreement.get(identityKey);
                        if (lanesSeen && lanesSeen.size > hits) hits = lanesSeen.size;
                    }
                    result._laneHits = hits;
                    if (hits > 1) agreeing++;
                }
                if (agreeing > 0) {
                    console.log(`  [Media Agent] ${provider.name}: ${agreeing} result(s) appeared in more than one search phrasing`);
                }
            }
            let results = liveResults;
            if (topicScoutResults.length > 0 || memoryResults.length > 0) {
                results = _mergeSearchResults(_mergeSearchResults(liveResults, topicScoutResults), memoryResults);
                const parts = [`${liveResults.length} live`];
                if (topicScoutResults.length) parts.push(`${topicScoutResults.length} topic-bank`);
                if (memoryResults.length) parts.push(`${memoryResults.length} memory`);
                console.log(`  [Media Memory] ${provider.name} merged evidence -> ${parts.join(', ')}, ${results.length} total`);
            }
            const discoveredResults = Array.isArray(results) ? results.slice(0, 40) : [];
            if (discoveredResults.length > 0) {
                _recordMediaProvider(scene, {
                    provider: provider.name,
                    key: providerKey,
                    mediaType,
                    query: searchQuery,
                    status: 'discovered',
                    reason: `raw search results before filtering (${discoveredResults.length})`,
                    resultCount: discoveredResults.length,
                    candidates: discoveredResults,
                    candidateLimit: 50,
                });
            }
            results = _filterKnownBadResults(results, scene, provider.name, providerKey, {
                skipAccepted: !PRESCORE_PROVIDERS.has(providerKey),
            });

            // Apply quality filtering (watermark + size rejection)
            const beforeCount = results.length;
            results = provider.filterResults(results);
            if (results.length < beforeCount) {
                console.log(`  🛡️ [${provider.name}] Filtered ${beforeCount - results.length} low-quality result(s)`);
            }
            if (!OPEN_MEDIA_GATES) {
                results = _filterResultsByHunterTitle(results, hunterProfile, provider.name, scene, mediaType, providerKey, searchQuery);
            }
            if (visualContract?.enabled) {
                const scout = scoutMediaResults(results, visualContract, {
                    providerKey,
                    providerName: provider.name,
                    query: searchQuery,
                });
                if (scout.log && (mediaType === 'image' || scout.rejected.length > 0 || visualContract.strictRaw)) {
                    console.log(scout.log);
                }
                if (scout.rejected.length > 0) {
                    const categories = [...new Set(scout.rejected.map(r => r.assessment.category || 'rejected'))].slice(0, 4).join(', ');
                    for (const rejected of scout.rejected) {
                        _rememberSceneRejectedResult(scene, rejected.result, rejected.assessment?.reason || rejected.assessment?.category || 'media scout rejected');
                    }
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: scout.results.length ? 'info' : 'rejected',
                        reason: `media scout rejected ${scout.rejected.length} candidate(s)${categories ? `: ${categories}` : ''}`,
                        resultCount: scout.results.length,
                        candidates: scout.rejected.map(r => r.result),
                    });
                }
                results = scout.results;
            }

            const hardVisualEntityRequired = visualContract?.enabled
                ? _hasHardVisualEntityRequirement(visualContract)
                : false;
            // Set by any provider-specific pass that has ALREADY looked at this
            // candidate list's pictures before downloading (Storyblocks' grid,
            // YouTube's SERP shot and storyboard screen). The generic thumbnail
            // screen further down reads it so we never pay a second vision call
            // to learn the same thing twice. A future provider that grows its
            // own look just sets this flag.
            let preDownloadLookApplied = false;
            if (mediaType === 'video' && visualContract?.enabled) {
                let storyblocksThumbnailVisionApplied = false;

                // For Storyblocks, visual thumbnails are stronger evidence than
                // short stock-library titles. Judge the thumbnail grid before the
                // text-only title sanity gate can veto useful generic B-roll.
                if (results.length > 0
                    && providerKey === 'storyblocks'
                    && results.some(r => r && (r._thumbUrl || r.thumbUrl))
                    && hasSceneBudget(18_000, `${provider.name} thumbnail vision`)) {
                    try {
                        const tv = await _thumbnailVisionGrid(results, visualContract, scene, {
                            providerName: provider.name,
                            niche: nicheId || '',
                            getThumbUrl: (result) => result?._thumbUrl || result?.thumbUrl || '',
                        });
                        storyblocksThumbnailVisionApplied = true;
                        preDownloadLookApplied = true;
                        for (const kept of tv.kept) {
                            if (kept && typeof kept === 'object') kept._thumbnailVisionPassed = true;
                        }
                        if (tv.log) console.log(tv.log);
                        const thumbnailSoftKeptMaps = [];
                        const thumbnailHardRejected = [];
                        const geoScene = _sceneHasGeographicContext(scene);
                        for (const rejected of tv.rejected) {
                            const topicMapCandidate = _isCandidateTopicAccurateMap(rejected.result, scene, hunterProfile, {
                                providerName: provider.name,
                                providerKey,
                                query: searchQuery,
                                videoTopic: _videoTopic(),
                            });
                            // In a geographic scene, keep map candidates even when
                            // the title doesn't literally echo the place-name —
                            // defer the real relevance call to the vision SCORE
                            // instead of killing the map on a brittle title match.
                            const geoMapCandidate = !topicMapCandidate
                                && geoScene
                                && _looksLikeMapCandidate(rejected.result, rejected.reason);
                            if (topicMapCandidate || geoMapCandidate) {
                                if (rejected.result && typeof rejected.result === 'object') {
                                    rejected.result._thumbnailVisionPassed = true;
                                    rejected.result._titleSanityWarning = rejected.reason || 'thumbnail vision map/graphic mismatch ignored for topic map';
                                }
                                thumbnailSoftKeptMaps.push(rejected.result);
                            } else {
                                thumbnailHardRejected.push(rejected);
                            }
                        }
                        if (thumbnailSoftKeptMaps.length > 0) {
                            console.log(`  Thumbnail Vision: [${provider.name}] soft-kept ${thumbnailSoftKeptMaps.length} topic-map candidate(s); map/3D animation is valid for this scene`);
                        }
                        if (thumbnailHardRejected.length > 0) {
                            const sampleReason = thumbnailHardRejected[0]?.reason || 'thumbnail mismatch';
                            for (const rejected of thumbnailHardRejected) {
                                const perCandidateReason = rejected.reason || 'thumbnail vision rejected';
                                if (rejected.result && typeof rejected.result === 'object') {
                                    rejected.result._thumbnailVisionPassed = false;
                                    rejected.result._scoutRejectReason = `thumbnail vision: ${perCandidateReason}`;
                                }
                                _rememberSceneRejectedResult(scene, rejected.result, perCandidateReason);
                            }
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: tv.kept.length || thumbnailSoftKeptMaps.length ? 'info' : 'rejected',
                                reason: `thumbnail vision rejected ${thumbnailHardRejected.length} candidate(s): ${sampleReason}`,
                                resultCount: tv.kept.length + thumbnailSoftKeptMaps.length,
                                candidates: thumbnailHardRejected.map(r => r.result),
                            });
                        }
                        results = [...tv.kept, ...thumbnailSoftKeptMaps];
                    } catch (e) {
                        console.log(`  Warning: Storyblocks Thumbnail Vision skipped (${e.message})`);
                    }
                } else if (results.length > 0
                    && providerKey === 'storyblocks'
                    && !results.some(r => r && (r._thumbUrl || r.thumbUrl))) {
                    console.log(`  Thumbnail Vision: [${provider.name}] skipped (no Storyblocks thumbnails scraped)`);
                }
                // Title Sanity (AI): hard-reject titles whose subject is clearly wrong for
                // this scene — saves Omni frames on obvious mismatches like r/submechanophobia
                // for a Bab-el-Mandeb cargo scene. Strict-raw only; fail-safe to keep-all.
                if (results.length > 0 && hasSceneBudget(8_000, `${provider.name} title sanity`)) {
                    try {
                        const beforeSanity = results;
                        const originalOrder = new Map(beforeSanity.map((result, idx) => [result, idx]));
                        const sanity = await _titleSanityJudge(results, visualContract, scene, {
                            providerKey,
                            providerName: provider.name,
                            niche: nicheId || '',
                        });
                        if (sanity.log) console.log(sanity.log);
                        const softKept = [];
                        const hardRejected = [];
                        for (const rejected of sanity.rejected) {
                            const mediaScoutScore = Number(rejected.result?._mediaScoutScore || 0);
                            const titleReason = String(rejected.reason || '');
                            const storyblocksTopicMapCandidate = providerKey === 'storyblocks'
                                && _isCandidateTopicAccurateMap(rejected.result, scene, hunterProfile, {
                                    providerName: provider.name,
                                    providerKey,
                                    query: searchQuery,
                                    videoTopic: _videoTopic(),
                                });
                            const strongStoryblocksVisualEvidence = rejected.result?._thumbnailVisionPassed === true
                                || mediaScoutScore >= 8;
                            const hardTitleMismatch = /\b(presenter|talking head|podcast|interview|webinar|lecture|animation|animated|cartoon|slideshow|thumbnail|ai generated|wrong brand|unrelated subject|not relevant)\b/i
                                .test(titleReason);
                            const canSoftKeepStoryblocks = storyblocksTopicMapCandidate
                                || (providerKey === 'storyblocks'
                                    && !hardVisualEntityRequired
                                    && strongStoryblocksVisualEvidence
                                    && !hardTitleMismatch);
                            if (canSoftKeepStoryblocks) {
                                rejected.result._titleSanityWarning = rejected.reason || 'title-only mismatch';
                                softKept.push(rejected.result);
                            } else {
                                hardRejected.push(rejected);
                            }
                        }
                        if (softKept.length > 0) {
                            console.log(`  Title Sanity: [${provider.name}] soft-kept ${softKept.length} visually plausible Storyblocks candidate(s); title-only mismatch will not override thumbnail/media scout`);
                        }
                        if (sanity.rejected.length > 0) {
                            const sampleReason = hardRejected[0]?.reason || 'wrong subject';
                            for (const rejected of hardRejected) {
                                const perCandidateReason = rejected.reason || 'title sanity rejected';
                                // Stamp the per-candidate verdict on the result so the
                                // scout-lab Tried Links panel shows each title's own reason
                                // instead of the batch summary.
                                if (rejected.result && typeof rejected.result === 'object') {
                                    rejected.result._scoutRejectReason = `title sanity: ${perCandidateReason}`;
                                }
                                _rememberSceneRejectedResult(scene, rejected.result, perCandidateReason);
                            }
                            if (hardRejected.length > 0) {
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: sanity.kept.length || softKept.length ? 'info' : 'rejected',
                                    reason: `title sanity AI rejected ${hardRejected.length} candidate(s): ${sampleReason}`,
                                    resultCount: sanity.kept.length + softKept.length,
                                    candidates: hardRejected.map(r => r.result),
                                });
                            }
                        }
                        results = [...sanity.kept, ...softKept]
                            .sort((a, b) => (originalOrder.get(a) ?? 9999) - (originalOrder.get(b) ?? 9999));
                    } catch (e) {
                        console.log(`  ⚠️ Title Sanity skipped (${e.message})`);
                    }
                }

                // Thumbnail Vision (AI): cheap pre-download visual gates.
                // YouTube uses a real SERP screenshot. Storyblocks uses the
                // thumbnail/poster URLs scraped from its result grid. This keeps
                // obvious wrong B-roll out before full download + scoring.
                // Bypassed for priority-channel scopes (e.g. Kanal13AZ for politics/military):
                // baked-in channel logos are intrinsic to the source and not a quality signal.
                if (results.length > 0
                    && providerKey === 'youtube'
                    && !youtubeChannelScope
                    && hasSceneBudget(15_000, `${provider.name} thumbnail vision`)) {
                    try {
                        const tv = await _thumbnailVisionYouTube(results, searchQuery, visualContract, scene, {
                            providerName: provider.name,
                            niche: nicheId || '',
                        });
                        if (tv.log) console.log(tv.log);
                        if (tv.rejected.length > 0) {
                            const sampleReason = tv.rejected[0]?.reason || 'packaged content';
                            for (const rejected of tv.rejected) {
                                const perCandidateReason = rejected.reason || 'thumbnail vision rejected';
                                if (rejected.result && typeof rejected.result === 'object') {
                                    rejected.result._scoutRejectReason = `thumbnail vision: ${perCandidateReason}`;
                                }
                                _rememberSceneRejectedResult(scene, rejected.result, perCandidateReason);
                            }
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: tv.kept.length ? 'info' : 'rejected',
                                reason: `thumbnail vision rejected ${tv.rejected.length} candidate(s): ${sampleReason}`,
                                resultCount: tv.kept.length,
                                candidates: tv.rejected.map(r => r.result),
                            });
                        }
                        results = tv.kept;
                        preDownloadLookApplied = true;
                    } catch (e) {
                        console.log(`  ⚠️ Thumbnail Vision skipped (${e.message})`);
                    }
                }

                // Storyboard Screen — LOOK INSIDE the video before downloading it.
                //
                // Everything above this line picks a YouTube video from its TITLE:
                // a string an uploader typed for humans, full of SEO padding, and
                // frequently describing something the video does not show. That is
                // how a build spends minutes downloading and vision-scoring a clip
                // it was never going to keep, and why the honest fix is upstream of
                // the download rather than another rescue rung after it.
                //
                // YouTube publishes free sprite-sheet storyboards — a visual index
                // of the whole video. For one small fetch and a couple of vision
                // calls we can pack them into contact sheets and ask the same
                // presence question the Storyboard Scout already uses, before
                // committing to a multi-minute download.
                //
                // RANKING, NOT A GATE. A yes promotes; a no demotes but keeps the
                // candidate (the screen samples frames, so a brief appearance can be
                // missed); no answer at all changes nothing. Worst case we race the
                // same list in the same order we would have anyway.
                if (results.length > 1
                    && providerKey === 'youtube'
                    && !youtubeChannelScope
                    && hasSceneBudget(25_000, `${provider.name} storyboard screen`)) {
                    try {
                        const { screenVideos } = require('./storyboard-scout');
                        const topN = Math.max(2, Math.min(8, parseInt(process.env.YOUTUBE_STORYBOARD_SCREEN_TOP || '5', 10) || 5));
                        const shortlist = results.slice(0, topN);
                        const idOf = (r) => String(r?.id || (String(r?.url || '').match(/[?&]v=([^&]+)/) || [])[1] || '').trim();
                        const screens = await screenVideos(keyword, shortlist.map(idOf), {
                            ytdlpPath: provider._ytdlpPath,
                            sceneText: scene?.text || '',
                            signal: abortSignal,
                            deadlineMs: Math.max(10_000, Math.min(45_000, remainingMs() - 20_000)),
                        });
                        if (screens.size > 0) {
                            preDownloadLookApplied = true;
                            let saw = 0, missed = 0;
                            for (const result of shortlist) {
                                const screen = screens.get(idOf(result));
                                if (!screen || !result || typeof result !== 'object') continue;
                                result._storyboardScreen = screen;
                                if (screen.present && screen.strictConfirmed !== false && screen.source !== 'cover') {
                                    saw++;
                                    // Same meaning as the thumbnail gates above — a
                                    // cheap look confirmed the subject — so it feeds
                                    // the race's existing pre-download evidence bonus
                                    // instead of inventing a parallel signal.
                                    result._thumbnailVisionPassed = true;
                                } else {
                                    missed++;
                                }
                            }
                            if (saw || missed) {
                                // Stable partition, best evidence first:
                                //   0  answered BOTH the plain and the specific question
                                //   1  weaker yes — either the plain question only (right
                                //      kind of thing, maybe not the right thing), or a
                                //      cover picture instead of frames from the video
                                //   2  never screened — no evidence either way
                                //   3  looked and did not see it
                                // Order inside each band is preserved, so the media
                                // scout's ranking still decides ties.
                                const band = (r) => {
                                    const s = r?._storyboardScreen;
                                    if (!s) return 2;
                                    if (!s.present) return 3;
                                    return (s.strictConfirmed === false || s.source === 'cover') ? 1 : 0;
                                };
                                const order = new Map(results.map((r, i) => [r, i]));
                                results = [...results].sort((a, b) => (band(a) - band(b)) || (order.get(a) - order.get(b)));
                                const top = results[0]?._storyboardScreen;
                                const weak = shortlist.filter(r => r?._storyboardScreen?.strictConfirmed === false).length;
                                console.log(`  🗺️ [Storyboard Screen] looked inside ${screens.size} video(s) before downloading: ${saw} show "${top?.probe || keyword}", ${missed} don't${weak ? `, ${weak} only loosely` : ''}${saw ? ` — racing "${_short(results[0]?.title || '', 60)}" first` : ''}`);
                            }
                        }
                    } catch (e) {
                        console.log(`  ⚠️ Storyboard Screen skipped (${e.message})`);
                    }
                }

                if (results.length > 0
                    && providerKey === 'storyblocks'
                    && !storyblocksThumbnailVisionApplied
                    && results.some(r => r && (r._thumbUrl || r.thumbUrl))
                    && hasSceneBudget(18_000, `${provider.name} thumbnail vision`)) {
                    try {
                        const tv = await _thumbnailVisionGrid(results, visualContract, scene, {
                            providerName: provider.name,
                            niche: nicheId || '',
                            getThumbUrl: (result) => result?._thumbUrl || result?.thumbUrl || '',
                        });
                        for (const kept of tv.kept) {
                            if (kept && typeof kept === 'object') kept._thumbnailVisionPassed = true;
                        }
                        if (tv.log) console.log(tv.log);
                        if (tv.rejected.length > 0) {
                            const sampleReason = tv.rejected[0]?.reason || 'thumbnail mismatch';
                            for (const rejected of tv.rejected) {
                                const perCandidateReason = rejected.reason || 'thumbnail vision rejected';
                                if (rejected.result && typeof rejected.result === 'object') {
                                    rejected.result._thumbnailVisionPassed = false;
                                    rejected.result._scoutRejectReason = `thumbnail vision: ${perCandidateReason}`;
                                }
                                _rememberSceneRejectedResult(scene, rejected.result, perCandidateReason);
                            }
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: tv.kept.length ? 'info' : 'rejected',
                                reason: `thumbnail vision rejected ${tv.rejected.length} candidate(s): ${sampleReason}`,
                                resultCount: tv.kept.length,
                                candidates: tv.rejected.map(r => r.result),
                            });
                        }
                        results = tv.kept;
                        preDownloadLookApplied = true;
                    } catch (e) {
                        console.log(`  Warning: Storyblocks Thumbnail Vision skipped (${e.message})`);
                    }
                } else if (results.length > 0
                    && providerKey === 'storyblocks'
                    && !results.some(r => r && (r._thumbUrl || r.thumbUrl))) {
                    console.log(`  Thumbnail Vision: [${provider.name}] skipped (no Storyblocks thumbnails scraped)`);
                }
            }

            if (results.length === 0) {
                _recordMediaProvider(scene, {
                    provider: provider.name,
                    key: providerKey,
                    mediaType,
                    query: searchQuery,
                    status: 'rejected',
                    reason: 'no usable results',
                    resultCount: 0,
                    candidates: discoveredResults,
                });
                console.log(`  ⚠️ [${provider.name}] No results, trying next...`);
                continue;
            }
            _recordMediaProvider(scene, {
                provider: provider.name,
                key: providerKey,
                mediaType,
                query: searchQuery,
                status: 'results',
                reason: 'usable results',
                resultCount: results.length,
                candidates: results,
            });
            results = _rankResultsByProtectedTerms(results, scene, provider.name);
            results = rankResultsForHunter(results, hunterProfile, provider.name);

            // Thumbnail Screen — LOOK at the free preview pictures before
            // committing to any download.
            //
            // Everything above this line ordered the candidates from TEXT: the
            // title an uploader typed, the tags a stock library assigned. That
            // is how a build downloads and vision-scores hundreds of clips it
            // was never going to keep — the scene only races the top few, so a
            // list ordered by text is a list that downloads the wrong ones
            // first.
            //
            // Every provider hands back a preview picture for free. Twenty-five
            // of them pack into ONE grid and cost ONE vision call, which is the
            // same trick the Storyboard Screen uses on YouTube, applied to the
            // lanes that actually carry the volume.
            //
            // RANKING, NOT A GATE — see screenThumbnailGrid(). Nothing is ever
            // dropped here, and a screen that names no winner changes nothing
            // at all, so the worst case is the order we would have raced anyway.
            if (results.length > 1
                && !preDownloadLookApplied
                && visualContract?.enabled
                && results.some(r => r && (r._thumbUrl || r.thumbUrl))
                && hasSceneBudget(THUMBNAIL_SCREEN_MIN_BUDGET_MS, `${provider.name} thumbnail screen`)) {
                try {
                    const screen = await _thumbnailScreen(results, visualContract, scene, {
                        providerName: provider.name,
                        niche: nicheId || '',
                        getThumbUrl: (result) => result?._thumbUrl || result?.thumbUrl || '',
                    });
                    if (screen.log) console.log(screen.log);
                    if (screen.saw > 0) {
                        // Same meaning as every other pre-download look in this
                        // file — a cheap glance confirmed the subject — so it
                        // feeds the race's existing evidence bonus rather than
                        // inventing a parallel signal. Only ever set to true:
                        // a `no` here is a demotion, and writing `false` would
                        // turn this ranking into the rejection it must not be.
                        for (const result of screen.confirmed) {
                            if (result && typeof result === 'object') result._thumbnailVisionPassed = true;
                        }
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status: 'info',
                            reason: `thumbnail screen promoted ${screen.saw} visually-confirmed candidate(s) ahead of ${screen.missed} mismatch(es)`,
                            resultCount: screen.ranked.length,
                            candidates: screen.ranked.slice(0, 12),
                        });
                    }
                    results = screen.ranked;
                } catch (e) {
                    console.log(`  Thumbnail Screen skipped (${e.message})`);
                }
            }

            // Last word on ordering for images: big beats small, everything else equal.
            results = _reserveUndersizedTail(results, provider.name);
            if (mediaType === 'video'
                && results.length > 2
                && visualContract?.enabled
                && hasSceneBudget(FINALIST_SCOUT_MIN_BUDGET_MS, `${provider.name} finalist scout`)) {
                try {
                    const finalistScout = await rankCandidateFinalists(results, scene, visualContract, {
                        providerKey,
                        providerName: provider.name,
                        query: searchQuery,
                        mediaAgent: mediaAgentPlan,
                        hunterProfile,
                    });
                    if (finalistScout.log) {
                        console.log(`  ${finalistScout.log}`);
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status: 'info',
                            reason: finalistScout.log,
                            resultCount: finalistScout.results.length,
                            candidates: finalistScout.ranked?.slice(0, 12) || [],
                        });
                    }
                    results = finalistScout.results;
                } catch (e) {
                    console.log(`  Candidate Finalist Scout skipped (${e.message})`);
                }
            }
            if (mediaType === 'video') {
                const previewScout = await _previewScoutResults(results, {
                    provider,
                    providerKey,
                    keyword,
                    scene,
                    sceneDuration,
                    nicheId,
                    hunterProfile,
                    scriptContext: scriptContextRef || {},
                    hasSceneBudget,
                    reserveSceneOmni,
                    maxCandidates: topicScoutResults.length > 0 ? PREVIEW_SCOUT_BANK_MAX_CANDIDATES : PREVIEW_SCOUT_MAX_CANDIDATES,
                    allowOmniReserve,
                    priorityChannel: providerKey === 'youtube' && youtubeChannelScope,
                });
                if (previewScout.log) {
                    console.log(`  ${previewScout.log}`);
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: 'info',
                        reason: `preview scout accepted ${previewScout.accepted}/${previewScout.inspected}; rejected ${previewScout.rejected}; windowRejected ${previewScout.windowRejected || 0}`,
                        resultCount: previewScout.results.length,
                    });
                }
                results = previewScout.results;
            }
            if (results.length > 0) {
                const remembered = rememberMediaSources(results, scene, scriptContextRef || {}, {
                    providerKey,
                    providerName: provider.name,
                    mediaType,
                    query: searchQuery,
                    mediaAgent: mediaAgentPlan,
                    mediaHunter: hunterProfile,
                    visualContract,
                    status: 'seen',
                    limit: Math.min(results.length, 24),
                });
                if (remembered > 0) {
                    console.log(`  [Media Memory] learned ${remembered} ${provider.name} source(s) for future scenes`);
                }
            }
            if (providersStarted > 1 && shouldReserveForControlledStock()) {
                console.log(`  [Deadline Reserve] ${Math.round(remainingMs() / 1000)}s left after search; handing off to controlled stock-video fallback`);
                return null;
            }

            // Try multiple results from this provider (vision may reject early ones)
            const baseMaxTries = Math.min(results.length, mediaType === 'image' ? IMAGE_MAX_TRIES : (strictRawWebSearch ? 3 : (_visionEnabled ? 5 : 3)));
            let maxTries = baseMaxTries;
            let queuedSmartWindowRetries = 0;
            const visionRejections = []; // track what vision saw for keyword rewrite
            let consecutiveLowScores = 0; // track consistently bad keywords
            let deferredAccept = null; // hold an okay finalist while checking one stronger alternative

            // ──────────────────────────────────────────────────────────
            // PARALLEL CANDIDATE RACE (enabled by default)
            //   Set FOOTAGE_PARALLEL_RACE=false only when debugging serial
            //   legacy behavior. The real build uses the same army path as
            //   Scout Lab: race top-N candidates in parallel. If the race produces
            //   a winner, we return immediately. If not, we fall through to
            //   the existing serial loop below so all edge-case handling
            //   (smart-trim alternates, deferred-accept hold, deep clip
            //   analysis, AI keyword retry) still runs.
            //
            //   First iteration handles the core path: download → vertical
            //   reject → duplicate check → ffmpeg pre-screen → post-download
            //   Qwen-VL score → accept if score >= raceMinScore.
            //
            //   The race is now the primary try path. When it misses, we move
            //   by provider/query lane in batches instead of falling back to
            //   slow one-by-one candidate attempts.
            // ──────────────────────────────────────────────────────────
            const raceEligibleMedia = mediaType === 'video'
                || (mediaType === 'image' && (provider.mediaType || mediaType) === 'image');
            if (process.env.FOOTAGE_PARALLEL_RACE !== 'false'
                && raceEligibleMedia
                && _visionEnabled
                && !deadlineRescue
                && !isAborted()
                && results.length >= 1) {
                const raceLockStrength = mediaAgentProviderLock?.strength || 'open';
                const raceLockedProviders = new Set((mediaAgentProviderLock?.providers || []).map(k => String(k || '').toLowerCase()));
                const raceProviderIsHardLocked = (raceLockStrength === 'hard' || raceLockStrength === 'reference')
                    && (raceLockedProviders.size === 0 || raceLockedProviders.has(providerKey));
                const raceProviderIsSoftLocked = raceLockStrength === 'soft'
                    && (raceLockedProviders.size === 0 || raceLockedProviders.has(providerKey));
                const raceProviderIsLocked = raceProviderIsHardLocked || raceProviderIsSoftLocked;
                const raceDefaultBatches = parseInt(process.env.FOOTAGE_RACE_MAX_BATCHES || '2', 10);
                const hardLockDefaultBatches = mediaType === 'image'
                    ? parseInt(process.env.IMAGE_RACE_HARD_LOCK_MAX_BATCHES || process.env.FOOTAGE_RACE_HARD_LOCK_MAX_BATCHES || '4', 10)
                    : parseInt(process.env.FOOTAGE_RACE_HARD_LOCK_MAX_BATCHES || '8', 10);
                const softLockDefaultBatches = parseInt(process.env.FOOTAGE_RACE_SOFT_LOCK_MAX_BATCHES || '4', 10);
                const defaultRaceMaxBatches = Math.max(1, Math.min(12,
                    raceProviderIsHardLocked ? hardLockDefaultBatches
                    : raceProviderIsSoftLocked ? softLockDefaultBatches
                    : raceDefaultBatches
                ));
                const raceMinScore = mediaType === 'image'
                    ? Math.max(4, Math.min(9, parseInt(process.env.IMAGE_RACE_MIN_SCORE || process.env.FOOTAGE_RACE_MIN_SCORE || '6', 10)))
                    : Math.max(4, Math.min(9, parseInt(process.env.FOOTAGE_RACE_MIN_SCORE || '6', 10)));
                // Race pool should NOT be capped at maxTries (which is 3 for
                // strict-raw video). The army consumes full batches only.
                // Cap to the exact number this race can actually test.
                // No serial one-by-one fallback is used after an army miss.
                const preliminaryRacePlan = _adaptiveRacePlan({
                    mediaType,
                    providerKey,
                    candidates: results,
                    lockStrength: raceLockStrength,
                    hardLocked: raceProviderIsHardLocked,
                    softLocked: raceProviderIsSoftLocked,
                    defaultMaxBatches: defaultRaceMaxBatches,
                    baseConcurrency: getProviderConcurrency(providerKey),
                    mediaAgentPlan,
                    hunterProfile,
                    visualContract,
                });
                const raceConcurrency = preliminaryRacePlan.concurrency;
                const raceMaxBatches = preliminaryRacePlan.maxBatches;
                const racePoolTarget = raceMaxBatches * raceConcurrency;
                const racePoolHardCap = raceProviderIsHardLocked ? 64 : raceProviderIsSoftLocked ? 32 : 20;
                const racePoolCap = Math.max(maxTries, Math.min(racePoolHardCap, racePoolTarget));
                const rawRacePool = results.slice(0, Math.min(results.length, racePoolCap));
                const dedupedRacePool = _dedupeRaceCandidates(rawRacePool, { providerKey });
                if (dedupedRacePool.duplicates > 0) {
                    const sample = (dedupedRacePool.duplicateSamples || [])
                        .slice(0, 3)
                        .map(c => `"${_short(c?.title || c?.url || c?._sourcePage || '', 58)}"`)
                        .join(', ');
                    console.log(`  [Race Speed] skipped ${dedupedRacePool.duplicates} duplicate race candidate(s) before download${sample ? `: ${sample}` : ''}`);
                }
                const finalistTrim = _trimRacePoolByFinalistPriority(dedupedRacePool.results, {
                    minPriority: preliminaryRacePlan.finalistMinPriority,
                    minKeep: Math.max(1, preliminaryRacePlan.finalistMinKeep),
                });
                const racePool = finalistTrim.results;
                if (finalistTrim.skipped.length > 0) {
                    const sample = finalistTrim.skipped
                        .slice(0, 3)
                        .map(c => `"${_short(c?.title || c?.url || '', 58)}" (${Number(c?._candidateFinalistScore || 0)}/10)`)
                        .join(', ');
                    console.log(`  [Race Speed] finalist scout skipped ${finalistTrim.skipped.length} weak-tail candidate(s) before download${sample ? `: ${sample}` : ''}`);
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: 'info',
                        reason: `race speed skipped ${finalistTrim.skipped.length} low-priority finalist candidate(s) before download`,
                        resultCount: racePool.length,
                        candidates: finalistTrim.skipped.slice(0, 12),
                    });
                }
                if (raceProviderIsLocked) {
                    console.log(`  [Race] provider ${raceLockStrength} lock expands army budget for ${provider.name}: ${raceMaxBatches} batch(es), up to ${racePool.length} candidate(s)`);
                }
                console.log(`  [Adaptive Race] ${provider.name}: mode=${preliminaryRacePlan.difficulty}, soldiers=${raceConcurrency}, batches=${raceMaxBatches}, collect=${preliminaryRacePlan.refereeCollectBatches}, refereeNow=${preliminaryRacePlan.refereeNowScore}/10 x${preliminaryRacePlan.refereeNowMinCandidates}, collectBudget=${Math.round(preliminaryRacePlan.maxCollectMs / 1000)}s, early=${preliminaryRacePlan.earlyAcceptScore}/10 (${preliminaryRacePlan.reason})`);
                if (!racePool.length) {
                    console.log(`  [Race] no candidates left after race prefilter; trying next provider/lane`);
                    continue;
                }

                const raceProcessOne = async (selected, raceAttempt, raceControl = {}) => {
                    if (!selected) return { accepted: false };
                    // The race hands each soldier its own abort signal. Once it
                    // fires, this soldier's result is thrown away no matter what
                    // it returns — so every euro spent past that point (a vision
                    // call, a deep clip analysis, the rest of a download) is pure
                    // waste that also slows down the soldiers still being listened
                    // to. `_abandoned()` is the checkpoint before each of them.
                    const soldierSignal = _isAbortSignalLike(raceControl?.signal) ? raceControl.signal : null;
                    const _abandoned = () => !!soldierSignal?.aborted;
                    const soldierSignals = _combineAbortSignals(abortSignal, soldierSignal);
                    // Nobody is listening for this soldier's return value once it
                    // is abandoned, so the orchestrator's loser cleanup can never
                    // see its file. It has to clean up after itself.
                    const _dropOwnFile = (p) => {
                        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
                    };
                    const reusableMemoryAssetPath = _getReusableMediaMemoryAsset(selected);
                    const dlUrl = selected.url || selected._cachedMeta?.url || selected._meta?.url || selected._directVideoUrl || selected._fallbackUrl || reusableMemoryAssetPath || '';
                    if (!dlUrl) return { accepted: false };
                    const recordRaceAttempt = (status, reason, extra = {}) => {
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status,
                            reason,
                            attempt: raceAttempt + 1,
                            selected,
                            url: dlUrl,
                            race: true,
                            ...extra,
                        });
                    };
                    recordRaceAttempt('candidate', `race soldier ${raceAttempt + 1} started`);
                    if (_isBlacklisted(dlUrl)) {
                        recordRaceAttempt('rejected', 'blacklisted URL');
                        return { accepted: false, reason: 'blacklisted' };
                    }
                    const raceAttemptBudget = mediaType === 'image' ? imageAttemptBudgetMs : 18_000;
                    if (isAborted() || !hasSceneBudget(raceAttemptBudget, `race candidate ${raceAttempt + 1}`)) {
                        recordRaceAttempt('rejected', 'race candidate skipped: no scene budget');
                        return { accepted: false, reason: 'no scene budget' };
                    }
                    // Storyblocks auth-dead early exit: once the kill switch
                    // trips in batch N, every in-flight Storyblocks candidate
                    // bails immediately instead of running through to discover
                    // the same auth wall. Saves ~16s per in-flight soldier.
                    if (providerKey === 'storyblocks') {
                        try {
                            const { isStoryblocksAuthDead } = require('./providers/storyblocks-video');
                            if (typeof isStoryblocksAuthDead === 'function' && isStoryblocksAuthDead()) {
                                recordRaceAttempt('failed', 'storyblocks auth dead');
                                return { accepted: false, reason: 'storyblocks auth dead', _storyblocksAuthDead: true };
                            }
                        } catch (_) { /* helper not exported in older build — skip */ }
                    }
                    const raceInFlightReason = `${provider.name} race soldier ${raceAttempt + 1} (${mediaType} download+scoring)`;
                    const raceInFlightOpts = mediaType === 'video'
                        ? { minRemainingMs: RACE_INFLIGHT_GRACE_MS, extraCapMs: RACE_INFLIGHT_MAX_EXTENSION_MS }
                        : { minRemainingMs: Math.min(45_000, RACE_INFLIGHT_GRACE_MS), extraCapMs: Math.min(90_000, RACE_INFLIGHT_MAX_EXTENSION_MS) };
                    // The WHOLE candidate stopwatch: download AND judging. The
                    // per-candidate budget is spent on both, so both have to be
                    // measured, or the budget shrinks to the size of half the job
                    // and nothing can ever finish inside it.
                    const _soldierStartedAt = Date.now();
                    let _reachedVerdict = false;
                    _beginInFlight(scene, raceInFlightReason, raceInFlightOpts);
                    try {
                    const memoryAssetExt = reusableMemoryAssetPath ? path.extname(reusableMemoryAssetPath) : '';
                    const providerExt = memoryAssetExt || ((provider.mediaType === 'image') ? '.jpg' : (provider.mediaType === 'video') ? '.mp4' : ext);
                    const outputPath = path.join(
                        config.paths.temp,
                        `${filenameBase}.race-${raceAttempt + 1}-${Date.now().toString(36)}${providerExt}`
                    );
                    let finalPath = null;
                    // Measured so patience tunes itself to what this provider
                    // really costs on this machine/network, instead of a guess.
                    const _dlStartedAt = Date.now();
                    try {
                        const downloadOptions = {
                            duration: sceneDuration,
                            keyword,
                            _directVideoUrl: selected._directVideoUrl || null,
                            _cachedMeta: selected._cachedMeta || selected._meta || null,
                            _fallbackUrl: selected._fallbackUrl || null,
                            _smartStartTime: Number.isFinite(Number(selected._smartStartTime)) ? Number(selected._smartStartTime) : null,
                            sceneText: scene?.text || '',
                            niche: nicheId || '',
                            videoTopic: scriptContextRef?.summary || '',
                            theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                            entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                            mediaAgent: mediaAgentPlan,
                            mediaHunter: hunterProfile,
                            sourceTitle: String(selected.title || '').slice(0, 200),
                            sourceUrl: dlUrl,
                            sourceDuration: Number(selected.duration) > 0 ? Number(selected.duration) : null,
                            // Scene deadline OR this soldier's own timeout —
                            // whichever gives up first actually stops the bytes.
                            abortSignal: soldierSignals,
                            // The scene's wall-clock, so in-download look-inside work
                            // (the storyboard deep scout) stops when the scene's time
                            // does instead of running on and starving later providers.
                            deadlineAt: scene?._deadlineAt || 0,
                        };
                        if (reusableMemoryAssetPath) {
                            finalPath = _copyReusableMediaMemoryAsset(selected, outputPath, provider.mediaType || mediaType);
                            console.log(`  [Media Memory] reused local asset for ${provider.name}: ${path.basename(reusableMemoryAssetPath)} -> ${path.basename(finalPath)}`);
                            recordRaceAttempt('info', `reused media memory asset ${path.basename(reusableMemoryAssetPath)}`, { path: finalPath });
                        } else {
                            finalPath = await provider.download(selected.url, outputPath, downloadOptions);
                        }
                        _assertDownloadedFile(finalPath, provider.mediaType || mediaType, provider.name);
                        // Only successful downloads are sampled. A download that
                        // stalled tells us nothing about how long a working one
                        // needs, and feeding stalls back would inflate patience
                        // without bound.
                        if (!reusableMemoryAssetPath) {
                            downloadPatience.recordDownload({
                                mediaType,
                                providerKey,
                                ms: Date.now() - _dlStartedAt,
                            });
                        }
                    } catch (e) {
                        console.log(`  [Race] download failed (${provider.name}): ${e.message?.slice(0, 100)}`);
                        try { if (finalPath && fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (_) {}
                        recordRaceAttempt('failed', `download failed: ${e.message}`, { path: finalPath || outputPath });
                        return { accepted: false, reason: `download failed: ${e.message}` };
                    }
                    // Checkpoint 1 — the download finished, but did anyone still
                    // want it? If this soldier was abandoned mid-download, the
                    // file is already unreachable by the orchestrator, so bin it
                    // here and stop before paying the AI to judge a clip whose
                    // verdict will be discarded.
                    if (_abandoned()) {
                        _dropOwnFile(finalPath);
                        recordRaceAttempt('rejected', 'race candidate abandoned (per-candidate timeout) — stopped before judging');
                        return { accepted: false, reason: 'abandoned before judging', _abandoned: true };
                    }

                    const finalExt = path.extname(finalPath);

                    // Vertical reject. Reddit is exempted as a provider (its
                    // native content is mobile-shot vertical), BUT template-
                    // background scenes ALWAYS reject vertical — those scenes
                    // play the clip full-frame behind a UI card on a 16:9
                    // canvas, and a center-cropped portrait loses half the
                    // composition. No Reddit exemption when role=template-bg.
                    const isTemplateBackground = mediaAgentPlan?.role === 'template-background'
                        || hunterProfile?.templateBackground === true;
                    // Portrait STILLS are usable, not garbage: the framing agent crops-to-fill
                    // or floats them on a blurred backdrop (lots of good archival/poster/photo
                    // B-roll is portrait). Only VIDEO and template-background clips truly need
                    // 16:9 (a center-cropped portrait video loses half the motion). Pure
                    // geometry — no niche assumption. Set MEDIA_REJECT_PORTRAIT_IMAGES=1 to
                    // restore the old hard reject.
                    const allowPortraitStill = mediaType === 'image'
                        && !isTemplateBackground
                        && process.env.MEDIA_REJECT_PORTRAIT_IMAGES !== '1';
                    const allowVertical = (providerKey === 'reddit' && !isTemplateBackground)
                        || allowPortraitStill;
                    try {
                        const { probeDimensions: _probeDims } = require('../agents/smart-segment');
                        const _ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
                        const dims = await _probeDims(_ffmpegPath, finalPath);
                        if (!allowVertical && dims && dims.height > dims.width) {
                            const tag = isTemplateBackground ? ' [template-background]' : '';
                            console.log(`  [Race] ⛔ vertical reject${tag} ${dims.width}x${dims.height}`);
                            _blacklistUrl(dlUrl, 1, `vertical ${dims.width}x${dims.height}`);
                            recordRaceAttempt('rejected', `vertical ${dims.width}x${dims.height}`, { path: finalPath });
                            return { accepted: false, path: finalPath, reason: 'vertical' };
                        }
                        if (allowPortraitStill && dims && dims.height > dims.width) {
                            console.log(`  🖼️ [Race] portrait still KEPT ${dims.width}x${dims.height} (would've been rejected before — framing will crop/float it)`);
                        }
                        if (dims && dims.width > 0 && dims.height > 0) {
                            selected.width = dims.width;
                            selected.height = dims.height;
                            if (dims.codec) selected._codec = dims.codec;
                        }
                    } catch (_) { /* probe failure non-fatal */ }

                    // Duplicate media check
                    const dup = _checkAcceptedMediaDuplicate(finalPath);
                    if (dup.duplicate) {
                        console.log(`  [Race] duplicate from scene ${dup.duplicate.sceneIndex}`);
                        recordRaceAttempt('rejected', `duplicate media from scene ${dup.duplicate.sceneIndex}`, { path: finalPath });
                        return { accepted: false, path: finalPath, reason: 'duplicate' };
                    }

                    // The judging stopwatch. Everything from here to the verdict
                    // is the half of a candidate's cost that used to be invisible
                    // to the budget that pays for it.
                    const _judgeStartedAt = Date.now();

                    // ffmpeg structural pre-screen (freeze/black detect)
                    if (['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase())) {
                        try {
                            const screen = await prescreenClip(finalPath);
                            if (!screen.acceptable) {
                                console.log(`  [Race] ⛔ pre-screen reject: ${screen.reason}`);
                                _blacklistUrl(dlUrl, 1, `pre-screen: ${screen.reason}`);
                                recordRaceAttempt('rejected', `pre-screen: ${screen.reason}`, { path: finalPath });
                                return { accepted: false, path: finalPath, reason: `pre-screen: ${screen.reason}` };
                            }
                        } catch (_) { /* pre-screen failure non-fatal */ }
                    }

                    // Checkpoint 2 — the AI judgement is the single most expensive
                    // thing a soldier does, and the rented GPU has a fixed number
                    // of lanes. An abandoned soldier queueing here is literally
                    // taking a lane away from a soldier the race is still waiting
                    // on, which is how one slow batch turned into six.
                    if (_abandoned()) {
                        _dropOwnFile(finalPath);
                        recordRaceAttempt('rejected', 'race candidate abandoned (per-candidate timeout) — stopped before the AI judgement');
                        return { accepted: false, reason: 'abandoned before judging', _abandoned: true };
                    }

                    // Post-download vision scoring. Videos use the lightweight
                    // segment scorer; images use the normal image scorer so web
                    // text/banner/mismatch guards stay identical to serial mode.
                    let postScore = 0;
                    let postDesc = '';
                    let postApiError = false;
                    // "The model answered, we just couldn't read a number out of it."
                    // Deliberately NOT postApiError: that flag aborts the whole race.
                    let postUnparsed = false;
                    let postApiErrorMsg = '';
                    let visionContext = null;
                    try {
                        visionContext = {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: _videoTopic(),
                                theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                entityContext,
                                tone: scriptContextRef?.tone || '',
                                mood: scriptContextRef?.mood || '',
                                mediaAgent: mediaAgentPlan,
                                mediaHunter: hunterProfile,
                                sourceTitle: String(selected.title || '').slice(0, 200),
                                sourceUrl: dlUrl,
                                sourceProvider: provider?.name || '',
                                mediaType,
                                sourceHint,
                                keyword,
                                // The full request, before shortening. The judge grades
                                // against this, not against the provider-sized query.
                                visualIntent: fullVisualIntent,
                        };
                        const visionResult = mediaType === 'image'
                            ? await _scoreDownloadedMedia(finalPath, finalExt, keyword, visionContext)
                            : await scoreDownloadedVideo(finalPath, {
                                keyword,
                                context: visionContext,
                                providerTag: provider.name,
                                minAcceptScore: raceMinScore,
                                scoreSanityFloor: raceMinScore,
                            });
                        if (!visionResult) {
                            postApiError = true;
                            postApiErrorMsg = 'vision scoring unavailable';
                        } else {
                            postScore = Number(visionResult?.bestScore || visionResult?.score || 0);
                            postDesc = String(visionResult?.description || '');
                            postApiError = !!visionResult?.apiError;
                            postApiErrorMsg = String(visionResult?.errorMessage || '');
                            if (!postApiError) {
                                const sanity = applyVisionScoreSanity(
                                    {
                                        score: postScore,
                                        description: postDesc,
                                        parseError: !!visionResult?.parseError,
                                        errorMessage: postApiErrorMsg,
                                    },
                                    keyword,
                                    visionContext,
                                    {
                                        // Only reachable when the judge answered but the
                                        // answer carried no readable number — the race gate
                                        // below is a hard `< raceMinScore` compare, so an
                                        // unjudged-but-strongly-matching candidate either
                                        // clears the line or is skipped entirely. A readable
                                        // score is never touched; the widened trigger that
                                        // used to sit here promoted 27 real 1-5/10 verdicts
                                        // straight onto the pass mark in a single build.
                                        floor: raceMinScore,
                                    }
                                );
                                if (sanity?.scoreSanity?.adjusted) {
                                    console.log(`  [Score Sanity] [Race] ${provider.name}: ${sanity.scoreSanity.from}/10 -> ${sanity.scoreSanity.to}/10 (${sanity.scoreSanity.reason})`);
                                    postScore = Number(sanity.score || postScore);
                                    postDesc = String(sanity.description || postDesc);
                                } else if (visionResult?.parseError && postScore <= 0) {
                                    // Was `postApiError = true` — which made a working
                                    // vision model that simply formatted its answer
                                    // oddly look identical to a dead API, and 59 of
                                    // these in one build tripped 9 race aborts.
                                    postUnparsed = true;
                                    postApiErrorMsg = postApiErrorMsg || 'vision response missing numeric score';
                                }
                            }
                        }
                        if (!postApiError && !postUnparsed && postScore <= 0 && /\b(vision ai error|api error|timeout|timed out|unavailable|quota|rate limit|network)\b/i.test(`${postDesc} ${postApiErrorMsg}`)) {
                            postApiError = true;
                            postApiErrorMsg = postApiErrorMsg || postDesc || 'vision scoring unavailable';
                        }
                    } catch (e) {
                        postApiError = true;
                        postApiErrorMsg = String(e?.message || 'unknown').slice(0, 200);
                        console.log(`  [Race] vision failed (${provider.name}): ${postApiErrorMsg.slice(0, 100)}`);
                    }

                    // If both Qwen and NVIDIA failed, scoreDownloadedVideo returns
                    // score=0 with apiError=true. Don't blacklist the candidate —
                    // we just can't judge it right now. Return a signal so the
                    // orchestrator can abort the race when vision is dead.
                    if (postApiError) {
                        console.log(`  [Race] ⚠️ vision API unavailable — candidate left unjudged (${postApiErrorMsg.slice(0, 80)})`);
                        recordRaceAttempt('failed', `vision API unavailable: ${postApiErrorMsg.slice(0, 120)}`, { path: finalPath });
                        return { accepted: false, path: finalPath, reason: 'vision API unavailable', _visionApiFailed: true };
                    }

                    // Unreadable scorecard: the service is fine, the answer just
                    // didn't contain a number we could parse. Skip this candidate
                    // without blacklisting it (it was never actually judged), and
                    // WITHOUT counting toward the "vision is dead → abort the whole
                    // race" tally — that conflation is what made a healthy model
                    // shut the search down and fall back to placeholder scenes.
                    if (postUnparsed) {
                        console.log(`  [Race] ⚠️ vision score unreadable — candidate left unjudged (${postApiErrorMsg.slice(0, 80)})`);
                        recordRaceAttempt('failed', `vision score unreadable: ${postApiErrorMsg.slice(0, 120)}`, { path: finalPath });
                        return { accepted: false, path: finalPath, reason: 'vision score unreadable', _visionUnparsed: true };
                    }

                    // A real verdict exists. Sample how long judging cost, so the
                    // next candidate's budget is sized against measurement instead
                    // of a guess — and mark this soldier as one whose whole-span
                    // timing is worth keeping (see the `finally` below).
                    _reachedVerdict = true;
                    downloadPatience.recordJudging({ mediaType, ms: Date.now() - _judgeStartedAt });

                    const raceTopicMapCandidate = providerKey === 'storyblocks'
                        && (
                            _isCandidateTopicAccurateMap(selected, scene, hunterProfile, {
                                providerName: provider.name,
                                providerKey,
                                query: searchQuery,
                                videoTopic: _videoTopic(),
                            })
                            || isTopicAccurateMapFromPremiumStock(postDesc, visionContext || {
                                sourceProvider: provider.name,
                                keyword,
                                sceneText: scene?.text || '',
                                videoTopic: _videoTopic(),
                                entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                entityContext,
                                mediaHunter: hunterProfile,
                            })
                        );
                    if (raceTopicMapCandidate && postScore < Math.max(7, raceMinScore)) {
                        console.log(`  [Race] topic-map Storyblocks candidate accepted as map asset: ${postScore}/10 -> ${Math.max(7, raceMinScore)}/10`);
                        postScore = Math.max(7, raceMinScore);
                    }

                    if (postScore < raceMinScore) {
                        console.log(`  [Race] candidate scored ${postScore}/10 (need ≥${raceMinScore}) — ${postDesc.slice(0, 90)}`);
                        recordRaceAttempt('rejected', `race vision ${postScore}/10 below ${raceMinScore}: ${postDesc}`, {
                            path: finalPath,
                            score: postScore,
                            postScore,
                        });
                        return { accepted: false, path: finalPath, reason: `vision ${postScore}/10` };
                    }

                    // Deep clip analysis (Omni multi-frame). Catches what the
                    // 1-frame post-vision misses: slideshows, Ken-Burns stills,
                    // talking-head pans, motion-discontinuity that breaks the
                    // edit. Skip when no scene budget — race already burned a
                    // download+vision call; abandon this candidate gracefully.
                    let clipAnalysisResult = null;
                    const isVideoRaceCandidate = ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                    // ONE_VISION_LAYER: skip the extra multi-frame deep analysis — the
                    // post-download vision score is the single verdict (downstream already
                    // "trusts post-vision" when this is absent).
                    // Checkpoint 3 — a second, even more expensive multi-frame AI
                    // pass. If the race already stopped listening, this candidate
                    // cannot win, so there is nothing to learn by paying for it.
                    if (_abandoned()) {
                        _dropOwnFile(finalPath);
                        recordRaceAttempt('rejected', 'race candidate abandoned (per-candidate timeout) — judged, but too late to be used');
                        return { accepted: false, reason: 'abandoned after judging', _abandoned: true };
                    }
                    if (!ONE_VISION_LAYER && isVideoRaceCandidate && hasSceneBudget(18_000, `race deep analysis ${provider.name}`)) {
                        try {
                            const clipDur = Number(selected.duration || selected._cachedMeta?.duration || 0) || sceneDuration;
                            clipAnalysisResult = await clipAnalyzer.analyzeClip(finalPath, clipDur, keyword, {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: _videoTopic(),
                                entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                entityContext,
                                mediaAgent: mediaAgentPlan,
                                mediaHunter: hunterProfile,
                                sourceTitle: String(selected.title || '').slice(0, 200),
                                sourceUrl: dlUrl,
                                sourceProvider: provider.name,
                                visualIntent: fullVisualIntent,
                            });
                        } catch (e) {
                            console.log(`  [Race] deep analysis errored (${e.message?.slice(0, 80)}) — trusting post-vision ${postScore}/10`);
                        }
                    }

                    if (clipAnalysisResult) {
                        const rejectThreshold = config.clipAnalyzer?.rejectThreshold || 3;
                        // Slideshow / Ken-Burns detector: permanent blacklist
                        // (the URL never produces real footage).
                        const desc = String(clipAnalysisResult.description || '');
                        const issues = (clipAnalysisResult.issues || []).join(' ');
                        const motion = String(clipAnalysisResult.motion || '');
                        const slideshowText = `${desc} ${issues} ${motion}`.toLowerCase();
                        const isSlideshow = /\b(slideshow|slide show|still photo|still photos|static photo|static photos|photo slideshow|photo montage|photograph montage|ken[- ]?burns)\b/i.test(slideshowText);
                        const deepTopicMap = raceTopicMapCandidate
                            || isTopicAccurateMapFromPremiumStock(`${desc} ${issues}`, {
                                sourceProvider: provider.name,
                                keyword,
                                sceneText: scene?.text || '',
                                videoTopic: _videoTopic(),
                                entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                entityContext,
                                mediaHunter: hunterProfile,
                            });
                        if (isSlideshow && !deepTopicMap) {
                            console.log(`  [Race] ⛔ slideshow/Ken-Burns detected — permanent blacklist`);
                            _blacklistUrl(dlUrl, 1, `slideshow/ken-burns: ${desc.slice(0, 120)}`);
                            recordRaceAttempt('rejected', `slideshow/ken-burns: ${desc.slice(0, 120)}`, {
                                path: finalPath,
                                score: postScore,
                                postScore,
                                deepScore: clipAnalysisResult.score,
                            });
                            return { accepted: false, path: finalPath, reason: `slideshow/ken-burns` };
                        }
                        if (Number(clipAnalysisResult.score || 0) <= rejectThreshold && !deepTopicMap) {
                            console.log(`  [Race] ⛔ deep analysis too low (${clipAnalysisResult.score}/10 ≤ ${rejectThreshold}): ${desc.slice(0, 90)}`);
                            _blacklistUrl(dlUrl, clipAnalysisResult.score || 1, desc);
                            recordRaceAttempt('rejected', `deep analysis ${clipAnalysisResult.score}/10: ${desc}`, {
                                path: finalPath,
                                score: Math.min(postScore, Number(clipAnalysisResult.score || 0)),
                                postScore,
                                deepScore: clipAnalysisResult.score,
                            });
                            return { accepted: false, path: finalPath, reason: `deep ${clipAnalysisResult.score}/10` };
                        }
                        console.log(`  [Race] 🎬 deep analysis ${clipAnalysisResult.score}/10 | ${motion} motion | ${(clipAnalysisResult.issues || []).length ? 'Issues: ' + (clipAnalysisResult.issues || []).join(', ') : 'Clean'}`);
                    }

                    const mandatoryConfirmation = _mandatoryAcceptanceConfirmation({
                        postDescription: postDesc,
                        deepDescription: clipAnalysisResult?.description || '',
                        context: visionContext,
                        candidate: selected,
                        keyword,
                    });
                    if (!mandatoryConfirmation.ok) {
                        console.log(`  [Race] mandatory object guard: ${mandatoryConfirmation.reason}`);
                        _rememberSceneRejectedResult(scene, selected, mandatoryConfirmation.reason);
                        recordRaceAttempt('rejected', mandatoryConfirmation.reason, {
                            path: finalPath,
                            score: Math.min(postScore || 0, 4),
                            postScore,
                            deepScore: clipAnalysisResult?.score,
                        });
                        return { accepted: false, path: finalPath, reason: mandatoryConfirmation.reason };
                    }

                    // Blended score: lean on the lower of (post-vision, deep)
                    // so race comparison favors candidates that survived BOTH
                    // checks strongly, not just the one-frame snapshot.
                    //
                    // Template-background clips are different: they sit behind
                    // text/cards, so a clean broad background can be editorially
                    // correct even when deep analysis says it is "too broad" or
                    // lacks close-ups. Keep hard rejects above, but don't let a
                    // conservative deep score downgrade a strong post-score into
                    // failure for this background lane.
                    const deepScore = clipAnalysisResult ? Number(clipAnalysisResult.score || 0) : null;
                    let blendedScore = clipAnalysisResult
                        ? Math.min(postScore, deepScore || postScore)
                        : postScore;
                    if (isTemplateBackground
                        && postScore >= raceMinScore
                        && clipAnalysisResult
                        && deepScore > (config.clipAnalyzer?.rejectThreshold || 3)) {
                        blendedScore = postScore;
                        console.log(`  [Race] template-background: trusting post-score ${postScore}/10 over conservative deep score ${deepScore}/10 (${mandatoryConfirmation.reason || 'mandatory guard clear'})`);
                    }
                    recordRaceAttempt('candidate', `race contender passed: post ${postScore}/10${deepScore ? `, deep ${deepScore}/10` : ''}, blended ${blendedScore}/10 - ${postDesc}`, {
                        path: finalPath,
                        score: blendedScore,
                        postScore,
                        deepScore: deepScore || undefined,
                    });
                    return {
                        accepted: true,
                        score: blendedScore,
                        postScore,
                        deepScore: deepScore || null,
                        description: postDesc,
                        clipAnalysis: clipAnalysisResult,
                        path: finalPath,
                        ext: finalExt,
                        providerName: provider.name,
                        actualMediaType: provider.mediaType || mediaType,
                        selected,
                        dlUrl,
                    };
                    } finally {
                        _endInFlight(scene, raceInFlightReason);
                        // The whole-candidate sample. Gated on a real verdict:
                        // a download failure or an early reject says nothing about
                        // how long a WORKING candidate needs, and feeding those
                        // short spans back is precisely how the budget shrank to
                        // half a job and stopped fitting a whole one.
                        downloadPatience.recordCandidate({
                            mediaType,
                            providerKey,
                            ms: Date.now() - _soldierStartedAt,
                            reachedVerdict: _reachedVerdict,
                        });
                    }
                };

                // Per-candidate patience is resolved per (topic, provider, media
                // type, time left in this scene) and tunes itself against what
                // downloads actually cost in this run — see download-patience.js.
                // The scene-share clamp inside it is what keeps the retry and
                // fallback steps behind this race reachable instead of decorative.
                const patience = downloadPatience.resolveCandidatePatienceMs({
                    mediaType,
                    providerKey,
                    nicheId: scriptContextRef?.nicheId,
                    remainingSceneMs: remainingMs(),
                    log: (msg) => console.log(msg),
                });
                const racePerCandidateTimeoutMs = patience.ms;
                if (mediaType === 'video' || mediaType === 'image') {
                    const label = mediaType === 'image' ? 'image soldier timeout' : 'soldier timeout';
                    console.log(`  [Race] ${provider.name} ${label} ${racePerCandidateTimeoutMs > 0 ? `${Math.round(racePerCandidateTimeoutMs / 1000)}s` : 'disabled'}`
                        + ` — ${patience.explain}; scene deadline remains the outer guard`);
                }
                // Don't start work that cannot finish. If the scene has less time
                // left than ONE candidate needs to download AND be judged, this
                // race can only ever produce timed-out soldiers: it burns the last
                // of the scene's clock, spends AI money on verdicts that arrive
                // after the door closed, and still ends in a placeholder card.
                // Stepping to the next provider is not giving up — a cheaper
                // provider (a still instead of a clip) may well fit in what's left.
                if (patience.viable === false) {
                    console.log(`  ⏭️  [Race] skipping ${provider.name}: ${patience.explain.split(', ').pop()}`);
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: 'skipped',
                        reason: `not enough scene time for one full candidate (needs ~${Math.round(patience.minViableMs / 1000)}s incl. judging)`,
                        race: true,
                    });
                    continue;
                }
                const raceWinner = await runCandidateRace({
                    candidates: racePool,
                    processOne: raceProcessOne,
                    providerKey,
                    concurrency: raceConcurrency,
                    maxBatches: raceMaxBatches,
                    minAcceptScore: raceMinScore,
                    perCandidateTimeoutMs: racePerCandidateTimeoutMs,
                    refereeCollectBatches: preliminaryRacePlan.refereeCollectBatches,
                    collectMoreOnBorderline: true,
                    skipRefereeOnObvious: true,
                    earlyAcceptScore: preliminaryRacePlan.earlyAcceptScore,
                    earlyAcceptQualityGap: preliminaryRacePlan.earlyAcceptQualityGap,
                    maxCollectMs: preliminaryRacePlan.maxCollectMs,
                    refereeNowScore: preliminaryRacePlan.refereeNowScore,
                    refereeNowMinCandidates: preliminaryRacePlan.refereeNowMinCandidates,
                    refereeContext: {
                        scene,
                        keyword,
                        mediaType,
                        providerKey,
                        providerName: provider.name,
                        searchQuery,
                        sourceHint,
                        mediaAgent: mediaAgentPlan,
                        mediaHunter: hunterProfile,
                        visualContract,
                    },
                    shouldStop: () => isAborted(),
                });

                if (raceWinner && raceWinner.accepted) {
                    // Mirror the serial loop's accept path side-effects so
                    // downstream caching / dedup / scene-mediaType handling
                    // stays consistent.
                    const dlUrl = raceWinner.dlUrl;
                    const selected = raceWinner.selected;
                    _trackUrlUse(dlUrl);
                    if (provider.downloadedIds) {
                        if (selected?.id) provider.downloadedIds.add(selected.id);
                        if (dlUrl) provider.downloadedIds.add(normalizeUrlForDedup(dlUrl));
                    }
                    const acceptedSceneIndex = scene?.originalIndex ?? scene?.index ?? filenameBase;
                    const dupCheck = _checkAcceptedMediaDuplicate(raceWinner.path);
                    _rememberAcceptedMediaHash(dupCheck.hash, acceptedSceneIndex, provider.name, raceWinner.path);
                    if (raceWinner.description) {
                        _rememberAcceptedDescription(raceWinner.description, acceptedSceneIndex, provider.name);
                    }
                    if (dlUrl) _acceptedUrls.add(normalizeUrlForDedup(dlUrl));
                    const winnerDeepScore = raceWinner.deepScore || null;
                    const winnerPostScore = raceWinner.postScore || raceWinner.score;
                    if (raceWinner._referee) {
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status: 'info',
                            reason: `AI Referee: compared ${raceWinner._referee.compared || '?'} candidate(s); confidence ${raceWinner._referee.confidence || 0}/10; ${raceWinner._referee.reason || 'picked best editorial fit'}`,
                            selected,
                        });
                    }
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: 'accepted',
                        reason: raceWinner._referee?.reason
                            ? `parallel race vision ${raceWinner.score}/10; AI referee: ${raceWinner._referee.reason}`
                            : `parallel race vision ${raceWinner.score}/10`,
                        attempt: Number.isFinite(Number(raceWinner._raceIndex)) ? Number(raceWinner._raceIndex) + 1 : 1,
                        selected,
                        path: raceWinner.path,
                        score: raceWinner.score,
                        postScore: winnerPostScore,
                        deepScore: winnerDeepScore || undefined,
                    });
                    if (scene && raceWinner.actualMediaType !== mediaType) {
                        scene.mediaType = raceWinner.actualMediaType;
                    }
                    if (raceWinner._referee?.reason) {
                        console.log(`  [AI Referee] final pick reason: ${raceWinner._referee.reason}`);
                    }
                    const rememberedAcceptedSource = rememberMediaSource(selected, scene, scriptContextRef || {}, {
                        providerKey,
                        providerName: provider.name,
                        mediaType,
                        query: searchQuery,
                        mediaAgent: mediaAgentPlan,
                        mediaHunter: hunterProfile,
                        visualContract,
                        status: 'accepted',
                        score: raceWinner.score,
                        postScore: winnerPostScore,
                        deepScore: winnerDeepScore || 0,
                        startTime: selected?._smartStartTimeUsed ?? selected?._smartStartTime ?? selected?._previewScoutSegment?.startTime,
                        duration: sceneDuration,
                        reason: raceWinner._referee?.reason || `parallel race accepted ${raceWinner.score}/10`,
                        path: raceWinner.path,
                        ext: raceWinner.ext,
                    });
                    if (rememberedAcceptedSource?.assetPath) {
                        console.log(`  [Media Memory] saved accepted asset: ${path.basename(rememberedAcceptedSource.assetPath)}`);
                    }
                    console.log(`  ✅ [Race] accepted via ${provider.name}: ${path.basename(raceWinner.path)} (post ${winnerPostScore}/10${winnerDeepScore ? `, deep ${winnerDeepScore}/10` : ''}, blended ${raceWinner.score}/10)`);
                    const removedRaceScratch = cleanupSceneRaceTempMedia(filenameBase, raceWinner.path);
                    if (removedRaceScratch > 0) {
                        console.log(`  [Temp Cleanup] kept race winner; removed ${removedRaceScratch} loser/stale race scratch file(s) for ${filenameBase}`);
                    }
                    providerScoreboard.recordWin(mediaType, providerKey);
                    // The wording that actually produced footage is proven
                    // vocabulary for this video — protect its phrases from now on.
                    try { rememberPhraseWin(searchQuery); } catch (_) {}
                    return {
                        path: raceWinner.path,
                        ext: raceWinner.ext,
                        provider: provider.name,
                        mediaType: raceWinner.actualMediaType,
                        mediaWidth: selected?.width || 0,
                        mediaHeight: selected?.height || 0,
                        visionScore: raceWinner.score,
                        clipAnalysis: raceWinner.clipAnalysis || null,
                    };
                }
                // The race already spent its batch budget. Do not fall back
                // to serial one-by-one candidate attempts; continue by
                // provider/query lanes only.
                const lockStrength = mediaAgentProviderLock?.strength || 'open';
                const lockedProviders = new Set((mediaAgentProviderLock?.providers || []).map(k => String(k || '').toLowerCase()));
                const providerIsLocked = (lockStrength === 'hard' || lockStrength === 'reference')
                    && (lockedProviders.size === 0 || lockedProviders.has(providerKey));
                providerScoreboard.recordLoss(mediaType, providerKey, 'race exhausted, no winner');
                if (providerIsLocked) {
                    console.log(`  [Race] no winner - ${provider.name} exhausted in army mode; staying inside locked provider family only`);
                } else {
                    console.log(`  [Race] no winner - provider ${provider.name} exhausted, moving to next provider`);
                }
                continue;
            }

            for (let attempt = 0; attempt < maxTries; attempt++) {
                const isOverused = (url) => _getUrlUseCount(url) >= MAX_URL_REUSE;
                const selected = attempt === 0
                    ? provider.pickUnused(results, isOverused)
                    : results[attempt]; // fallback to next results if first download fails

                if (!selected) continue;
                const selectedTitle = String(selected.title || selected._cachedMeta?.title || selected._meta?.title || selected.url || '').replace(/\s+/g, ' ').trim();
                const selectedSourceUrl = selected.url || selected._cachedMeta?.url || selected._meta?.url || selected._directVideoUrl || selected._fallbackUrl || '';
                const queueNextSmartWindow = (reason) => {
                    if (mediaType !== 'video' || !PRESCORE_PROVIDERS.has(providerKey)) return false;
                    if (queuedSmartWindowRetries >= 2) return false;
                    const currentStart = Number.isFinite(Number(selected._smartStartTime))
                        ? Number(selected._smartStartTime)
                        : (Number.isFinite(Number(selected._smartStartTimeUsed)) ? Number(selected._smartStartTimeUsed) : null);
                    const alternates = []
                        .concat(Array.isArray(selected._smartSegmentAlternates) ? selected._smartSegmentAlternates : [])
                        .concat(Array.isArray(selected._lastSmartSegmentAlternates) ? selected._lastSmartSegmentAlternates : []);
                    const next = alternates.find(choice => {
                        const start = Number(choice?.startTime);
                        if (!Number.isFinite(start)) return false;
                        if (currentStart !== null && Math.abs(start - currentStart) < 2) return false;
                        if (Array.isArray(selected._triedSmartWindows) && selected._triedSmartWindows.some(prev => Math.abs(Number(prev) - start) < 2)) return false;
                        return Number(choice?.score || 0) >= 5;
                    });
                    if (!next) return false;
                    if (!hasSceneBudget(18_000, `${provider.name} alternate smart window`)) return false;
                    const tried = Array.isArray(selected._triedSmartWindows) ? selected._triedSmartWindows.slice() : [];
                    if (currentStart !== null) tried.push(currentStart);
                    tried.push(Number(next.startTime));
                    const remainingAlternates = alternates.filter(choice => Math.abs(Number(choice?.startTime) - Number(next.startTime)) >= 2);
                    const retryCandidate = {
                        ...selected,
                        _smartStartTime: Number(next.startTime),
                        _smartStartTimeUsed: Number(next.startTime),
                        _smartSegmentAlternates: remainingAlternates,
                        _lastSmartSegmentAlternates: remainingAlternates,
                        _triedSmartWindows: tried,
                        _previewScoutSegment: {
                            startTime: Number(next.startTime),
                            confidence: Number(next.confidence || 0.72),
                            reason: `alternate smart window after ${reason || 'failed clip'}: frame ${next.frame || '?'} ${next.score || '?'} / 10 fit ${next.editorFit ?? '?'}`,
                        },
                    };
                    results.splice(attempt + 1, 0, retryCandidate);
                    queuedSmartWindowRetries++;
                    maxTries = Math.min(results.length, maxTries + 1, baseMaxTries + 2);
                    console.log(`  [Smart Trim] Retrying same source at alternate window ${Math.round(Number(next.startTime))}s (${next.score || '?'} / 10, fit ${next.editorFit ?? '?'}) before abandoning "${_short(selectedTitle, 70)}"`);
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: 'info',
                        reason: `retry same source at alternate smart window ${Math.round(Number(next.startTime))}s after ${reason || 'failed clip'}`,
                        attempt: attempt + 1,
                        selected: retryCandidate,
                    });
                    return true;
                };
                // Per-clip hard cap: a single candidate must not eat more than
                // ~50s of AI budget. Vision + deep analysis combined can otherwise
                // burn 60-90s on one losing clip, starving the scene of attempts
                // at the rest. We don't yank in-flight calls — we gate the most
                // expensive call (deep clip analysis) on whether we already burned
                // most of the cap on download + vision.
                const _attemptStartedAt = Date.now();
                const _attemptElapsedMs = () => Date.now() - _attemptStartedAt;
                const _attemptOverHardCap = (threshold = 35_000) => _attemptElapsedMs() > threshold;
                _recordMediaProvider(scene, {
                    provider: provider.name,
                    key: providerKey,
                    mediaType,
                    query: searchQuery,
                    status: 'candidate',
                    reason: 'picked for download/vision attempt',
                    attempt: attempt + 1,
                    selected,
                });
                if (attempt > 0 && shouldReserveForControlledStock()) {
                    console.log(`  [Deadline Reserve] ${Math.round(remainingMs() / 1000)}s left after rejected candidate; handing off to controlled stock-video fallback`);
                    return null;
                }
                // When Media Agent excluded Storyblocks (exact-brand scenes), no stock-video
                // fallback is coming — don't reserve 24s for it. Use a tighter per-attempt
                // budget so YouTube/Reddit candidates get processed instead of starved out.
                const stockExcluded = Array.from(STOCK_VIDEO_PROVIDER_KEYS).every(key => agentExcludedKeys.has(key));
                const videoAttemptBudget = stockExcluded ? 12_000 : 24_000;
                if (!hasSceneBudget(mediaType === 'image' ? imageAttemptBudgetMs : videoAttemptBudget, `${provider.name} attempt ${attempt + 1}`)) break;

                // Check URL blacklist — skip URLs that scored poorly in previous scenes.
                // PRESCORE_PROVIDERS (YouTube) do per-scene segment selection
                // so the same URL can yield different content at different timestamps — don't blacklist them.
                const dlUrl = selected._directVideoUrl || selected.url;
                if (!PRESCORE_PROVIDERS.has(providerKey)) {
                    const blacklisted = _isBlacklisted(dlUrl);
                    if (blacklisted) {
                        console.log(`  ⛔ [${provider.name}] Skipping blacklisted URL (scored ${blacklisted.score}/10 before): ${dlUrl.substring(0, 80)}...`);
                        continue;
                    }
                    // Within-build accepted-URL skip: don't re-pull the exact same clip another scene already kept
                    const dlBaseUrl = dlUrl ? normalizeUrlForDedup(dlUrl) : '';
                    if (dlBaseUrl && _acceptedUrls.has(dlBaseUrl)) {
                        console.log(`  ⛔ [${provider.name}] URL already accepted by earlier scene this build: ${dlUrl.substring(0, 80)}...`);
                        continue;
                    }
                    // Deprioritize overused URLs — skip them on early attempts,
                    // but allow as last resort (last attempt)
                    const urlUses = _getUrlUseCount(dlUrl);
                    if (urlUses >= MAX_URL_REUSE && attempt < maxTries - 1) {
                        console.log(`  ⏭️ [${provider.name}] URL used ${urlUses}x already, trying fresh clips first...`);
                        continue;
                    }
                }

                try {
                    // Use the provider's own declared mediaType to pick the
                    // file extension. Safety net for cases where a provider
                    // ended up on the wrong lane — its bytes still land in a
                    // correctly-typed file.
                    const reusableMemoryAssetPath = _getReusableMediaMemoryAsset(selected);
                    const memoryAssetExt = reusableMemoryAssetPath ? path.extname(reusableMemoryAssetPath) : '';
                    const providerExt = memoryAssetExt || (provider.mediaType === 'video' ? '.mp4'
                        : provider.mediaType === 'image' ? '.jpg'
                        : ext);
                    const outputPath = path.join(config.paths.temp, filenameBase + providerExt);

                    // ── Smart Trimming: Omni pre-download segment selection ──
                    // If video is long enough and clip analyzer has budget,
                    // extract frames from URL → Omni picks best segment → pass startTime to download
                    let smartStartTime = null;
                    let smartSegmentResult = null;
                    let smartSegmentUrl = selected._directVideoUrl || selected._fallbackUrl || selected._cachedMeta?._fallbackUrl || null;
                    if (selected._smartStartTime != null && Number.isFinite(Number(selected._smartStartTime))) {
                        smartStartTime = Math.max(0, Number(selected._smartStartTime));
                        smartSegmentResult = selected._previewScoutSegment || {
                            startTime: smartStartTime,
                            confidence: selected._previewScoutScore || 0.8,
                            reason: selected._previewScoutReason || 'preview scout segment',
                        };
                        console.log(`  🎯 [Smart Trim] Using Media Preview Scout start=${Math.round(smartStartTime)}s (${smartSegmentResult.reason || 'clean segment'})`);
                    }
                    const videoDuration = reusableMemoryAssetPath
                        ? (sceneDuration || selected._cachedMeta?.duration || selected._meta?.duration || selected.duration || 0)
                        : (selected._cachedMeta?.duration || selected._meta?.duration || selected.duration || 0);
                    const strictRawSegmentHunt = hunterProfile?.strictRaw && !hunterProfile.allowGraphics;
                    const providerPrescores = PRESCORE_PROVIDERS.has(providerKey);
                    const needsExactWindowValidation = strictRawSegmentHunt
                        && PREVIEW_SCOUT_WINDOW_VALIDATION
                        && clipAnalyzer.validateSegmentWindow
                        && !selected._previewScoutWindowValidation;
                    const strictRawShortSegmentEligible = strictRawSegmentHunt
                        && mediaType === 'video'
                        && videoDuration < 60
                        && videoDuration > Math.max(sceneDuration + 4, 18);
                    const smartTrimEligible = mediaType === 'video'
                        && videoDuration > sceneDuration + (strictRawSegmentHunt ? 4 : 15)
                        && (videoDuration >= 60 || strictRawShortSegmentEligible)
                        && (!providerPrescores || strictRawSegmentHunt);
                    const segmentFrameNeed = _segmentScanFrameNeed(
                        videoDuration,
                        { mediaHunter: hunterProfile },
                        scene,
                        { allowOmniReserve, reserveWindowFrames: needsExactWindowValidation }
                    );
                    const omniAvailable = segmentFrameNeed >= 3 && (clipAnalyzer.hasOmniBudget
                        ? clipAnalyzer.hasOmniBudget(segmentFrameNeed, { allowReserve: allowOmniReserve })
                        : clipAnalyzer.isAvailable({ framesNeeded: segmentFrameNeed, allowReserve: allowOmniReserve }));
                    // Only use Omni on first attempt per provider — retries use single-frame vision instead
                    const segmentAttempts = strictRawSegmentHunt ? 2 : 1;
                    const useOmni = omniAvailable
                        && attempt < segmentAttempts
                        && (!Number.isFinite(remainingMs()) || remainingMs() >= 55_000);
                    console.log(`  🔍 [Smart Trim] provider=${provider.name} | videoDur=${Math.round(videoDuration)}s | sceneDur=${Math.round(sceneDuration)}s | eligible=${smartTrimEligible}${strictRawShortSegmentEligible ? ' | short exact-source scan' : ''} | omniAvailable=${omniAvailable}${attempt >= segmentAttempts ? ' (segment budget for provider used)' : ''} | prescore=${providerPrescores}`);

                    if (smartTrimEligible && useOmni && smartStartTime === null && !reserveSceneOmni(segmentFrameNeed, `${provider.name} smart trim candidate ${attempt + 1}`)) {
                        console.log(`  [Smart Trim] Skipped - scene Omni cap reached`);
                    } else if (smartTrimEligible && useOmni && smartStartTime === null) {
                        try {
                            // Prefer direct stream URLs that ffmpeg can seek into
                            // (Reddit permalinks need yt-dlp, but fallback_url is a direct DASH stream)
                            let segUrl = smartSegmentUrl;
                            if (!segUrl && provider.getStreamUrl) {
                                console.log(`  🔍 [Smart Trim] Resolving stream URL via ${provider.name}...`);
                                segUrl = await provider.getStreamUrl(selected.url);
                            }
                            if (!segUrl) segUrl = selected.url;
                            smartSegmentUrl = segUrl;
                            console.log(`  🔍 [Smart Trim] Sending ${clipAnalyzer.getFramesBudgetInfo ? clipAnalyzer.getFramesBudgetInfo() : '?'} frames to Omni for segment selection | URL: ${segUrl.substring(0, 80)}...`);
                            const segResult = await clipAnalyzer.findBestSegment(
                                segUrl,
                                videoDuration,
                                sceneDuration,
                                keyword,
                                {
                                    sceneText: scene?.text || '',
                                    niche: nicheId || '',
                                    videoTopic: _videoTopic(),
                                    theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                    tone: scriptContextRef?.tone || '',
                                    mood: scriptContextRef?.mood || '',
                                    entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                    entityContext,
                                    mediaAgent: mediaAgentPlan,
                                    mediaHunter: hunterProfile,
                                    maxSegmentFrames: segmentFrameNeed,
                                    allowShortSource: strictRawShortSegmentEligible,
                                    allowOmniReserve,
                                    priorityChannel: providerKey === 'youtube' && youtubeChannelScope,
                                }
                            );
                            if (segResult && segResult.startTime !== null) {
                                smartStartTime = segResult.startTime;
                                smartSegmentResult = segResult;
                                console.log(`  🎯 [Smart Trim] Omni picked START=${Math.round(smartStartTime)}s (reason: ${segResult.reason || 'best segment'}) | keyword="${keyword}"`);
                            } else {
                                console.log(`  [Smart Trim] Omni returned no segment - ${strictRawSegmentHunt ? 'trying provider trim under final vision guard' : 'falling back to provider trim'}`);
                                if (strictRawSegmentHunt) {
                                    _recordMediaProvider(scene, {
                                        provider: provider.name,
                                        key: providerKey,
                                        mediaType,
                                        query: searchQuery,
                                        status: 'info',
                                        reason: 'segment hunt found no clean raw window; trying provider trim under final vision guard',
                                        attempt: attempt + 1,
                                    });
                                }
                            }
                        } catch (e) {
                            console.log(`  ⚠️ [Smart Trim] Failed: ${e.message}${strictRawSegmentHunt ? ' — trying provider trim as last resort' : ' — falling back to dumb trim'}`);
                            if (_isPermanentMediaFailure(e)) {
                                _rememberStructuralRejectedResult(selected, e.message, {
                                    providerKey,
                                    permanent: true,
                                });
                            } else if (_isTimeoutMediaFailure(e)) {
                                _rememberStructuralRejectedResult(selected, `timeout: ${e.message}`, {
                                    providerKey,
                                    strike: true,
                                });
                            }
                        }
                    } else if (smartTrimEligible && !useOmni) {
                        const reason = attempt >= segmentAttempts
                            ? 'segment attempts used'
                            : (!Number.isFinite(remainingMs()) || remainingMs() >= 55_000)
                                ? 'no Qwen/Gemini key or budget exhausted'
                                : `scene deadline (${Math.round(remainingMs() / 1000)}s left)`;
                        console.log(`  ⏭️ [Smart Trim] Skipped — ${reason}`);
                    }

                    const dumbTrimClipDuration = Math.ceil(sceneDuration) + 2;
                    const dumbTrimProbeEligible = mediaType === 'video'
                        && smartStartTime === null
                        && videoDuration > dumbTrimClipDuration + 5
                        && LIGHTWEIGHT_TRIM_PROVIDER_KEYS.has(providerKey)
                        && typeof clipAnalyzer.pickLightweightTrimStart === 'function';
                    if (dumbTrimProbeEligible) {
                        if (!hasSceneBudget(DUMB_TRIM_PROBE_MIN_BUDGET_MS, `${provider.name} dumb-trim probe`)) {
                            console.log(`  [Dumb Trim Probe] Skipped by deadline; provider legacy offset may be used`);
                        } else {
                            try {
                                let probeUrl = smartSegmentUrl;
                                if (!probeUrl && provider.getStreamUrl) {
                                    console.log(`  [Dumb Trim Probe] Resolving stream URL via ${provider.name}...`);
                                    probeUrl = await provider.getStreamUrl(selected.url);
                                }
                                if (!probeUrl) probeUrl = selected.url;
                                smartSegmentUrl = probeUrl;

                                console.log(`  [Dumb Trim Probe] Scoring 20/40/60% candidate starts with NVIDIA before download`);
                                const trimProbe = await clipAnalyzer.pickLightweightTrimStart(
                                    probeUrl,
                                    videoDuration,
                                    dumbTrimClipDuration,
                                    keyword,
                                    {
                                        sceneText: scene?.text || '',
                                        niche: nicheId || '',
                                        videoTopic: _videoTopic(),
                                        theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                        tone: scriptContextRef?.tone || '',
                                        mood: scriptContextRef?.mood || '',
                                        entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                        entityContext,
                                        mediaAgent: mediaAgentPlan,
                                        mediaHunter: hunterProfile,
                                        sourceTitle: selectedTitle,
                                        sourceUrl: selectedSourceUrl,
                                    }
                                );

                                if (trimProbe && Number.isFinite(Number(trimProbe.score))) {
                                    const probeScore = Number(trimProbe.score);
                                    const sampleSummary = Array.isArray(trimProbe.samples)
                                        ? trimProbe.samples
                                            .map(item => `${Math.round(Number(item.timestamp || 0))}s=${Number(item.score || 0).toFixed(1)}`)
                                            .join(', ')
                                        : '';
                                    if (probeScore < DUMB_TRIM_MIN_SCORE) {
                                        const reason = `dumb trim probe ${probeScore}/10: ${trimProbe.reason || 'best sampled start was weak'}`;
                                        console.log(`  [Dumb Trim Probe] Rejected before download (${_short(reason, 110)}${sampleSummary ? ` | ${sampleSummary}` : ''})`);
                                        const isTopicMapCandidate = _isCandidateTopicAccurateMap(selected, scene, hunterProfile, {
                                            providerName: provider?.name,
                                            providerKey,
                                            query: searchQuery,
                                            videoTopic: _videoTopic(),
                                        });
                                        if (!isTopicMapCandidate) {
                                            _blacklistUrl(dlUrl, probeScore, reason);
                                        } else {
                                            console.log(`  🗺️  Skipping blacklist — topic-accurate map URL stays usable for later map scenes`);
                                        }
                                        visionRejections.push(reason);
                                        _recordMediaProvider(scene, {
                                            provider: provider.name,
                                            key: providerKey,
                                            mediaType,
                                            query: searchQuery,
                                            status: 'rejected',
                                            reason,
                                            attempt: attempt + 1,
                                            selected,
                                        });
                                        _rememberSceneRejectedResult(scene, selected, reason);
                                        continue;
                                    }

                                    smartStartTime = Math.max(0, Number(trimProbe.startTime || 0));
                                    smartSegmentResult = {
                                        startTime: smartStartTime,
                                        confidence: Math.max(0.55, Math.min(0.95, probeScore / 10)),
                                        reason: `lightweight dumb-trim probe ${probeScore}/10${trimProbe.reason ? `: ${trimProbe.reason}` : ''}`,
                                        lightweightTrimProbe: trimProbe,
                                    };
                                    console.log(`  [Dumb Trim Probe] Picked start=${Math.round(smartStartTime)}s (${probeScore}/10${sampleSummary ? ` | ${sampleSummary}` : ''})`);
                                } else {
                                    console.log(`  [Dumb Trim Probe] No usable probe scores; provider legacy offset may be used`);
                                }
                            } catch (e) {
                                console.log(`  [Dumb Trim Probe] Failed (${e.message}); provider legacy offset may be used`);
                            }
                        }
                    }

                    if (
                        strictRawSegmentHunt
                        && smartStartTime !== null
                        && PREVIEW_SCOUT_WINDOW_VALIDATION
                        && clipAnalyzer.validateSegmentWindow
                        && !selected._previewScoutWindowValidation
                    ) {
                        try {
                            if (!smartSegmentUrl && provider.getStreamUrl) {
                                console.log(`  [Smart Trim] Resolving stream URL for exact-window validation via ${provider.name}...`);
                                smartSegmentUrl = await provider.getStreamUrl(selected.url);
                            }
                            if (!smartSegmentUrl) smartSegmentUrl = selected.url;

                            if (!hasSceneBudget(PREVIEW_SCOUT_WINDOW_MIN_BUDGET_MS, `${provider.name} exact-window validation`)) {
                                console.log(`  [Smart Trim] Exact-window validation skipped by deadline; rejecting strict raw candidate instead of downloading blind`);
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: 'rejected',
                                    reason: 'not enough budget for exact-window validation',
                                    attempt: attempt + 1,
                                });
                                visionRejections.push('Exact-window validation skipped by deadline');
                                _rememberSceneRejectedResult(scene, selected, 'exact-window validation skipped by deadline');
                                continue;
                            }
                            const windowFrameNeed = _segmentWindowFrameNeed();
                            if (clipAnalyzer.hasOmniBudget && !clipAnalyzer.hasOmniBudget(windowFrameNeed, { allowReserve: allowOmniReserve })) {
                                const info = clipAnalyzer.getFramesBudgetInfo ? clipAnalyzer.getFramesBudgetInfo({ allowReserve: allowOmniReserve }) : 'budget unavailable';
                                console.log(`  [Smart Trim] Exact-window validation skipped by global Omni budget (${info}); rejecting strict raw candidate instead of downloading blind`);
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: 'rejected',
                                    reason: 'global Omni budget blocked exact-window validation',
                                    attempt: attempt + 1,
                                });
                                visionRejections.push('Exact-window validation blocked by global Omni budget');
                                _rememberSceneRejectedResult(scene, selected, 'exact-window validation blocked by global Omni budget');
                                continue;
                            }
                            if (!reserveSceneOmni(windowFrameNeed, `${provider.name} exact-window validation`)) {
                                // Scene Omni cap exhausted by earlier candidates. Instead of hard-
                                // rejecting blindly, rescue scout-confident segments (>=threshold)
                                // by skipping exact-window and letting post-download vision be the
                                // arbiter. Matches the Preview Scout rescue at line ~3041.
                                const smartConfidence = Number(smartSegmentResult?.confidence || 0);
                                if (smartConfidence >= STRICT_RAW_SEGMENT_DEADLINE_ACCEPT_CONFIDENCE) {
                                    console.log(`  [Smart Trim] Exact-window validation skipped by scene Omni cap; rescuing scout-confident segment (${smartConfidence.toFixed(2)}) — post-download vision will decide`);
                                    selected._previewScoutWindowValidation = {
                                        ok: true,
                                        skipped: true,
                                        score: 0,
                                        reason: 'scene Omni cap (rescued by scout confidence)',
                                    };
                                } else {
                                    console.log(`  [Smart Trim] Exact-window validation skipped by scene Omni cap; rejecting strict raw candidate instead of downloading blind`);
                                    _recordMediaProvider(scene, {
                                        provider: provider.name,
                                        key: providerKey,
                                        mediaType,
                                        query: searchQuery,
                                        status: 'rejected',
                                        reason: 'scene Omni cap blocked exact-window validation',
                                        attempt: attempt + 1,
                                    });
                                    visionRejections.push('Exact-window validation blocked by scene Omni cap');
                                    _rememberSceneRejectedResult(scene, selected, 'exact-window validation blocked by scene Omni cap');
                                    continue;
                                }
                            }

                            // If we rescued via scout-confidence above, _previewScoutWindowValidation
                                // is already set to { ok:true, skipped:true } and we skip the AI call.
                            const windowValidation = selected._previewScoutWindowValidation
                                ? selected._previewScoutWindowValidation
                                : await clipAnalyzer.validateSegmentWindow(
                                smartSegmentUrl,
                                videoDuration,
                                smartStartTime,
                                sceneDuration,
                                keyword,
                                {
                                    sceneText: scene?.text || '',
                                    niche: nicheId || '',
                                    videoTopic: _videoTopic(),
                                    theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                    tone: scriptContextRef?.tone || '',
                                    mood: scriptContextRef?.mood || '',
                                   entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                   entityContext,
                                   mediaAgent: mediaAgentPlan,
                                   mediaHunter: hunterProfile,
                                   sourceTitle: selectedTitle,
                                   sourceUrl: selectedSourceUrl,
                                   sourceProvider: provider?.name || '',
                                   allowOmniReserve,
                                   priorityChannel: providerKey === 'youtube' && youtubeChannelScope,
                               }
                            );

                            if (!windowValidation || !windowValidation.ok) {
                                const reason = windowValidation?.reason || 'exact window did not validate';
                                console.log(`  [Smart Trim] Exact window rejected before download (${_short(reason, 90)})`);
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: 'rejected',
                                    reason: `exact-window rejected: ${reason}`,
                                    attempt: attempt + 1,
                                    selected,
                                });
                                visionRejections.push(`Exact-window rejected: ${reason}`);
                                _rememberSceneRejectedResult(scene, selected, `exact-window rejected: ${_short(reason, 120)}`);
                                if (queueNextSmartWindow(`exact-window rejected: ${_short(reason, 80)}`)) {
                                    continue;
                                }
                                continue;
                            }

                            console.log(`  [Smart Trim] Exact window passed before download (${windowValidation.score || '?'} / 10)`);
                            smartSegmentResult = {
                                ...(smartSegmentResult || {}),
                                windowValidation,
                            };
                        } catch (e) {
                            console.log(`  [Smart Trim] Exact-window validation failed (${e.message}); rejecting strict raw candidate`);
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: 'rejected',
                                reason: `exact-window validation failed: ${e.message}`,
                                attempt: attempt + 1,
                                selected,
                            });
                            visionRejections.push(`Exact-window validation failed: ${e.message}`);
                            _rememberSceneRejectedResult(scene, selected, `exact-window validation failed: ${_short(e.message, 120)}`);
                            if (_isPermanentMediaFailure(e)) {
                                _rememberStructuralRejectedResult(selected, e.message, {
                                    providerKey,
                                    permanent: true,
                                });
                            } else if (_isTimeoutMediaFailure(e)) {
                                _rememberStructuralRejectedResult(selected, `timeout: ${e.message}`, {
                                    providerKey,
                                    strike: true,
                                });
                            }
                            continue;
                        }
                    }

                    const protectPromisingDownload = strictRawSegmentHunt && mediaType === 'video';
                    let candidateWasSegmentHunted = smartStartTime !== null;

                    if (protectPromisingDownload) {
                        _extendSceneDeadline(scene, smartStartTime !== null ? 75_000 : 45_000, `${provider.name} strict raw video candidate`);
                    }

                    if (isAborted()) { console.log(`  ⏱️ Scene aborted — skipping download`); return null; }
                    if (!hasSceneBudget(mediaType === 'image' ? imageDownloadBudgetMs : 18_000, `${provider.name} download`)) break;
                    _beginInFlight(scene, `${provider.name} candidate ${attempt + 1} (download+scoring)`, (
                        protectPromisingDownload
                            ? { minRemainingMs: 90_000, extraCapMs: 120_000 }
                            : {}
                    ));
                    console.log(`  ⬇️  [${provider.name}] Downloading${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}...`);
                    const downloadOptions = { duration: sceneDuration, keyword: keyword, _directVideoUrl: selected._directVideoUrl || null, _cachedMeta: selected._cachedMeta || selected._meta || null, _fallbackUrl: selected._fallbackUrl || null, _smartStartTime: smartStartTime, sceneText: scene?.text || '', niche: nicheId || '', videoTopic: scriptContextRef?.summary || '', theme: scriptContextRef?.themeId || scriptContextRef?.theme || '', entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []), mediaAgent: mediaAgentPlan, mediaHunter: hunterProfile, sourceTitle: selectedTitle, sourceUrl: selectedSourceUrl, sourceDuration: Number(selected.duration) > 0 ? Number(selected.duration) : null, abortSignal, deadlineAt: scene?._deadlineAt || 0 };
                    let finalPath = null;
                    if (reusableMemoryAssetPath) {
                        finalPath = _copyReusableMediaMemoryAsset(selected, outputPath, provider.mediaType || mediaType);
                        console.log(`  [Media Memory] reused local asset for ${provider.name}: ${path.basename(reusableMemoryAssetPath)} -> ${path.basename(finalPath)}`);
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status: 'info',
                            reason: `reused media memory asset ${path.basename(reusableMemoryAssetPath)}`,
                            attempt: attempt + 1,
                            selected,
                            path: finalPath,
                        });
                    } else {
                        finalPath = await provider.download(selected.url, outputPath, downloadOptions);
                    }
                    if (Number.isFinite(Number(downloadOptions._smartStartTimeUsed))) {
                        smartStartTime = Math.max(0, Number(downloadOptions._smartStartTimeUsed));
                        selected._smartStartTimeUsed = smartStartTime;
                        candidateWasSegmentHunted = true;
                    }
                    if (downloadOptions._smartSegmentPick && !smartSegmentResult) {
                        smartSegmentResult = downloadOptions._smartSegmentPick;
                    }
                    if (Array.isArray(downloadOptions._smartSegmentAlternates) && downloadOptions._smartSegmentAlternates.length > 0) {
                        selected._lastSmartSegmentAlternates = downloadOptions._smartSegmentAlternates;
                        if (!Array.isArray(selected._smartSegmentAlternates) || selected._smartSegmentAlternates.length === 0) {
                            selected._smartSegmentAlternates = downloadOptions._smartSegmentAlternates;
                        }
                    }
                    _assertDownloadedFile(finalPath, provider.mediaType || mediaType, provider.name);
                    const finalExt = path.extname(finalPath);
                    console.log(`  ✅ [${provider.name}] Downloaded: ${path.basename(finalPath)}`);

                    // Global vertical-video reject. Storyblocks "Vertical Video"
                    // series, YouTube Shorts, and similar deliver 1080x1920 portrait
                    // files that the search metadata may mis-report as landscape.
                    // Reddit is EXEMPT in most cases — vertical clips are native to
                    // that platform and the renderer crops/zooms to fit. BUT for
                    // template-background scenes (footage plays full-frame behind
                    // a UI card), vertical is NEVER acceptable — a center-cropped
                    // portrait loses half the composition. Reddit exemption is
                    // suppressed for those scenes.
                    const _videoExtsForProbe = new Set(['.mp4', '.webm', '.mkv', '.mov']);
                    const _isTemplateBackgroundSerial = mediaAgentPlan?.role === 'template-background'
                        || hunterProfile?.templateBackground === true;
                    const _allowVerticalForProvider = providerKey === 'reddit' && !_isTemplateBackgroundSerial;
                    // Measure EVERY downloaded file, image included. The race path
                    // already did this; the serial path used to probe video only, so a
                    // still's size stayed whatever the site claimed — and the two stock
                    // APIs claim the ORIGINAL's size while serving a smaller rendition.
                    // The vertical REJECT below stays video-only: portrait stills are
                    // deliberately kept (framing crops/floats them).
                    const _isVideoFileForProbe = _videoExtsForProbe.has(finalExt.toLowerCase());
                    if (fs.existsSync(finalPath)) {
                        try {
                            const { probeDimensions: _probeDims } = require('../agents/smart-segment');
                            const _ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
                            const dims = await _probeDims(_ffmpegPath, finalPath);
                            if (_isVideoFileForProbe && !_allowVerticalForProvider && dims && dims.width > 0 && dims.height > 0 && dims.height > dims.width) {
                                const _tplTag = _isTemplateBackgroundSerial ? ' [template-background]' : '';
                                console.log(`  ⛔ Vertical video rejected${_tplTag} (${dims.width}x${dims.height}) — unusable on 16:9 canvas`);
                                _blacklistUrl(dlUrl, 1, `vertical ${dims.width}x${dims.height}`);
                                _rememberStructuralRejectedResult(selected, `vertical ${dims.width}x${dims.height}`, {
                                    providerKey,
                                    permanent: true,
                                });
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: 'rejected',
                                    reason: `vertical video ${dims.width}x${dims.height}`,
                                    attempt: attempt + 1,
                                    url: dlUrl,
                                    selected,
                                });
                                _rememberSceneRejectedResult(scene, selected, `vertical ${dims.width}x${dims.height}`);
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                            }
                            // Stamp real dimensions on candidate so downstream
                            // logic (renderer hints, vision crop) sees the truth
                            // instead of the provider's claimed 1920x1080.
                            if (dims && dims.width > 0 && dims.height > 0) {
                                selected.width = dims.width;
                                selected.height = dims.height;
                                if (dims.codec) selected._codec = dims.codec;
                            }
                        } catch (_) { /* probe failure is non-fatal — proceed */ }
                    }

                    // Stamp ffprobe duration on candidates whose search step didn't
                    // surface it (Storyblocks subscribed scrape has no duration meta).
                    // Without this stamp, Smart Trim sees videoDur=0s and silently
                    // skips segment hunting on retries; downstream scoreDownloadedVideo
                    // also benefits from a known duration when picking sample windows.
                    if (_videoExtsForProbe.has(finalExt.toLowerCase())
                        && !(selected._cachedMeta?.duration > 0)
                        && !(selected._meta?.duration > 0)
                        && !(selected.duration > 0)) {
                        try {
                            const { probeDuration: _probeDur } = require('../agents/smart-segment');
                            const _ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
                            const probed = await _probeDur(_ffmpegPath, finalPath);
                            if (Number.isFinite(probed) && probed > 0) {
                                selected._cachedMeta = { ...(selected._cachedMeta || {}), duration: probed };
                                selected.duration = probed;
                                console.log(`  [${provider.name}] ffprobe duration: ${Math.round(probed)}s (search lacked duration meta)`);
                            }
                        } catch (_) { /* non-fatal — downstream falls back to scene duration */ }
                    }

                    let acceptedMediaHash = null;
                    const duplicateMedia = _checkAcceptedMediaDuplicate(finalPath);
                    acceptedMediaHash = duplicateMedia.hash;
                    if (duplicateMedia.duplicate) {
                        const prior = duplicateMedia.duplicate;
                        console.log(`  [${provider.name}] Duplicate media already used by scene ${prior.sceneIndex} (${prior.provider}); trying next result...`);
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status: 'rejected',
                            reason: `duplicate media from scene ${prior.sceneIndex}`,
                            attempt: attempt + 1,
                            url: dlUrl,
                            selected,
                        });
                        _rememberSceneRejectedResult(scene, selected, `duplicate media from scene ${prior.sceneIndex}`);
                        try { fs.unlinkSync(finalPath); } catch {}
                        continue;
                    }

                    // Post-download segment quality check for video files from providers
                    // that DON'T do their own pre-download smart segment scoring.
                    // YouTube & News already pick the best segment before downloading.
                    const isVideo = ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                    let preliminarySegmentScore = 0;
                    const segmentScoreBudgetMs = candidateWasSegmentHunted ? 14_000 : 24_000;
                    if (_visionEnabled && isVideo && !PRESCORE_PROVIDERS.has(providerKey) && fs.existsSync(finalPath) && hasSceneBudget(segmentScoreBudgetMs, `${provider.name} segment scoring`)) {
                        const segResult = await scoreDownloadedVideo(finalPath, {
                            keyword,
                            context: {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: _videoTopic(),
                                theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                entityContext,
                                tone: scriptContextRef?.tone || '',
                                mood: scriptContextRef?.mood || '',
                                mediaAgent: mediaAgentPlan,
                                mediaHunter: hunterProfile,
                            },
                            providerTag: provider.name,
                        });
                        preliminarySegmentScore = Math.max(
                            Number(segResult?.bestScore || 0),
                            Number(segResult?.score || 0)
                        );
                        if (segResult.shouldRetrim && attempt < maxTries - 1) {
                            console.log(`  🎯 [${provider.name}] Video segment scored poorly — trying next result...`);
                            // Topic-accurate maps from premium stock score low here when the
                            // scene wants real footage (vision says "no real vessels"). The URL
                            // itself is still a valid map asset for downstream map scenes —
                            // reject for this scene only, don't poison the global blacklist.
                            const isTopicMapCandidate = _isCandidateTopicAccurateMap(selected, scene, hunterProfile, {
                                providerName: provider?.name,
                                providerKey,
                                query: searchQuery,
                                videoTopic: _videoTopic(),
                            });
                            const segmentParseError = !!segResult?.parseError && !segResult?.scoreSanity?.adjusted;
                            if (!isTopicMapCandidate && !segmentParseError) {
                                _blacklistUrl(dlUrl, segResult.bestScore || 0, 'Poor video segment');
                            } else if (segmentParseError) {
                                console.log(`  [Score Sanity] skipping blacklist - low score came from an unrescued vision parse issue`);
                            } else {
                                console.log(`  🗺️  Skipping blacklist — topic-accurate map URL stays usable for later map scenes`);
                            }
                            visionRejections.push(`Poor video segment (score: ${segResult.bestScore}/10)`);
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: 'rejected',
                                reason: `poor segment score ${segResult.bestScore || 0}/10`,
                                attempt: attempt + 1,
                                url: dlUrl,
                                selected,
                            });
                            _rememberSceneRejectedResult(scene, selected, `poor segment score ${segResult.bestScore || 0}/10`);
                            try { fs.unlinkSync(finalPath); } catch {}
                            continue;
                        }
                    }

                    // Inline vision scoring — ALL providers get 3-frame post-download check
                    // (YouTube does pre-download scoring too, but mid-clip cuts can still slip through)
                    // Storyblocks preview clips (_isPreview=true) wear a giant watermark that
                    // crashes vision scores; bypass scoring for them so the smoke-test pipeline
                    // actually accepts the clip. The subscribed (clean) URLs will not set this flag.
                    const isPreviewClip = !!selected._isPreview;
                    let visionScore = 0;
                    let visionDescription = '';
                    // Surfaces the topic-map rescue from _scoreDownloadedMedia so the
                    // deep-analysis blend + post-blend penalty don't drag the rescued
                    // clip back below threshold. The rescue already concluded that the
                    // clip's "text overlay / packaged graphic" characteristics are
                    // expected for a topic-accurate map; Omni rediscovering those
                    // findings must not double-jeopardy them.
                    let mapRescued = false;
                    let verifiedSegmentLocked = candidateWasSegmentHunted
                        && _segmentWindowIsVerified(selected?._previewScoutWindowValidation || null);
                    let segmentDeadlineRescue = false;
                    let segmentDeadlineRescueConfidence = 0;
                    const visionBudgetMs = mediaType === 'image' ? imageVisionBudgetMs : (candidateWasSegmentHunted ? 12_000 : 20_000);
                    let finalVisionSkippedForBudget = false;
                    const shouldRunFinalVision = _visionEnabled && fs.existsSync(finalPath) && !isPreviewClip;
                    const hasFinalVisionBudget = shouldRunFinalVision && hasSceneBudget(visionBudgetMs, `${provider.name} vision scoring`);

                    // ── ffmpeg pre-screen ──
                    // 1-2s structural check on the downloaded video. Catches frozen
                    // slideshows, near-black footage, and Ken-Burns stills BEFORE
                    // paying ~15-25s of Qwen-VL scoring. Skip for preview clips
                    // (watermark-dominated) and verified-segment-locked clips
                    // (Preview Scout already validated their content with Omni).
                    const _videoExtsForPrescreen = new Set(['.mp4', '.webm', '.mkv', '.mov']);
                    if (!isPreviewClip
                        && !verifiedSegmentLocked
                        && _videoExtsForPrescreen.has(finalExt.toLowerCase())
                        && fs.existsSync(finalPath)) {
                        try {
                            const screen = await prescreenClip(finalPath);
                            if (!screen.acceptable) {
                                console.log(`  ⛔ Pre-screen rejected (${provider.name}): ${screen.reason}`);
                                _blacklistUrl(dlUrl, 1, `pre-screen: ${screen.reason}`);
                                _rememberStructuralRejectedResult(selected, `pre-screen: ${screen.reason}`, {
                                    providerKey,
                                    permanent: true,
                                });
                                visionRejections.push(`Pre-screen: ${screen.reason}`);
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: 'rejected',
                                    reason: `pre-screen: ${screen.reason}`,
                                    attempt: attempt + 1,
                                    url: dlUrl,
                                    selected,
                                });
                                _rememberSceneRejectedResult(scene, selected, `pre-screen: ${screen.reason}`);
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                            }
                            if (!screen.skipped) {
                                console.log(`  ✓ Pre-screen passed (${screen.reason})`);
                            }
                        } catch (e) {
                            // Pre-screen failure is non-fatal — fall through to AI scoring.
                            console.log(`  ⚠️ Pre-screen threw (${e.message?.slice(0, 80)}) — proceeding to AI scoring`);
                        }
                    }

                    if (isPreviewClip) {
                        visionScore = 7; // neutral pass score; clip can't be vision-judged through the watermark
                        console.log(`  🩹 Preview clip (${provider.name}) — bypassing vision/deep checks; watermark would dominate score`);
                    }
                    // Trust the Preview Scout: if it already verified this exact segment
                    // (Omni multi-frame analysis on the pre-download window), don't re-run
                    // post-download vision. Saves Omni budget AND prevents the post-download
                    // Qwen-VL pass from contradicting a window the scout already cleared with
                    // higher-fidelity Omni analysis. Apply BEFORE the post-download vision call.
                    if (verifiedSegmentLocked && !isPreviewClip) {
                        const winScore = Number(selected?._previewScoutWindowValidation?.score || 0);
                        visionScore = Math.max(visionScore, winScore >= 7 ? winScore : 7);
                        visionDescription = String(selected?._previewScoutWindowValidation?.description || selected?._previewScoutWindowValidation?.reason || selected?._previewScoutReason || '');
                        console.log(`  🔒 Preview Scout segment verified (${winScore || '?'}/10) — skipping post-download vision (trust verified window)`);
                    } else if (hasFinalVisionBudget) {
                        // Per-URL vision cache: reuse the prior AI verdict for this
                        // exact URL+segment so re-runs become deterministic instead
                        // of flipping on Qwen-VL temperature noise.
                        const _cacheStart = (typeof smartStartTime === 'number' && Number.isFinite(smartStartTime))
                            ? smartStartTime
                            : 0;
                        const _visionCacheScope = visionCache.makeScope ? visionCache.makeScope({
                            keyword,
                            sceneText: scene?.text || '',
                            mediaType,
                            sourceHint,
                            sourceProvider: provider?.name || '',
                            mediaAgent: mediaAgentPlan?.lane || mediaAgentPlan?.mode || mediaAgentPlan?.source || '',
                            mediaHunter: hunterProfile?.target || hunterProfile?.domain || hunterProfile?.mode || '',
                        }) : null;
                        const cachedVision = visionCache.get('vision', dlUrl, _cacheStart, _visionCacheScope);
                        let visionResult;
                        if (cachedVision) {
                            visionResult = {
                                score: cachedVision.score,
                                description: cachedVision.description || '',
                                mapRescued: !!cachedVision.mapRescued,
                                penaltyReasons: cachedVision.penaltyReasons || [],
                            };
                            console.log(`  💾 Vision cache hit (${dlUrl.substring(0, 60)}#${Math.round(_cacheStart)}s) → ${visionResult.score}/10`);
                        } else {
                            visionResult = await _scoreDownloadedMedia(finalPath, finalExt, keyword, {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: _videoTopic(),
                                theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                entityContext,
                                tone: scriptContextRef?.tone || '',
                                mood: scriptContextRef?.mood || '',
                                mediaAgent: mediaAgentPlan,
                                mediaHunter: hunterProfile,
                                sourceTitle: selectedTitle,
                                sourceUrl: selectedSourceUrl,
                                sourceProvider: provider?.name || '',
                                mediaType,
                                sourceHint,
                                keyword,
                                // Judge against the full request, not the shortened query.
                                visualIntent: fullVisualIntent,
                            });
                            if (visionResult) {
                                visionCache.set('vision', dlUrl, _cacheStart, {
                                    score: visionResult.score,
                                    description: visionResult.description || '',
                                    mapRescued: !!visionResult.mapRescued,
                                    penaltyReasons: visionResult.penaltyReasons || [],
                                }, _visionCacheScope);
                                // Merged path: same AI call already produced the deep
                                // analysis. Pre-fill the deep cache so the later deep
                                // block hits cache and skips a duplicate AI call.
                                if (visionResult._clipAnalysis) {
                                    const _ca = visionResult._clipAnalysis;
                                    visionCache.set('deep', dlUrl, _cacheStart, {
                                        score: _ca.score,
                                        description: _ca.description || '',
                                        issues: _ca.issues || [],
                                        motion: _ca.motion || 'unknown',
                                        trimSuggestion: _ca.trimSuggestion || null,
                                    }, _visionCacheScope);
                                }
                            }
                        }
                        if (visionResult) {
                            const { score, description } = visionResult;
                            visionDescription = String(description || '');
                            const finalVisionProblemText = `${description || ''} ${(visionResult.penaltyReasons || []).join(' ')}`.trim();
                            visionScore = score;
                            mapRescued = !!visionResult.mapRescued;
                            // Storyblocks topic-map rescues are valid assets, not a quota.
                            // Set TOPIC_MAP_RESCUE_CAP only when deliberately testing map overuse.
                            const rawRescueCap = parseInt(process.env.TOPIC_MAP_RESCUE_CAP || '0', 10);
                            const rescueCap = Number.isFinite(rawRescueCap) && rawRescueCap > 0 ? rawRescueCap : 0;
                            const rescueCountSoFar = Number(scriptContextRef?._topicMapRescueCount || 0);
                            const rescueWouldFire = mapRescued && score <= 4;
                            if (rescueCap > 0 && rescueWouldFire && rescueCountSoFar >= rescueCap) {
                                console.log(`  🧢 Topic-map rescue cap hit (${rescueCountSoFar}/${rescueCap}) — rejecting this clip so image fallback can run`);
                                mapRescued = false;
                            }
                            console.log(`  👁️ Vision: ${score}/10 → ${description}${mapRescued ? ' [topic-map rescued]' : ''}`);
                            // Topic-map rescued clips bypass the basic-vision early reject.
                            // The rescue inside _scoreDownloadedMedia already confirmed the
                            // map depicts the scene's topic and exempted the inner penalty;
                            // a downstream score ≤4 here would mean some other rule (future
                            // penalty, scoring drift) clawed it back. Honor the rescue.
                            if (mapRescued && score <= 4) {
                                visionScore = Math.max(visionScore, 7);
                                console.log(`  🗺️  Rescue floor applied — vision dropped to ${score}/10 but topic-map rescue holds at ≥7`);
                                if (scriptContextRef) {
                                    scriptContextRef._topicMapRescueCount = rescueCountSoFar + 1;
                                }
                            }
                            // Divergence guard: when the post-download score
                            // came back strong (≥8) but the final vision came
                            // back weak (≤5), the post-download likely matched
                            // metaphorically ("symbolizes durability") rather
                            // than literally. Two independent vision calls
                            // disagreeing by 3+ points → trust the lower one.
                            // Skips when topic-map rescued or for clips already
                            // accepted via verified segment lock.
                            if (!mapRescued && preliminarySegmentScore >= 8 && score <= 5 && (preliminarySegmentScore - score) >= 3) {
                                console.log(`  ⚠️ Vision divergence: post-download ${preliminarySegmentScore}/10 vs final ${score}/10 — final wins, rejecting metaphorical match`);
                                if (!PRESCORE_PROVIDERS.has(providerKey)) {
                                    _blacklistUrl(dlUrl, score, `divergence ${preliminarySegmentScore}↘${score}: ${description}`);
                                }
                                visionRejections.push(`divergence ${preliminarySegmentScore}/10 vs ${score}/10: ${description}`);
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: 'rejected',
                                    reason: `vision divergence ${preliminarySegmentScore}↘${score}: ${description}`,
                                    attempt: attempt + 1,
                                    url: dlUrl,
                                    selected,
                                });
                                _rememberSceneRejectedResult(scene, selected, `vision divergence ${preliminarySegmentScore}↘${score}: ${description}`);
                                consecutiveLowScores++;
                                if (queueNextSmartWindow(`vision divergence ${preliminarySegmentScore}↘${score}`)) {
                                    try { fs.unlinkSync(finalPath); } catch {}
                                    continue;
                                }
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                            }
                            if (!mapRescued && score <= 4) {
                                const verifiedSegmentLock = candidateWasSegmentHunted
                                    && _canVerifiedSegmentLockLowVision(
                                        finalVisionProblemText || description,
                                        keyword,
                                        scene?.text,
                                        hunterProfile,
                                        smartSegmentResult,
                                        selected?._previewScoutWindowValidation || null
                                    );
                                if (verifiedSegmentLock) {
                                    verifiedSegmentLocked = true;
                                    visionScore = Math.max(7, score);
                                    consecutiveLowScores = 0;
                                    const lockLabel = selected._previewScoutSegment ? 'Preview Scout verified segment lock' : 'Smart Segment verified lock';
                                    const rescueLabel = lockLabel;
                                    console.log(`  ✅ ${rescueLabel}: later vision scored ${score}/10, but the pre-download segment still matches clean raw footage`);
                                } else {
                                console.log(`  ❌ Score too low (${score}/10), trying next result...`);
                                if (!PRESCORE_PROVIDERS.has(providerKey)) {
                                    _blacklistUrl(dlUrl, score, description);
                                }
                                visionRejections.push(description);
                                _recordMediaProvider(scene, {
                                    provider: provider.name,
                                    key: providerKey,
                                    mediaType,
                                    query: searchQuery,
                                    status: 'rejected',
                                    reason: `vision ${score}/10: ${description}`,
                                    attempt: attempt + 1,
                                    url: dlUrl,
                                    selected,
                                });
                                _rememberSceneRejectedResult(scene, selected, `vision ${score}/10: ${description}`);
                                consecutiveLowScores++;
                                if (queueNextSmartWindow(`vision ${score}/10`)) {
                                    try { fs.unlinkSync(finalPath); } catch {}
                                    continue;
                                }
                                // If 2 consecutive results all score ≤4, the keyword is the problem — bail early
                                const shouldKeepTryingStockShortlist = providerKey === 'storyblocks'
                                    && topicScoutResults.length > 0
                                    && results.length <= maxTries;
                                if (consecutiveLowScores >= 2 && attempt < maxTries - 1 && !shouldKeepTryingStockShortlist) {
                                    console.log(`  ⏩ 2 consecutive low scores — keyword "${keyword}" is likely unsearchable, skipping remaining attempts`);
                                    try { fs.unlinkSync(finalPath); } catch {}
                                    break;
                                }
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                                }
                            }
                            // Score is decent — reset low-score streak
                            consecutiveLowScores = 0;
                        }
                    } else if (shouldRunFinalVision) {
                        finalVisionSkippedForBudget = true;
                    }

                    // Deep clip analysis — Omni multimodal video understanding (optional)
                    // Runs AFTER basic vision pass. Sends 8 frames to Qwen Omni for holistic
                    // clip understanding: watermark detection, motion quality, content relevance.
                    // Only for video files, only if within frame budget.
                    let clipAnalysis = null;
                    const isVideoForAnalysis = ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                    const deepBudgetMs = candidateWasSegmentHunted ? 22_000 : 35_000;
                    // Per-clip hard-cap gate: if we already burned >35s on download+vision
                    // for THIS candidate, skip deep analysis. Vision verdict alone is enough
                    // to keep/reject and try the next candidate, which is far more useful
                    // than spending another 22-35s confirming what vision already saw.
                    const _deepCapTripped = _attemptOverHardCap(35_000);
                    if (_deepCapTripped) {
                        console.log(`  ⏱️ Per-clip cap (${Math.round(_attemptElapsedMs() / 1000)}s on this candidate) — skipping deep analysis, using vision verdict only`);
                    }
                    if (!isPreviewClip && !_deepCapTripped && isVideoForAnalysis && (clipAnalyzer.isClipAnalysisAvailable ? clipAnalyzer.isClipAnalysisAvailable() : clipAnalyzer.isAvailable()) && fs.existsSync(finalPath) && hasSceneBudget(deepBudgetMs, `${provider.name} deep clip analysis`)) {
                        try {
                            const { probeDuration: _probeDur } = require('../agents/smart-segment');
                            const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
                            const clipDur = await _probeDur(ffmpegPath, finalPath) || sceneDuration;
                            // Deep-clip cache: same URL+segment → reuse verdict.
                            const _deepCacheStart = (typeof smartStartTime === 'number' && Number.isFinite(smartStartTime))
                                ? smartStartTime
                                : 0;
                            const _deepCacheScope = visionCache.makeScope ? visionCache.makeScope({
                                keyword,
                                sceneText: scene?.text || '',
                                mediaType,
                                sourceHint,
                                sourceProvider: provider?.name || '',
                                mediaAgent: mediaAgentPlan?.lane || mediaAgentPlan?.mode || mediaAgentPlan?.source || '',
                                mediaHunter: hunterProfile?.target || hunterProfile?.domain || hunterProfile?.mode || '',
                            }) : null;
                            const cachedDeep = visionCache.get('deep', dlUrl, _deepCacheStart, _deepCacheScope);
                            if (cachedDeep) {
                                clipAnalysis = {
                                    score: cachedDeep.score,
                                    description: cachedDeep.description || '',
                                    issues: Array.isArray(cachedDeep.issues) ? cachedDeep.issues.slice() : [],
                                    motion: cachedDeep.motion || 'unknown',
                                    trimSuggestion: cachedDeep.trimSuggestion || null,
                                    raw: cachedDeep.raw || '',
                                };
                                console.log(`  💾 Deep-clip cache hit (${dlUrl.substring(0, 60)}#${Math.round(_deepCacheStart)}s) → ${clipAnalysis.score}/10`);
                            } else {
                                clipAnalysis = await clipAnalyzer.analyzeClip(finalPath, clipDur, keyword, {
                                    sceneText: scene?.text || '',
                                    niche: nicheId || '',
                                    videoTopic: _videoTopic(),
                                    entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                    entityContext,
                                    mediaAgent: mediaAgentPlan,
                                    mediaHunter: hunterProfile,
                                    sourceTitle: selectedTitle,
                                    sourceUrl: selectedSourceUrl,
                                    sourceProvider: provider?.name || '',
                                    visualIntent: fullVisualIntent,
                                });
                                if (clipAnalysis) {
                                    visionCache.set('deep', dlUrl, _deepCacheStart, {
                                        score: clipAnalysis.score,
                                        description: clipAnalysis.description || '',
                                        issues: clipAnalysis.issues || [],
                                        motion: clipAnalysis.motion || 'unknown',
                                        trimSuggestion: clipAnalysis.trimSuggestion || null,
                                    }, _deepCacheScope);
                                }
                            }
                            if (clipAnalysis) {
                                console.log(`  🎬 Clip Analysis: ${clipAnalysis.score}/10 | ${clipAnalysis.motion} motion | ${clipAnalysis.issues.length ? 'Issues: ' + clipAnalysis.issues.join(', ') : 'Clean'}`);
                                console.log(`     ${clipAnalysis.description}`);
                                const rejectThreshold = config.clipAnalyzer?.rejectThreshold || 3;
                                // Slideshow / Ken Burns / static-photos detector — these clips are
                                // NOT real footage, just panned stills. Permanently blacklist the URL
                                // so future builds skip it entirely instead of wasting download +
                                // AI scoring time only to reject via post-blend penalty. Map-rescued
                                // clips are exempt: maps legitimately use Ken Burns over a still.
                                if (!mapRescued && !verifiedSegmentLocked) {
                                    const _slideshowText = `${clipAnalysis.description || ''} ${(clipAnalysis.issues || []).join(' ')} ${clipAnalysis.motion || ''}`.toLowerCase();
                                    const _slideshowHit = /\b(slideshow|slide show|still photo|still photos|static photo|static photos|photo slideshow|photo montage|photograph montage|ken[- ]?burns)\b/i.test(_slideshowText);
                                    if (_slideshowHit) {
                                        console.log(`  ⛔ Slideshow/Ken-Burns detected — permanent blacklist (${dlUrl.substring(0, 80)})`);
                                        _blacklistUrl(dlUrl, 1, `slideshow/ken-burns: ${clipAnalysis.description}`);
                                        _rememberStructuralRejectedResult(selected, `slideshow/ken-burns: ${clipAnalysis.description?.substring(0, 120) || ''}`, {
                                            providerKey,
                                            permanent: true,
                                        });
                                        visionRejections.push(`Slideshow: ${clipAnalysis.description}`);
                                        _recordMediaProvider(scene, {
                                            provider: provider.name,
                                            key: providerKey,
                                            mediaType,
                                            query: searchQuery,
                                            status: 'rejected',
                                            reason: `slideshow/ken-burns: ${clipAnalysis.description}`,
                                            attempt: attempt + 1,
                                            url: dlUrl,
                                            selected,
                                        });
                                        _rememberSceneRejectedResult(scene, selected, `slideshow/ken-burns`);
                                        try { fs.unlinkSync(finalPath); } catch {}
                                        continue;
                                    }
                                }
                                // Topic-map rescued clips are intentionally exempt from the
                                // deep-analysis low-score reject: Omni reliably scores route
                                // maps 1-3/10 because of text overlays + Ken Burns zoom +
                                // AI-generated content, but those are inherent properties of
                                // a map, not signals of mismatch. The rescue already verified
                                // the map shows the scene's topic.
                                if (clipAnalysis.score <= rejectThreshold
                                    && !mapRescued
                                    && verifiedSegmentLocked
                                    && !_clipTextHasHardVisualProblem(`${clipAnalysis.description || ''} ${(clipAnalysis.issues || []).join(' ')}`, {
                                        sourceProvider: provider.name,
                                        keyword,
                                        sceneText: scene?.text || '',
                                        videoTopic: _videoTopic(),
                                        entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                        entityContext,
                                        mediaHunter: hunterProfile,
                                    })
                                    && !_strictRawDiscontinuityRejectReason(clipAnalysis, hunterProfile)) {
                                    visionScore = Math.max(visionScore, 7);
                                    clipAnalysis.score = rejectThreshold + 1;
                                    console.log(`  âœ… Verified segment lock held: deep analysis was low, but no hard visual problem was found`);
                                }
                                if (clipAnalysis.score <= rejectThreshold && !mapRescued) {
                                    console.log(`  ❌ Deep analysis too low (${clipAnalysis.score}/10 ≤ ${rejectThreshold}), trying next result...`);
                                    _blacklistUrl(dlUrl, clipAnalysis.score, clipAnalysis.description);
                                    visionRejections.push(`Deep: ${clipAnalysis.description}`);
                                    _recordMediaProvider(scene, {
                                        provider: provider.name,
                                        key: providerKey,
                                        mediaType,
                                        query: searchQuery,
                                        status: 'rejected',
                                        reason: `deep analysis ${clipAnalysis.score}/10: ${clipAnalysis.description}`,
                                        attempt: attempt + 1,
                                        url: dlUrl,
                                        selected,
                                    });
                                    _rememberSceneRejectedResult(scene, selected, `deep analysis ${clipAnalysis.score}/10: ${clipAnalysis.description}`);
                                    try { fs.unlinkSync(finalPath); } catch {}
                                    continue;
                                }
                                // Skip strict-raw continuity rejects for:
                                //   - topic-map rescued clips: this gate literally rejects "map,
                                //     graphic, animation, AI-generated content" — exactly the things
                                //     the rescue just verified are acceptable.
                                //   - verifiedSegmentLocked clips: Preview Scout already validated
                                //     the EXACT segment we'll use with Omni multi-frame analysis.
                                //     Deep clip analysis samples a wider span and can hit cuts that
                                //     don't actually exist inside the chosen 3s window — trusting it
                                //     over the scout would re-reject scout-approved clips for noise
                                //     elsewhere in the source video.
                                const rawDiscontinuity = _strictRawDiscontinuityRejectReason(clipAnalysis, hunterProfile);
                                const discontinuityReason = (mapRescued || verifiedSegmentLocked) ? null : rawDiscontinuity;
                                if (verifiedSegmentLocked && rawDiscontinuity) {
                                    console.log(`  🔒 Preview Scout segment lock holds: deep-analysis flagged "${_short(rawDiscontinuity, 80)}" but the verified window stays clean`);
                                }
                                if (discontinuityReason) {
                                    console.log(`  ⛔ Strict raw continuity reject: ${discontinuityReason}`);
                                    _blacklistUrl(dlUrl, Math.min(4, clipAnalysis.score || 4), discontinuityReason);
                                    visionRejections.push(`Continuity: ${discontinuityReason}`);
                                    _recordMediaProvider(scene, {
                                        provider: provider.name,
                                        key: providerKey,
                                        mediaType,
                                        query: searchQuery,
                                        status: 'rejected',
                                        reason: discontinuityReason,
                                        attempt: attempt + 1,
                                        url: dlUrl,
                                        selected,
                                    });
                                    _rememberSceneRejectedResult(scene, selected, discontinuityReason);
                                    try { fs.unlinkSync(finalPath); } catch {}
                                    continue;
                                }
                                // Semantic duplicate guard — Omni description vs prior accepted scenes.
                                // Catches near-identical visual content (e.g. two reposts of the same
                                // cargo-ship-bow POV) that pass byte-hash dedup because encoders differ.
                                // In default "warn" mode this is advisory only; URL/file-hash dedup is the
                                // hard precision guard. Description overlap is too fuzzy for generic B-roll.
                                const semDupe = _checkSemanticDuplicate(clipAnalysis.description);
                                if (semDupe) {
                                    const msg = `semantic similarity to scene ${semDupe.sceneIndex} (${(semDupe.ratio * 100).toFixed(0)}% word overlap, via ${semDupe.provider})`;
                                    if (_shouldRejectSemanticDuplicate()) {
                                        console.log(`  ⛔ Semantic duplicate of scene ${semDupe.sceneIndex} (${(semDupe.ratio * 100).toFixed(0)}% word overlap, via ${semDupe.provider}); trying next result...`);
                                        _blacklistUrl(dlUrl, clipAnalysis.score, `semantic dupe of scene ${semDupe.sceneIndex}`);
                                        visionRejections.push(`Semantic dupe of scene ${semDupe.sceneIndex}`);
                                        _recordMediaProvider(scene, {
                                            provider: provider.name,
                                            key: providerKey,
                                            mediaType,
                                            query: searchQuery,
                                            status: 'rejected',
                                            reason: `semantic duplicate of scene ${semDupe.sceneIndex} (${(semDupe.ratio * 100).toFixed(0)}% overlap)`,
                                            attempt: attempt + 1,
                                            url: dlUrl,
                                            selected,
                                        });
                                        _rememberSceneRejectedResult(scene, selected, `semantic duplicate of scene ${semDupe.sceneIndex}`);
                                        try { fs.unlinkSync(finalPath); } catch {}
                                        continue;
                                    }
                                    console.log(`  ⚠️ Semantic duplicate warning: ${msg}; accepting because URL/hash dedup did not match`);
                                }
                                // Upgrade or downgrade visionScore based on deep analysis
                                // Weighted blend: 40% basic vision + 60% deep analysis
                                if (mapRescued) {
                                    // Topic-accurate map already passed the rescue floor (7/10).
                                    // Omni's findings will rediscover "text overlays / packaged
                                    // graphic" because that's literally what a route map looks
                                    // like — blending with that 2/10 verdict would defeat the
                                    // whole point of the rescue. Hold the rescued floor.
                                    visionScore = Math.max(visionScore, 7);
                                } else if (visionScore > 0) {
                                    visionScore = Math.round(visionScore * 0.4 + clipAnalysis.score * 0.6);
                                } else {
                                    visionScore = clipAnalysis.score;
                                }
                                // Re-apply mismatch penalty with the deep-clip description + issues list.
                                // The blend alone can rescue a clip that's only "contextually" related
                                // (right country/mood but wrong subject) — this is the final gate.
                                // Skip entirely for topic-map rescued clips: every reason the
                                // penalty would fire (text overlay, packaged graphic, AI-generated)
                                // is exactly what makes a route map a map. The carve-out already
                                // verified the map shows the scene's topic.
                                const deepPenalty = (mapRescued || verifiedSegmentLocked)
                                    ? { score: visionScore, penalty: 0, reasons: [] }
                                    : _applyMismatchPenalty(
                                        visionScore,
                                        `${clipAnalysis.description} ${clipAnalysis.issues?.join(' ') || ''}`,
                                        keyword,
                                        scene?.text,
                                        clipAnalysis,
                                        {
                                            mediaAgent: mediaAgentPlan,
                                            mediaHunter: hunterProfile,
                                            mediaType,
                                            sourceHint,
                                            priorityChannel: providerKey === 'youtube' && youtubeChannelScope,
                                        }
                                    );
                                if (deepPenalty.penalty > 0) {
                                    console.log(`  ⛔ Post-blend mismatch penalty -${deepPenalty.penalty} (${deepPenalty.reasons.join('; ')}) → ${visionScore} → ${deepPenalty.score}`);
                                    visionScore = deepPenalty.score;
                                    // If the penalty dropped the blended score at or below the basic-vision
                                    // reject threshold, bail out on this result — the blend was masking
                                    // literal-mismatch problems.
                                    if (visionScore <= 4) {
                                        console.log(`  ❌ Blended score now ≤4 after penalty — rejecting and trying next result`);
                                        _blacklistUrl(dlUrl, visionScore, `penalized: ${deepPenalty.reasons.join('; ')}`);
                                        visionRejections.push(`Penalty: ${deepPenalty.reasons.join('; ')}`);
                                        _recordMediaProvider(scene, {
                                            provider: provider.name,
                                            key: providerKey,
                                            mediaType,
                                            query: searchQuery,
                                            status: 'rejected',
                                            reason: `mismatch penalty: ${deepPenalty.reasons.join('; ')}`,
                                            attempt: attempt + 1,
                                        });
                                        _rememberSceneRejectedResult(scene, selected, `mismatch penalty: ${deepPenalty.reasons.join('; ')}`);
                                        try { fs.unlinkSync(finalPath); } catch {}
                                        continue;
                                    }
                                }
                            }
                        } catch (err) {
                            // Non-fatal — deep analysis is optional
                            console.log(`  ⚠️ Clip analysis skipped: ${err.message}`);
                        }
                    }

                    const strictRawVideo = hunterProfile?.strictRaw
                        && !hunterProfile.allowGraphics
                        && ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                    if (strictRawVideo && _visionEnabled && visionScore <= 0) {
                        const segmentConfidence = Number(smartSegmentResult?.confidence || 0);
                        const segmentDeadlineAccept = finalVisionSkippedForBudget
                            && candidateWasSegmentHunted
                            && segmentConfidence >= STRICT_RAW_SEGMENT_DEADLINE_ACCEPT_CONFIDENCE;
                        const scoutConfidence = Math.max(
                            Number(selected?._previewScoutScore || 0),
                            Number(selected?._topicScout?.score || 0) / 10,
                            Number(selected?._mediaScoutScore || 0) / 10
                        );
                        const metadataScoutAccept = !finalVisionSkippedForBudget
                            && scoutConfidence >= 0.75
                            && (selected?._previewScoutSegment || selected?._topicScoutInjected || selected?._mediaScoutScore);
                        const stockScoutAccept = providerKey === 'storyblocks'
                            && !hardVisualEntityRequired
                            && scoutConfidence >= 0.55
                            && (selected?._thumbnailVisionPassed === true || selected?._mediaScoutScore);
                        if (segmentDeadlineAccept) {
                            segmentDeadlineRescue = true;
                            segmentDeadlineRescueConfidence = segmentConfidence;
                            visionScore = 5;
                            console.log(`  ✅ strict raw guard: final vision was skipped by deadline, but Omni segment hunt was confident (${segmentConfidence.toFixed(2)}); accepting deadline-rescued clean segment`);
                        } else if (metadataScoutAccept) {
                            segmentDeadlineRescue = true;
                            segmentDeadlineRescueConfidence = scoutConfidence;
                            visionScore = 5;
                            console.log(`  ✅ strict raw guard: final vision unavailable, but pre-download scout confidence was ${scoutConfidence.toFixed(2)}; accepting with review-grade score`);
                        } else if (stockScoutAccept) {
                            segmentDeadlineRescue = true;
                            segmentDeadlineRescueConfidence = scoutConfidence;
                            visionScore = 5;
                            console.log(`  âœ… strict raw guard: final vision unavailable, but Storyblocks thumbnail/media scout prevalidated this generic stock clip (${scoutConfidence.toFixed(2)}); accepting with review-grade score`);
                        } else if (finalVisionSkippedForBudget && preliminarySegmentScore >= STRICT_RAW_DEADLINE_SEGMENT_ACCEPT_SCORE) {
                            segmentDeadlineRescue = true;
                            segmentDeadlineRescueConfidence = preliminarySegmentScore / 10;
                            visionScore = preliminarySegmentScore;
                            console.log(`  ✅ strict raw guard: final vision skipped by deadline, but post-download segment score was ${preliminarySegmentScore}/10; accepting deadline-safe clip`);
                        } else {
                            const reason = finalVisionSkippedForBudget
                                ? 'strict raw guard: final vision scoring was skipped'
                                : 'strict raw guard: final vision scoring was unavailable';
                            console.log(`  ⛔ ${reason}; rejecting unchecked clip`);
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: 'rejected',
                                reason,
                                attempt: attempt + 1,
                            });
                            _rememberSceneRejectedResult(scene, selected, reason);
                            try { fs.unlinkSync(finalPath); } catch {}
                            continue;
                        }
                    }

                    const serialMandatoryConfirmation = _mandatoryAcceptanceConfirmation({
                        postDescription: visionDescription,
                        deepDescription: clipAnalysis?.description || '',
                        context: {
                            sceneText: scene?.text || '',
                            niche: nicheId || '',
                            videoTopic: _videoTopic(),
                            theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                            entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                            entityContext,
                            tone: scriptContextRef?.tone || '',
                            mood: scriptContextRef?.mood || '',
                            mediaAgent: mediaAgentPlan,
                            mediaHunter: hunterProfile,
                            sourceTitle: selectedTitle,
                            sourceUrl: selectedSourceUrl,
                            sourceProvider: provider?.name || '',
                            mediaType,
                            sourceHint,
                            keyword,
                        },
                        candidate: selected,
                        keyword,
                    });
                    if (!serialMandatoryConfirmation.ok) {
                        console.log(`  [Mandatory Guard] rejecting accepted candidate: ${serialMandatoryConfirmation.reason}`);
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status: 'rejected',
                            reason: serialMandatoryConfirmation.reason,
                            attempt: attempt + 1,
                            url: dlUrl,
                            selected,
                        });
                        _rememberSceneRejectedResult(scene, selected, serialMandatoryConfirmation.reason);
                        try { fs.unlinkSync(finalPath); } catch {}
                        continue;
                    }

                    const compareLimit = Math.min(maxTries, FINALIST_COMPARE_MAX);
                    const currentFinalistScore = Number(selected?._candidateFinalistScore || 0);
                    const shouldHoldForComparison = mediaType === 'video'
                        && hunterProfile?.strictRaw
                        && FINALIST_COMPARE_MAX > 1
                        && attempt < compareLimit
                        && Number(visionScore || 0) > 0
                        && Number(visionScore || 0) < FINALIST_FAST_ACCEPT_SCORE
                        && hasSceneBudget(FINALIST_COMPARE_MIN_BUDGET_MS, `${provider.name} compare next finalist`);
                    if (mediaType === 'video' && hunterProfile?.strictRaw && Number(visionScore || 0) >= FINALIST_FAST_ACCEPT_SCORE) {
                        console.log(`  ⚡ [Race] fast-accept: ${visionScore}/10 ≥ ${FINALIST_FAST_ACCEPT_SCORE} — taking it now (not holding for a better one)`);
                    }
                    if (shouldHoldForComparison) {
                        const savedPath = path.join(
                            config.paths.temp,
                            `${filenameBase}.candidate-${attempt + 1}${finalExt || providerExt || ext}`
                        );
                        let heldForComparison = false;
                        try {
                            fs.copyFileSync(finalPath, savedPath);
                            heldForComparison = true;
                            const shouldReplaceHeld = !deferredAccept
                                || Number(visionScore || 0) > Number(deferredAccept.visionScore || 0)
                                || (
                                    Number(visionScore || 0) === Number(deferredAccept.visionScore || 0)
                                    && currentFinalistScore > Number(deferredAccept.candidateFinalistScore || 0)
                                );
                            if (shouldReplaceHeld) {
                                if (deferredAccept?.savedPath && deferredAccept.savedPath !== savedPath) {
                                    try { fs.unlinkSync(deferredAccept.savedPath); } catch {}
                                }
                                deferredAccept = {
                                    savedPath,
                                    finalPath,
                                    finalExt,
                                    providerName: provider.name,
                                    providerKey,
                                    mediaType,
                                    actualMediaType: provider.mediaType || mediaType,
                                    query: searchQuery,
                                    dlUrl,
                                    selected,
                                    acceptedMediaHash,
                                    acceptedSceneIndex: scene?.originalIndex ?? scene?.index ?? filenameBase,
                                    clipAnalysis,
                                    visionScore,
                                    candidateFinalistScore: currentFinalistScore,
                                    candidateFinalistReason: selected?._candidateFinalistReason || '',
                                    mediaWidth: selected.width || 0,
                                    mediaHeight: selected.height || 0,
                                    attempt: attempt + 1,
                                };
                            } else {
                                try { fs.unlinkSync(savedPath); } catch {}
                            }
                            console.log(`  [Candidate Scout] Holding ${visionScore}/10 finalist and checking next candidate before accepting first okay match`);
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: 'info',
                                reason: `holding ${visionScore}/10 finalist; checking next candidate before final accept`,
                                attempt: attempt + 1,
                                selected,
                            });
                        } catch (e) {
                            console.log(`  [Candidate Scout] Could not hold finalist for comparison (${e.message}); accepting current candidate`);
                        }
                        if (heldForComparison) {
                            try { fs.unlinkSync(finalPath); } catch {}
                            continue;
                        }
                    }

                    if (deferredAccept?.savedPath && mediaType === 'video' && hunterProfile?.strictRaw) {
                        const heldScore = Number(deferredAccept.visionScore || 0);
                        const currentScore = Number(visionScore || 0);
                        const heldFinalistScore = Number(deferredAccept.candidateFinalistScore || 0);
                        const currentBetter = currentScore > heldScore
                            || (currentScore === heldScore && currentFinalistScore > heldFinalistScore);
                        if (!currentBetter) {
                            console.log(`  [Candidate Scout] Current ${currentScore}/10 finalist did not beat held ${heldScore}/10 candidate; keeping best compared finalist`);
                            _recordMediaProvider(scene, {
                                provider: provider.name,
                                key: providerKey,
                                mediaType,
                                query: searchQuery,
                                status: 'info',
                                reason: `current ${currentScore}/10 did not beat held ${heldScore}/10 finalist`,
                                attempt: attempt + 1,
                                selected,
                            });
                            try { fs.unlinkSync(finalPath); } catch {}
                            break;
                        }
                        console.log(`  [Candidate Scout] Current ${currentScore}/10 finalist beat held ${heldScore}/10 candidate; accepting stronger candidate`);
                        _recordMediaProvider(scene, {
                            provider: provider.name,
                            key: providerKey,
                            mediaType,
                            query: searchQuery,
                            status: 'info',
                            reason: `current ${currentScore}/10 beat held ${heldScore}/10 finalist`,
                            attempt: attempt + 1,
                            selected,
                        });
                        try { fs.unlinkSync(deferredAccept.savedPath); } catch {}
                        deferredAccept = null;
                    }

                    // Track URL reuse count
                    _trackUrlUse(dlUrl);
                    if (provider.downloadedIds) {
                        if (selected.id) provider.downloadedIds.add(selected.id);
                        if (dlUrl) provider.downloadedIds.add(normalizeUrlForDedup(dlUrl));
                    }
                    const acceptedSceneIndex = scene?.originalIndex ?? scene?.index ?? filenameBase;
                    _rememberAcceptedMediaHash(acceptedMediaHash, acceptedSceneIndex, provider.name, finalPath);
                    if (clipAnalysis?.description) {
                        _rememberAcceptedDescription(clipAnalysis.description, acceptedSceneIndex, provider.name);
                    }
                    if (dlUrl) _acceptedUrls.add(normalizeUrlForDedup(dlUrl));
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: 'accepted',
                        reason: segmentDeadlineRescue
                            ? `deadline segment rescue confidence ${segmentDeadlineRescueConfidence.toFixed(2)}`
                            : (visionScore ? `vision ${visionScore}/10` : 'accepted'),
                        attempt: attempt + 1,
                        selected,
                    });

                    // Report the provider's actual mediaType — if a video
                    // provider ran on an image lane (or vice versa), downstream
                    // (scene.mediaType, renderer, MG composition) must see the
                    // real type so the .mp4 isn't treated as a still image.
                    const actualMediaType = provider.mediaType || mediaType;
                    if (scene && actualMediaType !== mediaType) {
                        scene.mediaType = actualMediaType;
                        console.log(`  [Media Type] provider ${provider.name} delivered ${actualMediaType} on ${mediaType} lane -> scene.mediaType=${actualMediaType}`);
                    }
                    if (deferredAccept?.savedPath) {
                        try { fs.unlinkSync(deferredAccept.savedPath); } catch {}
                        deferredAccept = null;
                    }
                    try { rememberPhraseWin(searchQuery); } catch (_) {}
                    const rememberedAcceptedSource = rememberMediaSource(selected, scene, scriptContextRef || {}, {
                        providerKey,
                        providerName: provider.name,
                        mediaType: actualMediaType,
                        query: searchQuery,
                        mediaAgent: mediaAgentPlan,
                        mediaHunter: hunterProfile,
                        visualContract,
                        status: 'accepted',
                        score: visionScore,
                        postScore: visionScore,
                        deepScore: clipAnalysis?.score || 0,
                        startTime: selected?._smartStartTimeUsed ?? selected?._smartStartTime ?? selected?._previewScoutSegment?.startTime,
                        duration: sceneDuration,
                        reason: clipAnalysis?.description || (visionScore ? `vision ${visionScore}/10` : 'accepted'),
                        path: finalPath,
                        ext: finalExt,
                    });
                    if (rememberedAcceptedSource?.assetPath) {
                        console.log(`  [Media Memory] saved accepted asset: ${path.basename(rememberedAcceptedSource.assetPath)}`);
                    }
                    return {
                        path: finalPath,
                        ext: finalExt,
                        provider: provider.name,
                        mediaType: actualMediaType,
                        mediaWidth: selected.width || 0,
                        mediaHeight: selected.height || 0,
                        visionScore: visionScore,
                        clipAnalysis: clipAnalysis,
                    };
                } catch (dlError) {
                    _recordMediaProvider(scene, {
                        provider: provider.name,
                        key: providerKey,
                        mediaType,
                        query: searchQuery,
                        status: 'rejected',
                        reason: `download failed: ${dlError.message}`,
                        attempt: attempt + 1,
                    });
                    _rememberSceneRejectedResult(scene, selected, `download failed: ${dlError.message}`);
                    if (_isPermanentMediaFailure(dlError)) {
                        _rememberStructuralRejectedResult(selected, dlError.message, {
                            providerKey,
                            permanent: true,
                        });
                    } else if (_isTimeoutMediaFailure(dlError)) {
                        _rememberStructuralRejectedResult(selected, `timeout: ${dlError.message}`, {
                            providerKey,
                            strike: true,
                        });
                    }
                    console.log(`  ⚠️ [${provider.name}] Download failed: ${dlError.message}${attempt < maxTries - 1 ? ', trying next result...' : ''}`);
                } finally {
                    _endInFlight(scene);
                }
            }

            if (deferredAccept) {
                try {
                    if (deferredAccept.savedPath && deferredAccept.finalPath && deferredAccept.savedPath !== deferredAccept.finalPath) {
                        fs.copyFileSync(deferredAccept.savedPath, deferredAccept.finalPath);
                    }
                } catch (e) {
                    console.log(`  [Candidate Scout] Deferred finalist restore failed (${e.message}); continuing to retries`);
                    try { if (deferredAccept.savedPath) fs.unlinkSync(deferredAccept.savedPath); } catch {}
                    deferredAccept = null;
                }
            }

            if (deferredAccept) {
                _trackUrlUse(deferredAccept.dlUrl);
                if (provider.downloadedIds) {
                    if (deferredAccept.selected?.id) provider.downloadedIds.add(deferredAccept.selected.id);
                    if (deferredAccept.dlUrl) provider.downloadedIds.add(normalizeUrlForDedup(deferredAccept.dlUrl));
                }
                _rememberAcceptedMediaHash(deferredAccept.acceptedMediaHash, deferredAccept.acceptedSceneIndex, deferredAccept.providerName, deferredAccept.finalPath);
                if (deferredAccept.clipAnalysis?.description) {
                    _rememberAcceptedDescription(deferredAccept.clipAnalysis.description, deferredAccept.acceptedSceneIndex, deferredAccept.providerName);
                }
                if (deferredAccept.dlUrl) _acceptedUrls.add(normalizeUrlForDedup(deferredAccept.dlUrl));
                _recordMediaProvider(scene, {
                    provider: deferredAccept.providerName,
                    key: deferredAccept.providerKey,
                    mediaType: deferredAccept.mediaType,
                    query: deferredAccept.query,
                    status: 'accepted',
                    reason: `best compared finalist vision ${deferredAccept.visionScore}/10${deferredAccept.candidateFinalistScore ? `; finalist scout ${deferredAccept.candidateFinalistScore}/10` : ''}`,
                    attempt: deferredAccept.attempt,
                    selected: deferredAccept.selected,
                });
                if (scene && deferredAccept.actualMediaType !== deferredAccept.mediaType) {
                    scene.mediaType = deferredAccept.actualMediaType;
                    console.log(`  [Media Type] provider ${deferredAccept.providerName} delivered ${deferredAccept.actualMediaType} on ${deferredAccept.mediaType} lane -> scene.mediaType=${deferredAccept.actualMediaType}`);
                }
                console.log(`  [Candidate Scout] Accepted held finalist after comparing available candidates (${deferredAccept.visionScore}/10)`);
                const rememberedAcceptedSource = rememberMediaSource(deferredAccept.selected, scene, scriptContextRef || {}, {
                    providerKey: deferredAccept.providerKey,
                    providerName: deferredAccept.providerName,
                    mediaType: deferredAccept.actualMediaType,
                    query: deferredAccept.query,
                    mediaAgent: mediaAgentPlan,
                    mediaHunter: hunterProfile,
                    visualContract,
                    status: 'accepted',
                    score: deferredAccept.visionScore,
                    postScore: deferredAccept.visionScore,
                    deepScore: deferredAccept.clipAnalysis?.score || 0,
                    startTime: deferredAccept.selected?._smartStartTimeUsed ?? deferredAccept.selected?._smartStartTime ?? deferredAccept.selected?._previewScoutSegment?.startTime,
                    duration: sceneDuration,
                    reason: deferredAccept.clipAnalysis?.description || `held finalist ${deferredAccept.visionScore}/10`,
                    path: deferredAccept.finalPath,
                    ext: deferredAccept.finalExt,
                });
                if (rememberedAcceptedSource?.assetPath) {
                    console.log(`  [Media Memory] saved accepted asset: ${path.basename(rememberedAcceptedSource.assetPath)}`);
                }
                const accepted = {
                    path: deferredAccept.finalPath,
                    ext: deferredAccept.finalExt,
                    provider: deferredAccept.providerName,
                    mediaType: deferredAccept.actualMediaType,
                    mediaWidth: deferredAccept.mediaWidth,
                    mediaHeight: deferredAccept.mediaHeight,
                    visionScore: deferredAccept.visionScore,
                    clipAnalysis: deferredAccept.clipAnalysis,
                };
                try { if (deferredAccept.savedPath) fs.unlinkSync(deferredAccept.savedPath); } catch {}
                deferredAccept = null;
                return accepted;
            }

            // Vision rejected all attempts — ask AI to suggest a DIFFERENT keyword angle
            if (visionRejections.length >= 3 && shouldReserveForControlledStock()) {
                console.log(`  [Deadline Reserve] skipping AI keyword retry; controlled stock fallback needs ${Math.round(remainingMs() / 1000)}s remaining`);
                return null;
            }
            if (visionRejections.length >= 3 && hasSceneBudget(45_000, 'AI keyword retry')) {
                const suggestion = await _visionSuggestKeyword(visionRejections, keyword, {
                    sceneText: scene?.text || '',
                    niche: nicheId || '',
                    videoTopic: _videoTopic(),
                    theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                    entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                    entityContext,
                    tone: scriptContextRef?.tone || '',
                    eventAnchor: scriptContextRef?.eventAnchor || '',
                    triedKeywords: [keyword, ...(scene?.stockQuery ? [scene.stockQuery] : []), ...(scene?.webQuery ? [scene.webQuery] : [])],
                    mediaType,
                    sourceHint,
                    mediaAgent: mediaAgentPlan,
                    mediaHunter: hunterProfile,
                });
                if (suggestion) {
                    suggestion.keyword = trimSearchKeyword(suggestion.keyword, scene);
                    console.log(`  🧠 Vision AI suggests different angle: "${suggestion.keyword}"${suggestion.switchToVideo ? ' (as VIDEO)' : ''}`);
                    // Retry with AI-suggested keyword using ALL providers in smart priority order
                    // (not just the current provider — if YouTube failed 5x, try Reddit too)
                    let retryType = suggestion.switchToVideo ? 'video' : mediaType;
                    if (!_mediaIntentAllowsType(scene, retryType)) {
                        console.log(`  [Media Lock] AI retry wanted ${retryType}, but intent locks ${mediaType}; staying ${mediaType}`);
                        retryType = mediaType;
                    }
                    const retryExt = retryType === 'video' ? '.mp4' : '.jpg';
                    const retryAllProviders = retryType === 'video'
                        ? _filterProvidersByMediaIntent(reorderProviders(videoProviders, getSmartPriority(sourceHint, 'video', scriptContextRef), VIDEO_SOURCE_MAP, agentExcludedKeys), 'video', scene)
                        : _filterProvidersByMediaIntent(reorderProviders(imageProviders, getSmartPriority(sourceHint, 'image', scriptContextRef), IMAGE_SOURCE_MAP, agentExcludedKeys), 'image', scene);
                    for (const retryProvider of retryAllProviders) {
                        if (retryProvider && agentExcludedKeys.has(String(getProviderKey(retryProvider) || '').toLowerCase())) {
                            const skipReason = getMediaAgentProviderSkipReason(mediaAgentPlan, getProviderKey(retryProvider));
                            console.log(`  [Media Agent] AI retry skipping ${getProviderKey(retryProvider)}: ${skipReason || 'agent exclusion'}`);
                            continue;
                        }
                        if (!hasSceneBudget(18_000, `${retryProvider.name} AI retry`)) break;
                        if (!retryProvider.isAvailable()) continue;
                        const retryProviderKey = getProviderKey(retryProvider);
                        let picked = null;
                        try {
                            const retrySearchTimeoutMs = Math.min(_providerSearchTimeoutMs(retryProviderKey), Math.max(8_000, remainingMs() - 8_000));
                            const retryResults = await _withStepTimeout(
                                retryProvider.search(suggestion.keyword),
                                retrySearchTimeoutMs,
                                `${retryProvider.name} AI retry search`
                            );
                            const retryDiscoveredResults = Array.isArray(retryResults) ? retryResults.slice(0, 40) : [];
                            if (retryDiscoveredResults.length > 0) {
                                _recordMediaProvider(scene, {
                                    provider: retryProvider.name,
                                    key: retryProviderKey,
                                    mediaType: retryType,
                                    query: suggestion.keyword,
                                    status: 'discovered',
                                    reason: `AI retry raw search results before filtering (${retryDiscoveredResults.length})`,
                                    resultCount: retryDiscoveredResults.length,
                                    candidates: retryDiscoveredResults,
                                    candidateLimit: 50,
                                });
                            }
                            let filtered = _filterKnownBadResults(retryResults, scene, retryProvider.name, retryProviderKey, {
                                skipAccepted: !PRESCORE_PROVIDERS.has(retryProviderKey),
                            });
                            filtered = retryProvider.filterResults(filtered);
                            if (!OPEN_MEDIA_GATES) {
                                filtered = _filterResultsByHunterTitle(filtered, hunterProfile, retryProvider.name, scene, retryType, retryProviderKey, suggestion.keyword);
                            }
                            if (!OPEN_MEDIA_GATES && visualContract?.enabled) {
                                const retryContract = buildVisualContract(scene, scriptContextRef || {}, {
                                    keyword: suggestion.keyword,
                                    mediaType: retryType,
                                    sourceHint,
                                    nicheId,
                                    hunterProfile,
                                });
                                const scout = scoutMediaResults(filtered, retryContract, {
                                    providerKey: retryProviderKey,
                                    providerName: retryProvider.name,
                                    query: suggestion.keyword,
                                });
                                if (scout.log && (retryType === 'image' || scout.rejected.length > 0 || retryContract.strictRaw)) {
                                    console.log(scout.log);
                                }
                                if (scout.rejected.length > 0) {
                                    const categories = [...new Set(scout.rejected.map(r => r.assessment.category || 'rejected'))].slice(0, 4).join(', ');
                                    for (const rejected of scout.rejected) {
                                        _rememberSceneRejectedResult(scene, rejected.result, rejected.assessment?.reason || rejected.assessment?.category || 'AI retry media scout rejected');
                                    }
                                    _recordMediaProvider(scene, {
                                        provider: retryProvider.name,
                                        key: retryProviderKey,
                                        mediaType: retryType,
                                        query: suggestion.keyword,
                                        status: scout.results.length ? 'info' : 'rejected',
                                        reason: `media scout rejected ${scout.rejected.length} AI-retry candidate(s)${categories ? `: ${categories}` : ''}`,
                                        resultCount: scout.results.length,
                                        candidates: scout.rejected.map(r => r.result),
                                    });
                                }
                                filtered = scout.results;
                            }
                            if (filtered.length === 0) {
                                _recordMediaProvider(scene, {
                                    provider: retryProvider.name,
                                    key: retryProviderKey,
                                    mediaType: retryType,
                                    query: suggestion.keyword,
                                    status: 'rejected',
                                    reason: 'AI retry no usable results',
                                    candidates: retryDiscoveredResults,
                                });
                                continue;
                            }
                            _recordMediaProvider(scene, {
                                provider: retryProvider.name,
                                key: retryProviderKey,
                                mediaType: retryType,
                                query: suggestion.keyword,
                                status: 'results',
                                reason: 'AI retry usable results',
                                resultCount: filtered.length,
                                candidates: filtered,
                            });
                            filtered = rankResultsForHunter(filtered, hunterProfile, retryProvider.name);
                            filtered = _reserveUndersizedTail(filtered, retryProvider.name);
                            if (retryType === 'video') {
                                const previewScout = await _previewScoutResults(filtered, {
                                    provider: retryProvider,
                                    providerKey: retryProviderKey,
                                    keyword: suggestion.keyword,
                                    scene,
                                    sceneDuration,
                                    nicheId,
                                    hunterProfile,
                                    scriptContext: scriptContextRef || {},
                                    hasSceneBudget,
                                    reserveSceneOmni,
                                    maxCandidates: 2,
                                    allowOmniReserve,
                                    priorityChannel: retryProviderKey === 'youtube'
                                        && _isPoliticsMilitaryYouTubeChannelScope(scene, suggestion.keyword, scriptContextRef || {}),
                                });
                                if (previewScout.log) {
                                    console.log(`  ${previewScout.log}`);
                                    _recordMediaProvider(scene, {
                                        provider: retryProvider.name,
                                        key: retryProviderKey,
                                        mediaType: retryType,
                                        query: suggestion.keyword,
                                        status: 'info',
                                        reason: `AI retry preview scout accepted ${previewScout.accepted}/${previewScout.inspected}; rejected ${previewScout.rejected}; windowRejected ${previewScout.windowRejected || 0}`,
                                        resultCount: previewScout.results.length,
                                    });
                                }
                                filtered = previewScout.results;
                            }
                            const isOverused = (url) => _getUrlUseCount(url) >= MAX_URL_REUSE;
                            picked = retryProvider.pickUnused(filtered, isOverused);
                            if (!picked) continue;
                            const pickedTitle = String(picked.title || picked._cachedMeta?.title || picked._meta?.title || picked.url || '').replace(/\s+/g, ' ').trim();
                            const pickedSourceUrl = picked.url || picked._cachedMeta?.url || picked._meta?.url || picked._directVideoUrl || picked._fallbackUrl || '';
                            _recordMediaProvider(scene, {
                                provider: retryProvider.name,
                                key: retryProviderKey,
                                mediaType: retryType,
                                query: suggestion.keyword,
                                status: 'candidate',
                                reason: 'AI retry picked for download/vision attempt',
                                selected: picked,
                            });

                            const outputPath = path.join(config.paths.temp, filenameBase + retryExt);
                            if (isAborted()) { console.log(`  ⏱️ Scene aborted — skipping AI-retry download`); return null; }
                            if (!hasSceneBudget(18_000, `${retryProvider.name} AI retry download`)) break;
                            _beginInFlight(scene, `${retryProvider.name} AI-retry candidate (download+scoring)`);
                            console.log(`  ⬇️  [${retryProvider.name}] Retry with AI keyword...`);
                            const retryDownloadOptions = { duration: sceneDuration, keyword: suggestion.keyword, _directVideoUrl: picked._directVideoUrl || null, _cachedMeta: picked._cachedMeta || picked._meta || null, _fallbackUrl: picked._fallbackUrl || null, _smartStartTime: picked._smartStartTime || null, sceneText: scene?.text || '', niche: nicheId || '', videoTopic: scriptContextRef?.summary || '', theme: scriptContextRef?.themeId || scriptContextRef?.theme || '', entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []), mediaAgent: mediaAgentPlan, mediaHunter: hunterProfile, sourceTitle: pickedTitle, sourceUrl: pickedSourceUrl, sourceDuration: Number(picked.duration) > 0 ? Number(picked.duration) : null, abortSignal, deadlineAt: scene?._deadlineAt || 0 };
                            let finalPath = await retryProvider.download(picked.url, outputPath, retryDownloadOptions);
                            _assertDownloadedFile(finalPath, retryProvider.mediaType || retryType, retryProvider.name);
                            let finalExt = path.extname(finalPath);
                            if (Number.isFinite(Number(retryDownloadOptions._smartStartTimeUsed))) {
                                picked._smartStartTimeUsed = Math.max(0, Number(retryDownloadOptions._smartStartTimeUsed));
                            }
                            if (Array.isArray(retryDownloadOptions._smartSegmentAlternates) && retryDownloadOptions._smartSegmentAlternates.length > 0) {
                                picked._lastSmartSegmentAlternates = retryDownloadOptions._smartSegmentAlternates;
                                picked._smartSegmentAlternates = retryDownloadOptions._smartSegmentAlternates;
                            }
                            console.log(`  ✅ [${retryProvider.name}] Downloaded: ${path.basename(finalPath)}`);

                            // Vision scoring on AI-retry clips (same as primary path)
                            const retryIsPreviewClip = !!picked._isPreview;
                            let retryVisionScore = retryIsPreviewClip ? 7 : 0;
                            let retryVisionDescription = '';
                            const retryContext = {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: _videoTopic(),
                                theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                entityContext,
                                tone: scriptContextRef?.tone || '',
                                mood: scriptContextRef?.mood || '',
                                mediaAgent: mediaAgentPlan,
                                mediaHunter: hunterProfile,
                                sourceProvider: retryProvider?.name || '',
                                sourceTitle: pickedTitle,
                                sourceUrl: pickedSourceUrl,
                                mediaType: retryType,
                                sourceHint,
                                keyword: suggestion.keyword,
                                // Judge against the full request, not the retry query.
                                visualIntent: fullVisualIntent,
                            };
                            if (retryIsPreviewClip) {
                                console.log(`  🩹 Preview clip (${retryProvider.name}) retry — bypassing vision/deep checks`);
                            }
                            if (!retryIsPreviewClip && _visionEnabled && fs.existsSync(finalPath) && hasSceneBudget(20_000, `${retryProvider.name} AI retry vision`)) {
                                const retryVision = await _scoreDownloadedMedia(finalPath, finalExt, suggestion.keyword, retryContext);
                                if (retryVision) {
                                    retryVisionScore = retryVision.score;
                                    retryVisionDescription = String(retryVision.description || '');
                                    console.log(`  👁️ Vision (retry): ${retryVision.score}/10 → ${retryVision.description}`);
                                    if (retryVision.score <= 4) {
                                        const currentStart = Number.isFinite(Number(picked._smartStartTimeUsed))
                                            ? Number(picked._smartStartTimeUsed)
                                            : (Number.isFinite(Number(picked._smartStartTime)) ? Number(picked._smartStartTime) : null);
                                        const alternates = []
                                            .concat(Array.isArray(picked._smartSegmentAlternates) ? picked._smartSegmentAlternates : [])
                                            .concat(Array.isArray(picked._lastSmartSegmentAlternates) ? picked._lastSmartSegmentAlternates : []);
                                        const alternate = retryType === 'video' && PRESCORE_PROVIDERS.has(retryProviderKey)
                                            ? alternates.find(choice => {
                                                const start = Number(choice?.startTime);
                                                if (!Number.isFinite(start)) return false;
                                                if (currentStart !== null && Math.abs(start - currentStart) < 2) return false;
                                                return Number(choice?.score || 0) >= 5;
                                            })
                                            : null;
                                        if (alternate && hasSceneBudget(24_000, `${retryProvider.name} AI retry alternate smart window`)) {
                                            const altStart = Math.max(0, Number(alternate.startTime));
                                            const remainingAlternates = alternates.filter(choice => Math.abs(Number(choice?.startTime) - altStart) >= 2);
                                            console.log(`  [Smart Trim] AI retry trying alternate window ${Math.round(altStart)}s (${alternate.score || '?'} / 10, fit ${alternate.editorFit ?? '?'}) before abandoning "${_short(pickedTitle, 70)}"`);
                                            _recordMediaProvider(scene, {
                                                provider: retryProvider.name,
                                                key: retryProviderKey,
                                                mediaType: retryType,
                                                query: suggestion.keyword,
                                                status: 'info',
                                                reason: `AI retry alternate smart window ${Math.round(altStart)}s after vision ${retryVision.score}/10`,
                                                selected: picked,
                                            });
                                            try { fs.unlinkSync(finalPath); } catch {}
                                            picked = {
                                                ...picked,
                                                _smartStartTime: altStart,
                                                _smartStartTimeUsed: altStart,
                                                _smartSegmentAlternates: remainingAlternates,
                                                _lastSmartSegmentAlternates: remainingAlternates,
                                            };
                                            const altOptions = { ...retryDownloadOptions, _smartStartTime: altStart };
                                            finalPath = await retryProvider.download(picked.url, outputPath, altOptions);
                                            _assertDownloadedFile(finalPath, retryProvider.mediaType || retryType, retryProvider.name);
                                            finalExt = path.extname(finalPath);
                                            if (Number.isFinite(Number(altOptions._smartStartTimeUsed))) {
                                                picked._smartStartTimeUsed = Math.max(0, Number(altOptions._smartStartTimeUsed));
                                            }
                                            console.log(`  ✅ [${retryProvider.name}] Downloaded alternate window: ${path.basename(finalPath)}`);
                                            const altVision = await _scoreDownloadedMedia(finalPath, finalExt, suggestion.keyword, retryContext);
                                            if (altVision) {
                                                retryVisionScore = altVision.score;
                                                retryVisionDescription = String(altVision.description || '');
                                                console.log(`  👁️ Vision (retry alternate): ${altVision.score}/10 → ${altVision.description}`);
                                                if (altVision.score <= 4) {
                                                    _recordMediaProvider(scene, {
                                                        provider: retryProvider.name,
                                                        key: retryProviderKey,
                                                        mediaType: retryType,
                                                        query: suggestion.keyword,
                                                        status: 'rejected',
                                                        reason: `AI retry alternate vision ${altVision.score}/10: ${altVision.description}`,
                                                    });
                                                    console.log(`  ❌ Retry alternate score too low (${altVision.score}/10), trying next provider...`);
                                                    try { fs.unlinkSync(finalPath); } catch {}
                                                    continue;
                                                }
                                            } else {
                                                _recordMediaProvider(scene, {
                                                    provider: retryProvider.name,
                                                    key: retryProviderKey,
                                                    mediaType: retryType,
                                                    query: suggestion.keyword,
                                                    status: 'rejected',
                                                    reason: 'AI retry alternate vision unavailable',
                                                });
                                                console.log(`  ❌ Retry alternate could not be vision-scored, trying next provider...`);
                                                try { fs.unlinkSync(finalPath); } catch {}
                                                continue;
                                            }
                                         } else {
                                            _recordMediaProvider(scene, {
                                                provider: retryProvider.name,
                                                key: retryProviderKey,
                                                mediaType: retryType,
                                                query: suggestion.keyword,
                                                status: 'rejected',
                                                reason: `AI retry vision ${retryVision.score}/10: ${retryVision.description}`,
                                            });
                                            console.log(`  ❌ Retry score too low (${retryVision.score}/10), trying next provider...`);
                                            try { fs.unlinkSync(finalPath); } catch {}
                                            continue;
                                         }
                                    }
                                }
                            }

                            // Deep clip analysis on AI-retry clips
                            let retryClipAnalysis = null;
                            const retryIsVideo = ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                            if (!retryIsPreviewClip && retryIsVideo && (clipAnalyzer.isClipAnalysisAvailable ? clipAnalyzer.isClipAnalysisAvailable() : clipAnalyzer.isAvailable()) && fs.existsSync(finalPath) && hasSceneBudget(35_000, `${retryProvider.name} AI retry deep analysis`)) {
                                try {
                                    const { probeDuration: _probeDur } = require('../agents/smart-segment');
                                    const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
                                    const clipDur = await _probeDur(ffmpegPath, finalPath) || sceneDuration;
                                    retryClipAnalysis = await clipAnalyzer.analyzeClip(finalPath, clipDur, suggestion.keyword, {
                                        sceneText: scene?.text || '',
                                        niche: nicheId || '',
                                        videoTopic: _videoTopic(),
                                        entities: entityContext.length ? entityContext : (scriptContextRef?.entities || []),
                                        entityContext,
                                        mediaAgent: mediaAgentPlan,
                                        mediaHunter: hunterProfile,
                                        sourceProvider: retryProvider?.name || '',
                                        sourceTitle: pickedTitle,
                                        sourceUrl: pickedSourceUrl,
                                        visualIntent: fullVisualIntent,
                                    });
                                    if (retryClipAnalysis) {
                                        console.log(`  🎬 Clip Analysis (retry): ${retryClipAnalysis.score}/10 | ${retryClipAnalysis.motion} motion | ${retryClipAnalysis.issues.length ? 'Issues: ' + retryClipAnalysis.issues.join(', ') : 'Clean'}`);
                                        console.log(`     ${retryClipAnalysis.description}`);
                                        const rejectThreshold = config.clipAnalyzer?.rejectThreshold || 3;
                                        if (retryClipAnalysis.score <= rejectThreshold) {
                                            _recordMediaProvider(scene, {
                                                provider: retryProvider.name,
                                                key: retryProviderKey,
                                                mediaType: retryType,
                                                query: suggestion.keyword,
                                                status: 'rejected',
                                                reason: `AI retry deep analysis ${retryClipAnalysis.score}/10`,
                                            });
                                            console.log(`  ❌ Deep analysis too low (${retryClipAnalysis.score}/10), trying next provider...`);
                                            try { fs.unlinkSync(finalPath); } catch {}
                                            continue;
                                        }
                                        const retryDiscontinuityReason = _strictRawDiscontinuityRejectReason(retryClipAnalysis, hunterProfile);
                                        if (retryDiscontinuityReason) {
                                            _recordMediaProvider(scene, {
                                                provider: retryProvider.name,
                                                key: retryProviderKey,
                                                mediaType: retryType,
                                                query: suggestion.keyword,
                                                status: 'rejected',
                                                reason: retryDiscontinuityReason,
                                            });
                                            console.log(`  ⛔ Retry strict raw continuity reject: ${retryDiscontinuityReason}`);
                                            try { fs.unlinkSync(finalPath); } catch {}
                                            continue;
                                        }
                                        if (retryVisionScore > 0) {
                                            retryVisionScore = Math.round(retryVisionScore * 0.4 + retryClipAnalysis.score * 0.6);
                                        } else {
                                            retryVisionScore = retryClipAnalysis.score;
                                        }
                                        const retryPenalty = _applyMismatchPenalty(
                                            retryVisionScore,
                                            `${retryClipAnalysis.description} ${retryClipAnalysis.issues?.join(' ') || ''}`,
                                            suggestion.keyword,
                                            scene?.text,
                                            retryClipAnalysis,
                                            {
                                                mediaAgent: mediaAgentPlan,
                                                mediaHunter: hunterProfile,
                                                mediaType: retryType,
                                                sourceHint,
                                                priorityChannel: retryProviderKey === 'youtube'
                                                    && _isPoliticsMilitaryYouTubeChannelScope(scene, suggestion.keyword, scriptContextRef || {}),
                                            }
                                        );
                                        if (retryPenalty.penalty > 0) {
                                            console.log(`  â›” Retry post-blend mismatch penalty -${retryPenalty.penalty} (${retryPenalty.reasons.join('; ')}) â†’ ${retryVisionScore} â†’ ${retryPenalty.score}`);
                                            retryVisionScore = retryPenalty.score;
                                            if (retryVisionScore <= 4) {
                                                _recordMediaProvider(scene, {
                                                    provider: retryProvider.name,
                                                    key: retryProviderKey,
                                                    mediaType: retryType,
                                                    query: suggestion.keyword,
                                                    status: 'rejected',
                                                    reason: `AI retry mismatch penalty: ${retryPenalty.reasons.join('; ')}`,
                                                });
                                                try { fs.unlinkSync(finalPath); } catch {}
                                                continue;
                                            }
                                        }
                                    }
                                } catch (err) {
                                    console.log(`  ⚠️ Clip analysis skipped: ${err.message}`);
                                }
                            }

                            const retryStrictRawVideo = hunterProfile?.strictRaw
                                && !hunterProfile.allowGraphics
                                && ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                            if (retryStrictRawVideo && _visionEnabled && retryVisionScore <= 0) {
                                const reason = 'strict raw guard: AI retry final vision scoring was skipped';
                                _recordMediaProvider(scene, {
                                    provider: retryProvider.name,
                                    key: retryProviderKey,
                                    mediaType: retryType,
                                    query: suggestion.keyword,
                                    status: 'rejected',
                                    reason,
                                });
                                console.log(`  ⛔ ${reason}; rejecting unchecked retry clip`);
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                            }

                            const retryMandatoryConfirmation = _mandatoryAcceptanceConfirmation({
                                postDescription: retryVisionDescription,
                                deepDescription: retryClipAnalysis?.description || '',
                                context: retryContext,
                                candidate: picked,
                                keyword: suggestion.keyword,
                            });
                            if (!retryMandatoryConfirmation.ok) {
                                console.log(`  [Mandatory Guard] rejecting AI retry candidate: ${retryMandatoryConfirmation.reason}`);
                                _recordMediaProvider(scene, {
                                    provider: retryProvider.name,
                                    key: retryProviderKey,
                                    mediaType: retryType,
                                    query: suggestion.keyword,
                                    status: 'rejected',
                                    reason: retryMandatoryConfirmation.reason,
                                    selected: picked,
                                });
                                _rememberSceneRejectedResult(scene, picked, retryMandatoryConfirmation.reason);
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                            }

                            _trackUrlUse(picked._directVideoUrl || picked.url);
                            _recordMediaProvider(scene, {
                                provider: retryProvider.name,
                                key: retryProviderKey,
                                mediaType: retryType,
                                query: suggestion.keyword,
                                status: 'accepted',
                                reason: retryVisionScore ? `AI retry vision ${retryVisionScore}/10` : 'AI retry accepted',
                                selected: picked,
                            });
                            const rememberedAcceptedSource = rememberMediaSource(picked, scene, scriptContextRef || {}, {
                                providerKey: retryProviderKey,
                                providerName: retryProvider.name,
                                mediaType: retryType,
                                query: suggestion.keyword,
                                mediaAgent: mediaAgentPlan,
                                mediaHunter: hunterProfile,
                                visualContract,
                                status: 'accepted',
                                score: retryVisionScore,
                                postScore: retryVisionScore,
                                deepScore: retryClipAnalysis?.score || 0,
                                startTime: picked?._smartStartTimeUsed ?? picked?._smartStartTime ?? picked?._previewScoutSegment?.startTime,
                                duration: sceneDuration,
                                reason: retryClipAnalysis?.description || (retryVisionScore ? `AI retry vision ${retryVisionScore}/10` : 'AI retry accepted'),
                                path: finalPath,
                                ext: finalExt,
                            });
                            if (rememberedAcceptedSource?.assetPath) {
                                console.log(`  [Media Memory] saved accepted asset: ${path.basename(rememberedAcceptedSource.assetPath)}`);
                            }
                            return {
                                path: finalPath,
                                ext: finalExt,
                                provider: retryProvider.name,
                                mediaType: retryType,
                                mediaWidth: picked.width || 0,
                                mediaHeight: picked.height || 0,
                                visionScore: retryVisionScore,
                                clipAnalysis: retryClipAnalysis,
                            };
                        } catch (e) {
                            _recordMediaProvider(scene, {
                                provider: retryProvider.name,
                                mediaType: retryType,
                                query: suggestion.keyword,
                                status: 'rejected',
                                reason: `AI keyword retry failed: ${e.message}`,
                            });
                            if (picked) _rememberSceneRejectedResult(scene, picked, `AI keyword retry failed: ${e.message}`);
                            if (picked && _isPermanentMediaFailure(e)) {
                                _rememberStructuralRejectedResult(picked, e.message, {
                                    providerKey: retryProviderKey,
                                    permanent: true,
                                });
                            } else if (picked && _isTimeoutMediaFailure(e)) {
                                _rememberStructuralRejectedResult(picked, `timeout: ${e.message}`, {
                                    providerKey: retryProviderKey,
                                    strike: true,
                                });
                            }
                            console.log(`  ⚠️ [${retryProvider.name}] AI keyword retry failed: ${e.message}`);
                        } finally {
                            _endInFlight(scene);
                        }
                    }
                }
            }
        } catch (error) {
            _recordMediaProvider(scene, {
                provider: provider.name,
                key: getProviderKey(provider),
                mediaType,
                status: 'rejected',
                reason: error.message,
            });
            console.log(`  ⚠️ [${provider.name}] Failed: ${error.message}, trying next...`);
            continue;
        }
    }

    if (scene && !options.repairAttempt && process.env.MEDIA_AGENT_REPAIR !== '0' && hasSceneBudget(MEDIA_AGENT_REPAIR_MIN_BUDGET_MS, 'AI media repair')) {
        const failureContext = _buildMediaRepairFailureContext(scene, {
            keyword,
            mediaType,
            sourceHint,
            nicheId,
        });
        const repairPlan = await buildMediaAgentRepairPlan(scene, scriptContextRef || {}, mediaAgentPlan, failureContext, {
            keyword,
            mediaType,
            sourceHint,
            nicheId,
        });
        if (repairPlan?.enabled) {
            const lock = getMediaAgentProviderLock(repairPlan, mediaType);
            const lanes = _planLanePreview(repairPlan, 10);
            console.log(`  [Media Repair] rerunning provider army with revised mission`);
            console.log(`  [Media Repair] providers ${(repairPlan.providerOrder || []).slice(0, 5).join(' > ') || '-'}${lock?.strength && lock.strength !== 'open' ? ` | lock ${lock.strength}:${(lock.providers || []).join('>') || '-'}` : ''}`);
            if (lanes) console.log(`  [Media Repair] query lanes ${lanes}`);
            _recordMediaProvider(scene, {
                provider: 'Media Repair Agent',
                key: 'media-repair',
                mediaType,
                query: keyword,
                status: 'info',
                reason: `AI repair plan: ${(repairPlan.providerOrder || []).join(' > ') || 'same providers'}${repairPlan.repairReason ? `; ${repairPlan.repairReason}` : ''}`,
            });
            return await downloadMedia(keyword, mediaType, filenameBase, sceneDuration, sourceHint, nicheId, scene, {
                ...options,
                repairAttempt: true,
                repairPlan,
            });
        }
    }

    console.log(`  ❌ All ${mediaType} providers failed for "${keyword}"`);
    return null;
}

async function downloadAllMedia(scenes, scriptContext, options = {}) {
    const runLabel = options.label ? ` (${options.label})` : '';
    console.log(`\n🎥 Downloading stock footage${runLabel}...\n`);

    // ── Media-system feature banner (so you can SEE what's active each build) ──
    const _ytCap = process.env.YOUTUBE_DOWNLOAD_MAX_HEIGHT;
    const _on = (envVal, offValue = 'off') => String(envVal || '').toLowerCase() === offValue ? 'OFF' : 'ON';
    console.log(`🎬 ── Media System (active this build) ─────────────────────────`);
    console.log(`   YouTube: ${config.youtube?.apiKeys?.length || 0} key(s) · 403 client-ladder ON · cap ${_ytCap === '0' ? 'uncapped' : `${_ytCap || 1080}p`} · metadata-passthrough ON · segment ${process.env.YOUTUBE_SMART_SEGMENT === '1' ? 'vision smart-trim (slow)' : 'transcript/heuristic (fast)'}`);
    console.log(`   Relevance: Retrievability-Rescue ${_on(process.env.RETRIEVABILITY_RESCUE)} · Title-Sanity loose→defers-to-vision · Transcript-Scout ${_on(process.env.TRANSCRIPT_SCOUT)} (caption videos)`);
    console.log(`   Race: fast-accept first clip ≥${FINALIST_FAST_ACCEPT_SCORE}/10 · portrait-stills ${process.env.MEDIA_REJECT_PORTRAIT_IMAGES === '1' ? 'REJECT' : 'KEEP (crop/float)'} · vision-layers ${ONE_VISION_LAYER ? '1 (post-download score only)' : 'FULL gauntlet'}`);
    console.log(`   Qwen vision: round-robin-spread ${process.env.QWEN_ROTATION_SPREAD === '0' ? 'OFF' : 'ON'} · revalidate-exhausted ${process.env.QWEN_REVALIDATE_EXHAUSTED === '0' ? 'OFF' : 'ON'}`);
    console.log(`───────────────────────────────────────────────────────────────\n`);
    try {
        uiLog.info(`🎬 Media system: rescue ${_on(process.env.RETRIEVABILITY_RESCUE)} · title-sanity loose · transcript-scout ${_on(process.env.TRANSCRIPT_SCOUT)} · fast-accept ≥${FINALIST_FAST_ACCEPT_SCORE} · 1 vision layer · qwen spread ON`);
    } catch (_) {}

    // Initialize fresh provider instances with script context
    initProviders(scriptContext);

    // Phrase memory: learn this script's own multi-word terms ("root cellar",
    // "barn raising", "Gulf of Aden") BEFORE the first query is shortened, so
    // scene 1 is treated as intelligently as scene 50. Read-only pass.
    try {
        const _phraseStats = observePhraseScenes(scenes);
        if (_phraseStats && _phraseStats.learned > 0) {
            console.log(`  [Phrases] ${_phraseStats.learned} multi-word term(s) protected from mid-phrase trimming this run`);
        }
    } catch (_) {}
    if (process.env.MEDIA_MEMORY_BANK !== '0') {
        initMediaMemoryBank(scriptContext || {}, { tempDir: config.paths.temp });
        const memorySummary = summarizeMediaMemoryBank();
        console.log(`  [Media Memory] loaded ${memorySummary.count} remembered source(s), ${memorySummary.assetCount || 0} reusable asset(s) from ${memorySummary.path}`);
    }

    // ── Resume-aware media phase ──
    // On a repeat-from-media / resume run, classify scenes UP FRONT into "already have
    // media (reuse)" vs "to (re)attempt" so the phase presents as a real RESUME — the build
    // log shows the exact reused + pending indices instead of looking like a fresh 0-start,
    // and the UI counter reflects completed work. Production feature, not a debug aid:
    // works on any cancelled build (first or Nth), validates each cached file, and only the
    // genuine gaps are re-attempted. The per-scene resume-skip below does the real reuse.
    const _resumeActive = /^true$/i.test(String(process.env.BUILD_RESUME || ''))
        || /^(media|download-media|footage|step5|step-5)$/i.test(String(process.env.BUILD_REPEAT_FROM || '').trim());
    if (_resumeActive) {
        const _resExts = ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
        const _reused = [], _pending = [];
        for (const scene of scenes) {
            if (!scene || scene.fullscreenMG) continue; // fullscreen MGs carry no downloaded footage
            const si = scene.index;
            const hasFile = _resExts.some(ext => {
                try { return fs.existsSync(path.join(config.paths.temp, `scene-${si}${ext}`)); } catch (_) { return false; }
            });
            (hasFile ? _reused : _pending).push(si);
        }
        const _fmtIdx = (arr) => arr.length > 50 ? `${arr.slice(0, 50).join(', ')} +${arr.length - 50} more` : (arr.join(', ') || 'none');
        console.log(`♻️  RESUME MODE — ${_reused.length} scene(s) already have media (will be reused), ${_pending.length} to (re)attempt.`);
        console.log(`   ✅ reused indices: ${_fmtIdx(_reused)}`);
        console.log(`   ⏳ attempting indices: ${_fmtIdx(_pending)}`);
        uiLog.info(`♻️ Resume: ${_reused.length} reused · ${_pending.length} to (re)attempt`);
    }

    // Clear media cache for fresh build.
    if (!options.preserveCache) {
        _clearMediaCache();
    }
    const isListicle = scriptContext?.format === 'listicle';
    const allowMediaCacheReuse = options.allowMediaCacheReuse === true || isListicle;

    // If no video providers enabled, force all scenes to image (and vice versa)
    const hasVideoProviders = videoProviders.some(p => p.isAvailable());
    const hasImageProviders = imageProviders.some(p => p.isAvailable());
    const optionConcurrencyRaw = options.sceneConcurrency ?? options.concurrency;
    const optionConcurrency = parseInt(optionConcurrencyRaw, 10);
    const hasOptionConcurrency = String(optionConcurrencyRaw || '').trim() !== ''
        && Number.isFinite(optionConcurrency)
        && optionConcurrency > 0;
    const CONCURRENCY = Math.max(1, Math.min(8, hasOptionConcurrency ? optionConcurrency : DOWNLOAD_CONCURRENCY));

    // ─── Log buffering for clean scene-by-scene output ─────────────
    // Scenes download in parallel (3 at a time) but their logs interleave,
    // making output unreadable. We use AsyncLocalStorage to track which
    // async context belongs to which scene, buffer logs per-scene, and
    // flush each scene's logs as a clean block when it finishes.

    const _sceneBuffers = new Map(); // sceneIndex → string[]
    const _readyScenes = new Set();  // scenes that finished and are ready to flush
    let _nextFlush = 0;              // next scene index to flush in order

    const _flushedScenes = new Set(); // scenes whose logs have already been emitted — late async must be discarded

    function _flushSceneLog(sceneIdx) {
        _readyScenes.add(sceneIdx);

        // Flush in order: scene 0, 1, 2, 3... so output reads sequentially
        // If scene 2 finishes before scene 0, it waits until 0 and 1 flush first
        while (_readyScenes.has(_nextFlush)) {
            const buf = _sceneBuffers.get(_nextFlush);
            if (buf && buf.length > 0) {
                _originalConsoleLog(buf.join('\n'));
            }
            _sceneBuffers.delete(_nextFlush);
            _readyScenes.delete(_nextFlush);
            _flushedScenes.add(_nextFlush);
            _nextFlush++;
        }
    }

    // Hijack console.log — route to scene buffer via AsyncLocalStorage.
    // NOTE: We install this hijack PERMANENTLY (no restore). Reason:
    // aborted/timed-out scene tasks can continue running provider chains
    // (network retries, vision fallbacks) for minutes after downloadAllMedia
    // returns. Their console.log calls still carry the scene's AsyncLocalStorage
    // context. If we restored the original console.log, those late logs would
    // spill into whatever step is running next (Step 6 MG, Step 6.05, etc.),
    // making output unreadable. Keeping the hijack installed lets us detect
    // scene-scoped late logs and silently drop them.
    const _prevLog = console.log;
    console.log = function (...args) {
        const store = _logStorage.getStore();
        if (store && store.sceneIdx !== undefined) {
            // Scene already flushed — discard late async output (timed-out providers, etc.)
            if (_flushedScenes.has(store.sceneIdx)) {
                return;
            }
            const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
            const buf = _sceneBuffers.get(store.sceneIdx);
            if (buf) {
                buf.push(line);
                return;
            }
            // Buffer is gone but flush flag missing — treat as already-emitted, discard
            return;
        }
        // Outside scene context — print immediately
        _originalConsoleLog.apply(console, args);
    };

    // Scout Lab / single-scene mode detected early so we can use it for timeout selection.
    // In a full build, 100+ scenes share a global budget so per-scene caps are tight.
    // In Scout Lab the whole point is exhaustive single-scene exploration — let it
    // run up to 8 minutes per scene so we can fully exercise Preview Scout + Smart
    // Trim + multiple candidate downloads without a premature deadline cutoff.
    const isScoutLabLikeRun = scenes.length === 1 || /scout-lab/i.test(String(options.label || ''));
    const SCOUT_LAB_SCENE_TIMEOUT_MS = Math.max(SCENE_DOWNLOAD_TIMEOUT_MS, 8 * 60 * 1000);

    // Hard per-scene timeout — if a single scene hangs (network stall, hung VL call),
    // give up rather than blocking the entire build.
    const defaultTimeoutForRun = isScoutLabLikeRun ? SCOUT_LAB_SCENE_TIMEOUT_MS : SCENE_DOWNLOAD_TIMEOUT_MS;
    const requestedTimeout = parseInt(options.sceneTimeoutMs || String(defaultTimeoutForRun), 10);
    const SCENE_TIMEOUT_MS = Math.max(10_000, Number.isFinite(requestedTimeout) ? requestedTimeout : defaultTimeoutForRun);
    if (isScoutLabLikeRun && SCENE_TIMEOUT_MS > SCENE_DOWNLOAD_TIMEOUT_MS) {
        _originalConsoleLog(`  [Scout Lab] diagnostic mode -> per-scene deadline raised to ${Math.round(SCENE_TIMEOUT_MS / 1000)}s (build default was ${Math.round(SCENE_DOWNLOAD_TIMEOUT_MS / 1000)}s)`);
    }
    const strictScenes = scenes.filter(scene => _needsStrictRawSceneBudget(scene));
    const useLargeBuildStrictCap = ENABLE_LARGE_BUILD_STRICT_CAP
        && !LOW_BANDWIDTH_MODE
        && !STRICT_RAW_TIMEOUT_EXPLICIT
        && strictScenes.length >= STRICT_RAW_LARGE_BUILD_SCENES;
    if (useLargeBuildStrictCap) {
        for (const scene of strictScenes) scene._largeBuildStrictTimeout = true;
        console.log(`  Download budget: large strict-raw build (${strictScenes.length} video scenes) -> cap per-scene strict timeout at ${Math.round(STRICT_RAW_LARGE_BUILD_TIMEOUT_MS / 1000)}s`);
    } else {
        for (const scene of strictScenes) scene._largeBuildStrictTimeout = false;
    }
    const strictTimeouts = strictScenes
        .map(scene => _effectiveSceneTimeoutMs(scene, SCENE_TIMEOUT_MS, options.label || ''));
    const maxSceneTimeoutMs = strictTimeouts.length ? Math.max(SCENE_TIMEOUT_MS, ...strictTimeouts) : SCENE_TIMEOUT_MS;
    const timeoutLabel = maxSceneTimeoutMs === SCENE_TIMEOUT_MS
        ? `${Math.round(SCENE_TIMEOUT_MS / 1000)}s`
        : `${Math.round(SCENE_TIMEOUT_MS / 1000)}-${Math.round(maxSceneTimeoutMs / 1000)}s`;
    const networkLabel = LOW_BANDWIDTH_MODE
        ? ` | low-bandwidth mode: ON, media timeout=${Math.round((config.network?.mediaDownloadTimeoutMs || 0) / 1000)}s, retries=${config.network?.mediaDownloadRetries || '?'}`
        : '';
    const concurrencyNote = hasOptionConcurrency
        ? `option=${optionConcurrencyRaw}`
        : (DOWNLOAD_CONCURRENCY_SETTING.source === 'default'
            ? 'default'
            : `${DOWNLOAD_CONCURRENCY_SETTING.source}=${DOWNLOAD_CONCURRENCY_SETTING.raw}`);
    console.log(`  Download budget: scene concurrency=${CONCURRENCY} (${concurrencyNote}), scene timeout=${timeoutLabel}${networkLabel}`);

    // Scout Lab / single-scene live logging mode: disable AsyncLocalStorage
    // buffering so the UI sees download chain output AS IT HAPPENS, instead
    // of waiting for scene completion to flush a (possibly never-flushed)
    // buffer. With one scene there is no log-interleaving concern, and a
    // silent 180s hang in a buffered scene gives zero diagnostic value.
    const useSingleSceneLive = isScoutLabLikeRun;
    if (useSingleSceneLive) {
        _originalConsoleLog(`  [Diag] Single-scene live mode — per-scene log buffering disabled (label="${options.label || '-'}")`);
    }

    // Periodic buffer drain — if buffering IS active (multi-scene build) and
    // a single scene is taking a long time, drain its buffer to the sink every
    // few seconds so a hung scene doesn't sit invisible until completion/timeout.
    const _drainSceneBuffer = (sceneIdx) => {
        const buf = _sceneBuffers.get(sceneIdx);
        if (!buf || buf.length === 0) return;
        const block = buf.splice(0, buf.length).join('\n');
        if (block) _originalConsoleLog(block);
    };

    const _makeSceneTask = (scene, i) => async () => {
        // Use scene's original index for filenames/logs (preserves alignment with fullscreen MG scenes)
        const si = scene.index !== undefined ? scene.index : i;

        // F1 diagnostic probe — bypasses any buffer. Proves _makeSceneTask
        // actually started. If this line is missing from the export but a
        // TIMEOUT fires, the worker never invoked the task.
        _originalConsoleLog(`  [Diag] Scene ${si} _makeSceneTask entered @ ${new Date().toISOString()}`);

        // F2 periodic drain — armed only in multi-scene mode (where buffering
        // is on). 3s cadence so a hung scene surfaces logs without waiting
        // for the 180s timeout. Cleared in the wrapper's finally.
        scene._drainInterval = !useSingleSceneLive
            ? setInterval(() => { try { _drainSceneBuffer(i); } catch (_) {} }, 3000)
            : null;

        const _runBody = async () => {
            if (!useSingleSceneLive) _sceneBuffers.set(i, []);
            const failScene = (reason, mediaTypeForExt = scene.mediaType || 'video') => {
                console.log(`  [Media Trace] failed: ${reason}`);
                scene.mediaFile = null;
                scene.mediaExtension = mediaTypeForExt === 'image' ? '.jpg' : '.mp4';
                scene.sourceProvider = null;
                scene.mediaWidth = 0;
                scene.mediaHeight = 0;
                scene.mediaDownloadStatus = 'failed';
                _setMediaFinal(scene, { status: 'failed', reason });
                cleanupSceneTempMedia(`scene-${si}`);
                _logMediaTrace(scene);
                _flushSceneLog(i);
            };

            // ── RESUME: skip scenes already downloaded in a previous (cancelled) run ──
            for (const ext of ['.mp4', '.jpg', '.jpeg', '.png', '.webp']) {
                const existing = path.join(config.paths.temp, `scene-${si}${ext}`);
                if (fs.existsSync(existing)) {
                    // Fix mediaType from actual file extension — plan may say "image" but
                    // the previously downloaded file could be a video (or vice versa).
                    const videoExts = new Set(['.mp4', '.webm', '.mov', '.mkv']);
                    const existingType = videoExts.has(ext) ? 'video' : 'image';
                    try {
                        _assertDownloadedFile(existing, existingType, 'resume');
                    } catch (err) {
                        console.log(`  ♻️ Scene ${si} resume file invalid — redownloading (${err.message})`);
                        continue;
                    }
                    console.log(`  ♻️ Scene ${si} already has media — reusing (resume)`);
                    // Emit a UI 'ok' row so the Build Log + counter mark this scene DONE on
                    // resume (without this the 84 reused scenes were invisible, making the
                    // phase look like a fresh 0-start while only the gaps showed downloading).
                    uiLog.sceneEvt('download', si, 'ok', 'reused (resume)', path.basename(existing));
                    scene.mediaFile = existing;
                    scene.mediaExtension = ext;
                    scene.sourceProvider = 'resumed';
                    scene.mediaDownloadStatus = 'resumed';
                    scene.mediaType = existingType;
                    scene.mediaDiagnostics = {
                        planner: {
                            keyword: scene.searchKeyword || scene.researchKeyword || scene.keyword || '',
                            searchKeyword: scene.searchKeyword || '',
                            stockQuery: scene.stockQuery || '',
                            webQuery: scene.webQuery || '',
                            mediaType: scene.mediaType,
                            sourceHint: scene.sourceHint || '',
                        },
                        intent: scene.mediaIntent || null,
                        providers: [{ provider: 'resume', mediaType: scene.mediaType, status: 'resumed', reason: 'existing temp file' }],
                        final: { status: 'resumed', provider: 'resumed', path: existing },
                    };
                    _logMediaTrace(scene);
                    _flushSceneLog(i);
                    return;
                }
            }

            let mediaType = scene.mediaType || 'video';
            let sourceHint = sanitizeSourceHint(scene.sourceHint || '', 'youtube') || '';
            if (sourceHint !== (scene.sourceHint || '')) scene.sourceHint = sourceHint;
            const intentPolicy = _mediaIntentPolicy(scene);
            scene.mediaDiagnostics = {
                planner: {
                    keyword: scene.searchKeyword || scene.researchKeyword || scene.keyword || '',
                    searchKeyword: scene.searchKeyword || '',
                    stockQuery: scene.stockQuery || '',
                    webQuery: scene.webQuery || '',
                    mediaType,
                    sourceHint,
                    templateHint: scene.templateHint || null,
                    fullscreenMG: scene.fullscreenMG || null,
                },
                intent: scene.mediaIntent || null,
                mediaAgent: null,
                providers: [],
                hunter: null,
                final: null,
            };

            if (!OPEN_MEDIA_GATES && (intentPolicy.download === 'skip' || intentPolicy.download === 'template')) {
                scene.mediaDownloadStatus = 'skipped';
                scene.mediaFile = null;
                scene.sourceProvider = null;
                _setMediaFinal(scene, { status: 'skipped', reason: `media intent download=${intentPolicy.download}` });
                _logMediaTrace(scene);
                _flushSceneLog(i);
                return;
            }

            if (!OPEN_MEDIA_GATES && intentPolicy.mediaType && mediaType !== intentPolicy.mediaType) {
                console.log(`  [Media Lock] type ${mediaType} -> ${intentPolicy.mediaType} (${scene.mediaIntent?.lane || 'intent'})`);
                mediaType = intentPolicy.mediaType;
                scene.mediaType = mediaType;
            }
            const policySourceHint = sanitizeSourceHint(intentPolicy.sourceHint || '', 'youtube');
            if (!OPEN_MEDIA_GATES && policySourceHint && sourceHint !== policySourceHint) {
                console.log(`  [Media Intent] source suggestion ${sourceHint || 'none'} -> ${policySourceHint} (soft; Media Agent decides provider)`);
                if (!sourceHint) {
                    sourceHint = policySourceHint;
                    scene.sourceHint = sourceHint;
                }
            }

            // Auto-correct type if providers aren't available
            if (mediaType === 'video' && !hasVideoProviders && hasImageProviders && _mediaIntentAllowsType(scene, 'image')) {
                mediaType = 'image';
                scene.mediaType = 'image';
            } else if (mediaType === 'image' && !hasImageProviders && hasVideoProviders && _mediaIntentAllowsType(scene, 'video')) {
                mediaType = 'video';
                scene.mediaType = 'video';
            } else if (mediaType === 'video' && !hasVideoProviders) {
                failScene('no video providers available and media intent blocks image fallback', mediaType);
                return;
            } else if (mediaType === 'image' && !hasImageProviders) {
                failScene('no image providers available and media intent blocks video fallback', mediaType);
                return;
            }

            if (mediaType === 'image' && hasVideoProviders && _mediaIntentAllowsType(scene, 'video') && _shouldUpgradeImageToVideo(scene, scriptContext)) {
                mediaType = 'video';
                scene.mediaType = 'video';
                if (!sourceHint || sourceHint === 'stock') {
                    sourceHint = 'youtube';
                }
                console.log(`  🎞️ Media repair: image → video for concrete factual scene`);
            }

            const split = applySearchKeywordSplit(scene, scriptContext);
            if (split.changed) {
                console.log(`  Search keyword trim: "${split.before}" -> "${split.after}" (entity context kept separate)`);
            }

            let keyword = scene.searchKeyword || scene.researchKeyword || scene.keyword;
            const sceneDuration = (scene.endTime || 0) - (scene.startTime || 0) || 10;
            const nicheId = scriptContext?.nicheId || '';

            // Validate and fix keyword before searching
            keyword = validateKeyword(keyword, scene, scriptContext);
            keyword = trimSearchKeyword(keyword, scene);
            scene.searchKeyword = keyword;
            scene.mediaDiagnostics.planner.keyword = keyword;
            scene.mediaDiagnostics.planner.searchKeyword = keyword;
            scene.mediaDiagnostics.planner.entityContext = _sceneEntityContext(scene, scriptContext);
            scene.mediaDiagnostics.planner.mediaType = mediaType;
            scene.mediaDiagnostics.planner.sourceHint = sourceHint;

            console.log(`\n${'═'.repeat(70)}`);
            console.log(`📌 Scene ${si}/${scenes.length - 1} (${mediaType})${_resumeActive ? ' [resume re-attempt]' : ''} — "${keyword}"${sourceHint ? `  [hint: ${sourceHint}]` : ''}${nicheId ? `  [niche: ${nicheId}]` : ''}`);
            uiLog.sceneEvt('download', si, 'start', `${mediaType} · "${keyword}"${_resumeActive ? ' · resume re-attempt' : ''}`, sourceHint ? `hint: ${sourceHint}` : '');
            console.log(`${'─'.repeat(70)}`);
            if (scene.stockQuery || scene.webQuery) {
                console.log(`  🎯 Optimized: stock="${scene.stockQuery || '-'}" web="${scene.webQuery || '-'}"`);
            }

            // Check media cache first (reuse previously downloaded clips)
            if (allowMediaCacheReuse && _mediaCache.size > 0) {
                const cached = _checkMediaCache(keyword, mediaType, si, `scene-${si}`);
                if (cached) {
                    console.log(`  ♻️ Cache hit! Reusing ${path.basename(cached.path)} (from ${cached.provider})`);
                    console.log(`  ✅ Scene ${si} DONE (cached)`);
                    scene.mediaFile = cached.path;
                    scene.mediaExtension = cached.ext;
                    scene.sourceProvider = cached.provider;
                    scene.mediaWidth = cached.mediaWidth || 0;
                    scene.mediaHeight = cached.mediaHeight || 0;
                    scene.mediaDownloadStatus = 'cached';
                    scene.reusedFromCache = true;
                    _recordMediaProvider(scene, {
                        provider: cached.provider,
                        mediaType,
                        query: keyword,
                        status: 'cached',
                        reason: 'cache hit',
                    });
                    _setMediaFinal(scene, { status: 'cached', provider: cached.provider, path: cached.path });
                    _logMediaTrace(scene);
                    _flushSceneLog(i);
                    return;
                }
            }

            // ── AI-VIDEO lane ── opt-in; GENERATE instead of download. ──
            // Reached only when a directive/niche/planner set sourceHint='ai-video'.
            // Backend chosen by AI_VIDEO_BACKEND: 'kling' (default — browser bridge,
            // uses the account's credits, NO key) or 'veo' (API, needs VEO_API_KEY).
            // On any miss we reset to stock and fall through the normal gauntlet
            // (no scene left blank).
            if (sourceHint === 'ai-video') {
                const backend = String(process.env.AI_VIDEO_BACKEND || 'kling').trim().toLowerCase();
                const aiPrompt = _buildAiVideoPrompt(scene, keyword);
                const aspect = _veoAspect(scriptContext);
                const outFile = path.join(config.paths.temp, `scene-${si}.mp4`);
                let clip = null;
                let providerName = backend === 'veo' ? 'veo' : 'kling';
                try {
                    if (backend === 'veo') {
                        if (veoProvider.isEnabled()) {
                            console.log(`  🤖 Scene ${si}: generating AI video (Veo) — "${aiPrompt.slice(0, 90)}"`);
                            uiLog.sceneEvt('download', si, 'start', `AI video (Veo) · "${keyword}"`, 'ai-video');
                            clip = await veoProvider.generateVeoClip({
                                prompt: aiPrompt, outFile, durationSec: sceneDuration,
                                aspectRatio: aspect, log: (m) => console.log(`     ${m}`),
                            });
                        } else {
                            console.log(`  ⚠️ Scene ${si}: AI_VIDEO_BACKEND=veo but Veo not configured (need VEO_API_KEY) — using stock`);
                        }
                    } else {
                        // Kling browser bridge — no key, spends the account's credits.
                        if (klingVideoProvider.isEnabled()) {
                            console.log(`  🎬 Scene ${si}: generating AI video (Kling) — "${aiPrompt.slice(0, 90)}"`);
                            uiLog.sceneEvt('download', si, 'start', `AI video (Kling) · "${keyword}"`, 'ai-video');
                            clip = await klingVideoProvider.generateVideoClip({
                                prompt: aiPrompt, outFile, durationSec: sceneDuration,
                                aspectRatio: aspect, log: (m) => console.log(`     ${m}`),
                            });
                        } else {
                            console.log(`  ⚠️ Scene ${si}: AI_VIDEO_BACKEND=kling but no Kling session — run \`npm run kling-cookies\` — using stock`);
                        }
                    }
                } catch (e) {
                    console.log(`  ⚠️ Scene ${si}: ${providerName} generation failed (${e.message}) — falling back to stock`);
                    uiLog.sceneEvt('download', si, 'warn', `${providerName} failed → stock`, e.message);
                }
                if (clip) {
                    const dims = _aiVideoDims(aspect, backend);
                    scene.mediaFile = clip;
                    scene.mediaExtension = '.mp4';
                    scene.mediaType = 'video';
                    mediaType = 'video';
                    scene.sourceProvider = providerName;
                    scene.mediaWidth = dims.w;
                    scene.mediaHeight = dims.h;
                    scene.mediaDownloadStatus = 'ai-generated';
                    _recordMediaProvider(scene, {
                        provider: providerName, mediaType: 'video', query: aiPrompt,
                        status: 'accepted', reason: `AI generated (${providerName})`, path: clip,
                    });
                    _setMediaFinal(scene, {
                        status: 'ai-generated', provider: providerName, path: clip,
                        mediaType: 'video', reason: `AI generated (${providerName})`,
                    });
                    console.log(`  ✅ Scene ${si} DONE → ${providerName}: ${path.basename(clip)}`);
                    uiLog.sceneEvt('download', si, 'ok', providerName, path.basename(clip));
                    _logMediaTrace(scene);
                    _flushSceneLog(i);
                    return;
                }
                // Fallback: treat this scene as stock for the rest of the pipeline.
                sourceHint = 'stock';
                scene.sourceHint = 'stock';
                scene.mediaDiagnostics.planner.sourceHint = 'stock';
            }

            // Log provider priority
            const priorityOrder = getSmartPriority(sourceHint, mediaType, scriptContext);
            const prioritySource = sourceHint && SOURCE_PRIORITY_MAP[sourceHint] ? 'hint' : nicheId ? 'niche' : 'default';
            console.log(`  📦 Priority: ${priorityOrder.join(' → ')} (${prioritySource})`);

            let mediaDownloadStatus = 'accepted';
            let stockFallbackTried = false;
            // Track every (mediaType, query) pair already attempted in this scene's
            // retry chain. getKeywordVariants + getHunterFallbackKeywords + niche
            // fallbacks frequently produce duplicates (e.g. "speed queen washer" shows
            // up as primary, hunter variant, AND niche fallback). Each duplicate
            // burned 60-90s of AI scoring on the exact same candidate list.
            const _triedDownloadKeys = new Set();
            const _shouldSkipDuplicateQuery = (q, mt) => {
                const norm = String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
                if (!norm) return false;
                const key = `${String(mt || '')}|${norm}`;
                if (_triedDownloadKeys.has(key)) {
                    console.log(`  ⏭️ Skipping duplicate retry query (${mt}): "${norm.slice(0, 60)}"`);
                    return true;
                }
                _triedDownloadKeys.add(key);
                return false;
            };
            const sceneRemainingMs = () => scene?._deadlineAt ? Math.max(0, scene._deadlineAt - Date.now()) : Infinity;
            const hasOuterSceneBudget = (minMs, step) => {
                if (scene?._aborted || _sceneAbortSignal(scene)?.aborted) return false;
                const left = sceneRemainingMs();
                if (Number.isFinite(left) && left < minMs) {
                    console.log(`  Scene deadline: ${Math.round(left / 1000)}s left, skipping ${step}`);
                    return false;
                }
                return true;
            };
            const retryMissionBudgetMs = (mt = mediaType) => Math.max(
                12_000,
                parseInt(process.env.MEDIA_RETRY_MIN_BUDGET_MS || (mt === 'image' ? '18000' : '35000'), 10) || (mt === 'image' ? 18_000 : 35_000)
            );
            const DEADLINE_RESCUE_TRIGGER_MS = Math.max(
                8_000,
                parseInt(process.env.MEDIA_DEADLINE_RESCUE_TRIGGER_MS || '22000', 10) || 22_000
            );
            const DEADLINE_RESCUE_IMAGE_MIN_BUDGET_MS = Math.max(
                2_000,
                parseInt(process.env.MEDIA_DEADLINE_RESCUE_IMAGE_MIN_BUDGET_MS || '5000', 10) || 5_000
            );
            const tryControlledStockFallback = async (reason) => {
                if (stockFallbackTried || !_shouldTryControlledStockVideoFallback(scene, mediaType)) return null;
                const stockSkipReason = _getMediaAgentStockProviderSkipReason(scene?._mediaAgentPlan);
                if (stockSkipReason) {
                    stockFallbackTried = true;
                    console.log(`  [Media Agent] skipping controlled stock-video fallback: ${stockSkipReason}`);
                    return null;
                }
                stockFallbackTried = true;
                if (!hasOuterSceneBudget(STRICT_RAW_STOCK_MIN_ATTEMPT_MS, 'controlled stock-video fallback')) return null;

                const stockVariants = getHunterFallbackKeywords(keyword, scene, scriptContext, {
                    mediaType: 'video',
                    sourceHint: 'stock',
                    nicheId,
                    providerKey: _preferredStockVideoProviderKey(),
                    forceKeywordBase: true,
                    max: STRICT_RAW_STOCK_VARIANTS,
                });
                if (stockVariants.length === 0) return null;

                const leftLabel = Number.isFinite(sceneRemainingMs())
                    ? `${Math.round(sceneRemainingMs() / 1000)}s left`
                    : 'no deadline';
                console.log(`  [Deadline Reserve] Trying controlled stock-video fallback early (${reason}; ${leftLabel}) (${stockVariants.slice(0, 3).join(' | ')}${stockVariants.length > 3 ? ' | ...' : ''})`);
                for (const variant of stockVariants) {
                    if (_shouldSkipDuplicateQuery(variant, 'video')) continue;
                    if (!hasOuterSceneBudget(STRICT_RAW_STOCK_MIN_ATTEMPT_MS, `controlled stock fallback "${variant}"`)) break;
                    const stockResult = await downloadMedia(variant, 'video', `scene-${si}`, sceneDuration, 'stock', nicheId, scene, {
                        allowStockFallback: true,
                        stockOnly: true,
                        forceKeywordQuery: true,
                    });
                    if (stockResult) {
                        mediaDownloadStatus = 'providerFallbackAccepted';
                        return stockResult;
                    }
                }
                return null;
            };
            let deadlineImageRescueTried = false;
            const tryDeadlineImageRescue = async (reason) => {
                if (deadlineImageRescueTried) return null;
                if (mediaType !== 'video') return null;
                if (!hasImageProviders || !_mediaIntentAllowsType(scene, 'image')) return null;
                const left = sceneRemainingMs();
                if (!Number.isFinite(left) || left > DEADLINE_RESCUE_TRIGGER_MS) return null;
                if (!hasOuterSceneBudget(DEADLINE_RESCUE_IMAGE_MIN_BUDGET_MS, 'deadline image rescue')) return null;
                deadlineImageRescueTried = true;
                const rescueVariants = [
                    keyword,
                    ...(buildSearchKeywordVariants(keyword, scene, { max: 4 }) || []),
                    scene?.templateBgQuery,
                    scene?.webQuery,
                    scene?.stockQuery,
                ].map(value => trimSearchKeyword(value, { searchKeyword: value, _forcedSearchKeyword: value }, { maxWords: 8 }))
                    .filter(Boolean);
                const uniqueVariants = _uniqueQueryLanes(rescueVariants, 5);
                if (uniqueVariants.length === 0) return null;
                console.log(`  [Deadline Rescue] ${Math.round(left / 1000)}s left after ${reason}; trying fast image fallback (${uniqueVariants.slice(0, 3).join(' | ')})`);
                for (const variant of uniqueVariants) {
                    if (_shouldSkipDuplicateQuery(variant, 'image')) continue;
                    if (!hasOuterSceneBudget(DEADLINE_RESCUE_IMAGE_MIN_BUDGET_MS, `deadline image rescue "${variant}"`)) break;
                    const rescue = await downloadMedia(variant, 'image', `scene-${si}`, sceneDuration, 'web-image', nicheId, scene, {
                        forceKeywordQuery: true,
                        skipMediaAgent: true,
                        deadlineRescue: true,
                    });
                    if (rescue) {
                        scene.mediaType = 'image';
                        mediaDownloadStatus = 'fallbackAccepted';
                        console.log(`  ✅ Deadline image rescue worked: "${variant}"`);
                        return rescue;
                    }
                }
                return null;
            };

            // F1 diagnostic probe — direct log, bypasses buffer. If this line
            // appears but no provider logs follow, the hang is inside downloadMedia
            // (network/yt-dlp). If it's missing, the hang is upstream in setup.
            _originalConsoleLog(`  [Diag] Scene ${si} entering first downloadMedia("${_short(keyword, 60)}", ${mediaType}) @ ${new Date().toISOString()}`);
            _shouldSkipDuplicateQuery(keyword, mediaType); // seed primary attempt
            let result = await downloadMedia(keyword, mediaType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene);
            if (!result) {
                result = await tryControlledStockFallback('primary web sources failed');
            }
            if (!result) {
                result = await tryDeadlineImageRescue('primary/provider fallback');
            }

            // If the primary keyword failed, try Media Hunter visual alternates
            // before destructive simplification. This keeps the scene meaning but
            // changes the visual angle from "topic/article" to "usable B-roll".
            if (!result) {
                const hunterVariants = getHunterFallbackKeywords(keyword, scene, scriptContext, {
                    mediaType,
                    sourceHint,
                    nicheId,
                    providerKey: mediaType === 'video' ? 'youtube' : 'bing',
                    max: scene?._mediaHunterProfile?.strictRaw && !scene._mediaHunterProfile.allowGraphics ? 2 : 4,
                });
                for (const variant of hunterVariants) {
                    if (!variant || variant.toLowerCase() === String(keyword || '').toLowerCase()) continue;
                    if (_shouldSkipDuplicateQuery(variant, mediaType)) continue;
                    if (!hasOuterSceneBudget(retryMissionBudgetMs(mediaType), `Media Hunter retry "${variant}"`)) break;
                    if (scene?._mediaHunterProfile?.strictRaw
                        && !scene._mediaHunterProfile.allowGraphics
                        && _shouldTryControlledStockVideoFallback(scene, mediaType)
                        && !hasOuterSceneBudget(STRICT_RAW_STOCK_RESERVE_MS, `Media Hunter retry "${variant}"`)) {
                        break;
                    }
                    console.log(`  Media Hunter retry: "${variant}"`);
                    result = await downloadMedia(variant, mediaType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene, {
                        forceKeywordQuery: true,
                    });
                    if (result) break;
                }
            }
            if (!result) {
                result = await tryDeadlineImageRescue('Media Hunter retries');
            }

            // If strict raw web sources are polluted with explainers/news packages,
            // keep the lane as VIDEO but let clean stock-video B-roll rescue the scene.
            if (!result && !stockFallbackTried && _shouldTryControlledStockVideoFallback(scene, mediaType)) {
                const stockSkipReason = _getMediaAgentStockProviderSkipReason(scene?._mediaAgentPlan);
                if (stockSkipReason) {
                    stockFallbackTried = true;
                    console.log(`  [Media Agent] skipping controlled stock-video fallback: ${stockSkipReason}`);
                } else {
                stockFallbackTried = true;
                const stockVariants = getHunterFallbackKeywords(keyword, scene, scriptContext, {
                    mediaType: 'video',
                    sourceHint: 'stock',
                    nicheId,
                    providerKey: _preferredStockVideoProviderKey(),
                    forceKeywordBase: true,
                    max: STRICT_RAW_STOCK_VARIANTS,
                });
                if (stockVariants.length > 0) {
                    console.log(`  🔄 Trying controlled stock-video fallback (${stockVariants.slice(0, 3).join(' | ')}${stockVariants.length > 3 ? ' | ...' : ''})`);
                }
                for (const variant of stockVariants) {
                    if (_shouldSkipDuplicateQuery(variant, 'video')) continue;
                    if (!hasOuterSceneBudget(retryMissionBudgetMs('video'), `controlled stock fallback "${variant}"`)) break;
                    result = await downloadMedia(variant, 'video', `scene-${si}`, sceneDuration, 'stock', nicheId, scene, {
                        allowStockFallback: true,
                        stockOnly: true,
                        forceKeywordQuery: true,
                    });
                    if (result) {
                        mediaDownloadStatus = 'providerFallbackAccepted';
                        break;
                    }
                }
                }
            }
            if (!result) {
                result = await tryDeadlineImageRescue('controlled stock fallback');
            }

            // If primary keyword failed, try simplified variants
            if (!result) {
                const skipSimplifiedRetries = stockFallbackTried
                    && scene?._mediaHunterProfile?.strictRaw
                    && !scene._mediaHunterProfile.allowGraphics
                    && _shouldTryControlledStockVideoFallback(scene, mediaType)
                    && !hasOuterSceneBudget(STRICT_RAW_STOCK_MIN_ATTEMPT_MS, 'simplified keyword retries');
                if (skipSimplifiedRetries) {
                    console.log(`  [Deadline Reserve] skipping simplified keyword retries after controlled stock fallback`);
                }
                const variants = skipSimplifiedRetries ? [] : getKeywordVariants(keyword, scene);
                for (const variant of variants) {
                    if (_shouldSkipDuplicateQuery(variant, mediaType)) continue;
                    if (!hasOuterSceneBudget(retryMissionBudgetMs(mediaType), `simplified keyword retry "${variant}"`)) break;
                    console.log(`  🔄 Retrying with simplified keyword: "${variant}"`);
                    result = await downloadMedia(variant, mediaType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene, {
                        forceKeywordQuery: true,
                    });
                    if (result) break;
                }
            }
            if (!result) {
                result = await tryDeadlineImageRescue('simplified retries');
            }

            // If still failed, try the other media type
            if (!result) {
                const fallbackType = mediaType === 'video' ? 'image' : 'video';
                const fallbackProviders = fallbackType === 'video' ? videoProviders : imageProviders;
                // Last-resort cross-type bypass: web-image scenes that exhausted
                // all image attempts may try video. Map-image scenes stay locked
                // (map planner picked specific images; videos don't substitute).
                const policy = _mediaIntentPolicy(scene);
                const lane = String(scene?.mediaIntent?.lane || '').toLowerCase();
                const source = sanitizeSourceHint(policy.sourceHint || scene.sourceHint || '', 'youtube') || '';
                const lastResortWebImageToVideo = fallbackType === 'video'
                    && mediaType === 'image'
                    && source === 'web-image'
                    && lane !== 'mapimage';
                const allowed = lastResortWebImageToVideo || _mediaIntentAllowsType(scene, fallbackType);
                if (!allowed) {
                    console.log(`  [Media Lock] blocked fallback type ${mediaType} -> ${fallbackType}`);
                } else if (fallbackProviders.some(p => p.isAvailable())) {
                    if (lastResortWebImageToVideo && !_mediaIntentAllowsType(scene, fallbackType)) {
                        console.log(`  [Media Lock] last-resort bypass: web-image exhausted, allowing video fallback`);
                    }
                    let fallbackSourceHint;
                    if (fallbackType === 'image') {
                        fallbackSourceHint = 'web-image';
                    } else if (lastResortWebImageToVideo) {
                        // Web-image scenes have sourceHint='web-image' which has no
                        // meaning for video providers — default to stock for video.
                        fallbackSourceHint = 'stock';
                    } else {
                        fallbackSourceHint = sourceHint;
                    }
                    console.log(`  🔄 Trying fallback type: ${fallbackType}...`);
                    if (!_shouldSkipDuplicateQuery(keyword, fallbackType)) {
                        if (hasOuterSceneBudget(retryMissionBudgetMs(fallbackType), `fallback type ${fallbackType}`)) {
                            result = await downloadMedia(keyword, fallbackType, `scene-${si}`, sceneDuration, fallbackSourceHint, nicheId, scene, {
                                forceKeywordQuery: true,
                            });
                        }
                    }

                    if (!result) {
                        const variants = getKeywordVariants(keyword, scene);
                        for (const variant of variants) {
                            if (_shouldSkipDuplicateQuery(variant, fallbackType)) continue;
                            if (!hasOuterSceneBudget(retryMissionBudgetMs(fallbackType), `${fallbackType} retry "${variant}"`)) break;
                            console.log(`  🔄 Retrying ${fallbackType} with: "${variant}"`);
                            result = await downloadMedia(variant, fallbackType, `scene-${si}`, sceneDuration, fallbackSourceHint, nicheId, scene, {
                                forceKeywordQuery: true,
                            });
                            if (result) break;
                        }
                    }

                    if (result) {
                        scene.mediaType = fallbackType;
                        mediaDownloadStatus = 'fallbackAccepted';
                    }
                }
            }
            if (!result) {
                result = await tryDeadlineImageRescue('cross-type fallback');
            }

            // Last resort: niche fallback keywords
            if (!result && nicheId) {
                {
                    const strictRecovery = Boolean(scene?._mediaHunterProfile?.strictRaw && !scene._mediaHunterProfile.allowGraphics);
                    let fallbacks = getFallbackKeywords(nicheId);
                    if (strictRecovery) {
                        const visualFallbacks = buildSearchKeywordVariants(keyword, scene, { max: 8 });
                        fallbacks = [...visualFallbacks, ...fallbacks];
                        console.log(`  [Media Hunter] strict recovery fallbacks enabled before continuity (${visualFallbacks.slice(0, 3).join(' | ')}${visualFallbacks.length > 3 ? ' | ...' : ''})`);
                    }
                    // Filter by mediaHunter domain when present — generic niche
                    // fallbacks (e.g. "capitol building", "parliament session")
                    // are off-domain for maritime/industrial/health/food scenes
                    // and just burn provider quota.
                    const prefer = Array.isArray(scene?._mediaHunterProfile?.prefer)
                        ? scene._mediaHunterProfile.prefer.map(s => String(s).toLowerCase())
                        : null;
                    if (prefer && prefer.length > 0) {
                        const matches = fallbacks.filter(fb => {
                            const fbLower = String(fb).toLowerCase();
                            return prefer.some(p => fbLower.includes(p));
                        });
                        if (matches.length > 0) {
                            console.log(`  🎯 [Media Hunter] narrowed niche fallbacks to domain matches: ${matches.length}/${fallbacks.length}`);
                            fallbacks = matches;
                        } else if (!strictRecovery) {
                            console.log(`  ⚠️ [Media Hunter] no niche fallbacks match domain prefer-list; skipping rather than searching off-domain`);
                            fallbacks = [];
                        }
                    }
                    fallbacks = [...new Set(fallbacks.map(fb => String(fb || '').trim()).filter(Boolean))].slice(0, strictRecovery ? 8 : 12);
                    if (fallbacks.length > 0) {
                        console.log(`  🔄 Trying niche fallback keywords (${nicheId})...`);
                        for (const fbKeyword of fallbacks) {
                            if (_shouldSkipDuplicateQuery(fbKeyword, mediaType)) continue;
                            if (!hasOuterSceneBudget(retryMissionBudgetMs(mediaType), `niche fallback "${fbKeyword}"`)) break;
                            result = await downloadMedia(fbKeyword, mediaType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene, {
                                forceKeywordQuery: true,
                            });
                            if (result) {
                                mediaDownloadStatus = 'fallbackAccepted';
                                console.log(`  ✅ Niche fallback worked: "${fbKeyword}"`);
                                break;
                            }
                        }
                    }

                    // Symmetric image pass — if niche fallbacks failed as video and
                    // intent permits image, retry the SAME fallback list as image.
                    // Catches scenes where the keyword is unsearchable on video
                    // providers but a stock image of the same subject exists.
                    if (!result && mediaType === 'video' && _mediaIntentAllowsType(scene, 'image') && hasImageProviders && fallbacks.length > 0) {
                        console.log(`  🔄 Trying niche fallback keywords as image (${nicheId})...`);
                        for (const fbKeyword of fallbacks) {
                            if (_shouldSkipDuplicateQuery(fbKeyword, 'image')) continue;
                            if (!hasOuterSceneBudget(retryMissionBudgetMs('image'), `niche image fallback "${fbKeyword}"`)) break;
                            result = await downloadMedia(fbKeyword, 'image', `scene-${si}`, sceneDuration, 'web-image', nicheId, scene, {
                                forceKeywordQuery: true,
                            });
                            if (result) {
                                scene.mediaType = 'image';
                                mediaDownloadStatus = 'fallbackAccepted';
                                console.log(`  ✅ Niche fallback (image) worked: "${fbKeyword}"`);
                                break;
                            }
                        }
                    }
                }
            }

            if (!result) {
                result = await tryDeadlineImageRescue('niche fallbacks');
            }

            // If the outer timeout already fired, drop any late completion on the floor —
            // the timeout handler has already written the final scene state and logged it.
            if (scene._aborted) {
                _originalConsoleLog(`  ⏱️ [Scene ${si}] late completion ignored (scene was aborted)`);
                if (!_readyScenes.has(i)) _flushSceneLog(i);
                return;
            }

            if (!result) {
                const agenticFallback = createAgenticGraphicFallback(scene, {
                    filenameBase: `scene-${si}`,
                    keyword,
                    mediaType,
                    sceneDuration,
                    reason: 'all providers and AI repair attempts exhausted',
                });
                if (agenticFallback) {
                    result = agenticFallback;
                    scene.mediaType = 'image';
                    mediaDownloadStatus = 'agenticGraphicFallback';
                    _recordMediaProvider(scene, {
                        provider: agenticFallback.provider,
                        key: 'agentic-visual-fallback',
                        mediaType: 'image',
                        query: keyword,
                        // NOT 'accepted'. This card is what we draw when every
                        // provider failed; recording it as a success is how a
                        // build reported "0 missing" while shipping blanks.
                        // `scene-coverage.js` treats it as uncovered and the
                        // late rescue sweep comes back for it.
                        status: 'placeholder',
                        reason: agenticFallback.reason,
                        path: agenticFallback.path,
                    });
                    console.log(`  ⚠️ Scene ${si}: NO real footage found — placeholder card stands in (${agenticFallback.reason}); flagged for rescue`);
                }
            }

            if (result) {
                scene.mediaFile = result.path;
                scene.mediaExtension = result.ext;
                scene.sourceProvider = result.provider;
                scene.mediaWidth = result.mediaWidth || 0;
                scene.mediaHeight = result.mediaHeight || 0;
                scene.mediaDownloadStatus = mediaDownloadStatus;
                _setMediaFinal(scene, {
                    status: mediaDownloadStatus,
                    provider: result.provider,
                    path: result.path,
                    mediaType: scene.mediaType,
                    reason: result.agenticFallback
                        ? (result.reason || 'agentic visual fallback')
                        : (result.visionScore ? `vision ${result.visionScore}/10` : 'accepted'),
                });
                console.log(`  ✅ Scene ${si} DONE → ${result.provider}: ${path.basename(result.path)}${result.visionScore ? ` (vision: ${result.visionScore}/10)` : ''}${result.agenticFallback ? ' (agentic fallback)' : ''}`);
                uiLog.sceneEvt('download', si, 'ok', `${result.provider}${result.visionScore ? ` ${result.visionScore}/10` : ''}${result.agenticFallback ? ' fallback' : ''}`, path.basename(result.path));

                if (!result.noCache) {
                    _cacheMedia(keyword, result, result.visionScore || 0, si);
                }
            } else {
                console.log(`  ❌ Scene ${si}: No media found after all retries`);
                uiLog.sceneEvt('download', si, 'fail', 'no media found', `"${keyword}" — all providers/retries exhausted`);
                scene.mediaFile = null;
                scene.mediaExtension = mediaType === 'image' ? '.jpg' : '.mp4';
                scene.sourceProvider = null;
                scene.mediaWidth = 0;
                scene.mediaHeight = 0;
                scene.mediaDownloadStatus = 'failed';
                _setMediaFinal(scene, { status: 'failed', reason: 'no media after retries' });
                cleanupSceneTempMedia(`scene-${si}`);
            }

            _logMediaTrace(scene);
            // Flush this scene's buffered logs as a clean block (no-op in single-scene live mode)
            if (!useSingleSceneLive) _flushSceneLog(i);
        };

        try {
            return useSingleSceneLive
                ? await _runBody()
                : await _logStorage.run({ sceneIdx: i }, _runBody);
        } finally {
            if (scene._drainInterval) {
                try { clearInterval(scene._drainInterval); } catch (_) {}
                scene._drainInterval = null;
                // Final drain to catch anything queued between last tick and completion.
                if (!useSingleSceneLive) try { _drainSceneBuffer(i); } catch (_) {}
            }
        }
    };

    // Wrap each task with a hard per-scene timeout so a hung download never blocks the build.
    // We attach an AbortController so in-flight HTTP requests cancel on timeout, and flip a
    // scene._aborted flag so any late completion inside _makeSceneTask bails out before
    // overwriting the timeout's failure state (and before logging a phantom "DONE").
    const tasks = scenes.map((scene, i) => async () => {
        const si = scene.index !== undefined ? scene.index : i;
        const sceneTimeoutMs = _effectiveSceneTimeoutMs(scene, SCENE_TIMEOUT_MS, options.label || '');
        const controller = new AbortController();
        scene._abortSignal = controller.signal;
        scene._aborted = false;
        scene._deadlineStartedAt = Date.now();
        scene._deadlineAt = scene._deadlineStartedAt + sceneTimeoutMs;
        scene._maxDeadlineAt = scene._deadlineAt + SCENE_TIMEOUT_GRACE_MS;
        scene._isScoutLab = isScoutLabLikeRun;
        let timeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            const armTimeout = () => {
                const delay = Math.max(0, Math.min(2 ** 31 - 1, Number(scene._deadlineAt || Date.now()) - Date.now()));
                timeoutId = setTimeout(() => {
                    if (!scene._aborted && Number(scene._deadlineAt || 0) > Date.now() + 250) {
                        armTimeout();
                        return;
                    }
                    // In-flight hold: if a candidate is mid-download or mid-scoring,
                    // don't yank it. Push the deadline forward (capped by maxDeadline)
                    // and re-arm so the current candidate can reach an accept/reject
                    // verdict before we give up on the scene.
                    if (!scene._aborted && scene._inFlightCandidate) {
                        const cap = Number(scene._maxDeadlineAt || 0);
                        const now = Date.now();
                        if (Number.isFinite(cap) && now < cap - 1000) {
                            const target = Math.min(cap, now + 30_000);
                            if (target > Number(scene._deadlineAt || 0) + 500) {
                                scene._deadlineAt = target;
                                scene._softTimedOut = true;
                                const reason = scene._inFlightCandidateReason || 'in-flight candidate';
                                const activeCount = Math.max(1, Number(scene._inFlightCandidateCount || 1));
                                const activeText = activeCount > 1 ? ` (${activeCount} active)` : '';
                                console.log(`  [Deadline Hold] ${reason}${activeText} — holding abort ${Math.round((target - now) / 1000)}s to let current candidate finish`);
                                armTimeout();
                                return;
                            }
                        }
                    }
                    scene._aborted = true;
                    try { controller.abort(); } catch (_) {}
                    const elapsedMin = Math.max(0, (Date.now() - (scene._deadlineStartedAt || Date.now())) / 60000);
                    reject(new Error(`timed out after ${elapsedMin.toFixed(1)} min`));
                }, delay);
            };
            armTimeout();
        });
        try {
            await Promise.race([_makeSceneTask(scene, i)(), timeoutPromise]);
            if (timeoutId) clearTimeout(timeoutId);
        } catch (err) {
            if (timeoutId) clearTimeout(timeoutId);
            scene._aborted = true;
            try { controller.abort(); } catch (_) {}
            // Stop the periodic drain (if any) and force one final drain so any
            // logs queued mid-flight surface BEFORE the TIMEOUT line — gives the
            // reader the last words of the scene before it died.
            if (scene._drainInterval) {
                try { clearInterval(scene._drainInterval); } catch (_) {}
                scene._drainInterval = null;
            }
            if (!useSingleSceneLive) {
                try { _drainSceneBuffer(i); } catch (_) {}
            }
            _originalConsoleLog(`  ⏱️ [Scene ${si}] TIMEOUT — skipping: ${err.message}`);
            const timeoutFallback = createAgenticGraphicFallback(scene, {
                filenameBase: `scene-${si}`,
                keyword: scene.searchKeyword || scene.keyword || '',
                mediaType: scene.mediaType || 'video',
                sceneDuration: Math.max(1, Number(scene.endTime || 0) - Number(scene.startTime || 0)) || Number(scene.duration || 5) || 5,
                reason: `scene download timed out: ${err.message || 'timeout'}`,
            });
            if (timeoutFallback) {
                scene.mediaFile = timeoutFallback.path;
                scene.mediaExtension = timeoutFallback.ext;
                scene.sourceProvider = timeoutFallback.provider;
                scene.mediaType = 'image';
                scene.mediaWidth = timeoutFallback.mediaWidth || 1920;
                scene.mediaHeight = timeoutFallback.mediaHeight || 1080;
                scene.mediaDownloadStatus = 'agenticGraphicFallback';
                _recordMediaProvider(scene, {
                    provider: timeoutFallback.provider,
                    key: 'agentic-visual-fallback',
                    mediaType: 'image',
                    query: scene.searchKeyword || scene.keyword || '',
                    status: 'placeholder', // a timeout is a failure — see the twin above
                    reason: timeoutFallback.reason,
                    path: timeoutFallback.path,
                });
                _setMediaFinal(scene, {
                    status: 'agenticGraphicFallback',
                    provider: timeoutFallback.provider,
                    path: timeoutFallback.path,
                    mediaType: 'image',
                    reason: timeoutFallback.reason,
                });
                _originalConsoleLog(`  ⚠️ [Scene ${si}] TIMED OUT with no footage — placeholder card stands in; flagged for rescue`);
                uiLog.sceneEvt('download', si, 'timeout', 'no footage — placeholder stands in', path.basename(timeoutFallback.path));
            } else {
                uiLog.sceneEvt('download', si, 'timeout', 'timed out', err.message);
                scene.mediaFile = null;
                scene.mediaExtension = (scene.mediaType === 'image') ? '.jpg' : '.mp4';
                scene.sourceProvider = null;
                scene.mediaWidth = 0;
                scene.mediaHeight = 0;
                scene.mediaDownloadStatus = 'failed';
                _setMediaFinal(scene, { status: 'failed', reason: err.message || 'timeout' });
                cleanupSceneTempMedia(`scene-${si}`);
            }
            _logMediaTrace(scene);
            // Ensure buffered logs are flushed even on timeout
            if (!_readyScenes.has(i)) _flushSceneLog(i);
        }
    });

    await parallelWithLimit(tasks, CONCURRENCY);

    // NOTE: Intentionally NOT restoring console.log here. See comment above the
    // hijack installation — aborted scene tasks can keep emitting logs for
    // minutes after we return, and the hijack is what silences them.

    // Post-download: measure the REAL dimensions of every downloaded file.
    //
    // This used to run only when width/height were missing, which meant a wrong
    // number was trusted forever. Stock APIs report the ORIGINAL photo's size
    // while serving a smaller rendition, and explainer-image-provider invents a
    // 1280x720 when the provider reports nothing — both survive a "fill the
    // blanks" sweep untouched. Framing (Step 5.1) branches on this ratio, so a
    // fabricated size is a fabricated crop. The file on disk is the only
    // trustworthy source; measure it and let it win.
    let probeCount = 0;
    let correctedCount = 0;
    for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
        const scene = scenes[sIdx];
        if (!scene?.mediaFile) continue;
        const dims = probeMediaDimensions(scene.mediaFile);
        if (!dims || !(dims.width > 0) || !(dims.height > 0)) continue;
        if (!scene.mediaWidth || !scene.mediaHeight) {
            probeCount++;
        } else if (scene.mediaWidth !== dims.width || scene.mediaHeight !== dims.height) {
            console.log(`  📐 Scene ${sIdx + 1}: real size ${dims.width}x${dims.height} (was recorded as ${scene.mediaWidth}x${scene.mediaHeight})`);
            correctedCount++;
        }
        scene.mediaWidth = dims.width;
        scene.mediaHeight = dims.height;
    }
    if (probeCount > 0 || correctedCount > 0) {
        console.log(`  🔍 Measured dimensions: ${probeCount} filled in, ${correctedCount} corrected`);
    }

    // ── Visual-diversity MMR (OPENMONTAGE-BORROW-PLAN #20) — OPT-IN. Break up
    // near-duplicate ADJACENT B-roll by swapping media between nearby scenes.
    // Never adds/removes a scene; no-op if the optional CLIP dep is absent.
    if (process.env.CLIP_VISUAL_DIVERSITY === '1') {
        try {
            const clipEmbedder = require('./clip-embedder');
            if (await clipEmbedder.isAvailable()) {
                const eligible = scenes.filter((s) => s && s.mediaFile && s.sourceProvider
                    && !s.fullscreenMG && !s.isMGScene && !s.templateType
                    && s.mediaDownloadStatus !== 'agenticGraphicFallback'
                    && (!s.trackId || s.trackId === 'video-track-1'));
                let embedded = 0;
                for (const s of eligible) { if (!s._clipVisualVec) { if (await _computeSceneVisualVec(s)) embedded++; } else embedded++; }
                const order = eligible.slice().sort((a, b) => (Number(a.startTime) || 0) - (Number(b.startTime) || 0));
                const swaps = clipEmbedder.planAdjacentSwaps(order, { simMax: Number(process.env.CLIP_DIVERSITY_SIM_MAX || 0.92), window: 3 });
                let applied = 0;
                for (const { i, j } of swaps) {
                    const A = order[i], B = order[j];
                    if (!A || !B) continue;
                    for (const f of ['mediaFile', 'mediaExtension', 'mediaWidth', 'mediaHeight', 'mediaType', 'sourceProvider', '_clipVisualVec', '_clipTagVec']) {
                        const tmp = A[f]; A[f] = B[f]; B[f] = tmp;
                    }
                    applied++;
                }
                console.log(`  🎨 [CLIP MMR] embedded ${embedded}/${eligible.length} scene(s), swapped ${applied} adjacent near-duplicate cut(s)`);
            }
        } catch (e) { console.warn(`  [CLIP MMR] skipped: ${String(e.message || e).slice(0, 100)}`); }
    }

    // Provider usage summary
    const providerHits = {};
    const downloadStats = {
        total: scenes.length,
        directAccepted: 0,
        providerFallbackAccepted: 0,
        typeFallbackAccepted: 0,
        cached: 0,
        resumed: 0,
        skipped: 0,
        agenticGraphicFallback: 0,
        failed: 0,
    };
    for (const scene of scenes) {
        const status = scene.mediaDownloadStatus || (scene.mediaFile ? 'accepted' : 'failed');
        if (status === 'accepted') downloadStats.directAccepted++;
        else if (status === 'providerFallbackAccepted') downloadStats.providerFallbackAccepted++;
        else if (status === 'fallbackAccepted') downloadStats.typeFallbackAccepted++;
        else if (status === 'cached') downloadStats.cached++;
        else if (status === 'resumed') downloadStats.resumed++;
        else if (status === 'skipped') downloadStats.skipped++;
        else if (status === 'agenticGraphicFallback') downloadStats.agenticGraphicFallback++;
        else if (!scene.mediaFile) downloadStats.failed++;
        if (scene.reusedFromCache && status !== 'cached') downloadStats.cached++;
        if (scene.sourceProvider) {
            providerHits[scene.sourceProvider] = (providerHits[scene.sourceProvider] || 0) + 1;
        }
    }
    const hitsSummary = Object.entries(providerHits).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}(${c})`).join(', ');
    // Placeholders are NOT ready. They used to be added in here, which is how a
    // build could report full readiness while several scenes held nothing but a
    // generated apology card. They are counted and named separately so the
    // number on this line is the number of scenes that actually found footage.
    const readyBeforeContinuity = downloadStats.directAccepted
        + downloadStats.providerFallbackAccepted
        + downloadStats.typeFallbackAccepted
        + downloadStats.cached
        + downloadStats.resumed
        + downloadStats.skipped;
    const notReal = downloadStats.agenticGraphicFallback + downloadStats.failed;
    console.log(`\n${notReal > 0 ? '⚠️' : '✅'} Media download pass complete`);
    console.log(`  Media readiness: ${readyBeforeContinuity}/${downloadStats.total} with real footage | accepted=${downloadStats.directAccepted} providerFallback=${downloadStats.providerFallbackAccepted} typeFallback=${downloadStats.typeFallbackAccepted} cached=${downloadStats.cached} resumed=${downloadStats.resumed} skipped=${downloadStats.skipped} placeholder=${downloadStats.agenticGraphicFallback} missing=${downloadStats.failed}`);
    if (notReal > 0) {
        console.log(`  ⚠️ ${notReal} scene(s) have NO real footage (${downloadStats.agenticGraphicFallback} placeholder, ${downloadStats.failed} empty) — the coverage sweep will try to rescue them`);
    }
    console.log(`  Sources: ${hitsSummary || 'none'}\n`);
    return { scenes, stats: downloadStats };
}

// ============================================================
// BACKGROUND CANVAS DOWNLOAD
// ============================================================

const BACKGROUND_CACHE_DIR = path.join(__dirname, '..', '..', 'assets', 'backgrounds');

/**
 * Ensure background cache directory exists
 */
function ensureBackgroundCacheDir() {
    if (!fs.existsSync(BACKGROUND_CACHE_DIR)) {
        fs.mkdirSync(BACKGROUND_CACHE_DIR, { recursive: true });
    }
}

/**
 * Download background canvas video for a theme
 * Downloads subtle texture video that plays behind all footage
 * Cached in assets/backgrounds/ for future builds
 *
 * @param {string} themeId - Theme identifier (e.g., 'tech', 'nature', 'dark')
 * @returns {string|null} Path to downloaded background video, or null if failed
 */
async function downloadBackgroundCanvas(themeId) {
    console.log(`\n🎨 Downloading background canvas for theme: ${themeId}...`);

    ensureBackgroundCacheDir();

    const backgroundSource = getBackgroundSource(themeId);
    const cacheFile = path.join(BACKGROUND_CACHE_DIR, `${themeId}.mp4`);

    // Check cache first
    if (fs.existsSync(cacheFile)) {
        console.log(`   ✅ Cache hit: ${cacheFile}`);
        console.log(`   📦 Background ready (${backgroundSource.name})\n`);
        return cacheFile;
    }

    console.log(`   🔍 Searching: "${backgroundSource.name}"`);
    console.log(`   Keywords: ${backgroundSource.keywords.join(' | ')}`);

    // Try downloading from available free stock providers.
    let downloaded = false;

    if (!downloaded) {
        const pexels = new PexelsVideoProvider();
        if (pexels.isAvailable()) {
            try {
                for (const keyword of backgroundSource.keywords) {
                    const results = await pexels.search(keyword);
                    if (results && results.length > 0) {
                        const picked = results[0];
                        console.log(`   🎬 Found on ${pexels.name}: ${picked.url}`);
                        downloaded = await pexels.download(picked.url, cacheFile);
                        if (downloaded) break;
                    }
                }
            } catch (err) {
                console.log(`   ⚠️ ${pexels.name} failed: ${err.message}`);
            }
        }
    }

    if (!downloaded) {
        const pixabay = new PixabayVideoProvider();
        if (pixabay.isAvailable()) {
            try {
                for (const keyword of backgroundSource.keywords) {
                    const results = await pixabay.search(keyword);
                    if (results && results.length > 0) {
                        const picked = results[0];
                        console.log(`   ðŸŽ¬ Found on ${pixabay.name}: ${picked.url}`);
                        downloaded = await pixabay.download(picked.url, cacheFile);
                        if (downloaded) break;
                    }
                }
            } catch (err) {
                console.log(`   âš ï¸ ${pixabay.name} failed: ${err.message}`);
            }
        }
    }

    if (downloaded) {
        console.log(`   ✅ Background canvas downloaded & cached`);
        console.log(`   📦 ${cacheFile}\n`);
        return cacheFile;
    } else {
        console.log(`   ⚠️ Could not download background canvas`);
        console.log(`   💡 Rendering will use solid color fallback\n`);
        return null;
    }
}

module.exports = { downloadMedia, downloadAllMedia, initProviders, scoreDownloadedMedia: _scoreDownloadedMedia, enableInlineVision, setLogSink, cleanupSceneTempMedia, cleanupSceneRaceTempMedia, _getSmartPriority: getSmartPriority };
