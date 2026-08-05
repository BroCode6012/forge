const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { fileURLToPath } = require('url');
const timelineContract = require('../project/timeline-contract');
const { normalizeTextColor, textStyleSegments } = require('./text-style-ranges');
const { prefersFixedRenderer } = require('./authored-composition-policy');
const {
    normalizeAuthoredTimeline,
    validateComposition: validateAuthoredComposition,
    measureAuthoredMotion,
} = require('./hf-template-author');
const {
    buildAdaptiveContrastCss,
    buildAdaptiveContrastRuntime,
} = require('./hf-adaptive-contrast');
const {
    harmonizeVisualPalette,
} = require('./hf-palette-coherence');
const {
    videoLint,
    motionFamily: videoLintMotionFamily,
} = require('./hf-video-lint');
const {
    buildGraphicShellCss,
    graphicShellClassNames,
    graphicShellData,
} = require('./graphic-shells');
const {
    applyGraphicMediaPolicy,
    overlayAllowsFrameTreatment,
} = require('./overlay-visual-policy');

let themeRuntime = {};
let mgRegistryRuntime = {};
let agenticCompositionRuntime = {};
try {
    themeRuntime = require('../data/themes');
} catch (_) {
    themeRuntime = {};
}
try {
    mgRegistryRuntime = require('./mg-registry');
} catch (_) {
    mgRegistryRuntime = {};
}
try {
    agenticCompositionRuntime = require('./agentic-composition');
} catch (_) {
    agenticCompositionRuntime = {};
}
let mapHfBuilder = null;
try {
    mapHfBuilder = require('../map/map-hf-builder');
} catch (_) {
    mapHfBuilder = null;
}
let hfEffects = null;
try {
    hfEffects = require('./hf-effects');
} catch (_) {
    hfEffects = null;
}

const {
    getThemeTokens = () => ({}),
    getMGStylePreset = () => ({}),
    MG_THEME_OVERRIDES = {},
    TEMPLATE_THEME_OVERRIDES = {},
} = themeRuntime;

const {
    MG_REGISTRY = {},
    resolveSubType: resolveRegistrySubType = null,
    resolveAnimation: resolveRegistryAnimation = null,
} = mgRegistryRuntime;

const {
    normalizeAgenticCompositionSpec = null,
} = agenticCompositionRuntime;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveGsapRuntime() {
    for (const ref of ['gsap/dist/gsap.min.js', 'hyperframes/node_modules/gsap/dist/gsap.min.js']) {
        try {
            return require.resolve(ref);
        } catch (_) {
            // Try the next installed runtime.
        }
    }
    throw new Error('Local GSAP runtime is missing. Install the gsap package before generating HyperFrames projects.');
}

function cleanName(value, fallback = 'asset') {
    const base = String(value == null || value === '' ? fallback : value)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 90);
    return base || fallback;
}

function classToken(value, fallback = 'item') {
    return cleanName(value, fallback)
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || fallback;
}

function html(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function css(value) {
    return String(value == null ? '' : value).replace(/[\\"]/g, '\\$&');
}

function toSeconds(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function getDuration(item, fallback = 3) {
    const start = toSeconds(item?.startTime, 0);
    const end = toSeconds(item?.endTime, NaN);
    const span = Number.isFinite(end) && end > start ? end - start : NaN;
    if (Number.isFinite(span) && span > 0 && span < 3600) return span;
    const explicitSeconds = toSeconds(item?.durationSeconds ?? item?.durationSec, NaN);
    if (Number.isFinite(explicitSeconds) && explicitSeconds > 0 && explicitSeconds < 3600) return explicitSeconds;
    const durationFrames = toSeconds(item?.durationFrames, NaN);
    const fps = Math.max(1, toSeconds(item?.fps, 30));
    if (Number.isFinite(durationFrames) && durationFrames > 0) return durationFrames / fps;
    const explicit = toSeconds(item?.duration, NaN);
    if (String(item?.durationUnit || item?.timingUnit || '').toLowerCase() === 'frames'
        && Number.isFinite(explicit) && explicit > 0) {
        return explicit / fps;
    }
    if (Number.isFinite(explicit) && explicit > 0 && explicit < 3600) return explicit;
    return fallback;
}

function renderDuration(value, fallback = 3) {
    return Math.max(0.033, Math.max(0.033, toSeconds(value, fallback)) - 0.002);
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return NaN;
}

function findFfmpeg() {
    const candidates = [
        process.env.FFMPEG_PATH,
        process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : null,
        'ffmpeg',
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (candidate === 'ffmpeg') return candidate;
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (_) {
            // Try the next candidate.
        }
    }
    return 'ffmpeg';
}

function findFfprobe() {
    const ff = findFfmpeg();
    if (ff === 'ffmpeg') return 'ffprobe';
    const probe = ff.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext || ''}`);
    try {
        if (fs.existsSync(probe)) return probe;
    } catch (_) { /* fall through */ }
    return 'ffprobe';
}

function probeVideoDurationSec(src) {
    try {
        const out = execFileSync(findFfprobe(), [
            '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', src,
        ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const d = parseFloat(out);
        return Number.isFinite(d) && d > 0 ? d : 0;
    } catch (_) {
        return 0;
    }
}

// A valid encoded clip is always well over a few KB. A ~261-byte file is an empty
// MKV/MP4 container ffmpeg writes when a seek lands past the end of the source
// (0 frames). Such a file has NO video stream and makes the HyperFrames renderer
// hard-fail with "[FFmpeg] No video stream found", killing the whole render.
const MIN_VALID_VIDEO_BYTES = 4096;

function fileSizeSafe(p) {
    try { return fs.statSync(p).size; } catch (_) { return 0; }
}

function transcodeVideoForHyperframes(src, outPath, duration, startOffset = 0) {
    const ffmpeg = findFfmpeg();
    // +0.65s tail: a motion transition slides/scales the OUT-going clip for up to
    // ~0.6s AFTER its on-screen window ends. The renderer keeps seeking the video
    // during that slide, so the clip must carry real footage past its window or
    // the exiting frame goes black mid-transition. The extra tail is cheap and the
    // GSAP container opacity still governs when the scene actually disappears.
    const targetDuration = Math.max(0.5, toSeconds(duration, 3) + 0.65);
    let offset = Math.max(0, toSeconds(startOffset, 0));

    // Continuity-fallback scenes reuse a neighbouring clip and stagger the offset
    // (8/12/16/20s) so each looks different — but the reused clip can be far
    // shorter (e.g. 7s) than those offsets. Seeking past the end produces a
    // frameless, ~261-byte file. Clamp the offset into the real clip so the trim
    // always lands on actual frames.
    //
    // Only reachable when offset > 0: at offset 0 the guard needs srcDuration < 0.3s to
    // fire, and targetDuration is always >= 0.5, so `srcDuration - targetDuration` is
    // negative and Math.max(0, ...) hands back the 0 the offset already had. Skipping the
    // probe there avoids one ffprobe process per clip — on Windows that spawn is
    // AV-scan-bound and cost ~12s across the 36 clips in a 4-minute render, for a branch
    // that provably cannot change anything.
    if (offset > 0) {
        const srcDuration = probeVideoDurationSec(src);
        if (srcDuration > 0 && offset + 0.3 >= srcDuration) {
            offset = Math.max(0, srcDuration - targetDuration);
        }
    }

    const buildArgs = (off) => {
        const a = ['-y', '-hide_banner', '-loglevel', 'error'];
        if (off > 0) a.push('-ss', off.toFixed(3));
        a.push(
            '-i', src,
            '-t', targetDuration.toFixed(3),
            '-map', '0:v:0',
            '-an',
            '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '18',
            '-r', '30',
            '-g', '30',
            '-keyint_min', '30',
            '-sc_threshold', '0',
            '-movflags', '+faststart',
            outPath
        );
        return a;
    };

    execFileSync(ffmpeg, buildArgs(offset), { stdio: ['ignore', 'ignore', 'pipe'] });

    // Belt-and-suspenders: if the encode still produced an empty file, re-encode
    // from the very start of the clip. If THAT is still empty, throw so the caller
    // skips the clip entirely rather than emitting a file the renderer can't read.
    if (fileSizeSafe(outPath) < MIN_VALID_VIDEO_BYTES && offset > 0) {
        console.warn(`[HyperFrames] Empty transcode at offset ${offset.toFixed(1)}s for ${path.basename(src)} — retrying from clip start.`);
        execFileSync(ffmpeg, buildArgs(0), { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    if (fileSizeSafe(outPath) < MIN_VALID_VIDEO_BYTES) {
        try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
        throw new Error(`transcode produced no usable video stream for ${path.basename(src)}`);
    }
}

function getLookupDirs(dirs) {
    if (Array.isArray(dirs)) return dirs.filter(Boolean);
    if (dirs && Array.isArray(dirs.lookupDirs)) return dirs.lookupDirs.filter(Boolean);
    return [];
}

function resolveMaybeFile(ref, dirs) {
    if (!ref) return null;
    let clean = String(ref);
    if (/^file:\/\//i.test(clean)) {
        try {
            clean = fileURLToPath(clean);
        } catch (_) {
            clean = clean.replace(/^file:\/+/i, '');
        }
    }
    try {
        clean = decodeURIComponent(clean);
    } catch (_) {
        // Keep raw value.
    }
    if (path.isAbsolute(clean) && fs.existsSync(clean)) return clean;
    for (const dir of getLookupDirs(dirs)) {
        const direct = path.join(dir, clean);
        if (fs.existsSync(direct)) return direct;
        const byBase = path.join(dir, path.basename(clean));
        if (fs.existsSync(byBase)) return byBase;
    }
    return null;
}

function listMediaFiles(dirs) {
    const out = [];
    const seen = new Set();
    for (const dir of getLookupDirs(dirs)) {
        try {
            if (!dir || !fs.existsSync(dir)) continue;
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir, name);
                if (seen.has(full)) continue;
                const stat = fs.statSync(full);
                if (!stat.isFile()) continue;
                const ext = path.extname(name).toLowerCase();
                if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue;
                seen.add(full);
                out.push(full);
            }
        } catch (_) {
            // Ignore unreadable lookup folders.
        }
    }
    return out;
}

function looksLikeLocalMediaRef(value, keyHint = '') {
    if (!value || typeof value !== 'string') return false;
    if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) return false;
    const hint = String(keyHint || '').toLowerCase();
    const hasMediaKey = /(file|path|asset|media|image|video|background|template|src|url)/i.test(hint);
    const clean = value.split(/[?#]/)[0];
    const hasMediaExt = /\.(mp4|mov|m4v|webm|png|jpe?g|webp|gif|svg)$/i.test(clean);
    const hasPathShape = /^[a-z]:[\\/]/i.test(clean) || /^file:\/\//i.test(clean) || clean.includes('\\') || clean.includes('/');
    return hasMediaExt || (hasMediaKey && hasPathShape);
}

function collectFileRefsFromObject(value, refs = [], depth = 0, keyHint = '') {
    if (!value || depth > 5) return refs;
    if (typeof value === 'string') {
        if (looksLikeLocalMediaRef(value, keyHint)) refs.push(value);
        return refs;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectFileRefsFromObject(item, refs, depth + 1, keyHint);
        return refs;
    }
    if (typeof value !== 'object') return refs;
    for (const [key, item] of Object.entries(value)) {
        const nextHint = keyHint ? `${keyHint}.${key}` : key;
        collectFileRefsFromObject(item, refs, depth + 1, nextHint);
    }
    return refs;
}

function uniqueRefs(refs) {
    const seen = new Set();
    const out = [];
    for (const ref of refs.filter(Boolean)) {
        const key = String(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
    }
    return out;
}

/*
 * HARDLINK INSTEAD OF COPY
 *
 * Every build — preview or render — writes into a BRAND NEW project dir. That unique
 * name is deliberate (it is what stops the preview iframe serving a stale document),
 * but it meant re-copying the entire media set each time. Measured on a real project:
 * ~252 MB per preview dir, and the preview is rebuilt on a 700 ms debounce with
 * force:true on every timeline edit — so an active editing session was writing a
 * quarter of a gigabyte roughly once per second of settled activity, plus retaining
 * it (three preview dirs = 777 MB, 69 of 70 files identical across them).
 *
 * A hardlink is a second directory entry pointing at bytes that are already on disk:
 * nothing is read, nothing is written, and the media dir still looks like a plain
 * folder of files to ffmpeg, the headless browser and the preview server alike.
 *
 * IT MUST BE A HARDLINK, NOT A SYMLINK. `hf-preview://` resolves requests through
 * fs.realpathSync.native and allowlists only <PROJECT_DIR>/hyperframes. A symlink
 * resolves to the ORIGINAL in public/, lands outside the allowlist, and every media
 * request 403s. A hardlink's realpath is itself, so it passes. (Symlinks are a
 * non-starter anyway: fs.symlinkSync throws EPERM on Windows without elevation.)
 *
 * TWO HAZARDS, BOTH HANDLED HERE:
 *  1. Writing THROUGH a link hits the original. Verified on the real volume: writing
 *     10 bytes to the link truncated the 1024-byte original to 10 bytes. So nothing
 *     may ever overwrite a linked path in place — callers unlink first (see the
 *     transcode branch below), and anything replacing a file in public/ must
 *     write-then-rename rather than copy over it.
 *  2. Links cannot cross volumes. Fonts and SFX come from the app install (D:) while
 *     a project commonly lives on C: — verified to throw EXDEV. Hence the fallback,
 *     which is simply the old behaviour.
 *
 * Deleting a link never touches the original, so the existing project prune is safe
 * as-is (also verified).
 */
let _linkFallbackLogged = false;
function linkOrCopy(src, outPath) {
    try {
        fs.linkSync(src, outPath);
        return 'link';
    } catch (err) {
        // EEXIST means another pass won the race — whatever is there is already correct.
        if (err.code === 'EEXIST') return 'exists';
        // EXDEV (cross-volume), EPERM/EACCES (policy), ENOSYS/ENOTSUP/EOPNOTSUPP
        // (FAT32/exFAT/network share), EMLINK (link count exhausted). None of these are
        // worth failing a build over when a copy does the same job, so fall back on any
        // error and just say so once per build.
        // Per-file, not global: EXDEV normally means just the fonts/SFX that live on the
        // app install drive while the project is on another. Scene media on the project's
        // own volume still links. Say it once so a genuinely link-less filesystem is
        // visible in the log without spamming a line per asset.
        if (!_linkFallbackLogged) {
            _linkFallbackLogged = true;
            console.log(`[HyperFrames] Copying (not linking) some media — first reason: ${err.code || err.message}`);
        }
        fs.copyFileSync(src, outPath);
        return 'copy';
    }
}

/**
 * Hardlink an already-normalized clip in from a retained sibling project dir instead of
 * re-transcoding it.
 *
 * The `.normmeta` disk cache below has always been unreachable in practice:
 * generateHyperframesProject mints a brand-new `yta-hf-<stamp>` dir per build, so
 * `fs.existsSync(outPath)` is tested against an empty directory and can never hit. Every
 * build therefore re-encoded clips that were byte-identical to ones sitting on disk from
 * minutes earlier — measured at ~73s for a Motion QA second pass and ~24s for the MG clips
 * the preview had already normalized. This makes the EXISTING key reachable across the
 * sibling dirs the keep-N prune already retains; the key string itself is untouched.
 *
 * Staleness is bounded two ways. The search only sees dirs the prune kept (minutes old),
 * and — because the key identifies the source by PATH, not by content, while scene Retry
 * overwrites `public/scene-N-asset.*` in place — a candidate is rejected unless it is
 * strictly newer than the source it claims to encode. That makes a post-Retry render fall
 * through to a real transcode instead of silently shipping the pre-Retry footage.
 */
function _seedNormalizedFromSibling(src, mediaDir, outName, outPath, key) {
    try {
        const projectDir = path.dirname(mediaDir);
        const siblings = _listHfProjects(_hfProjectRoots(path.dirname(projectDir)), path.basename(projectDir));
        if (!siblings.length) return false;
        const srcMtime = fs.statSync(src).mtimeMs;
        // Newest first; cap the scan so a large retained pool cannot cost more than it saves.
        for (const sib of siblings.slice(0, 6)) {
            const cand = path.join(sib.dir, 'media', outName);
            let st;
            try {
                if (fs.readFileSync(`${cand}.normmeta`, 'utf8') !== key) continue;
                st = fs.statSync(cand);
            } catch (_) { continue; }
            if (st.size < MIN_VALID_VIDEO_BYTES) continue;
            if (srcMtime > st.mtimeMs) continue;
            // Break any link already here before writing, for the same reason the transcode
            // path does: writing through a shared inode would truncate the original.
            try { fs.unlinkSync(outPath); } catch (_) {}
            linkOrCopy(cand, outPath);
            // A hardlink bypasses the transcode path's validity guard, so re-apply it here.
            if (fileSizeSafe(outPath) < MIN_VALID_VIDEO_BYTES) {
                try { fs.unlinkSync(outPath); } catch (_) {}
                continue;
            }
            try { fs.writeFileSync(`${outPath}.normmeta`, key); } catch (_) {}
            return true;
        }
    } catch (_) { /* seeding is an optimization — never fail a render over housekeeping */ }
    return false;
}

function copyAsset(src, mediaDir, name, assetCache, options = {}) {
    if (!src || !fs.existsSync(src)) return null;
    ensureDir(mediaDir);
    const ext = path.extname(src).toLowerCase();
    const normalizeVideo = options.normalizeVideo && VIDEO_EXTS.has(ext);
    const outExt = normalizeVideo ? '.mp4' : (ext || '.bin');
    const outName = `${cleanName(name)}${outExt}`;
    const outPath = path.join(mediaDir, outName);
    const key = normalizeVideo
        ? `${path.resolve(src)}|video|${toSeconds(options.duration, 3).toFixed(3)}|${toSeconds(options.startOffset, 0).toFixed(3)}`
        : `${path.resolve(src)}|copy`;
    if (assetCache?.has(key)) return assetCache.get(key);
    try {
        if (normalizeVideo) {
            // Disk cache: a previous open/refresh already normalized this exact source with
            // the same duration/offset (the `key`). Reuse it instead of re-transcoding every
            // time. A sidecar `.normmeta` stores the key so we still re-normalize when the
            // duration/offset actually changes (e.g. after the user trims the clip).
            const metaPath = outPath + '.normmeta';
            let reuse = false;
            try {
                reuse = fs.existsSync(outPath)
                    && fs.statSync(outPath).size > 0
                    && fs.existsSync(metaPath)
                    && fs.readFileSync(metaPath, 'utf8') === key;
            } catch (_) { reuse = false; }
            if (reuse) {
                console.log(`[HyperFrames] Reusing normalized video ${outName} (cached)`);
            } else if (_seedNormalizedFromSibling(src, mediaDir, outName, outPath, key)) {
                console.log(`[HyperFrames] Reusing normalized video ${outName} (from previous build)`);
            } else {
                console.log(`[HyperFrames] Normalizing video ${path.basename(src)} -> ${outName} (${toSeconds(options.duration, 3).toFixed(1)}s, offset ${toSeconds(options.startOffset, 0).toFixed(1)}s)`);
                // Break any existing link BEFORE ffmpeg opens this path for writing. If a
                // previous pass hardlinked the source here, `-y` would truncate the shared
                // inode and destroy the original in public/ (verified: writing through a
                // link truncates the original). Unlinking drops only this directory entry.
                try { fs.unlinkSync(outPath); } catch (_) {}
                transcodeVideoForHyperframes(src, outPath, options.duration, options.startOffset);
                try { fs.writeFileSync(metaPath, key); } catch (_) {}
            }
        } else if (!fs.existsSync(outPath)) {
            linkOrCopy(src, outPath);
        }
        const rel = `media/${outName}`;
        assetCache?.set(key, rel);
        return rel;
    } catch (err) {
        console.warn(`[HyperFrames] Failed to prepare media ${src}: ${err.message}`);
        return null;
    }
}

function displayValue(...values) {
    for (const value of values) {
        if (typeof value === 'string' || typeof value === 'number') {
            const text = String(value).trim();
            if (text && !/^(?:true|false|null|undefined)$/i.test(text)) return text;
        }
    }
    return '';
}

function firstBoolean(...values) {
    for (const value of values) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            if (/^(?:true|on|yes|show|visible)$/i.test(value.trim())) return true;
            if (/^(?:false|off|no|hide|hidden|none)$/i.test(value.trim())) return false;
        }
    }
    return undefined;
}

function stringValue(value) {
    return displayValue(value);
}

function templateTypeFromHint(value) {
    const text = stringValue(value);
    return text ? text.split(':')[0].trim() : '';
}

function normalizeType(value, fallback = 'graphic') {
    const raw = stringValue(value);
    if (!raw) return fallback;
    const simple = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .toLowerCase();
    const aliases = {
        lowerthird: 'lower-third',
        'lower-third': 'lower-third',
        headline: 'headline',
        callout: 'callout',
        statcounter: 'stat-counter',
        'stat-counter': 'stat-counter',
        focusword: 'focus-word',
        'focus-word': 'focus-word',
        progressbar: 'progress-bar',
        'progress-bar': 'progress-bar',
        barchart: 'bar-chart',
        'bar-chart': 'bar-chart',
        donutchart: 'donut-chart',
        'donut-chart': 'donut-chart',
        rankinglist: 'ranking-list',
        'ranking-list': 'ranking-list',
        timeline: 'timeline',
        comparisoncard: 'comparison-card',
        'comparison-card': 'comparison-card',
        bulletlist: 'bullet-list',
        'bullet-list': 'bullet-list',
        mapchart: 'map-chart',
        map: 'map-chart',
        'map-chart': 'map-chart',
        explainer: 'explainer',
        kinetictext: 'kinetic-text',
        'kinetic-text': 'kinetic-text',
        typewriter: 'typewriter',
        subscribecta: 'subscribe-cta',
        'subscribe-cta': 'subscribe-cta',
        listiclecounter: 'listicle-counter',
        'listicle-counter': 'listicle-counter',
        progresstracker: 'progress-tracker',
        'progress-tracker': 'progress-tracker',
        listiclegrid: 'listicle-grid',
        'listicle-grid': 'listicle-grid',
        chaptercard: 'chapter-card',
        'chapter-card': 'chapter-card',
        titlecard: 'title-card',
        'title-card': 'title-card',
        locationcard: 'location-card',
        'location-card': 'location-card',
        quotecard: 'quote-card',
        'quote-card': 'quote-card',
        keytakeaway: 'key-takeaway',
        'key-takeaway': 'key-takeaway',
        timelinecard: 'timeline-card',
        'timeline-card': 'timeline-card',
        factcard: 'fact-card',
        'fact-card': 'fact-card',
        imageshowcase: 'image-showcase',
        'image-showcase': 'image-showcase',
        statcard: 'stat-card',
        'stat-card': 'stat-card',
        personintro: 'person-intro',
        'person-intro': 'person-intro',
        splitscreen: 'split-screen',
        'split-screen': 'split-screen',
        infographic: 'infographic',
        fullscreenmg: 'headline',
        'full-screen-mg': 'headline',
        template: 'chapter-card',
        graphic: fallback || 'graphic',
    };
    return aliases[simple] || aliases[simple.replace(/-/g, '')] || simple || fallback;
}

function visualTypeCandidate(value, kind = 'graphic') {
    const text = stringValue(value);
    if (!text) return '';
    const normalized = normalizeType(text, '');
    if (!normalized || /^(?:true|false|null|undefined)$/i.test(normalized)) return '';
    if (kind === 'template' && normalized === 'template') return 'chapter-card';
    return normalized;
}

function resolveVisualType(mg, kind = 'graphic') {
    const candidates = kind === 'template'
        ? [mg?.type, mg?.mgType, mg?.templateKind, mg?.templateName, typeof mg?.templateType === 'string' ? mg.templateType : '', templateTypeFromHint(mg?.templateHint), templateTypeFromHint(mg?.keyword)]
        : [mg?.type, mg?.mgType, mg?.templateType, mg?.templateKind, templateTypeFromHint(mg?.templateHint), mg?._hfKind];
    for (const candidate of candidates) {
        const value = visualTypeCandidate(candidate, kind || 'graphic');
        if (value) return value;
    }
    return normalizeType(kind || 'graphic');
}

function camelRegistryKey(type) {
    const normalized = normalizeType(type, '');
    if (!normalized) return '';
    return normalized.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function templateRegistryKey(type) {
    const key = camelRegistryKey(type);
    return key === 'titleCard' ? 'chapterCard' : key;
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeMotionSpeed(value, fallback = 1) {
    if (value == null || value === '') return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.max(0.25, Math.min(3, numeric));
    const raw = classToken(value, 'normal');
    if (raw.includes('very-slow')) return 0.55;
    if (raw.includes('slow') || raw.includes('calm') || raw.includes('gentle')) return 0.75;
    if (raw.includes('rapid') || raw.includes('snappy')) return 1.6;
    if (raw.includes('fast') || raw.includes('quick') || raw.includes('energetic')) return 1.35;
    if (raw.includes('normal') || raw.includes('standard') || raw.includes('medium')) return 1;
    return fallback;
}

function themeOverrideFor(type, themeId, tokens) {
    const key = camelRegistryKey(type);
    return tokens?.chrome?.mgOverrides?.[key]
        || MG_THEME_OVERRIDES?.[themeId]?.[key]
        || null;
}

function templateOverrideFor(type, themeId, tokens) {
    const key = templateRegistryKey(type);
    return tokens?.templates?.overrides?.[key]
        || TEMPLATE_THEME_OVERRIDES?.[themeId]?.[key]
        || null;
}

function firstExistingVariant(type, explicitVariant, themeOverride, stylePreset) {
    const regKey = camelRegistryKey(type);
    const reg = MG_REGISTRY?.[regKey];
    if (!reg?.types) return explicitVariant || 'standard';

    if (explicitVariant && reg.types[explicitVariant]) return explicitVariant;
    if (themeOverride?.style && reg.types[themeOverride.style]) return themeOverride.style;

    if (regKey === 'lowerThird' && stylePreset?.lowerThirdStyle && reg.types[stylePreset.lowerThirdStyle]) {
        return stylePreset.lowerThirdStyle;
    }

    if (resolveRegistrySubType) {
        try {
            const resolved = resolveRegistrySubType({ type: regKey, subType: explicitVariant }, themeOverride, stylePreset);
            if (resolved && reg.types[resolved]) return resolved;
        } catch (_) {
            // Fall through to the registry rotation below.
        }
    }

    const avoid = new Set(Array.isArray(themeOverride?.variantAvoid) ? themeOverride.variantAvoid : []);
    const allowed = Object.keys(reg.types).filter(key => !avoid.has(key));
    return allowed[0] || reg.defaultType || Object.keys(reg.types)[0] || 'standard';
}

function templateDefault(type) {
    const key = templateRegistryKey(type);
    const defaults = {
        chapterCard: { variant: 'standard', animation: 'fadeSlide' },
        titleCard: { variant: 'standard', animation: 'fadeSlide' },
        locationCard: { variant: 'standard', animation: 'slideLeft' },
        quoteCard: { variant: 'standard', animation: 'popUp' },
        keyTakeaway: { variant: 'standard', animation: 'springScale' },
        comparisonCard: { variant: 'standard', animation: 'staggerSlide' },
        timelineCard: { variant: 'standard', animation: 'cascade' },
        factCard: { variant: 'splitPanel', animation: 'slideRight' },
        imageShowcase: { variant: 'standard', animation: 'slideOpposite' },
        statCard: { variant: 'sideBySide', animation: 'countUp' },
        personIntro: { variant: 'standard', animation: 'slideRight' },
        splitScreen: { variant: 'standard', animation: 'slideOpposite' },
        infographic: { variant: 'standard', animation: 'staggerSlide' },
    };
    return defaults[key] || { variant: 'standard', animation: 'fadeSlide' };
}

function normalizeCssColor(value, fallback) {
    const text = displayValue(value);
    return text || fallback;
}

function resolveHyperframeVisual(mg, kind, type, plan = {}) {
    const themeId = cleanName(displayValue(
        mg?.themeId,
        mg?.mgData?.themeId,
        plan?.themeId,
        plan?.scriptContext?.themeId,
        plan?.theme,
        'standard'
    ), 'standard');
    const tokens = getThemeTokens(themeId) || {};
    const themeOverride = themeOverrideFor(type, themeId, tokens);
    const templateOverride = kind === 'template' ? templateOverrideFor(type, themeId, tokens) : null;
    const requestedStyle = displayValue(
        mg?.styleName,
        mg?.style,
        mg?.mgStyle,
        mg?.visualStyle,
        mg?.themeStyle,
        mg?.templateStyle,
        mg?.mgData?.styleName,
        mg?.mgData?.style,
        mg?.mgData?.visualStyle,
    );
    const requestedStyleName = cleanName(requestedStyle, '');
    const themeStyleName = cleanName(displayValue(
        themeOverride?.styleName,
        tokens?.mgStyle,
        plan?.mgStyle,
        'clean'
    ), 'clean');
    const styleManual = mg?.styleManual === true || mg?.mgData?.styleManual === true;
    const styleName = cleanName(
        styleManual
            ? displayValue(requestedStyle, themeStyleName, 'clean')
            : (
                !requestedStyleName || (
                    requestedStyleName === 'clean'
                    && themeStyleName !== 'clean'
                )
                    ? themeStyleName
                    : requestedStyleName
            ),
        'clean'
    );
    const stylePreset = getMGStylePreset(styleName) || {};
    const explicitVariant = displayValue(
        mg?.subType,
        mg?.variant,
        mg?.variantName,
        mg?.templateVariant,
        mg?.templateSubType,
        mg?.mgData?.subType,
        mg?.mgData?.variant,
        mg?.mgData?.variantName,
    );
    const fallbackTemplate = templateDefault(type);
    const variant = cleanName(kind === 'template'
        ? displayValue(explicitVariant, templateOverride?.variant, fallbackTemplate.variant)
        : firstExistingVariant(type, explicitVariant, themeOverride, stylePreset), 'standard');
    const explicitAnimation = displayValue(
        mg?.animation,
        mg?.animationName,
        mg?.animationType,
        mg?.templateAnimation,
        mg?.templateAnimationType,
        mg?.mgData?.animation,
        mg?.mgData?.animationName,
        mg?.mgData?.animationType,
    );
    let animation = '';
    if (kind === 'template') {
        animation = displayValue(explicitAnimation, templateOverride?.animation, fallbackTemplate.animation);
    } else {
        const regKey = camelRegistryKey(type);
        const reg = MG_REGISTRY?.[regKey];
        if (explicitAnimation) {
            animation = explicitAnimation;
        } else if (resolveRegistryAnimation) {
            try {
                animation = resolveRegistryAnimation({ type: regKey }, variant, themeOverride);
            } catch (_) {
                animation = '';
            }
        }
        animation = displayValue(
            animation,
            themeOverride?.animation,
            themeOverride?.anim,
            reg?.types?.[variant]?.animation,
            regKey === 'lowerThird' ? stylePreset?.lowerThirdAnimation : '',
            reg?.animations?.[0],
            'fadeSlide'
        );
    }

    /*
     * Where did that entrance come from?
     *
     * Reported, never used above — this asks the same questions in the same
     * order and cannot change the answer. Step 7.8 Motion QA needs it because
     * varying an entrance nobody chose is a repair, while overruling one a
     * theme or the plan deliberately stated is vandalism, and from the outside
     * those two look identical: both arrive here as a plain string.
     *
     *   'explicit' — the item said so (planner, agent, or a human edit)
     *   'theme'    — the theme's own per-type table said so, which is an
     *                editorial voice and is left alone
     *   'default'  — nothing chose it; it fell through to a fallback table.
     *                This is the only case anything downstream may rewrite.
     */
    const animationSource = explicitAnimation
        ? 'explicit'
        : (kind === 'template'
            ? (templateOverride?.animation ? 'theme' : 'default')
            : ((themeOverride?.anim || themeOverride?.animation) ? 'theme' : 'default'));

    const colors = tokens?.colors || {};
    const explicitColors = (
        mg?.colors && typeof mg.colors === 'object'
            ? mg.colors
            : (mg?.mgData?.colors && typeof mg.mgData.colors === 'object'
                ? mg.mgData.colors
                : {})
    );
    const overrideColors = themeOverride?.colors || {};
    const typography = tokens?.typography || {};
    const speed = clampNumber(firstFiniteNumber(
        mg?.animationSpeed,
        mg?._animationSpeed,
        mg?.mgData?.animationSpeed,
        plan?.scriptContext?.mgAnimationSpeed,
        plan?.mgAnimationSpeed
    ), 0.25, 3, 1);
    // Same provenance question as animationSource, for the same reason. A
    // plan-wide speed is a deliberate global choice and outranks a repair.
    const speedSource = Number.isFinite(firstFiniteNumber(
        mg?.animationSpeed, mg?._animationSpeed, mg?.mgData?.animationSpeed
    ))
        ? 'explicit'
        : (Number.isFinite(firstFiniteNumber(
            plan?.scriptContext?.mgAnimationSpeed, plan?.mgAnimationSpeed
        )) ? 'plan' : 'default');
    const shadowStrength = clampNumber(firstFiniteNumber(
        mg?.overlayShadowStrength,
        mg?.mgData?.overlayShadowStrength,
        plan?.scriptContext?.mgOverlayShadow,
        plan?.mgOverlayShadow
    ), 0, 1, 0.55);
    const accentRuleVisible = firstBoolean(
        mg?.accentRuleVisible,
        mg?.mgData?.accentRuleVisible,
        mg?.agenticComposition?.style?.accentRule,
        mg?.mgData?.agenticComposition?.style?.accentRule
    ) !== false;
    const resolvedSurface = normalizeCssColor(
        explicitColors.surface || explicitColors.background,
        overrideColors.bgFill
            || overrideColors.cardFill
            || stylePreset?.bg
            // Neutral, not Tailwind slate-950 — see the palette note below.
            || colors.surface
            || 'rgba(14,14,16,0.78)'
    );
    /*
     * The last-resort values below are LOW-CHROMA NEUTRALS, matching the policy
     * already documented on the stage root (#yta-hyperframes): a fallback that
     * looks designed is a fallback that hides a bug.
     *
     * This chain used to end in cyan #22d3ee + violet #8b5cf6 over Tailwind slate
     * (#f8fafc / rgba(226,232,240) / rgba(2,6,23)) — the exact textbook
     * generated-design palette that the root fallback was cleaned of. The root
     * was fixed; this copy one layer down was not, so any graphic whose theme
     * failed to resolve a colour still landed on it, and it landed there looking
     * deliberate enough that nobody questioned it.
     */
    const palette = harmonizeVisualPalette({
        surface: resolvedSurface,
        background: normalizeCssColor(explicitColors.background, colors.background || '#050505'),
        text: normalizeCssColor(explicitColors.text, overrideColors.textFill || colors.textPrimary || '#f2efe9'),
        textMuted: normalizeCssColor(explicitColors.textMuted, colors.textSecondary || 'rgba(238,235,228,0.88)'),
        primary: normalizeCssColor(
            explicitColors.primary,
            overrideColors.primaryFill || overrideColors.accentFill || colors.mgPrimary || colors.primary || '#b9c2cc'
        ),
        accent: normalizeCssColor(
            explicitColors.accent,
            overrideColors.accentFill || colors.mgAccent || colors.accent || '#d8c6a3'
        ),
        textLocked: mg?.textColorManual === true || mg?.mgData?.textColorManual === true,
    });

    return {
        themeId,
        type,
        kind,
        styleName,
        variant,
        animation: cleanName(animation, 'fadeSlide'),
        animationSource,
        speed,
        speedSource,
        shadowStrength,
        accentRuleVisible,
        cardStyle: cleanName(displayValue(
            mg?.transparentBackground ? 'transparent' : '',
            mg?.cardStyle,
            mg?.mgData?.cardStyle,
            stylePreset?.cardStyle,
            'filled'
        ), 'filled'),
        chrome: {
            bg: resolvedSurface,
            radius: clampNumber(stylePreset?.borderRadius, 0, 40, 12),
            strokeWidth: clampNumber(stylePreset?.strokeWidth, 0, 8, 2),
            shadowBlur: clampNumber(stylePreset?.shadowBlur, 0, 60, 18),
            shadowOffsetY: clampNumber(stylePreset?.shadowOffsetY, 0, 24, 4),
            glow: !!stylePreset?.glow,
        },
        colors: {
            primary: palette.primary,
            accent: palette.accent,
            text: palette.text,
            textMuted: palette.textMuted,
            surface: resolvedSurface,
            shadow: normalizeCssColor(colors.shadow, 'rgba(0,0,0,0.46)'),
            background: normalizeCssColor(explicitColors.background, colors.background || '#050505'),
        },
        contrastTone: palette.tone,
        paletteRatios: palette.ratios,
        fonts: {
            // Last-resort fallbacks only — all 8 themes declare their own faces.
            // Deliberately the system stack rather than Inter: a theme that fails
            // to declare a face should look unstyled, not look like every other
            // generated design. See the overused-font rule in hf-slop-lint.js.
            heading: displayValue(typography.headingFont, 'system-ui, sans-serif'),
            body: displayValue(typography.bodyFont, 'system-ui, sans-serif'),
            caption: displayValue(typography.captionFont, typography.bodyFont, 'system-ui, sans-serif'),
        },
    };
}

function hyperframeStyleVars(visual) {
    const v = visual || resolveHyperframeVisual({}, 'graphic', 'headline', {});
    const blur = Math.round((v.chrome.shadowBlur || 18) * (0.35 + v.shadowStrength));
    const alpha = Math.max(0, Math.min(0.78, 0.18 + v.shadowStrength * 0.5));
    const vars = {
        '--hf-primary': v.colors.primary,
        '--hf-accent': v.colors.accent,
        '--hf-text': v.colors.text,
        '--hf-muted': v.colors.textMuted,
        '--hf-surface': v.colors.surface,
        '--hf-bg': v.chrome.bg,
        '--hf-shadow-color': v.colors.shadow,
        '--hf-shadow': `0 ${v.chrome.shadowOffsetY || 4}px ${blur}px rgba(0,0,0,${alpha.toFixed(2)})`,
        '--hf-radius': `${v.chrome.radius}px`,
        '--hf-stroke': `${v.chrome.strokeWidth}px`,
        '--hf-heading-font': v.fonts.heading,
        '--hf-body-font': v.fonts.body,
        '--hf-caption-font': v.fonts.caption,
        '--hf-speed': String(v.speed),
    };
    return Object.entries(vars)
        .map(([key, value]) => `${key}: ${String(value).replace(/;/g, '')}`)
        .join('; ');
}

function hasExplicitGraphicTextColor(mg = {}) {
    return Boolean(
        mg?.textColorManual === true
        || mg?.mgData?.textColorManual === true
    );
}

function contrastToneForGraphic({
    mg,
    kind,
    asset,
    transparentTemplateBg,
    visual,
} = {}) {
    const requested = displayValue(
        mg?.contrastTone,
        mg?.readability?.contrastTone,
        mg?.mgData?.contrastTone,
        mg?.mgData?.readability?.contrastTone,
        ''
    ).toLowerCase();
    if (requested === 'light' || requested === 'dark') return requested;
    const transparent = Boolean(
        transparentTemplateBg
        || mg?.transparentBackground === true
        || mg?.mgData?.transparentBackground === true
        || visual?.cardStyle === 'transparent'
    );
    const shellSurface = String(
        mg?._hfResolvedGraphicShell?.surface
        || mg?.graphicShell?.surface
        || mg?.mgData?.graphicShell?.surface
        || ''
    ).toLowerCase();
    const mediaTreatment = String(
        mg?.agenticComposition?.media?.treatment
        || mg?.mgData?.agenticComposition?.media?.treatment
        || ''
    ).toLowerCase();
    if (transparent || asset) return 'light';
    if (
        kind === 'overlay'
        && (
            ['none', 'transparent', 'outline'].includes(shellSurface)
            || ['image-focus', 'cinematic-background', 'darken-footage'].includes(mediaTreatment)
            || visual?.cardStyle === 'outline'
        )
    ) return 'light';
    return visual?.contrastTone === 'dark' ? 'dark' : 'light';
}

function adaptiveContrastEnabled(mg = {}, kind = 'graphic') {
    if (/^(0|false|off|no)$/i.test(String(process.env.HF_ADAPTIVE_CONTRAST || '').trim())) return false;
    if (!kind) return false;
    if (mg?.adaptiveContrast === false || mg?.mgData?.adaptiveContrast === false) return false;
    if (mg?.readability?.adaptiveContrast === false || mg?.mgData?.readability?.adaptiveContrast === false) return false;
    return true;
}

function contrastProtectionMode(mg = {}) {
    const raw = displayValue(
        mg?.contrastProtection,
        mg?.readability?.contrastProtection,
        mg?.mgData?.contrastProtection,
        mg?.mgData?.readability?.contrastProtection,
        ''
    ).toLowerCase();
    return raw === 'strong' ? 'strong' : '';
}

function resolveSceneMedia(scene, dirs) {
    const refs = uniqueRefs([
        scene?.mediaFile,
        scene?.mediaPath,
        scene?.file,
        scene?.path,
        scene?.assetFile,
        scene?.assetPath,
        scene?.templateMediaFile,
        scene?.templateBgFile,
        scene?.backgroundMediaFile,
        scene?.backgroundImageFile,
        scene?.imageFile,
        scene?.videoFile,
        scene?.renderedMedia,
        scene?.finalAsset,
        scene?.asset?.file,
        scene?.asset?.path,
        ...collectFileRefsFromObject(scene?.renderAssets),
        ...collectFileRefsFromObject(scene?.template),
        ...collectFileRefsFromObject(scene?.background),
        ...collectFileRefsFromObject(scene?.media),
        ...collectFileRefsFromObject(scene?.asset),
    ]);
    for (const ref of refs) {
        const found = resolveMaybeFile(ref, dirs);
        if (found) return found;
    }
    return null;
}

function parseTrackIndex(trackId, fallback = 0) {
    const n = Number(String(trackId || '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? Math.max(0, n - 1) : fallback;
}

function getSceneVideoOffset(scene) {
    const offset = firstFiniteNumber(
        scene?.mediaOffset,
        scene?.templateMediaOffset,
        scene?.clipOffset,
        scene?.sourceOffset,
        scene?.sourceStart,
        scene?.trimStart,
        scene?.mediaStart,
        scene?.videoStart,
        scene?.startOffset
    );
    return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function getMgText(mg) {
    return displayValue(
        mg?.agenticComposition?.title,
        mg?.agenticComposition?.text,
        mg?.mgData?.agenticComposition?.title,
        mg?.mgData?.agenticComposition?.text,
        mg?.text,
        mg?.title,
        mg?.headline,
        mg?.label,
        mg?.keyword,
        mg?.templateText,
        mg?.templateTitle,
        mg?.mgData?.text,
        mg?.mgData?.title
    );
}

function getMgSubtext(mg) {
    return displayValue(
        mg?.agenticComposition?.subtitle,
        mg?.agenticComposition?.subtext,
        mg?.mgData?.agenticComposition?.subtitle,
        mg?.mgData?.agenticComposition?.subtext,
        mg?.subtext,
        mg?.subText,
        mg?.subtitle,
        mg?.caption,
        mg?.description,
        mg?.templateSubtext,
        mg?.templateSubtitle,
        mg?.visualIntent,
        mg?.mgData?.subtext,
        mg?.mgData?.subtitle
    );
}

function conciseVisualText(value, { maxChars = 110, maxWords = 18 } = {}) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const words = clean.split(/\s+/).filter(Boolean);
    if (clean.length <= maxChars && words.length <= maxWords) return clean;
    const limitedWords = words.slice(0, maxWords).join(' ');
    const clipped = limitedWords.length > maxChars
        ? limitedWords.slice(0, maxChars).replace(/\s+\S*$/, '').trim()
        : limitedWords;
    return clipped ? `${clipped.replace(/[,:;\-–—]+$/, '')}…` : '';
}

function safeLayoutRequested(mg) {
    return Boolean(
        mg?.motionQaSafeLayout === true
        || mg?._motionQaSafeLayout === true
        || mg?.mgData?.motionQaSafeLayout === true
        || mg?.mgData?._motionQaSafeLayout === true
    );
}

function comparisonContent(mg, text, subtext, items = []) {
    const parts = String(text || '')
        .split(/\s+(?:vs\.?|versus)\s+/i)
        .map((part) => conciseVisualText(part, { maxChars: 58, maxWords: 8 }))
        .filter(Boolean);
    const itemLabels = (items || [])
        .slice(0, 2)
        .map((item) => conciseVisualText(item?.label || item?.value, { maxChars: 58, maxWords: 8 }))
        .filter(Boolean);
    const sides = parts.length >= 2 ? [parts[0], parts.slice(1).join(' vs ')] : itemLabels;
    const note = conciseVisualText(subtext, { maxChars: 96, maxWords: 14 });
    return {
        left: sides[0] || 'Option A',
        right: sides[1] || 'Option B',
        note,
    };
}

function normalizeItem(item, index) {
    if (item == null) return null;
    if (typeof item === 'string' || typeof item === 'number') {
        const label = String(item).trim();
        return label ? { label, value: String(index + 1) } : null;
    }
    const label = displayValue(item.label, item.title, item.name, item.text, item.caption, item.keyword);
    const value = displayValue(item.value, item.number, item.stat, item.rank, item.year, item.prefix);
    const subtext = displayValue(item.subtext, item.subtitle, item.description, item.note);
    if (!label && !value && !subtext) return null;
    return { label: label || subtext || `Item ${index + 1}`, value: value || String(index + 1), subtext };
}

function parseItemsFromText(value) {
    const text = String(value || '').trim();
    if (!text) return [];
    return text
        .split(/\s*;\s*|\n+|\s+\|\s+/)
        .map(part => part.trim())
        .filter(Boolean)
        .map((part, index) => {
            const kv = part.match(/^([^:=-]{1,52})\s*[:=-]\s*(.+)$/);
            if (!kv) return { label: part, value: String(index + 1) };
            const left = kv[1].trim();
            const right = kv[2].trim();
            const leftLooksValue = /^(?:#?\d+(?:[,.]\d+)?(?:%|x|m|bn|b)?|\d{4}|Q[1-4])$/i.test(left);
            return leftLooksValue ? { label: right, value: left } : { label: left, value: right || String(index + 1) };
        });
}

function itemsFromMg(mg, text, subtext) {
    const sources = [
        mg?.items,
        mg?._items,
        mg?.templateItems,
        mg?._listicleItems,
        mg?.mgData?.items,
        mg?.mgData?._items,
        // The Motion Director writes structured list/data entries here — wire them
        // to the dedicated renderers (bullet-list/ranking/timeline/comparison) so a
        // data MG isn't rendered with just its title as a single fake item.
        mg?.agenticComposition?.items,
        mg?.mgData?.agenticComposition?.items,
    ];
    for (const source of sources) {
        if (!source) continue;
        const arr = Array.isArray(source) ? source : parseItemsFromText(source);
        const normalized = arr.map(normalizeItem).filter(Boolean);
        if (normalized.length) return normalized.slice(0, 8);
    }
    const parsedSubtext = parseItemsFromText(subtext);
    if (parsedSubtext.length >= 2) return parsedSubtext.slice(0, 8);
    const parsedText = parseItemsFromText(text);
    if (parsedText.length >= 3) return parsedText.slice(0, 8);
    return [];
}

function renderItemList(items, className = 'hf-items') {
    return `<div class="${className}">${items.map((item, i) => `
        <div class="hf-item" style="--i:${i}">
          <span class="hf-item-value">${html(item.value || String(i + 1))}</span>
          <span class="hf-item-label">${html(item.label || '')}</span>
          ${item.subtext ? `<span class="hf-item-subtext">${html(item.subtext)}</span>` : ''}
        </div>`).join('')}</div>`;
}

function normalizeDisplaySemantics(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/([$€£¥])\s+/g, '$1')
        .replace(/[^a-z0-9$€£¥%]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function displayNumbers(value) {
    return (String(value || '').match(/[-+]?\d[\d,]*(?:\.\d+)?(?:\s*%)?/g) || [])
        .map(raw => {
            const percent = /%/.test(raw);
            const number = Number(raw.replace(/[%\s,]/g, ''));
            return Number.isFinite(number) ? `${number}${percent ? '%' : ''}` : null;
        })
        .filter(Boolean);
}

function semanticallyRepeatsDisplay(a, b) {
    const left = normalizeDisplaySemantics(a);
    const right = normalizeDisplaySemantics(b);
    if (!left || !right) return false;
    if (left === right) return true;

    const leftNumbers = new Set(displayNumbers(left));
    const rightNumbers = new Set(displayNumbers(right));
    const sharesNumber = [...leftNumbers].some(value => rightNumbers.has(value));
    if (!sharesNumber) return false;

    const words = value => new Set(
        value.split(' ').filter(word => word.length > 1 && !/^\d/.test(word))
    );
    const leftWords = words(left);
    const rightWords = words(right);
    return [...leftWords].some(word => rightWords.has(word))
        || leftWords.size === 0
        || rightWords.size === 0;
}

function templateKicker(_type, mg = null) {
    // LOOK HUMAN rule (June 2026, user mandate): the small all-caps category
    // label above a stage-visual title ("KEY TAKEAWAY", "KEY CHOKEPOINT") is
    // the #1 AI-design tell — banned on ALL templates + fullscreen MGs.
    // person-intro keeps its label (a real role/title, not a category).
    // Overlay MGs are untouched (kicker there carries functional info).
    if (isStageVisual(mg?._hfKind || 'graphic', _type) && _type !== 'person-intro') return '';
    const explicit = displayValue(
        mg?.kicker,
        mg?.eyebrow,
        mg?.categoryLabel,
        mg?.templateLabel,
        mg?.mgData?.kicker,
        mg?.mgData?.eyebrow
    );
    const generic = new Set([
        'chapter',
        'location',
        'quote',
        'key takeaway',
        'timeline',
        'fact',
        'image study',
        'data point',
        'profile',
        'contrast',
        'breakdown',
        'the list',
    ]);
    if (explicit && !generic.has(explicit.trim().toLowerCase())) return explicit;
    return '';
}

const SUPPORTED_HF_TYPES = new Set([
    'headline', 'lower-third', 'callout', 'stat-counter', 'focus-word',
    'progress-bar', 'bar-chart', 'donut-chart', 'ranking-list', 'timeline',
    'comparison-card', 'bullet-list', 'map-chart', 'explainer', 'kinetic-text',
    'typewriter', 'subscribe-cta', 'listicle-counter', 'progress-tracker',
    'listicle-grid', 'chapter-card', 'title-card', 'location-card', 'quote-card',
    'key-takeaway', 'timeline-card', 'fact-card', 'image-showcase', 'stat-card',
    'person-intro', 'split-screen', 'infographic', 'graphic',
]);

function typeSupportsFullscreen(type) {
    return new Set([
        'map-chart', 'bar-chart', 'donut-chart', 'ranking-list', 'timeline',
        'comparison-card', 'bullet-list', 'chapter-card', 'title-card',
        'listicle-grid', 'location-card', 'quote-card', 'key-takeaway',
        'timeline-card', 'fact-card', 'image-showcase', 'stat-card',
        'person-intro', 'split-screen', 'infographic',
    ]).has(type);
}

function isStageVisual(kind, type) {
    return kind === 'template' || kind === 'fullscreen' || typeSupportsFullscreen(type);
}

function templateBackgroundMode(mg = {}) {
    const fields = [
        mg.mgBackground,
        mg.background,
        mg.templateBackground,
        mg.templateBg,
        mg.backgroundMode,
        mg.mgData?.mgBackground,
        mg.mgData?.background,
        mg.mgData?.templateBackground,
        mg.mgData?.templateBg,
        mg.mgData?.backgroundMode,
    ];
    const explicitTransparent = fields.find(value => {
        if (typeof value !== 'string') return false;
        const mode = value.trim().toLowerCase();
        return mode === 'none' || mode === 'transparent' || (mode.includes('transparent') && !mode.startsWith('gradient:') && !mode.startsWith('image:'));
    });
    if (explicitTransparent) return explicitTransparent.trim();
    for (const value of fields) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function isTransparentTemplateBackground(mg = {}) {
    const mode = templateBackgroundMode(mg).toLowerCase();
    if (!mode) return false;
    if (mode === 'none' || mode === 'transparent') return true;
    if (mode.includes('transparent') && !mode.startsWith('gradient:') && !mode.startsWith('image:')) return true;
    return false;
}

function typeUsesDedicatedRenderer(type) {
    return typeSupportsFullscreen(type) || new Set([
        'map-chart', 'bar-chart', 'donut-chart', 'ranking-list', 'timeline',
        'comparison-card', 'bullet-list', 'chapter-card', 'title-card',
        'listicle-grid', 'location-card', 'quote-card', 'key-takeaway',
        'timeline-card', 'fact-card', 'image-showcase', 'stat-card',
        'person-intro', 'split-screen', 'infographic',
    ]).has(type);
}

function rendererMotion(mg, type, visual, agenticSpec) {
    const fixedRendererOverride = prefersFixedRenderer(mg);
    const authoredMotion = !fixedRendererOverride && mg?._authoredComposition
        ? agenticSpec?.motion
        : null;
    const useAgenticRenderer = Boolean(
        agenticSpec
        && !typeUsesDedicatedRenderer(type)
    );
    return {
        useAgenticRenderer,
        animation: displayValue(
            authoredMotion?.entrance,
            !fixedRendererOverride && useAgenticRenderer
                ? agenticSpec?.motion?.entrance
                : null,
            visual?.animation,
            'fadeSlide'
        ),
        speed: normalizeMotionSpeed(
            authoredMotion?.speed
                ?? (!fixedRendererOverride && useAgenticRenderer
                    ? agenticSpec?.motion?.speed
                    : null),
            visual?.speed
        ),
    };
}

const DEDICATED_GRAPHIC_SHELL_TYPES = new Set([
    'map-chart', 'bar-chart', 'donut-chart', 'ranking-list', 'timeline',
    'comparison-card', 'bullet-list', 'chapter-card', 'title-card',
    'listicle-grid', 'location-card', 'quote-card', 'key-takeaway',
    'timeline-card', 'fact-card', 'image-showcase', 'stat-card',
    'person-intro', 'split-screen', 'infographic',
]);

function typeSupportsGraphicShell(type, useAgenticRenderer = false) {
    return Boolean(useAgenticRenderer || DEDICATED_GRAPHIC_SHELL_TYPES.has(type));
}

const MIN_VISUAL_DURATION = 0.5;
const TIMING_GUARD_GAP = 0.08;

function renderRangeClipInfo(item) {
    const clip = item?._renderRangeClip;
    if (!clip || typeof clip !== 'object') return null;
    const sourceDuration = Number(clip.sourceDuration);
    const sourceOffset = Math.max(0, Number(clip.sourceOffset) || 0);
    const clippedAtStart = clip.clippedAtStart === true;
    const clippedAtEnd = clip.clippedAtEnd === true;
    if (!(sourceDuration > 0) || (!clippedAtStart && !clippedAtEnd)) return null;
    return {
        sourceDuration,
        sourceOffset: Math.min(sourceDuration, sourceOffset),
        visibleDuration: Math.max(0.001, Number(clip.visibleDuration) || 0.001),
        clippedAtStart,
        clippedAtEnd,
    };
}

function minimumVisualDuration(item) {
    const rangeClip = renderRangeClipInfo(item);
    return rangeClip
        ? Math.max(0.001, Math.min(MIN_VISUAL_DURATION, rangeClip.visibleDuration))
        : MIN_VISUAL_DURATION;
}

function getSceneWindow(scene) {
    if (!scene) return null;
    const start = toSeconds(scene.startTime, toSeconds(scene.start, NaN));
    const end = toSeconds(scene.endTime, toSeconds(scene.end, NaN));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return { start: Math.max(0, start), end: Math.max(0, end), duration: Math.max(MIN_VISUAL_DURATION, end - start) };
    }
    const duration = getDuration(scene, NaN);
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
        return { start: Math.max(0, start), end: Math.max(0, start + duration), duration: Math.max(MIN_VISUAL_DURATION, duration) };
    }
    return null;
}

function getExplicitVisualSpan(mg) {
    const minimumDuration = minimumVisualDuration(mg);
    const start = toSeconds(mg?.startTime, toSeconds(mg?.start, toSeconds(mg?.at, NaN)));
    const end = toSeconds(mg?.endTime, toSeconds(mg?.end, NaN));
    const duration = firstFiniteNumber(
        toSeconds(mg?.durationSeconds, NaN),
        toSeconds(mg?.displayDuration, NaN),
        toSeconds(mg?.templateDuration, NaN),
        toSeconds(mg?.visualDuration, NaN),
        toSeconds(mg?.duration, NaN)
    );
    const hasExplicitStart = Number.isFinite(start);
    const hasExplicitEnd = hasExplicitStart && Number.isFinite(end) && end > start;
    return {
        start: hasExplicitStart ? Math.max(0, start) : 0,
        end: hasExplicitEnd ? Math.max(0, end) : NaN,
        duration: hasExplicitEnd
            ? Math.max(minimumDuration, end - start)
            : (Number.isFinite(duration) && duration > 0 && duration < 3600 ? duration : NaN),
        hasExplicitStart,
        hasExplicitEnd,
    };
}

function maxVisualDuration(kind, type, mg) {
    if (mg?.allowLongDuration || mg?.persistent || mg?.isPersistent) return Infinity;
    if (kind === 'overlay') return 5.8;
    if (isStageVisual(kind, type)) {
        const span = getExplicitVisualSpan(mg);
        return span.hasExplicitEnd ? Infinity : 8.2;
    }
    if (type === 'lower-third' || type === 'focus-word' || type === 'callout') return 5.8;
    return 6.5;
}

function getVisualTiming(mg, kind, type) {
    const rangeClip = renderRangeClipInfo(mg);
    const minimumDuration = minimumVisualDuration(mg);
    const stageVisual = isStageVisual(kind, type);
    const explicitSpan = getExplicitVisualSpan(mg);
    const rawStart = explicitSpan.hasExplicitStart ? explicitSpan.start : toSeconds(mg?.startTime, 0);
    const rawDuration = Number.isFinite(explicitSpan.duration) ? explicitSpan.duration : getDuration(mg, 3);
    const sceneWindow = getSceneWindow(mg?._hfOwnerScene);
    const maxDuration = maxVisualDuration(kind, type, mg);
    let start = Math.max(0, rawStart);
    let duration = Math.max(minimumDuration, rawDuration);

    // An overlay with an explicit (word-synced) start owns its timeline position —
    // never move it. Only anchor overlays that have NO explicit start, and stage
    // visuals, to the scene window.
    const overlayExplicit = kind === 'overlay' && explicitSpan.hasExplicitStart;
    if (sceneWindow && !stageVisual) {
        if (kind !== 'overlay' || !explicitSpan.hasExplicitStart) start = sceneWindow.start;
        if (!overlayExplicit && (start < sceneWindow.start - 0.2 || start > sceneWindow.end + 0.2)) start = sceneWindow.start;
        const remainingScene = Math.max(minimumDuration, sceneWindow.end - start);
        if (!overlayExplicit) duration = Math.min(duration, remainingScene);
    } else if (sceneWindow && !explicitSpan.hasExplicitStart) {
        start = sceneWindow.start;
        const remainingScene = Math.max(minimumDuration, sceneWindow.end - start);
        duration = Math.min(duration, remainingScene);
    }

    if (Number.isFinite(maxDuration)) duration = Math.min(duration, maxDuration);
    duration = Math.max(minimumDuration, duration);
    const sourceOffset = rangeClip?.sourceOffset || 0;
    const sourceDuration = Math.max(
        duration + sourceOffset,
        rangeClip?.sourceDuration || duration
    );
    return {
        start,
        duration,
        rawStart,
        rawDuration,
        sourceOffset,
        sourceDuration,
        rangeClippedAtStart: rangeClip?.clippedAtStart === true,
        rangeClippedAtEnd: rangeClip?.clippedAtEnd === true,
        rangeFragment: Boolean(rangeClip),
        minimumDuration,
        clamped: Math.abs(start - Math.max(0, rawStart)) > 0.01 || Math.abs(duration - Math.max(minimumDuration, rawDuration)) > 0.01,
    };
}

function visualOverlapGroup(mg, type) {
    const kind = mg?._hfKind || 'graphic';
    if (isStageVisual(kind, type)) {
        const directScene = graphicSceneIndex(mg);
        const ownerScene = graphicSceneIndex(mg?._hfOwnerScene);
        const scene = Number.isFinite(directScene) ? directScene : ownerScene;
        if (Number.isFinite(scene)) return `stage:${scene}`;
        return `stage:${Math.round(toSeconds(mg?.startTime, 0) * 10) / 10}`;
    }
    if (kind === 'overlay') {
        const visual = mg?._hfVisual || {};
        const zone = normalizeType(visual.safeZone || visual.layout || mg?.safeZone || mg?.position || mg?.layout, 'overlay');
        return `overlay:${zone}`;
    }
    return `graphic:${type || kind}`;
}

function applyVisualTimingGuards(graphics, totalDuration) {
    const report = { total: graphics.length, clamped: [], groups: {} };
    const withTiming = graphics.map((mg) => {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        const timing = getVisualTiming(mg, mg?._hfKind, type);
        return { ...mg, _hfTiming: timing, _hfTimingType: type, _hfTimingGroup: visualOverlapGroup(mg, type) };
    });

    const groups = new Map();
    for (const mg of withTiming) {
        const group = mg._hfTimingGroup || 'graphic';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(mg);
    }

    for (const [group, items] of groups.entries()) {
        items.sort((a, b) => a._hfTiming.start - b._hfTiming.start);
        report.groups[group] = items.length;
        for (let i = 0; i < items.length; i++) {
            const current = items[i];
            const next = items[i + 1];
            const original = { ...current._hfTiming };
            const minimumDuration = current._hfTiming.minimumDuration || MIN_VISUAL_DURATION;
            if (next && current._hfTiming.start + current._hfTiming.duration > next._hfTiming.start - TIMING_GUARD_GAP) {
                current._hfTiming.duration = Math.max(minimumDuration, next._hfTiming.start - current._hfTiming.start - TIMING_GUARD_GAP);
            }
            if (Number.isFinite(totalDuration) && current._hfTiming.start + current._hfTiming.duration > totalDuration) {
                current._hfTiming.duration = Math.max(minimumDuration, totalDuration - current._hfTiming.start);
            }
            if (current._hfTiming.clamped || Math.abs(current._hfTiming.duration - original.duration) > 0.01) {
                report.clamped.push({
                    group,
                    kind: current._hfKind || 'graphic',
                    type: current._hfTimingType,
                    start: Number(current._hfTiming.start.toFixed(3)),
                    rawDuration: Number(original.rawDuration.toFixed ? original.rawDuration.toFixed(3) : original.rawDuration),
                    duration: Number(current._hfTiming.duration.toFixed(3)),
                    reason: next ? 'scene/window or overlap guard' : 'scene/window guard',
                });
            }
        }
    }

    return { graphics: withTiming, report };
}

function looseSceneIndex(value) {
    if (value == null) return NaN;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value);
    const match = text.match(/(?:scene|s)?\s*#?\s*(\d+)/i);
    return match ? Number(match[1]) : NaN;
}

function graphicSceneIndex(mg) {
    return firstFiniteNumber(
        looseSceneIndex(mg?.sceneIndex),
        looseSceneIndex(mg?.sourceSceneIndex),
        looseSceneIndex(mg?.targetSceneIndex),
        looseSceneIndex(mg?.sceneId),
        looseSceneIndex(mg?.scene),
        looseSceneIndex(mg?._sceneIndex),
        looseSceneIndex(mg?._ownerSceneIndex),
        looseSceneIndex(mg?.index)
    );
}

function findOwnerSceneForGraphic(scenes, mg) {
    if (!Array.isArray(scenes) || !scenes.length || !mg) return null;
    const start = toSeconds(mg?.startTime, NaN);
    const byTime = () => {
        if (!Number.isFinite(start)) return null;
        return scenes.find((scene) => {
            const s = toSeconds(scene?.startTime, toSeconds(scene?.start, NaN));
            const e = toSeconds(scene?.endTime, toSeconds(scene?.end, NaN));
            if (Number.isFinite(s) && Number.isFinite(e) && e >= s) return start >= s - 0.25 && start <= e + 0.25;
            return Number.isFinite(s) && Math.abs(s - start) < 0.75;
        }) || null;
    };
    // Overlay MGs are word-synced to an ABSOLUTE time, so their startTime is
    // authoritative — match the scene ACTIVE AT THAT TIME. A stored sceneIndex can
    // be stale after scenes are renumbered/reordered/merged, and matching it would
    // teleport the overlay to a different scene's window (the bug where a
    // statCounter labelled @71.3s rendered @82.9s). Stage visuals (fullscreen/
    // template) stay tied to their scene index.
    if ((mg?._hfKind || '') === 'overlay') {
        const t = byTime();
        if (t) return t;
    }
    const wanted = graphicSceneIndex(mg);
    if (Number.isFinite(wanted)) {
        const byIndex = scenes.find((scene) => looseSceneIndex(scene?.index) === wanted || looseSceneIndex(scene?.sceneIndex) === wanted);
        if (byIndex) return byIndex;
    }
    return byTime();
}

function graphicDedupeText(mg) {
    const raw = [
        getMgText(mg),
        getMgSubtext(mg),
        mg?.templateText,
        mg?.templateHint,
        mg?.sceneText,
        mg?.title,
        mg?.label,
    ].filter(Boolean).join(' ');
    return String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .slice(0, 110);
}

function graphicDedupeKey(mg) {
    const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
    const directScene = graphicSceneIndex(mg);
    const ownerScene = graphicSceneIndex(mg?._hfOwnerScene);
    const scene = Number.isFinite(directScene) ? directScene : ownerScene;
    const start = Math.round(toSeconds(mg?.startTime, toSeconds(mg?.start, 0)) * 20) / 20;
    const text = graphicDedupeText(mg) || classToken(type, 'visual');
    return [
        type,
        Number.isFinite(scene) ? `scene-${scene}` : `start-${start}`,
        start,
        text,
    ].join('|');
}

function graphicDedupeScore(mg) {
    const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
    const kindScore = mg?._hfKind === 'template' ? 40 : (mg?._hfKind === 'fullscreen' ? 32 : 20);
    const assetScore = mgAssetRefs(mg, type).some(Boolean) ? 10 : 0;
    const endScore = Number.isFinite(toSeconds(mg?.endTime, NaN)) ? 3 : 0;
    const textScore = graphicDedupeText(mg) ? 2 : 0;
    return kindScore + assetScore + endScore + textScore;
}

function dedupeGraphics(graphics) {
    const kept = new Map();
    const removed = [];
    for (const mg of graphics) {
        const key = graphicDedupeKey(mg);
        const score = graphicDedupeScore(mg);
        const current = kept.get(key);
        if (!current || score > current.score) {
            if (current) {
                removed.push({
                    key,
                    keptKind: mg?._hfKind || 'graphic',
                    removedKind: current.item?._hfKind || 'graphic',
                    type: resolveVisualType(mg, mg?._hfKind || 'graphic'),
                    startTime: toSeconds(mg?.startTime, 0),
                    text: graphicDedupeText(mg),
                });
            }
            kept.set(key, { item: mg, score });
        } else {
            removed.push({
                key,
                keptKind: current.item?._hfKind || 'graphic',
                removedKind: mg?._hfKind || 'graphic',
                type: resolveVisualType(mg, mg?._hfKind || 'graphic'),
                startTime: toSeconds(mg?.startTime, 0),
                text: graphicDedupeText(mg),
            });
        }
    }
    return {
        graphics: Array.from(kept.values()).map(entry => entry.item)
            .sort((a, b) => toSeconds(a.startTime, 0) - toSeconds(b.startTime, 0)),
        report: {
            before: graphics.length,
            after: kept.size,
            removed,
        },
    };
}

function mgAssetRefs(mg, type) {
    const refs = [];
    if (type === 'map-chart') {
        refs.push(
            mg?.mapImageFile,
            mg?.mapImagePath,
            mg?.mapImage,
            mg?.renderAssets?.mapImageFile,
            mg?._mapScene?.renderAssets?.mapImageFile,
            mg?._mapScene?.mapImageFile
        );
    }
    refs.push(
        mg?.templateMediaFile,
        mg?.templateBgFile,
        mg?._templateMediaUrl,
        mg?.backgroundMediaFile,
        mg?.backgroundImageFile,
        mg?.backgroundVideoFile,
        mg?.templateBackgroundFile,
        mg?.templateBackgroundMediaFile,
        mg?.templateBackgroundImageFile,
        mg?.templateBackgroundVideoFile,
        mg?._templateMediaFile,
        mg?.imageFile,
        mg?.imagePath,
        mg?.videoFile,
        mg?.videoPath,
        mg?.mediaFile,
        mg?.mediaPath,
        mg?.assetFile,
        mg?.assetPath,
        mg?.file,
        mg?.path,
        mg?._hfOwnerScene?.mediaFile,
        mg?._hfOwnerScene?.mediaPath,
        mg?._hfOwnerScene?.backgroundMediaFile,
        mg?._hfOwnerScene?.backgroundImageFile,
        mg?._hfOwnerScene?.imageFile,
        mg?._hfOwnerScene?.videoFile,
        mg?._hfOwnerScene?.assetFile,
        mg?._hfOwnerScene?.file,
        mg?._hfOwnerScene?.path,
        ...collectFileRefsFromObject(mg?.renderAssets),
        ...collectFileRefsFromObject(mg?._mapScene?.renderAssets),
        ...collectFileRefsFromObject(mg?.template),
        ...collectFileRefsFromObject(mg?.background),
        ...collectFileRefsFromObject(mg?.media),
        ...collectFileRefsFromObject(mg?.asset),
        ...collectFileRefsFromObject(mg?.mgData),
        ...collectFileRefsFromObject(mg?._hfOwnerScene)
    );
    return uniqueRefs(refs);
}

function indexedMediaCandidates(mg, type, dirs) {
    if (type !== 'map-chart' && !typeSupportsFullscreen(type)) return [];

    const indices = [
        graphicSceneIndex(mg),
        looseSceneIndex(mg?._hfOwnerScene?.index),
        looseSceneIndex(mg?._hfOwnerScene?.sourceSceneIndex),
        looseSceneIndex(mg?._hfOwnerScene?.sceneIndex),
        looseSceneIndex(mg?._hfOwnerScene?.id),
    ].filter(Number.isFinite);
    if (!indices.length) return [];

    const wanted = new Set(indices.map(n => String(Math.max(0, Math.round(n)))));
    const isMap = type === 'map-chart';
    const prefersVideo = typeSupportsFullscreen(type) && !isMap;
    const files = listMediaFiles(dirs).filter((file) => {
        const base = path.basename(file).toLowerCase();
        if (isMap && /^map[-_]/.test(base)) return true;
        return [...wanted].some(idx => base === `scene-${idx}${path.extname(base)}` || base.startsWith(`scene-${idx}.`) || base.startsWith(`scene-${idx}-`));
    });
    return files.sort((a, b) => {
        const extA = path.extname(a).toLowerCase();
        const extB = path.extname(b).toLowerCase();
        const aVideo = VIDEO_EXTS.has(extA);
        const bVideo = VIDEO_EXTS.has(extB);
        if (prefersVideo && aVideo !== bVideo) return aVideo ? -1 : 1;
        if (isMap && baseScore(a) !== baseScore(b)) return baseScore(a) - baseScore(b);
        return path.basename(a).localeCompare(path.basename(b));
    });

    function baseScore(file) {
        const base = path.basename(file).toLowerCase();
        if (base.startsWith('map-satellite')) return 0;
        if (base.startsWith('map-')) return 1;
        return 2;
    }
}

function copyMgAsset(mg, type, dirs, mediaDir, assetCache, id) {
    const explicitRefs = mgAssetRefs(mg, type)
        .map(ref => resolveMaybeFile(ref, dirs))
        .filter(Boolean);
    const candidates = uniqueRefs([...explicitRefs, ...indexedMediaCandidates(mg, type, dirs)]);
    for (const found of candidates) {
        if (!found) continue;
        const ext = path.extname(found).toLowerCase();
        const isVideo = VIDEO_EXTS.has(ext);
        const rel = copyAsset(found, mediaDir, `${id}-${path.basename(found, ext)}`, assetCache, {
            normalizeVideo: isVideo,
            duration: getDuration(mg, 5),
            startOffset: getSceneVideoOffset(mg) || getSceneVideoOffset(mg?._hfOwnerScene),
        });
        if (rel) return { rel, isVideo, ext };
    }
    return null;
}

function hasResolvedMgAsset(mg, type, dirs) {
    return mgAssetRefs(mg, type).some(ref => resolveMaybeFile(ref, dirs)) || indexedMediaCandidates(mg, type, dirs).length > 0;
}

function mapLabelsFromMg(mg) {
    const labels = [];
    const explicit = mg?._mapScene?.annotationPlan?.labels || mg?.annotationPlan?.labels || [];
    for (const label of explicit) {
        const text = displayValue(label?.text, label?.name, label?.subjectId);
        if (text && !labels.includes(text)) labels.push(text);
    }
    const pins = mg?._mapScene?.geometry?.pins || mg?.geometry?.pins || mg?._mapPins || [];
    for (const pin of pins) {
        const text = displayValue(pin?.name, pin?.fullName, pin?.label);
        if (text && !labels.includes(text)) labels.push(text);
    }
    return labels.slice(0, 6);
}

let COUNTRY_GEOJSON_CACHE = null;

function loadCountryGeoJSON(dirs) {
    if (COUNTRY_GEOJSON_CACHE) return COUNTRY_GEOJSON_CACHE;
    const candidates = [
        dirs?.appRoot ? path.join(dirs.appRoot, 'assets', 'geo', 'countries-slim.json') : null,
        path.join(process.cwd(), 'assets', 'geo', 'countries-slim.json'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            COUNTRY_GEOJSON_CACHE = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            return COUNTRY_GEOJSON_CACHE;
        } catch (_) {
            // Try the next candidate.
        }
    }
    COUNTRY_GEOJSON_CACHE = { features: [] };
    return COUNTRY_GEOJSON_CACHE;
}

function normalizePlaceName(value) {
    return String(value || '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b(?:port|city|region|province|state|strait|route|shipping|map|satellite|border|borders)\b/gi, ' ')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .toLowerCase();
}

function collectMapNames(mg) {
    const names = [...mapLabelsFromMg(mg)];
    const sources = [
        mg?._mapScene?.subjects,
        mg?.subjects,
        mg?._mapScene?.renderAssets?.waypoints,
        mg?.renderAssets?.waypoints,
        mg?._mapWaypoints,
        mg?._mapScene?.geometry?.pins,
        mg?.geometry?.pins,
        mg?._mapPins,
    ];
    for (const source of sources) {
        const arr = Array.isArray(source) ? source : [];
        for (const item of arr) {
            const text = displayValue(item?.name, item?.fullName, item?.label, item?.title, item?.country, item?.iso, item);
            if (text && !names.includes(text)) names.push(text);
        }
    }
    return names.slice(0, 10);
}

function countryFeatureName(feature) {
    return displayValue(
        feature?.properties?.name,
        feature?.properties?.nameLong,
        feature?.properties?.sov,
        feature?.properties?.iso
    );
}

function findCountryFeatures(names, dirs) {
    const geo = loadCountryGeoJSON(dirs);
    const features = Array.isArray(geo?.features) ? geo.features : [];
    const selected = [];
    const used = new Set();
    for (const rawName of names) {
        const needle = normalizePlaceName(rawName);
        if (!needle) continue;
        const found = features.find((feature) => {
            const props = feature?.properties || {};
            const values = [props.name, props.nameLong, props.sov, props.iso].filter(Boolean);
            return values.some((value) => {
                const hay = normalizePlaceName(value);
                return hay && (hay === needle || hay.includes(needle) || needle.includes(hay));
            });
        });
        const key = countryFeatureName(found);
        if (found && key && !used.has(key)) {
            used.add(key);
            selected.push(found);
        }
    }
    return selected.slice(0, 6);
}

function geometryRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return geometry.coordinates || [];
    if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
    return [];
}

function ringBounds(ring, bounds) {
    for (const point of ring || []) {
        const lon = Number(point?.[0]);
        const lat = Number(point?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        bounds.minLon = Math.min(bounds.minLon, lon);
        bounds.maxLon = Math.max(bounds.maxLon, lon);
        bounds.minLat = Math.min(bounds.minLat, lat);
        bounds.maxLat = Math.max(bounds.maxLat, lat);
    }
}

function featureBounds(features) {
    const bounds = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
    for (const feature of features) {
        for (const ring of geometryRings(feature?.geometry)) ringBounds(ring, bounds);
    }
    if (!Number.isFinite(bounds.minLon)) return null;
    const lonPad = Math.max(0.5, (bounds.maxLon - bounds.minLon) * 0.16);
    const latPad = Math.max(0.5, (bounds.maxLat - bounds.minLat) * 0.16);
    return {
        minLon: bounds.minLon - lonPad,
        maxLon: bounds.maxLon + lonPad,
        minLat: bounds.minLat - latPad,
        maxLat: bounds.maxLat + latPad,
    };
}

function projectLonLat(lon, lat, bounds, width = 1600, height = 900, pad = 90) {
    const safeLonSpan = Math.max(0.001, bounds.maxLon - bounds.minLon);
    const safeLatSpan = Math.max(0.001, bounds.maxLat - bounds.minLat);
    return {
        x: pad + ((lon - bounds.minLon) / safeLonSpan) * (width - pad * 2),
        y: pad + ((bounds.maxLat - lat) / safeLatSpan) * (height - pad * 2),
    };
}

function ringToPath(ring, bounds) {
    if (!Array.isArray(ring) || ring.length < 2) return '';
    const step = Math.max(1, Math.ceil(ring.length / 520));
    const parts = [];
    for (let i = 0; i < ring.length; i += step) {
        const lon = Number(ring[i]?.[0]);
        const lat = Number(ring[i]?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const p = projectLonLat(lon, lat, bounds);
        parts.push(`${parts.length ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
    }
    return parts.length ? `${parts.join(' ')} Z` : '';
}

function featurePath(feature, bounds) {
    return geometryRings(feature?.geometry)
        .map((ring) => ringToPath(ring, bounds))
        .filter(Boolean)
        .join(' ');
}

function featureCenter(feature) {
    const bounds = featureBounds([feature]);
    if (!bounds) return null;
    return {
        lon: (bounds.minLon + bounds.maxLon) * 0.5,
        lat: (bounds.minLat + bounds.maxLat) * 0.5,
    };
}

function buildCountryBorderMap(mg, labels, dirs) {
    const names = collectMapNames(mg);
    const features = findCountryFeatures(names, dirs);
    if (!features.length) return '';
    const bounds = featureBounds(features);
    if (!bounds) return '';
    const paths = features.map((feature, index) => {
        const name = countryFeatureName(feature);
        const d = featurePath(feature, bounds);
        return d ? `<path class="hf-country-fill" style="--i:${index}" d="${d}" data-name="${html(name)}"></path><path class="hf-country-line" style="--i:${index}" d="${d}"></path>` : '';
    }).join('');
    const centers = features.map((feature) => {
        const center = featureCenter(feature);
        return center ? { ...center, name: countryFeatureName(feature) } : null;
    }).filter(Boolean);
    const routePoints = centers.map((center) => projectLonLat(center.lon, center.lat, bounds));
    const route = routePoints.length > 1
        ? `<path class="hf-country-route" d="${routePoints.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')}"></path>`
        : '';
    const pins = centers.map((center, index) => {
        const p = projectLonLat(center.lon, center.lat, bounds);
        const label = labels[index] || center.name;
        return `<g class="hf-country-pin" style="--i:${index}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><circle r="10"></circle><text x="18" y="5">${html(label)}</text></g>`;
    }).join('');
    return `
      <svg class="hf-country-map" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Animated country border map">
        <rect class="hf-map-water" x="0" y="0" width="1600" height="900"></rect>
        ${paths}
        ${route}
        ${pins}
      </svg>`;
}

function splitStatText(text) {
    const raw = String(text || '').trim();
    const m = raw.match(/^([~]?[\s\d,.]+(?:\s*[-]\s*[\d,.]+)?\s*(?:%|m|bn|b|million|billion|trillion|x)?)(?:\s+(.+))?$/i);
    if (!m) return { value: raw, label: '' };
    return { value: m[1].trim(), label: (m[2] || '').trim() };
}

function buildTitleBits(text, subtext, options = {}) {
    const kicker = displayValue(options.kicker);
    return `
      ${kicker ? `<div class="hf-kicker">${html(kicker)}</div>` : ''}
      ${text ? `<div class="hf-title">${html(text)}</div>` : ''}
      ${subtext ? `<div class="hf-subtitle">${html(subtext)}</div>` : ''}`;
}

function buildSafeLayoutMarkup({
    mg,
    baseAttrs,
    asset,
    id,
    start,
    duration,
    track,
    kind,
    type,
    text,
    subtext,
    items,
}) {
    const title = conciseVisualText(text || type.replace(/-/g, ' '), {
        maxChars: kind === 'overlay' ? 72 : 110,
        maxWords: kind === 'overlay' ? 11 : 18,
    });
    const subtitle = conciseVisualText(subtext, {
        maxChars: kind === 'overlay' ? 90 : 130,
        maxWords: kind === 'overlay' ? 14 : 22,
    });
    const safeItems = (items || []).slice(0, 4).map((item) => ({
        value: conciseVisualText(item?.value, { maxChars: 24, maxWords: 4 }),
        label: conciseVisualText(item?.label, { maxChars: 56, maxWords: 9 }),
        subtext: conciseVisualText(item?.subtext, { maxChars: 70, maxWords: 11 }),
    })).filter((item) => item.value || item.label || item.subtext);
    const itemMarkup = safeItems.length
        ? `<div class="hf-safe-layout-items" data-hf-layout-probe="safe-items" data-hf-layout-strict="1">${safeItems.map((item) => `
            <div class="hf-safe-layout-item" data-hf-layout-critical="1">
              ${item.value ? `<strong>${html(item.value)}</strong>` : ''}
              ${item.label ? `<span>${html(item.label)}</span>` : ''}
              ${item.subtext ? `<small>${html(item.subtext)}</small>` : ''}
            </div>`).join('')}</div>`
        : '';
    const reason = conciseVisualText(
        mg?.motionQaSafeLayoutReason
        || mg?._motionQaSafeLayoutReason
        || mg?.mgData?.motionQaSafeLayoutReason
        || '',
        { maxChars: 160, maxWords: 24 }
    );

    if (type === 'comparison-card') {
        const comparison = comparisonContent(mg, text, subtext, items);
        return `
    ${renderAssetFill(asset, id, start, duration, track, {
        template: kind === 'template',
        preRoll: kind === 'template' ? 0.12 : 0,
    })}
    <div ${baseAttrs} data-hf-safe-layout="1" data-hf-safe-layout-reason="${html(reason)}">
      <div class="hf-safe-layout-backdrop"></div>
      <div class="hf-comparison-stage hf-safe-comparison-stage">
        <div class="hf-comparison-wrap" data-hf-layout-probe="safe-comparison-grid" data-hf-layout-strict="1">
          <div class="hf-compare-side" data-hf-layout-critical="1" data-hf-layout-collision="1">${html(comparison.left)}</div>
          <div class="hf-compare-vs" data-hf-layout-critical="1" data-hf-layout-collision="1">VS</div>
          <div class="hf-compare-side" data-hf-layout-critical="1" data-hf-layout-collision="1">${html(comparison.right)}</div>
        </div>
        ${comparison.note ? `<div class="hf-comparison-note" data-hf-layout-critical="1" data-hf-layout-collision="1">${html(comparison.note)}</div>` : ''}
      </div>
    </div>`;
    }

    if (kind === 'overlay' && type === 'stat-counter') {
        const stat = splitStatText(title);
        return `
    <div ${baseAttrs} data-hf-safe-layout="1" data-hf-safe-layout-reason="${html(reason)}">
      <div class="hf-safe-stat-overlay" data-hf-layout-probe="safe-stat-overlay" data-hf-layout-strict="1">
        <div class="hf-safe-stat-value" data-hf-layout-critical="1">${html(stat.value || title)}</div>
        ${stat.label ? `<div class="hf-safe-stat-label" data-hf-layout-critical="1">${html(stat.label)}</div>` : ''}
        ${subtitle ? `<div class="hf-safe-layout-subtitle" data-hf-layout-critical="1">${html(subtitle)}</div>` : ''}
      </div>
    </div>`;
    }

    if (kind === 'overlay') {
        return `
    <div ${baseAttrs} data-hf-safe-layout="1" data-hf-safe-layout-reason="${html(reason)}">
      <div class="hf-safe-layout-overlay" data-hf-layout-probe="safe-overlay" data-hf-layout-strict="1">
        ${title ? `<div class="hf-safe-layout-title" data-hf-layout-critical="1">${html(title)}</div>` : ''}
        ${subtitle ? `<div class="hf-safe-layout-subtitle" data-hf-layout-critical="1">${html(subtitle)}</div>` : ''}
        ${itemMarkup}
      </div>
    </div>`;
    }

    return `
    ${renderAssetFill(asset, id, start, duration, track, {
        template: kind === 'template',
        preRoll: kind === 'template' ? 0.12 : 0,
    })}
    <div ${baseAttrs} data-hf-safe-layout="1" data-hf-safe-layout-reason="${html(reason)}">
      <div class="hf-safe-layout-backdrop"></div>
      <div class="hf-safe-layout-stage">
        <div class="hf-safe-layout-card" data-hf-layout-probe="safe-card" data-hf-layout-strict="1">
          ${title ? `<div class="hf-safe-layout-title" data-hf-layout-critical="1">${html(title)}</div>` : ''}
          ${subtitle ? `<div class="hf-safe-layout-subtitle" data-hf-layout-critical="1">${html(subtitle)}</div>` : ''}
          ${itemMarkup}
        </div>
      </div>
    </div>`;
}

function buildFallbackMap(labels, mg, dirs) {
    const countryMap = buildCountryBorderMap(mg, labels, dirs);
    if (countryMap) return countryMap;
    const chips = labels.length ? labels : ['Map data'];
    return `
      <div class="hf-fallback-map">
        <div class="hf-map-grid"></div>
        <div class="hf-map-route"></div>
        <div class="hf-map-fallback-labels">${chips.map(label => `<span>${html(label)}</span>`).join('')}</div>
      </div>`;
}

/**
 * Will this graphic actually ship the agent's own composition, or fall back to
 * the fixed renderer?
 *
 * buildMgMarkup has always answered this — it just answered it privately, deep
 * inside a 200-line function, after the visual report had already been written.
 * That was survivable while only the renderer cared. It stopped being
 * survivable when the report started carrying MEASURED motion: a composition
 * that is rejected at the safety gate renders as a fixed-renderer graphic whose
 * motion genuinely IS its `animation`/`speed` label, and stamping measured
 * timings onto it would tell the sequence linter to grade a timeline that never
 * ran. One shared answer, two callers, no drift.
 *
 * Pure by construction: the warning and the `_authoredRendered` bookkeeping
 * stay with the renderer, so asking the question twice costs nothing and
 * changes nothing.
 */
function authoredRenderPlan(mg, { type, kind, timing }) {
    const safeLayout = safeLayoutRequested(mg);
    const authored = (safeLayout || prefersFixedRenderer(mg)) ? null : (mg?._authoredComposition || null);
    const assets = Array.isArray(mg?._authoredAssets) ? mg._authoredAssets : [];
    const ns = String(mg?._authoredNs || authored?.ns || '').trim();
    const duration = Math.max(timing.duration, timing.sourceDuration || timing.duration);
    let validation = null;
    if (authored && authored.html && authored.timeline && ns) {
        validation = validateAuthoredComposition(authored, ns, duration, assets, null);
    }
    const willRender = Boolean(
        authored
        && (!ns || validation?.ok)
        && (isStageVisual(kind, type) || kind === 'overlay')
    );
    return { safeLayout, authored, assets, ns, duration, validation, willRender };
}

function buildVisualDiagnostics(graphics, dirs) {
    const report = {
        total: graphics.length,
        byType: {},
        byStyle: {},
        byVariant: {},
        byAnimation: {},
        byMotionFamily: {},
        byComposition: {},
        byLayout: {},
        resolved: [],
        unsupported: [],
        fallbacks: [],
        missingMapAssets: [],
        missingTemplateMedia: [],
    };
    const templateNeedsMedia = new Set(['chapter-card', 'title-card', 'location-card', 'fact-card', 'stat-card', 'image-showcase', 'person-intro', 'split-screen', 'infographic']);
    for (const mg of graphics) {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        const visual = mg?._hfVisual || resolveHyperframeVisual(mg, mg?._hfKind || 'graphic', type, {});
        const text = getMgText(mg);
        const subtext = getMgSubtext(mg);
        const items = itemsFromMg(mg, text, subtext);
        const spec = getAgenticCompositionSpec(mg, {
            kind: mg?._hfKind || 'graphic',
            type,
            visual,
            text,
            subtext,
            items,
            kicker: templateKicker(type, mg),
            hasAsset: hasResolvedMgAsset(mg, type, dirs),
        });
        const compositionMode = spec?.mode || 'legacy';
        const compositionLayout = spec?.layout || 'legacy';
        const motion = rendererMotion(mg, type, visual, spec);
        const effectiveAnimation = motion.animation;
        const effectiveSpeed = motion.speed;
        report.byType[type] = (report.byType[type] || 0) + 1;
        report.byStyle[visual.styleName] = (report.byStyle[visual.styleName] || 0) + 1;
        report.byVariant[`${type}:${visual.variant}`] = (report.byVariant[`${type}:${visual.variant}`] || 0) + 1;
        report.byAnimation[effectiveAnimation] = (report.byAnimation[effectiveAnimation] || 0) + 1;
        report.byComposition[compositionMode] = (report.byComposition[compositionMode] || 0) + 1;
        report.byLayout[compositionLayout] = (report.byLayout[compositionLayout] || 0) + 1;
        // The same entrance reaches this report under two spellings (camelCase
        // from themes/registry, kebab from the motion QA agent and authored
        // comps), so byAnimation splits one motion across two keys and reads as
        // variety. byAnimation is left exactly as it was — other tooling reads
        // it — and the honest tally is recorded beside it.
        const family = videoLintMotionFamily(effectiveAnimation);
        report.byMotionFamily[family] = (report.byMotionFamily[family] || 0) + 1;
        const timing = getVisualTiming(mg, mg?._hfKind || 'graphic', type);
        // An authored composition's motion lives in the GSAP timeline the agent
        // wrote, not in `animation`/`speed` — those two are resolved from the
        // PLAN above and, for an authored comp, describe a renderer that never
        // runs. Grading pace off them would be grading a label. So measure the
        // timeline that actually ships and report the numbers beside the label.
        // Registry MGs keep being judged on their strings, which for them are
        // the truth; authored comps get judged on their timing, which for them
        // is the truth. Same rule, different evidence.
        const authoredPlan = authoredRenderPlan(mg, { type, kind: mg?._hfKind || 'graphic', timing });
        const authoredMotionFacts = authoredPlan.willRender
            ? measureAuthoredMotion(authoredPlan.authored.timeline)
            : null;
        report.resolved.push({
            type,
            kind: mg?._hfKind || 'graphic',
            sceneIndex: mg?.sceneIndex ?? mg?.index ?? null,
            startTime: toSeconds(mg?.startTime, 0),
            compositionMode,
            layout: spec?.layout || '',
            safeZone: spec?.safeZone || '',
            compositionSource: spec?.source || '',
            mediaTreatment: spec?.media?.treatment || '',
            themeId: visual.themeId,
            styleName: visual.styleName,
            variant: visual.variant,
            animation: effectiveAnimation,
            speed: effectiveSpeed,
            authoredMotion: authoredMotionFacts
                ? {
                    openSpan: Math.round(authoredMotionFacts.openSpan * 1000) / 1000,
                    beats: authoredMotionFacts.beats,
                    settle: Math.round(authoredMotionFacts.settle * 1000) / 1000,
                    ease: authoredMotionFacts.ease,
                }
                : null,
            motionReason: spec?.motion?.reason || '',
            shadowStrength: visual.shadowStrength,
            text: text.slice(0, 120),
            // `text` is truncated for readability. The reading-speed rule in
            // hf-video-lint needs the REAL length or it measures the truncation
            // instead of the copy. `duration` is the resolved on-screen hold,
            // which is what the timing and reading rules judge.
            textLength: text.length,
            duration: Math.round((timing?.duration || 0) * 100) / 100,
        });
        if (!SUPPORTED_HF_TYPES.has(type)) {
            report.unsupported.push({ type, sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), text: getMgText(mg).slice(0, 120) });
            continue;
        }
        if (type === 'map-chart' && !hasResolvedMgAsset(mg, type, dirs) && !findCountryFeatures(collectMapNames(mg), dirs).length) {
            report.missingMapAssets.push({ sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), text: getMgText(mg).slice(0, 120) });
        }
        if (templateNeedsMedia.has(type) && !hasResolvedMgAsset(mg, type, dirs)) {
            report.missingTemplateMedia.push({ type, sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), text: getMgText(mg).slice(0, 120) });
        }
        if (!text && !subtext && items.length === 0) {
            report.fallbacks.push({ type, sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), reason: 'no display text/items' });
        }
    }
    return report;
}

// Reserved lane floor for graphic background media. Every NON-RESERVED
// data-track-index this file emits is >= -10000 (scene media floors exactly there;
// graphics 500+, audio 30+), so anything below this constant is a private address
// space that no other allocator can reach, at any plan size. The only other
// reserved bands are the caption/transition origins below, and they are deliberately
// parked BELOW every lane this floor can ever produce — see the proof there.
const BG_MEDIA_TRACK_FLOOR = -100000;

// Reserved lane origins for caption cues and overlay transitions — the last two
// SHARED hardcoded lanes this file emitted (26 and 28). Every cue of an entire video
// sat in one lint group and every overlay transition in another, and a group is only
// safe if nothing inside it ever overlaps in time. Both do:
//   - captions: buildCaptionCues() pads any cue shorter than 0.4s UP to 0.4s
//     (Math.max(0.4, end - start)) without moving the NEXT cue's start, and 94.5% of
//     real WhisperX inter-word gaps are exactly 0s, so the pad has nothing to eat
//     into. A real 47-scene plan emitted, from the CLI itself:
//     "Track 26: clip ending at 78.06s overlaps with clip starting at 78.02s".
//   - transitions: an overlay transition is CENTRED on the cut, spanning
//     [B - d/2, B + d/2] with d up to 0.75s, so two collide whenever their boundaries
//     sit closer than (d1 + d2)/2. Cut-at-playhead in the UI deep-clones the scene
//     INCLUDING its transition, reproducing exactly that at cut offsets in [0.2s, d).
// `overlapping_clips_same_track` is severity ERROR and Motion QA hard-fails the render
// on it, so this is a render-blocker, not a cosmetic warning. Restamping the lane is
// the only lever available: moving the clip TIMING would drag captions off the words
// they caption and slide transitions off their cuts, while the lane is pure
// bookkeeping for the CLI's lint/manifest — stacking comes from CSS z-index
// (.hf-transition 80, .hf-caption 60) and DOM order, never from this attribute. One
// private lane PER CLIP makes a same-lane overlap arithmetically unreachable instead
// of merely unlikely, and as a bonus it drops both lanes to a single element each, so
// `timeline_track_too_dense` (WARNING, >3 timed elements per lane; captions are NOT
// exempt — the rule's isCaptionCue() wants a `caption-*` class token and we emit
// `hf-caption`) stops firing on them too.
//
// DISJOINTNESS, by construction rather than by luck:
//   - vs every unreserved emitter here: those are all >= -10000 (scene media is
//     -10000 + base*1000 + n with base,n >= 0; graphics 500|1000 + order; audio 30+).
//     Both bands start below -5e9 and only ever decrease.
//   - vs graphic background media: that band is BG_MEDIA_TRACK_FLOOR minus a graphic
//     WRAPPER track, and the wrapper track is allocateGraphicTrack() = 500|1000 + order
//     where `order` is the index of a JS array (`graphics.forEach((mg, i) => ...)`).
//     ECMAScript caps array length at 2^32-1, so the largest index is 4294967294 and
//     the deepest lane that floor can EVER produce is -100000 - 1000 - 4294967294 =
//     -4295068294. Both origins are below that, so the separation is a language-level
//     guarantee with NO ceiling on plan size — not a "surely nobody has that many"
//     estimate.
//   - vs each other: captions take the EVEN offsets and transitions the ODD ones, so a
//     caption lane is always even and a transition lane always odd, at any count.
//   - within a family: the offset is the map() index, so every lane is distinct.
// TRAP: these MUST stay INTEGERS. The CLI's readTrackValue() silently rewrites a
// NON-integer to lane 0 — dumping the clip into an unrelated overlap group instead of
// erroring, i.e. a silent regression rather than a loud one. That is why the offset is
// the Array.prototype.map index (a non-negative integer by construction) and never
// anything derived from plan data such as a startTime or a JSON-parsed field.
// Magnitude is safe: |origin| < 2^53, and both the lint grouping and the density rule
// key off the RAW attribute STRING, while readTrackValue() parses with Number() +
// Number.isInteger() — no int32 truncation anywhere on this path, and no exponent
// notation (String() only switches to it at |x| >= 1e21).
const CAPTION_TRACK_ORIGIN = -5000000000;
const TRANSITION_TRACK_ORIGIN = -5000000001;

function renderAssetFill(asset, id, start, duration, track, options = {}) {
    if (!asset) return '';
    const bgId = `${id}-bg`;
    // The background gets its OWN reserved lane, NOT `track - 1`. allocateGraphicTrack()
    // hands out CONSECUTIVE integers (base + order), so lane track-1 is literally the
    // PREVIOUS graphic's wrapper lane — and the template preRoll below starts this clip
    // 0.12s EARLIER than its own graphic, reaching back into that neighbour's window.
    // Consecutive stage visuals are normally butt-joined, so that collision is the rule,
    // not the exception: the HyperFrames CLI lint `overlapping_clips_same_track` is an
    // ERROR and Motion QA hard-fails the render on it ("Track 509: clip ending at 133.7s
    // overlaps with clip starting at 133.58s"). Renumbering is free — the lane number is
    // pure bookkeeping for the CLI's lint/manifest; stacking comes from CSS
    // (.hf-bg-media z-index:30 under .hf-mg z-index:40) plus DOM order, never from this
    // attribute. TRAP: it MUST stay an INTEGER — the CLI's readTrackValue() silently
    // rewrites a non-integer to lane 0, which would merge this clip into an unrelated
    // overlap group instead of erroring. Subtracting the (unique) wrapper track keeps
    // one private lane per graphic.
    const trackIndex = BG_MEDIA_TRACK_FLOOR - Math.max(0, Math.floor(Number(track) || 0));
    const preRoll = Math.max(0, Number(options.preRoll || 0));
    const startNum = Number(start) || 0;
    const durationNum = Number(duration) || 0;
    const clipStart = Math.max(0, startNum - preRoll);
    const clipDuration = Math.max(0.05, durationNum + (startNum - clipStart));
    const extraClass = options.template ? ' hf-template-bg-media' : '';
    const markLoaded = `document.getElementById('${id}')?.classList.add('hf-bg-loaded')`;
    const markError = `document.getElementById('${id}')?.classList.add('hf-bg-error')`;
    if (asset.isVideo) {
        return `<video id="${bgId}" class="clip hf-bg-media${extraClass}" data-hf-anim="${bgId}" data-start="${clipStart.toFixed(3)}" data-duration="${clipDuration.toFixed(3)}" data-track-index="${trackIndex}" src="${html(asset.rel)}" muted playsinline preload="auto" onloadeddata="${markLoaded}" oncanplay="${markLoaded}" onerror="${markError}"></video>`;
    }
    return `<img id="${bgId}" class="clip hf-bg-media${extraClass}" data-hf-anim="${bgId}" data-start="${clipStart.toFixed(3)}" data-duration="${clipDuration.toFixed(3)}" data-track-index="${trackIndex}" src="${html(asset.rel)}" alt="" onload="${markLoaded}" onerror="${markError}">`;
}

function renderTemplateFallbackBg(id, type, text) {
    const label = html(String(text || type || 'visual')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96));
    return `
      <div class="hf-template-fallback-bg" aria-hidden="true">
        <div class="hf-template-fallback-field"></div>
        <div class="hf-template-fallback-lines"></div>
        ${label ? `<div class="hf-template-fallback-label">${label}</div>` : ''}
      </div>`;
}

function agenticClasses(spec) {
    if (!spec) return '';
    return [
        'hf-agentic',
        `hf-agentic-role-${classToken(spec.role, 'graphic')}`,
        `hf-agentic-layout-${classToken(spec.layout, 'freeform')}`,
        `hf-agentic-safe-${classToken(spec.safeZone, 'center')}`,
        `hf-agentic-density-${classToken(spec.density, 'standard')}`,
        `hf-agentic-motion-${classToken(spec.motion?.entrance, 'fade-slide')}`,
        `hf-agentic-emphasis-${classToken(spec.motion?.emphasis, 'none')}`,
        `hf-agentic-text-${classToken(spec.textStrategy, 'headline')}`,
        `hf-agentic-media-${classToken(spec.media?.treatment, 'cinematic-background')}`,
        `hf-agentic-source-${classToken(spec.source, 'derived')}`,
    ].join(' ');
}

function buildAgenticItems(items = []) {
    if (!items.length) return '';
    return `<div class="hf-agentic-items">${items.map((item, i) => `
        <div class="hf-agentic-item hf-agentic-item-${classToken(item.kind || 'item', 'item')}" style="--i:${i}">
          ${item.value ? `<span class="hf-agentic-item-value">${html(item.value)}</span>` : ''}
          ${item.label ? `<span class="hf-agentic-item-label">${html(item.label)}</span>` : ''}
          ${item.subtext ? `<span class="hf-agentic-item-subtext">${html(item.subtext)}</span>` : ''}
        </div>`).join('')}</div>`;
}

function _graphicTextStyleRanges(mg) {
    return mg?.textStyleRanges || mg?.mgData?.textStyleRanges || [];
}

function buildStyledTextMarkup(value, mg, options = {}) {
    const source = options.kinetic
        ? String(value == null ? '' : value).split(/\s+/).filter(Boolean).slice(0, 14).join(' ')
        : String(value == null ? '' : value);
    const segments = textStyleSegments(source, _graphicTextStyleRanges(mg));
    if (options.kinetic || options.wordCascade) {
        return segments.map((segment) => (
            String(segment.text).split(/(\s+)/).filter((part) => part !== '').map((part) => {
                if (/^\s+$/.test(part)) return html(part);
                const styled = segment.color
                    ? ` hf-agentic-text-range" data-hf-contrast-lock="manual" data-hf-text-range="${html(part)}" data-hf-text-range-color="${html(segment.color)}" style="--hf-text-range-color:${html(segment.color)}`
                    : '';
                return `<span class="hf-agentic-word${styled}">${html(part)}</span>`;
            }).join('')
        )).join('');
    }
    // data-hf-contrast-lock="manual" is the adaptive-contrast module's own
    // escape hatch, and a coloured range is exactly what it was built for: a
    // colour somebody deliberately chose. Without it the in-page contrast pass
    // paints the theme's text colour over the span with !important, so the
    // Editor Agent's "make those two words red" is correct in the plan,
    // correct in the markup, and invisible on screen. Legibility is not lost —
    // the pass still gives the span the same shadow, stroke and scrim as its
    // neighbours; only the hue is left alone.
    return segments.map((segment) => (
        segment.color
            ? `<span class="hf-agentic-text-range" data-hf-contrast-lock="manual" data-hf-text-range="${html(segment.text)}" data-hf-text-range-color="${html(segment.color)}" style="--hf-text-range-color:${html(segment.color)}">${html(segment.text)}</span>`
            : html(segment.text)
    )).join('');
}

function buildAgenticMarkup({ mg, id, baseAttrs, spec, asset, fallbackMarkup = '', start, duration, track, text, subtext, kicker, type }) {
    const title = displayValue(spec?.title, text, mg?.text, mg?.templateText, mg?.keyword) || 'Motion Graphic';
    const subtitle = displayValue(spec?.subtitle, subtext, mg?.subtext, mg?.templateSubtext) || '';
    // Same LOOK HUMAN gate as templateKicker — the spec/mg fallbacks here
    // must not resurrect a banned category eyebrow on stage visuals.
    const eyebrowBanned = isStageVisual(mg?._hfKind || 'graphic', type) && type !== 'person-intro';
    const eyebrow = eyebrowBanned ? '' : (displayValue(spec?.kicker, kicker, mg?.kicker, mg?.eyebrow) || '');
    const items = Array.isArray(spec?.items) ? spec.items : [];
    const isData = ['data-focus', 'split-panel', 'evidence-board', 'map-explainer'].includes(spec?.layout);
    const meta = spec?.motion?.reason ? `<div class="hf-agentic-reason">${html(spec.motion.reason)}</div>` : '';
    const transparentTemplateBg = mg?._hfKind === 'template' && isTransparentTemplateBackground(mg);
    const bg = transparentTemplateBg ? '' : renderAssetFill(asset, id, start, duration, track, {
        template: mg?._hfKind === 'template',
        preRoll: mg?._hfKind === 'template' ? 0.12 : 0,
    });
    const mediaTreatment = classToken(spec?.media?.treatment, 'cinematic-background');
    // Kinetic text: split the headline into per-word spans so the runtime can
    // stagger them in (real kinetic typography) instead of fading the whole
    // line as one block (which reads as a static headline).
    const isKinetic = type === 'kinetic-text';
    const isTypewriterMotion = (
        type === 'typewriter'
        || cleanName(mg?._hfVisual?.variant || mg?.subType || mg?.variant || '', '') === 'typewriter'
        || cleanName(spec?.motion?.entrance || mg?._hfVisual?.animation || mg?.animation || '', '') === 'typewriter'
    );
    const motionName = cleanName(
        spec?.motion?.entrance || mg?._hfVisual?.animation || mg?.animation || '',
        ''
    ).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const isWordCascadeMotion = motionName === 'wordcascade';
    const titleInner = buildStyledTextMarkup(title, mg, {
        kinetic: isKinetic,
        wordCascade: isWordCascadeMotion,
    });
    const titleClass = isKinetic
        ? 'hf-agentic-title hf-agentic-kinetic'
        : (
            isWordCascadeMotion
                ? 'hf-agentic-title hf-agentic-word-cascade'
                : (
                    isTypewriterMotion
                        ? 'hf-agentic-title hf-agentic-typewriter'
                        : 'hf-agentic-title hf-agentic-part'
                )
        );
    return `
    ${bg}
    <div ${baseAttrs} data-hf-composition="agentic" data-hf-layout="${html(spec.layout)}" data-hf-safe-zone="${html(spec.safeZone)}" data-hf-media-treatment="${html(mediaTreatment)}" data-hf-text-strategy="${html(spec?.textStrategy || '')}" data-hf-motion-emphasis="${html(spec?.motion?.emphasis || '')}" data-hf-motion-exit="${html(spec?.motion?.exit || '')}" data-hf-composition-source="${html(spec?.source || '')}">
      ${fallbackMarkup || ''}
      <div class="hf-agentic-shade hf-agentic-media-${mediaTreatment}"></div>
      <div class="hf-agentic-stage">
        <div class="hf-agentic-rule"></div>
        <div class="hf-agentic-copy hf-shell-target">
          ${eyebrow ? `<div class="hf-agentic-kicker hf-agentic-part">${html(eyebrow)}</div>` : ''}
          <div class="${titleClass}">${titleInner}</div>
          ${subtitle ? `<div class="hf-agentic-subtitle hf-agentic-part">${html(subtitle)}</div>` : ''}
          ${isData ? buildAgenticItems(items) : ''}
          ${meta}
        </div>
        ${!isData ? buildAgenticItems(items) : ''}
      </div>
    </div>`;
}

function getAgenticCompositionSpec(mg, context = {}) {
    if (!normalizeAgenticCompositionSpec) return null;
    return normalizeAgenticCompositionSpec(mg, {
        kind: context.kind || mg?._hfKind || 'graphic',
        type: context.type || resolveVisualType(mg, context.kind || mg?._hfKind || 'graphic'),
        visual: context.visual || mg?._hfVisual || {},
        text: context.text ?? getMgText(mg),
        subtext: context.subtext ?? getMgSubtext(mg),
        items: context.items || itemsFromMg(mg, context.text ?? getMgText(mg), context.subtext ?? getMgSubtext(mg)),
        kicker: context.kicker ?? templateKicker(context.type || resolveVisualType(mg, context.kind || mg?._hfKind || 'graphic'), mg),
        hasAsset: Boolean(context.hasAsset),
    });
}

function allocateGraphicTrack(isFull, order = 0) {
    const index = Number.isFinite(Number(order)) ? Math.max(0, Math.floor(Number(order))) : 0;
    // Stage visuals replace the footage, while overlay graphics must remain
    // visible above that stage (templateHint + mgHint is a supported lane).
    // The old ordering put overlays below fullscreen/template tracks, silently
    // hiding lower thirds and callouts whenever both occupied the same scene.
    const base = isFull ? 500 : 1000;
    return base + index;
}

function buildMgMarkup(mg, id, kind, dirs, mediaDir, assetCache, visual = null, order = 0) {
    const type = resolveVisualType(mg, kind || 'graphic');
    const resolvedVisual = visual || mg?._hfVisual || resolveHyperframeVisual(mg, kind || 'graphic', type, {});
    const text = getMgText(mg);
    const subtext = getMgSubtext(mg);
    const items = itemsFromMg(mg, text, subtext);
    const variant = cleanName(resolvedVisual.variant || 'standard', 'standard');
    const variantClass = classToken(variant, 'standard');
    const styleClass = classToken(resolvedVisual.styleName || 'clean', 'clean');
    const themeClass = classToken(resolvedVisual.themeId || 'standard', 'standard');
    const cardClass = classToken(resolvedVisual.cardStyle || 'filled', 'filled');
    const position = mg?.position || 'center';
    const isTemplateKind = kind === 'template';
    const isFull = isStageVisual(kind, type);
    const timing = mg?._hfTiming || getVisualTiming(mg, kind, type);
    const start = timing.start.toFixed(3);
    const duration = timing.duration.toFixed(3);
    const track = allocateGraphicTrack(isFull, order);
    // Overlay MGs float text/graphics over the live scene footage — they must NOT
    // render their own full-frame background media. Doing so re-draws (often the
    // scene's own) footage on a separate layer that scales/fades on enter+exit,
    // producing the visible "distortion" glitch over the clip. Only stage visuals
    // (fullscreen / template / map) fill with media.
    const transparentTemplateBg = isTemplateKind && isTransparentTemplateBackground(mg);
    const asset = isFull && !transparentTemplateBg ? copyMgAsset(mg, type, dirs, mediaDir, assetCache, id) : null;
    const kicker = templateKicker(type, mg);
    const rawAgenticSpec = getAgenticCompositionSpec(mg, {
        kind: kind || 'graphic',
        type,
        visual: resolvedVisual,
        text,
        subtext,
        items,
        kicker,
        hasAsset: Boolean(asset),
    });
    const agenticSpec = applyGraphicMediaPolicy(rawAgenticSpec, {
        role: kind || 'graphic',
        type,
        fallback: isFull && asset ? 'cinematic-background' : 'transparent',
    });
    const safeLayout = safeLayoutRequested(mg);
    const motion = rendererMotion(mg, type, resolvedVisual, agenticSpec);
    const useAgenticRenderer = Boolean(motion.useAgenticRenderer && !safeLayout);
    const componentOwnsLayout = Boolean(
        safeLayout
        || useAgenticRenderer
        || isFull
        || typeUsesDedicatedRenderer(type)
    );
    // Same answer the visual report used, from the same helper — see
    // authoredRenderPlan. The bookkeeping and the operator warning stay here,
    // because only the renderer is entitled to have side effects.
    const {
        authored,
        assets: authoredAssets,
        ns: authoredNs,
        duration: authoredDuration,
        validation: authoredValidation,
        willRender: authoredCompositionWillRender,
    } = authoredRenderPlan(mg, { type, kind, timing });
    if (authoredValidation && !authoredValidation.ok) {
        mg._authoredRendered = false;
        delete mg._hfAuthoredTimeline;
        console.warn(
            `  ⚠️ [HyperFrames] authored comp ${authoredNs} rejected at render safety gate: `
            + authoredValidation.errors.slice(0, 2).join(' | ')
        );
    }
    const storedShell = (
        mg?.graphicShell
        || mg?.mgData?.graphicShell
        || mg?.agenticComposition?.shell
        || mg?.mgData?.agenticComposition?.shell
        || null
    );
    const shellEnabled = Boolean(
        !safeLayout
        &&
        typeSupportsGraphicShell(type, useAgenticRenderer)
        && !authoredCompositionWillRender
        && mg?.graphicShell !== false
        && mg?.mgData?.graphicShell !== false
        && (kind === 'overlay' || storedShell)
    );
    const shellContext = {
        id: mg?.id || mg?.clipId || id,
        role: kind,
        type,
        text,
        subtext,
        items,
        density: agenticSpec?.density,
        textStrategy: agenticSpec?.textStrategy,
        safeZone: agenticSpec?.safeZone || position,
        layout: agenticSpec?.layout,
        mood: `${agenticSpec?.style?.mood || ''} ${agenticSpec?.motion?.reason || ''}`,
        manual: mg?.graphicShellManual === true || mg?.mgData?.graphicShellManual === true,
        transparentBackground: Boolean(
            mg?.transparentBackground === true
            || mg?.mgData?.transparentBackground === true
            || resolvedVisual?.cardStyle === 'transparent'
            || transparentTemplateBg
        ),
        accentRuleVisible: resolvedVisual?.accentRuleVisible !== false,
    };
    const shellData = shellEnabled
        ? graphicShellData(
            agenticSpec?.shell || mg?.graphicShell || mg?.mgData?.graphicShell,
            shellContext
        )
        : null;
    mg._hfResolvedGraphicShell = shellData?.shell || null;
    mg._hfGraphicShellApplied = Boolean(shellData);
    const effectiveAnimation = motion.animation;
    const effectiveSpeed = motion.speed;
    const animationClass = classToken(effectiveAnimation, 'fadeSlide');
    const extra = `${isTemplateKind ? ' hf-template' : ''}${isFull ? ' hf-fullscreen' : ''}${transparentTemplateBg ? ' hf-transparent-bg' : ''}${asset ? ' hf-has-bg' : ' hf-no-bg'}${resolvedVisual.accentRuleVisible === false ? ' hf-no-accent-rule' : ''}${componentOwnsLayout ? ' hf-component-layout-owned' : ''}${safeLayout ? ' hf-safe-layout' : ''}${agenticSpec?.density ? ` hf-layout-density-${classToken(agenticSpec.density, 'standard')}` : ''}${useAgenticRenderer ? ` ${agenticClasses(agenticSpec)}` : ''}${shellData ? ` ${graphicShellClassNames(shellData.shell, shellContext)}` : ''}`;
    const adaptiveContrast = adaptiveContrastEnabled(mg, kind || 'graphic');
    const contrastTone = contrastToneForGraphic({
        mg,
        kind,
        asset,
        transparentTemplateBg,
        visual: resolvedVisual,
    });
    const textColorExplicit = hasExplicitGraphicTextColor(mg);
    const toneVisual = textColorExplicit
        ? resolvedVisual
        : {
            ...resolvedVisual,
            colors: {
                ...resolvedVisual.colors,
                text: contrastTone === 'dark' ? '#11100e' : '#fffaf2',
                textMuted: contrastTone === 'dark'
                    ? 'rgba(17,16,14,0.78)'
                    : 'rgba(255,250,242,0.82)',
            },
        };
    const requestedProtection = contrastProtectionMode(mg);
    const protectionMode = requestedProtection || (
        contrastTone === 'light'
        && (
            asset
            || transparentTemplateBg
            || mg?.transparentBackground === true
            || mg?.mgData?.transparentBackground === true
            || resolvedVisual.cardStyle === 'transparent'
            || ['none', 'outline', 'transparent'].includes(String(
                mg?._hfResolvedGraphicShell?.surface || ''
            ).toLowerCase())
        )
            ? 'guarded'
            : ''
    );
    mg._hfContrastTone = contrastTone;
    mg._hfContrastProtection = protectionMode;
    const adaptiveAttrs = adaptiveContrast
        ? ` data-hf-adaptive-contrast="1" data-hf-text-explicit="${textColorExplicit ? '1' : '0'}" data-hf-contrast-tone="${contrastTone}" data-hf-contrast-force="${protectionMode}"`
        : '';
    const shellAttrs = shellData ? ` ${shellData.attrs}` : '';
    const wrapperOwnsTiming = !(asset?.isVideo && !authoredCompositionWillRender);
    const timingAttrs = wrapperOwnsTiming
        ? `data-start="${start}" data-duration="${duration}" data-track-index="${track}"`
        : `data-hf-start="${start}" data-hf-duration="${duration}"`;
    const baseAttrs = `id="${id}" ${timingAttrs} class="${wrapperOwnsTiming ? 'clip ' : ''}hf-mg hf-type-${classToken(type, 'graphic')}${extra} hf-theme-${themeClass} hf-style-${styleClass} hf-card-${cardClass} hf-variant-${variantClass} hf-anim-${animationClass} pos-${classToken(position, 'center')}" data-hf-anim="${id}" data-hf-type="${html(type)}" data-hf-style="${html(resolvedVisual.styleName)}" data-hf-theme="${html(resolvedVisual.themeId)}" data-hf-variant="${html(variant)}" data-hf-animation="${html(effectiveAnimation)}" data-hf-speed="${effectiveSpeed}"${adaptiveAttrs}${shellAttrs} style="${html(hyperframeStyleVars({ ...toneVisual, speed: effectiveSpeed }))}"`;

    if (safeLayout) {
        mg._authoredRendered = false;
        return buildSafeLayoutMarkup({
            mg,
            baseAttrs,
            asset,
            id,
            start,
            duration,
            track,
            kind,
            type,
            text,
            subtext,
            items,
        });
    }

    // ── Agent-authored composition path (composition-author worker) ──
    // HIGHEST-priority renderer: any MG (template, fullscreen, overlay) that
    // carries a validated `_authoredComposition` renders the agent's bespoke
    // html/css and feeds its GSAP fragment into the master timeline. This
    // MUST come before the agentic-spec early return — overlay types take
    // that path and were silently losing their authored comps.
    const authoredOverlay = kind === 'overlay';
    if (
        authored
        && authored.html
        && authored.timeline
        && (!authoredNs || authoredValidation?.ok)
        && (isFull || authoredOverlay)
    ) {
        // v9 asset pipe: the author wrote __HF_ASSET_i__ tokens; substitute
        // the real copied media paths. A used token that can't resolve means
        // the comp was designed around a missing photo — fall through to the
        // fixed renderer instead of shipping a broken-image frame.
        let aHtml = authored.html;
        let aCss = authored.css || '';
        let assetsOk = true;
        authoredAssets.forEach((a, i) => {
            if (!assetsOk || !a) return;
            const token = a.token || `__HF_ASSET_${i}__`;
            if (!aHtml.includes(token) && !aCss.includes(token)) return; // author didn't use it
            const found = resolveMaybeFile(a.path || a, dirs);
            const rel = found ? copyAsset(found, mediaDir, `${id}-auth${i}-${path.basename(found, path.extname(found))}`, assetCache, {}) : null;
            if (!rel) { assetsOk = false; return; }
            aHtml = aHtml.split(token).join(rel);
            aCss = aCss.split(token).join(rel);
        });
        if (assetsOk) {
            // ── Author-owned film finish ──
            // The Composition Author prescribed this scene's cinematic FX (grain/leak/
            // grade/era look) in the SAME creative act as the layout + motion. Realize it
            // from the hf-effects registry here: the grade filter rides an #id CSS rule
            // (no layout impact), the texture/light layers append as overlays, and the FX
            // GSAP fragment joins the authored timeline (relative offset=0 → it rides the
            // same `__master.add(tl, offset)` injection). Fullscreen comps only — overlay
            // comps annotate live footage that already carries the footage director's grade.
            let fxHtml = '';
            let authoredTimeline = normalizeAuthoredTimeline(authored.timeline, authoredDuration);
            if (isFull && Array.isArray(authored.effects) && authored.effects.length && hfEffects && typeof hfEffects.buildSceneEffects === 'function') {
                try {
                    const fx = hfEffects.buildSceneEffects({ _effectRecipe: authored.effects }, id, 0, Math.max(1, authoredDuration), { framed: false });
                    if (fx) {
                        if (fx.filter) aCss += `\n#${id}{filter:${fx.filter};}`;
                        if (fx.html) fxHtml = fx.html;
                        if (fx.timelineJS) authoredTimeline = `${authored.timeline}\n${fx.timelineJS}`;
                    }
                } catch (_) { /* FX are optional polish — never break a validated composition */ }
            }
            mg._hfAuthoredTimeline = authoredTimeline;
            mg._hfAuthoredOffset = timing.start;
            mg._hfAuthoredSourceOffset = timing.sourceOffset || 0;
            mg._hfAuthoredVisibleDuration = timing.duration;
            mg._hfAuthoredSourceDuration = authoredDuration;
            mg._authoredRendered = true;
            const authoredMediaTreatment = classToken(agenticSpec?.media?.treatment, 'transparent');
            const authoredFrameShade = (
                authoredOverlay
                && overlayAllowsFrameTreatment({ role: kind, type })
                && authoredMediaTreatment !== 'transparent'
            )
                ? `<div class="hf-agentic-shade hf-agentic-media-${authoredMediaTreatment}" data-hf-frame-focus="1"></div>`
                : '';
            // Authored comps are designed on the full 1920×1080 canvas — the
            // hf-authored-overlay class breaks the container out of the
            // positioned pos-* boxes overlay MGs normally live in.
            return `
    <div ${baseAttrs}${authoredOverlay ? ' data-hf-authored-overlay="1"' : ''} data-hf-composition="authored">
      <style>${aCss}</style>
      ${authoredFrameShade}
      ${aHtml}
      ${fxHtml}
    </div>`;
        }
        console.log(`  ⚠️ [HyperFrames] authored comp ${mg._authoredNs || id} dropped — referenced asset missing; using fixed renderer`);
    }

    if (useAgenticRenderer) {
        const fallbackMarkup = type === 'map-chart' ? `<div class="hf-map-backup">${buildFallbackMap(mapLabelsFromMg(mg), mg, dirs)}</div>` : '';
        return buildAgenticMarkup({ mg, id, baseAttrs, spec: agenticSpec, asset, fallbackMarkup, start, duration, track, text, subtext, kicker, type });
    }

    if (type === 'map-chart') {
        // ── Map builder path (map-hf-builder): real basemap + projected OSM
        // border SVG + GSAP camera. The animated-map system — legacy static
        // markup below survives only as the graceful-degradation floor when
        // the MapScene/renderAssets are missing or the builder is disabled.
        const mapBuilderOff = /^(0|false|off|no)$/i.test(String(process.env.HF_MAP_BUILDER || '').trim());
        const mapScene = mg._mapScene || mg.mgData?._mapScene || null;
        const mapRa = mapScene && mapScene.renderAssets;
        if (mapHfBuilder && !mapBuilderOff && mapRa && mapRa.mapView) {
            let basemapRel = '';
            const baseAbs = resolveMaybeFile(mapRa.mapImageFile, dirs);
            if (baseAbs) basemapRel = copyAsset(baseAbs, mediaDir, `${id}-basemap`, assetCache) || '';
            const built = mapHfBuilder.buildMapHF(mapScene, {
                id,
                duration: timing.sourceDuration || timing.duration,
                style: mg.mapStyle || mapScene.mapStyle || THEME_DEFAULT_MAP_STYLE[resolvedVisual.themeId] || 'satellite',
                basemapRel,
            });
            if (built && built.ok) {
                // Collected by buildComposition after the graphics loop and
                // injected into the page's GSAP timeline at the MG's offset.
                mg._hfMapAnim = built.anim;
                mg._hfMapOffset = timing.start;
                mg._hfMapSourceOffset = timing.sourceOffset || 0;
                mg._hfMapVisibleDuration = timing.duration;
                mg._hfMapSourceDuration = timing.sourceDuration || timing.duration;
                return `
    <div ${baseAttrs}>
      ${built.html}
      <div class="hf-map-vignette"></div>
    </div>`;
            }
            console.warn(`[HyperFrames] map builder failed for ${id} — falling back to static map markup`);
        }
        const labels = mapLabelsFromMg(mg);
        const labelChips = labels.map(label => `<span>${html(label)}</span>`).join('');
        return `
    ${renderAssetFill(asset, id, start, duration, track, { template: isTemplateKind, preRoll: isTemplateKind ? 0.12 : 0 })}
    <div ${baseAttrs}>
      <div class="hf-map-backup">${buildFallbackMap(labels, mg, dirs)}</div>
      <div class="hf-map-vignette"></div>
      ${labelChips ? `<div class="hf-map-labels">${labelChips}</div>` : ''}
      ${(text || subtext) ? `<div class="hf-map-caption hf-shell-target">${buildTitleBits(text, subtext)}</div>` : ''}
    </div>`;
    }

    if (type === 'bar-chart') {
        const bars = items.length ? items : parseItemsFromText(subtext || text).slice(0, 6);
        return `
    <div ${baseAttrs}>
      <div class="hf-data-stage">
        <div class="hf-data-header hf-shell-target">${buildTitleBits(text, subtext)}</div>
        <div class="hf-bar-chart">${bars.slice(0, 6).map((item, i) => {
            const raw = parseFloat(String(item.value || '').replace(/[^\d.-]/g, ''));
            const width = Number.isFinite(raw) ? Math.max(18, Math.min(100, raw)) : (92 - i * 11);
            return `<div class="hf-bar-row" style="--w:${width}%; --i:${i}"><span>${html(item.label)}</span><b>${html(item.value)}</b><i></i></div>`;
        }).join('')}</div>
      </div>
    </div>`;
    }

    if (type === 'donut-chart') {
        const first = items[0] || splitStatText(text);
        const value = parseFloat(String(first.value || first.label || '').replace(/[^\d.-]/g, ''));
        const pct = Number.isFinite(value) ? Math.max(5, Math.min(96, value)) : 67;
        return `
    <div ${baseAttrs}>
      <div class="hf-donut-stage">
        <div class="hf-donut" style="--pct:${pct}"><span>${html(first.value || `${pct}%`)}</span></div>
        <div class="hf-donut-copy hf-shell-target">${buildTitleBits(text, subtext)}</div>
      </div>
    </div>`;
    }

    if (type === 'ranking-list' || type === 'bullet-list' || type === 'timeline') {
        const list = items.length ? items : parseItemsFromText(subtext || text).slice(0, 7);
        return `
    <div ${baseAttrs}>
      <div class="hf-list-stage hf-list-${type}">
        <div class="hf-list-header hf-shell-target">${buildTitleBits(text, subtext)}</div>
        ${renderItemList(list.length ? list : [{ label: text, value: '01' }], type === 'timeline' ? 'hf-timeline-items' : 'hf-ranked-items')}
      </div>
    </div>`;
    }

    if (type === 'stat-counter') {
        const stat = splitStatText(text);
        return `
    <div ${baseAttrs}>
      <div class="hf-stat-card hf-shell-target">
        <div class="hf-stat-value">${html(stat.value)}</div>
        ${stat.label ? `<div class="hf-stat-label">${html(stat.label)}</div>` : ''}
        ${subtext ? `<div class="hf-subtitle">${html(subtext)}</div>` : ''}
      </div>
    </div>`;
    }

    if (type === 'comparison-card') {
        const comparison = comparisonContent(mg, text, subtext, items);
        return `
    <div ${baseAttrs}>
      <div class="hf-comparison-stage">
        <div class="hf-comparison-wrap hf-shell-target" data-hf-layout-probe="comparison-grid" data-hf-layout-strict="1">
          <div class="hf-compare-side" data-hf-layout-critical="1" data-hf-layout-collision="1">${html(comparison.left)}</div>
          <div class="hf-compare-vs" data-hf-layout-critical="1" data-hf-layout-collision="1">VS</div>
          <div class="hf-compare-side" data-hf-layout-critical="1" data-hf-layout-collision="1">${html(comparison.right)}</div>
        </div>
        ${comparison.note ? `<div class="hf-comparison-note" data-hf-layout-critical="1" data-hf-layout-collision="1">${html(comparison.note)}</div>` : ''}
      </div>
    </div>`;
    }

    if (type === 'listicle-grid') {
        const gridItems = items.length ? items : parseItemsFromText(subtext || text);
        return `
    <div ${baseAttrs}>
      <div class="hf-grid-stage">
        <div class="hf-grid-title hf-shell-target">${buildTitleBits(text, subtext, { kicker })}</div>
        ${renderItemList(gridItems.slice(0, 8), 'hf-listicle-grid-items')}
      </div>
    </div>`;
    }

    if (type === 'chapter-card' || type === 'title-card') {
        return `
    ${renderAssetFill(asset, id, start, duration, track, { template: isTemplateKind, preRoll: isTemplateKind ? 0.12 : 0 })}
    <div ${baseAttrs}>
      ${asset || transparentTemplateBg ? '' : renderTemplateFallbackBg(id, type, text || subtext)}
      <div class="hf-template-shade"></div>
      <div class="hf-chapter-rule"></div>
      <div class="hf-chapter-copy hf-shell-target">${buildTitleBits(text, subtext, { kicker })}</div>
    </div>`;
    }

    if (['image-showcase', 'split-screen', 'infographic', 'person-intro', 'location-card', 'quote-card', 'key-takeaway', 'timeline-card', 'fact-card', 'stat-card'].includes(type)) {
        const itemDrivenTemplate = ['image-showcase', 'split-screen', 'infographic', 'timeline-card', 'fact-card', 'stat-card'].includes(type);
        const list = items.length
            ? items
            : (itemDrivenTemplate ? parseItemsFromText(subtext || text).slice(0, 6) : []);
        const stage = type.replace(/-card$/, '').replace(/-/g, '-');
        const singleStatSummary = type === 'stat-card' && list.length === 1
            ? `${list[0].value || ''} ${list[0].label || ''} ${list[0].subtext || ''}`.trim()
            : '';
        const titleText = singleStatSummary && semanticallyRepeatsDisplay(text, singleStatSummary)
            ? ''
            : text;
        return `
    ${renderAssetFill(asset, id, start, duration, track, { template: isTemplateKind, preRoll: isTemplateKind ? 0.12 : 0 })}
    <div ${baseAttrs}>
      ${asset || transparentTemplateBg ? '' : renderTemplateFallbackBg(id, type, text || subtext)}
      <div class="hf-template-shade"></div>
      <div class="hf-template-stage hf-template-stage-${stage}">
        ${type === 'person-intro' && kicker ? `<div class="hf-person-label">${html(kicker)}</div>` : ''}
        <div class="hf-template-copy hf-shell-target">${buildTitleBits(titleText, subtext, { kicker: type === 'person-intro' ? '' : kicker })}</div>
        ${list.length ? renderItemList(list, 'hf-template-items') : ''}
      </div>
    </div>`;
    }

    if (type === 'typewriter') {
        const lines = String(text || '').split(/\s+/).filter(Boolean).slice(0, 10);
        return `
    <div ${baseAttrs}>
      <div class="hf-shell-target">
        <div class="hf-typewriter-line">${lines.map(word => `<span>${html(word)}</span>`).join(' ')}</div>
        ${subtext ? `<div class="hf-subtitle">${html(subtext)}</div>` : ''}
      </div>
    </div>`;
    }

    if (type === 'kinetic-text') {
        const words = String(text || '').split(/\s+/).filter(Boolean).slice(0, 12);
        return `
    <div ${baseAttrs}>
      <div class="hf-shell-target"><div class="hf-kinetic-line">${words.map(word => `<span>${html(word)}</span>`).join(' ')}</div></div>
    </div>`;
    }

    if (type === 'progress-bar' || type === 'progress-tracker') {
        const pct = Math.max(5, Math.min(100, toSeconds(mg?.percent ?? mg?.progress, 72)));
        return `
    <div ${baseAttrs}>
      <div class="hf-progress-shell hf-shell-target">${buildTitleBits(text, subtext)}<div class="hf-progress-rail"><span style="--pct:${pct}%"></span></div></div>
    </div>`;
    }

    if (type === 'listicle-counter') {
        const number = displayValue(mg?.number, mg?.rank, mg?.value) || '01';
        return `
    <div ${baseAttrs}>
      <div class="hf-listicle-counter-badge hf-shell-target"><span>${html(number)}</span><b>${html(text)}</b></div>
    </div>`;
    }

    return `
    <div ${baseAttrs}>
      <div class="hf-copy-shell hf-shell-target">${buildTitleBits(text || subtext || type, text ? subtext : '')}</div>
    </div>`;
}

const TRANSITION_PALETTE = ['crossfade', 'wipe-left', 'zoom-blur', 'light-leak', 'push-left', 'glitch', 'luma-fade', 'dip-black'];

// Scene-MOTION transitions animate the actual outgoing/incoming footage
// containers (push, wipe, whip-pan, zoom-through, blur-dissolve). Overlay
// transitions keep the slab/flare element swept over the cut.
const MOTION_TRANSITION_TYPES = new Set([
    'push-left', 'push-right', 'push-up',
    'wipe-left', 'wipe-right', 'wipe-up',
    'whip-left', 'whip-right',
    'zoom-punch', 'zoom-pull', 'blur-dissolve', 'spin-settle',
]);
// New themes pick a matching basemap look unless the user/scene chose one.
const THEME_DEFAULT_MAP_STYLE = { 'warm-editorial': 'light', nature: 'natural', luxury: 'dark' };
const OVERLAY_TRANSITION_TYPES = new Set(['flash-white', 'dip-black', 'light-sweep', 'glitch', 'fire-burn', 'lens-flare']);

function canonicalTransitionType(value) {
    const raw = normalizeType(value, '');
    // Hard cuts / "none" must produce NO transition overlay — they are instant.
    // (Bug fix: previously 'cut' fell through to the default crossfade slab +
    // white flare, flashing a dark dip on every hard cut.)
    if (!raw || ['auto', 'random', 'transition', 'cut', 'none', 'hard', 'hard-cut', 'hardcut', 'straight-cut'].includes(raw)) return '';
    // Already-canonical names pass straight through.
    if (MOTION_TRANSITION_TYPES.has(raw) || OVERLAY_TRANSITION_TYPES.has(raw) || raw === 'crossfade') return raw;
    // Legacy pipeline names (panLeft, slideUp, whipPan, fade_to_black,
    // lightLeak, …) map onto the canonical vocabulary, PRESERVING the
    // direction instead of flattening everything to *-left.
    const dir = raw.includes('right') ? 'right' : (raw.includes('up') || raw.includes('down')) ? 'up' : 'left';
    if (raw.includes('whip')) return `whip-${dir === 'up' ? 'left' : dir}`;
    if (raw.includes('wipe') || raw.includes('swipe') || raw.includes('slide')) return `wipe-${dir}`;
    if (raw.includes('push') || raw.includes('pan')) return `push-${dir}`;
    if (raw.includes('zoom')) return (raw.includes('out') || raw.includes('pull')) ? 'zoom-pull' : 'zoom-punch';
    if (raw.includes('spin') || raw.includes('rotate') || raw.includes('roll')) return 'spin-settle';
    if (raw.includes('blur') || raw.includes('luma')) return 'blur-dissolve';
    if (raw.includes('glitch') || raw.includes('rgb') || raw.includes('digital')) return 'glitch';
    // Anamorphic lens streak — check BEFORE 'flare' (lens-flare contains "flare").
    if (raw.includes('lens') || raw.includes('anamorphic') || raw.includes('streak')) return 'lens-flare';
    // Fire / film-burn — check BEFORE 'light'/'leak' so warm fiery names land here.
    if (raw.includes('fire') || raw.includes('flame') || raw.includes('burn') || raw.includes('ember')) return 'fire-burn';
    if (raw.includes('light') || raw.includes('leak') || raw.includes('flare')) return 'light-sweep';
    if (raw.includes('flash') || raw.includes('white')) return 'flash-white';
    if (raw.includes('black') || raw.includes('dip')) return 'dip-black';
    if (raw.includes('shape') || raw.includes('circle') || raw.includes('iris') || raw.includes('diamond') || raw.includes('blind') || raw.includes('rect') || raw.includes('stripe')) return 'wipe-left';
    if (raw.includes('camera') || raw.includes('shake')) return 'whip-left';
    // Soft, shapeless legacy names (morph/ripple/dream/ink/reveal/warp) become a
    // blur-dissolve — a real soft move — instead of falling through to a dead slab.
    if (raw.includes('morph') || raw.includes('ripple') || raw.includes('dream') || raw.includes('ink') || raw.includes('warp') || raw.includes('reveal')) return 'blur-dissolve';
    if (raw.includes('fade') || raw.includes('cross') || raw.includes('dissolve')) return 'crossfade';
    // Unknown / legacy name with no implemented move → clean crossfade (which
    // collectTransitionOverlays skips) rather than a background-less overlay
    // slab that consumes the boundary while flashing nothing.
    return 'crossfade';
}

function transitionTypeName(value) {
    // Return '' (no overlay) when there is no real visible transition. Do NOT
    // invent one from the palette — that put a slab/flare on plain cuts.
    return canonicalTransitionType(value);
}

function collectTransitionOverlays(sceneAnims, plan) {
    const planTransitions = Array.isArray(plan?.transitions) ? plan.transitions : [];
    const overlays = [];
    // i=0 included: when the video OPENS with graphics/maps, the first
    // footage scene still has a real boundary (e.g. at 26.9s) — the old
    // i=1 start silently dropped its transition.
    for (let i = 0; i < sceneAnims.length; i++) {
        const scene = sceneAnims[i];
        const boundary = toSeconds(scene.start, 0);
        if (boundary <= 0.05) continue;
        // Talking-head hold: a continuation beat inside a presenter span must NOT get a
        // visible transition — it's the same held image, so a plain cut is invisible while
        // any slide/wipe would flicker between identical frames. Force a cut (no item).
        if (scene._presenterContinuation) continue;
        const explicit = planTransitions.find(t => Math.abs(toSeconds(t?.startTime ?? t?.at, -9999) - boundary) < 0.75);
        // scene.transition is an object { type, duration } in the saved plan — pull
        // its .type out (older code passed the whole object to normalizeType and got
        // nothing, silently dropping every transition).
        const sceneTx = (scene.transition && typeof scene.transition === 'object') ? scene.transition : null;
        const rawType = explicit?.type || scene.transitionIn || (sceneTx ? sceneTx.type : scene.transition) || scene.transitionType;
        const type = transitionTypeName(rawType);
        // Only real transitions produce an item. Cuts ('' type) and plain
        // dissolves (crossfade) need none — the per-scene opacity fades
        // already cross-dissolve them. This is what removes the dark-dip +
        // white flash that appeared between scenes on hard cuts.
        if (!type || type === 'crossfade') continue;
        const duration = Math.min(0.75, Math.max(0.34, toSeconds(explicit?.duration ?? (sceneTx ? sceneTx.duration : undefined), 0.46)));
        // Scene-motion transitions animate the actual footage containers.
        // They need the outgoing scene to be ADJACENT (no template/map gap
        // between) — otherwise the stage-visual takeover owns the boundary
        // and we soften to incoming-only motion.
        if (MOTION_TRANSITION_TYPES.has(type)) {
            const prev = sceneAnims[i - 1];
            const prevEnd = prev ? toSeconds(prev.start, 0) + toSeconds(prev.duration, 0) : -1;
            const adjacent = prev && Math.abs(prevEnd - boundary) < 0.35;
            overlays.push({
                id: `tx-${i}-${type}`,
                start: Math.max(0, boundary - duration * 0.5),
                duration, type, mode: 'motion',
                outId: adjacent ? prev.id : null,
                inId: scene.id,
                boundary,
            });
            continue;
        }
        overlays.push({ id: `tx-${i}-${type}`, start: Math.max(0, boundary - duration * 0.5), duration, type, mode: 'overlay' });
    }
    return overlays;
}

function collectGraphics(plan) {
    const graphics = [];
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
    (plan.motionGraphics || []).forEach((mg, sourceIndex) => {
        if (!mg || mg.disabled) return;
        graphics.push({
            ...mg,
            _hfOwnerScene: findOwnerSceneForGraphic(scenes, mg),
            _hfKind: 'overlay',
            _hfSourceGroup: 'motionGraphics',
            _hfSourceIndex: sourceIndex,
        });
    });
    (plan.mgScenes || []).forEach((mg, sourceIndex) => {
        if (!mg || mg.disabled) return;
        graphics.push({
            ...mg,
            type: mg.type || mg.mgType || 'fullscreenMG',
            text: getMgText(mg) || mg.sceneText || '',
            subtext: getMgSubtext(mg) || '',
            _hfOwnerScene: findOwnerSceneForGraphic(scenes, mg),
            _hfKind: 'fullscreen',
            _hfSourceGroup: 'mgScenes',
            _hfSourceIndex: sourceIndex,
        });
    });
    (plan.templateScenes || []).forEach((mg, sourceIndex) => {
        if (!mg || mg.disabled) return;
        graphics.push({
            ...mg,
            type: resolveVisualType(mg, 'template'),
            text: getMgText(mg) || mg.templateText || mg.templateHint || mg.sceneText || '',
            subtext: getMgSubtext(mg) || mg.templateSubtext || '',
            _hfOwnerScene: findOwnerSceneForGraphic(scenes, mg),
            _hfKind: 'template',
            _hfSourceGroup: 'templateScenes',
            _hfSourceIndex: sourceIndex,
        });
    });
    return graphics.sort((a, b) => toSeconds(a.startTime, 0) - toSeconds(b.startTime, 0));
}

function clamp01(n) { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }

// ── Local font embedding ──
// The render browser has no network fonts: without @font-face every theme
// font (Oswald, Barlow Condensed, Fjalla One…) silently falls back to a
// generic face — final videos shipped with wrong typography (renderer lint:
// font_family_without_font_face). Copy assets/fonts/* into media/fonts and
// emit @font-face for each. Family name derives from the CamelCase filename
// ("BarlowCondensed-700.woff2" → "Barlow Condensed", weight 700).
function buildFontFaces(dirs, mediaDir, plan) {
    try {
        const srcDir = path.join(dirs.appRoot || process.cwd(), 'assets', 'fonts');
        if (!fs.existsSync(srcDir)) return '';
        const outDir = path.join(mediaDir, 'fonts');
        ensureDir(outDir);
        const SPECIAL = { NotoSansKR: 'Noto Sans KR', BlackHanSans: 'Black Han Sans' };

        // Some faces exist only to serve one language — today the two Korean CJK fonts, which
        // are 10.2 MB of the 10.7 MB in assets/fonts. Every capture worker uploads and parses
        // them at session start, so an English render pays for glyphs nothing can reference.
        // Derived from the language registry rather than a filename list, so a new language
        // stays correct automatically. Quotes are stripped because languages.js stores
        // CSS-ready values ('"Noto Sans KR"') while the family names below are bare — comparing
        // them unstripped would silently never match and quietly gate nothing.
        // This is an emission guard only: the files stay on disk, because the app window's own
        // @font-face rules and language-helper.js resolveLanguageFonts() still use them.
        const activeLang = String(plan?.scriptContext?.language || '').trim().toLowerCase();
        const langScoped = new Set();
        const activeWants = new Set();
        try {
            const { LANGUAGES } = require('../data/languages');
            for (const [code, def] of Object.entries(LANGUAGES || {})) {
                for (const list of Object.values(def?.fontOverrides || {})) {
                    for (const raw of list || []) {
                        const fam = String(raw).replace(/["']/g, '').trim().toLowerCase();
                        if (!fam || /^(sans-serif|serif|monospace|cursive|fantasy|system-ui)$/.test(fam)) continue;
                        langScoped.add(fam);
                        if (code.toLowerCase() === activeLang) activeWants.add(fam);
                    }
                }
            }
        } catch (_) { /* no registry -> gate nothing, embed everything as before */ }

        const rules = [];
        let skipped = 0;
        for (const file of fs.readdirSync(srcDir)) {
            if (!/\.(woff2?|ttf|otf)$/i.test(file)) continue;
            const base = file.replace(/\.(woff2?|ttf|otf)$/i, '');
            const m = base.match(/^([A-Za-z]+)[-_]?(\d{3}|Regular|VariableFont.*)?$/);
            if (!m) continue;
            const famKey = m[1];
            const family = SPECIAL[famKey] || famKey.replace(/([a-z])([A-Z])/g, '$1 $2');
            const famLower = family.toLowerCase();
            if (langScoped.has(famLower) && !activeWants.has(famLower)) { skipped++; continue; }
            const weight = /^\d{3}$/.test(m[2] || '') ? m[2] : '400';
            const fmt = /woff2$/i.test(file) ? 'woff2' : (/woff$/i.test(file) ? 'woff' : 'truetype');
            // Link rather than copy (12 MB of fonts per build dir otherwise), and never
            // overwrite: the destination may be a hardlink to the font in assets/, so a
            // blind copy would write straight back into the app's own install.
            const fontOut = path.join(outDir, file);
            try { if (!fs.existsSync(fontOut)) linkOrCopy(path.join(srcDir, file), fontOut); } catch (_) { continue; }
            rules.push(`@font-face { font-family: "${family}"; src: url("media/fonts/${file}") format("${fmt}"); font-weight: ${weight}; font-style: normal; font-display: block; }`);
        }
        if (rules.length) console.log(`[HyperFrames] Embedded ${rules.length} @font-face rule(s) from assets/fonts${skipped ? ` (skipped ${skipped} for other languages)` : ''}`);
        return rules.join('\n    ');
    } catch (err) {
        console.warn(`[HyperFrames] font embedding skipped: ${err.message}`);
        return '';
    }
}

// Film-grain texture. We deliberately do NOT use an SVG <feTurbulence> filter for
// grain: the headless render browser re-rasterizes it every frame and leaks GPU
// memory, which crashed the capture ("Target closed") mid-render. Instead bake a
// tiny static grayscale noise PNG once and tile it (a flat raster is cheap + stable).
let _grainTextureWritten = null;
function writeGrainTexture(mediaDir) {
    try {
        const out = path.join(mediaDir, '_grain.png');
        if (_grainTextureWritten === out && fs.existsSync(out)) return 'media/_grain.png';
        if (fs.existsSync(out)) { _grainTextureWritten = out; return 'media/_grain.png'; }
        const zlib = require('zlib');
        const W = 96, H = 96;
        const crc32 = (buf) => { let c = ~0 >>> 0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1); } return (~c) >>> 0; };
        const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, c]); };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; // 8-bit grayscale
        const raw = Buffer.alloc((W + 1) * H);
        let seed = 1337; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; for (let x = 0; x < W; x++) raw[y * (W + 1) + 1 + x] = Math.floor(rnd() * 256); }
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
        fs.writeFileSync(out, png);
        _grainTextureWritten = out;
        return 'media/_grain.png';
    } catch (_) {
        return null;
    }
}

// The AI pipeline emits a per-scene cinematic grade in scene.effectOverrides
// (grain / blurVignette / colorGrade / chromatic) that the old WebGL compositor
// rendered as shaders. HyperFrames is HTML/CSS, so we approximate the same look
// with a CSS `filter` on the footage + blend-mode overlay layers on top of it.
function sceneEffectTreatment(scene) {
    const ov = scene?.effectOverrides || {};
    const filters = [];
    const layers = [];

    const cg = ov.colorGrade;
    if (cg && cg.enabled !== false) {
        const desat = clamp01(cg.desaturation);
        if (desat > 0.001) filters.push(`saturate(${(1 - desat).toFixed(3)})`);
        const r = Math.round(clamp01(cg.tintR ?? 1) * 255);
        const g = Math.round(clamp01(cg.tintG ?? 1) * 255);
        const b = Math.round(clamp01(cg.tintB ?? 1) * 255);
        const ts = clamp01(cg.tintStrength) * 0.6;
        if (ts > 0.01) layers.push(`<div class="hf-scene-fx hf-scene-tint" style="background:rgb(${r},${g},${b});opacity:${ts.toFixed(3)};"></div>`);
    }

    const bv = ov.blurVignette;
    if (bv && bv.enabled !== false) {
        const intensity = clamp01(bv.intensity);
        if (intensity > 0.01) {
            const inner = Math.round(26 + clamp01(bv.radius ?? 0.5) * 34);
            const a = (0.12 + intensity * 0.7).toFixed(3);
            layers.push(`<div class="hf-scene-fx hf-scene-vignette" style="background:radial-gradient(ellipse at 50% 50%, transparent ${inner}%, rgba(0,0,0,${a}) 100%);"></div>`);
        }
    }

    // Plain vignette (theme key "vignette") — same look as blurVignette but a
    // theme may define one or the other.
    const vig = ov.vignette;
    if (vig && vig.enabled !== false) {
        const intensity = clamp01(vig.intensity);
        if (intensity > 0.01) {
            const inner = Math.round(24 + clamp01(vig.radius ?? 0.4) * 34);
            const a = (0.12 + intensity * 0.7).toFixed(3);
            layers.push(`<div class="hf-scene-fx hf-scene-vignette" style="background:radial-gradient(ellipse at 50% 50%, transparent ${inner}%, rgba(0,0,0,${a}) 100%);"></div>`);
        }
    }

    const grain = ov.grain;
    if (grain && grain.enabled !== false) {
        const intensity = clamp01(grain.intensity);
        if (intensity > 0.005) layers.push(`<div class="hf-scene-fx hf-scene-grain" style="opacity:${Math.min(0.55, intensity * 3.2).toFixed(3)};"></div>`);
    }

    // Dust — sparse speckle: reuse the grain texture, larger tile + lower opacity.
    const dust = ov.dust;
    if (dust && dust.enabled !== false) {
        const intensity = clamp01(dust.intensity);
        const density = clamp01(dust.density ?? 0.3);
        if (intensity > 0.005) layers.push(`<div class="hf-scene-fx hf-scene-dust" style="opacity:${Math.min(0.4, intensity * (1 + density)).toFixed(3)};"></div>`);
    }

    // Light leak — soft warm diagonal sweep (screen blend). Warmth shifts hue.
    const leak = ov.lightLeak;
    if (leak && leak.enabled !== false) {
        const intensity = clamp01(leak.intensity);
        const warmth = clamp01(leak.warmth ?? 0.6);
        if (intensity > 0.01) {
            const a = (intensity * 0.85).toFixed(3);
            const warm = `rgba(255, ${Math.round(180 + warmth * 50)}, ${Math.round(120 - warmth * 70)}, ${a})`;
            layers.push(`<div class="hf-scene-fx hf-scene-leak" style="background:linear-gradient(115deg, ${warm} 0%, transparent 42%);"></div>`);
        }
    }

    // chromatic ({intensity,angle}) is intentionally not rendered — at theme
    // intensities (~0.006) it is visually negligible and a true RGB-split is
    // expensive/unstable in the headless render browser.

    return { filter: filters.join(' '), layers: layers.join('\n        ') };
}

// Base (static) transform for a scene frame: floating framing + manual clip edits
// (scale / posX / posY) the editor lets the user set. Ken Burns is layered on the
// inner media separately so the two never fight.
function sceneBaseTransform(scene) {
    const framing = String(scene?.framing || 'fullscreen').toLowerCase();
    const parts = [];
    const posX = Number(scene?.posX) || 0;
    const posY = Number(scene?.posY) || 0;
    if (posX || posY) parts.push(`translate(${posX}px, ${posY}px)`);
    let scale = Number(scene?.scale);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    if (framing === 'floating' && scale === 1) scale = 0.5;
    if (scale !== 1) parts.push(`scale(${scale.toFixed(4)})`);
    return { transform: parts.join(' '), framing, scale, offset: !!(posX || posY) };
}

// Ken Burns (slow zoom/drift) — applied to still images so they don't sit dead on
// screen. Video footage already moves, so leave it alone. Deterministic direction
// from the scene index so it's stable across renders.
function kenBurnsFor(scene, isImage) {
    if (!isImage || scene?.kenBurns === false || scene?.kenBurnsEnabled === false) return null;
    const speed = clampNumber(scene?.kenBurnsSpeed, 0.25, 2, 1);
    // Floating clips normally sit still (the card element itself carries the motion),
    // but a floating PRESENTER still (talking-head framed insert) needs subtle idle
    // life so a held photo isn't dead. Normal floating clips stay still.
    if (scene?.framing === 'floating' && !scene?.presenterInsert) return null;
    // Presenter HOLD: one CONTINUOUS slow push across the whole span so multiple
    // beats of the same held image don't pop back on every inner cut. Each beat
    // renders its slice of the span-wide 1.05→1.13 zoom (consistent pan direction).
    const span = scene && scene._presenterSpan;
    if (scene?.presenterInsert && span && Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start) {
        const total = span.end - span.start;
        const cs = Number(scene.startTime ?? scene.start ?? span.start);
        const ce = Number(scene.endTime ?? scene.end ?? span.end);
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const f0 = clamp01((cs - span.start) / total);
        const f1 = clamp01((ce - span.start) / total);
        const S = (f) => 1.05 + 0.08 * f;   // 1.05 → 1.13 across the whole hold
        const X = (f) => -1.2 + 2.4 * f;    // -1.2% → +1.2%, single continuous direction
        return { fromScale: +S(f0).toFixed(4), toScale: +S(f1).toFixed(4), fromX: +X(f0).toFixed(3), toX: +X(f1).toFixed(3) };
    }
    const idx = Number(scene?.index) || 0;
    const dir = idx % 2 === 0 ? 1 : -1;
    // COVERAGE RULE: a ±X% pan needs scale ≥ 1 + 2*X/100 at ALL times or the
    // media edge enters the frame. The old fromScale 1.0 with ±1.6% pan
    // exposed a ~30px black strip at every image scene start that slowly
    // closed as the zoom reached 1.09 — "the image animates but the black
    // box doesn't". 1.06 covers ±3% pan with margin from frame one.
    return {
        fromScale: 1.06,
        toScale: +(1.06 + 0.09 * speed).toFixed(4),
        fromX: +(-dir * 1.6 * speed).toFixed(3),
        toX: +(dir * 1.6 * speed).toFixed(3),
    };
}

// Word-timed captions. The pipeline aligns scene.words[] = {word,start,end} to the
// narration; group them into short phrases and emit one timed clip per phrase.
// Gated on plan.subtitlesEnabled (the UI toggle) — off = no caption track.
function buildCaptionCues(plan) {
    if (!plan || !plan.subtitlesEnabled) return [];
    // Karaoke (word-by-word highlight) is OPT-IN. Default OFF → cues are exactly
    // as before (no `words` field), so caption markup/animation are unchanged.
    const karaoke = typeof plan.captionKaraoke === 'boolean'
        ? plan.captionKaraoke
        : /^(1|true|on|yes)$/i.test(String(process.env.KARAOKE_CAPTIONS || '').trim());
    const wordsPerCue = Math.max(2, Math.min(12, Math.round(Number(plan.captionWordsPerCue) || 7)));
    const maxDuration = Math.max(0.8, Math.min(5, Number(plan.captionMaxDuration) || 3.2));
    const cues = [];
    let idx = 0;
    for (const scene of plan.scenes || []) {
        if (!scene || scene.disabled) continue;
        const words = Array.isArray(scene.words) ? scene.words : [];
        if (!words.length) continue;
        let group = [];
        const flush = () => {
            if (!group.length) return;
            const start = toSeconds(group[0].start, 0);
            const end = toSeconds(group[group.length - 1].end, start + 1);
            const text = group.map(w => String(w.word ?? w.text ?? '').trim()).filter(Boolean).join(' ').trim();
            if (text) {
                const cue = { id: `cap-${idx++}`, start, duration: Math.max(0.4, end - start), text };
                if (karaoke) {
                    cue.words = group
                        .map(w => ({ w: String(w.word ?? w.text ?? '').trim(), t: toSeconds(w.start, start) }))
                        .filter(x => x.w);
                }
                cues.push(cue);
            }
            group = [];
        };
        for (const w of words) {
            group.push(w);
            const txt = String(w.word ?? w.text ?? '');
            const span = toSeconds(w.end, 0) - toSeconds(group[0].start, 0);
            if (group.length >= wordsPerCue || span >= maxDuration || /[.!?]$/.test(txt)) flush();
        }
        flush();
    }
    return cues;
}

function resolveCaptionVisual(plan) {
    const source = plan?.captionStyle && typeof plan.captionStyle === 'object'
        ? plan.captionStyle
        : {};
    const position = ['top', 'center', 'bottom'].includes(source.position)
        ? source.position
        : 'bottom';
    const background = ['box', 'pill', 'none'].includes(source.background)
        ? source.background
        : 'box';
    const color = normalizeTextColor(source.color) || '#ffffff';
    // Only the DEFAULT is theme-derived; an explicit captionStyle.backgroundColor
    // is the creator's decision and still wins. Built as near-black tinted
    // toward the theme rather than straight var(--hf-bg), because on a light
    // theme the background token is cream and the caption text is white — a
    // caption plate has to stay dark in all 8 themes or the words vanish.
    const backgroundColor = normalizeTextColor(source.backgroundColor)
        || 'color-mix(in srgb, color-mix(in srgb, #000, var(--hf-primary) 10%), transparent 36%)';
    const activeColor = normalizeTextColor(source.activeColor) || '#facc15';
    const fontSize = clampNumber(source.fontSize, 24, 84, 46);
    const maxWidth = clampNumber(source.maxWidth, 720, 1760, 1560);
    const fontWeight = clampNumber(source.fontWeight, 400, 950, 800);
    const placement = position === 'top'
        ? 'top: 72px; bottom: auto; align-items: flex-start;'
        : position === 'center'
            ? 'top: 0; bottom: 0; align-items: center;'
            : 'top: auto; bottom: 92px; align-items: flex-end;';
    const shell = background === 'none'
        ? 'padding: 0; background: transparent; border-radius: 0;'
        : background === 'pill'
            ? `padding: 12px 32px 14px; background: ${backgroundColor}; border-radius: 999px;`
            : `padding: 10px 28px 12px; background: ${backgroundColor}; border-radius: 14px;`;
    return {
        position,
        background,
        color,
        backgroundColor,
        activeColor,
        fontSize,
        maxWidth,
        fontWeight,
        placement,
        shell,
    };
}

function buildComposition({ plan, dirs, projectDir, options = {} }) {
    plan = timelineContract.normalizePlan(plan);
    const mediaDir = path.join(projectDir, 'media');
    ensureDir(mediaDir);
    const grainTextureRel = writeGrainTexture(mediaDir) || '';
    const fontFacesCss = buildFontFaces(dirs, mediaDir, plan);
    const assetCache = new Map();
    let graphics = collectGraphics(plan).map((mg) => {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        return { ...mg, _hfVisual: resolveHyperframeVisual(mg, mg?._hfKind || 'graphic', type, plan) };
    });
    const sceneDuration = Math.max(1, ...(plan.scenes || []).map(s => toSeconds(s.endTime, toSeconds(s.end, 0))));
    const totalDuration = toSeconds(plan.totalDuration, 0) || sceneDuration;
    const dedupe = dedupeGraphics(graphics);
    graphics = dedupe.graphics;
    const timingGuard = applyVisualTimingGuards(graphics, totalDuration);
    timingGuard.report.deduped = dedupe.report;
    graphics = timingGuard.graphics;
    fs.writeFileSync(path.join(projectDir, 'hyperframes-timing-report.json'), JSON.stringify(timingGuard.report, null, 2), 'utf8');
    if (dedupe.report.removed.length > 0) {
        console.warn(`[HyperFrames] Dedupe removed ${dedupe.report.removed.length} duplicate visual item(s) before timing`);
    }
    if (timingGuard.report.clamped.length > 0) {
        console.warn(`[HyperFrames] Timing guard clamped ${timingGuard.report.clamped.length} runaway/overlapping visual item(s)`);
    }
    const visualReport = buildVisualDiagnostics(graphics, dirs);
    fs.writeFileSync(path.join(projectDir, 'hyperframes-visual-report.json'), JSON.stringify(visualReport, null, 2), 'utf8');
    fs.writeFileSync(path.join(projectDir, 'hyperframes-style-report.json'), JSON.stringify({
        total: visualReport.total,
        byStyle: visualReport.byStyle,
        byVariant: visualReport.byVariant,
        byAnimation: visualReport.byAnimation,
        byComposition: visualReport.byComposition,
        byLayout: visualReport.byLayout,
        resolved: visualReport.resolved,
    }, null, 2), 'utf8');

    // ── Whole-video sameness scan (src/render/hf-video-lint.js) ────────────
    // The slop linter judges each graphic on its own; this judges the sequence,
    // which is where the machine-made feel actually lives. Diagnostics only —
    // it never blocks a render — but it runs on every build so the evidence is
    // always fresh instead of being gathered by hand once.
    if (String(process.env.HF_VIDEO_LINT || '').trim() !== '0') {
        try {
            const vl = videoLint(visualReport);
            fs.writeFileSync(
                path.join(projectDir, 'hyperframes-video-lint.json'),
                JSON.stringify({ ok: vl.ok, counts: vl.counts, stats: vl.stats, findings: vl.findings }, null, 2),
                'utf8'
            );
            if (vl.findings.length) {
                console.warn(`[HyperFrames] Sameness scan: ${vl.findings.length} finding(s) across the whole video`);
                for (const f of vl.findings.slice(0, 8)) {
                    console.warn(`[HyperFrames]   ${f.severity === 'error' ? '✗' : '·'} ${f.id}: ${f.snippet}`);
                }
            } else {
                console.log(`[HyperFrames] Sameness scan: clean across ${vl.stats.total} graphic(s)`);
            }
        } catch (err) {
            console.warn(`[HyperFrames] Sameness scan skipped: ${String(err.message).slice(0, 120)}`);
        }
    }

    const issueCount = visualReport.unsupported.length + visualReport.missingMapAssets.length + visualReport.missingTemplateMedia.length + visualReport.fallbacks.length;
    const typeSummary = Object.entries(visualReport.byType).map(([type, count]) => `${type}:${count}`).join(', ') || 'none';
    const styleSummary = Object.entries(visualReport.byStyle).map(([style, count]) => `${style}:${count}`).join(', ') || 'none';
    const animationSummary = Object.entries(visualReport.byAnimation).map(([animation, count]) => `${animation}:${count}`).join(', ') || 'none';
    const compositionSummary = Object.entries(visualReport.byComposition).map(([mode, count]) => `${mode}:${count}`).join(', ') || 'none';
    const layoutSummary = Object.entries(visualReport.byLayout).map(([layout, count]) => `${layout}:${count}`).join(', ') || 'none';
    console.log(`[HyperFrames] Visual bridge: ${visualReport.total} graphic/template/map item(s) (${typeSummary})`);
    console.log(`[HyperFrames] Styles: ${styleSummary}`);
    console.log(`[HyperFrames] Animations: ${animationSummary}`);
    console.log(`[HyperFrames] Compositions: ${compositionSummary}`);
    console.log(`[HyperFrames] Layouts: ${layoutSummary}`);
    if (issueCount > 0) {
        console.warn(`[HyperFrames] Visual bridge diagnostics: unsupported=${visualReport.unsupported.length}, missingMaps=${visualReport.missingMapAssets.length}, missingTemplateMedia=${visualReport.missingTemplateMedia.length}, fallbacks=${visualReport.fallbacks.length}`);
    }

    const sceneTags = [];
    const sceneAnims = [];
    const sceneHoldSources = [];
    const fxTimelines = []; // hf-effects GSAP fragments, injected after graphic anims
    const iconAnims = []; // explainer icon moments (icon-director) — pop/float/exit
    const explainAnims = []; // talking-head presenter-stage explanation images — slide in beside the host, then out
    const glowAnims = []; // keyword-glow word-emphasis overlays (#18) — pop/glow/exit
    const sceneMediaTrackCounters = new Map();
    const allocateSceneMediaTrack = (baseTrack = 0) => {
        const base = Math.max(0, Math.floor(Number(baseTrack) || 0));
        const next = sceneMediaTrackCounters.get(base) || 0;
        sceneMediaTrackCounters.set(base, next + 1);
        // Media clips need independent HyperFrames tracks because foreground,
        // blurred backdrop, presenter inserts, transition tails, and adjacent
        // scenes can intentionally overlap. Negative reserved lanes keep them
        // below graphic/caption tracks without changing DOM/CSS compositing.
        return -10000 + base * 1000 + next;
    };
    const sceneWindowAttrs = (start, duration, mediaStartOffset = 0) => (
        `data-hf-scene-start="${Number(start).toFixed(3)}" `
        + `data-hf-scene-duration="${Number(duration).toFixed(3)}"`
        + (Number(mediaStartOffset) > 0.001
            ? ` data-media-start="${Number(mediaStartOffset).toFixed(3)}"`
            : '')
    );
    const timedSceneMediaAttrs = ({
        id,
        start,
        duration,
        baseTrack,
        mediaStartOffset = 0,
    }) => (
        `id="${id}" data-start="${Number(start).toFixed(3)}" `
        + `data-duration="${Number(duration).toFixed(3)}" `
        + `data-track-index="${allocateSceneMediaTrack(baseTrack)}"`
        + (Number(mediaStartOffset) > 0.001
            ? ` data-media-start="${Number(mediaStartOffset).toFixed(3)}"`
            : '')
    );

    // ── Video background pack (ONE per video) ──
    // Scenes whose upstream background choice is FLAT (gradient:*/soft-*/
    // style) render the video's designed background pack instead of the old
    // generic tint. The duplicate-blur backdrop stays the default lane.
    // Pack chosen by the effects director (plan._hfBackgroundPack) with a
    // theme-default fallback. HF_BACKGROUND_PACKS=0 reverts to legacy tints.
    let bgPack = null;
    let bgPackCss = '';
    if (!/^(0|false|off|no)$/i.test(String(process.env.HF_BACKGROUND_PACKS || '').trim())) {
        try {
            const { buildBackgroundPack, resolvePackId } = require('./hf-background-packs');
            const planThemeId = cleanName(displayValue(plan?.scriptContext?.themeId, plan?.themeId, plan?.theme, 'standard'), 'standard');
            const packId = resolvePackId(plan?._hfBackgroundPack, planThemeId);
            bgPack = buildBackgroundPack(packId, getThemeTokens(planThemeId) || {});
            bgPackCss = bgPack.css;
            console.log(`[HyperFrames] Background pack: ${bgPack.id} (theme ${planThemeId}${plan?._hfBackgroundPack ? ', director-chosen' : ', theme default'})`);
        } catch (e) {
            console.warn(`[HyperFrames] background packs unavailable: ${String(e.message).slice(0, 80)}`);
        }
    }

    // Accent color for authored SVG explainer icons (currentColor strokes).
    let iconAccent = '#38bdf8';
    try {
        const _it = getThemeTokens(cleanName(displayValue(plan?.scriptContext?.themeId, plan?.themeId, plan?.theme, 'standard'), 'standard')) || {};
        iconAccent = _it.colors?.accent || _it.colors?.primary || iconAccent;
    } catch (_) { /* default accent */ }

    const buildSceneBackdropMarkup = ({
        id,
        rel,
        isImage,
        start,
        duration,
        trackIndex,
        mediaStartOffset = 0,
        needsBackdrop = false,
        background = '',
    }) => {
        if (!needsBackdrop) return '';
        const bgRaw = String(background || '').trim().toLowerCase();
        const bgKind = bgRaw.split(':')[0];
        const isFlat = bgKind === 'gradient' || bgKind === 'soft' || bgRaw.startsWith('soft-');
        if (isFlat && bgPack) {
            return `<div class="hf-scene-floatbg ${bgPack.stageClass}">${bgPack.html}</div>`;
        }
        const flatClass = isFlat
            ? ((bgRaw.startsWith('soft-') || bgKind === 'soft')
                ? ' hf-floatbg-soft'
                : (bgRaw.includes('warm') ? ' hf-floatbg-warm' : ''))
            : '';
        const attrs = timedSceneMediaAttrs({
            id: `${id}-backdrop-media`,
            start,
            // Keep the intentional duplicate-fill lane distinct from the
            // foreground media fingerprint used by HyperFrames discovery.
            duration: Number(duration) + 0.001,
            baseTrack: trackIndex,
            mediaStartOffset,
        });
        const fill = isImage
            ? `<img ${attrs} class="clip hf-floatbg-fill" src="${html(rel)}" alt="">`
            : `<video ${attrs} class="clip hf-floatbg-fill" src="${html(rel)}" muted playsinline preload="auto"></video>`;
        return `<div class="hf-scene-floatbg hf-floatbg-media${flatClass}">${fill}</div>`;
    };

    for (const scene of plan.scenes || []) {
        if (!scene || scene.disabled || scene.isMGScene) continue;
        const src = resolveSceneMedia(scene, dirs);
        const start = toSeconds(scene.startTime, 0);
        const duration = getDuration(scene, Math.max(0.5, toSeconds(scene.endTime, start + 3) - start));
        const durationForTimeline = renderDuration(duration, 0.5);
        const id = `scene-${cleanName(scene.clipId ?? `${scene.index ?? sceneTags.length}-${sceneTags.length}`)}`;
        const trackIndex = parseTrackIndex(scene.trackId, 0);
        const mediaStartOffset = options?.preview ? getSceneVideoOffset(scene) : 0;
        const openingSceneClass = start <= 0.001 ? ' hf-opening-scene' : '';
        const baseAttrs = `id="${id}" ${sceneWindowAttrs(start, durationForTimeline, mediaStartOffset)} data-hf-anim="${id}"`;
        let kenBurns = null;
        // Subject-pan for cover-fit media. Declared at loop scope (like kenBurns) because the
        // sceneAnims.push below runs for EVERY scene — outside the has-media `else` block where
        // `fit` is in scope. Set inside that block once `fit` is known; stays null otherwise.
        let focusPan = null;
        if (!src) {
            const emptyTrack = allocateSceneMediaTrack(trackIndex);
            sceneTags.push(`
    <div id="${id}" data-start="${start.toFixed(3)}" data-duration="${durationForTimeline.toFixed(3)}" data-track-index="${emptyTrack}" data-hf-anim="${id}" class="clip hf-scene hf-scene-wrap hf-empty${openingSceneClass}">
      <div class="hf-empty-text">${html(scene.text || scene.keyword || 'Missing scene media')}</div>
    </div>`);
        } else {
            const ext = path.extname(src).toLowerCase();
            const isImage = IMAGE_EXTS.has(ext);
            const isVideo = VIDEO_EXTS.has(ext);
            const rel = copyAsset(src, mediaDir, id, assetCache, {
                // Preview opens should be instant-ish. Do not transcode every
                // scene into short MP4s just to show the iframe; the preview
                // runtime seeks with data-media-start instead. Full render keeps
                // normalization so capture gets bounded media windows.
                normalizeVideo: isVideo && !options?.preview,
                duration,
                startOffset: getSceneVideoOffset(scene),
            });
            if (!rel) continue;
            const fit = classToken(scene.fitMode || scene.fit || 'cover', 'cover');
            focusPan = (fit === 'cover' && scene.focusPan) ? scene.focusPan : null;
            const treat = sceneEffectTreatment(scene);
            // ── hf-effects registry: animated effect stack (grain drift, leak
            // sweeps, flicker, breathing vignette…). Takes over layer rendering
            // when it produces a stack; legacy static treat.layers is the
            // fallback. Timeline fragments collect into fxTimelines and join
            // the master timeline at this scene's offset.
            let fxLayers = treat.layers;
            let fxFilter = treat.filter;
            if (hfEffects) {
                try {
                    const _framingStr = String(scene.framing || 'fullscreen').toLowerCase();
                    const _sc = Number(scene.scale);
                    const _framed = _framingStr === 'floating' || _framingStr === 'cinematic'
                        || (Number.isFinite(_sc) && _sc > 0 && _sc < 0.999)
                        || !!(Number(scene.posX) || Number(scene.posY));
                    const fx = hfEffects.buildSceneEffects(scene, id, start, durationForTimeline, { framed: _framed, baseLook: plan._hfBaseLook });
                    if (fx) {
                        fxLayers = fx.html;
                        // SINGLE grade owner: the hf-effects grade (video base look or a
                        // scene's flashback delta) is authoritative. Do NOT also stack the
                        // legacy colorGrade saturate() — two grades fighting = muddy footage.
                        if (fx.filter) fxFilter = fx.filter;
                        if (fx.timelineJS) fxTimelines.push(fx.timelineJS);
                    }
                } catch (fxErr) {
                    console.warn(`[HyperFrames] effects registry failed for ${id}: ${fxErr.message}`);
                }
            }
            const base = sceneBaseTransform(scene);
            const isFloating = base.framing === 'floating';
            const isCinematic = base.framing === 'cinematic';
            // ANY scene whose frame doesn't cover the full canvas needs a
            // backdrop — not just the floating/cinematic framing labels. A
            // fullscreen-framed scene with a manual Scale 0.85 (or a posX/Y
            // nudge) used to get NO backdrop at all: a hard black inset around
            // the footage, with Ken Burns animating the media inside while
            // the black border sat dead. Coverage, not framing label, decides.
            const needsBackdrop = isFloating || isCinematic || base.scale < 0.999 || base.offset;
            kenBurns = kenBurnsFor(scene, isImage);
            const frameStyle = base.transform ? ` style="transform:${base.transform};"` : '';
            // Subject-anchored crop: when the framing worker set a focus point (scene.focusX/Y),
            // drive object-position so a fill-frame (cover) crop keeps the subject's face in view
            // instead of centering and cutting it off. No focus set → CSS default center center.
            const _hasFocus = fit === 'cover' && (Number.isFinite(Number(scene.focusX)) || Number.isFinite(Number(scene.focusY)));
            const _objPos = _hasFocus
                ? `object-position:${(Number(scene.focusX ?? 0.5) * 100).toFixed(1)}% ${(Number(scene.focusY ?? 0.5) * 100).toFixed(1)}%;`
                : '';
            const _mediaCss = `${fxFilter ? `filter:${fxFilter};` : ''}${_objPos}`;
            const mediaStyle = _mediaCss ? ` style="${_mediaCss}"` : '';
            // HyperFrames owns playback/visibility on the media element itself.
            // The visual wrapper is intentionally NOT a timed clip: a timed video
            // nested in a second timed element freezes during deterministic capture.
            // A 0.6s media tail keeps the outgoing frame decoded while GSAP finishes
            // push/whip/zoom transitions on the untimed wrapper.
            const mediaRenderDuration = durationForTimeline + 0.6;
            const mainMediaAttrs = timedSceneMediaAttrs({
                id: `${id}-media`,
                start,
                duration: mediaRenderDuration,
                baseTrack: trackIndex,
                mediaStartOffset: isVideo ? mediaStartOffset : 0,
            });
            const mediaTag = isImage
                ? `<img ${mainMediaAttrs} class="clip hf-scene-media fit-${fit}" src="${html(rel)}" alt=""${mediaStyle}>`
                : `<video ${mainMediaAttrs} class="clip hf-scene-media fit-${fit}" src="${html(rel)}" muted playsinline preload="auto" onerror="this.closest('.hf-scene-wrap')?.classList.add('hf-media-error')"${mediaStyle}></video>`;
            // Backdrop for scaled framings. The CEO (framing worker) sets scene.background:
            // 'blur'/'none'/unspecified → a BLURRED, scaled copy of the footage itself (the
            // rich "blurred fill" a human editor uses — never a black void); 'gradient:*' /
            // 'soft-*' → a flat tinted panel. This honors the CEO's choice AND guarantees a
            // scaled clip never floats on black (the old code drew one fixed dark gradient
            // for every framed scene, which read as "no background").
            const backdropMarkup = buildSceneBackdropMarkup({
                id,
                rel,
                isImage,
                start,
                duration: mediaRenderDuration,
                trackIndex,
                mediaStartOffset: isVideo ? mediaStartOffset : 0,
                needsBackdrop,
                background: scene.background,
            });
            // Explainer icon moments (icon-director): photo cutouts / authored
            // SVGs popping in over the footage, word-synced. Rendered inside
            // the scene wrap so they travel with scene transitions.
            let iconMarkup = '';
            const iconMoments = Array.isArray(scene._iconMoments) ? scene._iconMoments : [];
            // Framed presenter holds render as a "presenter stage" — their icon moments become
            // the explanation images that slide in beside the host (built below), NOT corner icons.
            const isPStage = !!(scene.presenterInsert && scene.presenterInsert.layout === 'framed');
            if (!isPStage) iconMoments.forEach((m, j) => {
                if (!m) return;
                let inner = '';
                let framedClass = '';
                if ((m.kind === 'photo' || m.kind === 'image') && m.src) {
                    const irel = copyAsset(m.src, mediaDir, `${id}-icon-${j}`, assetCache, {});
                    if (!irel) return;
                    inner = `<img src="${html(irel)}" alt="">`;
                    // 'image' = whole photograph in a small frame (no cutout)
                    if (m.kind === 'image') framedClass = ' hf-scene-icon-framed';
                } else if (m.kind === 'svg' && m.svg) {
                    inner = m.svg;
                } else return;
                const iconId = `${id}-icon-${j}`;
                const iconColor = normalizeTextColor(m.color)
                    || normalizeTextColor(iconAccent)
                    || '#38bdf8';
                const iconScale = clampNumber(m.scale, 0.25, 3, 1);
                const iconWidth = Math.round((framedClass ? 400 : 260) * iconScale);
                const iconHeight = Math.round((framedClass ? 270 : 260) * iconScale);
                const iconPosition = classToken(m.position, 'top-right');
                const centerOffset = iconPosition === 'center-left' || iconPosition === 'center-right'
                    ? `;margin-top:-${Math.round(iconHeight / 2)}px`
                    : '';
                iconMarkup += `
      <div id="${iconId}" class="hf-scene-icon${framedClass} hf-icon-pos-${iconPosition}" style="color:${iconColor};width:${iconWidth}px;height:${iconHeight}px${centerOffset}">${inner}</div>`;
                iconAnims.push({ id: iconId, start: start + toSeconds(m.at, 0.5), duration: Math.max(1, toSeconds(m.dur, 2)) });
            });
            // Keyword-glow overlays (#18) — word-synced emphasis inside the wrap so
            // they travel with scene transitions. Only present when HF_KEYWORD_GLOW set.
            let glowMarkup = '';
            const kwGlows = Array.isArray(scene._keywordGlow) ? scene._keywordGlow : [];
            kwGlows.forEach((g, j) => {
                if (!g || !g.phrase) return;
                const kwId = `${id}-kw-${j}`;
                glowMarkup += `
      <div id="${kwId}" class="hf-kw-glow hf-kw-pos-${classToken(g.position, 'lower-center')}" style="color:${iconAccent}"><span class="hf-kw-glow-fill">${html(g.phrase)}</span><span class="hf-kw-glow-layer" aria-hidden="true">${html(g.phrase)}</span></div>`;
                glowAnims.push({ id: kwId, start: start + toSeconds(g.at, 0.5), duration: Math.max(1, toSeconds(g.dur, 1.8)) });
            });
            // Talking-head corner PiP (rare, HF_PRESENTER_PIP): the presenter rides as a
            // framed inset OVER the B-roll base — INSIDE the scene wrap, so no z-index or
            // backdrop rework. Image now; a per-scene avatar clip (timed video) later.
            let presenterPipMarkup = '';
            const _pip = (scene.presenterInsert && scene.presenterInsert.layout === 'pip') ? scene.presenterInsert : null;
            if (_pip && _pip.mediaFile) {
                const prel = copyAsset(_pip.mediaFile, mediaDir, `${id}-pip`, assetCache, {});
                if (prel) {
                    const pipVid = /\.(mp4|webm|mov|m4v)$/i.test(prel);
                    const pipId = `${id}-pip`;
                    const pipMediaAttrs = pipVid
                        ? timedSceneMediaAttrs({
                            id: `${pipId}-media`,
                            start,
                            duration: mediaRenderDuration,
                            baseTrack: trackIndex,
                        })
                        : '';
                    const pipInner = pipVid
                        ? `<video ${pipMediaAttrs} class="clip" src="${html(prel)}" muted playsinline preload="auto" onerror="this.style.display='none'"></video>`
                        : `<img src="${html(prel)}" alt="">`;
                    const cornerCss = { 'bottom-right': 'right:5%;bottom:8%;', 'bottom-left': 'left:5%;bottom:8%;', 'top-right': 'right:5%;top:8%;', 'top-left': 'left:5%;top:8%;' }[_pip.corner] || 'right:5%;bottom:8%;';
                    presenterPipMarkup = `
      <div id="${pipId}" class="hf-presenter-pip" style="${cornerCss}">${pipInner}</div>`;
                    iconAnims.push({ id: pipId, start: start + 0.2, duration: Math.max(1, durationForTimeline - 0.4) });
                }
            }
            // Talking-head SPLIT SCREEN: presenter on one side, the scene's B-roll on the
            // other — two half-panels replace the normal single-media frame. Presenter half
            // holds while the B-roll half changes across a multi-beat split (no per-beat pop).
            let frameExtraClass = isFloating ? ' is-floating' : '';
            let frameInnerHtml = `${mediaTag}
        ${fxLayers}`;
            const _split = (scene.presenterInsert && scene.presenterInsert.layout === 'split') ? scene.presenterInsert : null;
            if (_split && _split.mediaFile) {
                const presRel = copyAsset(_split.mediaFile, mediaDir, `${id}-splitpres`, assetCache, {});
                if (presRel) {
                    const pVid = /\.(mp4|webm|mov|m4v)$/i.test(presRel);
                    const objPos = `object-position:${(Number(scene.focusX ?? 0.5) * 100).toFixed(0)}% ${(Number(scene.focusY ?? 0.38) * 100).toFixed(0)}%;`;
                    const presenterMediaAttrs = pVid
                        ? timedSceneMediaAttrs({
                            id: `${id}-split-presenter-media`,
                            start,
                            duration: mediaRenderDuration,
                            baseTrack: trackIndex,
                        })
                        : '';
                    const presTag = pVid
                        ? `<video ${presenterMediaAttrs} class="clip" src="${html(presRel)}" muted playsinline preload="auto" style="${objPos}"></video>`
                        : `<img src="${html(presRel)}" alt="" style="${objPos}">`;
                    const brollPanel = rel ? mediaTag : '';
                    frameExtraClass = ' hf-scene-split' + (_split.side === 'right' ? ' is-right' : '');
                    frameInnerHtml = `
        <div class="hf-split-panel hf-split-presenter">${presTag}</div>
        <div class="hf-split-panel hf-split-broll">${brollPanel}</div>
        ${fxLayers}`;
                }
            }
            // Talking-head PRESENTER STAGE (framed holds): host card on hostSide + an explanation
            // slot on the other side where the scene's word-synced images SLIDE IN and back out.
            // The host holds (same image across a multi-beat span); the explanation images change.
            if (isPStage && rel) {
                const hostSide = scene.presenterInsert.hostSide === 'right' ? 'right' : 'left';
                const objPos = `object-position:${(Number(scene.focusX ?? 0.5) * 100).toFixed(0)}% ${(Number(scene.focusY ?? 0.38) * 100).toFixed(0)}%;`;
                const hostVid = /\.(mp4|webm|mov|m4v)$/i.test(rel);
                const hostMediaAttrs = hostVid
                    ? timedSceneMediaAttrs({
                        id: `${id}-host-media`,
                        start,
                        duration: mediaRenderDuration,
                        baseTrack: trackIndex,
                        mediaStartOffset,
                    })
                    : '';
                const hostTag = hostVid
                    ? `<video ${hostMediaAttrs} class="clip" src="${html(rel)}" muted playsinline preload="auto" style="${objPos}"></video>`
                    : `<img src="${html(rel)}" alt="" style="${objPos}">`;
                let explainHtml = '';
                iconMoments.forEach((m, j) => {
                    if (!m) return;
                    let inner = '';
                    if ((m.kind === 'photo' || m.kind === 'image') && m.src) {
                        const irel = copyAsset(m.src, mediaDir, `${id}-ex-${j}`, assetCache, {});
                        if (!irel) return;
                        inner = `<img src="${html(irel)}" alt="">`;
                    } else if (m.kind === 'svg' && m.svg) {
                        const iconColor = normalizeTextColor(m.color)
                            || normalizeTextColor(iconAccent)
                            || '#38bdf8';
                        inner = `<div class="hf-pexplain-svg" style="color:${iconColor}">${m.svg}</div>`;
                    } else return;
                    const exId = `${id}-ex-${j}`;
                    const explainScale = clampNumber(m.scale, 0.25, 3, 1);
                    explainHtml += `
        <div id="${exId}" class="hf-pexplain" style="--hf-explain-scale:${explainScale}">${inner}</div>`;
                    explainAnims.push({ id: exId, start: start + toSeconds(m.at, 0.6), duration: Math.max(1.6, toSeconds(m.dur, 2.8)), from: hostSide === 'left' ? 'right' : 'left' });
                });
                frameExtraClass = ' hf-pstage is-host-' + hostSide;
                frameInnerHtml = `
        <div class="hf-pstage-hostcard">${hostTag}</div>
        <div class="hf-pstage-slot">${explainHtml}</div>
        ${fxLayers}`;
            }
            sceneTags.push(`
    <div ${baseAttrs} class="hf-scene hf-scene-wrap${openingSceneClass}${isFloating ? ' hf-scene-floating' : ''}${isCinematic ? ' hf-scene-cinematic' : ''}">
      ${backdropMarkup}
      <div class="hf-scene-frame${frameExtraClass}"${frameStyle}>
        ${frameInnerHtml}
      </div>${iconMarkup}${presenterPipMarkup}${glowMarkup}
    </div>`);
            sceneHoldSources.push({
                sourceId: id,
                sourceClipId: scene.clipId || '',
                sourceSceneIndex: scene.sourceSceneIndex ?? scene.index,
                start,
                end: start + durationForTimeline,
                rel,
                isImage,
                fit,
                frameStyle,
                mediaStyle,
                needsBackdrop,
                background: scene.background,
                isFloating,
                isCinematic,
                treatLayers: treat.layers,
                trackIndex,
                kenBurns,
                mediaStartOffset,
                focusPan,
            });
        }
        sceneAnims.push({ id, start, duration: durationForTimeline, kenBurns, transition: scene.transition, transitionType: scene.transitionType, transitionIn: scene.transitionIn, focusPan });
    }

    const transitionOverlays = collectTransitionOverlays(sceneAnims, plan);

    // ── Transition opacity ownership (smoothness / anti-ghost fix) ──
    // A real editor's push / wipe / whip / zoom keeps BOTH frames fully opaque —
    // the geometric move IS the transition. The generic per-scene opacity
    // crossfade (applied in the sceneAnims runtime loop) otherwise fades the
    // incoming up from 0 WHILE it slides/scales in, so during the most visible
    // part of the move you see through it to the outgoing/stage = a mushy
    // double-exposure ("ghosty, not made by an editor"). Precompute which scene
    // is the incoming/outgoing side of a HARD-motion transition and let the
    // motion own opacity there. blur-dissolve/crossfade are TRUE dissolves and
    // deliberately keep the opacity fade (soft = time passing).
    const _HARD_MOTION_TX = new Set([
        'push-left', 'push-right', 'push-up',
        'wipe-left', 'wipe-right', 'wipe-up',
        'whip-left', 'whip-right',
        'zoom-punch', 'zoom-pull', 'spin-settle',
    ]);
    {
        const _sceneById = new Map(sceneAnims.map(s => [s.id, s]));
        for (const ov of transitionOverlays) {
            if (ov.mode !== 'motion' || !_HARD_MOTION_TX.has(ov.type)) continue;
            const inScene = ov.inId ? _sceneById.get(ov.inId) : null;
            if (inScene) inScene._motionIn = true;
            const outScene = ov.outId ? _sceneById.get(ov.outId) : null;
            if (outScene) {
                outScene._motionOut = true;
                // the motion runtime resets the outgoing transform at boundary + duration
                outScene._motionOutSnapAt = (ov.boundary != null ? ov.boundary : ov.start + ov.duration * 0.5) + ov.duration;
            }
        }
        // Plain-cut adjacency: when the next scene begins exactly at this scene's
        // end (back-to-back, same base track), it paints on top — so hold this
        // scene opaque and let the successor dissolve in OVER it. Keeps luminance
        // constant across the cut instead of both clips fading over the dark
        // stage (a repeated ~9% "breath" at every one of the ~200 plain cuts).
        for (let i = 0; i < sceneAnims.length; i++) {
            const s = sceneAnims[i];
            if (s._motionOut) continue;
            const succ = sceneAnims[i + 1];
            if (!succ) continue;
            const end = toSeconds(s.start, 0) + toSeconds(s.duration, 0);
            const succStart = toSeconds(succ.start, 0);
            if (succStart >= toSeconds(s.start, 0) && Math.abs(succStart - end) < 0.05) {
                s._coveredOut = true;
            }
        }
    }

    // Only overlay-mode transitions need a DOM element (slab/flare swept over
    // the cut). Motion-mode transitions animate the scene containers directly.
    const transitionTags = transitionOverlays.filter(item => item.mode !== 'motion').map((item, overlayIndex) => `
    <div id="${item.id}" data-start="${item.start.toFixed(3)}" data-duration="${item.duration.toFixed(3)}" data-track-index="${TRANSITION_TRACK_ORIGIN - 2 * overlayIndex}" class="clip hf-transition hf-transition-${classToken(item.type, 'crossfade')}" data-hf-anim="${item.id}" data-hf-transition="${html(item.type)}">
      <div class="hf-transition-slab"></div>
      <div class="hf-transition-flare"></div>
    </div>`);

    const captionCues = buildCaptionCues(plan);
    const captionVisual = resolveCaptionVisual(plan);
    // `cueIndex`, not `i` — the body below already binds its own `i` in the karaoke
    // word loop, and reusing the name would shadow it.
    const captionTags = captionCues.map((c, cueIndex) => {
        // Karaoke: when the cue carries per-word timings, emit one span per word
        // (highlighted on the timeline). Otherwise render the single text span
        // exactly as before.
        const inner = (Array.isArray(c.words) && c.words.length)
            ? c.words.map((w, i) => `<span class="hf-cap-word" id="${c.id}-w${i}">${html(w.w)}</span>`).join(' ')
            : html(c.text);
        return `
    <div id="${c.id}" data-start="${c.start.toFixed(3)}" data-duration="${c.duration.toFixed(3)}" data-track-index="${CAPTION_TRACK_ORIGIN - 2 * cueIndex}" class="clip hf-caption" data-hf-anim="${c.id}">
      <span class="hf-caption-text">${inner}</span>
    </div>`;
    });

    const graphicTags = [];
    const graphicAnims = [];
    // ── Stage-visual chains (June 12): when a template/fullscreen MG is
    // immediately followed by another (gap ≤ 0.35s), the boundary must be
    // SEAMLESS — no container scale-pop out/in. The internal choreography
    // (content exit of A, content entrance of B) carries the swap, so the
    // pair reads as pages of one continuous design. seamOut on A's side,
    // seamIn on B's side; the page runtime consumes the flags.
    const _stageWindows = graphics
        .map((mg, i) => {
            const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
            if (!isStageVisual(mg?._hfKind || 'graphic', type) || type === 'map-chart') return null;
            const timing = mg._hfTiming || getVisualTiming(mg, mg._hfKind, type);
            return { i, start: timing.start, end: timing.start + timing.duration };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);
    const _seamIn = new Set();
    const _seamOut = new Set();
    for (let w = 1; w < _stageWindows.length; w++) {
        const prev = _stageWindows[w - 1], cur = _stageWindows[w];
        if (cur.start - prev.end <= 0.35 && cur.start - prev.end >= -0.5) {
            _seamOut.add(prev.i);
            _seamIn.add(cur.i);
        }
    }
    graphics.forEach((mg, i) => {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        const id = `mg-${i}-${cleanName(type || mg._hfKind || 'graphic')}`;
        const timing = mg._hfTiming || getVisualTiming(mg, mg._hfKind, type);
        const visual = mg._hfVisual || resolveHyperframeVisual(mg, mg._hfKind, type, plan);
        const text = getMgText(mg);
        const subtext = getMgSubtext(mg);
        const resolvedItems = itemsFromMg(mg, text, subtext);
        const hasAsset = hasResolvedMgAsset(mg, type, dirs);
        const spec = getAgenticCompositionSpec(mg, {
            kind: mg._hfKind,
            type,
            visual,
            text,
            subtext,
            items: resolvedItems,
            kicker: templateKicker(type, mg),
            hasAsset,
        });
        const motion = rendererMotion(mg, type, visual, spec);
        const effectiveAnimation = motion.animation;
        const effectiveSpeed = motion.speed;
        const transparentTemplateBg = mg._hfKind === 'template' && isTransparentTemplateBackground(mg);
        graphicTags.push(buildMgMarkup(mg, id, mg._hfKind, dirs, mediaDir, assetCache, visual, i));
        graphicAnims.push({
            id,
            selector: `#${id}`,
            start: timing.start,
            duration: timing.duration,
            rawStart: timing.rawStart,
            rawDuration: timing.rawDuration,
            sourceOffset: timing.sourceOffset || 0,
            sourceDuration: timing.sourceDuration || timing.duration,
            rangeClippedAtStart: timing.rangeClippedAtStart === true,
            rangeClippedAtEnd: timing.rangeClippedAtEnd === true,
            rangeFragment: timing.rangeFragment === true,
            timingClamped: Boolean(
                timing.clamped
                || Math.abs(timing.start - Math.max(0, Number(timing.rawStart) || 0)) > 0.01
                || Math.abs(timing.duration - Math.max(
                    timing.minimumDuration || MIN_VISUAL_DURATION,
                    Number(timing.rawDuration) || timing.minimumDuration || MIN_VISUAL_DURATION
                )) > 0.01
            ),
            kind: mg._hfKind,
            sourceGroup: mg._hfSourceGroup || '',
            sourceIndex: Number.isInteger(mg._hfSourceIndex) ? mg._hfSourceIndex : null,
            sourceClipId: mg.clipId || mg.id || '',
            ownerSceneIndex: mg?._hfOwnerScene?.index ?? mg?.sceneIndex ?? null,
            // set by buildMgMarkup when the authored markup actually rendered
            // (false when it fell back to the fixed renderer)
            authored: Boolean(mg._authoredRendered && !prefersFixedRenderer(mg)),
            // seamless stage-visual chain boundaries (no container pop)
            seamIn: _seamIn.has(i),
            seamOut: _seamOut.has(i),
            type,
            compositionMode: spec?.mode || 'legacy',
            layout: spec?.layout || '',
            safeZone: spec?.safeZone || '',
            compositionSource: spec?.source || '',
            textStrategy: spec?.textStrategy || '',
            mediaTreatment: spec?.media?.treatment || '',
            density: spec?.density || '',
            componentOwnsLayout: Boolean(
                safeLayoutRequested(mg)
                || motion.useAgenticRenderer
                || isStageVisual(mg?._hfKind || 'graphic', type)
                || typeUsesDedicatedRenderer(type)
            ),
            safeLayout: safeLayoutRequested(mg),
            graphicShell: mg?._hfResolvedGraphicShell || null,
            graphicShellApplied: mg?._hfGraphicShellApplied === true,
            graphicShellManual: mg?.graphicShellManual === true || mg?.mgData?.graphicShellManual === true,
            motionEmphasis: spec?.motion?.emphasis || '',
            motionExit: spec?.motion?.exit || '',
            motionStagger: spec?.motion?.stagger || '',
            variant: visual.variant,
            animation: effectiveAnimation,
            speed: effectiveSpeed,
            styleName: visual.styleName,
            themeId: visual.themeId,
            cardStyle: visual.cardStyle,
            transparentBackground: visual.cardStyle === 'transparent',
            textColor: visual.colors?.text || '',
            textColorExplicit: hasExplicitGraphicTextColor(mg),
            adaptiveContrast: adaptiveContrastEnabled(mg, mg._hfKind),
            contrastTone: mg._hfContrastTone || contrastToneForGraphic({
                mg,
                kind: mg._hfKind,
                asset: hasAsset,
                transparentTemplateBg,
                visual,
            }),
            contrastProtection: mg._hfContrastProtection || contrastProtectionMode(mg),
            paletteRatios: visual.paletteRatios || null,
            accentRuleVisible: visual.accentRuleVisible !== false,
            fixedRendererOverride: prefersFixedRenderer(mg),
            authoredNs: mg._authoredNs || '',
            textPreview: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
            charCount: String(text || '').length,
            wordCount: String(`${text || ''} ${subtext || ''}`).trim().split(/\s+/).filter(Boolean).length,
            itemCount: resolvedItems.length,
            transparentTemplateBg,
        });
    });

    // ── Map builder timelines ──
    // buildMgMarkup attaches _hfMapAnim/_hfMapOffset for every map-chart that
    // took the map-hf-builder path. Serialize their GSAP tweens (camera,
    // border draw-on, route, pins) at each MG's absolute start offset; the
    // block is injected into the page script after the graphic anims loop.
    const mapTimelineScript = mapHfBuilder
        ? graphics
            .filter(g => g && g._hfMapAnim)
            .map(g => {
                const sourceOffset = Math.max(0, Number(g._hfMapSourceOffset) || 0);
                const visibleDuration = Math.max(0.001, Number(g._hfMapVisibleDuration) || 0.001);
                const sourceDuration = Math.max(
                    sourceOffset + visibleDuration,
                    Number(g._hfMapSourceDuration) || visibleDuration
                );
                const isRangeSlice = sourceOffset > 0.001 || sourceDuration > visibleDuration + 0.001;
                if (!isRangeSlice) {
                    return mapHfBuilder.buildMapTimelineJS(g._hfMapAnim, g._hfMapOffset || 0);
                }
                const localTimeline = mapHfBuilder.buildMapTimelineJS(g._hfMapAnim, 0, 'tl');
                const sliceEnd = Math.min(sourceDuration, sourceOffset + visibleDuration);
                return `(function(__master){ var tl = gsap.timeline({paused:true});\n${localTimeline}\ntry { tl.progress(1, true).progress(0, true); } catch (e) {}\n__master.fromTo(tl,{time:${sourceOffset.toFixed(3)}},{time:${sliceEnd.toFixed(3)},duration:${visibleDuration.toFixed(3)},ease:"none"},${(Number(g._hfMapOffset) || 0).toFixed(3)}); })(tl);`;
            })
            .join('\n')
        : '';

    // ── Agent-authored composition timelines ──
    // Each authored fragment runs against its own nested timeline (shadowed
    // `tl` inside the IIFE), then the nested timeline is added to the master
    // at the MG's start offset. The master is passed as a parameter so the
    // inner `var tl` shadow can't hoist over it.
    // Belt-and-suspenders: syntax-check every fragment (vm parse, no exec)
    // before injection — ONE unparseable fragment would otherwise kill the
    // entire page <script>, master timeline included.
    const vm = require('vm');
    let _authoredDropped = 0;
    const authoredTimelineScript = graphics
        .filter(g => g && g._hfAuthoredTimeline)
        .map(g => {
            // prime: GSAP fromTo tweens don't apply their "from" state until
            // first rendered — without this, frame 0 of the scene shows the
            // FINISHED layout (CSS hero state), which then snaps invisible
            // and animates in. progress(1)→progress(0) force-renders every
            // tween so t=0 shows true entrance starting states.
            const sourceOffset = Math.max(0, Number(g._hfAuthoredSourceOffset) || 0);
            const visibleDuration = Math.max(0.001, Number(g._hfAuthoredVisibleDuration) || 0.001);
            const sourceDuration = Math.max(
                sourceOffset + visibleDuration,
                Number(g._hfAuthoredSourceDuration) || visibleDuration
            );
            const isRangeSlice = sourceOffset > 0.001 || sourceDuration > visibleDuration + 0.001;
            const sliceEnd = Math.min(sourceDuration, sourceOffset + visibleDuration);
            const wrapped = isRangeSlice
                ? `(function(__master){ var tl = gsap.timeline({paused:true});\n${g._hfAuthoredTimeline}\ntry { tl.progress(1, true).progress(0, true); } catch (e) {}\n__master.fromTo(tl,{time:${sourceOffset.toFixed(3)}},{time:${sliceEnd.toFixed(3)},duration:${visibleDuration.toFixed(3)},ease:"none"},${(Number(g._hfAuthoredOffset) || 0).toFixed(3)}); })(tl);`
                : `(function(__master){ var tl = gsap.timeline();\n${g._hfAuthoredTimeline}\ntry { tl.progress(1, true).progress(0, true); } catch (e) {}\n__master.add(tl, ${(Number(g._hfAuthoredOffset) || 0).toFixed(3)}); })(tl);`;
            try {
                new vm.Script(wrapped);
                return wrapped;
            } catch (e) {
                _authoredDropped++;
                console.warn(`[HyperFrames] dropping authored timeline (syntax error): ${String(e.message).slice(0, 80)}`);
                return '';
            }
        })
        .filter(Boolean)
        .join('\n');

    const fxTimelineScript = fxTimelines.join('\n');
    if (fxTimelines.length) console.log(`[HyperFrames] Effects registry: ${fxTimelines.length} scene(s) with animated effect stacks`);

    // One-line observability for the two new render paths — these are the
    // lines to scan for in app logs after a build.
    const _mapBuilderCount = graphics.filter(g => g && g._hfMapAnim).length;
    const _mapTotal = graphics.filter(g => resolveVisualType(g, g?._hfKind || 'graphic') === 'map-chart').length;
    const _authoredCount = graphics.filter(g => g && g._hfAuthoredTimeline).length;
    console.log(`[HyperFrames] Map builder: ${_mapBuilderCount}/${_mapTotal} map scene(s) via map-hf-builder${_mapTotal > _mapBuilderCount ? ` (${_mapTotal - _mapBuilderCount} legacy fallback)` : ''}`);
    console.log(`[HyperFrames] Authored compositions: ${_authoredCount} rendered${_authoredDropped ? `, ${_authoredDropped} DROPPED at injection (syntax)` : ''}`);
    const _txMotion = transitionOverlays.filter(t => t.mode === 'motion').length;
    console.log(`[HyperFrames] Transitions: ${transitionOverlays.length} visible (${_txMotion} scene-motion, ${transitionOverlays.length - _txMotion} overlay), rest are cuts/crossfades`);
    console.log(`[HyperFrames] Explainer icons: ${iconAnims.length} moment(s) on the page`);

    const sortedHoldSources = [...sceneHoldSources].sort((a, b) => a.start - b.start);
    const holdGapAnims = [];
    const plannedHolds = Array.isArray(plan.continuityHolds)
        ? plan.continuityHolds
        : timelineContract.buildContinuityHolds(plan.scenes || [], {
            fps: plan.fps || 30,
            totalDuration,
        });
    const holdSourcesByClipId = new Map(
        sortedHoldSources
            .filter((source) => source.sourceClipId)
            .map((source) => [String(source.sourceClipId), source])
    );
    for (let i = 0; i < plannedHolds.length; i++) {
        const hold = plannedHolds[i];
        const holdStart = Math.max(0, toSeconds(hold?.startTime, 0));
        const holdEnd = Math.min(totalDuration, toSeconds(hold?.endTime, holdStart));
        const holdDuration = holdEnd - holdStart;
        if (holdDuration <= 0.04) continue;

        const source = holdSourcesByClipId.get(String(hold?.sourceClipId || ''))
            || [...sortedHoldSources].reverse().find(item => (
                item.start <= holdStart + 0.2
                && (
                    hold?.sourceSceneIndex == null
                    || String(item.sourceSceneIndex) === String(hold.sourceSceneIndex)
                )
            ))
            || sortedHoldSources.find(item => item.start >= holdEnd - 0.2);
        if (!source) continue;

        const id = `hold-${cleanName(hold?.clipId || `${i}-${source.sourceSceneIndex ?? source.sourceId}`)}`;
        const holdMediaDuration = holdDuration + 0.3;
        const sourceDuration = Math.max(0.05, source.end - source.start);
        const freezeOffset = source.isImage
            ? 0
            : (
                hold?.holdMode === 'head'
                    ? source.mediaStartOffset
                    : source.mediaStartOffset + Math.max(0, sourceDuration - 1 / Math.max(1, Number(plan.fps) || 30))
            );
        const holdMediaAttrs = timedSceneMediaAttrs({
            id: `${id}-media`,
            start: holdStart,
            duration: holdMediaDuration,
            baseTrack: source.trackIndex,
            mediaStartOffset: freezeOffset,
        });
        const mediaTag = source.isImage
            ? `<img ${holdMediaAttrs} class="clip hf-scene-media fit-${source.fit}" src="${html(source.rel)}" alt=""${source.mediaStyle}>`
            : `<video ${holdMediaAttrs} class="clip hf-scene-media fit-${source.fit}" src="${html(source.rel)}" muted playsinline preload="auto"${source.mediaStyle}></video>`;
        const holdBackdropMarkup = buildSceneBackdropMarkup({
            id,
            rel: source.rel,
            isImage: source.isImage,
            start: holdStart,
            duration: holdMediaDuration,
            trackIndex: source.trackIndex,
            mediaStartOffset: freezeOffset,
            needsBackdrop: source.needsBackdrop,
            background: source.background,
        });
        sceneTags.push(`
    <div id="${id}" ${sceneWindowAttrs(holdStart, holdDuration, freezeOffset)} data-hf-anim="${id}" data-hf-continuity-hold="1" data-hf-source-clip="${html(source.sourceClipId || '')}" class="hf-scene hf-scene-wrap hf-hold-scene${source.isFloating ? ' hf-scene-floating' : ''}${source.isCinematic ? ' hf-scene-cinematic' : ''}">
      ${holdBackdropMarkup}
      <div class="hf-scene-frame${source.isFloating ? ' is-floating' : ''}"${source.frameStyle}>
        ${mediaTag}
        ${source.treatLayers}
      </div>
    </div>`);
        sceneAnims.push({
            id,
            start: holdStart,
            duration: holdDuration,
            kenBurns: null,
            hold: true,
            sourceClipId: source.sourceClipId || '',
            focusPan: null,
        });
        holdGapAnims.push({
            start: holdStart,
            end: holdEnd,
            source: source.sourceSceneIndex ?? source.sourceId,
            sourceClipId: source.sourceClipId || '',
        });
    }
    if (holdGapAnims.length > 0) {
        console.warn(`[HyperFrames] Applied ${holdGapAnims.length} planned timeline continuity hold(s)`);
    }

    // A fullscreen/template visual owns the frame through its declared end.
    // If real footage begins on the same boundary, force that incoming scene
    // fully opaque immediately so the pre-stage continuity underlay cannot
    // flash between the stage visual and the next scene.
    const STAGE_HANDOFF_EPSILON = 0.05;
    const realSceneAnims = sceneAnims.filter((item) => !item.hold);
    for (const graphic of graphicAnims) {
        const stageVisual = graphic.kind === 'fullscreen' || graphic.kind === 'template';
        if (!stageVisual) continue;
        graphic.holdsFrameToEnd = true;
        if (graphic.seamOut) {
            graphic.handoffMode = 'stage';
            continue;
        }
        const boundary = graphic.start + graphic.duration;
        const incoming = realSceneAnims
            .filter((scene) => Math.abs(scene.start - boundary) <= STAGE_HANDOFF_EPSILON)
            .sort((left, right) => Math.abs(left.start - boundary) - Math.abs(right.start - boundary))[0];
        if (incoming) {
            graphic.handoffMode = 'scene';
            graphic.handoffTo = incoming.id;
            incoming._stageIn = true;
            incoming._stageInFrom = graphic.id;
        } else {
            graphic.handoffMode = 'underlay';
        }
    }

    const audioTags = [];
    const audioSrc = resolveMaybeFile(plan.audio, dirs);
    if (audioSrc) {
        const rel = copyAsset(audioSrc, mediaDir, 'voiceover', assetCache);
        const narrationVolume = clampNumber(plan.narrationVolume, 0, 1, 1);
        audioTags.push(`    <audio id="voiceover" data-start="0" data-duration="${totalDuration.toFixed(3)}" data-track-index="30" class="clip" src="${html(rel)}" data-volume="${narrationVolume}"></audio>`);
    }
    for (const [i, sfx] of (plan.sfxClips || []).entries()) {
        if (!sfx || !sfx.file) continue;
        const sfxPath = resolveMaybeFile(sfx.file, [path.join(dirs.appRoot, 'assets', 'sfx'), ...dirs.lookupDirs]);
        if (!sfxPath) continue;
        const rel = copyAsset(sfxPath, mediaDir, `sfx-${i}-${sfx.file}`, assetCache);
        audioTags.push(`    <audio id="sfx-${i}" data-start="${toSeconds(sfx.startTime, 0).toFixed(3)}" data-duration="${getDuration(sfx, 0.5).toFixed(3)}" data-track-index="${31 + i}" class="clip" src="${html(rel)}" data-volume="${toSeconds(sfx.volume, 0.35)}"></audio>`);
    }

    if (glowAnims.length) console.log(`[HyperFrames] Keyword glow: ${glowAnims.length} moment(s) on the page`);
    // glowAnims added ONLY when present so an OFF build's timeline JSON is byte-identical.
    const _timing = { sceneAnims, graphicAnims, transitionAnims: transitionOverlays, captionAnims: captionCues, iconAnims };
    if (glowAnims.length) _timing.glowAnims = glowAnims;
    if (explainAnims.length) _timing.explainAnims = explainAnims;
    const timelineData = JSON.stringify(_timing, null, 2);
    // Machine-readable motion contract for the automatic Motion QA agent.
    // HyperFrames' keyframes command statically sees literal authored tweens,
    // while the fixed renderer intentionally builds many tweens through
    // seek-safe loops/helpers. This sidecar preserves exact resolved subjects,
    // timings and source-plan identities so both paths are inspectable.
    const motionManifest = {
        version: 1,
        compositionId: 'yta-hyperframes',
        duration: totalDuration,
        scenes: sceneAnims.map((item) => ({
            id: item.id,
            selector: `#${item.id}`,
            start: item.start,
            duration: item.duration,
            hold: Boolean(item.hold),
            sourceClipId: item.sourceClipId || null,
            stageHandoffIn: Boolean(item._stageIn),
            stageHandoffFrom: item._stageInFrom || null,
            motionIn: Boolean(item._motionIn),
            motionOut: Boolean(item._motionOut),
            coveredOut: Boolean(item._coveredOut),
            hasKenBurns: Boolean(item.kenBurns),
            hasFocusPan: Boolean(item.focusPan),
        })),
        graphics: graphicAnims,
        transitions: transitionOverlays.map((item) => ({
            id: item.id,
            selector: `#${item.id}`,
            start: item.start,
            duration: item.duration,
            boundary: item.boundary,
            type: item.type,
            mode: item.mode,
            outId: item.outId || null,
            inId: item.inId || null,
        })),
        captions: captionCues.map((item) => ({
            id: item.id,
            selector: `#${item.id}`,
            start: item.start,
            duration: item.duration,
        })),
        icons: iconAnims.map((item) => ({
            id: item.id,
            selector: `#${item.id}`,
            start: item.start,
            duration: item.duration,
        })),
    };
    fs.writeFileSync(
        path.join(projectDir, 'hyperframes-motion-manifest.json'),
        JSON.stringify(motionManifest, null, 2),
        'utf8'
    );
    // Global background treatment (user-tuned): a medium edge vignette painted over
    // the WHOLE composition. Footage/packs stay true-color (neutral darken only); the
    // flat cream template cards gain depth instead of reading as stark empty canvas.
    // Edge-weighted (transparent core to 58%), so centered headlines/stats/subtitles
    // are untouched. Disable with HF_BG_VIGNETTE=0; tune with HF_BG_VIGNETTE_ALPHA.
    const __bgVignetteOn = process.env.HF_BG_VIGNETTE !== '0';
    const __bgVignetteAlpha = Math.max(0, Math.min(0.6, parseFloat(process.env.HF_BG_VIGNETTE_ALPHA || '0.34') || 0.34));
    const __bgTreatmentCss = __bgVignetteOn
        ? `\n    #yta-hyperframes::after { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 70; background: radial-gradient(125% 105% at 50% 44%, rgba(28,19,8,0) 0%, rgba(28,19,8,0) 58%, rgba(28,19,8,${__bgVignetteAlpha}) 100%); }`
        : '';
    const adaptiveContrastCss = buildAdaptiveContrastCss();
    const adaptiveContrastRuntime = buildAdaptiveContrastRuntime();
    const adaptiveLiveHookScript = options?.preview ? `
      if (typeof tl.eventCallback === 'function') {
        const previousTimelineUpdate = tl.eventCallback('onUpdate');
        tl.eventCallback('onUpdate', function ytaAdaptiveContrastTimelineUpdate() {
          if (typeof previousTimelineUpdate === 'function') {
            previousTimelineUpdate.apply(this, arguments);
          }
          hfAdaptiveContrast.schedule(typeof tl.time === 'function' ? tl.time() : 0, false);
        });
      }
      const refreshAdaptiveContrast = function refreshAdaptiveContrast() {
        hfAdaptiveContrast.schedule(typeof tl.time === 'function' ? tl.time() : 0, true);
      };
      document.addEventListener('loadeddata', refreshAdaptiveContrast, true);
      document.addEventListener('seeked', refreshAdaptiveContrast, true);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(refreshAdaptiveContrast).catch(function () {});
      }` : '';
    const graphicShellCss = buildGraphicShellCss();

    const __hfHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YTA HyperFrames Render</title>
  <style>
    /* display:grid centers the fixed 1920x1080 composition when the host
       viewport is larger (the app preview iframe) — without it the comp pins
       top-left and the rest of the iframe reads as a black box. The CLI
       renderer uses an exact 1920x1080 viewport, where centering is a no-op. */
    html, body { margin: 0; width: 100%; height: 100%; background: #050505; overflow: hidden; font-family: system-ui, sans-serif; }
    body { display: grid; place-items: center; }
    /* Root fallback values only — every graphic overrides these inline from its
       own theme (hyperframeStyleVars). They are deliberately LOW-CHROMA NEUTRALS
       rather than a chosen palette: a fallback that looks designed is a fallback
       that hides a bug. The previous values (cyan #22d3ee + violet #8b5cf6 on
       Tailwind slate) were the textbook generated-design palette and leaked into
       every graphic that failed to carry inline vars. Fonts fall back to the
       system stack, not to a webfont, for the same reason. */
    #yta-hyperframes { width: 1920px; height: 1080px; position: relative; overflow: hidden; background: radial-gradient(circle at 50% 40%, #121214 0%, #050505 70%); color: #f2efe9; --hf-primary:#b9c2cc; --hf-accent:#d8c6a3; --hf-text:#f2efe9; --hf-muted:rgba(238,235,228,0.88); --hf-surface:rgba(14,14,16,0.78); --hf-bg:rgba(14,14,16,0.78); --hf-shadow-color:rgba(0,0,0,0.48); --hf-shadow:0 22px 70px rgba(0,0,0,0.48); --hf-radius:12px; --hf-stroke:2px; --hf-heading-font:system-ui,sans-serif; --hf-body-font:system-ui,sans-serif; --hf-caption-font:system-ui,sans-serif; }
    .hf-scene { position: absolute; inset: 0; width: 100%; height: 100%; object-position: center center; opacity: 0; z-index: 1; }${__bgTreatmentCss}
    .hf-scene.hf-opening-scene { opacity: 1; }
    .hf-hold-scene { z-index: 0; }
    .hf-media.fit-cover, .hf-bg-media { object-fit: cover; width: 100%; height: 100%; }
    .hf-media.fit-contain { object-fit: contain; background: #050505; }
    /* Scene wrapper: footage + cinematic-treatment layers (grain/vignette/tint) */
    .hf-scene-wrap { overflow: hidden; }
    .hf-scene-frame { overflow: hidden; /* clip KB-scaled media to the frame — footage bleeding past the frame left the fx layers (grain) covering a SMALLER box than the visible media */  position: absolute; inset: 0; transform-origin: center center; }
    .hf-scene-media { position: absolute; inset: 0; width: 100%; height: 100%; object-position: center center; transform-origin: center center; }
    .hf-scene-media.fit-cover { object-fit: cover; }
    .hf-scene-media.fit-contain { object-fit: contain; background: #050505; }
    .hf-scene-fx { position: absolute; inset: 0; pointer-events: none; }
    .hf-scene-tint { mix-blend-mode: soft-light; }
    .hf-scene-vignette { mix-blend-mode: multiply; }
    .hf-scene-grain { mix-blend-mode: overlay; background-size: 220px 220px; background-repeat: repeat; ${grainTextureRel ? `background-image: url("${grainTextureRel}");` : ''} }
    .hf-scene-dust { mix-blend-mode: screen; background-size: 540px 540px; background-repeat: repeat; ${grainTextureRel ? `background-image: url("${grainTextureRel}");` : ''} }
    /* If the scene's media errors out, hide texture FX — grain/dust over a
       dead (black) layer renders as full-frame TV static in the final video. */
    .hf-media-error .hf-scene-fx { display: none; }
    /* hf-effects registry (animated effect stacks) */
${hfEffects ? hfEffects.sharedEffectsCSS(grainTextureRel) : ''}
    /* Local fonts — render browser has no network fonts */
    ${fontFacesCss}
    .hf-scene-leak { mix-blend-mode: screen; }
    .hf-scene-floatbg { position: absolute; inset: 0; overflow: hidden; background: radial-gradient(circle at 50% 38%, #161d2b 0%, #070a11 72%); }
    .hf-scene-floatbg.hf-floatbg-media { background: #070a11; }
    /* brightness 0.5 + a 0.5 edge vignette made the blurred fill read as a
       BLACK box around inset clips (the visible margin ring sits exactly in
       the most-darkened zone). Brighter fill + lighter vignette keeps the
       editorial dim while clearly showing the blurred duplicate. */
    .hf-floatbg-fill { position: absolute; inset: -10%; width: 120%; height: 120%; object-fit: cover; filter: blur(40px) brightness(0.78) saturate(1.15); transform: scale(1.06); will-change: transform; }
    .hf-scene-floatbg.hf-floatbg-media:after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 50% 42%, rgba(2,6,23,0) 40%, rgba(2,6,23,0.28) 100%); }
    .hf-scene-floatbg.hf-floatbg-soft { background: linear-gradient(160deg, #2a2f3a, #14171e); }
    .hf-scene-floatbg.hf-floatbg-warm { background: radial-gradient(circle at 50% 40%, #2a2018, #120d09 72%); }
${bgPackCss}
${adaptiveContrastCss}
    .hf-scene-frame.is-floating { transform-origin: center center; }
    .hf-scene-frame.is-floating .hf-scene-media { border-radius: 20px; box-shadow: 0 44px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04); overflow: hidden; }
    /* The no-media state fills the whole frame with nothing behind it, so it is
       the graphic's paper and has to be the theme's paper. */
    .hf-empty { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, color-mix(in srgb, var(--hf-bg), var(--hf-primary) 8%), var(--hf-bg)); }
    .hf-empty-text { max-width: 1100px; font-size: 54px; line-height: 1.08; color: var(--hf-muted); text-align: center; }
    .hf-mg { position: absolute; box-sizing: border-box; opacity: 0; pointer-events: none; z-index: 40; color: var(--hf-text); font-family: var(--hf-body-font); text-shadow: 0 2px 18px rgba(0,0,0,0.42); }
    .hf-title { max-width: 1450px; font-family: var(--hf-heading-font); font-size: 76px; line-height: 0.98; font-weight: 900; letter-spacing: 0; text-wrap: balance; }
    .hf-subtitle { max-width: 1250px; margin-top: 16px; color: var(--hf-muted); font-family: var(--hf-body-font); font-size: 34px; line-height: 1.18; font-weight: 650; text-wrap: balance; }
    .hf-kicker { margin-bottom: 14px; color: var(--hf-accent); font-family: var(--hf-caption-font); font-size: 24px; font-weight: 850; letter-spacing: 0; text-transform: uppercase; }
    /* ACCENT MARKS — see the side-tab rule in hf-slop-lint.js.
       A full-height coloured bar down the left edge of every card is the single
       most recognisable generated-design tell, and the engine used to put one on
       ten different elements, so every card in every video wore the same stripe.
       Each site now draws a SHORT mark instead, sized and placed for that
       element specifically: a tick beside a lower third, a rule under a headline,
       a cap over a counter. The --hf-mark variable recolours a mark without any
       variant having to redeclare its geometry. */
    .hf-copy-shell { position: relative; --hf-mark: var(--hf-primary); padding: 34px 46px 38px 54px; border-radius: var(--hf-radius); background: linear-gradient(90deg, var(--hf-bg), color-mix(in srgb, var(--hf-bg), transparent 34%)); box-shadow: var(--hf-shadow); backdrop-filter: blur(16px); }
    .hf-copy-shell:after { content: ""; position: absolute; left: 26px; top: 40px; width: 4px; height: 36px; background: var(--hf-mark); }
    .hf-agentic { --hf-agentic-pad-x: 120px; --hf-agentic-pad-y: 92px; --hf-agentic-copy-max: 1220px; --hf-agentic-gap: 22px; inset: 0; width: 100%; height: 100%; transform: none; overflow: hidden; }
    .hf-agentic.hf-agentic-layout-center-stack, .hf-agentic.hf-agentic-layout-cinematic-title, .hf-agentic.hf-agentic-layout-evidence-board, .hf-agentic.hf-agentic-layout-data-focus, .hf-agentic.hf-agentic-layout-split-panel, .hf-agentic.hf-agentic-layout-map-explainer, .hf-agentic.hf-agentic-layout-focus-panel { inset: 0; width: 100%; height: 100%; transform: none; }
    .hf-agentic-shade { position: absolute; inset: 0; z-index: 0; background: radial-gradient(circle at 72% 48%, rgba(15,23,42,0.05), rgba(2,6,23,0.34) 64%), linear-gradient(90deg, rgba(2,6,23,0.72), rgba(2,6,23,0.18), rgba(2,6,23,0.04)); pointer-events: none; }
    /* hf-no-bg means there is NO footage under this shade — so it stops being
       a wash and becomes the surface the text sits on. Every other shade below
       is genuinely a scrim over the creator's media and stays neutral.
       The centred radial glow that used to sit on top is gone: a soft halo
       parked behind the headline is the single most recognisable generator
       signature there is. It only escaped the halo check while it was flat
       grey — tinting it to the theme is what made it visible. Lit from one
       corner instead, matching .hf-template-fallback-bg below. */
    .hf-agentic.hf-no-bg .hf-agentic-shade { background: linear-gradient(118deg, color-mix(in srgb, var(--hf-bg), var(--hf-primary) 15%), color-mix(in srgb, var(--hf-bg), #000 8%) 58%, color-mix(in srgb, var(--hf-bg), #000 20%)); }
    .hf-agentic.hf-agentic-media-transparent { background: transparent; }
    .hf-agentic-shade.hf-agentic-media-transparent { display: none; }
    .hf-agentic-shade.hf-agentic-media-darken-background { background: linear-gradient(90deg, rgba(2,6,23,0.82), rgba(2,6,23,0.40), rgba(2,6,23,0.08)); }
    .hf-agentic-shade.hf-agentic-media-blur-background { background: rgba(2,6,23,0.30); backdrop-filter: blur(18px) saturate(1.08); }
    .hf-agentic-shade.hf-agentic-media-image-focus { background: radial-gradient(circle at 62% 44%, rgba(255,255,255,0.04), rgba(2,6,23,0.44) 58%), linear-gradient(90deg, rgba(2,6,23,0.78), rgba(2,6,23,0.16)); }
    .hf-agentic-shade.hf-agentic-media-map-focus { background: radial-gradient(circle at 50% 46%, rgba(56,189,248,0.08), rgba(2,6,23,0.28) 52%), linear-gradient(0deg, rgba(2,6,23,0.46), rgba(2,6,23,0.08)); }
    .hf-agentic-shade.hf-agentic-media-evidence-board { background: linear-gradient(115deg, rgba(2,6,23,0.82), rgba(15,23,42,0.34), rgba(2,6,23,0.12)); }
    .hf-agentic-shade.hf-agentic-media-split-background { background: linear-gradient(90deg, rgba(2,6,23,0.86) 0 48%, rgba(2,6,23,0.16) 48% 100%); }
    .hf-mg.hf-agentic-role-overlay:not(.hf-type-focus-word), .hf-mg[data-hf-authored-overlay]:not(.hf-type-focus-word) { background: transparent !important; background-image: none !important; backdrop-filter: none !important; }
    .hf-mg.hf-agentic-role-overlay:not(.hf-type-focus-word) > .hf-agentic-shade, .hf-mg[data-hf-authored-overlay]:not(.hf-type-focus-word) > .hf-agentic-shade { display: none !important; }
    .hf-agentic-kinetic { display: flex; flex-wrap: wrap; gap: 0.26em 0.32em; justify-content: inherit; }
    .hf-agentic-safe-center .hf-agentic-kinetic { justify-content: center; }
    .hf-agentic-word { display: inline-block; }
    .hf-agentic-text-range { color: var(--hf-text-range-color, currentColor); }
    .hf-agentic-layout-focus-panel .hf-agentic-stage { align-content: center; justify-items: center; text-align: center; }
    .hf-agentic-layout-focus-panel .hf-agentic-rule { display: none; }
    /* The panel already reads as a panel — surface, hairline, radius, shadow,
       blur. The 12px accent edge on top of all that was the stripe, not the
       design; a short tick beside the first line does the same job quietly. */
    .hf-agentic-layout-focus-panel .hf-agentic-copy { padding: 38px 58px 44px; max-width: 1180px; background: color-mix(in srgb, var(--hf-bg), transparent 12%); border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 42%); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); backdrop-filter: blur(20px) saturate(1.1); }
    /* The panel centres its type, so the mark centres too. A tick pinned to the
       left padding of a centred panel is beside nothing — it reads as leftover
       chrome. Sitting on the top border, a short centred rule caps the panel the
       way a masthead rule caps a page. */
    /* Fallback accent marks, for graphics the shell layer did not take ownership
     * of. The shell silences these whenever it supplies an accent of its own, so
     * what is left here is the only mark an unshelled graphic gets. They are sized
     * to match the shell's marks (a short rule, a first-line tick) rather than the
     * 5-6px edge bars they used to be, so a shelled and an unshelled graphic in
     * the same video do not read as coming from two different design systems. */
    .hf-agentic-layout-focus-panel .hf-agentic-copy:after { content: ""; position: absolute; left: 50%; top: 0; transform: translateX(-50%); width: 88px; height: 3px; background: var(--hf-primary); }
    .hf-agentic-layout-focus-panel .hf-agentic-kicker { color: var(--hf-primary); letter-spacing: 0.16em; text-transform: uppercase; }
    .hf-agentic-layout-focus-panel .hf-agentic-title { font-size: clamp(50px, 92.16px, 88px); }
    .hf-agentic-stage { position: absolute; inset: 0; z-index: 2; display: grid; align-content: center; justify-items: start; gap: var(--hf-agentic-gap); padding: var(--hf-agentic-pad-y) var(--hf-agentic-pad-x); box-sizing: border-box; }
    .hf-agentic-safe-center .hf-agentic-stage { align-content: center; justify-items: center; text-align: center; }
    .hf-agentic-safe-center .hf-agentic-copy { justify-items: center; }
    /* THE MARK — one short flat rule, not a rail.
       This element used to be an 8px pill running the FULL HEIGHT of the copy,
       with a primary-to-accent gradient and a 34px halo. That is the side-tab
       tell, drawn as a div so no border-based check could see it — which is why
       hf-slop-lint.js now carries a pseudo-side-bar rule as well.
       A mark should be short, flat, square-ended and sized to the type it
       introduces: the kicker rule of a broadcast title, not a coloured spine
       glued to the edge of a card. Each layout below sets its own length and
       indent so the mark lines up with that layout's text, instead of every
       graphic wearing the same stripe. */
    .hf-agentic-rule { width: 132px; height: 4px; min-height: 0; border-radius: 0; background: var(--hf-primary); box-shadow: none; }
    .hf-no-accent-rule .hf-agentic-rule { display: none !important; }
    .hf-no-accent-rule .hf-agentic-stage { grid-template-columns: minmax(0, 1fr) !important; }
    .hf-agentic-copy { display: grid; gap: 12px; max-width: var(--hf-agentic-copy-max); position: relative; }
    .hf-agentic-kicker { color: var(--hf-accent); font-family: var(--hf-caption-font); font-size: 24px; font-weight: 900; text-transform: uppercase; letter-spacing: 0; }
    .hf-agentic-title { font-family: var(--hf-heading-font); font-size: clamp(58px, 111.36px, 110px); line-height: 0.98; font-weight: 950; letter-spacing: 0; text-wrap: balance; }
    .hf-agentic-subtitle { max-width: 980px; color: var(--hf-muted); font-family: var(--hf-body-font); font-size: 32px; line-height: 1.16; font-weight: 650; text-wrap: balance; }
    .hf-agentic-items { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; width: min(1320px, 100%); }
    .hf-agentic-item { padding: 18px 22px; border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 68%); border-radius: var(--hf-radius); background: color-mix(in srgb, var(--hf-surface), transparent 18%); box-shadow: 0 16px 44px rgba(0,0,0,0.26); backdrop-filter: blur(14px); }
    .hf-agentic-item-value { display: block; color: var(--hf-primary); font-family: var(--hf-heading-font); font-size: 32px; line-height: 1; font-weight: 950; }
    .hf-agentic-item-label { display: block; margin-top: 8px; font-family: var(--hf-heading-font); font-size: 28px; line-height: 1.08; font-weight: 850; }
    /* 20px on a 1080-tall frame is 1.9% of frame height — it survives a desktop
       preview and dies on a phone, and video compression eats the thin strokes
       first. 24px is the readability floor for supporting copy. */
    .hf-agentic-item-subtext { display: block; margin-top: 8px; color: var(--hf-muted); font-size: 24px; line-height: 1.2; }
    .hf-agentic-reason { display: none; }
    .hf-agentic.hf-agentic-layout-lower-third { left: 112px; right: 112px; top: auto; bottom: 86px; width: auto; height: auto; transform: none; }
    .hf-agentic-layout-lower-third .hf-agentic-shade { display: none; }
    .hf-agentic-layout-lower-third .hf-agentic-stage { position: relative; inset: auto; padding: 0; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 12px; }
    /* margin-left matches the copy card's own left padding so the mark starts on
       the same vertical as the name below it, instead of floating off the card. */
    .hf-agentic-layout-lower-third .hf-agentic-rule { width: 96px; height: 4px; margin-left: 42px; }
    .hf-agentic-layout-lower-third .hf-agentic-copy { padding: 30px 42px 34px; max-width: 1280px; border-radius: var(--hf-radius); background: linear-gradient(90deg, color-mix(in srgb, var(--hf-bg), transparent 0%), color-mix(in srgb, var(--hf-bg), transparent 24%), transparent); box-shadow: var(--hf-shadow); backdrop-filter: blur(18px); }
    .hf-agentic-layout-lower-third .hf-agentic-title { font-size: clamp(54px, 86.4px, 84px); }
    .hf-agentic-layout-lower-third .hf-agentic-subtitle { font-size: 27px; max-width: 1120px; }
    .hf-agentic-layout-center-stack .hf-agentic-stage, .hf-agentic-layout-cinematic-title .hf-agentic-stage { align-content: center; justify-items: start; grid-template-columns: minmax(0, 1fr); gap: 22px; }
    .hf-agentic-layout-center-stack .hf-agentic-rule, .hf-agentic-layout-cinematic-title .hf-agentic-rule { width: 148px; height: 5px; }
    .hf-agentic-layout-center-stack .hf-agentic-copy, .hf-agentic-layout-cinematic-title .hf-agentic-copy { align-self: center; }
    .hf-agentic-layout-cinematic-title .hf-agentic-shade { background: radial-gradient(circle at 72% 48%, rgba(2,6,23,0.04), rgba(2,6,23,0.34) 60%), linear-gradient(90deg, rgba(2,6,23,0.70), rgba(2,6,23,0.18), rgba(2,6,23,0.02)); }
    /* Impact-text types (focusWord / kineticText) have a fixed visual identity: one
       big, DEAD-CENTRE punch — never the headline's left-rail layout. This is locked
       by TYPE so the Motion Director's per-item layout choice can't make a focusWord
       look like a lower-third. Placed after center-stack so it wins the cascade. */
    .hf-type-focus-word .hf-agentic-stage, .hf-type-kinetic-text .hf-agentic-stage { justify-items: center; text-align: center; align-content: center; grid-template-columns: minmax(0, 1fr); }
    .hf-type-focus-word .hf-agentic-rule, .hf-type-kinetic-text .hf-agentic-rule { display: none; }
    .hf-type-focus-word .hf-agentic-copy, .hf-type-kinetic-text .hf-agentic-copy { justify-items: center; text-align: center; }
    .hf-type-focus-word .hf-agentic-title { font-size: clamp(96px, 182.4px, 190px); font-weight: 950; letter-spacing: 0.01em; line-height: 0.95; text-transform: uppercase; }
    .hf-type-kinetic-text .hf-agentic-kinetic { justify-content: center; }
    /* ── Registry VARIANTS, wired to the live agentic markup ──
       Overlays render through .hf-agentic-* (not the old .hf-copy-shell), so the
       per-variant looks the AI picks (mg.subType → hf-variant-X, already on the
       element) were rendering identically. These rules restore each variant's
       distinct identity by targeting the agentic structure. */
    /* lowerThird: bar(default)/box/underline/banner/glass/split */
    .hf-type-lower-third.hf-variant-box .hf-agentic-stage { grid-template-columns: minmax(0, 1fr); }
    .hf-type-lower-third.hf-variant-box .hf-agentic-rule { display: none; }
    .hf-type-lower-third.hf-variant-box .hf-agentic-copy { border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 38%); background: color-mix(in srgb, var(--hf-bg), transparent 6%); }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-stage { grid-template-columns: minmax(0, 1fr); justify-items: start; }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-rule { display: none; }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-copy { justify-self: start; width: fit-content; max-width: min(1180px, 100%); padding: 14px 8px 28px; background: transparent; box-shadow: none; backdrop-filter: none; border-radius: 0; }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-copy:after { content: ""; position: absolute; left: 8px; bottom: 10px; width: 96px; height: 3px; background: var(--hf-accent); }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-title { line-height: 1.04; }
    .hf-type-lower-third.hf-variant-banner.hf-agentic-layout-lower-third { left: 0; right: 0; bottom: 74px; }
    .hf-type-lower-third.hf-variant-banner .hf-agentic-stage { grid-template-columns: minmax(0, 1fr); }
    .hf-type-lower-third.hf-variant-banner .hf-agentic-rule { display: none; }
    .hf-type-lower-third.hf-variant-banner .hf-agentic-copy { padding-left: 130px; border-radius: 0; background: linear-gradient(90deg, var(--hf-bg), color-mix(in srgb, var(--hf-bg), transparent 22%), transparent); border-top: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 45%); }
    .hf-type-lower-third.hf-variant-glass .hf-agentic-copy { background: color-mix(in srgb, var(--hf-bg), transparent 26%); border: var(--hf-stroke) solid rgba(255,255,255,0.18); backdrop-filter: blur(28px) saturate(1.18); }
    /* callout: standard(default Quote Box)/minimal/accent — focus-panel layout
       A 6px coloured bar on the variant literally named "minimal" was a
       contradiction as well as a cliché. It now gets a short rule ABOVE the copy,
       the way a pull quote is ruled in print. */
    .hf-type-callout.hf-variant-minimal .hf-agentic-copy { position: relative; background: transparent; border: 0; border-radius: 0; box-shadow: none; backdrop-filter: none; padding: 30px 30px 12px; }
    .hf-type-callout.hf-variant-minimal .hf-agentic-copy:after { content: ""; position: absolute; left: 50%; top: 0; transform: translateX(-50%); width: 92px; height: 3px; background: var(--hf-accent); }
    .hf-type-callout.hf-variant-accent .hf-agentic-copy { background: color-mix(in srgb, var(--hf-accent), transparent 86%); border-color: color-mix(in srgb, var(--hf-accent), transparent 46%); }
    /* "Accent Bar" is the variant's registry label, not a licence to draw a bar
       down the edge. The accent here is the tinted panel plus a heavier rule over
       the copy — the variant still reads louder than minimal, without the stripe. */
    .hf-type-callout.hf-variant-accent .hf-agentic-copy:after { content: ""; position: absolute; left: 50%; top: 0; transform: translateX(-50%); width: 120px; height: 4px; background: var(--hf-accent); }
    /* headline: standard/stamp/typewriter — center-stack layout */
    .hf-type-headline.hf-variant-stamp .hf-agentic-copy { transform: rotate(-2.5deg); }
    .hf-type-headline.hf-variant-stamp .hf-agentic-title { display: inline-block; padding: 14px 32px; border: 6px solid var(--hf-primary); text-transform: uppercase; box-shadow: 0 0 0 4px color-mix(in srgb, var(--hf-bg), transparent 30%); }
    .hf-type-headline.hf-variant-typewriter .hf-agentic-title { font-family: var(--hf-mono-font, var(--hf-body-font)); letter-spacing: 0.02em; text-transform: none; }
    /* statCounter: standard(default)/ticker/ring — data-focus layout */
    .hf-type-stat-counter.hf-variant-ticker .hf-agentic-title { display: inline-block; padding: 10px 30px; border-radius: 14px; background: color-mix(in srgb, var(--hf-bg), transparent 8%); border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 40%); letter-spacing: 0.08em; font-variant-numeric: tabular-nums; }
    .hf-type-stat-counter.hf-variant-ring .hf-agentic-copy { width: 440px; height: 440px; place-content: center; justify-items: center; text-align: center; border-radius: 50%; border: 14px solid color-mix(in srgb, var(--hf-primary), transparent 12%); box-shadow: inset 0 0 0 10px color-mix(in srgb, var(--hf-bg), transparent 30%), 0 0 60px color-mix(in srgb, var(--hf-primary), transparent 60%); background: radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--hf-bg), transparent 10%), color-mix(in srgb, var(--hf-bg), transparent 40%)); }
    .hf-type-stat-counter.hf-variant-ring .hf-agentic-title { font-size: clamp(72px, 134.4px, 132px); }
    /* kineticText glitch variant gets a chromatic shadow (other kinetic variants differ via entrance animation) */
    .hf-type-kinetic-text.hf-variant-glitch .hf-agentic-word { text-shadow: 3px 0 color-mix(in srgb, var(--hf-accent), transparent 20%), -3px 0 color-mix(in srgb, var(--hf-primary), transparent 20%); }
    .hf-agentic-layout-evidence-board .hf-agentic-stage { align-content: center; }
    .hf-agentic-layout-evidence-board .hf-agentic-copy { max-width: 1180px; }
    .hf-agentic-layout-evidence-board .hf-agentic-items { margin-top: 10px; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); }
    .hf-agentic-layout-data-focus .hf-agentic-stage { justify-items: center; text-align: center; }
    /* 760px is 40% of the frame — a solid accent band that wide stops reading as
       a rule and starts reading as a progress bar. A stat needs a short cap. */
    .hf-agentic-layout-data-focus .hf-agentic-rule { height: 5px; width: min(280px, 18vw); }
    .hf-agentic-layout-data-focus .hf-agentic-title { font-size: clamp(80px, 153.6px, 154px); color: var(--hf-primary); }
    .hf-agentic-layout-split-panel .hf-agentic-stage { grid-template-columns: minmax(520px, 0.75fr) minmax(500px, 1fr); align-items: center; gap: 52px; }
    /* The split panel's first column is the panel side; the mark sits at its top
       as a masthead rule. It used to be a 420px glowing spine, which is the same
       tell at its largest. Column widths are unchanged. */
    .hf-agentic-layout-split-panel .hf-agentic-rule { width: 168px; height: 5px; align-self: start; }
    .hf-agentic-layout-split-panel .hf-agentic-items { grid-template-columns: 1fr; }
    .hf-agentic-layout-map-explainer .hf-agentic-stage { align-content: end; padding-bottom: 82px; }
    .hf-agentic-layout-map-explainer .hf-agentic-copy { max-width: 1180px; padding: 24px 34px 28px 42px; background: color-mix(in srgb, var(--hf-bg), transparent 18%); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); backdrop-filter: blur(18px); }
    .hf-agentic-layout-map-explainer .hf-agentic-copy:after { content: ""; position: absolute; left: 20px; top: 28px; width: 3px; height: 34px; background: var(--hf-primary); }
    .hf-agentic-safe-bottom-right .hf-agentic-stage { justify-items: end; text-align: right; }
    .hf-agentic-safe-top-left .hf-agentic-stage { align-content: start; justify-items: start; }
    .hf-agentic-safe-top-right .hf-agentic-stage { align-content: start; justify-items: end; text-align: right; }
    .hf-agentic-safe-center-right .hf-agentic-stage { justify-items: end; text-align: right; }
    .hf-agentic-density-dense .hf-agentic-title, .hf-agentic-density-compact .hf-agentic-title { font-size: clamp(48px, 88.32px, 82px); }
    .hf-agentic-density-dense .hf-agentic-subtitle, .hf-agentic-density-compact .hf-agentic-subtitle { font-size: 26px; }
    .hf-agentic-text-minimal .hf-agentic-kicker, .hf-agentic-text-minimal .hf-agentic-subtitle, .hf-agentic-text-keyword .hf-agentic-subtitle { display: none; }
    .hf-agentic-text-data .hf-agentic-title { color: var(--hf-primary); }
    .hf-agentic-emphasis-pulse .hf-agentic-title, .hf-agentic-emphasis-glow .hf-agentic-title { text-shadow: 0 0 26px color-mix(in srgb, var(--hf-primary), transparent 52%), 0 8px 38px rgba(0,0,0,0.46); }
    /* Urgency reads as a longer, heavier, hotter mark — not as a halo. A glow
       around a 4px rule just blurs it, and on a compressed upload it smears. */
    .hf-agentic-emphasis-urgent .hf-agentic-rule { width: 196px; height: 7px; background: var(--hf-accent); }
    .hf-agentic-emphasis-elegant .hf-agentic-copy { gap: 18px; }
    .hf-card-outline .hf-copy-shell, .hf-card-outline .hf-stat-card, .hf-card-outline .hf-item { background: transparent; border-color: color-mix(in srgb, var(--hf-primary), transparent 38%); box-shadow: none; backdrop-filter: none; }
    .hf-card-transparent .hf-agentic-copy, .hf-card-transparent .hf-copy-shell, .hf-card-transparent .hf-stat-card, .hf-card-transparent .hf-item { background: transparent !important; border-color: transparent !important; box-shadow: none !important; backdrop-filter: none !important; }
    .hf-agentic-typewriter { display: inline-block; max-width: 100%; clip-path: inset(0 100% 0 0); }
    .hf-agentic-word-cascade .hf-agentic-word { display: inline-block; transform-origin: 50% 100%; will-change: transform, opacity; }
    .hf-card-glass .hf-copy-shell, .hf-card-glass .hf-stat-card, .hf-card-glass .hf-item { background: color-mix(in srgb, var(--hf-bg), transparent 30%); border-color: rgba(255,255,255,0.18); box-shadow: var(--hf-shadow); backdrop-filter: blur(28px) saturate(1.18); }
    .hf-style-minimal { text-shadow: none; }
    .hf-style-minimal .hf-copy-shell, .hf-style-minimal .hf-template-stage, .hf-style-minimal .hf-grid-stage, .hf-style-minimal .hf-data-stage, .hf-style-minimal .hf-list-stage { background: color-mix(in srgb, var(--hf-bg), transparent 42%); box-shadow: none; }
    .hf-style-bold .hf-title, .hf-style-bold .hf-item-label, .hf-style-bold .hf-stat-value { text-transform: uppercase; }
    .hf-style-neon .hf-copy-shell, .hf-style-neon .hf-stat-card, .hf-style-neon .hf-item { box-shadow: 0 0 0 var(--hf-stroke) color-mix(in srgb, var(--hf-primary), transparent 32%), 0 0 42px color-mix(in srgb, var(--hf-primary), transparent 58%); }
    .hf-style-cinematic .hf-title { letter-spacing: 0; }
    .hf-style-cinematic .hf-template-shade, .hf-style-cinematic .hf-copy-shell { background: linear-gradient(90deg, rgba(2,6,23,0.82), rgba(2,6,23,0.32), rgba(2,6,23,0.06)); }
    .hf-style-elegant .hf-copy-shell, .hf-style-elegant .hf-template-stage { border-color: color-mix(in srgb, var(--hf-accent), transparent 35%); }
    .hf-type-lower-third { left: 126px; right: 126px; bottom: 92px; }
    .hf-type-lower-third .hf-copy-shell { --hf-mark: var(--hf-accent); background: linear-gradient(90deg, var(--hf-bg), color-mix(in srgb, var(--hf-bg), transparent 28%), color-mix(in srgb, var(--hf-bg), transparent 78%)); }
    .hf-type-lower-third .hf-title { font-size: 72px; }
    /* The underline variant's whole identity IS the rule, so it keeps one — but a
       SHORT drawn rule under the first word or two, the way a masthead is ruled,
       instead of a border stretched the full width of the card. */
    .hf-type-lower-third.hf-variant-underline .hf-copy-shell { display: inline-grid; width: fit-content; max-width: 100%; box-sizing: border-box; padding: 18px 0 28px; border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; }
    .hf-type-lower-third.hf-variant-underline .hf-copy-shell:after { left: 0; top: auto; bottom: 12px; width: 96px; height: 3px; }
    .hf-type-lower-third.hf-variant-underline .hf-title { font-size: 68px; }
    .hf-type-lower-third.hf-variant-box { left: 116px; right: auto; width: 980px; }
    .hf-type-lower-third.hf-variant-box .hf-copy-shell { border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 35%); }
    .hf-type-lower-third.hf-variant-banner { left: 0; right: 0; bottom: 78px; }
    /* The banner is edge-to-edge, so its hairline top rule is already the mark —
       a second tick floating in the left bleed would just be noise. */
    .hf-type-lower-third.hf-variant-banner .hf-copy-shell { padding-left: 160px; border-radius: 0; border-top: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 45%); background: linear-gradient(90deg, var(--hf-bg), color-mix(in srgb, var(--hf-bg), transparent 20%), transparent); }
    .hf-type-lower-third.hf-variant-banner .hf-copy-shell:after { display: none; }
    .hf-type-lower-third.hf-variant-glass .hf-copy-shell { background: color-mix(in srgb, var(--hf-bg), transparent 24%); border: var(--hf-stroke) solid rgba(255,255,255,0.18); backdrop-filter: blur(28px) saturate(1.18); }
    /* The split variant used to draw a 12px full-height glowing spine as its own
       grid column — the side-tab tell, again. What actually makes this variant
       read as "split" is the card's left-edge accent WASH, which is already in
       the background gradient below. So the column is gone and the spine is a
       short rule over the copy; the shared tick stays off so the two don't
       double up. */
    .hf-type-lower-third.hf-variant-split .hf-copy-shell { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; background: linear-gradient(90deg, color-mix(in srgb, var(--hf-accent), transparent 12%), var(--hf-bg) 14%, transparent); }
    .hf-type-lower-third.hf-variant-split .hf-copy-shell:before { content: ""; width: 120px; height: 3px; background: var(--hf-accent); }
    .hf-type-lower-third.hf-variant-split .hf-copy-shell:after { display: none; }
    .hf-type-headline, .hf-type-focus-word, .hf-type-typewriter, .hf-type-stat-counter, .hf-type-kinetic-text { left: 160px; right: 160px; top: 50%; transform: translateY(-50%); text-align: center; }
    /* A centred headline card gets a short centred rule under it, not an 8px
       border stretched across 1520px. */
    /* The plate used to carry a soft coloured radial glow behind it. Nothing in
       the physical world glows from behind a card, which is why that look reads
       as generated on sight — and it was redundant here anyway: the 82%-opaque
       theme plate below it is what actually separates the text from the footage.
       What replaces it is a shallow one-direction tonal shift, i.e. a flat
       surface lit from above, which is what a real card does. */
    .hf-type-headline .hf-copy-shell, .hf-type-focus-word .hf-copy-shell { display: inline-block; min-width: 820px; max-width: 1520px; padding: 48px 70px 54px; background: linear-gradient(176deg, color-mix(in srgb, var(--hf-text), transparent 96%), transparent 62%), color-mix(in srgb, var(--hf-bg), transparent 18%); }
    .hf-type-headline .hf-copy-shell:after, .hf-type-focus-word .hf-copy-shell:after { left: 50%; top: auto; bottom: 26px; width: 88px; height: 3px; transform: translateX(-50%); }
    .hf-stat-card { display: inline-grid; gap: 12px; padding: 42px 58px; background: var(--hf-bg); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 58%); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); }
    .hf-stat-value { font-family: var(--hf-heading-font); font-size: 120px; line-height: 0.92; font-weight: 950; color: var(--hf-primary); }
    .hf-stat-label { font-family: var(--hf-heading-font); font-size: 42px; font-weight: 850; color: var(--hf-text); }
    .hf-fullscreen { inset: 0; width: 100%; height: 100%; transform: none; }
    /* The backdrop behind card media. It shows through wherever the media does
       not cover, so on a light theme a slate-950 plate was a black rectangle in
       the middle of a cream video. Follows the theme, with a neutral near-black
       only as the last resort. */
    .hf-bg-media { position: absolute; inset: 0; opacity: 0; pointer-events: none; z-index: 30; transform-origin: center center; background: var(--hf-surface, #0e0e10); }
    .hf-template { display: grid; place-items: center; overflow: hidden; }
    /* TEMPLATE FALLBACK GROUND — shown behind a template card when no media
       arrived. It used to be graph-paper grid + cyan diagonals + violet crosshair
       lines + two skewed scanline boxes, which is the generated-tech-dashboard
       wallpaper in full. A card with no footage behind it should read as a quiet,
       lit surface, so it is now a theme-derived wash with a single raking light
       and one deliberate rule — the way a gaffer lights a blank wall. */
    .hf-template-fallback-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; background: linear-gradient(118deg, color-mix(in srgb, var(--hf-surface), #000 18%) 0%, color-mix(in srgb, var(--hf-surface), #000 52%) 62%, color-mix(in srgb, var(--hf-surface), #000 72%) 100%); }
    .hf-template-fallback-field { position: absolute; inset: -12%; background-image: linear-gradient(104deg, color-mix(in srgb, var(--hf-text), transparent 94%) 0%, transparent 34%, transparent 66%, color-mix(in srgb, var(--hf-text), transparent 97%) 100%); transform: rotate(-6deg) scale(1.08); opacity: 0.8; }
    .hf-template-fallback-lines { position: absolute; left: 118px; bottom: 22%; width: 210px; height: 4px; background: color-mix(in srgb, var(--hf-accent), transparent 34%); }
    .hf-template-fallback-label { position: absolute; right: 84px; bottom: 70px; max-width: 760px; color: rgba(226,232,240,0.13); font-family: var(--hf-heading-font); font-size: 54px; line-height: 0.96; font-weight: 950; text-transform: uppercase; text-align: right; }
    .hf-template-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(2,6,23,0.58), rgba(2,6,23,0.24), rgba(2,6,23,0.08)); z-index: 0; }
    .hf-has-bg .hf-template-shade { background: radial-gradient(circle at 70% 50%, rgba(2,6,23,0.04), rgba(2,6,23,0.36) 72%), linear-gradient(90deg, rgba(2,6,23,0.50), rgba(2,6,23,0.16), rgba(2,6,23,0.04)); }
    /* hf-no-bg means there is NO footage under this shade, so it stops being a
       wash and becomes the surface the card's text sits on. The hf-has-bg
       sibling below is a genuine scrim over the creator's media and stays
       neutral on purpose.
       No centred radial glow here either — see the note on the agentic shade
       above. A different angle from that one on purpose: two families lit from
       the same corner start to look stamped out of one mould. */
    .hf-no-bg .hf-template-shade { background: linear-gradient(146deg, color-mix(in srgb, var(--hf-bg), var(--hf-primary) 12%), color-mix(in srgb, var(--hf-bg), #000 6%) 54%, color-mix(in srgb, var(--hf-bg), #000 16%)); }
    .hf-chapter-rule { position: absolute; left: 178px; top: 194px; bottom: 300px; width: 9px; background: linear-gradient(180deg, var(--hf-primary), var(--hf-accent)); box-shadow: 0 0 34px color-mix(in srgb, var(--hf-primary), transparent 55%); z-index: 1; }
    .hf-chapter-copy { position: absolute; left: 216px; top: 384px; z-index: 2; max-width: 1040px; }
    .hf-chapter-copy .hf-title { font-size: 92px; line-height: 0.98; }
    .hf-template.hf-variant-minimal .hf-template-shade { background: linear-gradient(90deg, rgba(2,6,23,0.34), rgba(2,6,23,0.06), transparent); }
    .hf-template.hf-variant-minimal .hf-chapter-rule { top: 236px; bottom: 318px; width: 7px; }
    .hf-template.hf-variant-minimal .hf-chapter-copy { top: 420px; max-width: 1180px; }
    .hf-template.hf-variant-minimal .hf-kicker { display: none; }
    .hf-template.hf-variant-cinematic .hf-template-shade { background: radial-gradient(circle at 68% 52%, transparent 0 38%, rgba(2,6,23,0.34) 74%), linear-gradient(90deg, rgba(2,6,23,0.78), rgba(2,6,23,0.26), rgba(2,6,23,0.02)); }
    .hf-template.hf-variant-cinematic .hf-chapter-copy .hf-title { font-size: 104px; max-width: 1280px; }
    .hf-template.hf-variant-cinematic .hf-chapter-rule { top: 170px; bottom: 250px; width: 11px; }
    .hf-template.hf-variant-standard .hf-chapter-copy { top: 382px; }
    .hf-template.hf-variant-overlay .hf-template-stage { align-content: end; padding-bottom: 120px; background: linear-gradient(0deg, rgba(2,6,23,0.76), rgba(2,6,23,0.12) 64%, transparent); }
    .hf-template.hf-variant-sidebar .hf-template-stage { width: 720px; right: auto; padding: 96px 72px; background: color-mix(in srgb, var(--hf-bg), transparent 6%); border-right: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 45%); }
    .hf-template.hf-variant-splitpanel .hf-template-stage, .hf-template.hf-variant-sidebyside .hf-template-stage { grid-template-columns: minmax(520px, 0.72fr) 1fr; align-items: center; }
    .hf-template.hf-variant-numbered .hf-item-value { font-size: 52px; color: var(--hf-accent); }
    .hf-template.hf-variant-collage .hf-template-items { grid-template-columns: repeat(3, minmax(220px, 1fr)); transform: rotate(-1.2deg); }
    .hf-template.hf-variant-collage .hf-item:nth-child(even) { transform: rotate(1.4deg) translateY(18px); }
    .hf-template.hf-variant-stacked .hf-template-stage { align-content: center; justify-items: start; max-width: 1120px; }
    .hf-template.hf-variant-single .hf-template-items { display: none; }
    /* The stage LAYS OUT the card (grid + gap), so it is the card's paper, not
       a wash over footage - the hf-has-bg and hf-transparent-bg overrides below
       take those cases. Paper has to come from the theme. */
    .hf-template-stage, .hf-grid-stage, .hf-data-stage, .hf-list-stage { position: absolute; inset: 0; z-index: 2; padding: 105px 120px; display: grid; align-content: center; gap: 28px; background: linear-gradient(120deg, color-mix(in srgb, var(--hf-bg), transparent 26%), color-mix(in srgb, var(--hf-bg), transparent 88%)); }
    .hf-has-bg .hf-template-stage, .hf-has-bg .hf-grid-stage, .hf-has-bg .hf-data-stage, .hf-has-bg .hf-list-stage { background: linear-gradient(90deg, rgba(2,6,23,0.46), rgba(2,6,23,0.12), rgba(2,6,23,0)); }
    .hf-transparent-bg .hf-template-shade, .hf-transparent-bg .hf-agentic-shade { display: none; }
    .hf-transparent-bg .hf-template-stage, .hf-transparent-bg .hf-grid-stage, .hf-transparent-bg .hf-data-stage, .hf-transparent-bg .hf-list-stage { background: transparent; }
    .hf-template.hf-transparent-bg.hf-variant-overlay .hf-template-stage, .hf-template.hf-transparent-bg.hf-variant-sidebar .hf-template-stage { background: transparent; border-color: transparent; }
    .hf-transparent-bg .hf-copy-shell, .hf-transparent-bg .hf-stat-card, .hf-transparent-bg .hf-item, .hf-transparent-bg .hf-agentic-copy, .hf-transparent-bg .hf-agentic-item { background: transparent; box-shadow: none; backdrop-filter: none; }
    .hf-template-items, .hf-listicle-grid-items, .hf-ranked-items, .hf-timeline-items { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; max-width: 1500px; }
    .hf-template.hf-type-stat-card.hf-variant-single .hf-template-items { display: grid; grid-template-columns: minmax(420px, 760px); justify-content: center; width: min(760px, 82vw); max-width: 760px; }
    .hf-template.hf-type-stat-card.hf-variant-single .hf-item { padding: 48px 56px; text-align: center; }
    .hf-template.hf-type-stat-card.hf-variant-single .hf-item-value { font-size: clamp(88px, 172.8px, 168px); line-height: 0.9; }
    .hf-template.hf-type-stat-card.hf-variant-single .hf-item-label { font-size: clamp(34px, 57.6px, 58px); }
    .hf-item { padding: 20px 24px; background: color-mix(in srgb, var(--hf-surface), transparent 16%); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 68%); border-radius: var(--hf-radius); box-shadow: 0 14px 40px rgba(0,0,0,0.24); }
    .hf-item-value { display: block; color: var(--hf-primary); font-family: var(--hf-heading-font); font-size: 34px; font-weight: 900; }
    .hf-item-label { display: block; margin-top: 8px; font-family: var(--hf-heading-font); font-size: 28px; font-weight: 800; }
    .hf-item-subtext { display: block; margin-top: 8px; color: var(--hf-muted); font-size: 24px; line-height: 1.25; }
    .hf-type-listicle-grid.hf-variant-strip .hf-listicle-grid-items { grid-template-columns: 1fr; max-width: 1200px; }
    .hf-type-listicle-grid.hf-variant-strip .hf-item { display: grid; grid-template-columns: 120px 1fr; align-items: center; }
    .hf-type-listicle-grid.hf-variant-stack .hf-listicle-grid-items { grid-template-columns: repeat(2, minmax(360px, 1fr)); }
    /* The seam down the middle of a split comparison. Both ENDS already took the
       theme; only the gutter was slate, so the one place the eye lands to read
       "these two are opposed" was the one place that belonged to no video. */
    .hf-type-comparison-card.hf-variant-split .hf-comparison-wrap { grid-template-columns: minmax(0, 1fr) 96px minmax(0, 1fr); background: linear-gradient(90deg, color-mix(in srgb, var(--hf-primary), transparent 84%), color-mix(in srgb, var(--hf-bg), #000 12%), color-mix(in srgb, var(--hf-accent), transparent 84%)); }
    .hf-type-comparison-card.hf-variant-stacked .hf-comparison-wrap { grid-template-columns: 1fr; gap: 18px; }
    .hf-type-comparison-card.hf-variant-stacked .hf-compare-vs { justify-self: center; width: 86px; height: 86px; }
    .hf-type-progress-tracker.hf-variant-dots .hf-progress-rail { display: flex; height: 24px; gap: 16px; background: transparent; overflow: visible; }
    .hf-type-progress-tracker.hf-variant-dots .hf-progress-rail:before { content: ""; display: block; width: 24px; height: 24px; border-radius: 50%; background: var(--hf-primary); box-shadow: 54px 0 0 color-mix(in srgb, var(--hf-primary), transparent 18%), 108px 0 0 color-mix(in srgb, var(--hf-primary), transparent 36%), 162px 0 0 color-mix(in srgb, var(--hf-primary), transparent 54%); }
    .hf-type-progress-tracker.hf-variant-fraction .hf-progress-rail { height: 6px; }
    /* The matte the basemap tiles sit on, and what shows at the edges while the
       map camera moves. Opaque black tinted toward the theme, so the void reads
       as part of THIS video instead of the same blue-black in all 8 themes. */
    .hf-type-map-chart { overflow: hidden; background: color-mix(in srgb, #000, var(--hf-primary) 7%); }
    .hf-map-world { position: absolute; top: 0; left: 0; will-change: transform; transform-origin: 0 0; z-index: 0; }
    .hf-map-base { width: 100%; height: 100%; display: block; }
    .hf-map-svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
    .hf-map-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #07111f; z-index: 0; }
    .hf-map-vignette { position: absolute; inset: 0; background: radial-gradient(circle at 50% 50%, transparent 36%, rgba(2,6,23,0.44) 100%); z-index: 1; }
    .hf-map-labels { position: absolute; left: 104px; top: 84px; display: flex; flex-wrap: wrap; gap: 14px; z-index: 2; }
    .hf-map-labels span { padding: 10px 16px; background: var(--hf-bg); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 45%); color: var(--hf-text); font-weight: 850; font-size: 24px; }
    .hf-map-caption { position: absolute; left: 104px; right: 104px; bottom: 86px; z-index: 3; padding: 26px 34px 26px 44px; background: var(--hf-bg); }
    .hf-map-caption:after { content: ""; position: absolute; left: 20px; top: 30px; width: 4px; height: 28px; background: var(--hf-primary); }
    .hf-map-caption .hf-title { font-size: 58px; }
    .hf-map-backup { position: absolute; inset: 0; z-index: 0; opacity: 1; pointer-events: none; transition: opacity 0.16s linear; }
    .hf-bg-loaded .hf-map-backup { opacity: 0; }
    .hf-bg-error .hf-map-backup { opacity: 1; }
    /* MAP GROUND — every colour here used to be a hardcoded cyan/teal/slate
       literal, so a crime video and a nature video drew the same glowing sci-fi
       map. The ground, the graticule, the water and the landmass now derive from
       the active theme; only the pin stays deliberately red, because a map pin
       reading as "here" is a convention worth keeping. */
    .hf-fallback-map { position: absolute; inset: 0; background: linear-gradient(168deg, color-mix(in srgb, var(--hf-surface), #000 26%), color-mix(in srgb, var(--hf-surface), #000 66%)); overflow: hidden; }
    .hf-map-grid { position: absolute; inset: -20%; background-image: linear-gradient(color-mix(in srgb, var(--hf-text), transparent 88%) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--hf-text), transparent 88%) 1px, transparent 1px); background-size: 72px 72px; transform: rotate(-8deg); }
    .hf-map-route { position: absolute; left: 12%; right: 12%; top: 50%; height: 5px; background: linear-gradient(90deg, transparent, var(--hf-primary) 24%, var(--hf-accent) 76%, transparent); }
    .hf-map-fallback-labels { position: absolute; left: 120px; bottom: 120px; display: flex; gap: 14px; flex-wrap: wrap; }
    .hf-map-fallback-labels span { padding: 12px 18px; background: color-mix(in srgb, var(--hf-bg), transparent 20%); border: 1px solid color-mix(in srgb, var(--hf-text), transparent 84%); font-size: 26px; font-weight: 850; }
    .hf-country-map { position: absolute; inset: 0; width: 100%; height: 100%; background: linear-gradient(172deg, color-mix(in srgb, var(--hf-surface), #000 24%), color-mix(in srgb, var(--hf-surface), #000 64%)); z-index: 0; }
    .hf-map-water { fill: color-mix(in srgb, var(--hf-surface), #000 58%); }
    .hf-country-fill { fill: color-mix(in srgb, var(--hf-primary), transparent 72%); stroke: none; transform-box: fill-box; transform-origin: center; }
    .hf-country-line { fill: none; stroke: color-mix(in srgb, var(--hf-text), transparent 34%); stroke-width: 2.2; vector-effect: non-scaling-stroke; }
    .hf-country-route { fill: none; stroke: var(--hf-primary); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 900; stroke-dashoffset: 900; filter: drop-shadow(0 0 16px color-mix(in srgb, var(--hf-primary), transparent 42%)); }
    .hf-country-pin circle { fill: #ef4444; stroke: #fff; stroke-width: 3; filter: drop-shadow(0 0 14px rgba(239,68,68,0.66)); }
    /* Every rule around this one already reads the theme; this one was still
       slate-50 on slate-950, so map pin labels were the one element that ignored
       the theme — and on a light theme they inverted against their own map. */
    .hf-country-pin text { fill: var(--hf-text, #f2efe9); font-size: 30px; font-weight: 900; paint-order: stroke; stroke: color-mix(in srgb, var(--hf-surface, #0e0e10), #000 30%); stroke-width: 7px; stroke-linejoin: round; text-transform: uppercase; }
    /* The card's own surfaces, so they take theme tokens. These were the last
       fullscreen renderers still painting hardcoded slate: the card looked
       byte-identical in all 8 themes and therefore belonged to no video. */
    .hf-comparison-stage { position: absolute; inset: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 26px; padding: 92px 118px 72px; overflow: hidden; background: linear-gradient(96deg, color-mix(in srgb, var(--hf-bg), var(--hf-primary) 10%), color-mix(in srgb, var(--hf-bg), transparent 24%)); }
    .hf-comparison-wrap { position: relative; min-width: 0; width: 100%; height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 118px minmax(0, 1fr); align-items: stretch; gap: 24px; padding: 28px; overflow: hidden; }
    .hf-compare-side { min-width: 0; min-height: 0; display: grid; place-items: center; padding: 34px; overflow: hidden; overflow-wrap: anywhere; font-size: clamp(38px, 61.44px, 62px); line-height: 1.02; font-weight: 900; background: color-mix(in srgb, var(--hf-surface), transparent 10%); border: 0; border-top: var(--hf-stroke, 2px) solid color-mix(in srgb, var(--hf-primary), transparent 40%); text-align: center; }
    /* A comparison whose two halves are painted identically communicates
       nothing - opposition IS the graphic's job. The two sides take the two
       ends of the theme (primary vs accent) at equal structural weight, so the
       contrast is read as a deliberate pairing rather than a winner. Kept
       radius-free on purpose: a painted background plus a corner radius is what
       the nested-cards rule counts as a card, and the shell already wraps these. */
    .hf-comparison-wrap > .hf-compare-side:first-child { background: color-mix(in srgb, var(--hf-surface), var(--hf-primary) 16%); border-top-color: var(--hf-primary); }
    .hf-comparison-wrap > .hf-compare-side:last-child { background: color-mix(in srgb, var(--hf-surface), var(--hf-accent) 16%); border-top-color: var(--hf-accent); }
    .hf-compare-vs { align-self: center; justify-self: center; display: grid; place-items: center; width: 108px; height: 108px; border-radius: 50%; background: linear-gradient(135deg, var(--hf-primary), var(--hf-accent)); font-size: 36px; font-weight: 950; }
    /* Secondary text under a comparison — the muted role, so it takes the muted
       token. It was slate-200, the last hardcoded literal of the palette already
       cleaned off the stage root. */
    .hf-comparison-note { position: relative; min-width: 0; max-width: 1320px; justify-self: center; overflow-wrap: anywhere; font-size: clamp(24px, 32.64px, 32px); line-height: 1.2; color: var(--hf-muted, rgba(238,235,228,0.88)); text-align: center; }
    .hf-layout-density-compact .hf-comparison-stage { padding: 78px 104px 64px; }
    .hf-layout-density-compact .hf-comparison-wrap { grid-template-columns: minmax(0, 1fr) 94px minmax(0, 1fr); gap: 18px; padding: 22px; }
    .hf-layout-density-compact .hf-compare-side { padding: 26px; font-size: clamp(34px, 53.76px, 54px); }
    .hf-layout-density-compact .hf-compare-vs { width: 88px; height: 88px; font-size: 30px; }
    /* Full-bleed and near-opaque, so this is a surface the viewer reads as the
       graphic's own paper - not a scrim over footage. It takes the theme. */
    .hf-safe-layout-backdrop { position: absolute; inset: 0; background: linear-gradient(125deg, color-mix(in srgb, var(--hf-bg), var(--hf-primary) 7%), color-mix(in srgb, var(--hf-bg), var(--hf-accent) 5%)); }
    .hf-safe-layout-stage { position: absolute; inset: 0; display: grid; place-items: center; padding: 96px 120px; overflow: hidden; }
    .hf-safe-layout-card, .hf-safe-layout-overlay, .hf-safe-stat-overlay { position: relative; box-sizing: border-box; min-width: 0; width: min(1320px, 100%); max-height: 100%; display: grid; gap: 24px; padding: 48px 58px; overflow: hidden; background: color-mix(in srgb, var(--hf-bg), transparent 8%); border: 2px solid color-mix(in srgb, var(--hf-primary), transparent 45%); border-radius: max(18px, var(--hf-radius)); box-shadow: var(--hf-shadow); }
    .hf-safe-layout-overlay { width: min(920px, 100%); padding: 28px 36px; }
    .hf-safe-layout-title { min-width: 0; overflow-wrap: anywhere; font-family: var(--hf-heading-font); font-size: clamp(48px, 96px, 92px); line-height: 1.08; padding-block: 0.08em 0.12em; font-weight: 950; color: var(--hf-text); }
    .hf-safe-layout-overlay .hf-safe-layout-title { font-size: clamp(38px, 72.96px, 68px); }
    .hf-safe-layout-subtitle { min-width: 0; overflow-wrap: anywhere; font-size: clamp(24px, 38.4px, 34px); line-height: 1.22; color: var(--hf-muted); }
    .hf-safe-stat-overlay { width: min(760px, 100%); grid-template-columns: auto minmax(0, 1fr); align-items: baseline; gap: 8px 20px; padding: 30px 38px 34px; }
    .hf-safe-stat-value { min-width: 0; overflow-wrap: anywhere; font-family: var(--hf-heading-font); font-size: clamp(58px, 96px, 88px); line-height: 1.08; padding-block: 0.06em 0.1em; font-weight: 950; color: var(--hf-primary); }
    .hf-safe-stat-label { min-width: 0; overflow-wrap: anywhere; font-family: var(--hf-heading-font); font-size: clamp(34px, 57.6px, 54px); line-height: 1.1; padding-block: 0.08em; font-weight: 900; color: var(--hf-text); }
    .hf-safe-stat-overlay .hf-safe-layout-subtitle { grid-column: 1 / -1; }
    .hf-safe-comparison-stage { z-index: 1; }
    .hf-safe-layout-items { min-width: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap: 16px; overflow: hidden; }
    .hf-safe-layout-item { min-width: 0; display: grid; gap: 6px; padding: 18px 20px; overflow: hidden; background: color-mix(in srgb, var(--hf-surface), transparent 12%); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 65%); }
    .hf-safe-layout-item strong, .hf-safe-layout-item span, .hf-safe-layout-item small { min-width: 0; overflow-wrap: anywhere; }
    .hf-safe-layout-item strong { font-family: var(--hf-heading-font); font-size: 34px; color: var(--hf-primary); }
    .hf-safe-layout-item span { font-size: 26px; font-weight: 800; }
    .hf-safe-layout-item small { font-size: 24px; line-height: 1.2; color: var(--hf-muted); }
    .hf-typewriter-line, .hf-kinetic-line { display: flex; justify-content: center; flex-wrap: wrap; gap: 18px; font-size: 92px; line-height: 0.92; font-weight: 950; text-align: center; text-transform: uppercase; }
    .hf-typewriter-line span, .hf-kinetic-line span { display: inline-block; }
    .hf-progress-shell { position: relative; max-width: 1180px; padding: 28px 34px 28px 44px; background: var(--hf-bg); }
    .hf-progress-shell:after { content: ""; position: absolute; left: 20px; top: 32px; width: 4px; height: 30px; background: var(--hf-primary); }
    /* The unfilled half of a bar whose fill is primary->accent. It was a fixed
       slate; the empty track has to come from the same palette as the fill. */
    .hf-progress-rail { margin-top: 26px; height: 18px; overflow: hidden; background: color-mix(in srgb, var(--hf-primary), transparent 78%); }
    .hf-progress-rail span { display: block; width: var(--pct); height: 100%; background: linear-gradient(90deg, var(--hf-primary), var(--hf-accent)); transform-origin: left center; }
    .hf-listicle-counter-badge { display: inline-grid; grid-template-columns: 118px 1fr; gap: 24px; align-items: center; max-width: 1080px; padding: 26px 34px; background: var(--hf-bg); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 58%); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); }
    .hf-listicle-counter-badge span { display: grid; place-items: center; width: 100px; height: 100px; background: linear-gradient(135deg, var(--hf-primary), var(--hf-accent)); font-size: 50px; font-weight: 950; }
    .hf-type-listicle-counter.hf-variant-pill .hf-listicle-counter-badge { border-radius: 999px; }
    /* A ribbon should read as a ribbon: squared off, tinted, capped over the
       number cell — not a rounded card with a coloured stripe glued to its edge. */
    .hf-type-listicle-counter.hf-variant-ribbon .hf-listicle-counter-badge { position: relative; border-radius: 0; border: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--hf-accent), transparent 74%), var(--hf-bg) 30%); }
    .hf-type-listicle-counter.hf-variant-ribbon .hf-listicle-counter-badge:after { content: ""; position: absolute; left: 0; top: 0; width: 118px; height: 5px; background: var(--hf-accent); }
    .hf-type-listicle-counter.hf-variant-minimal .hf-listicle-counter-badge { background: transparent; box-shadow: none; border: 0; }
    .pos-top, .pos-top-left, .pos-top-right { top: 88px; bottom: auto; }
    .pos-center { top: 50%; bottom: auto; transform: translateY(-50%); }
    .pos-bottom, .pos-bottom-left, .pos-bottom-right { bottom: 95px; }
    .pos-top-left, .pos-bottom-left { left: 126px; right: auto; width: 1460px; }
    .pos-top-right, .pos-bottom-right { left: auto; right: 126px; width: 1180px; }
    .hf-fullscreen.pos-top, .hf-fullscreen.pos-top-left, .hf-fullscreen.pos-top-right, .hf-fullscreen.pos-center, .hf-fullscreen.pos-center-left, .hf-fullscreen.pos-center-right, .hf-fullscreen.pos-bottom, .hf-fullscreen.pos-bottom-left, .hf-fullscreen.pos-bottom-right { inset: 0; width: 100%; height: 100%; transform: none; }
    /* Authored overlays are designed on the full 1920x1080 canvas (the comp
       anchors itself in its position zone) — break out of the pos-* boxes.
       transform locked: their container enter is opacity-only by design. */
    .hf-mg[data-hf-authored-overlay] { inset: 0 !important; width: 100% !important; height: 100% !important; transform: none !important; }
    /* Explainer icons (icon-director): small word-synced visuals over footage */
    .hf-scene-icon { position: absolute; width: 260px; height: 260px; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; z-index: 6; pointer-events: none; filter: drop-shadow(0 16px 32px rgba(0,0,0,0.55)); }
    .hf-scene-icon img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .hf-scene-icon svg { width: 84%; height: 84%; }
    /* framed image kind: the whole photograph as a small picture card */
    .hf-scene-icon-framed { width: 400px; height: 270px; transform: rotate(-1.6deg); }
    .hf-scene-icon-framed img { width: 100%; height: 100%; object-fit: cover; border-radius: 10px; border: 4px solid rgba(255,255,255,0.92); box-shadow: 0 22px 48px rgba(0,0,0,0.5); }
    /* Talking-head corner PiP: presenter card over B-roll. opacity/visibility hidden = frame-0 safe (revealed by iconAnims). */
    /* Same mat as .hf-pexplain and for the same reason - these two are twins and
       must stay twins, or the picture-in-picture and the explanation slot end
       up framed differently in the same video. */
    .hf-presenter-pip { position: absolute; width: 30%; aspect-ratio: 16 / 9; opacity: 0; visibility: hidden; z-index: 8; pointer-events: none; border-radius: 14px; overflow: hidden; border: 3px solid color-mix(in srgb, var(--hf-text), transparent 10%); box-shadow: 0 18px 50px var(--hf-shadow-color, rgba(0,0,0,0.55)); }
    .hf-presenter-pip img, .hf-presenter-pip video { width: 100%; height: 100%; object-fit: cover; }
    /* Talking-head SPLIT SCREEN: presenter half + B-roll half (static, frame-0 safe). */
    .hf-scene-frame.hf-scene-split { display: flex; flex-direction: row; }
    .hf-scene-frame.hf-scene-split.is-right { flex-direction: row-reverse; }
    /* The half-frame a presenter or B-roll clip fills. Whatever the clip does
       not cover is this colour, so it is the video's own matte and takes the
       theme rather than a fixed blue-black. */
    .hf-split-panel { position: relative; width: 50%; height: 100%; overflow: hidden; background: color-mix(in srgb, #000, var(--hf-primary) 9%); }
    .hf-split-panel > img, .hf-split-panel > video { width: 100%; height: 100%; object-fit: cover; }
    .hf-split-presenter { box-shadow: 0 0 40px rgba(0,0,0,0.5); z-index: 1; }
    /* Talking-head PRESENTER STAGE: host card on one side + explanation slot (sliding images) on the other. */
    /* The presenter stage's backdrop - the whole frame behind the host card and
       the explanation slot. It is the most visible surface in a talking-head
       video, so it is the last one that should look the same in every theme. */
    .hf-scene-frame.hf-pstage { background: radial-gradient(130% 110% at 28% 18%, color-mix(in srgb, #000, var(--hf-primary) 20%), color-mix(in srgb, #000, var(--hf-primary) 8%)); }
    .hf-pstage .hf-pstage-hostcard { position: absolute; top: 12%; width: 40%; height: 76%; border-radius: 18px; overflow: hidden; box-shadow: 0 26px 70px rgba(0,0,0,0.6); }
    .hf-pstage.is-host-left .hf-pstage-hostcard { left: 5%; }
    .hf-pstage.is-host-right .hf-pstage-hostcard { right: 5%; }
    .hf-pstage .hf-pstage-hostcard > img, .hf-pstage .hf-pstage-hostcard > video { width: 100%; height: 100%; object-fit: cover; }
    .hf-pstage .hf-pstage-slot { position: absolute; top: 16%; width: 46%; height: 68%; }
    .hf-pstage.is-host-left .hf-pstage-slot { right: 4%; }
    .hf-pstage.is-host-right .hf-pstage-slot { left: 4%; }
    /* The explanation slot's mat. The 3px rule was pure white, which reads as a
       stock photo frame on a light theme and as a glaring edge on a dark one -
       var(--hf-text) is whatever the theme uses for maximum contrast, so the
       mat separates the slot in all 8 without ever being someone else's white. */
    .hf-pexplain { position: absolute; inset: 0; opacity: 0; visibility: hidden; border-radius: 14px; overflow: hidden; border: 3px solid color-mix(in srgb, var(--hf-text), transparent 8%); box-shadow: 0 18px 50px var(--hf-shadow-color, rgba(0,0,0,0.55)); background: color-mix(in srgb, #000, var(--hf-primary) 9%); }
    .hf-pexplain > img { width: 100%; height: 100%; object-fit: cover; transform: scale(var(--hf-explain-scale, 1)); }
    .hf-pexplain-svg { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; transform: scale(var(--hf-explain-scale, 1)); }
    .hf-pexplain-svg svg { width: 70%; height: 70%; }
    /* Keyword glow (#18): word-synced emphasis phrase. opacity/visibility default hidden = frame-0 safe. */
    .hf-kw-glow { position: absolute; opacity: 0; visibility: hidden; z-index: 7; pointer-events: none; font-family: var(--hf-heading-font, system-ui, sans-serif); font-weight: 900; font-size: 64px; letter-spacing: -0.01em; text-transform: uppercase; white-space: nowrap; }
    .hf-kw-glow .hf-kw-glow-fill { position: relative; z-index: 2; color: #ffffff; text-shadow: 0 3px 22px rgba(0,0,0,0.8); }
    .hf-kw-glow .hf-kw-glow-layer { position: absolute; left: 0; top: 0; z-index: 1; color: currentColor; opacity: 0; text-shadow: 0 0 18px currentColor, 0 0 40px currentColor; }
    .hf-kw-pos-lower-center { left: 50%; bottom: 190px; transform: translateX(-50%); text-align: center; }
    .hf-kw-pos-upper-center { left: 50%; top: 150px; transform: translateX(-50%); text-align: center; }
    .hf-kw-pos-lower-left { left: 90px; bottom: 200px; }
    .hf-kw-pos-lower-right { right: 90px; bottom: 200px; text-align: right; }
    .hf-icon-pos-top-left { left: 110px; top: 110px; }
    .hf-icon-pos-top-right { right: 110px; top: 110px; }
    .hf-icon-pos-bottom-left { left: 110px; bottom: 150px; }
    .hf-icon-pos-bottom-right { right: 110px; bottom: 150px; }
    .hf-icon-pos-center-left { left: 110px; top: 50%; margin-top: -130px; }
    .hf-icon-pos-center-right { right: 110px; top: 50%; margin-top: -130px; }
    .hf-transition { position: absolute; inset: 0; overflow: hidden; pointer-events: none; opacity: 0; z-index: 80; }
    .hf-transition-slab, .hf-transition-flare { position: absolute; inset: 0; pointer-events: none; }
    .hf-transition-flare { background: radial-gradient(circle at 50% 50%, rgba(255,255,255,0.45), transparent 48%); opacity: 0; mix-blend-mode: screen; }
    .hf-transition-wipe-left .hf-transition-slab, .hf-transition-push-left .hf-transition-slab { background: linear-gradient(90deg, rgba(2,6,23,0), rgba(56,189,248,0.72), rgba(2,6,23,0)); transform: translateX(-110%); }
    .hf-transition-zoom-blur .hf-transition-slab { background: radial-gradient(circle, rgba(255,255,255,0.24), rgba(15,23,42,0.68)); transform: scale(0.86); }
    .hf-transition-light-leak .hf-transition-slab { background: linear-gradient(105deg, rgba(255,110,20,0), rgba(255,150,40,0.82), rgba(255,90,10,0.5), rgba(255,190,70,0.9), rgba(255,110,20,0)); transform: translateX(-120%); mix-blend-mode: screen; filter: saturate(1.25); }
    .hf-transition-glitch .hf-transition-slab { background: repeating-linear-gradient(0deg, rgba(255,255,255,0.16) 0 2px, transparent 2px 8px), linear-gradient(90deg, rgba(239,68,68,0.18), rgba(34,211,238,0.18)); }
    .hf-transition-luma-fade .hf-transition-slab, .hf-transition-dip-black .hf-transition-slab, .hf-transition-crossfade .hf-transition-slab { background: rgba(2,6,23,0.92); }
    .hf-transition-flash-white .hf-transition-slab { background: rgba(255,255,255,0.96); }
    /* Amped light-sweep: hotter orange/amber glow (blue tail dropped), brighter core — reads as a warm fire-glow flare. */
    .hf-transition-light-sweep .hf-transition-slab { background: linear-gradient(105deg, rgba(255,110,20,0), rgba(255,150,40,0.82), rgba(255,90,10,0.5), rgba(255,190,70,0.9), rgba(255,110,20,0)); transform: translateX(-120%); mix-blend-mode: screen; filter: saturate(1.25); }
    .hf-transition-light-sweep .hf-transition-flare { background: radial-gradient(circle at 50% 50%, rgba(255,190,90,0.55), rgba(255,120,30,0.25) 34%, transparent 58%); }
    /* Fire burn: hot flame band (deep red → orange → yellow core) sweeps across, screen-blended; the flare becomes a warm ember-glow core. */
    .hf-transition-fire-burn .hf-transition-slab { background: linear-gradient(100deg, rgba(60,6,0,0) 20%, rgba(190,40,0,0.78) 40%, rgba(255,110,20,0.97) 50%, rgba(255,210,90,0.92) 60%, rgba(120,20,0,0) 80%); transform: translateX(-120%); mix-blend-mode: screen; filter: saturate(1.4) contrast(1.1); }
    .hf-transition-fire-burn .hf-transition-flare { background: radial-gradient(circle at 50% 58%, rgba(255,160,50,0.6), rgba(255,80,10,0.28) 32%, transparent 58%); }
    /* Anamorphic lens flare: a bright vertical light core streaks across; the flare is a thin horizontal blue-white streak flashing through the middle. */
    .hf-transition-lens-flare .hf-transition-slab { background: radial-gradient(ellipse 11% 92% at 50% 50%, rgba(255,255,255,0.98), rgba(150,200,255,0.5) 42%, transparent 70%); transform: translateX(-130%); mix-blend-mode: screen; }
    .hf-transition-lens-flare .hf-transition-flare { background: linear-gradient(0deg, transparent 47%, rgba(120,180,255,0.5) 49%, rgba(255,255,255,0.96) 50%, rgba(120,180,255,0.5) 51%, transparent 53%); mix-blend-mode: screen; }
    .hf-caption { position: absolute; left: 7%; right: 7%; ${captionVisual.placement} display: flex; justify-content: center; text-align: center; opacity: 0; z-index: 60; pointer-events: none; }
    .hf-caption-text { display: inline-block; ${captionVisual.shell} color: ${captionVisual.color}; font-family: var(--hf-caption-font), 'Segoe UI', system-ui, sans-serif; font-weight: ${captionVisual.fontWeight}; font-size: ${captionVisual.fontSize}px; line-height: 1.22; letter-spacing: -0.01em; text-shadow: 0 2px 16px rgba(0,0,0,0.7); max-width: ${captionVisual.maxWidth}px; }
    /* Karaoke word spans (KARAOKE_CAPTIONS opt-in; inert when captions are single-span). Active word lit by the timeline. */
    .hf-cap-word { display: inline; opacity: 0.5; }
${graphicShellCss}
  </style>
</head>
<body>
  <div id="yta-hyperframes" data-composition-id="yta-hyperframes" data-width="1920" data-height="1080" data-start="0" data-duration="${totalDuration.toFixed(3)}" data-visible-transition-count="${transitionOverlays.length}" data-motion-transition-count="${_txMotion}" data-overlay-transition-count="${transitionOverlays.length - _txMotion}">
${sceneTags.join('\n')}
${transitionTags.join('\n')}
${graphicTags.join('\n')}
${captionTags.join('\n')}
${audioTags.join('\n')}
  </div>
  <script src="vendor/gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {};
    const timing = ${timelineData};
    const tl = gsap.timeline({ paused: true });
    let hfActiveTimeline = tl;

    for (const item of timing.sceneAnims) {
      const sel = '#' + CSS.escape(item.id);
      const isOpeningScene = item.start <= 0.001;
      // True crossfade between back-to-back scenes: fade IN over the first 0.2s, and
      // fade OUT STARTING AT the scene's end (overlapping the next scene's fade-in)
      // — NOT before the end. The old code faded out over the last 0.14s while the
      // next faded in over its first 0.12s with no overlap, so at every cut both were
      // ~0 opacity for an instant = a black flash between clips.
      // ── Opacity ownership (transition smoothness) ──
      // IN: a HARD-motion incoming (push/wipe/whip/zoom/spin) arrives FULLY
      // OPAQUE — the geometric move is the transition, so no see-through slide.
      // The 1ms fromTo (not a bare set) guarantees opacity 0 for every frame
      // before the boundary (frame-0 / pre-boundary safe). Everything else keeps
      // the soft 0.2s fade-in.
      if (isOpeningScene) {
        // The first visual is already on-air at frame zero. Starting it at
        // opacity 0 creates a needless black lead-in before ordinary footage.
        // Keep later scenes animated; only frame-zero scenes begin fully shown.
        hfSet(sel, { opacity: 1 }, 0);
      } else if (item._motionIn || item._stageIn) {
        // Appear EXACTLY when the incoming video becomes active (its window start),
        // never before — an opaque container over a not-yet-seeked (black) video
        // paints a 1-frame black flash at the leading edge of the move. The
        // same rule applies after fullscreen graphics so the continuity
        // underlay never leaks through during the stage-to-scene handoff.
        hfFromTo(sel, { opacity: 0 }, { opacity: 1, duration: 0.001, ease: 'none' }, item.start);
      } else {
        hfFromTo(sel, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: 'power1.out' }, item.start);
      }
      // OUT: hold the outgoing footage opaque BENEATH the incoming move/dissolve,
      // then hard-cut once it is fully covered — constant luminance, no premature
      // fade during a slide/wipe/zoom, no dark "breath" at plain cuts.
      if (item._motionOut) {
        hfSet(sel, { opacity: 0 }, (item._motionOutSnapAt != null ? item._motionOutSnapAt : item.start + item.duration));
      } else if (item._coveredOut) {
        hfSet(sel, { opacity: 0 }, item.start + item.duration + 0.24);
      } else if (item.duration > 0.4) {
        // gap before the next scene, or the final scene → keep the graceful fade
        hfTo(sel, { opacity: 0, duration: 0.24, ease: 'power1.inOut' }, item.start + item.duration);
      }
      // Ken Burns (slow zoom/drift) on still-image scenes so they don't sit dead.
      if (item.kenBurns) {
        const kb = item.kenBurns;
        hfFromTo(sel + ' .hf-scene-media',
          { scale: kb.fromScale, xPercent: kb.fromX, yPercent: kb.fromY || 0 },
          { scale: kb.toScale, xPercent: kb.toX, yPercent: kb.toY || 0, duration: item.duration, ease: 'none' },
          item.start);
      }
      // Subject-follow pan (#16): gently ease the cover-crop object-position from→to
      // so a moving subject stays framed. Static "from" is already set inline (frame-0
      // safe); this animates on the master timeline (separate channel from Ken Burns).
      if (item.focusPan) {
        const fp = item.focusPan;
        hfFromTo(sel + ' .hf-scene-media',
          { objectPosition: (fp.fromX * 100).toFixed(1) + '% ' + (fp.fromY * 100).toFixed(1) + '%' },
          { objectPosition: (fp.toX * 100).toFixed(1) + '% ' + (fp.toY * 100).toFixed(1) + '%', duration: item.duration, ease: 'sine.inOut' },
          item.start);
      }
    }

    for (const item of (timing.captionAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      hfFromTo(sel, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out' }, item.start);
      if (item.duration > 0.3) hfTo(sel, { opacity: 0, duration: 0.14, ease: 'power1.in' }, item.start + item.duration - 0.1);
      // Karaoke: dim all words, then light each one at its absolute start time.
      // Timeline-driven so it seeks correctly under frame capture. Only runs when
      // the cue carries per-word timings (KARAOKE_CAPTIONS opt-in).
      if (Array.isArray(item.words) && item.words.length) {
        for (let i = 0; i < item.words.length; i++) {
          const wsel = sel + '-w' + i;
          if (!hfHas(wsel)) continue;
          hfSet(wsel, { opacity: 0.5, color: ${JSON.stringify(captionVisual.color)} }, item.start);
          hfTo(wsel, { opacity: 1, color: ${JSON.stringify(captionVisual.activeColor)}, duration: 0.12, ease: 'power1.out' }, Math.max(item.start, Number(item.words[i].t) || item.start));
        }
      }
    }

    // ── Explainer icons (icon-director): pop in on the trigger word, float
    // gently while alive, exit before the moment ends ──
    for (const item of (timing.iconAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      if (!hfHas(sel)) continue;
      hfSet(sel, { visibility: 'visible' }, Math.max(0, item.start - 0.01));
      hfFromTo(sel, { opacity: 0, scale: 0.45, y: 22 }, { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: 'back.out(2.2)' }, item.start);
      const floatDur = Math.max(0.6, (item.duration - 0.95) / 2);
      hfTo(sel, { y: -8, duration: floatDur, ease: 'sine.inOut', yoyo: true, repeat: 1 }, item.start + 0.55);
      hfTo(sel, { opacity: 0, scale: 0.82, y: -16, duration: 0.3, ease: 'power2.in' }, item.start + item.duration - 0.3);
      hfSet(sel, { visibility: 'hidden' }, item.start + item.duration + 0.02);
    }

    // ── Talking-head presenter-stage explanation images: slide in from the outer edge,
    // hold beside the host, slide back out. Seek-safe GSAP (no CSS animation). ──
    for (const item of (timing.explainAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      if (!hfHas(sel)) continue;
      const dx = item.from === 'left' ? -70 : 70; // slide in from that side (% of its own box)
      hfSet(sel, { visibility: 'visible' }, Math.max(0, item.start - 0.01));
      hfFromTo(sel, { opacity: 0, xPercent: dx }, { opacity: 1, xPercent: 0, duration: 0.5, ease: 'power3.out' }, item.start);
      hfTo(sel, { opacity: 0, xPercent: dx * 0.5, duration: 0.35, ease: 'power2.in' }, item.start + item.duration - 0.35);
      hfSet(sel, { visibility: 'hidden' }, item.start + item.duration + 0.02);
    }

    // ── Keyword glow (#18): pop the phrase in on the trigger word, hold with a
    // glow, exit. Seek-safe (no onUpdate/random). Absent unless HF_KEYWORD_GLOW. ──
    for (const item of (timing.glowAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      if (!hfHas(sel)) continue;
      const layer = sel + ' .hf-kw-glow-layer';
      hfSet(sel, { visibility: 'visible' }, Math.max(0, item.start - 0.01));
      hfFromTo(sel, { opacity: 0, scale: 0.86, y: 10 }, { opacity: 1, scale: 1.06, y: 0, duration: 0.18, ease: 'back.out(2.4)' }, item.start);
      hfSet(layer, { opacity: 0 }, item.start);
      hfTo(layer, { opacity: 0.95, duration: 0.18, ease: 'power2.out' }, item.start);
      const sustain = Math.max(0.3, item.duration - 0.45);
      hfTo(sel, { scale: 1.0, duration: sustain, ease: 'sine.inOut' }, item.start + 0.18);
      hfTo(sel, { opacity: 0, scale: 0.94, duration: 0.27, ease: 'power2.in' }, item.start + item.duration - 0.27);
      hfTo(layer, { opacity: 0, duration: 0.27, ease: 'power2.in' }, item.start + item.duration - 0.27);
      hfSet(sel, { visibility: 'hidden' }, item.start + item.duration + 0.02);
    }

    function hfAnimName(item) {
      return String(item.animation || 'fadeSlide').replace(/[^a-z0-9]/gi, '').toLowerCase();
    }
    function hfSpeed(item) {
      const raw = item.speed == null ? 1 : item.speed;
      const speed = Number(raw);
      if (Number.isFinite(speed)) return Math.max(0.25, Math.min(3, speed));
      const text = String(raw || 'normal').toLowerCase();
      if (text.includes('very-slow')) return 0.55;
      if (text.includes('slow') || text.includes('calm') || text.includes('gentle')) return 0.75;
      if (text.includes('rapid') || text.includes('snappy')) return 1.6;
      if (text.includes('fast') || text.includes('quick') || text.includes('energetic')) return 1.35;
      return 1;
    }
    function hfStagger(item, fallback) {
      const raw = Number(item.motionStagger);
      const base = Number.isFinite(raw) ? raw : fallback;
      return Math.max(0.01, Math.min(0.22, base)) / hfSpeed(item);
    }
    function hfDuration(base, item, min = 0.08, max = 1.6) {
      return Math.max(min, Math.min(max, base / hfSpeed(item)));
    }
    function hfEnterState(item) {
      const anim = hfAnimName(item);
      if (anim.includes('wipe')) return { opacity: 1, clipPath: 'inset(0 100% 0 0)' };
      if (anim.includes('flip')) return { opacity: 0, rotateX: -48, y: 24, transformPerspective: 900, transformOrigin: 'center center' };
      if (anim.includes('scatter')) return { opacity: 0, y: -70, scale: 1.08, rotate: -2 };
      if (anim.includes('spring') || anim.includes('pop')) return { opacity: 0, y: 16, scale: 0.82 };
      if (anim.includes('right') && !anim.includes('opposite')) return { opacity: 0, x: 76, scale: 0.99 };
      if (anim.includes('left') || anim.includes('opposite')) return { opacity: 0, x: -76, scale: 0.99 };
      if (anim.includes('up')) return { opacity: 0, y: 72, scale: 0.99 };
      if (anim.includes('scale')) return { opacity: 0, scale: 0.9 };
      if ((item.type || '') === 'map-chart') return { opacity: 0, scale: 1.025 };
      // Stage visuals (templates / fullscreen graphics): cinematic takeover —
      // the composition scales in over the still-visible footage. No overlay,
      // no dip, no box: the template itself IS the transition.
      if (item.kind === 'fullscreen' || item.kind === 'template') return { opacity: 0, scale: 0.94, y: 14 };
      return { opacity: 0, y: 38, scale: 0.985 };
    }
    function hfShowState(item) {
      const anim = hfAnimName(item);
      const isTemplate = item.kind === 'template';
      const duration = hfDuration(isTemplate ? 0.38 : 0.46, item, 0.12, 1.1);
      const show = { opacity: 1, x: 0, y: 0, rotate: 0, rotateX: 0, scale: 1, clipPath: 'inset(0 0% 0 0)', duration, ease: 'power3.out' };
      if (anim.includes('spring') || anim.includes('pop')) show.ease = 'back.out(1.65)';
      if (anim.includes('flip')) show.ease = 'back.out(1.25)';
      if (anim.includes('wipe')) show.ease = 'power2.inOut';
      if ((item.kind === 'fullscreen' || item.kind === 'template') && !anim.includes('wipe') && !anim.includes('flip')) {
        Object.assign(show, { duration: hfDuration(0.55, item, 0.2, 1.1), ease: 'power3.out' });
      }
      if ((item.type || '') === 'map-chart') Object.assign(show, { duration: hfDuration(0.58, item, 0.18, 1.2), ease: 'power2.out' });
      return show;
    }
    function hfExitState(item) {
      const anim = hfAnimName(item);
      if (anim.includes('wipe')) return { opacity: 1, clipPath: 'inset(0 0 0 100%)', duration: hfDuration(0.28, item), ease: 'power2.in' };
      if (anim.includes('left') || anim.includes('opposite')) return { opacity: 0, x: -34, duration: hfDuration(0.28, item), ease: 'power2.in' };
      if (anim.includes('right')) return { opacity: 0, x: 34, duration: hfDuration(0.28, item), ease: 'power2.in' };
      // Stage visuals exit by growing slightly past the camera while fading —
      // the inverse of the scale-in takeover, hands the frame back smoothly.
      if (item.kind === 'fullscreen' || item.kind === 'template') return { opacity: 0, scale: 1.035, duration: hfDuration(0.34, item), ease: 'power2.in' };
      return { opacity: 0, y: item.kind === 'template' ? -12 : -22, scale: 0.995, duration: hfDuration(0.28, item), ease: 'power2.in' };
    }
    function hfChildEnterState(item) {
      const anim = hfAnimName(item);
      if (anim.includes('scatter')) return { opacity: 0, y: -48, scale: 1.08, rotate: -4 };
      if (anim.includes('cascade')) return { opacity: 0, y: 34, scale: 0.98 };
      if (anim.includes('flip')) return { opacity: 0, rotateY: -38, transformPerspective: 800 };
      if (anim.includes('opposite')) return { opacity: 0, x: 44 };
      return { opacity: 0, y: 28, scale: 0.985 };
    }
    function hfChildShowState(item) {
      const anim = hfAnimName(item);
      return {
        opacity: 1,
        x: 0,
        y: 0,
        rotate: 0,
        rotateY: 0,
        scale: 1,
        duration: hfDuration(0.34, item, 0.1, 0.8),
        stagger: hfStagger(item, anim.includes('cascade') ? 0.085 : 0.055),
        ease: anim.includes('spring') || anim.includes('scatter') ? 'back.out(1.4)' : 'power3.out'
      };
    }
    // Per-variant kinetic typography — each kineticText subType gets its OWN
    // signature word motion, the way a human motion designer would author it,
    // instead of every variant sharing one generic stagger. Keyed off the
    // variant (mg.subType) first, then the animation name as fallback.
    function hfKineticMotion(item) {
      const v = String(item.variant || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const a = hfAnimName(item);
      const key = (v && v !== 'standard') ? v : a;
      const sp = hfSpeed(item);
      const d = (base) => hfDuration(base, item, 0.12, 1.0);
      const stg = (each, from) => ({ each: Math.max(0.012, each / sp), from: from || 'start' });
      if (/rise|slideup|^up$|up$/.test(key))
        return { from: { opacity: 0, y: 96, scale: 0.97 }, to: { opacity: 1, y: 0, scale: 1, duration: d(0.52), ease: 'back.out(1.9)', stagger: stg(0.06) } };
      if (/cascade/.test(key))
        return { from: { opacity: 0, y: -56, scale: 0.98, rotate: -2 }, to: { opacity: 1, y: 0, scale: 1, rotate: 0, duration: d(0.46), ease: 'power2.out', stagger: stg(0.09, 'start') } };
      if (/punch/.test(key))
        return { from: { opacity: 0, scale: 1.75 }, to: { opacity: 1, scale: 1, duration: d(0.32), ease: 'power4.out', stagger: stg(0.045) } };
      if (/stamp/.test(key))
        return { from: { opacity: 0, scale: 1.9, rotate: -4, y: -14 }, to: { opacity: 1, scale: 1, rotate: 0, y: 0, duration: d(0.4), ease: 'back.out(2.6)', stagger: stg(0.08) } };
      if (/glitch/.test(key))
        return { from: { opacity: 0, x: -10, skewX: 10 }, to: { opacity: 1, x: 0, skewX: 0, duration: d(0.16), ease: 'steps(3)', stagger: stg(0.05) } };
      if (/wave/.test(key))
        return { from: { opacity: 0, y: 56 }, to: { opacity: 1, y: 0, duration: d(0.5), ease: 'sine.out', stagger: stg(0.085) } };
      if (/pop|spring|scatter/.test(key))
        return { from: { opacity: 0, scale: 0.18 }, to: { opacity: 1, scale: 1, duration: d(0.44), ease: 'back.out(3)', stagger: stg(0.05) } };
      // centered / fade / default — calm elegant rise
      return { from: { opacity: 0, y: 34, scale: 0.96 }, to: { opacity: 1, y: 0, scale: 1, duration: d(0.44), ease: 'power3.out', stagger: stg(0.05) } };
    }
    function hfHas(selector) {
      try { return !!selector && document.querySelectorAll(selector).length > 0; } catch (e) { return false; }
    }
    function hfFromTo(selector, fromVars, toVars, at) {
      if (hfHas(selector)) hfActiveTimeline.fromTo(selector, fromVars, toVars, at);
    }
    function hfTo(selector, vars, at) {
      if (hfHas(selector)) hfActiveTimeline.to(selector, vars, at);
    }
    function hfSet(selector, vars, at) {
      if (hfHas(selector)) hfActiveTimeline.set(selector, vars, at);
    }

    for (const sourceItem of timing.graphicAnims) {
      const visibleStart = Math.max(0, Number(sourceItem.start) || 0);
      const visibleDuration = Math.max(0.001, Number(sourceItem.duration) || 0.001);
      const sourceOffset = Math.max(0, Number(sourceItem.sourceOffset) || 0);
      const sourceDuration = Math.max(
        sourceOffset + visibleDuration,
        Number(sourceItem.sourceDuration) || visibleDuration
      );
      const rangeTimeline = sourceItem.rangeFragment ? gsap.timeline({ paused: true }) : null;
      const item = rangeTimeline
        ? Object.assign({}, sourceItem, { start: 0, duration: sourceDuration })
        : sourceItem;
      if (rangeTimeline) hfActiveTimeline = rangeTimeline;
      const commitRangeTimeline = function() {
        if (!rangeTimeline) return;
        hfActiveTimeline = tl;
        try { rangeTimeline.progress(1, true).progress(0, true); } catch (e) {}
        const sliceEnd = Math.min(sourceDuration, sourceOffset + visibleDuration);
        tl.fromTo(
          rangeTimeline,
          { time: sourceOffset },
          { time: sliceEnd, duration: visibleDuration, ease: 'none' },
          visibleStart
        );
      };
      const sel = '#' + CSS.escape(item.id);
      const bgSel = '#' + CSS.escape(item.id + '-bg');
      const isTemplate = item.kind === 'template';
      const isStageVisual = item.kind === 'template' || item.kind === 'fullscreen';
      if (hfHas(bgSel)) {
        hfSet(bgSel, { visibility: 'visible', pointerEvents: 'none' }, Math.max(0, item.start - (isTemplate ? 0.08 : 0.01)));
        if (isTemplate) {
          // Template backgrounds are the visual bed. They must be present on
          // frame one so the title/card can animate over media, not over black.
          hfSet(bgSel, { opacity: 1, scale: 1.0 }, Math.max(0, item.start - 0.08));
        } else {
          hfFromTo(bgSel, { opacity: 0, scale: 1.035 }, { opacity: 1, scale: 1.0, duration: hfDuration(0.34, item), ease: 'power2.out' }, item.start);
        }
        if (!isStageVisual && item.duration > 0.75) {
          hfTo(bgSel, { opacity: 0, scale: 1.01, duration: hfDuration(0.24, item), ease: 'power1.in' }, item.start + item.duration - hfDuration(0.24, item));
        }
      }
      if (!hfHas(sel)) {
        commitRangeTimeline();
        continue;
      }
      const type = item.type || 'graphic';
      hfSet(sel, { visibility: 'visible', pointerEvents: 'none' }, Math.max(0, item.start - 0.01));
      if (item.authored && item.kind === 'overlay') {
        // Authored overlays bring their own internal choreography — the
        // container only gates visibility with a quick opacity ramp so the
        // default slide/scale enter can't fight the authored motion (the
        // full-frame container is also transform-locked in CSS).
        hfFromTo(sel, { opacity: 0 }, { opacity: 1, duration: 0.16, ease: 'power1.out' }, item.start);
        if (item.duration > 0.6) hfTo(sel, { opacity: 0, duration: 0.2, ease: 'power1.in' }, item.start + item.duration - 0.2);
        hfSet(sel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, item.start + item.duration + 0.025);
        commitRangeTimeline();
        continue;
      }
      if (item.seamIn) {
        // Seamless chain boundary: the previous stage visual hands off to
        // this one with NO container pop — the canvas holds steady and the
        // internal choreography (content entrance) carries the swap.
        hfSet(sel, { opacity: 1, x: 0, y: 0, scale: 1 }, item.start);
      } else {
        hfFromTo(sel, hfEnterState(item), hfShowState(item), item.start);
      }
      if (hfHas(sel + '.hf-agentic')) {
        if (hfHas(sel + ' .hf-agentic-rule')) {
          // The mark is a short horizontal rule, so it draws itself left-to-right
          // like a pen stroke. Measured, not assumed: any layout that still makes
          // the mark taller than it is wide keeps the upward wipe.
          var hfRuleEl = document.querySelector(sel + ' .hf-agentic-rule');
          var hfRuleVertical = !!(hfRuleEl && hfRuleEl.offsetHeight > hfRuleEl.offsetWidth);
          hfFromTo(sel + ' .hf-agentic-rule',
            hfRuleVertical ? { opacity: 0, scaleY: 0.2, transformOrigin: '50% 100%' } : { opacity: 0, scaleX: 0, transformOrigin: '0% 50%' },
            hfRuleVertical ? { opacity: 1, scaleY: 1, duration: hfDuration(0.38, item), ease: 'power3.out' } : { opacity: 1, scaleX: 1, duration: hfDuration(0.38, item), ease: 'power3.out' },
            item.start + 0.08);
        }
        if (hfHas(sel + ' .hf-agentic-part')) {
          hfFromTo(sel + ' .hf-agentic-part', hfChildEnterState(item), hfChildShowState(item), item.start + 0.14);
        }
        if (hfHas(sel + ' .hf-agentic-item')) {
          hfFromTo(sel + ' .hf-agentic-item', hfChildEnterState(item), hfChildShowState(item), item.start + 0.22);
        }
      }
      const usesTypewriterMotion = type === 'typewriter' || item.animation === 'typewriter' || item.variant === 'typewriter';
      if (usesTypewriterMotion) {
        const steps = Math.max(8, Math.min(80, Number(item.charCount) || Math.max(12, Number(item.wordCount || 1) * 6)));
        const typeDuration = hfDuration(Math.min(2.4, Math.max(0.65, item.duration * 0.45)), item, 0.3, 2.4);
        hfFromTo(sel + ' .hf-agentic-typewriter', { opacity: 1, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0% 0 0)', duration: typeDuration, ease: 'steps(' + steps + ')' }, item.start + 0.12);
        hfFromTo(sel + ' .hf-typewriter-line span', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: hfDuration(Math.min(1.4, Math.max(0.45, item.duration * 0.35)), item, 0.18, 1.4), ease: 'steps(18)' }, item.start + 0.12);
      }
      if (hfAnimName(item) === 'wordcascade') {
        hfFromTo(
          sel + ' .hf-agentic-word-cascade .hf-agentic-word',
          { opacity: 0, y: 58, scale: 0.88, rotateX: -18, transformPerspective: 900 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            rotateX: 0,
            duration: hfDuration(0.48, item, 0.16, 0.9),
            stagger: { each: Math.max(0.025, 0.09 / hfSpeed(item)), from: 'start' },
            ease: 'back.out(1.7)'
          },
          item.start + 0.12
        );
      }
      if (type === 'kinetic-text') {
        // Agentic markup splits the headline into .hf-agentic-word spans; each
        // variant gets its own signature word motion (rise/cascade/punch/stamp/
        // glitch/wave/pop/centered). (Legacy .hf-kinetic-line span kept for the
        // dedicated renderer path.)
        const km = hfKineticMotion(item);
        hfFromTo(sel + ' .hf-agentic-word', km.from, km.to, item.start + 0.1);
        hfFromTo(sel + ' .hf-kinetic-line span', km.from, km.to, item.start + 0.1);
      }
      if (type === 'stat-counter') {
        hfFromTo(sel + ' .hf-stat-value', { opacity: 0, y: 18, scale: 0.84 }, { opacity: 1, y: 0, scale: 1, duration: hfDuration(0.42, item), ease: 'back.out(1.8)' }, item.start + 0.12);
      }
      if (type === 'map-chart') {
        if (hfHas(sel + ' .hf-map-image')) {
          hfFromTo(sel + ' .hf-map-image', { scale: 1.045 }, { scale: 1.005, duration: Math.max(0.8, item.duration - 0.2), ease: 'none' }, item.start + 0.05);
        }
        if (hfHas(sel + ' .hf-country-fill')) {
          hfFromTo(sel + ' .hf-country-fill', { opacity: 0, scale: 0.985 }, { opacity: 1, scale: 1, duration: hfDuration(0.48, item), stagger: 0.06 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.12);
        }
        if (hfHas(sel + ' .hf-country-line')) {
          hfFromTo(sel + ' .hf-country-line', { opacity: 0 }, { opacity: 1, duration: hfDuration(0.42, item), stagger: 0.04 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.18);
        }
        if (hfHas(sel + ' .hf-country-route')) {
          hfTo(sel + ' .hf-country-route', { strokeDashoffset: 0, duration: hfDuration(Math.min(1.5, Math.max(0.6, item.duration * 0.32)), item, 0.24, 1.5), ease: 'power2.inOut' }, item.start + 0.26);
        }
        if (hfHas(sel + ' .hf-country-pin')) {
          hfFromTo(sel + ' .hf-country-pin', { opacity: 0, scale: 0.65 }, { opacity: 1, scale: 1, duration: hfDuration(0.3, item), stagger: 0.08 / hfSpeed(item), ease: 'back.out(1.8)' }, item.start + 0.48);
        }
        if (hfHas(sel + ' .hf-map-labels span')) {
          hfFromTo(sel + ' .hf-map-labels span', { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: hfDuration(0.32, item), stagger: 0.05 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.34);
        }
      }
      if (type === 'bar-chart') {
        hfFromTo(sel + ' .hf-bar-row', { opacity: 0, x: -32 }, { opacity: 1, x: 0, duration: hfDuration(0.34, item), stagger: 0.07 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.18);
        hfFromTo(sel + ' .hf-bar-row i', { scaleX: 0 }, { scaleX: 1, duration: hfDuration(0.72, item), stagger: 0.07 / hfSpeed(item), ease: 'power3.out' }, item.start + 0.28);
      }
      if (type === 'progress-bar' || type === 'progress-tracker') {
        hfFromTo(sel + ' .hf-progress-rail span', { scaleX: 0 }, { scaleX: 1, duration: hfDuration(0.72, item), ease: 'power3.out' }, item.start + 0.22);
      }
      if (hfHas(sel + ' .hf-item') && (type.includes('card') || type === 'listicle-grid' || type === 'infographic' || type === 'image-showcase' || type === 'split-screen' || type === 'person-intro' || type === 'ranking-list' || type === 'bullet-list' || type === 'timeline')) {
        hfFromTo(sel + ' .hf-item', hfChildEnterState(item), hfChildShowState(item), item.start + 0.18);
      }
      if (item.duration > 0.75 && !item.seamOut && !isStageVisual) {
        const exit = hfExitState(item);
        hfTo(sel, exit, item.start + item.duration - exit.duration);
      }
      // Stage visuals must own the full frame until the exact declared end.
      // Their inner copy may animate out, but the container/background cannot
      // pre-fade and expose the previous-scene continuity hold underneath.
      const clampAt = item.start + item.duration + (isStageVisual ? 0.001 : 0.025);
      hfSet(sel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, clampAt);
      if (hfHas(bgSel)) {
        hfSet(bgSel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, clampAt);
      }
      commitRangeTimeline();
    }

    // ── Map compositions (map-hf-builder GSAP timelines) ──
${mapTimelineScript}

    // ── Agent-authored compositions (composition-author worker) ──
${authoredTimelineScript}

    // ── Scene effect stacks (hf-effects registry) ──
${fxTimelineScript}

    // ── Transitions ──
    // Motion mode: choreograph the ACTUAL scene containers (outgoing exits
    // with intent, incoming arrives with momentum) — the broadcast feel.
    // Overlay mode: slab/flare element swept over the cut (flash/sweep/glitch).
    for (const item of timing.transitionAnims || []) {
      const type = item.type || 'crossfade';
      if (item.mode === 'motion') {
        const inSel = item.inId ? '#' + CSS.escape(item.inId) : null;
        const outSel = item.outId ? '#' + CSS.escape(item.outId) : null;
        if (!inSel || !hfHas(inSel)) continue;
        const hasOut = outSel && hfHas(outSel);
        const d = Math.max(0.3, Math.min(0.85, item.duration));
        const b = item.boundary != null ? item.boundary : (item.start + d * 0.5);
        const inAt = b - 0.02; // incoming starts a hair early — opacity still 0, transform pre-positions
        const dirX = type.endsWith('right') ? -1 : 1; // push-left = content travels left
        if (type.indexOf('push-') === 0) {
          const axis = type === 'push-up' ? 'yPercent' : 'xPercent';
          const from = {}; from[axis] = (type === 'push-up' ? 1 : dirX) * 26;
          const to = {}; to[axis] = 0;
          hfFromTo(inSel, from, Object.assign(to, { duration: d * 0.9, ease: 'power3.out' }), inAt);
          if (hasOut) {
            const outTo = {}; outTo[axis] = (type === 'push-up' ? 1 : dirX) * -20;
            hfTo(outSel, Object.assign(outTo, { duration: d * 0.7, ease: 'power2.in' }), b - d * 0.45);
            hfSet(outSel, type === 'push-up' ? { yPercent: 0 } : { xPercent: 0 }, b + d);
          }
        } else if (type.indexOf('wipe-') === 0) {
          const fromClip = type === 'wipe-up'
            ? 'inset(100% 0% 0% 0%)'
            : (type === 'wipe-right' ? 'inset(0% 0% 0% 100%)' : 'inset(0% 100% 0% 0%)');
          hfSet(inSel, { clipPath: fromClip }, inAt);
          hfTo(inSel, { clipPath: 'inset(0% 0% 0% 0%)', duration: d * 0.85, ease: 'power3.inOut' }, inAt);
          hfSet(inSel, { clipPath: 'none' }, inAt + d);
        } else if (type.indexOf('whip-') === 0) {
          hfFromTo(inSel, { xPercent: dirX * 46, filter: 'blur(14px)' },
            { xPercent: 0, filter: 'blur(0px)', duration: d * 0.62, ease: 'power3.out' }, inAt);
          hfSet(inSel, { filter: 'none' }, inAt + d * 0.62); // clear the blur layer once sharp
          if (hasOut) {
            hfTo(outSel, { xPercent: dirX * -38, filter: 'blur(12px)', duration: d * 0.5, ease: 'power2.in' }, b - d * 0.4);
            hfSet(outSel, { xPercent: 0, filter: 'none' }, b + d);
          }
        } else if (type === 'zoom-punch') {
          hfFromTo(inSel, { scale: 0.86 }, { scale: 1, duration: d * 0.9, ease: 'power3.out' }, inAt);
          if (hasOut) {
            hfTo(outSel, { scale: 1.16, duration: d * 0.7, ease: 'power2.in' }, b - d * 0.45);
            hfSet(outSel, { scale: 1 }, b + d);
          }
        } else if (type === 'zoom-pull') {
          hfFromTo(inSel, { scale: 1.14 }, { scale: 1, duration: d * 0.9, ease: 'power3.out' }, inAt);
          if (hasOut) {
            hfTo(outSel, { scale: 0.93, duration: d * 0.7, ease: 'power2.in' }, b - d * 0.45);
            hfSet(outSel, { scale: 1 }, b + d);
          }
        } else if (type === 'blur-dissolve') {
          hfFromTo(inSel, { filter: 'blur(12px)' }, { filter: 'blur(0px)', duration: d * 0.8, ease: 'power2.out' }, inAt);
          hfSet(inSel, { filter: 'none' }, inAt + d * 0.8); // clear the blur layer once sharp
          if (hasOut) {
            hfTo(outSel, { filter: 'blur(12px)', duration: d * 0.6, ease: 'power2.in' }, b - d * 0.4);
            hfSet(outSel, { filter: 'none' }, b + d);
          }
        } else if (type === 'spin-settle') {
          hfFromTo(inSel, { rotation: dirX * 1.8, scale: 1.06 }, { rotation: 0, scale: 1, duration: d, ease: 'power3.out' }, inAt);
        }
        continue;
      }
      const sel = '#' + CSS.escape(item.id);
      const slab = sel + ' .hf-transition-slab';
      const flare = sel + ' .hf-transition-flare';
      if (!hfHas(sel)) continue;
      hfSet(sel, { opacity: 1, visibility: 'visible', pointerEvents: 'none' }, item.start);
      if (type.includes('fire') || type.includes('burn')) {
        // Hot flame band sweeps across; a warm ember-glow core blooms with it.
        hfFromTo(slab, { xPercent: -120, opacity: 0.25 }, { xPercent: 120, opacity: 1, duration: item.duration, ease: 'power2.inOut' }, item.start);
        hfFromTo(flare, { opacity: 0, scale: 0.7 }, { opacity: 0.85, scale: 1.35, duration: item.duration * 0.5, yoyo: true, repeat: 1, ease: 'power2.out' }, item.start);
      } else if (type.includes('lens') || type.includes('anamorphic') || type.includes('streak')) {
        // Bright vertical light core whips across fast; horizontal streak flashes through.
        hfFromTo(slab, { xPercent: -130, opacity: 0.3 }, { xPercent: 130, opacity: 1, duration: item.duration, ease: 'power3.inOut' }, item.start);
        hfFromTo(flare, { opacity: 0, scaleX: 0.5 }, { opacity: 0.95, scaleX: 1.35, duration: item.duration * 0.45, yoyo: true, repeat: 1, ease: 'power2.out' }, item.start + item.duration * 0.18);
      } else if (type.includes('light') || type.includes('sweep') || type.includes('leak')) {
        hfFromTo(slab, { xPercent: -120, opacity: 0.1 }, { xPercent: 120, opacity: 1, duration: item.duration, ease: 'power2.inOut' }, item.start);
      } else if (type.includes('glitch')) {
        hfFromTo(slab, { opacity: 0, x: -8 }, { opacity: 0.5, x: 8, duration: 0.09, ease: 'steps(2)', yoyo: true, repeat: Math.min(3, Math.max(2, Math.floor(item.duration / 0.09))) }, item.start);
      } else {
        // flash-white / dip-black / legacy names: a quick opacity dip/flash.
        // dip-black goes nearly to full black so an act break reads as a real
        // cut-to-black, not a grey veil.
        const peak = (type.includes('flash') || type.includes('white')) ? 0.9 : (type.includes('dip') || type.includes('black')) ? 0.96 : 0.78;
        hfFromTo(slab, { opacity: 0 }, { opacity: peak, duration: item.duration * 0.5, yoyo: true, repeat: 1, ease: 'power1.inOut' }, item.start);
      }
      // Generic white flare bloom for light/sweep/leak/flash. fire-burn & lens-flare
      // drive their OWN (warm / streak) flare above, so they're excluded here.
      if (type.includes('light') || type.includes('sweep') || type.includes('leak') || type.includes('flash')) {
        hfFromTo(flare, { opacity: 0, scale: 0.8 }, { opacity: 0.5, scale: 1.2, duration: item.duration * 0.5, yoyo: true, repeat: 1, ease: 'power2.out' }, item.start);
      }
      hfSet(sel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, item.start + item.duration + 0.025);
    }

    window.__timelines['yta-hyperframes'] = tl;
    window.__HF_DURATION__ = ${totalDuration.toFixed(3)};
    const hfAdaptiveContrast = ${adaptiveContrastRuntime};
    if (hfAdaptiveContrast) {
      const previousFlushSync = window.__hfFlushSync;
      window.__hfFlushSync = function ytaAdaptiveContrastFlush() {
        if (typeof previousFlushSync === 'function') previousFlushSync();
        hfAdaptiveContrast.update(typeof tl.time === 'function' ? tl.time() : 0, true);
      };
${adaptiveLiveHookScript}
    }
    /*HF_PREVIEW_START*/
    (function initYtaHyperframesPreviewRuntime() {
      const params = new URLSearchParams(window.location.search || '');
      if (!params.has('preview')) return;
      const root = document.getElementById('yta-hyperframes');
      const compositionWidth = Number(root?.dataset.width || 1920);
      const compositionHeight = Number(root?.dataset.height || 1080);
      if (root) {
        root.style.position = 'absolute';
        root.style.left = '0';
        root.style.top = '0';
        root.style.transformOrigin = 'top left';
      }
      document.documentElement.style.background = '#050505';
      document.body.style.margin = '0';
      document.body.style.width = '100vw';
      document.body.style.height = '100vh';
      document.body.style.overflow = 'hidden';

      function fitPreviewRoot() {
        if (!root) return;
        const viewportWidth = Math.max(1, window.innerWidth || compositionWidth);
        const viewportHeight = Math.max(1, window.innerHeight || compositionHeight);
        const scale = Math.min(viewportWidth / compositionWidth, viewportHeight / compositionHeight);
        const left = Math.max(0, (viewportWidth - compositionWidth * scale) / 2);
        const top = Math.max(0, (viewportHeight - compositionHeight * scale) / 2);
        root.style.transform = 'translate(' + left + 'px, ' + top + 'px) scale(' + scale + ')';
      }

      window.addEventListener('resize', fitPreviewRoot);
      fitPreviewRoot();

      const clips = Array.from(document.querySelectorAll('.clip')).map((el) => {
        const timelineManaged = el.classList.contains('hf-scene')
          || el.classList.contains('hf-mg')
          || el.classList.contains('hf-bg-media')
          || el.classList.contains('hf-transition')
          || el.classList.contains('hf-caption');
        // Scene footage now lives inside a wrapper (.hf-scene-wrap > .hf-scene-frame
        // > video), so the media element is no longer the .clip itself — find it.
        // The MAIN scene media carries .hf-scene-media; the blurred backdrop carries
        // .hf-floatbg-fill and sits FIRST in DOM — so a naive querySelector('video')
        // would grab the backdrop. Select the main media explicitly, then drive the
        // backdrop video off the same clock.
        const mediaEl = (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')
          ? el
          : (el.querySelector('video.hf-scene-media, audio.hf-scene-media')
             || el.querySelector('.hf-scene-frame video, .hf-scene-frame audio')
             || el.querySelector('video, audio'));
        const bgMediaEl = el.querySelector ? el.querySelector('video.hf-floatbg-fill') : null;
        return {
          el,
          mediaEl,
          bgMediaEl,
          start: Number(el.dataset.start || 0),
          duration: Number(el.dataset.duration || 0),
          mediaStart: Number(el.dataset.mediaStart || 0),
          isMedia: !!mediaEl,
          manualVisibility: !timelineManaged || (!!mediaEl && mediaEl.tagName === 'AUDIO'),
        };
      });
      let playing = false;
      let lastTime = 0;
      let previewTimer = null;
      let lastTickMs = 0;

      function emitPreviewState() {
        window.parent?.postMessage({
          type: 'hf-preview-time',
          time: lastTime,
          duration: Number(window.__HF_DURATION__ || 0),
          playing
        }, '*');
      }

      function stopLoop() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = null;
      }

      function startLoop() {
        if (previewTimer) return;
        lastTickMs = performance.now();
        previewTimer = setTimeout(tick, 33);
      }

      function tick() {
        previewTimer = null;
        if (!playing) return;
        const now = performance.now();
        const duration = Number(window.__HF_DURATION__ || 0);
        const delta = Math.min(0.1, Math.max(0, (now - lastTickMs) / 1000));
        lastTickMs = now;
        let nextTime = lastTime + delta;
        if (duration > 0 && nextTime >= duration) {
          nextTime = duration;
          playing = false;
          seek(nextTime, false);
          return;
        }
        seek(nextTime, true);
        if (playing) startLoop();
      }

      clips.forEach((clip) => {
        clip.el.style.pointerEvents = 'none';
        if (clip.isMedia && clip.mediaEl) {
          clip.mediaEl.muted = true;
          clip.mediaEl.playsInline = true;
          clip.mediaEl.pause();
        }
      });

      function syncMedia(clip, localTime) {
        if (!clip.isMedia || !clip.mediaEl) return;
        try {
          const media = clip.mediaEl;
          const desired = Math.max(0, localTime + clip.mediaStart);
          const maxTime = Number.isFinite(media.duration) && media.duration > 0
            ? Math.max(0, media.duration - 0.05)
            : desired;
          const target = Math.min(desired, maxTime);
          if (Math.abs((media.currentTime || 0) - target) > 0.18) {
            media.currentTime = target;
          }
          if (playing && media.tagName === 'VIDEO') {
            media.play().catch(() => {});
          } else if (!playing && !media.paused) {
            media.pause();
          }
          // Keep the blurred backdrop video in step with the foreground.
          const bg = clip.bgMediaEl;
          if (bg && bg.tagName === 'VIDEO') {
            try {
              if (Math.abs((bg.currentTime || 0) - target) > 0.25) bg.currentTime = target;
              if (playing) { bg.muted = true; bg.play().catch(() => {}); }
              else if (!bg.paused) bg.pause();
            } catch (_) {}
          }
        } catch (_) {}
      }

      function seek(time, shouldPlay) {
        const duration = Number(window.__HF_DURATION__ || 0);
        const t = Math.max(0, Math.min(Number(time) || 0, duration));
        lastTime = t;
        if (typeof shouldPlay === 'boolean') playing = shouldPlay;
        const timeline = window.__timelines && window.__timelines['yta-hyperframes'];
        if (timeline) {
          if (typeof timeline.time === 'function') timeline.time(t, false);
          if (typeof timeline.pause === 'function') timeline.pause();
        }
        clips.forEach((clip) => {
          const clipDuration = Math.max(0.033, Number(clip.duration) || 0);
          const active = t >= clip.start && t < clip.start + clipDuration;
          if (clip.manualVisibility) {
            clip.el.style.visibility = active ? 'visible' : 'hidden';
          } else {
            clip.el.style.visibility = '';
          }
          if (clip.isMedia && active) {
            syncMedia(clip, t - clip.start);
          } else if (clip.isMedia && clip.mediaEl && !clip.mediaEl.paused) {
            clip.mediaEl.pause();
          }
        });
        if (window.__HF_ADAPTIVE_CONTRAST__) {
          window.__HF_ADAPTIVE_CONTRAST__.update(t, true);
        }
        if (root) root.setAttribute('data-preview-time', t.toFixed(3));
        if (playing) startLoop();
        else stopLoop();
        emitPreviewState();
      }

      window.__HF_PREVIEW__ = {
        fit: fitPreviewRoot,
        seek,
        play() { playing = true; seek(lastTime, true); },
        pause() { playing = false; seek(lastTime, false); },
      };

      window.addEventListener('message', (event) => {
        const msg = event.data || {};
        if (msg.type === 'hf-preview-seek') seek(msg.time, msg.playing);
        if (msg.type === 'hf-preview-play') window.__HF_PREVIEW__.play();
        if (msg.type === 'hf-preview-pause') window.__HF_PREVIEW__.pause();
      });

      seek(Number(params.get('t') || 0), false);
      window.parent?.postMessage({
        type: 'hf-preview-ready',
        rev: String(params.get('rev') || '')
      }, '*');
    })();
    /*HF_PREVIEW_END*/
  </script>
</body>
</html>`;
    // The preview controller above uses performance.now()/setTimeout for live
    // scrubbing in the iframe. HyperFrames' RENDER validator statically scans the
    // composition source and HARD-FAILS on non-deterministic calls (performance.now)
    // even though the block self-guards on ?preview. So strip the entire preview
    // runtime from the render build — HyperFrames drives the GSAP timeline itself,
    // frame-accurate and deterministic.
    if (options && options.preview) return __hfHtml;
    return __hfHtml.replace(/\/\*HF_PREVIEW_START\*\/[\s\S]*?\/\*HF_PREVIEW_END\*\//, '');
}

/**
 * Rough relative luminance of a CSS colour, for one purpose only: deciding
 * whether to describe this theme's canvas as light or dark in prose. Handles
 * #rgb / #rrggbb / rgb() / rgba(); anything else is treated as dark, which is
 * the safe default because 7 of 8 themes are.
 */
function _designLuminance(color) {
    const raw = String(color || '').trim();
    let r = 0, g = 0, b = 0;
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else {
        const fn = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        if (!fn) return 0;
        r = parseFloat(fn[1]); g = parseFloat(fn[2]); b = parseFloat(fn[3]);
    }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * DESIGN.md is not a note-to-self — the composition-author skill treats it as
 * authority ("DESIGN.md decides what things look like", house-style.md). So
 * whatever this file says is what the agent authoring graphics believes the
 * video looks like.
 *
 * It used to say the same thing for every video, from a hardcoded block: violet
 * #7c3aed and sky #0ea5e9 on near-black #050505, panelled in Tailwind slate.
 * That is the textbook generated-design palette, and it was handed to the
 * authoring agent on every run regardless of theme — a cream-and-copper
 * editorial video was being told to think in violet-on-black. It also read the
 * theme from scriptContext.theme, a field the plan does not carry (the plan uses
 * themeId), so the "Current Theme" line named something unrelated to the theme
 * every graphic actually resolved.
 *
 * Now it is generated from the theme's own tokens, which makes it a contract
 * rather than decoration: the palette, the type and the chrome the agent is told
 * to use are by construction the ones the renderer will apply.
 */
function writeDesign(projectDir, plan) {
    const themeId = cleanName(
        displayValue(plan?.scriptContext?.themeId, plan?.themeId, plan?.theme, 'standard'),
        'standard'
    );
    const title = plan?.scriptContext?.title || plan?.title || 'YTA video';
    const tokens = getThemeTokens(themeId) || {};
    const c = tokens.colors || {};
    const ty = tokens.typography || {};
    const ch = tokens.chrome || {};

    const light = _designLuminance(c.background) > 0.5;
    const canvas = light ? 'a light, printed-page canvas' : 'a rich dark canvas';
    const row = (label, value) => (value ? `- ${label}: ${value}\n` : '');

    const design = `# Design

## Style Prompt
Premium documentary motion graphics for "${title}". Clean editorial typography,
high contrast, ${canvas}, crisp animated overlays, and smooth full-frame title
cards.

## Current Theme
${themeId}${tokens.mgStyle ? ` (graphic style: ${tokens.mgStyle})` : ''}

## Colors
THESE ARE THE ONLY COLOURS. Do not invent a palette, and do not reach for
default greys — every neutral must be derived from the values below.

${row('Background', c.background)}${row('Surface / panel', c.surface)}${row('Text', c.textPrimary)}${row('Muted text', c.textSecondary)}${row('Primary', c.primary)}${row('Secondary', c.secondary)}${row('Accent', c.accent)}${row('Stroke', c.stroke)}${row('Shadow', c.shadow)}
## Typography
Use these families. Do not substitute a different face.

${row('Headings', ty.headingFont)}${row('Body', ty.bodyFont)}${row('Captions', ty.captionFont)}${row('Numbers / stats', ty.statFont)}${row('Heading weight', ty.headingWeight)}${row('Body weight', ty.bodyWeight)}${row('Emphasis weight', ty.emphasisWeight)}
## Chrome
${row('Corner radius', ch.borderRadius != null ? `${ch.borderRadius}px` : '')}${row('Stroke width', ch.strokeWidth != null ? `${ch.strokeWidth}px` : '')}${row('Shadow style', ch.shadowStyle)}${row('Card style', ch.cardStyle)}${row('Glow', ch.glow ? 'yes' : 'no')}
Accents are marks, not chrome: a short rule, a tick beside the first line, or
corner crop marks. Never a thick bar down the side of a card, and never a
full-width bar welded to the edge of a text block.
`;
    fs.writeFileSync(path.join(projectDir, 'DESIGN.md'), design, 'utf8');
}

/**
 * Every folder that can hold generated `yta-hf-*` projects for this project:
 * `root` itself, plus any sibling folder whose name starts with "hyperframes".
 *
 * The prune used to read only `root`, so a run that passed a different
 * outputRoot left its renders behind permanently — nothing ever looked in
 * there again. Measured in a real project: 5 abandoned roots holding 1.98 GB
 * of superseded renders next to a correctly-pruned main root.
 *
 * A sibling is only adopted when every entry inside it is a `yta-hf-*` dir, so
 * this can never reach into a folder holding anything the user put there.
 */
function _hfProjectRoots(root) {
    const roots = [root];
    try {
        const parent = path.dirname(root);
        const base = path.basename(root);
        for (const name of fs.readdirSync(parent)) {
            if (name === base || !/^hyperframes/i.test(name)) continue;
            const full = path.join(parent, name);
            if (!fs.statSync(full).isDirectory()) continue;
            const entries = fs.readdirSync(full);
            if (!entries.length || !entries.every(e => /^yta-hf-/.test(e))) continue;
            roots.push(full);
        }
    } catch (_) { /* sibling scan is best-effort — never block a render over housekeeping */ }
    return roots;
}

/** Generated project dirs across all roots, NEWEST FIRST (the name embeds an ISO stamp). */
function _listHfProjects(roots, excludeName) {
    const out = [];
    for (const r of roots) {
        let names = [];
        try { names = fs.readdirSync(r); } catch (_) { continue; }
        for (const name of names) {
            if (!/^yta-hf-/.test(name) || name === excludeName) continue;
            out.push({ root: r, name, dir: path.join(r, name) });
        }
    }
    out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    return out;
}

/** Delete one generated project, and the sibling root it lived in once that root is empty. */
function _removeHfProject(entry, primaryRoot) {
    fs.rmSync(entry.dir, { recursive: true, force: true });
    if (entry.root === primaryRoot) return;
    try {
        if (!fs.readdirSync(entry.root).length) fs.rmdirSync(entry.root);
    } catch (_) { /* leaving an empty shell behind is harmless */ }
}

function generateHyperframesProject({ plan, projectDir, appRoot, tempDir, publicDir, inputDir, outputRoot, options = {} }) {
    if (!plan || typeof plan !== 'object') throw new Error('Missing video plan');
    plan = timelineContract.normalizePlan(plan);
    // Preview regeneration can happen several times inside one second (Agent
    // apply/undo/redo). A second-resolution directory name made those runs
    // overwrite the document currently loaded by Electron, leaving the iframe
    // visually stale even though the canonical plan was already correct.
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const projectName = `yta-hf-${stamp}`;
    const root = outputRoot || path.join(projectDir, 'hyperframes');
    ensureDir(root);
    const hfDir = path.join(root, projectName);
    ensureDir(hfDir);
    const vendorDir = path.join(hfDir, 'vendor');
    ensureDir(vendorDir);
    fs.copyFileSync(resolveGsapRuntime(), path.join(vendorDir, 'gsap.min.js'));

    // Auto-prune older generated projects. Each yta-hf-* dir carries a full
    // copy of all scene media (~hundreds of MB); a busy project accumulated
    // 85+ of them (16 GB) and filled the disk mid-render (ENOSPC killed the
    // parallel capture). Keep the newest N (HF_KEEP_PROJECTS, default 3).
    try {
        const keepN = Math.max(1, parseInt(process.env.HF_KEEP_PROJECTS || '3', 10) || 3);
        // Pool every render root, not just this one — see _hfProjectRoots. The rule
        // is unchanged in spirit ("keep the newest N renders of this project"), it
        // just isn't blind to renders written somewhere else any more.
        const allRoots = _hfProjectRoots(root);
        const older = _listHfProjects(allRoots, projectName);
        const doomed = older.slice(Math.max(0, keepN - 1));
        for (const entry of doomed) _removeHfProject(entry, root);
        if (doomed.length) {
            const abandoned = doomed.filter(e => e.root !== root).length;
            console.log(`[HyperFrames] Pruned ${doomed.length} old project dir(s) (keeping newest ${keepN})${abandoned ? ` — ${abandoned} from abandoned render folder(s)` : ''}`);
        }
    } catch (pruneErr) {
        console.warn(`[HyperFrames] project prune skipped: ${pruneErr.message}`);
    }

    // ── Disk-space pre-flight (turn a cryptic mid-write crash into graceful handling).
    // buildComposition() below re-encodes EVERY scene + MG into hfDir/media (often
    // 300-600 MB) then writes a multi-MB plan snapshot. On a near-full disk those
    // writes die halfway with "cannot write to disk", leaving a broken half-project.
    // So when space is tight: reclaim hard (drop ALL older project dirs, keeping only
    // this run) so the build can still finish; if it's STILL critically low, fail NOW
    // with an actionable message instead of after 30 min of normalizing. statfs is
    // wrapped — if unavailable, this whole block no-ops and behaviour is unchanged.
    // Tunables: HF_MIN_FREE_GB (comfort, default 3), HF_HARD_MIN_FREE_GB (floor, 1.2).
    const _freeGB = (p) => {
        try { const s = fs.statfsSync(p); return (s.bavail * s.bsize) / (1024 ** 3); }
        catch (_) { return null; }
    };
    const minFreeGB = Math.max(0.5, parseFloat(process.env.HF_MIN_FREE_GB || '3') || 3);
    const hardMinGB = Math.max(0.3, parseFloat(process.env.HF_HARD_MIN_FREE_GB || '1.2') || 1.2);
    let freeGB = _freeGB(root);
    if (freeGB !== null && freeGB < minFreeGB) {
        try {
            const stale = _listHfProjects(_hfProjectRoots(root), projectName);
            for (const entry of stale) _removeHfProject(entry, root);
            if (stale.length) console.warn(`[HyperFrames] Low disk (${freeGB.toFixed(1)} GB free) — reclaimed ALL ${stale.length} old project dir(s) to make room.`);
        } catch (e) { console.warn(`[HyperFrames] low-disk reclaim skipped: ${e.message}`); }
        freeGB = _freeGB(root);
        if (freeGB !== null && freeGB < hardMinGB) {
            const drive = path.parse(root).root || root;
            throw new Error(`Not enough free disk space to render this video: only ${freeGB.toFixed(1)} GB free on ${drive} (need ~${minFreeGB} GB). Free up space — empty the Recycle Bin, clear old Downloads, or delete old projects — then build again.`);
        }
        if (freeGB !== null) console.warn(`[HyperFrames] Proceeding with ${freeGB.toFixed(1)} GB free (below the ${minFreeGB} GB comfort margin) — keep an eye on disk.`);
    }

    const dirs = {
        appRoot,
        lookupDirs: [
            tempDir,
            publicDir,
            inputDir,
            projectDir,
            path.join(projectDir, 'output'),
        ].filter(Boolean),
    };

    const indexHtml = buildComposition({ plan, dirs, projectDir: hfDir, options });
    fs.writeFileSync(path.join(hfDir, 'index.html'), indexHtml, 'utf8');
    fs.writeFileSync(path.join(hfDir, 'video-plan.snapshot.json'), JSON.stringify(plan, null, 2), 'utf8');
    const hyperframesCli = require.resolve('hyperframes/dist/cli.js').replace(/\\/g, '/');
    const localCliCommand = `node "${hyperframesCli}"`;
    fs.writeFileSync(path.join(hfDir, 'package.json'), JSON.stringify({
        scripts: {
            lint: `${localCliCommand} lint`,
            check: `${localCliCommand} check`,
            keyframes: `${localCliCommand} keyframes . --json --runtime all`,
            snapshot: `${localCliCommand} snapshot`,
            inspect: `${localCliCommand} inspect`,
            preview: `${localCliCommand} preview`,
            render: `${localCliCommand} render --gpu --workers 2 --browser-gpu`,
        },
        devDependencies: {},
    }, null, 2), 'utf8');
    writeDesign(hfDir, plan);

    return {
        success: true,
        projectDir: hfDir,
        indexPath: path.join(hfDir, 'index.html'),
        mediaDir: path.join(hfDir, 'media'),
        motionManifestPath: path.join(hfDir, 'hyperframes-motion-manifest.json'),
    };
}

/*
 * `resolveHyperframeVisual` is exported so Step 7.8 Motion QA can ASK what will
 * ship instead of predicting it. It used to have to guess: to know whether a
 * graphic's entrance was chosen or defaulted, it would have had to restate the
 * theme tables, the registry lookup and the per-type fallback map — a second
 * model of the same fact, which is exactly the shape of defect this codebase
 * keeps paying for. It imports the real resolver instead.
 */
module.exports = {
    generateHyperframesProject,
    buildCaptionCues,
    resolveHyperframeVisual,
    // Both of these answer questions Motion QA would otherwise have to answer by
    // guessing: which registry category a type belongs to, and whether a type is
    // drawn by its own dedicated renderer (which decides whether an agentic
    // entrance can outrank the resolved one). Exported rather than re-derived.
    camelRegistryKey,
    typeUsesDedicatedRenderer,
    _seedNormalizedFromSibling,
};
