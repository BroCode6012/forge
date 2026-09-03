const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { execFileSync, execSync, spawnSync } = require('child_process');
const timelineContract = require('../project/timeline-contract');
const { atomicWriteJson } = require('../project/project-store');
const config = require('../settings/config');
const { resetCosts, logCostReport, writeCostReport } = require('../brain/cost-tracker');
const { transcribeAudio } = require('./transcribe');
// NEW: Smart AI modules (Phase 1 & 2)
const { createDirectorsBrief } = require('../agents/directors-brief');
const { compileDirectives, directivesFloor, isDisabled: directivesDisabled } = require('../directives/directive-compiler');
const { enforceNumericLowerThirdExclusivity } = require('../directives/compliance-loop');
const directiveUtil = require('../directives/directive-util');
const { analyzeAndCreateScenes } = require('../agents/ai-director');
const { planVisuals } = require('../agents/ai-visual-planner');
const { planCompositorOverlays } = require('../agents/ai-compositor-planner');
// Existing modules
const { processMotionGraphics, FULLSCREEN_MG_TYPES } = require('../agents/ai-motion-graphics');
const { processTemplates, downloadTemplateItemImages, TEMPLATE_TYPES } = require('../agents/ai-templates');
const { downloadAllMedia } = require('../media/footage-manager');
const clipAnalyzer = require('../media/clip-analyzer');
const { buildTopicFootageBank } = require('../media/topic-footage-scout');
const { sanitizeSourceHint } = require('../media/source-policy');
// const { loadRecipe } = require('../settings/recipe-loader'); // Disabled — recipes caused wrong genre detection
const { preBuildReview, midBuildValidation, postBuildReview } = require('./build-orchestrator');
const log = require('../util/logger');

function writeVideoPlanAtomic(filePath, videoPlan) {
    const serializable = JSON.parse(JSON.stringify(
        timelineContract.withContinuityHolds(videoPlan),
        (key, value) => key === '_fileIndex' ? undefined : value
    ));
    atomicWriteJson(filePath, serializable);
}

function copyVideoPlanAtomic(sourcePath, destinationPath) {
    atomicWriteJson(destinationPath, JSON.parse(fs.readFileSync(sourcePath, 'utf8')));
}

function assignFinalSceneIndices(scenes = []) {
    scenes.forEach((scene, index) => {
        if (!scene || typeof scene !== 'object') return;
        const stableSourceIndex = scene.originalIndex
            ?? scene.sourceSceneIndex
            ?? scene.index
            ?? index;
        scene.index = index;
        scene.sourceSceneIndex = stableSourceIndex;
        scene.originalIndex = scene.originalIndex ?? stableSourceIndex;
    });
    return scenes;
}

// Track membership is by scene NUMBER, not object identity. The MG carve and the
// template carve both rebuild the base track out of `{ ...scene }` copies, so past
// that point nothing on the track is reference-equal to its entry in
// scenesWithKeywords — an identity test answers "off track" for every scene, and a
// merge that trusts it appends the whole track back onto itself (147 scenes in,
// 270 out, every beat drawn twice, the copy on top missing its effect recipe).
// Same key `scene-coverage.js:_uniqueScenes` uses, for the same reason.
function partitionTrackMembership(scenesOnTrack = [], candidateScenes = []) {
    const onTrackObjects = new Set(scenesOnTrack);
    const onTrackNumbers = new Set(
        scenesOnTrack.map(s => Number(s?.index)).filter(Number.isFinite)
    );
    const isOnTrack = (s) => {
        if (!s) return false;
        if (onTrackObjects.has(s)) return true;
        const no = Number(s.index);
        return Number.isFinite(no) && onTrackNumbers.has(no);
    };
    const offTrack = (candidateScenes || []).filter(s =>
        s && !isOnTrack(s) && !s._presenterAnchor && !s.presenterInsert
    );
    return { isOnTrack, offTrack };
}

// Clean a folder of old build artifacts — removes ALL media and plan files
function cleanFolder(folderPath, label) {
    if (!fs.existsSync(folderPath)) return;
    const files = fs.readdirSync(folderPath);
    let cleaned = 0;
    const mediaExts = new Set(['.mp4', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.webm', '.mov', '.mkv', '.mp3', '.wav']);

    // Resume detection: if scene-N.mp4/jpg files already exist AND user opted into
    // resume mode, preserve downloaded scenes so footage-manager can skip them.
    // When BUILD_RESUME !== 'true', always wipe everything (fresh build).
    const resumeAllowed = process.env.BUILD_RESUME === 'true' || _normalizeRepeatFromStep(process.env.BUILD_REPEAT_FROM) === 'media';
    // Force-fresh footage: still skip Director/VP (the checkpoint lives elsewhere), but
    // DON'T preserve cached scene media — let the full wipe below run so footage-manager
    // re-downloads every clip. Lets the user re-pick footage without re-paying for the plan.
    const forceFreshFootage = process.env.BUILD_FORCE_FRESH_FOOTAGE === 'true';
    const hasSceneFiles = files.some(f => /^scene-\d+\.(mp4|jpg|jpeg|png|webp)$/i.test(f));
    if (resumeAllowed && hasSceneFiles && label === 'temp' && !forceFreshFootage) {
        // Only clean non-scene files (MG pre-renders, tmp files, etc.) — keep scene-N media
        for (const file of files) {
            if (/^scene-\d+\.(mp4|jpg|jpeg|png|webp)$/i.test(file)) continue; // keep
            const ext = path.extname(file).toLowerCase();
            if (mediaExts.has(ext) || file === 'video-plan.json') {
                try { fs.unlinkSync(path.join(folderPath, file)); cleaned++; } catch (e) {}
            }
        }
        if (cleaned > 0) console.log(`   🧹 Cleaned ${cleaned} old files from ${label} (kept scene media for resume)`);
        console.log(`   ♻️  Resume mode: ${files.filter(f => /^scene-\d+\.(mp4|jpg|jpeg|png|webp)$/i.test(f)).length} scene file(s) preserved`);
        return;
    }

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (mediaExts.has(ext) || file === 'video-plan.json') {
            try {
                fs.unlinkSync(path.join(folderPath, file));
                cleaned++;
            } catch (e) { /* ignore locked files */ }
        }
    }
    if (cleaned > 0) console.log(`   🧹 Cleaned ${cleaned} old files from ${label}`);
}

function getVisualLaneBreakdown(scenes = []) {
    const fsCount = scenes.filter(s => s.fullscreenMG).length;
    const templateCount = scenes.filter(s => s.templateHint && !s.fullscreenMG).length;
    const templateOverlayCount = scenes.filter(s => s.templateHint && !s.fullscreenMG && s.mgHint).length;
    const overlayCount = scenes.filter(s => s.mgHint && !s.fullscreenMG && !s.templateHint).length;
    const plainFootageCount = scenes.length - fsCount - templateCount - overlayCount;
    return { fsCount, templateCount, templateOverlayCount, overlayCount, plainFootageCount };
}

function logVisualLaneBreakdown(label, scenes = []) {
    const b = getVisualLaneBreakdown(scenes);
    const templateOverlay = b.templateOverlayCount ? ` (${b.templateOverlayCount} with overlay)` : '';
    console.log(`   [VP] ${label}: fs=${b.fsCount}  template=${b.templateCount}${templateOverlay}  overlay=${b.overlayCount}  plain-footage=${b.plainFootageCount}`);
}

function isUsableVisualValue(value) {
    if (value == null) return false;
    const text = String(value).trim();
    return !!text && !['none', 'null', 'undefined', 'n/a'].includes(text.toLowerCase());
}

const EDITORIAL_DECISION_FIELDS = [
    'mgHint',
    'fullscreenMG',
    'templateHint',
    'templateBgQuery',
    'bgQuery',
    'mapVariant',
    'templateType',
    'isListicleOverview',
    'effectPreset',
    'effects',
    'framing',
    'background',
    'transition',
    'transitionType',
    'motionStyle',
    'visualStyle',
];

const EDITOR_AGENT_MEDIA_ROLE_FIELDS = new Set([
    // These fields are creative decisions, but they are also Step-5 download
    // policy. Clearing them before media download turns template/fullscreen
    // graphics scenes into exact footage hunts.
    'fullscreenMG',
    'templateHint',
    'templateBgQuery',
    'bgQuery',
    'mapVariant',
    'templateType',
    'isListicleOverview',
]);

function editorAgentOwnsEditingTasks(scriptContext = {}) {
    return process.env.EDITOR_AGENT === 'true'
        || scriptContext?.editorAgentOwnsEditing === true
        || scriptContext?._editorAgentOwnsEditing === true;
}

function editorAgentPreservesPlannerMediaRoles(scriptContext = {}) {
    if (!editorAgentOwnsEditingTasks(scriptContext)) return false;
    const raw = process.env.EDITOR_AGENT_PRESERVE_VP_MEDIA_ROLES;
    if (raw != null && ['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase())) {
        return false;
    }
    return scriptContext?.editorAgentPreserveVPMediaRoles !== false;
}

function envFlagEnabled(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw == null) return defaultValue;
    const value = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return defaultValue;
}

function templateBackgroundDownloadsEnabled(scriptContext = {}) {
    if (scriptContext?.downloadTemplateBackgrounds === true || scriptContext?.templateBackgroundDownloads === true) return true;
    if (scriptContext?.downloadTemplateBackgrounds === false || scriptContext?.templateBackgroundDownloads === false) return false;
    if (process.env.TEMPLATE_BACKGROUND_DOWNLOADS != null) {
        return envFlagEnabled('TEMPLATE_BACKGROUND_DOWNLOADS', true);
    }
    if (process.env.DOWNLOAD_TEMPLATE_BACKGROUNDS != null) {
        return envFlagEnabled('DOWNLOAD_TEMPLATE_BACKGROUNDS', true);
    }
    return true;
}

function handOffVisualPlannerEditorialDecisions(scenes = [], scriptContext = {}, phase = 'handoff') {
    if (!editorAgentOwnsEditingTasks(scriptContext)) return { scenesTouched: 0, fieldsCleared: 0, counts: {} };

    scriptContext.editorAgentOwnsEditing = true;
    scriptContext._editorAgentOwnsEditing = true;
    scriptContext.editorAgentPreserveVPMediaRoles = editorAgentPreservesPlannerMediaRoles(scriptContext);

    let scenesTouched = 0;
    let fieldsCleared = 0;
    const counts = Object.fromEntries(EDITORIAL_DECISION_FIELDS.map(field => [field, 0]));
    const preservedCounts = Object.fromEntries(EDITORIAL_DECISION_FIELDS.map(field => [field, 0]));

    for (const scene of scenes || []) {
        if (!scene) continue;
        const archived = {};
        const preserved = {};

        for (const field of EDITORIAL_DECISION_FIELDS) {
            if (!isUsableVisualValue(scene[field])) continue;
            archived[field] = scene[field];
            if (scriptContext.editorAgentPreserveVPMediaRoles && EDITOR_AGENT_MEDIA_ROLE_FIELDS.has(field)) {
                preserved[field] = scene[field];
                preservedCounts[field]++;
                continue;
            }
            scene[field] = null;
            counts[field]++;
            fieldsCleared++;
        }

        if (scene._vpReviewed) {
            archived._vpReviewed = scene._vpReviewed;
            delete scene._vpReviewed;
        }

        if (Object.keys(archived).length > 0) {
            scenesTouched++;
            scene._visualPlannerEditorial = {
                ...(scene._visualPlannerEditorial || {}),
                [phase]: archived,
                deferredTo: 'editor-agent',
            };
            if (Object.keys(preserved).length > 0) {
                scene._editorAgentPreservedMediaRole = {
                    ...(scene._editorAgentPreservedMediaRole || {}),
                    [phase]: preserved,
                };
            }
        }
    }

    const preservedSummary = Object.entries(preservedCounts)
        .filter(([, count]) => count > 0)
        .map(([field, count]) => `${field}=${count}`)
        .join(', ');

    if (fieldsCleared > 0) {
        const summary = Object.entries(counts)
            .filter(([, count]) => count > 0)
            .map(([field, count]) => `${field}=${count}`)
            .join(', ');
        const preservedTag = preservedSummary ? ` | preserved media roles: ${preservedSummary}` : '';
        console.log(`   [Editor Agent] ${phase}: deferred ${fieldsCleared} VP/orchestrator editing field(s) across ${scenesTouched} scene(s): ${summary}${preservedTag}`);
    } else {
        const preservedTag = preservedSummary ? `; preserved media roles: ${preservedSummary}` : '';
        console.log(`   [Editor Agent] ${phase}: no VP/orchestrator editing fields to defer${preservedTag}`);
    }

    return { scenesTouched, fieldsCleared, counts, preservedCounts };
}

function restorePlannerMediaRolesFromArchive(scenes = [], scriptContext = {}, label = 'restore') {
    if (!editorAgentPreservesPlannerMediaRoles(scriptContext)) return { scenesTouched: 0, fieldsRestored: 0 };

    let scenesTouched = 0;
    let fieldsRestored = 0;
    const counts = {};
    const phases = ['pre-media-download', 'post-orchestrator', 'post-vp'];

    for (const scene of scenes || []) {
        if (!scene) continue;
        // A per-scene directive that turned this beat into an MG/template lane
        // nulled its footage fields on purpose — don't let the archive refill them.
        const _lock = Array.isArray(scene._directiveLock) ? scene._directiveLock : null;
        if (_lock && (_lock.includes('fullscreenMG') || _lock.includes('templateHint'))) continue;
        const archiveRoot = scene._visualPlannerEditorial || {};
        const preservedRoot = scene._editorAgentPreservedMediaRole || {};
        const restoredForScene = {};

        for (const phase of phases) {
            const archived = { ...(archiveRoot[phase] || {}), ...(preservedRoot[phase] || {}) };
            for (const field of EDITOR_AGENT_MEDIA_ROLE_FIELDS) {
                if (_lock && _lock.includes(field)) continue; // creator directive owns this field
                if (isUsableVisualValue(scene[field])) continue;
                if (!isUsableVisualValue(archived[field])) continue;
                scene[field] = archived[field];
                restoredForScene[field] = archived[field];
                counts[field] = (counts[field] || 0) + 1;
                fieldsRestored++;
            }
        }

        if (Object.keys(restoredForScene).length > 0) {
            scenesTouched++;
            scene._editorAgentRestoredMediaRole = {
                ...(scene._editorAgentRestoredMediaRole || {}),
                [label]: restoredForScene,
            };
        }
    }

    if (fieldsRestored > 0) {
        const summary = Object.entries(counts)
            .map(([field, count]) => `${field}=${count}`)
            .join(', ');
        console.log(`   [Editor Agent] ${label}: restored ${fieldsRestored} media-role field(s) from VP archive across ${scenesTouched} scene(s): ${summary}`);
    }

    return { scenesTouched, fieldsRestored };
}

function restoreBlockedMapsForUserRequest(scenes = [], scriptContext = {}, label = 'restore') {
    const instructionText = [
        scriptContext?._directives?.raw,
        scriptContext?.freeInstructions,
        scriptContext?.aiInstructions,
        scriptContext?.instructions,
        scriptContext?.directorsBrief?.freeInstructions,
        scriptContext?.directorsBrief?.aiInstructions,
        scriptContext?.buildOptions?.aiInstructions,
        process.env.AI_INSTRUCTIONS,
    ].filter(Boolean).join('\n').toLowerCase();
    if (!instructionText) return { restored: 0 };

    const wantsMap = /\b(?:use|prefer|show|add|put|include|make|keep|preserve)\s+(?:a\s+)?maps?\b/.test(instructionText)
        || /\bmaps?\s+(?:at|in|on|for|during|first|opening|hook|intro)\b/.test(instructionText)
        || /\b(?:route|locator|map[\s-]*chart|map animation)\b/.test(instructionText);
    if (!wantsMap) return { restored: 0 };

    const hookEnd = Number(scriptContext?.hookEndTime || 0);
    let restored = 0;
    for (const scene of scenes || []) {
        if (!scene || scene.fullscreenMG || !scene._mapBlockedBy) continue;
        const blockedMap = String(scene._mapBlockedBy || '').trim();
        if (!blockedMap.toLowerCase().startsWith('mapchart')) continue;

        const disposition = Array.isArray(scriptContext?._mapDispositions)
            ? scriptContext._mapDispositions.find(d => d.sceneIndex === scene.index)
            : null;
        const reason = String(disposition?.reason || scene._mapDispositionOverridden || '');
        const hookish = (scene.startTime || 0) <= Math.max(hookEnd, 12);
        const budgetBlocked = /budget|global cap|niche budget/i.test(reason);
        const weakGateBlocked = /no named place|no spatial verb|ambiguous/i.test(reason);
        if (!hookish && !budgetBlocked && !weakGateBlocked) continue;

        scene.fullscreenMG = blockedMap;
        if (!scene.mapVariant) {
            const lower = blockedMap.toLowerCase();
            scene.mapVariant = lower.includes('route') ? 'route'
                : lower.includes('region') ? 'regionHighlight'
                : lower.includes('comparison') ? 'comparison'
                : 'locator';
        }
        scene.keyword = null;
        scene.stockQuery = null;
        scene.webQuery = null;
        scene.sourceHint = null;
        scene.mediaType = null;
        scene.mediaIntent = {
            lane: 'fullscreenMG',
            strength: 'hard',
            reason: `restored blocked VP map for user map request (${label})`,
            policy: { download: 'skip' },
        };
        scene._mapRestoredForUserRequest = true;
        restored++;
    }

    return { restored };
}

function buildSceneRoleManifest(scenes = []) {
    return (scenes || []).map(s => ({
        index: s.index,
        role: s.fullscreenMG ? 'fullscreen-mg' : (s.templateHint ? 'template' : 'footage'),
        keyword: s.keyword || null,
        searchKeyword: s.searchKeyword || null,
        entityContext: Array.isArray(s.entityContext) ? s.entityContext : [],
        protectedTerms: Array.isArray(s.protectedTerms) ? s.protectedTerms : [],
        sourceHint: s.sourceHint || null,
        mediaType: s.mediaType || null,
        fullscreenMG: s.fullscreenMG || null,
        templateHint: s.templateHint || null,
        templateBgQuery: s.templateBgQuery || null,
        mgHint: s.mgHint || null,
        mediaIntent: s.mediaIntent || null,
        text: (s.text || '').substring(0, 60),
    }));
}

const TEMPLATE_MEDIA_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'over', 'under', 'that', 'this',
    'these', 'those', 'their', 'there', 'where', 'when', 'what', 'which', 'while',
    'around', 'nearly', 'still', 'just', 'template', 'hint', 'scene',
    // Mood/style adjectives and staging nouns — VP keeps emitting "dark ominous
    // background..." style bg queries that produce zero stock results because
    // no clip is tagged with abstract atmospheres. Strip them before search.
    'dark', 'darkened', 'ominous', 'moody', 'atmospheric', 'eerie', 'sinister',
    'gloomy', 'somber', 'foreboding', 'tense', 'bleak', 'grim', 'dramatic',
    'cinematic', 'epic', 'minimalist', 'abstract', 'stylized', 'artistic',
    'background', 'backdrop', 'atmosphere', 'ambience', 'mood', 'tone',
    'elements', 'aesthetic', 'vibe', 'feel', 'setting', 'imagery', 'composition'
]);

function compactTemplateMediaKeyword(value, maxWords = 8) {
    const seen = new Set();
    return String(value || '')
        .replace(/^[^:]+:/, ' ')
        .replace(/[_|;]/g, ' ')
        .replace(/[^a-zA-Z0-9\s-]/g, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(Boolean)
        .filter(w => {
            const key = w.toLowerCase();
            if (TEMPLATE_MEDIA_STOPWORDS.has(key)) return false;
            if (key.length < 3 && !/^\d+$/.test(key) && !['el', 'al', 'uk', 'us'].includes(key)) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, maxWords)
        .join(' ');
}

function getTemplateMediaSource(scriptContext = {}) {
    try {
        const { getNiche } = require('../data/niches');
        const niche = getNiche(scriptContext.nicheId || scriptContext.niche || 'general');
        const priority = Array.isArray(niche?.footagePriority?.video) ? niche.footagePriority.video : [];
        const source = priority.find(src => src && src !== 'stock');
        if (source) return source;
    } catch (_) {
        // Fall through to stable video fallback.
    }
    return 'youtube';
}

function normalizeMediaExtension(ext, fallback = '.mp4') {
    const clean = String(ext || '').trim();
    if (!clean) return fallback;
    return clean.startsWith('.') ? clean : `.${clean}`;
}

function enforceDisabledSourcePolicy(scenes = [], label = 'source policy') {
    let changed = 0;
    for (const scene of scenes || []) {
        if (!scene) continue;
        const before = scene.sourceHint || null;
        const after = sanitizeSourceHint(before, 'youtube');
        if (before && after && before !== after) {
            scene.sourceHint = after;
            changed++;
        }
        if (scene.mediaIntent?.sourceHint) {
            const intentAfter = sanitizeSourceHint(scene.mediaIntent.sourceHint, 'youtube');
            if (intentAfter && intentAfter !== scene.mediaIntent.sourceHint) {
                scene.mediaIntent.sourceHint = intentAfter;
                changed++;
            }
        }
        if (scene.mediaIntent?.policy?.sourceHint) {
            const policyAfter = sanitizeSourceHint(scene.mediaIntent.policy.sourceHint, 'youtube');
            if (policyAfter && policyAfter !== scene.mediaIntent.policy.sourceHint) {
                scene.mediaIntent.policy.sourceHint = policyAfter;
                changed++;
            }
        }
    }
    if (changed > 0) console.log(`   [Source Policy] ${label}: replaced ${changed} disabled source hint(s)`);
    return changed;
}

const VIDEO_MEDIA_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const IMAGE_MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function getFfmpegPath() {
    const candidates = [
        process.env.FFMPEG_PATH,
        (() => {
            try { return require('ffmpeg-static'); } catch (_) { return null; }
        })(),
        process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg',
        'ffmpeg',
    ].filter(Boolean);
    return candidates.find((candidate) => {
        try {
            return candidate === 'ffmpeg' || fs.existsSync(candidate);
        } catch (_) {
            return false;
        }
    }) || null;
}

// Resolve ffprobe. Note: the ffmpeg-static package ships ONLY ffmpeg (no
// sibling ffprobe), so try several known locations before falling back to a
// bare 'ffprobe' (which requires it to be on PATH).
function getFfprobePath() {
    const candidates = [];
    if (process.env.FFPROBE_PATH) candidates.push(process.env.FFPROBE_PATH);
    const ffmpeg = getFfmpegPath();
    if (ffmpeg && ffmpeg !== 'ffmpeg') {
        candidates.push(ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext || ''}`));
    }
    if (process.env.FFMPEG_PATH) {
        candidates.push(process.env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext || ''}`));
    }
    if (process.platform === 'win32') candidates.push('C:\\ffmg\\bin\\ffprobe.exe');
    for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch (_) { /* skip */ }
    }
    return 'ffprobe';
}

// OPENMONTAGE-BORROW-PLAN #3 — fail fast on a bad narration input BEFORE the
// pipeline spends time transcribing. Returns { ok, durationSec, channels,
// bitRate, sampleRate, fatal, issues[] }. Graceful: probe failure ≠ build fail.
function probeNarration(srcPath) {
    const out = { ok: false, durationSec: 0, channels: 0, bitRate: 0, sampleRate: 0, fatal: false, issues: [] };
    const ffprobe = getFfprobePath();
    try {
        const r = spawnSync(ffprobe, [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=channels,sample_rate,bit_rate:format=duration,bit_rate',
            '-of', 'json', srcPath,
        ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
        if (r.status !== 0 || !r.stdout) {
            out.issues.push('ffprobe could not read the file');
            return out; // non-fatal: let transcription try
        }
        const j = JSON.parse(r.stdout);
        const st = (j.streams && j.streams[0]) || {};
        out.durationSec = Number(j.format?.duration || 0);
        out.channels = Number(st.channels || 0);
        out.sampleRate = Number(st.sample_rate || 0);
        out.bitRate = Number(st.bit_rate || j.format?.bit_rate || 0);
        if (!j.streams || !j.streams.length) { out.issues.push('no audio stream'); out.fatal = true; return out; }
        if (!(out.durationSec > 0.5)) { out.issues.push(`duration is ${out.durationSec.toFixed(2)}s (empty/corrupt)`); out.fatal = true; return out; }
        if (out.channels === 1) out.issues.push('mono narration (stereo preferred)');
        if (out.bitRate && out.bitRate < 96_000) out.issues.push(`low bitrate ${Math.round(out.bitRate / 1000)}kbps`);
        out.ok = true;
        return out;
    } catch (e) {
        out.issues.push(`probe error: ${String(e.message || e).slice(0, 80)}`);
        return out; // non-fatal
    }
}

// OPENMONTAGE-BORROW-PLAN #2 — clean the narration once up front (de-rumble,
// de-ess-ish, gate, gentle compress, normalize to −16 LUFS) so downstream sync
// AND the final audio-finishing (#1) ducking math are deterministic. Writes a
// sibling `.cleaned.mp3`; returns the cleaned filename or null on any failure.
// Disable with NARRATION_CLEANUP=0.
function cleanNarration(inputDir, audioFileName) {
    if (/^(0|false|off|no)$/i.test(String(process.env.NARRATION_CLEANUP || '').trim())) return null;
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) return null;
    const src = path.join(inputDir, audioFileName);
    const cleanedName = audioFileName.replace(/\.(mp3|wav|m4a|aac)$/i, '') + '.cleaned.mp3';
    const dest = path.join(inputDir, cleanedName);
    const filter = 'highpass=f=80,lowpass=f=13000,agate=threshold=0.008:ratio=2:attack=10:release=250,'
        + 'acompressor=threshold=-18dB:ratio=3:attack=15:release=250:makeup=2,'
        + 'loudnorm=I=-16:LRA=11:TP=-1.5';
    try {
        const r = spawnSync(ffmpeg, [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', src, '-af', filter,
            '-c:a', 'libmp3lame', '-q:a', '2', dest,
        ], { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
        if (r.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
            try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
            return null;
        }
        return cleanedName;
    } catch (_) {
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
        return null;
    }
}

function probeVideoCodecLine(filePath) {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) return '';
    const result = spawnSync(ffmpeg, ['-hide_banner', '-i', filePath, '-frames:v', '0', '-f', 'null', '-'], {
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const line = output.split(/\r?\n/).find((l) => /\bVideo:\s/i.test(l));
    return line || '';
}

function isBrowserSafeVideo(filePath, ext) {
    const cleanExt = normalizeMediaExtension(ext || path.extname(filePath)).toLowerCase();
    if (!VIDEO_MEDIA_EXTS.has(cleanExt)) return true;
    const codecLine = probeVideoCodecLine(filePath);
    if (!codecLine) return false;
    if (cleanExt === '.mp4') {
        return /\bVideo:\s*h264\b/i.test(codecLine) && /\byuv420p\b/i.test(codecLine);
    }
    if (cleanExt === '.webm') {
        return /\bVideo:\s*(vp8|vp9|av1)\b/i.test(codecLine);
    }
    return false;
}

function transcodeVideoForBrowser(srcMedia, destMedia) {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) throw new Error('ffmpeg unavailable');

    const tmpDest = destMedia.replace(/\.mp4$/i, `.${Date.now()}.tmp.mp4`);
    try {
        execFileSync(ffmpeg, [
            '-y',
            '-i', srcMedia,
            '-map', '0:v:0',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            tmpDest,
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: Number(process.env.MEDIA_TRANSCODE_TIMEOUT_MS || 300_000),
            maxBuffer: 4 * 1024 * 1024,
        });
        fs.renameSync(tmpDest, destMedia);
    } catch (error) {
        try { if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest); } catch (_) {}
        throw error;
    }
}

function copyBrowserPlayableMedia(srcMedia, destMedia, ext) {
    const cleanExt = normalizeMediaExtension(ext || path.extname(srcMedia)).toLowerCase();
    if (!VIDEO_MEDIA_EXTS.has(cleanExt)) {
        if (path.resolve(srcMedia).toLowerCase() !== path.resolve(destMedia).toLowerCase()) {
            fs.copyFileSync(srcMedia, destMedia);
        }
        return { mediaPath: destMedia, ext: cleanExt, transcoded: false };
    }

    if (isBrowserSafeVideo(srcMedia, cleanExt)) {
        if (path.resolve(srcMedia).toLowerCase() !== path.resolve(destMedia).toLowerCase()) {
            fs.copyFileSync(srcMedia, destMedia);
        }
        return { mediaPath: destMedia, ext: cleanExt, transcoded: false };
    }

    const h264Dest = destMedia.replace(/\.[^.\\/]+$/i, '.mp4');
    try {
        transcodeVideoForBrowser(srcMedia, h264Dest);
        return { mediaPath: h264Dest, ext: '.mp4', transcoded: true };
    } catch (error) {
        log.warn(`[Media Trace] browser-safe transcode failed for ${path.basename(srcMedia)}: ${error.message}`);
        if (path.resolve(srcMedia).toLowerCase() !== path.resolve(destMedia).toLowerCase()) {
            fs.copyFileSync(srcMedia, destMedia);
        }
        return { mediaPath: destMedia, ext: cleanExt, transcoded: false };
    }
}

function markSceneMediaCopySkipped(scene, publicIndex, reason) {
    scene.mediaFile = null;
    scene.sourceProvider = null;
    scene.mediaWidth = 0;
    scene.mediaHeight = 0;
    scene.mediaDownloadStatus = 'failed';
    scene.mediaCopySkippedReason = reason;
    scene.publicIndex = publicIndex;
    scene.index = publicIndex;
    if (scene.mediaDiagnostics) {
        scene.mediaDiagnostics.final = {
            ...(scene.mediaDiagnostics.final || {}),
            copyStatus: 'skipped',
            publicAsset: null,
            copyReason: reason,
        };
    }
    console.log(`  [Media Trace] public asset S${scene.originalIndex ?? publicIndex}: skipped (${reason})`);
    delete scene._fileIndex;
}

function copyAcceptedSceneMediaToPublic(scene, publicIndex, publicDir) {
    // Talking-head PiP / SPLIT: the presenter rides beside a normal B-roll base. Copy the
    // presenter media too (the base B-roll is copied by the normal path below).
    if (scene.presenterInsert && (scene.presenterInsert.layout === 'pip' || scene.presenterInsert.layout === 'split') && typeof scene.presenterInsert.mediaFile === 'string' && scene.presenterInsert.mediaFile) {
        try {
            const psrc = resolveExistingMediaPath(scene.presenterInsert.mediaFile, [publicDir, config.paths.temp]);
            if (psrc) {
                const pext = normalizeMediaExtension(path.extname(psrc) || '.png', '.png');
                const isVid = ['.mp4', '.webm', '.mov', '.m4v'].includes(pext.toLowerCase());
                const pdest = path.join(publicDir, isVid ? `presenter-${scene.presenterInsert.layout}-${publicIndex}${pext}` : `presenter-asset${pext}`);
                if (isVid || !fs.existsSync(pdest)) fs.copyFileSync(psrc, pdest);
                scene.presenterInsert.mediaFile = pdest;
            }
        } catch (_) { /* non-fatal — presenter panel just won't show */ }
    }
    // Talking-head presenter anchor: media is an INJECTED asset (no downloader /
    // sourceProvider). Copy it to public and rewrite the reference, keeping the
    // uniform scene.index=publicIndex reindexing the rest of the loop relies on.
    // Static image → single shared file (dedup); avatar video → per-scene file.
    if (scene.presenterInsert && scene.presenterInsert.layout !== 'pip' && typeof scene.mediaFile === 'string' && scene.mediaFile) {
        const src = resolveExistingMediaPath(scene.mediaFile, [publicDir, config.paths.temp]);
        if (!src) { markSceneMediaCopySkipped(scene, publicIndex, 'presenter media missing'); return false; }
        const pext = normalizeMediaExtension(path.extname(src) || '.png', '.png');
        const isVid = ['.mp4', '.webm', '.mov', '.m4v'].includes(pext.toLowerCase());
        const destName = isVid ? `presenter-asset-${publicIndex}${pext}` : `presenter-asset${pext}`;
        const destMedia = path.join(publicDir, destName);
        try {
            if (isVid || !fs.existsSync(destMedia)) fs.copyFileSync(src, destMedia);
        } catch (e) {
            markSceneMediaCopySkipped(scene, publicIndex, `presenter copy failed: ${e.message}`);
            return false;
        }
        scene.mediaFile = destMedia;
        scene.mediaExtension = pext;
        scene.mediaDownloadStatus = 'presenter';
        scene.publicIndex = publicIndex;
        scene.index = publicIndex;
        delete scene.mediaCopySkippedReason;
        delete scene._fileIndex;
        console.log(`  [Media Trace] presenter asset S${scene.originalIndex ?? publicIndex}: ${destName} (${scene.presenterInsert.layout})`);
        return true;
    }

    const srcIdx = scene._fileIndex !== undefined ? scene._fileIndex : publicIndex;
    const provider = String(scene.sourceProvider || '').trim();
    const currentPath = typeof scene.mediaFile === 'string' ? scene.mediaFile : '';
    const plannedExt = normalizeMediaExtension(scene.mediaExtension || path.extname(currentPath) || '.mp4');

    // sourceProvider is the downloader's acceptance flag. A leftover temp file
    // without a provider is a rejected/failed attempt and must not reach public.
    if (!provider) {
        markSceneMediaCopySkipped(scene, publicIndex, 'no accepted provider');
        return false;
    }

    const expectedTemp = path.join(config.paths.temp, `scene-${srcIdx}${plannedExt}`);
    const candidates = [currentPath, expectedTemp].filter(Boolean);
    const srcMedia = candidates.find(file => {
        try {
            return fs.existsSync(file) && fs.statSync(file).isFile();
        } catch (_) {
            return false;
        }
    });

    if (!srcMedia) {
        markSceneMediaCopySkipped(scene, publicIndex, 'accepted media file missing');
        return false;
    }

    const ext = normalizeMediaExtension(path.extname(srcMedia) || plannedExt, plannedExt);
    const destBase = `scene-${srcIdx}-asset`;
    const destMedia = path.join(publicDir, `${destBase}${ext}`);
    const copied = copyBrowserPlayableMedia(srcMedia, destMedia, ext);
    const destName = path.basename(copied.mediaPath);

    scene.mediaFile = copied.mediaPath;
    scene.mediaExtension = copied.ext;
    scene.mediaDownloadStatus = scene.mediaDownloadStatus || (scene.reusedFromCache ? 'cached' : 'accepted');
    scene.publicIndex = publicIndex;
    scene.index = publicIndex;
    if (scene.mediaDiagnostics) {
        scene.mediaDiagnostics.final = {
            ...(scene.mediaDiagnostics.final || {}),
            copyStatus: 'copied',
            publicAsset: scene.mediaFile,
            publicIndex,
        };
    }
    console.log(`  [Media Trace] public asset S${scene.originalIndex ?? srcIdx}: ${destName} via ${scene.sourceProvider || 'unknown'}${copied.transcoded ? ' (transcoded H.264)' : ''}`);
    delete scene.mediaCopySkippedReason;
    delete scene._fileIndex;
    return true;
}

function normalizeMaybeFileRef(ref) {
    if (typeof ref !== 'string') return '';
    const text = ref.trim();
    if (!text) return '';
    if (/^file:\/\//i.test(text)) {
        try { return fileURLToPath(text); } catch (_) { return text; }
    }
    return text;
}

function resolveExistingMediaPath(ref, searchDirs = []) {
    const file = normalizeMaybeFileRef(ref);
    if (!file) return null;
    const candidates = [];
    if (path.isAbsolute(file)) candidates.push(file);
    for (const dir of searchDirs) {
        if (dir) candidates.push(path.join(dir, file));
    }
    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return path.resolve(candidate);
            }
        } catch (_) {}
    }
    return null;
}

function isInsideDir(file, dir) {
    if (!file || !dir) return false;
    const rel = path.relative(path.resolve(dir), path.resolve(file));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function templateMediaRef(tpl = {}) {
    return tpl.templateMediaFile || tpl.mgData?.templateMediaFile || '';
}

function templateMediaOffset(tpl = {}) {
    const raw = tpl.templateMediaOffset ?? tpl.mgData?.templateMediaOffset ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function clearTemplateMediaRef(tpl = {}) {
    delete tpl.templateMediaFile;
    delete tpl.templateMediaOffset;
    delete tpl._templateMediaUrl;
    if (tpl.mgData) {
        delete tpl.mgData.templateMediaFile;
        delete tpl.mgData.templateMediaOffset;
        delete tpl.mgData._templateMediaUrl;
    }
}

function setTemplateMediaRef(tpl = {}, file, offset = 0, sourcePatch = {}) {
    const cleanOffset = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;
    tpl.templateMediaFile = file;
    tpl.templateMediaOffset = cleanOffset;
    delete tpl._templateMediaUrl;
    if (tpl.mgData) {
        tpl.mgData.templateMediaFile = file;
        tpl.mgData.templateMediaOffset = cleanOffset;
        delete tpl.mgData._templateMediaUrl;
    }
    const priorSource = tpl.templateBackgroundSource || tpl.mgData?.templateBackgroundSource || {};
    tpl.templateBackgroundSource = { ...priorSource, ...sourcePatch };
    if (tpl.mgData) tpl.mgData.templateBackgroundSource = tpl.templateBackgroundSource;
}

function copyTemplateMediaToPublic(tpl = {}, templateIndex = 0, publicDir, options = {}) {
    const ref = templateMediaRef(tpl);
    if (!ref) return { status: 'none' };

    const srcMedia = resolveExistingMediaPath(ref, [config.paths.temp, publicDir]);
    if (!srcMedia) {
        clearTemplateMediaRef(tpl);
        if (options.log?.warn) {
            options.log.warn(`Template bg [${tpl.type || tpl.templateType || 'template'}] media missing; will use nearest available fallback`);
        }
        return { status: 'missing' };
    }

    const ext = normalizeMediaExtension(path.extname(srcMedia) || '.mp4');
    const typeSlug = String(tpl.type || tpl.templateType || tpl.mgData?.type || 'template')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'template';
    const sourceInfo = tpl.templateBackgroundSource || tpl.mgData?.templateBackgroundSource || {};

    if (isInsideDir(srcMedia, publicDir)) {
        setTemplateMediaRef(tpl, srcMedia, templateMediaOffset(tpl), {
            ...sourceInfo,
            file: path.basename(srcMedia),
            publicAsset: path.basename(srcMedia),
            preservedTemplateMedia: true,
            copyStatus: 'already-public',
        });
        return { status: 'already-public', path: srcMedia };
    }

    const destMedia = path.join(publicDir, `template-bg-${String(templateIndex).padStart(3, '0')}-${typeSlug}${ext}`);
    try {
        const copied = copyBrowserPlayableMedia(srcMedia, destMedia, ext);
        setTemplateMediaRef(tpl, copied.mediaPath, templateMediaOffset(tpl), {
            ...sourceInfo,
            file: path.basename(copied.mediaPath),
            publicAsset: path.basename(copied.mediaPath),
            preservedTemplateMedia: true,
            copyStatus: copied.transcoded ? 'copied-transcoded' : 'copied',
        });
        if (options.log?.dim) {
            const transcodeTag = copied.transcoded ? ' (transcoded)' : '';
            options.log.dim(`   Template bg [${tpl.type || tpl.templateType || 'template'}] preserved: ${path.basename(copied.mediaPath)}${transcodeTag}`);
        }
        return { status: copied.transcoded ? 'copied-transcoded' : 'copied', path: copied.mediaPath };
    } catch (error) {
        clearTemplateMediaRef(tpl);
        if (options.log?.warn) {
            options.log.warn(`Template bg [${tpl.type || tpl.templateType || 'template'}] copy failed: ${error.message}; will use nearest available fallback`);
        }
        return { status: 'copy-failed', error };
    }
}

// Legacy helper retained for manual diagnostics only. Scene media continuity
// reuse is disabled in the build path; missing scenes now need a real download
// or an explicit agentic visual fallback from footage-manager.js.
const FALLBACK_POOL_NICHES = new Set([
    'news.military',
    'news.politics',
    'explainer.military',
    'explainer.politics',
]);

async function downloadFallbackPool(scriptContext = {}) {
    const nicheId = scriptContext.nicheId || scriptContext.niche?.id;
    if (!nicheId || !FALLBACK_POOL_NICHES.has(nicheId)) return [];

    let niche;
    try {
        const { getNiche } = require('../data/niches');
        niche = getNiche(nicheId);
    } catch (_) { return []; }
    const keywords = niche?.searchPolicy?.fallbackKeywords || [];
    if (keywords.length === 0) return [];

    let PexelsVideoProvider;
    let PixabayVideoProvider;
    try {
        PexelsVideoProvider = require('../media/providers/pexels-video');
        PixabayVideoProvider = require('../media/providers/pixabay-video');
    } catch (e) {
        log.warn(`[fallback pool] provider modules unavailable: ${e.message}`);
        return [];
    }

    const candidates = [];
    const pexels = new PexelsVideoProvider();
    const pixabay = new PixabayVideoProvider();
    if (pexels.isAvailable()) candidates.push(pexels);
    if (pixabay.isAvailable()) candidates.push(pixabay);
    if (candidates.length === 0) {
        log.warn(`[fallback pool] no usable free stock providers (Pexels/Pixabay API keys unavailable)`);
        return [];
    }

    log.step(`📦 Step 4.95: Pre-downloading ${nicheId} fallback pool (${keywords.length} clips)`);
    const tempDir = config.paths.temp;
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch (_) {}

    const pool = [];
    let idx = 0;
    for (const keyword of keywords) {
        idx++;
        const outPath = path.join(tempDir, `pool-fallback-${idx}.mp4`);
        // Skip if cached from a previous build (BUILD_RESUME or partial run).
        if (fs.existsSync(outPath)) {
            try {
                const stat = fs.statSync(outPath);
                if (stat.size > 50_000) {
                    pool.push(_buildPoolDonor(outPath, keyword, 'cached'));
                    log.dim(`   [pool ${idx}] cached: ${path.basename(outPath)} ("${keyword}")`);
                    continue;
                }
            } catch (_) {}
        }

        let downloaded = false;
        for (const provider of candidates) {
            try {
                const results = await provider.search(keyword);
                if (!results || results.length === 0) continue;
                // Take the first non-watermarked result. Providers already
                // filter watermark hosts in base-provider, but the search
                // result schema is just {id,url,w,h} so we trust the upstream.
                const pick = results.find(r => r && r.url) || null;
                if (!pick) continue;
                await provider.download(pick.url, outPath);
                pool.push(_buildPoolDonor(outPath, keyword, provider.name));
                log.dim(`   [pool ${idx}] ${provider.name}: "${keyword}" → ${path.basename(outPath)}`);
                downloaded = true;
                break;
            } catch (e) {
                log.dim(`   [pool ${idx}] ${provider.name} failed for "${keyword}": ${e.message}`);
            }
        }
        if (!downloaded) {
            log.warn(`[pool ${idx}] no provider returned media for "${keyword}"`);
        }
    }

    log.ok(`Fallback pool ready: ${pool.length}/${keywords.length} clip(s) for ${nicheId}`);
    return pool;
}

function _buildPoolDonor(mediaFile, keyword, providerName) {
    return {
        mediaFile,
        mediaExtension: path.extname(mediaFile) || '.mp4',
        mediaType: 'video',
        sourceProvider: `${providerName} (pool)`,
        mediaWidth: 1920,
        mediaHeight: 1080,
        // Neutral midpoint so centerOf() distance ranking treats pool donors as
        // equidistant from all scenes — the poolPenalty in the ranker handles
        // the preference ordering.
        startTime: 0,
        endTime: 0,
        originalIndex: -1,
        _isPoolDonor: true,
        _poolKeyword: keyword,
    };
}

function fillMissingSceneMediaWithContinuity() {
    return 0;
}

const TEMPLATE_BACKGROUND_FALLBACK = 'gradient:grid-texture';

function templateBackgroundRefs(tpl = {}) {
    return [
        tpl.templateBgFile,
        tpl.templateMediaFile,
        tpl.backgroundMediaFile,
        tpl.backgroundImageFile,
        tpl.backgroundVideoFile,
        tpl.templateBackgroundFile,
        tpl.templateBackgroundMediaFile,
        tpl.templateBackgroundImageFile,
        tpl.templateBackgroundVideoFile,
        tpl.mgData?.templateBgFile,
        tpl.mgData?.templateMediaFile,
        tpl.mgData?.backgroundMediaFile,
        tpl.mgData?.backgroundImageFile,
        tpl.mgData?.backgroundVideoFile,
    ].filter(v => typeof v === 'string' && v.trim());
}

function hasDedicatedTemplateBackground(tpl = {}) {
    return Boolean(
        tpl.templateBgFile ||
        tpl.backgroundMediaFile ||
        tpl.backgroundImageFile ||
        tpl.backgroundVideoFile ||
        tpl.templateBackgroundFile ||
        tpl.templateBackgroundMediaFile ||
        tpl.templateBackgroundImageFile ||
        tpl.templateBackgroundVideoFile ||
        tpl.mgData?.templateBgFile ||
        tpl.mgData?.backgroundMediaFile ||
        tpl.mgData?.backgroundImageFile ||
        tpl.mgData?.backgroundVideoFile
    );
}

function ensureTemplateBackgroundFallback(tpl = {}) {
    if (!tpl.mgBackground || tpl.mgBackground === 'none') tpl.mgBackground = TEMPLATE_BACKGROUND_FALLBACK;
    if (!tpl.background || tpl.background === 'none') tpl.background = TEMPLATE_BACKGROUND_FALLBACK;
    if (tpl.mgData) {
        if (!tpl.mgData.mgBackground || tpl.mgData.mgBackground === 'none') tpl.mgData.mgBackground = tpl.mgBackground;
        if (!tpl.mgData.background || tpl.mgData.background === 'none') tpl.mgData.background = tpl.background;
    }
}

function mediaKindFromFile(file, fallback = 'image') {
    const ext = path.extname(String(file || '')).toLowerCase();
    if (VIDEO_MEDIA_EXTS.has(ext)) return 'video';
    if (IMAGE_MEDIA_EXTS.has(ext)) return 'image';
    return fallback;
}

function templateCenterOf(item = {}) {
    const span = visualSpanOf(item);
    return span ? (span.start + span.end) / 2 : Number(item.startTime || 0);
}

function templateDonorFileExists(file) {
    if (!file || typeof file !== 'string') return false;
    if (!path.isAbsolute(file)) return true;
    try { return fs.existsSync(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
}

function collectTemplateBackgroundDonors(scenes = [], mgScenes = [], extraDonors = []) {
    const donors = [];
    for (const scene of scenes || []) {
        if (!scene || !scene.mediaFile || scene.isMGScene) continue;
        if (!templateDonorFileExists(scene.mediaFile)) continue;
        donors.push({
            kind: 'scene',
            file: scene.mediaFile,
            mediaType: scene.mediaType || mediaKindFromFile(scene.mediaFile, 'video'),
            startTime: Number(scene.startTime || 0),
            endTime: Number(scene.endTime || scene.startTime || 0),
            mediaOffset: Number(scene.mediaOffset || 0),
            sourceIndex: scene.originalIndex ?? scene.index,
            sourceProvider: scene.sourceProvider || 'scene media',
            scoreBias: 0,
        });
    }

    for (const mg of mgScenes || []) {
        const mapFile = [
            mg?.mapImageFile,
            mg?.mapImagePath,
            mg?.renderAssets?.mapImageFile,
            mg?._mapScene?.renderAssets?.mapImageFile,
            mg?._mapScene?.mapImageFile,
        ].find(Boolean);
        if (!mapFile || !templateDonorFileExists(mapFile)) continue;
        donors.push({
            kind: 'map',
            file: mapFile,
            mediaType: 'image',
            startTime: Number(mg.startTime || 0),
            endTime: Number(mg.endTime || (Number(mg.startTime || 0) + Number(mg.duration || 0))),
            sourceIndex: mg.sceneIndex ?? mg.index,
            sourceProvider: 'map scene',
            // Nearby map plates usually make template cards read as infographic
            // scenes, so prefer them slightly over unrelated B-roll.
            scoreBias: -4,
        });
    }

    for (const donor of extraDonors || []) {
        if (!donor || !donor.mediaFile || !templateDonorFileExists(donor.mediaFile)) continue;
        donors.push({
            kind: 'pool',
            file: donor.mediaFile,
            mediaType: donor.mediaType || mediaKindFromFile(donor.mediaFile, 'video'),
            startTime: Number(donor.startTime || 0),
            endTime: Number(donor.endTime || donor.startTime || 0),
            mediaOffset: Number(donor.mediaOffset || 0),
            sourceIndex: donor.originalIndex ?? donor.index,
            sourceProvider: donor.sourceProvider || 'fallback pool',
            scoreBias: 650,
        });
    }
    return donors;
}

function applyTemplateBackgroundDonor(tpl, donor) {
    if (!tpl || !donor?.file) return false;
    ensureTemplateBackgroundFallback(tpl);

    if (donor.kind === 'map') {
        const file = String(donor.file);
        tpl.templateBgFile = path.isAbsolute(file) ? path.basename(file) : file;
        tpl.templateMediaOffset = 0;
        if (tpl.mgData) {
            tpl.mgData.templateBgFile = tpl.templateBgFile;
            tpl.mgData.templateMediaOffset = 0;
        }
    } else {
        tpl.templateMediaFile = donor.file;
        const offsetInDonor = Math.max(0, Number(tpl.startTime || 0) - Number(donor.startTime || 0));
        tpl.templateMediaOffset = (donor.mediaOffset || 0) + offsetInDonor;
        delete tpl._templateMediaUrl;
        if (tpl.mgData) {
            tpl.mgData.templateMediaFile = tpl.templateMediaFile;
            tpl.mgData.templateMediaOffset = tpl.templateMediaOffset;
            delete tpl.mgData._templateMediaUrl;
        }
    }
    tpl.templateBackgroundSource = {
        kind: donor.kind,
        sourceIndex: donor.sourceIndex ?? null,
        sourceProvider: donor.sourceProvider || null,
        file: path.basename(String(donor.file)),
    };
    if (tpl.mgData) tpl.mgData.templateBackgroundSource = tpl.templateBackgroundSource;
    return true;
}

function attachTemplateBackgroundsFromAvailableMedia(templateScenes = [], scenes = [], mgScenes = [], extraDonors = [], options = {}) {
    if (!Array.isArray(templateScenes) || templateScenes.length === 0) return 0;
    const donors = collectTemplateBackgroundDonors(scenes, mgScenes, extraDonors);
    let assigned = 0;

    for (const tpl of templateScenes) {
        if (!tpl || tpl.disabled) continue;
        ensureTemplateBackgroundFallback(tpl);

        const refs = templateBackgroundRefs(tpl);
        const hasDedicated = hasDedicatedTemplateBackground(tpl);
        if (hasDedicated) continue;
        if (refs.length && !options.refreshExistingMedia) continue;
        if (donors.length === 0) continue;

        const center = templateCenterOf(tpl);
        const ranked = donors
            .map(donor => {
                const donorSpan = visualSpanOf(donor);
                const overlapBonus = donorSpan && tpl.startTime < donorSpan.end && tpl.endTime > donorSpan.start ? -8 : 0;
                const distance = Math.abs(templateCenterOf(donor) - center);
                const typePenalty = donor.mediaType === 'video' ? 0 : 1.5;
                return { donor, score: distance + typePenalty + (donor.scoreBias || 0) + overlapBonus };
            })
            .sort((a, b) => a.score - b.score);

        const donor = ranked[0]?.donor;
        if (!donor || !applyTemplateBackgroundDonor(tpl, donor)) continue;
        assigned++;
        if (options.log?.dim) {
            options.log.dim(`   Template bg [${tpl.type || 'template'}] -> ${donor.kind} ${path.basename(String(donor.file))}`);
        }
    }
    return assigned;
}

function visualSpanOf(item) {
    if (!item) return null;
    const start = Number(item.startTime);
    if (!Number.isFinite(start)) return null;
    const endFromField = Number(item.endTime);
    const duration = Number(item.duration);
    const end = Number.isFinite(endFromField)
        ? endFromField
        : (Number.isFinite(duration) ? start + duration : NaN);
    if (!Number.isFinite(end) || end <= start) return null;
    return { start, end };
}

function spansOverlap(a, b, pad = 0.03) {
    return a && b && a.start < b.end - pad && a.end > b.start + pad;
}

function hasVisualCoverageForSpan(span, visualItems = []) {
    return visualItems.some(item => {
        if (!item || item.disabled) return false;
        return spansOverlap(span, visualSpanOf(item));
    });
}

function inferCoverageTemplateText(scene = {}) {
    const preferred = [
        scene.ideaLowerThird,
        scene.keyword,
        scene.visualIntent,
        scene.ideaVisual,
        scene.text,
    ].find(isUsableVisualValue);
    const text = String(preferred || 'Key Context').trim();
    return text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;
}

function buildCoverageTemplateScene(scene, scriptContext = {}, style = {}) {
    const span = visualSpanOf(scene);
    if (!span) return null;
    const duration = span.end - span.start;
    const type = duration >= 3 ? 'keyTakeaway' : (duration >= 2.5 ? 'chapterCard' : 'locationCard');
    const text = inferCoverageTemplateText(scene);
    const subTextSource = scene.text && scene.text !== text ? scene.text : (scene.ideaReason || scene.visualIntent || '');
    const subText = String(subTextSource || '').trim();
    const themeId = style.themeId || scriptContext?.themeId || 'standard';
    const mgStyle = style.mgStyle || scriptContext?.mgStyle || 'clean';
    const animation = type === 'keyTakeaway' ? 'springScale' : 'fadeSlide';
    const mgData = {
        type,
        templateType: true,
        text,
        subText,
        items: [],
        startTime: span.start,
        endTime: span.end,
        duration,
        templateContentStartTime: span.start,
        templateContentEndTime: span.end,
        templateContentDuration: duration,
        templateContentOffset: 0,
        trackId: 'video-track-3',
        mediaType: 'template',
        style: mgStyle,
        themeId,
        variant: 'standard',
        animation,
        sceneIndex: scene.index,
        selectionMode: 'coverage-repair',
        confidence: 0.66,
        position: 'center',
        category: 'fullscreen',
        keyword: `Template: ${type}`,
        bgQuery: scene.templateBgQuery || scene.bgQuery || scene.keyword || null,
    };
    return {
        isMGScene: true,
        trackId: 'video-track-3',
        mediaType: 'template',
        startTime: span.start,
        endTime: span.end,
        duration,
        text,
        subtext: subText,
        subText,
        type,
        position: 'center',
        style: mgStyle,
        keyword: `Template: ${type}`,
        mgData,
        templateType: true,
        templateContentStartTime: span.start,
        templateContentEndTime: span.end,
        templateContentDuration: duration,
        templateContentOffset: 0,
        variant: 'standard',
        animation,
        themeId,
        sceneIndex: scene.index,
        selectionMode: 'coverage-repair',
        items: [],
    };
}

function repairSkippedTemplateCoverage(scenesWithKeywords = [], scenesWithMedia = [], mgScenes = [], templateScenes = [], motionGraphics = [], scriptContext = {}, style = {}) {
    const repaired = [];
    const visualItems = [...(scenesWithMedia || []), ...(mgScenes || []), ...(templateScenes || []), ...(motionGraphics || [])];
    const existingTemplateSceneIndexes = new Set((templateScenes || []).map(t => t?.sceneIndex).filter(v => v != null));

    for (const scene of scenesWithKeywords || []) {
        if (!scene || !scene.templateHint || !scene._templateBackgroundOptional) continue;
        if (existingTemplateSceneIndexes.has(scene.index)) continue;
        const span = visualSpanOf(scene);
        if (!span || hasVisualCoverageForSpan(span, visualItems)) continue;

        const tpl = buildCoverageTemplateScene(scene, scriptContext, style);
        if (!tpl) continue;
        repaired.push(tpl);
        visualItems.push(tpl);
        existingTemplateSceneIndexes.add(scene.index);
    }

    if (repaired.length > 0) {
        templateScenes.push(...repaired);
        templateScenes.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    }
    return repaired;
}

function prepareTemplateBackgroundMedia(scenes = [], scriptContext = {}) {
    const prepared = [];
    const downloadBackgrounds = templateBackgroundDownloadsEnabled(scriptContext);
    for (const scene of scenes) {
        if (!scene || scene.fullscreenMG || !scene.templateHint) continue;

        const query = scene.templateBgQuery ||
            (isUsableVisualValue(scene.keyword) ? String(scene.keyword).trim() : '') ||
            compactTemplateMediaKeyword(`${scene.templateHint} ${scene.text || scene.visualIntent || ''}`) ||
            'documentary background footage';

        if (!downloadBackgrounds) {
            scene.templateBgQuery = scene.templateBgQuery || query;
            scene.bgQuery = scene.bgQuery || query;
            scene._templateBackupFootage = false;
            scene._templateMediaFootage = false;
            scene._templateBackgroundOptional = true;
            scene.mediaIntent = {
                lane: 'templateBackground',
                strength: 'soft',
                reason: 'optional template scene background; download skipped',
                mediaType: scene.mediaType || 'video',
                sourceHint: scene.sourceHint || getTemplateMediaSource(scriptContext),
                policy: {
                    download: 'skip',
                    allowTypeFallback: true,
                    allowProviderFallback: true,
                    allowStockFallback: true,
                    allowedMediaTypes: null,
                    allowedSources: null,
                },
            };
            continue;
        }

        scene.keyword = query;
        scene.stockQuery = scene.stockQuery || query;
        scene.webQuery = scene.webQuery || query;
        scene.sourceHint = isUsableVisualValue(scene.sourceHint) ? scene.sourceHint : getTemplateMediaSource(scriptContext);
        scene.mediaType = isUsableVisualValue(scene.mediaType) ? scene.mediaType : 'video';
        // Historical flag name kept because the media agent/scout lab use it to
        // identify template-background tolerance. Behavior is no longer optional:
        // these scenes are downloaded in the main media pass.
        scene._templateBackupFootage = true;
        scene._templateMediaFootage = true;
        scene._templateBackgroundOptional = false;
        scene.mediaIntent = {
            lane: 'templateBackground',
            strength: 'soft',
            reason: 'required media for template scene background',
            mediaType: scene.mediaType,
            sourceHint: scene.sourceHint,
            policy: {
                download: 'normal',
                mediaType: scene.mediaType,
                sourceHint: scene.sourceHint,
                allowTypeFallback: true,
                allowProviderFallback: true,
                allowStockFallback: true,
                allowedMediaTypes: null,
                allowedSources: null,
            },
        };
        prepared.push(scene);
    }
    return prepared;
}

// ====================================================================
// DUMB MODE: No AI, uses Whisper segments + random keywords/MGs
// ====================================================================
async function buildDumbVideo(transcription, audioFile, directorsBrief) {
    const { downloadAllMedia } = require('../media/footage-manager');
    const { assignTransitions } = require('../agents/ai-director');
    const productionMode = directorsBrief?.productionMode || 'faceless';

    const fps = config.video.fps;
    const segments = transcription.segments || [];
    const audioDuration = transcription.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);

    // Build scenes from Whisper segments
    console.log('📝 Creating scenes from Whisper segments...');
    const scenes = segments.map((seg, i) => ({
        index: i,
        text: seg.text.trim(),
        startTime: seg.start,
        endTime: seg.end,
        duration: Math.round((seg.end - seg.start) * fps),
        words: seg.words || []
    }));
    // Extend last scene to audio end
    if (scenes.length > 0 && audioDuration > scenes[scenes.length - 1].endTime + 0.3) {
        scenes[scenes.length - 1].endTime = audioDuration;
        scenes[scenes.length - 1].duration = Math.round((audioDuration - scenes[scenes.length - 1].startTime) * fps);
    }
    console.log(`   ✅ ${scenes.length} scenes from Whisper\n`);

    // Generate simple keywords from scene text (extract 2-3 key words)
    console.log('🔑 Generating keywords from text...');
    const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','shall','should','may','might','must','can','could','and','but','or','nor','for','yet','so','in','on','at','to','from','by','with','of','it','its','this','that','these','those','i','you','he','she','we','they','me','him','her','us','them','my','your','his','our','their','not','no','if','then','than','as','just','also','very','really','about','up','out','into','over','after','before']);
    for (const scene of scenes) {
        const words = scene.text.replace(/[^\w\s]/g, '').toLowerCase().split(/\s+/)
            .filter(w => w.length > 3 && !stopWords.has(w));
        const unique = [...new Set(words)].slice(0, 3);
        scene.keyword = unique.join(' ') || 'abstract background';
        scene.mediaType = 'video';
        scene.sourceHint = 'stock';
        scene.framing = 'fullscreen';
        scene.backgroundId = 'none';
        scene.background = 'none';
    }
    console.log(`   ✅ Keywords assigned\n`);

    // Assign theme-driven transitions
    console.log('🎬 Assigning transitions...');
    const defaultContext = { pacing: 'moderate', themeId: 'standard', productionMode };
    assignTransitions(scenes, defaultContext);
    console.log('');

    // Download media (no vision AI)
    console.log('═'.repeat(60));
    console.log('🎥 Downloading Media (no vision analysis)');
    console.log('═'.repeat(60));
    const downloadResult = await downloadAllMedia(scenes, defaultContext);
    let scenesWithMedia = downloadResult.scenes;

    // Generate random MGs (simple overlay types only)
    console.log('\n═'.repeat(60));
    console.log('✨ Generating Random Motion Graphics');
    console.log('═'.repeat(60));
    const overlayTypes = ['lowerThird', 'headline', 'callout', 'focusWord', 'statCounter'];
    const motionGraphics = [];
    for (let i = 0; i < scenesWithMedia.length; i++) {
        const scene = scenesWithMedia[i];
        // ~60% chance of getting an MG
        if (Math.random() > 0.6) continue;
        const type = overlayTypes[Math.floor(Math.random() * overlayTypes.length)];
        const dur = scene.endTime - scene.startTime;
        if (dur < 1.5) continue;

        // Extract a short phrase from scene text for MG content
        const mgText = scene.text.split(/[,.!?]/).filter(s => s.trim().length > 3)[0]?.trim() || scene.text.substring(0, 30);

        motionGraphics.push({
            type,
            text: mgText.substring(0, 40),
            subtext: '',
            startTime: scene.startTime + 0.3,
            duration: Math.min(dur - 0.5, 3),
            endTime: scene.startTime + 0.3 + Math.min(dur - 0.5, 3),
            position: ['bottom-left', 'bottom-right', 'center'][Math.floor(Math.random() * 3)],
            sceneIndex: i,
            category: 'overlay',
            style: 'clean'
        });
    }
    console.log(`   ✅ Placed ${motionGraphics.length} random MGs\n`);

    // Assign final indices
    scenesWithMedia.forEach((scene, i) => {
        scene._fileIndex = i;
        scene.originalIndex = scene.originalIndex ?? i;
        scene.index = i;
    });

    // Build video plan
    console.log('📋 Creating video plan...');
    const scriptContext = {
        summary: scenes[0]?.text?.substring(0, 80) || '',
        theme: '', tone: '', mood: '', pacing: 'moderate', visualStyle: 'cinematic',
        entities: [], keyStats: [], mainPoints: [], targetAudience: '', emotionalArc: '',
        format: 'documentary', sections: [],
        ctaDetected: false, ctaStartTime: null, hookEndTime: null,
        densityTarget: 3, nicheId: 'general', themeId: 'standard',
        productionMode,
        videoTitle: String(process.env.VIDEO_TITLE || '').trim(),
        aiInstructions: String(process.env.AI_INSTRUCTIONS || '').trim(),
    };

    const videoPlan = {
        audio: audioFile,
        totalDuration: audioDuration,
        fps: config.video.fps,
        width: config.video.width,
        height: config.video.height,
        scenes: scenesWithMedia,
        mgScenes: [],
        motionGraphics,
        mgStyle: 'clean',
        mapStyle: 'dark',
        scriptContext
    };

    const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..', '..');
    const publicDir = path.join(PROJECT_DIR, 'public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    // Persist creator directives on the degraded dumb path too (floor only, no AI
    // call). scriptContext is the same object referenced by videoPlan above, so
    // this also lands in video-plan.json.
    if (directorsBrief && !directivesDisabled()) {
        const _dd = directorsBrief._directives || directivesFloor(directorsBrief.freeInstructions || process.env.AI_INSTRUCTIONS || '');
        if (_dd) scriptContext._directives = _dd;
    }

    // Validate: fix any mediaType/mediaExtension contradictions before writing plan
    // (e.g. resume detection or provider errors can leave mediaType='image' + mediaExtension='.mp4')
    const _videoExts = new Set(['.mp4', '.webm', '.mov', '.mkv']);
    const _imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    let _mediaTypeFixes = 0;
    for (const scene of videoPlan.scenes || []) {
        if (!scene.mediaExtension) continue;
        const ext = scene.mediaExtension.toLowerCase();
        if (_videoExts.has(ext) && scene.mediaType === 'image') {
            scene.mediaType = 'video'; _mediaTypeFixes++;
        } else if (_imageExts.has(ext) && scene.mediaType === 'video') {
            scene.mediaType = 'image'; _mediaTypeFixes++;
        }
    }
    if (_mediaTypeFixes > 0) console.log(`   ✅ Fixed ${_mediaTypeFixes} mediaType contradictions before writing plan`);

    // Save plan
    const planPath = path.join(config.paths.temp, 'video-plan.json');
    writeVideoPlanAtomic(planPath, videoPlan);
    copyVideoPlanAtomic(planPath, path.join(publicDir, 'video-plan.json'));

    // Copy audio
    fs.copyFileSync(
        path.join(config.paths.input, audioFile),
        path.join(publicDir, audioFile)
    );

    // Copy media files
    console.log('📂 Copying files to public folder...');
    let copiedMediaCount = 0;
    let skippedMediaCount = 0;
    for (let i = 0; i < scenesWithMedia.length; i++) {
        const scene = scenesWithMedia[i];
        if (copyAcceptedSceneMediaToPublic(scene, i, publicDir)) copiedMediaCount++;
        else skippedMediaCount++;
    }
    if (skippedMediaCount > 0) {
        log.warn(`Skipped public media copy for ${skippedMediaCount} failed scene(s); copied ${copiedMediaCount} accepted file(s)`);
    }

    // Copy SFX
    const sfxDir = path.join(__dirname, '..', '..', 'assets', 'sfx');
    if (fs.existsSync(sfxDir)) {
        const sfxFiles = fs.readdirSync(sfxDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
        for (const sfxFile of sfxFiles) {
            fs.copyFileSync(path.join(sfxDir, sfxFile), path.join(publicDir, sfxFile));
        }
        if (sfxFiles.length > 0) log.dim(`🔊 Copied ${sfxFiles.length} SFX files`);
    }

    // Re-link listicle grid thumbnails to updated public scene paths
    // Check both mgScenes (legacy) and templateScenes (new system)
    for (const container of [videoPlan.mgScenes, videoPlan.templateScenes]) {
        if (!container) continue;
        for (const mg of container) {
            if (mg.type === 'listicleGrid' && videoPlan.scriptContext?.listicleItems) {
                mg._itemThumbnails = videoPlan.scriptContext.listicleItems.map(item => {
                    const scene = scenesWithMedia[item.startSceneIndex];
                    return scene?.mediaFile || null;
                });
            }
        }
    }

    // Re-save plan with updated paths
    writeVideoPlanAtomic(path.join(publicDir, 'video-plan.json'), videoPlan);
    console.log(`   ✅ Plan saved\n`);

    console.log('🎬 ==========================================');
    console.log('✅ DUMB BUILD COMPLETE! (0 AI credits used)');
    console.log('🎬 ==========================================\n');

    return videoPlan;
}

// ═══════════════════════════════════════════════════════════════
// Time-Targeted Directive Parser
// Parses user AI instructions for time/scene-targeted commands:
//   "Use map animation in the first 22s"
//   "splitScreen at 3:58"
//   "No maps after 1:00"
//   "Use infographic on scene 5"
// ═══════════════════════════════════════════════════════════════

// NOTE: DIRECTIVE_MG_ALIASES + timestamp parsing moved to src/directive-util.js
// (shared with the per-scene directive applier below and the compliance loop).

function _loadStudioPlan(audioDuration) {
    const projectDir = process.env.PROJECT_DIR || process.cwd();
    const planPath = path.join(projectDir, 'styles', '.studio-plan.json');
    if (!fs.existsSync(planPath)) return null;

    try {
        const raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        if (!raw || raw.version !== 2 || !Array.isArray(raw.scenes) || raw.scenes.length < 2) return null;
        if (Math.abs((raw.audioDuration || 0) - audioDuration) > 2) {
            console.log(`   ⚠️ Studio plan duration ${raw.audioDuration?.toFixed?.(1)}s doesn't match audio ${audioDuration.toFixed(1)}s — skipping`);
            return null;
        }

        const fps = config.video.fps;
        const scenes = raw.scenes.map((s, i) => ({
            index: i,
            text: s.text || '',
            startTime: s.startTime,
            endTime: s.endTime,
            duration: Math.round((s.endTime - s.startTime) * fps),
            words: Array.isArray(s.words) ? s.words : [],
            // Visual fields (if studio plan includes them)
            ...(s.keyword && { keyword: s.keyword }),
            ...(Array.isArray(s.protectedTerms) && { protectedTerms: s.protectedTerms }),
            ...(s.stockQuery && { stockQuery: s.stockQuery }),
            ...(s.webQuery && { webQuery: s.webQuery }),
            ...(s.sourceHint && { sourceHint: s.sourceHint }),
            ...(s.framing && { framing: s.framing }),
            ...(s.effectPreset && { effectPreset: s.effectPreset }),
            ...(s.mgHint && { mgHint: s.mgHint }),
            ...(s.fullscreenMG && { fullscreenMG: s.fullscreenMG }),
            ...(s.templateHint && { templateHint: s.templateHint }),
            ...(s.visualIntent && { visualIntent: s.visualIntent }),
            ...(s.backgroundId && { backgroundId: s.backgroundId }),
            ...(s.floatingAnim && { floatingAnim: s.floatingAnim }),
            ...(s.mediaType && { mediaType: s.mediaType }),
        }));

        // Build scriptContext from brief (or defaults)
        const brief = raw.brief || {};
        const { pickNicheFromContent } = require('../data/niches');
        const scriptContext = {
            summary: brief.summary || '',
            theme: brief.tone || '',
            tone: brief.tone || '',
            mood: '',
            pacing: brief.pacing || 'moderate',
            visualStyle: '',
            entities: brief.entities || [],
            entityTypes: brief.entityTypes || {},
            keyStats: [],
            mainPoints: [],
            targetAudience: '',
            emotionalArc: '',
            format: brief.format || 'documentary',
            sections: [],
            ctaDetected: brief.ctaDetected || false,
            ctaStartTime: brief.ctaStartTime || null,
            hookEndTime: brief.hookEndTime || null,
            eventType: brief.eventType || 'educational',
            densityTarget: 3,
            nicheId: brief.nicheId || 'general',
            themeId: brief.themeId || 'standard',
        };

        // If niche wasn't in brief, try to detect from summary
        if (!brief.nicheId && scriptContext.summary) {
            try {
                const detected = pickNicheFromContent(scriptContext);
                if (detected) scriptContext.nicheId = detected;
            } catch (_) {}
        }

        return { scenes, scriptContext, hasVisualPlan: raw.hasVisualPlan === true };
    } catch (e) {
        console.log(`   ⚠️ Studio plan load failed: ${e.message}`);
        return null;
    }
}

function _normalizeRepeatFromStep(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw === 'off' || raw === 'none') return '';
    if (['visual-planner', 'visual_planner', 'vp', 'step4', 'step-4'].includes(raw)) return 'visual-planner';
    if (['media', 'download-media', 'footage', 'step5', 'step-5'].includes(raw)) return 'media';
    if ([
        'motion-graphics',
        'motion_graphics',
        'graphics',
        'mg',
        'step6',
        'step-6',
    ].includes(raw)) return 'motion-graphics';
    return raw;
}

function _loadJsonCheckpoint(filePath, label) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        log.warn(`${label} checkpoint is corrupt - ignoring it (${err.message})`);
        return null;
    }
}

function _saveJsonCheckpoint(filePath, data, label) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data));
        log.ok(`${label} checkpoint saved`);
        return true;
    } catch (err) {
        log.warn(`${label} checkpoint save failed: ${err.message}`);
        return false;
    }
}

function _prepareScenesForVisualPlannerRepeat(scenes = []) {
    const visualOnlyFields = [
        'keyword', 'stockQuery', 'webQuery', 'mediaType', 'sourceHint',
        'framing', 'effectPreset', 'effects', 'mgHint', 'fullscreenMG',
        'templateHint', 'templateType', 'isListicleOverview', 'visualIntent',
        'backgroundId', 'floatingAnim', 'mediaFile', 'mediaPath', 'localPath',
        'mediaWidth', 'mediaHeight', 'mediaExtension', 'sourceProvider',
        'downloadStatus', 'reusedFromCache', 'reusedFromContinuity',
        '_templateBackupFootage', '_templateMediaFootage', '_topicFootageCandidates', '_templateScene',
    ];

    return (scenes || []).map((scene, i) => {
        const clean = { ...scene, index: Number.isInteger(scene.index) ? scene.index : i };
        for (const field of visualOnlyFields) delete clean[field];
        return clean;
    });
}

function _attachStyleProfile(scriptContext, directorsBrief) {
    if (!scriptContext || !directorsBrief?.styleProfile) return scriptContext;
    scriptContext.styleProfile = directorsBrief.styleProfile;
    scriptContext.styleBlock = directorsBrief.styleBlock;
    return scriptContext;
}

// Stamp the orthogonal production mode (faceless | talkingHead) + presenter media source
// onto scriptContext. Called at EVERY scriptContext entry (normal/studio/checkpoint/repeat)
// so resume/studio/repeat builds never lose the mode. Default faceless keeps OFF builds clean.
function _attachProductionMode(scriptContext, directorsBrief) {
    if (!scriptContext) return scriptContext;
    const briefMode = directorsBrief && directorsBrief.productionMode;
    scriptContext.productionMode = briefMode || scriptContext.productionMode || 'faceless';
    if (directorsBrief && directorsBrief.presenter) {
        scriptContext.presenter = directorsBrief.presenter;
    }
    // Stamp the compiled creator directives (structured "orders" object) the same
    // way — it rides on directorsBrief._directives (set once after the brief is
    // built). _-prefixed → survives the _fileIndex-only plan serializer into
    // video-plan.json, so a resume never loses the order. null → OFF unchanged.
    if (directorsBrief && directorsBrief._directives) {
        scriptContext._directives = directorsBrief._directives;
    }
    return scriptContext;
}

// Remove any persisted talking-head presenter state (used when a checkpoint/plan built
// in talkingHead is resumed as faceless — the mode changed under us). Restores the scenes
// to plain footage scenes so the bridge/Step-8 presenter branches never fire.
function _stripPresenterState(scenes, scriptContext) {
    if (scriptContext) scriptContext._presenterDispositions = [];
    if (!Array.isArray(scenes)) return 0;
    let stripped = 0;
    for (const s of scenes) {
        if (!s || !s.presenterInsert) continue;
        delete s.presenterInsert;
        delete s._presenterAnchor;
        delete s._presenterSpan;
        delete s._presenterContinuation;
        // undo enforce's footage suppression so the scene can render/download normally
        if (s.mediaIntent && s.mediaIntent.policy && s.mediaIntent.policy.download === 'skip') {
            delete s.mediaIntent.policy.download;
        }
        stripped++;
    }
    return stripped;
}

// Step 3.4 — Presenter placement (talking-head mode). PRIMARY = agentic Presenter
// Director (doctrine-driven, no caps, returns holds/spans); FALLBACK = deterministic
// floor. Runs BEFORE Map Assignment so maps yield the shared beats to the presenter
// (precedence). Faceless mode short-circuits to [] (no-op).
async function _runPresenterAssign(scenes, scriptContext, directorsBrief, label = '') {
    if (!scriptContext || scriptContext.productionMode !== 'talkingHead') { if (scriptContext) scriptContext._presenterDispositions = []; return; }
    // Global kill switch (shared with the floor): PRESENTER_INSERTS=0 disables inserts
    // entirely — must short-circuit BOTH the agentic director AND the floor.
    if (/^(0|false|off|no)$/i.test(String(process.env.PRESENTER_INSERTS || '').trim())) {
        scriptContext._presenterDispositions = [];
        return;
    }
    try {
        const { assignPresenterDispositions, logPresenterDispositions } = require('../agents/presenter-assignment');
        let dispositions = null;
        let source = 'agent';
        const projectDir = process.env.PROJECT_DIR || path.join(__dirname, '..', '..');
        try {
            const { directPresenter } = require('../agents/workers/presenter-director');
            dispositions = await directPresenter(scenes, scriptContext, { projectDir, log: (m) => console.log(m) });
        } catch (e) {
            log.warn(`Presenter Director errored${label ? ` (${label})` : ''}: ${e.message} — using floor`);
            dispositions = null;
        }
        if (!Array.isArray(dispositions)) {
            dispositions = assignPresenterDispositions(scenes, scriptContext, scriptContext.styleProfile || null, null, { directorsBrief });
            source = 'floor';
        }
        if (dispositions.length) {
            log.step(`🎤 Step 3.4: Presenter Director${label ? ` (${label})` : ''} [${source}]`);
            logPresenterDispositions(dispositions, scriptContext);
        }
        scriptContext._presenterDispositions = dispositions;
    } catch (err) {
        log.warn(`Presenter placement failed${label ? ` (${label})` : ''}: ${err.message} — no presenter inserts`);
        scriptContext._presenterDispositions = [];
    }
}

// Hard enforce AFTER the Planner: stamp presenterInsert + suppress footage on anchor scenes.
function _runPresenterEnforce(scenesWithKeywords, scriptContext, label = '') {
    if (!scriptContext._presenterDispositions || !scriptContext._presenterDispositions.length) return;
    try {
        const { enforcePresenterDispositions } = require('../agents/presenter-assignment');
        const { anchors, insets } = enforcePresenterDispositions(scenesWithKeywords, scriptContext._presenterDispositions, scriptContext);
        console.log(`   [Presenter] enforcement${label ? ` (${label})` : ''}: ${anchors} anchor + ${insets} pip insert(s)`);
    } catch (err) {
        log.warn(`Presenter enforcement failed${label ? ` (${label})` : ''}: ${err.message}`);
    }
}

// Per-scene / time-targeted directive applier — shared implementation lives in
// directive-util.applySceneDirectives (reused by the post-build acting agent +
// compliance loop). Replaces the old regex _applyTimeDirectives. Runs under
// EDITOR_AGENT (unlike the old parser). Every written field is recorded on
// scene._directiveLock so CEO workers + the compliance loop honor it.
const applySceneDirectives = directiveUtil.applySceneDirectives;

// ── Veo AI-video scope pass ──────────────────────────────────────────────────
// Opt-in. When VEO_AI_VIDEO is on, stamp sourceHint='ai-video' on eligible scenes
// according to VEO_SCOPE, so the Step 5 media layer GENERATES them instead of
// downloading. Never touches scenes a user directive already locked (respects
// scene._directiveLock 'sourceHint'), presenter anchors, map/template/graphic-only
// scenes, or template backgrounds. Cost-safe default is 'directives' (this pass
// stamps NOTHING — AI video only happens where the creator explicitly asked).
//   VEO_SCOPE = 'directives' (default) | 'hero' | 'all'
function _applyVeoScope(scenes, scriptContext) {
    // Opt-in, env-driven. VEO_AI_VIDEO on + a non-'directives' VEO_SCOPE stamps
    // sourceHint='ai-video' on eligible scenes so the Step 5 media layer generates
    // them (Kling/Veo) instead of downloading. Cost-safe default 'directives' stamps
    // nothing — AI video only happens where the creator explicitly asked.
    const on = /^(1|true|yes|on)$/i.test(String(process.env.VEO_AI_VIDEO || '').trim());
    if (!on || !Array.isArray(scenes)) return 0;
    const scope = String(process.env.VEO_SCOPE || 'directives').trim().toLowerCase();
    if (scope === 'directives' || scope === 'off' || scope === 'none') return 0;

    const eligible = (s) => {
        if (!s) return false;
        if (Array.isArray(s._directiveLock) && s._directiveLock.includes('sourceHint')) return false; // user set it
        if (s.sourceHint === 'ai-video') return false; // already ai-video
        if (s._presenter || s.isPresenter || s.presenterAnchor) return false; // talking-head hold
        if (s.isMapScene || s.mapDisposition === 'map' || s.fullscreenMG || s.mgType) return false; // graphic scene
        if (s.templateType || s.templateHint) return false; // template card
        const lane = s.mediaIntent?.lane || '';
        if (lane === 'mapimage' || lane === 'template') return false;
        const dl = s.mediaIntent?.policy?.download;
        if (dl === 'skip' || dl === 'template') return false; // no footage lane at all
        return true;
    };

    let stamped = 0;
    if (scope === 'all') {
        for (const s of scenes) {
            if (!eligible(s)) continue;
            s.sourceHint = 'ai-video';
            if (s.mediaDiagnostics?.planner) s.mediaDiagnostics.planner.sourceHint = 'ai-video';
            stamped++;
        }
    } else if (scope === 'hero') {
        // First eligible scene + any explicit hook/key scenes, capped so cost stays sane.
        const CAP = 3;
        for (const s of scenes) {
            if (stamped >= CAP) break;
            if (!eligible(s)) continue;
            const isKey = stamped === 0 || s.isHook || s.sceneClass === 'hook' || s.hookScene;
            if (!isKey) continue;
            s.sourceHint = 'ai-video';
            if (s.mediaDiagnostics?.planner) s.mediaDiagnostics.planner.sourceHint = 'ai-video';
            stamped++;
        }
    }
    return stamped;
}

// ─────────────────────────────────────────────────────────────
// Pre-build Qwen model registry sync + vision health check (live key probe)
// ─────────────────────────────────────────────────────────────
async function preflightQwenModelRegistrySync() {
    if (['0', 'false', 'off', 'no'].includes(String(process.env.QWEN_MODEL_SYNC || '1').toLowerCase())) {
        return;
    }
    try {
        const { syncQwenVisionModelRegistry } = require('../vision/qwen-model-discovery');
        const probe = !['0', 'false', 'off', 'no'].includes(String(process.env.QWEN_MODEL_SYNC_PROBE || '1').toLowerCase());
        const result = await syncQwenVisionModelRegistry({
            skipFresh: true,
            probe,
            concurrency: Math.max(1, Math.min(12, parseInt(process.env.QWEN_MODEL_SYNC_CONCURRENCY || '4', 10) || 4)),
            timeoutMs: Math.max(3000, Math.min(30000, parseInt(process.env.QWEN_MODEL_SYNC_PROBE_TIMEOUT_MS || '12000', 10) || 12000)),
            catalogTimeoutMs: Math.max(3000, Math.min(30000, parseInt(process.env.QWEN_MODEL_SYNC_CATALOG_TIMEOUT_MS || '15000', 10) || 15000)),
            intervalHours: Math.max(1, parseInt(process.env.QWEN_MODEL_SYNC_INTERVAL_HOURS || '24', 10) || 24),
        });
        if (result?.skipped) return;
        const counts = result?.registry?.counts || {};
        log.info(`   Qwen model registry synced: image=${counts.image || 0}, omni-http=${counts.omniHttp || 0}, realtime=${counts.omniRealtime || 0}, rejected=${counts.rejected || 0}`);
    } catch (e) {
        log.warn(`Qwen model registry sync skipped (non-fatal): ${e.message}`);
    }
}

// Step 5 (footage download) scores every B-roll candidate with Qwen vision.
// The per-key/per-model health is persisted in .qwen-vision-health.json, but
// that file goes STALE: the user swaps in a fresh API key, or a model that is
// actually alive got flagged dead by a transient timeout. When that happens
// the download step burns scene-budget time rotating through models that are
// dead (or rediscovering ones that are alive) before it lands on a working
// one — which blows the per-scene deadline and shows up as the "TIMEOUT —
// skipping" / "no winner" download failures.
//
// This runs ONE live probe of every (key, model) pair up front and rebuilds
// the health map from ground truth: a live 200 clears the stale exhaustion
// flag (refreshQwenVisionHealth → _recordQwenModelHealth → _clearModelExhaustion),
// a real quota error is re-confirmed. The build then starts with an accurate
// map so the vision rotation immediately picks a known-good model.
//
// Gated by QWEN_PREFLIGHT (default on). Always non-fatal — a probe failure or
// a fully-dead pool never blocks the build (vision falls back to Bedrock).
async function preflightVisionHealth() {
    if (['0', 'false', 'off', 'no'].includes(String(process.env.QWEN_PREFLIGHT || '1').toLowerCase())) {
        return;
    }
    const fastMedia = /^(1|true|on|yes)$/i.test(String(process.env.BUILD_FAST_MEDIA || '').trim());
    if (fastMedia) {
        log.info('🔬 Pre-build footage-vision check skipped — Fast Test uses random media; Motion QA remains active');
        return;
    }
    // Self-hosted GPU backends (aws / lightning) expose a single vLLM endpoint that is
    // intentionally OFF until it's started just-in-time at Step 5. Probing it now would time
    // out on every (key,model) pair and POISON the health map (everything flagged exhausted),
    // so the later scoring — even after the GPU is up — refuses to use it. The health-probe
    // machinery is for the multi-key DashScope pool, not a single self-hosted model. Skip it.
    const _vb = String(process.env.VISION_BACKEND || 'aws').toLowerCase();
    if (_vb === 'aws' || _vb === 'lightning') {
        log.info(`🔬 Pre-build vision check skipped — ${_vb} GPU vision starts just-in-time at media download (Step 5)`);
        return;
    }
    // Azure Managed Compute is a single always-on deployment reached with one key, not a
    // rotating pool — the same reason the GPU backends skip this. Probing it here would
    // only add a cold call and could poison the health map for a pool it isn't part of.
    if (_vb === 'azure-managed') {
        log.info('🔬 Pre-build vision check skipped — Azure Managed Compute is always on (no key pool to probe)');
        return;
    }
    await preflightQwenModelRegistrySync();
    let mod;
    try {
        const providerPath = require.resolve('../brain/ai-provider');
        delete require.cache[providerPath];
        mod = require('../brain/ai-provider');
    } catch (_) { return; }
    if (typeof mod.refreshQwenVisionHealth !== 'function') return;

    let statusBefore = null;
    try {
        statusBefore = typeof mod.getQwenVisionStatus === 'function' ? mod.getQwenVisionStatus() : null;
    } catch (_) { /* optional */ }
    if ((statusBefore?.imageKeys || 0) + (statusBefore?.omniKeys || 0) === 0) {
        log.info('🔬 Pre-build vision check: no Qwen vision keys — footage scoring will use the Bedrock vision chain');
        return;
    }

    log.step('🔬 Pre-build vision check (live key probe)');
    // Re-validate permanently-exhausted vision models FIRST — probe every switched-off model
    // in parallel and turn back on any that genuinely respond (free allocation reset / key
    // regained credit). Without this the pool only ever shrinks. Truth-based: a model returns
    // only if it actually works (not a timer). The health refresh below then sees the
    // recovered pool. Disable with QWEN_REVALIDATE_EXHAUSTED=0.
    try {
        if (typeof mod.revalidateExhaustedVisionModels === 'function') {
            const reval = await mod.revalidateExhaustedVisionModels();
            if (reval.probed > 0) {
                log.info(`   ♻️ Re-checked ${reval.probed} switched-off vision model(s) — ${reval.revived} came back online`);
            }
        }
    } catch (e) { log.dim(`   vision re-validation skipped (${e.message})`); }
    const t0 = Date.now();
    try {
        const concurrency = Math.max(1, Math.min(12, parseInt(process.env.QWEN_PREFLIGHT_CONCURRENCY || '8', 10) || 8));
        const timeoutMs = Math.max(5000, Math.min(30000, parseInt(process.env.QWEN_PREFLIGHT_TIMEOUT_MS || '12000', 10) || 12000));
        const report = await mod.refreshQwenVisionHealth({ lanes: ['image', 'omniHttp'], concurrency, timeoutMs });

        const perKey = {}; // keyIndex -> { image:{ok,total}, omniHttp:{ok,total} }
        for (const r of report.results || []) {
            const ki = String(r.keyIndex || '?');
            perKey[ki] = perKey[ki] || { image: { ok: 0, total: 0 }, omniHttp: { ok: 0, total: 0 } };
            const lane = r.lane === 'omniHttp' ? 'omniHttp' : 'image';
            perKey[ki][lane].total++;
            if (r.status === 'ok') perKey[ki][lane].ok++;
        }

        let status = null;
        try {
            status = typeof mod.getQwenVisionStatus === 'function' ? mod.getQwenVisionStatus() : null;
        } catch (_) { /* status is optional */ }

        let totalImageOk = Number(status?.image?.verifiedOk || 0);
        for (const img of status?.image?.perKey || []) {
            const healthy = Number(img.verifiedOk || 0) > 0;
            log.info(`   Qwen Image key ${img.keyIndex} (...${img.keyTail || 'unknown'}): ${img.verifiedOk || 0}/${img.total || 0} live, ${img.available || 0}/${img.total || 0} available ${healthy ? 'ok' : 'degraded'}`);
            if (!healthy) {
                console.log(`QWEN_KEY_VISION_DEGRADED|key=${img.keyIndex}|tail=${img.keyTail || 'unknown'}|image=${img.verifiedOk || 0}/${img.total || 0}|omni=lane-split`);
            }
        }
        for (const omni of status?.omniHttp?.perKey || []) {
            const healthy = Number(omni.verifiedOk || 0) > 0;
            log.info(`   Qwen Omni key ${omni.keyIndex} (...${omni.keyTail || 'unknown'}): HTTP ${omni.verifiedOk || 0}/${omni.total || 0} live, ${omni.available || 0}/${omni.total || 0} available ${healthy ? 'ok' : 'degraded'}`);
            if (!healthy) {
                console.log(`QWEN_KEY_VISION_DEGRADED|key=${omni.keyIndex}|tail=${omni.keyTail || 'unknown'}|image=lane-split|omni=${omni.verifiedOk || 0}/${omni.total || 0}`);
            }
        }
        for (const ki of []) {
            const e = perKey[ki];
            totalImageOk += e.image.ok;
            const healthy = e.image.ok > 0;
            const tail = status?.keyTails?.[Number(ki) - 1] || 'unknown';
            // Label the omni count "omni-http" — this lane is ONLY the
            // HTTP/chat-completions omni models. The realtime omni models are
            // WebSocket-only and cannot be HTTP-probed here; they are exercised
            // at runtime via the realtime lane, not by this preflight.
            log.info(`   Qwen key ${ki} (...${tail}): image ${e.image.ok}/${e.image.total} alive, omni-http ${e.omniHttp.ok}/${e.omniHttp.total} ${healthy ? 'ok' : 'degraded'}`);
            if (e.image.ok === 0 || e.omniHttp.ok === 0) {
                console.log(`QWEN_KEY_VISION_DEGRADED|key=${ki}|tail=${tail}|image=${e.image.ok}/${e.image.total}|omni=${e.omniHttp.ok}/${e.omniHttp.total}`);
            }
        }

        // Note the unprobed omni capacity so the per-key line above is never
        // mistaken for the whole omni pool (image + omni-http + omni-realtime).
        try {
            const rt = status?.omniRealtime;
            if (rt && rt.totalPerKey > 0) {
                const activeNote = rt.activeInCurrentRuntime ? 'used at runtime' : 'disabled';
                log.info(`   ℹ️ +${rt.totalPerKey} realtime omni model(s)/key (WebSocket — not HTTP-probed, ${activeNote})`);
            }
            for (const warn of status?.diagnostics?.warnings || []) {
                log.warn(`Vision diagnostic: ${warn}`);
            }
            for (const rec of status?.diagnostics?.recommendations || []) {
                log.info(`   suggestion: ${rec}`);
            }
        } catch (_) { /* note only — never block */ }

        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (totalImageOk > 0) {
            log.ok(`Vision ready: ${totalImageOk} live image model(s) across ${status?.imageKeys || 0} image key(s); Omni keys: ${status?.omniKeys || 0} (${secs}s)`);
        } else {
            log.warn(`No live Qwen vision models on any key — footage scoring falls back to Bedrock (slower + costs). Swap QWEN_VISION_API_KEY for a fresh key. (${secs}s)`);
        }
    } catch (e) {
        log.warn(`Pre-build vision check failed (non-fatal): ${e.message}`);
    }
}

async function buildVideo() {
    log.banner('FACELESS VIDEO GENERATOR - AUTO BUILD');

    const startTime = Date.now();
    resetCosts(); // begin a fresh per-run AI cost ledger
    const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..', '..');
    const CHECKPOINT_FILE = path.join(PROJECT_DIR, '.build-checkpoint.json');
    const DIRECTOR_CHECKPOINT_FILE = path.join(PROJECT_DIR, '.build-director-checkpoint.json');
    const repeatFromStep = _normalizeRepeatFromStep(process.env.BUILD_REPEAT_FROM);
    const repeatVisualPlanner = repeatFromStep === 'visual-planner';
    const repeatMotionGraphics = repeatFromStep === 'motion-graphics';

    if (repeatMotionGraphics) {
        log.step('Motion Graphics Only: preserving planning, footage and audio');
        const { rebuildMotionGraphicsOnly } = require('./rebuild-motion-graphics');
        const result = await rebuildMotionGraphicsOnly({
            projectDir: PROJECT_DIR,
            appRoot: path.resolve(__dirname, '..', '..'),
            log,
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log.banner('BUILD COMPLETE!');
        log.timing('Total time', elapsed);
        log.kv('Mode', 'Motion graphics + visual QA only');
        log.kv('Graphics', result.graphicCount);
        log.kv('QA', String(result.qa?.status || 'pass').toUpperCase());
        log.info('Planning, downloaded media, narration, transitions and SFX were preserved.');
        return result.plan;
    }

    // ── Resume from checkpoint? ──
    // If a checkpoint exists from a previous build (same audio file), skip
    // Steps 0-4.8 (transcription, AI Director, Visual Planner, Orchestrator)
    // and jump straight to Step 5 (download). Saves time AND AI credits.
    // Gated by BUILD_RESUME (forced true for "Repeat From Step: Media Download").
    //
    // We deliberately DO NOT delete the checkpoint on resume-OFF builds: resumeMode
    // already requires resumeAllowed, so a leftover snapshot can never leak into a
    // fresh build. Deleting it used to silently break the repeat-from-media
    // workflow — any normal build run between two repeat attempts wiped the
    // snapshot, so the next "Media Download" repeat had nothing to resume from and
    // fell back to a full Director re-run. The checkpoint is only ever written as a
    // complete plan at the end of Step 4.8, and resume is guarded below by an
    // audioFile match, so preserving it across fresh builds is safe (a fresh build
    // of the same audio overwrites it at Step 4.8 anyway).
    const resumeAllowed = process.env.BUILD_RESUME === 'true' || repeatFromStep === 'media';
    const resumeMode = resumeAllowed && fs.existsSync(CHECKPOINT_FILE);
    let checkpoint = null;
    if (resumeMode) {
        try {
            checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
            log.ok(`♻️  Build checkpoint found (saved ${new Date(checkpoint._savedAt).toLocaleString()})`);
            log.ok(`   ${checkpoint.scenes.length} scenes, ${checkpoint.scriptContext?.nicheId || 'auto'} niche — skipping Steps 0-4.8`);
        } catch (e) {
            log.warn(`Checkpoint file corrupt — starting fresh build`);
            checkpoint = null;
            try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
        }
    } else if (resumeAllowed && !fs.existsSync(CHECKPOINT_FILE)) {
        // Resume/repeat-from-media was requested but there is no snapshot to
        // resume from. Don't fall through silently — that looks like a bug
        // ("I picked Media Download but it re-ran the Director"). Explain it.
        const why = repeatFromStep === 'media' ? 'Repeat From Step = "Media Download"' : 'Resume Build = ON';
        log.warn(`${why}, but no .build-checkpoint.json exists yet — running a FULL build.`);
        log.warn(`   The checkpoint is written once this build finishes Step 4.8 (Director + Visual Planner) and now PERSISTS after success, so the very next repeat-from-media run will skip straight to download.`);
    }

    // Step 0: Clean old build artifacts
    log.step('🧹 Step 0: Cleaning old build files');
    cleanFolder(path.join(PROJECT_DIR, 'public'), 'public');
    cleanFolder(config.paths.temp, 'temp');

    // Step 1: Find voiceover file + create Director's Brief
    log.step('📁 Step 1: Finding audio file');
    // Use explicit filename from UI if provided via env var
    const explicitAudio = process.env.BUILD_AUDIO_FILE;
    const inputFiles = fs.readdirSync(config.paths.input);
    // Ignore our own `.cleaned.mp3` output when auto-detecting (see Step 1.5).
    let audioFile = explicitAudio
        ? inputFiles.find(f => f === explicitAudio)
        : inputFiles.find(f => (f.endsWith('.mp3') || f.endsWith('.wav')) && !/\.cleaned\.mp3$/i.test(f));

    if (!audioFile) {
        log.fail('No audio file found in /input folder!');
        if (explicitAudio) log.info(`Expected: ${explicitAudio}`);
        log.info('💡 Add your voiceover.mp3 to the input folder and try again.');
        process.exit(1);
    }
    log.ok(`Found: ${audioFile}`);

    // ── Step 1.1: Source-media probe (OPENMONTAGE-BORROW-PLAN #3) ──
    // Fail fast on a corrupt/empty narration; warn on mono/low-bitrate; surface
    // long-build up front. Never blocks the build on a probe failure itself.
    let _narrationDurSec = 0;
    try {
        const probe = probeNarration(path.join(config.paths.input, audioFile));
        _narrationDurSec = Number(probe.durationSec) || 0;
        if (probe.fatal) {
            log.fail(`Narration file is unusable: ${probe.issues.join('; ')}`);
            log.info('💡 Re-export the voiceover (a real, non-silent audio track) and try again.');
            process.exit(1);
        }
        if (probe.ok) {
            const mins = probe.durationSec / 60;
            log.kv('Audio probe', `${mins.toFixed(1)} min · ${probe.channels}ch · ${probe.bitRate ? Math.round(probe.bitRate / 1000) + 'kbps' : 'bitrate?'}`);
            if (probe.issues.length) log.warn(`Narration: ${probe.issues.join('; ')}`);
            if (mins > 20) log.warn(`Long narration (${mins.toFixed(0)} min) — expect a long build.`);
        } else if (probe.issues.length) {
            log.warn(`Narration probe: ${probe.issues.join('; ')} (continuing)`);
        }
    } catch (e) {
        log.warn(`Source-media probe skipped (${e.message})`);
    }

    // ── Step 1.5: Narration speech-cleanup (OPENMONTAGE-BORROW-PLAN #2) ──
    // Produce a cleaned, −16 LUFS copy and point the whole pipeline at it.
    // Falls back to the raw file on any failure. NARRATION_CLEANUP=0 disables.
    // SKIP for long narrations: the full-file re-encode is slow and the final
    // audio-mixer already loudnorm-normalizes the output — not worth blocking the
    // build. Threshold via NARRATION_CLEANUP_MAX_MIN (default 15).
    const _cleanMaxSec = Number(process.env.NARRATION_CLEANUP_MAX_MIN || 15) * 60;
    if (_narrationDurSec > _cleanMaxSec) {
        log.dim(`🎙️ Narration cleanup skipped — ${(_narrationDurSec / 60).toFixed(0)} min narration (> ${(_cleanMaxSec / 60)} min); final mix is loudness-normalized instead.`);
    } else {
        try {
            const cleaned = cleanNarration(config.paths.input, audioFile);
            if (cleaned) {
                audioFile = cleaned;
                log.ok(`🎙️ Narration cleaned & normalized → ${cleaned}`);
            }
        } catch (e) {
            log.warn(`Narration cleanup skipped (${e.message}) — using raw audio`);
        }
    }

    // Create Director's Brief (reads env vars: AI_INSTRUCTIONS, BUILD_FORMAT, BUILD_QUALITY_TIER, BUILD_AUDIENCE)
    const directorsBrief = createDirectorsBrief();
    const rawNiche = (process.env.BUILD_NICHE || 'auto').trim();
    log.substep('📋 Director\'s Brief:');
    log.kv('Format', `${directorsBrief.format} | Quality: ${directorsBrief.qualityTier} | Density: ${directorsBrief.tier.sceneDensity}/min`);
    log.kv('Niche', `${directorsBrief.nicheOverride}${rawNiche !== directorsBrief.nicheOverride ? ` (preset: ${rawNiche})` : ''} | Theme: ${directorsBrief.themeOverride}`);
    if (directorsBrief.presetPacing) log.kv('Pacing', directorsBrief.presetPacing);
    if (directorsBrief.freeInstructions) log.kv('Instructions', `"${directorsBrief.freeInstructions.substring(0, 80)}${directorsBrief.freeInstructions.length > 80 ? '...' : ''}"`);

    // Compile the creator's free-text order into ONE structured directives object
    // (cached brain call). Stashed on directorsBrief → _attachProductionMode stamps
    // it onto scriptContext at every entry (normal/studio/checkpoint/repeat), so
    // every stage — Director, Planner, media/vision, editor workers — reads the
    // same orders. null when off / no order (OFF build byte-identical to today).
    try {
        directorsBrief._directives = await compileDirectives(directorsBrief, {
            themeId: directorsBrief.themeOverride,
            nicheId: directorsBrief.nicheOverride,
            productionMode: directorsBrief.productionMode,
        }, { projectDir: PROJECT_DIR, log: (m) => log.info(m) });
    } catch (e) {
        log.warn(`Directive compile skipped (${e.message}) — build continues without structured directives`);
        directorsBrief._directives = null;
    }
    if (directorsBrief.audienceHint) log.kv('Audience', `"${directorsBrief.audienceHint}"`);
    if (directorsBrief.styleProfile) {
        const sp = directorsBrief.styleProfile;
        log.kv('🎨 Style Profile', `"${sp.name || 'unnamed'}"`);
        const detailParts = [];
        if (sp.pacing?.avgSceneDuration) detailParts.push(`avg ${sp.pacing.avgSceneDuration.toFixed(1)}s/scene`);
        if (sp.pacing?.cutsPerMinute)    detailParts.push(`${sp.pacing.cutsPerMinute} cuts/min`);
        if (sp.pacing?.rhythm)           detailParts.push(`${sp.pacing.rhythm} rhythm`);
        if (detailParts.length) log.kv('   pacing', detailParts.join(', '));
        const fParts = [];
        if (sp.footage?.stockVsReal)        fParts.push(sp.footage.stockVsReal);
        if (sp.footage?.videoToImageRatio)  fParts.push(`${Math.round(sp.footage.videoToImageRatio * 100)}% video`);
        if (sp.footage?.brollPattern)       fParts.push(`${sp.footage.brollPattern} broll`);
        if (fParts.length) log.kv('   footage', fParts.join(', '));
        const mgParts = [];
        if (sp.motionGraphics?.density)             mgParts.push(`${sp.motionGraphics.density} density`);
        if (sp.motionGraphics?.frequencyPerMinute)  mgParts.push(`${sp.motionGraphics.frequencyPerMinute}/min`);
        if (sp.motionGraphics?.preferredTypes?.length) mgParts.push(`prefer: ${sp.motionGraphics.preferredTypes.slice(0, 3).join('/')}`);
        if (mgParts.length) log.kv('   MG', mgParts.join(', '));
        const tParts = [];
        if (typeof sp.transitions?.cutRatio === 'number') tParts.push(`${Math.round(sp.transitions.cutRatio * 100)}% cuts`);
        if (sp.transitions?.avgTransitionDuration)        tParts.push(`avg ${sp.transitions.avgTransitionDuration}s`);
        if (tParts.length) log.kv('   transitions', tParts.join(', '));
        const eParts = [];
        if (sp.effects?.grain && sp.effects.grain !== 'none')         eParts.push(`grain:${sp.effects.grain}`);
        if (sp.effects?.vignette && sp.effects.vignette !== 'none')   eParts.push(`vignette:${sp.effects.vignette}`);
        if (sp.effects?.colorTemperature)                              eParts.push(sp.effects.colorTemperature);
        if (sp.effects?.contrastLevel)                                 eParts.push(`${sp.effects.contrastLevel} contrast`);
        if (eParts.length) log.kv('   effects', eParts.join(', '));
    }
    log.br();

    // AI thinking mode (from UI dropdown — works for Gemini, DeepSeek)
    let repeatDirectorCheckpoint = null;
    if (repeatFromStep && !['visual-planner', 'media', 'motion-graphics'].includes(repeatFromStep)) {
        log.warn(`Unknown repeat-from step "${repeatFromStep}" - running normal build`);
    }
    if (repeatVisualPlanner) {
        const candidate = _loadJsonCheckpoint(DIRECTOR_CHECKPOINT_FILE, 'Director');
        if (!candidate) {
            log.warn('Repeat from Visual Planner requested, but no Director checkpoint exists - running normal build');
        } else if (candidate.audioFile !== audioFile) {
            log.warn(`Director checkpoint is for "${candidate.audioFile}" but building "${audioFile}" - running normal build`);
        } else if (!Array.isArray(candidate.scenes) || !candidate.transcription || !candidate.scriptContext) {
            log.warn('Director checkpoint is missing scene/transcription/context data - running normal build');
        } else {
            repeatDirectorCheckpoint = candidate;
            log.ok(`Repeat from Visual Planner: restored Director checkpoint (${candidate.scenes.length} scenes, saved ${new Date(candidate._savedAt).toLocaleString()})`);
        }
    }

    const aiThinkingMode = (process.env.AI_THINKING || process.env.GEMINI_THINKING || 'off').trim().toLowerCase();
    if (aiThinkingMode !== 'off') {
        const { setAIThinking } = require('../brain/ai-provider');
        setAIThinking(aiThinkingMode);
    }

    // Live-probe vision keys before committing to a long build. Runs on both
    // fresh and resume paths (resume still does Step 5 download + scoring).
    await preflightVisionHealth();

    // Variables that flow from Steps 2-4.8 into Step 5+
    let transcription, buildLanguage, scenesWithKeywords, scriptContext, buildManifest, actualAudioDuration;
    let aiInstructions = '';
    const plannedV2Scenes = [];
    const compositorExplainers = [];

    // ── RESUME PATH: restore from checkpoint ──
    if (checkpoint && checkpoint.audioFile === audioFile) {
        log.step('♻️  Resuming from checkpoint — skipping Steps 2-4.8');
        transcription = checkpoint.transcription;
        buildLanguage = checkpoint.buildLanguage;
        scenesWithKeywords = checkpoint.scenes;
        scriptContext = checkpoint.scriptContext;
        _attachProductionMode(scriptContext, directorsBrief);
        // If a talkingHead checkpoint is resumed as faceless (mode changed under us), strip
        // the persisted presenter state so a "faceless" resume never renders holds.
        if (scriptContext.productionMode !== 'talkingHead') {
            const _s = _stripPresenterState(scenesWithKeywords, scriptContext);
            if (_s) log.info(`   [Presenter] stripped ${_s} stale presenter hold(s) — resumed as faceless`);
        }
        buildManifest = checkpoint.buildManifest || null;
        actualAudioDuration = checkpoint.actualAudioDuration;
        aiInstructions = (process.env.AI_INSTRUCTIONS || '').trim();
        enforceDisabledSourcePolicy(scenesWithKeywords, 'checkpoint-restore');
        const restoredRoles = restorePlannerMediaRolesFromArchive(scenesWithKeywords, scriptContext, 'checkpoint-restore');
        const restoredBlockedMaps = restoreBlockedMapsForUserRequest(scenesWithKeywords, scriptContext, 'checkpoint-restore');
        if (restoredRoles.fieldsRestored > 0 || restoredBlockedMaps.restored > 0) {
            buildManifest = buildSceneRoleManifest(scenesWithKeywords);
            log.info('   [Editor Agent] checkpoint manifest rebuilt after media-role/map restore');
        }
        if (restoredBlockedMaps.restored > 0) {
            log.info(`   [Map] checkpoint restored ${restoredBlockedMaps.restored} blocked VP map scene(s) for user map request`);
        }
        log.ok(`Restored ${scenesWithKeywords.length} scenes, niche=${scriptContext.nicheId}, lang=${buildLanguage}`);
        log.ok(`Saved ${((Date.now() - startTime) / 1000).toFixed(0)}s+ of AI calls & transcription`);
        log.br();
    } else {
    // ── FRESH BUILD PATH: run Steps 2-4.8 ──
    if (checkpoint && checkpoint.audioFile !== audioFile) {
        log.warn(`Checkpoint is for "${checkpoint.audioFile}" but building "${audioFile}" — starting fresh`);
        try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
    }

    if (repeatDirectorCheckpoint) {
        log.step('Repeat from Step 4: Visual Planner');
        transcription = repeatDirectorCheckpoint.transcription;
        const hasDumbFlag = process.argv.includes('--dumb');
        const smartAIEnv = (process.env.SMART_AI || '').trim().toLowerCase();
        const smartAI = !hasDumbFlag && smartAIEnv !== 'false' && smartAIEnv !== '0';
        log.kv('Smart AI', `${smartAI ? log.pc.green('ON') : log.pc.red('OFF')} (env="${process.env.SMART_AI}", flag=${hasDumbFlag})`);
        if (!smartAI) {
            log.warn('Repeat from Visual Planner needs Smart AI. Falling back to dumb build from cached transcription.');
            log.divider();
            const dumbResult = await buildDumbVideo(transcription, audioFile, directorsBrief);
            return dumbResult;
        }
        buildLanguage = repeatDirectorCheckpoint.buildLanguage || repeatDirectorCheckpoint.scriptContext?.language || 'en';
        actualAudioDuration = repeatDirectorCheckpoint.actualAudioDuration
            || transcription?.duration
            || (Array.isArray(transcription?.segments) && transcription.segments.length > 0
                ? transcription.segments[transcription.segments.length - 1].end
                : 0);
        scriptContext = {
            ...repeatDirectorCheckpoint.scriptContext,
            language: buildLanguage,
            _mapDispositions: null,
            _mapScenes: null,
        };
        _attachStyleProfile(scriptContext, directorsBrief);
        _attachProductionMode(scriptContext, directorsBrief);

        const scenes = _prepareScenesForVisualPlannerRepeat(repeatDirectorCheckpoint.scenes);
        log.ok(`Skipping transcription + AI Director. Re-running Visual Planner for ${scenes.length} existing scenes.`);

        await _runPresenterAssign(scenes, scriptContext, directorsBrief, 'repeat');
        try {
            const { assignMapDispositions, logDispositions } = require('../map/map-assignment');
            const dispositions = assignMapDispositions(scenes, scriptContext, scriptContext.styleProfile || null, null, { directorsBrief });
            logDispositions(dispositions, scriptContext);
            scriptContext._mapDispositions = dispositions;
        } catch (err) {
            log.warn(`Map assignment failed (repeat VP): ${err.message} - VP will run without disposition gate`);
            scriptContext._mapDispositions = null;
        }

        log.step('Step 4: Visual Planner (repeated)');
        scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

        if (scriptContext._mapDispositions) {
            try {
                const { enforceDispositions } = require('../map/map-assignment');
                const { blocked, upgraded, upgradeSkipped, fallbackRestored } = enforceDispositions(scenesWithKeywords, scriptContext._mapDispositions, scriptContext);
                const finalMap = scenesWithKeywords.filter(s => typeof s.fullscreenMG === 'string' && s.fullscreenMG.toLowerCase().startsWith('mapchart'));
                console.log(`   [VP] Map disposition enforcement (repeat): blocked=${blocked} upgraded=${upgraded} skipped=${upgradeSkipped} fallback=${fallbackRestored || 0}`);
                console.log(`   [VP] Final map scenes: ${finalMap.map(s => s.index).join(', ') || 'none'}  (${finalMap.length} of ${scenesWithKeywords.length})`);
                logVisualLaneBreakdown('Post-map breakdown (repeat)', scenesWithKeywords);
            } catch (err) {
                log.warn(`Map disposition enforcement failed (repeat): ${err.message}`);
            }
        }
        _runPresenterEnforce(scenesWithKeywords, scriptContext, 'repeat');

        if (process.env.STOP_AFTER === 'visual-planner') {
            log.ok('=== STOP_AFTER=visual-planner - dumping results ===');
            for (const s of scenesWithKeywords) {
                log.info(`Scene ${s.index}: keyword="${s.keyword}" fx=${s.effectPreset || (s.effects||[]).join(',') || 'none'} mgHint=${s.mgHint || 'null'}`);
            }
            log.ok('Visual Planner repeat test complete.');
            process.exit(0);
        }
    } else {

    // Step 2: Transcribe
    log.step('🎙️ Step 2: Transcribing audio');
    const audioPath = path.join(config.paths.input, audioFile);

    // ── Language resolution ──
    // BUILD_LANGUAGE can be: a valid code ('en','es','de','fr','it','ko') to force it,
    // 'auto' (or empty) to auto-detect from Whisper, which is the default.
    const { resolveBuildLanguage, getWhisperLanguage } = require('../data/language-helper');
    const langOverride = (process.env.BUILD_LANGUAGE || 'auto').trim().toLowerCase();
    const hintCode = langOverride !== 'auto' ? getWhisperLanguage(langOverride) : null;
    if (hintCode) log.kv('Language override', `${langOverride} (hinting Whisper)`);
    else log.kv('Language', 'auto (Whisper will detect)');

    transcription = await transcribeAudio(audioPath, { languageHint: hintCode });

    // Resolve the final build language: explicit override wins, else Whisper's detection,
    // else fall back to English. Stored on scriptContext so all downstream steps see it.
    buildLanguage = resolveBuildLanguage(langOverride, transcription.language);
    log.kv('Build language', `${buildLanguage}${buildLanguage !== (transcription.language || 'en') && langOverride === 'auto' ? ' (unsupported auto-detect, falling back)' : ''}`);

    // ====================================================================
    // DUMB MODE: Skip all AI calls, use Whisper segments + random stuff
    // ====================================================================
    const hasDumbFlag = process.argv.includes('--dumb');
    const smartAIEnv = (process.env.SMART_AI || '').trim().toLowerCase();
    const smartAI = !hasDumbFlag && smartAIEnv !== 'false' && smartAIEnv !== '0';
    log.kv('Smart AI', `${smartAI ? log.pc.green('ON') : log.pc.red('OFF')} (env="${process.env.SMART_AI}", flag=${hasDumbFlag})`);
    if (!smartAI) {
        log.warn('DUMB MODE — No AI credits used');
        log.divider();
        const dumbResult = await buildDumbVideo(transcription, audioFile, directorsBrief);
        return dumbResult;
    }

    actualAudioDuration = transcription.duration || (transcription.segments.length > 0 ? transcription.segments[transcription.segments.length - 1].end : 0);

    // ── Studio Plan: check if Style Studio produced a combined plan ──
    const studioPlan = _loadStudioPlan(actualAudioDuration);
    if (studioPlan) {
        log.step('🎨 Steps 3+4: Style Studio Plan (pre-built by agent)');
        let scenes = studioPlan.scenes;
        scriptContext = studioPlan.scriptContext;
        scriptContext.language = buildLanguage;
        if (directorsBrief.styleProfile) {
            scriptContext.styleProfile = directorsBrief.styleProfile;
            scriptContext.styleBlock = directorsBrief.styleBlock;
        }
        _attachProductionMode(scriptContext, directorsBrief);
        log.ok(`Loaded ${scenes.length} scenes from Style Studio plan`);

        // Step 3.5: Map Assignment — same deterministic gate as the normal
        // path. Runs once on the studio scenes, then the enforcer is applied
        // once against whichever scenes array reaches the pipeline
        // (pre-built OR VP-output). Slice 1 must gate both entry paths.
        await _runPresenterAssign(scenes, scriptContext, directorsBrief, 'studio');
        try {
            const { assignMapDispositions, logDispositions } = require('../map/map-assignment');
            const dispositions = assignMapDispositions(scenes, scriptContext, scriptContext.styleProfile || null, null, { directorsBrief });
            logDispositions(dispositions, scriptContext);
            scriptContext._mapDispositions = dispositions;
        } catch (err) {
            log.warn(`Map assignment failed (studio): ${err.message} — enforcement skipped`);
            scriptContext._mapDispositions = null;
        }

        _saveJsonCheckpoint(DIRECTOR_CHECKPOINT_FILE, {
            _savedAt: Date.now(),
            stage: 'director',
            audioFile,
            transcription,
            buildLanguage,
            scenes,
            scriptContext,
            actualAudioDuration,
        }, 'Director');

        if (studioPlan.hasVisualPlan) {
            log.ok(`Visual plan included — skipping Step 4 (Visual Planner)`);
            scenesWithKeywords = scenes;
        } else {
            log.ok(`No visual plan — running Step 4 normally`);
            scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);
        }

        if (scriptContext._mapDispositions) {
            try {
                const { enforceDispositions } = require('../map/map-assignment');
                const { blocked, upgraded, upgradeSkipped, fallbackRestored } = enforceDispositions(scenesWithKeywords, scriptContext._mapDispositions, scriptContext);
                const finalMap = scenesWithKeywords.filter(s => typeof s.fullscreenMG === 'string' && s.fullscreenMG.toLowerCase().startsWith('mapchart'));
                console.log(`   [VP] Map disposition enforcement (studio): blocked=${blocked} upgraded=${upgraded} skipped=${upgradeSkipped} fallback=${fallbackRestored || 0}`);
                console.log(`   [VP] Final map scenes: ${finalMap.map(s => s.index).join(', ') || 'none'}  (${finalMap.length} of ${scenesWithKeywords.length})`);
                logVisualLaneBreakdown('Post-map breakdown (studio)', scenesWithKeywords);
            } catch (err) {
                log.warn(`Map disposition enforcement failed (studio): ${err.message}`);
            }
        }
        _runPresenterEnforce(scenesWithKeywords, scriptContext, 'studio');
        log.br();
    } else {
    // ── Normal path: AI Director + Visual Planner ──

    // Step 3: AI Director — Scene creation + context analysis + format detection
    log.step('🎬 Step 3: AI Director (Scene Creation + Context Analysis)');
    const dirResult = await analyzeAndCreateScenes(transcription, {
        ...directorsBrief,
        language: buildLanguage,
    });
    let scenes = dirResult.scenes;
    scriptContext = dirResult.scriptContext;
    // Attach resolved language to scriptContext so ALL downstream AI steps + the renderer see it.
    // This is the single place language enters the scriptContext — no other code should set it.
    scriptContext.language = buildLanguage;
    // Attach reference style profile (loaded by directors-brief.js) so all downstream steps can read it.
    if (directorsBrief.styleProfile) {
        scriptContext.styleProfile = directorsBrief.styleProfile;
        scriptContext.styleBlock = directorsBrief.styleBlock;
    }
    _attachProductionMode(scriptContext, directorsBrief);
    log.ok(`Created ${scenes.length} scenes with rich context (lang=${buildLanguage})`);
    log.br();

    // Step 3.5: Map Assignment — deterministic per-scene disposition
    // (must_map | can_map | must_not_map). Runs BEFORE VP so the planner's
    // output can be gated. Part of the map-system rebuild (slice 1).
    await _runPresenterAssign(scenes, scriptContext, directorsBrief);
    try {
        const { assignMapDispositions, logDispositions } = require('../map/map-assignment');
        const dispositions = assignMapDispositions(scenes, scriptContext, scriptContext.styleProfile || null, null, { directorsBrief });
        logDispositions(dispositions, scriptContext);
        scriptContext._mapDispositions = dispositions;
    } catch (err) {
        log.warn(`Map assignment failed: ${err.message} — VP will run without disposition gate`);
        scriptContext._mapDispositions = null;
    }

    // Step 4: Visual Planning — Batch keywords + media type + source hints
    _saveJsonCheckpoint(DIRECTOR_CHECKPOINT_FILE, {
        _savedAt: Date.now(),
        stage: 'director',
        audioFile,
        transcription,
        buildLanguage,
        scenes,
        scriptContext,
        actualAudioDuration,
    }, 'Director');

    log.step('🎨 Step 4: Visual Planner (Batch Keyword Generation)');
    scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

    // Apply map-disposition gate: strip mapChart from must_not_map, upgrade must_map.
    if (scriptContext._mapDispositions) {
        try {
            const { enforceDispositions } = require('../map/map-assignment');
            const { blocked, upgraded, upgradeSkipped, fallbackRestored } = enforceDispositions(scenesWithKeywords, scriptContext._mapDispositions, scriptContext);
            const finalMap = scenesWithKeywords.filter(s => typeof s.fullscreenMG === 'string' && s.fullscreenMG.toLowerCase().startsWith('mapchart'));
            console.log(`   [VP] Map disposition enforcement: blocked=${blocked} upgraded=${upgraded} skipped=${upgradeSkipped} fallback=${fallbackRestored || 0}`);
            console.log(`   [VP] Final map scenes: ${finalMap.map(s => s.index).join(', ') || 'none'}  (${finalMap.length} of ${scenesWithKeywords.length})`);
            logVisualLaneBreakdown('Post-map breakdown', scenesWithKeywords);
        } catch (err) {
            log.warn(`Map disposition enforcement failed: ${err.message}`);
        }
    }
    _runPresenterEnforce(scenesWithKeywords, scriptContext);

    // DEBUG: Stop after Visual Planner for testing
    if (process.env.STOP_AFTER === 'visual-planner') {
        log.ok('=== STOP_AFTER=visual-planner — dumping results ===');
        for (const s of scenesWithKeywords) {
            log.info(`Scene ${s.index}: keyword="${s.keyword}" fx=${s.effectPreset || (s.effects||[]).join(',') || 'none'} mgHint=${s.mgHint || 'null'}`);
        }
        log.ok('Visual Planner test complete.');
        process.exit(0);
    }

    } // end of studioPlan else (normal Director + VP path)
    } // end repeat-from-step else

    enforceDisabledSourcePolicy(scenesWithKeywords, 'post-VP');
    const editorAgentOwnsEditing = editorAgentOwnsEditingTasks(scriptContext);
    if (editorAgentOwnsEditing) {
        handOffVisualPlannerEditorialDecisions(scenesWithKeywords, scriptContext, 'post-vp');
    }

    // ── Step 4.1: Per-scene / time-targeted directive applier ──
    // Compiled directives.perScene[] (from directive-compiler) → deterministic
    // per-scene field writes, locked via scene._directiveLock so the CEO workers
    // + compliance loop honor them. Runs UNDER EDITOR_AGENT (the old regex parser
    // was disabled there); footage-replacing lanes (MG/template) must be set here,
    // before Step 5 download + the map/template build passes.
    aiInstructions = directorsBrief.freeInstructions || '';
    const _psApplied = applySceneDirectives(scriptContext._directives, scenesWithKeywords, scriptContext);
    if (_psApplied > 0) {
        log.ok(`Applied per-scene/time directive(s) to ${_psApplied} scene(s) from the creator's order`);
    }

    // ── Veo AI-video scope pass ── stamp sourceHint='ai-video' on eligible scenes
    // (runs AFTER the directive applier so user per-scene locks win). No-op unless
    // VEO_AI_VIDEO is on with a non-'directives' scope.
    const _veoStamped = _applyVeoScope(scenesWithKeywords, scriptContext);
    if (_veoStamped > 0) {
        log.ok(`🤖 AI video → Veo scope='${process.env.VEO_SCOPE}' → ${_veoStamped} scene(s) will be AI-generated`);
    }

    // Step 4.7: Compositor Planner — DISABLED (V2 overlay system needs rework)
    const nicheId = scriptContext.nicheId || 'general';

    // Promote mgHint → fullscreenMG when the hint is a fullscreen MG type.
    // This prevents wasted footage downloads for scenes the MG engine will cover
    // entirely — BUT only when it's safe:
    //   - not a hook scene (needs strong visual footage to grab attention)
    //   - not a CTA scene (needs closing footage, handled upstream by VP guard too)
    //   - not a scene the planner already chose a templateHint for (templates win)
    // Otherwise we silently swallow the AI's editorial intent.
    if (!editorAgentOwnsEditing) {
    const { FULLSCREEN_MG_TYPES: _FSMG } = require('../agents/ai-motion-graphics');
    const _hookEnd = parseFloat(scriptContext.hookEndTime);
    const _ctaStart = parseFloat(scriptContext.ctaStartTime);
    const _ctaOn = !!scriptContext.ctaDetected;
    const _phaseOf = (s) => {
        const st = s.startTime || 0;
        if (!Number.isNaN(_hookEnd) && st < _hookEnd) return 'hook';
        if (_ctaOn && !Number.isNaN(_ctaStart) && st >= _ctaStart) return 'cta';
        return 'body';
    };
    let _promoted = 0, _promoSkipped = 0;
    for (const s of scenesWithKeywords) {
        if (s.fullscreenMG) continue; // already set by VP
        if (!s.mgHint) continue;
        if (s.templateHint) continue; // planner chose a template — respect it

        const hintStr = String(s.mgHint).trim();
        const colonIdx = hintStr.indexOf(':');
        const hintType = colonIdx > 0 ? hintStr.substring(0, colonIdx).trim() : hintStr;
        if (!_FSMG.has(hintType)) continue;

        const phase = _phaseOf(s);
        if (phase === 'hook' || phase === 'cta') {
            _promoSkipped++;
            log.info(`   Scene ${s.index}: kept mgHint "${hintType}" as overlay (${phase} zone — no fullscreen promotion)`);
            continue;
        }

        s.fullscreenMG = s.mgHint;
        s.mgHint = null;
        s.keyword = null;
        s.stockQuery = null;
        s.webQuery = null;
        s.mediaType = null;
        s.sourceHint = null;
        _promoted++;
        log.info(`   Scene ${s.index}: promoted mgHint "${hintType}" → fullscreenMG (saves a download)`);
    }
    if (_promoted > 0 || _promoSkipped > 0) {
        log.info(`   🎛️  mgHint promoter: ${_promoted} promoted, ${_promoSkipped} kept as overlay`);
    }

    // Mark listicle overview scene as template early — saves a wasted footage download
    // The overview scene (scene before first item) will get a listicleGrid template in Step 6.5
    } else {
        log.info('   [Editor Agent] VP mgHint/fullscreen promotion disabled; Editor Agent owns MG/template decisions');
    }

    if (!editorAgentOwnsEditing && scriptContext.format === 'listicle' && scriptContext.listicleItems?.length > 0) {
        const firstItem = scriptContext.listicleItems.find(it => it.startSceneIndex != null);
        if (firstItem) {
            const overviewIdx = Math.max(0, firstItem.startSceneIndex - 1);
            const overviewScene = scenesWithKeywords.find(s => s.index === overviewIdx);
            if (overviewScene && !overviewScene.fullscreenMG) {
                overviewScene.fullscreenMG = 'listicleGrid'; // keeps scene excluded from footage download
                overviewScene.templateType = 'listicleGrid'; // signals ai-templates.js ownership
                overviewScene.isListicleOverview = true;
                overviewScene.keyword = null;
                overviewScene.stockQuery = null;
                overviewScene.webQuery = null;
                overviewScene.mediaType = null;
                overviewScene.sourceHint = null;
                log.info(`   Scene ${overviewIdx}: marked as listicleGrid template — skipping footage download`);
            }
        }
    }

    // Pre-filter: clear fullscreenMG if the type isn't allowed in this niche
    // (prevents scenes from being skipped for footage download when the MG won't be rendered)
    const { getNiche } = require('../data/niches');
    const nicheConfig = getNiche(nicheId);
    const nicheAllowedMGs = nicheConfig.allowedMGs || [];
    const enforceNicheMgGate = process.env.VP_ENFORCE_NICHE_MG === '1';
    for (const s of scenesWithKeywords) {
        if (!s.fullscreenMG) continue;
        const colonIdx = s.fullscreenMG.indexOf(':');
        const mgType = colonIdx > 0 ? s.fullscreenMG.substring(0, colonIdx).trim() : s.fullscreenMG.trim();
        const structuralListicleGrid = mgType === 'listicleGrid'
            && (scriptContext.format === 'listicle' || s.isListicleOverview);
        if (structuralListicleGrid) continue;
        if (!FULLSCREEN_MG_TYPES.has(mgType)) {
            log.warn(`Scene ${s.index}: fullscreenMG "${mgType}" is unknown — will download footage instead`);
            s.fullscreenMG = null;
            if (!s.keyword || s.keyword === 'none') {
                // Prefer the CLEAN footage-query fields (templateBgQuery/bgQuery/
                // stockQuery/webQuery) before visualIntent — visualIntent on a
                // template/graphics scene is a TREATMENT description ("Fullscreen
                // Red Sea template presenting"), not a searchable footage subject.
                s.keyword = s.templateBgQuery || s.bgQuery || s.stockQuery || s.webQuery
                    || s.visualIntent || s.text?.substring(0, 40) || 'abstract background';
            }
            if (!s.mediaType) s.mediaType = 'video';
            if (!s.sourceHint) s.sourceHint = 'stock';
            s.sourceHint = sanitizeSourceHint(s.sourceHint, 'youtube') || s.sourceHint;
            continue;
        }
        if (enforceNicheMgGate && nicheAllowedMGs.length > 0 && !nicheAllowedMGs.includes(mgType)) {
            log.warn(`Scene ${s.index}: fullscreenMG "${mgType}" not allowed in "${nicheConfig.name}" niche — will download footage instead`);
            s.fullscreenMG = null;
            // Restore download fields so footage manager can handle this scene
            if (!s.keyword || s.keyword === 'none') {
                // Prefer the CLEAN footage-query fields (templateBgQuery/bgQuery/
                // stockQuery/webQuery) before visualIntent — visualIntent on a
                // template/graphics scene is a TREATMENT description ("Fullscreen
                // Red Sea template presenting"), not a searchable footage subject.
                s.keyword = s.templateBgQuery || s.bgQuery || s.stockQuery || s.webQuery
                    || s.visualIntent || s.text?.substring(0, 40) || 'abstract background';
            }
            if (!s.mediaType) s.mediaType = 'video';
            if (!s.sourceHint) s.sourceHint = 'stock';
            s.sourceHint = sanitizeSourceHint(s.sourceHint, 'youtube') || s.sourceHint;
        }
    }

    // ── Orchestrator Phase 1: Pre-Build AI Review ──
    log.step('🧠 Step 4.8: Orchestrator — Pre-Build Review');
    buildManifest = null;
    try {
        const orchResult = await preBuildReview(scenesWithKeywords, scriptContext);
        buildManifest = orchResult.manifest;
        if (orchResult.changes.length > 0) {
            log.ok(`Orchestrator applied ${orchResult.changes.length} optimization(s)`);
        }
        if (orchResult.warnings.length > 0) {
            log.warn(`${orchResult.warnings.length} warning(s) — check log for details`);
        }
    } catch (error) {
        log.warn(`Orchestrator Phase 1 failed: ${error.message} — continuing without`);
    }
    enforceDisabledSourcePolicy(scenesWithKeywords, 'post-orchestrator');
    if (editorAgentOwnsEditingTasks(scriptContext)) {
        handOffVisualPlannerEditorialDecisions(scenesWithKeywords, scriptContext, 'post-orchestrator');
    }
    const preCompileRestoredMaps = restoreBlockedMapsForUserRequest(scenesWithKeywords, scriptContext, 'pre-map-compile');
    if (preCompileRestoredMaps.restored > 0 && buildManifest) {
        buildManifest = buildSceneRoleManifest(scenesWithKeywords);
        log.info(`   [Map] restored ${preCompileRestoredMaps.restored} blocked VP map scene(s) before map compile`);
    }
    log.br();

    // Slice 2: compile authoritative MapScene objects for every surviving map scene.
    // Runs ONCE on the FINAL post-orchestration state — after directives, mgHint promotion,
    // listicle injection, niche filtering, AND preBuildReview mutations — so MapScene
    // reflects the true fullscreen map state that will actually render.
    // Shared by both studio and normal paths (branch split ended above).
    try {
        const { compileMapScenes, logCompiledMapScenes } = require('../map/map-compiler');
        const { compiled, skipped } = compileMapScenes(scenesWithKeywords, scriptContext, scriptContext._mapDispositions || []);
        scriptContext._mapScenes = compiled;
        logCompiledMapScenes(compiled, skipped);
    } catch (err) {
        log.warn(`Map compiler failed: ${err.message} — downstream will use legacy payload only`);
    }

    // ── Save checkpoint (Steps 2-4.8 complete) ──
    // If the build fails later (download, MG, etc.), next build resumes from here.
    try {
        const checkpointData = {
            _savedAt: Date.now(),
            audioFile,
            transcription,
            buildLanguage,
            scenes: scenesWithKeywords,
            scriptContext,
            buildManifest,
            actualAudioDuration,
        };
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpointData));
        log.ok(`💾 Checkpoint saved — next build will resume from Step 5 if same audio`);
    } catch (e) {
        log.warn(`Checkpoint save failed: ${e.message}`);
    }

    } // end of fresh build else block

    // Snapshot every downloader-facing field BEFORE the last stages that can still
    // invent a brand-new search query (role restore, map restore, Template Rhythm).
    // The findability judge in Step 4.8 never saw those queries, so anything that
    // changes here gets re-judged below instead of shipping unchecked.
    const _preDownloadQuerySnapshot = new Map();
    try {
        for (const s of scenesWithKeywords) {
            if (!s) continue;
            _preDownloadQuerySnapshot.set(s.index, [
                s.stockQuery || '', s.searchKeyword || '', s.keyword || '', s.webQuery || '',
                s.mediaType || '', s.sourceHint || '', s.mediaIntent?.lane || '',
                s.fullscreenMG ? 1 : 0, s.templateHint ? 1 : 0,
            ].join('|'));
        }
    } catch (_) {}

    if (editorAgentOwnsEditingTasks(scriptContext)) {
        handOffVisualPlannerEditorialDecisions(scenesWithKeywords, scriptContext, 'pre-media-download');
    }
    const preMediaRestoredRoles = restorePlannerMediaRolesFromArchive(scenesWithKeywords, scriptContext, 'pre-media-download');
    const preMediaRestoredMaps = restoreBlockedMapsForUserRequest(scenesWithKeywords, scriptContext, 'pre-media-download');
    if ((preMediaRestoredRoles.fieldsRestored > 0 || preMediaRestoredMaps.restored > 0) && buildManifest) {
        buildManifest = buildSceneRoleManifest(scenesWithKeywords);
        log.info('   [Editor Agent] build manifest rebuilt after media-role/map restore');
    }
    if (preMediaRestoredMaps.restored > 0) {
        log.info(`   [Map] restored ${preMediaRestoredMaps.restored} blocked VP map scene(s) before media download`);
    }

    if (editorAgentOwnsEditingTasks(scriptContext)) {
        log.step('🎴 Step 4.85: Editor Agent Template Rhythm');
        try {
            const { runEditorAgentTemplateRhythm } = require('../agents/ceo');
            const rhythmResult = await runEditorAgentTemplateRhythm(scenesWithKeywords, scriptContext, {
                aiInstructions,
                log: (m) => log.dim(m),
            });
            if (rhythmResult?.changed > 0) {
                buildManifest = buildSceneRoleManifest(scenesWithKeywords);
                log.ok(`Template Rhythm demoted ${rhythmResult.changed} template role(s) back to footage before media download`);
            } else if (rhythmResult?.ok) {
                log.ok('Template Rhythm kept the current template plan');
            } else {
                log.warn('Template Rhythm did not change the template plan');
            }
        } catch (error) {
            log.warn(`Template Rhythm failed: ${error.message} — keeping VP template roles`);
        }
        enforceDisabledSourcePolicy(scenesWithKeywords, 'post-template-rhythm');
    }

    // ── Step 4.87: Findability re-check on brand-new queries ────────────────────────
    // Step 4.8's rescue judged the queries that existed THEN. Template Rhythm and the
    // role/map restores above can demote a scene back to footage with a query written
    // seconds ago that no library can return — those used to reach the downloader
    // unjudged and burn the whole per-scene budget. Delta only: same judge, same
    // prompt, only the scenes whose query actually changed. Off with RETRIEVABILITY_RESCUE=off.
    if (String(process.env.RETRIEVABILITY_RESCUE || 'on').toLowerCase() !== 'off'
        && _preDownloadQuerySnapshot.size > 0) {
        try {
            const changedIdx = new Set();
            for (const s of scenesWithKeywords) {
                if (!s) continue;
                const before = _preDownloadQuerySnapshot.get(s.index);
                const after = [
                    s.stockQuery || '', s.searchKeyword || '', s.keyword || '', s.webQuery || '',
                    s.mediaType || '', s.sourceHint || '', s.mediaIntent?.lane || '',
                    s.fullscreenMG ? 1 : 0, s.templateHint ? 1 : 0,
                ].join('|');
                if (before === undefined || before !== after) changedIdx.add(s.index);
            }
            if (changedIdx.size > 0) {
                log.step('🔎 Step 4.87: Findability re-check (new queries only)');
                const { applyRetrievabilityRescue } = require('../media/retrievability-rescue');
                const rescue = await applyRetrievabilityRescue(scenesWithKeywords, scriptContext, {
                    onlyIndices: changedIdx,
                    label: 'post-template-rhythm',
                });
                for (const c of (rescue?.changes || [])) log.dim(`   ${c}`);
            }
        } catch (e) {
            log.warn(`Findability re-check skipped: ${e.message}`);
        }
    }

    // Separate fullscreenMG scenes (no footage needed) from scenes that need
    // real downloadable media. Template scenes are media scenes too: their
    // background footage is downloaded in Step 5 unless explicitly opted out.
    const templateMediaScenes = prepareTemplateBackgroundMedia(scenesWithKeywords, scriptContext);
    const skippedTemplateMediaScenes = scenesWithKeywords.filter(s =>
        s && s._templateBackgroundOptional && s.mediaIntent?.lane === 'templateBackground'
            && s.mediaIntent?.policy?.download === 'skip'
    );
    const fullscreenMGScenes = scenesWithKeywords.filter(s => s.fullscreenMG);
    const mediaDownloadScenes = scenesWithKeywords.filter(s =>
        !s.fullscreenMG && s.mediaIntent?.policy?.download !== 'skip'
    );
    // FAST TEST MODE: skip the slow footage gauntlet (per-scene search + multi-candidate
    // download + vision scoring + clip vetting) and give each B-roll scene a random real
    // stock clip/photo from a pooled fetch (footage does NOT match the script — the point
    // is SPEED to test the rest of the pipeline: presenter/talking-head, MGs, transitions,
    // SFX, effects, render). Also skips the vision GPU start + topic scout below.
    const _fastMedia = /^(1|true|on|yes)$/i.test(String(process.env.BUILD_FAST_MEDIA || '').trim());
    if (_fastMedia) {
        log.warn('⚡ ONE-SHOT PIPELINE TEST (BUILD_FAST_MEDIA): unique random stock; semantic asset search, footage relevance vision, topic scout, icon/subject acquisition, and bespoke overlay authoring are skipped; stage authoring and Motion QA remain active');
        // Fast mode starts no vision GPU, so the Composition Author's perfectionist
        // hero-frame vision review would 530 on Qwen (and slow-fall-back to Bedrock).
        // Skip that review in fast tests — comps still author, just without the vision pass.
        if (process.env.HF_AUTHOR_PERFECTIONIST == null || process.env.HF_AUTHOR_PERFECTIONIST === '') {
            process.env.HF_AUTHOR_PERFECTIONIST = '0';
        }
    }
    if (fullscreenMGScenes.length > 0) {
        log.ok(`${fullscreenMGScenes.length} scene(s) planned as fullscreen MGs — skipping footage download`);
        for (const s of fullscreenMGScenes) {
            log.dim(`   Scene ${s.index}: ${s.fullscreenMG}`);
        }
    }
      if (templateMediaScenes.length > 0) {
          log.ok(`${templateMediaScenes.length} template background scene(s) prepared as required media in Step 5`);
          for (const s of templateMediaScenes) {
              log.dim(`   Scene ${s.index}: "${s.keyword}" [${s.sourceHint}] under ${s.templateHint}`);
          }
      }
      if (skippedTemplateMediaScenes.length > 0) {
          log.ok(`${skippedTemplateMediaScenes.length} template background scene(s) will render without blocking media download`);
          for (const s of skippedTemplateMediaScenes) {
              log.dim(`   Scene ${s.index}: "${s.templateBgQuery || s.bgQuery || s.keyword || 'theme background'}" under ${s.templateHint}`);
          }
      }

      // ── Vision GPU: start it JUST-IN-TIME, right before scoring ──────────────────────
      // The rented GPU (AWS box or Lightning Studio) runs ONLY for the media phase — it does
      // NOT run during transcribe/Director/Planner above, nor during rendering later. We block
      // here until it's ready (cold start ~2-4 min), then scoring proceeds on it. If this build
      // booted it, it is stopped again once vision is done (see the build entry's finally).
      // bedrock/dashscope have no machine → this is a no-op. Not configured → falls back to the
      // endpoint already in config (manual URL / Bedrock chain).
      if (!_fastMedia) try {
          const visionGpu = require('../vision/vision-gpu');
          if (visionGpu.isConfigured()) {
              log.step(`🖥️  Starting ${visionGpu.backendLabel()} for vision scoring (just-in-time)`);
              const vr = await visionGpu.ensureReady({ onProgress: (m) => log.info(`   ${m}`) });
              if (vr && vr.ok) log.ok(`Vision GPU ready ✓${vr.alreadyReady ? ' (already warm)' : ''}`);
              else log.warn(`Vision GPU not ready (${vr && vr.reason}) — scoring falls back to the Bedrock vision chain`);
          }
      } catch (e) { log.warn(`Vision GPU start skipped: ${e.message}`); }

      // Step 5: Download media (fullscreenMG scenes are skipped; template backgrounds download normally)
    log.step('🎥 Step 5: Downloading Media');
    // Scale Omni frame budget with scene count: 6 frames per scene (one Omni call each)
    const scaledBudget = Math.max(config.clipAnalyzer?.maxFramesPerBuild || 200, mediaDownloadScenes.length * 6);
    clipAnalyzer.resetBudget(scaledBudget);
    log.info(`   🎯 Omni budget: ${scaledBudget} frames (${mediaDownloadScenes.length} downloadable scenes × 6)`);
    let topicFootageBank = null;
    if (!_fastMedia && config.topicFootageScout?.enabled !== false && mediaDownloadScenes.length > 0) {
        log.step('Step 4.9: Topic Footage Scout');
        topicFootageBank = await buildTopicFootageBank(mediaDownloadScenes, scriptContext);
    }

    const downloadResult = _fastMedia
        ? await require('../media/fast-stock-media').fastTestMedia(mediaDownloadScenes, { log: (m) => log.info(m), tempDir: config.paths.temp })
        : await downloadAllMedia(mediaDownloadScenes, scriptContext, { label: 'scene media' });
    let scenesWithMedia = downloadResult.scenes;

    // Talking-head: presenter-anchor HOLD scenes were filtered out of the download set
    // above (download:'skip', no keyword, no fullscreenMG) — but they ARE base V1 scenes
    // whose media is the presenter image (injected at Step 5.9). Without this merge they
    // vanish from scenesWithMedia → allScenes, leaving a black gap and no presenter.
    // Re-insert them at their time positions so they ride the normal base render path,
    // get media resolved, and are copied at Step 8. No-op for faceless (no anchors).
    const _presenterAnchors = scenesWithKeywords.filter(s => s && s._presenterAnchor && !scenesWithMedia.includes(s));
    if (_presenterAnchors.length) {
        scenesWithMedia = [...scenesWithMedia, ..._presenterAnchors].sort((a, b) => (Number(a.startTime) || 0) - (Number(b.startTime) || 0));
        log.info(`   [Presenter] merged ${_presenterAnchors.length} presenter-hold scene(s) into the base track`);
    }

    if (downloadResult.stats) {
        const stats = downloadResult.stats || {};
        const providerReady = (stats.directAccepted || 0)
            + (stats.providerFallbackAccepted || 0)
            + (stats.typeFallbackAccepted || 0)
            + (stats.cached || 0)
            + (stats.resumed || 0)
            + (stats.skipped || 0);
        // A placeholder card is not "ready" — it is the failure we draw when
        // every provider missed. Counting it as ready is what made this line
        // read 100% on a build that shipped blank scenes.
        const agenticFallback = stats.agenticGraphicFallback || 0;
        log.info(`   Media truth: realFootage=${providerReady}/${stats.total || mediaDownloadScenes.length}, placeholder=${agenticFallback}, missing=${stats.failed || 0}, continuityFilled=0 (disabled)`);
        if (agenticFallback > 0 || (stats.failed || 0) > 0) {
            log.warn(`   ${agenticFallback + (stats.failed || 0)} scene(s) have no real footage yet — the coverage sweep runs after graphics settle`);
        }
    }

    // Log clip analyzer usage stats
    const caStats = clipAnalyzer.getStats();
    if (caStats.totalFramesSent > 0) {
        console.log(`  🎬 Clip Analyzer: Omni=${caStats.omniFrames}/${caStats.omniBudget} frames | VL clip scoring=${caStats.clipAnalysisFrames} frames | Omni remaining=${caStats.omniRemaining}`);
    }

    // Step 5.05: Download V2 overlay images (from compositor planner)
    if (plannedV2Scenes.length > 0) {
        log.step('📸 Step 5.05: Downloading V2 Overlay Images');
        let v2Downloaded = 0;
        for (let i = 0; i < plannedV2Scenes.length; i++) {
            const v2 = plannedV2Scenes[i];
            const v2Keyword = v2.keyword;
            const v2Filename = `v2-overlay-${i}`;
            try {
                // Download as image using web-image source hint
                const v2Scene = {
                    index: v2Filename,
                    keyword: v2Keyword,
                    mediaType: 'image',
                    sourceHint: 'web-image',
                    text: v2.label || v2Keyword,
                };
                const v2Result = await downloadAllMedia([v2Scene], scriptContext);
                if (v2Result.scenes && v2Result.scenes[0]) {
                    const downloaded = v2Result.scenes[0];
                    v2.mediaFile = downloaded.mediaFile;
                    v2.mediaExtension = downloaded.mediaExtension || '.jpg';
                    v2.mediaWidth = downloaded.mediaWidth;
                    v2.mediaHeight = downloaded.mediaHeight;
                    v2.sourceProvider = downloaded.sourceProvider;
                    v2._fileIndex = v2Filename;
                    v2Downloaded++;
                    log.provider(v2.sourceProvider || 'unknown', 'ok', `V2 ${i}: "${v2Keyword}"`);
                }
            } catch (e) {
                log.provider('download', 'fail', `V2 ${i}: "${v2Keyword}" — ${e.message}`);
            }
        }
        // Remove V2 scenes that failed to download
        const validV2 = plannedV2Scenes.filter(v2 => v2.mediaFile);
        plannedV2Scenes.length = 0;
        plannedV2Scenes.push(...validV2);
        log.ok(`Downloaded ${v2Downloaded}/${plannedV2Scenes.length + (validV2.length - v2Downloaded)} V2 overlay images`);
        log.br();
    }

    // Step 5.05b: Editor Agent (NEW — runs before legacy framing math)
    // When EDITOR_AGENT=true, the CEO processes every downloaded scene with
    // 1 representative frame + rich context and stamps framing/background/
    // scale/effects directly. Step 5.1 below then only fills in any scenes
    // the agent skipped (no media file, or fullscreen MG scenes).
    if (process.env.EDITOR_AGENT === 'true') {
        log.step('🎬 Step 5.05b: Editor Agent (CEO)');
        try {
            const { runEditorAgent } = require('../agents/ceo');
            await runEditorAgent(scenesWithMedia, scriptContext);
        } catch (e) {
            log.warn(`Editor Agent failed (${e.message}) — falling back to legacy Step 5.1 framing`);
        }
        log.br();
    }

    // Step 5.1: Auto-detect aspect ratios + apply AI framing decisions
    log.step('📐 Step 5.1: Aspect Ratio & Framing');

    // When EDITOR_AGENT=true, the CEO already stamped framing/background/
    // scale/fitMode for every scene with media in Step 5.05b. The legacy
    // ratio-dispatcher sections below are skipped to avoid clobbering the
    // agent's per-scene decisions. The agent itself enforces the vertical-
    // canvas constraint (contain+blur for ratio < 0.7) inside its framing
    // worker, so the structural safety net is preserved.
    const _editorAgentOwnsFraming = process.env.EDITOR_AGENT === 'true';
    if (_editorAgentOwnsFraming) {
        log.dim('   ↳ Legacy ratio framing skipped — Editor Agent CEO owns framing decisions');
        // Safety net: the Planner no longer sets framing on the CEO path, so if the
        // CEO framing worker ever failed for a scene, guarantee a valid default.
        for (const s of scenesWithMedia) {
            if (s && !s.framing) s.framing = 'fullscreen';
        }
        // CEO owns the cinematic grade. The Planner no longer picks effect presets;
        // instead every scene gets the active THEME's effectParams as its grade
        // (deterministic + consistent). The HyperFrames bridge renders these
        // effectOverrides (grain/vignette/blurVignette/dust/lightLeak/colorGrade/chromatic).
        try {
            const { THEMES } = require('../data/themes');
            const gradeThemeId = scriptContext?.themeId || directorsBrief?.themeOverride || 'standard';
            const themeFx = (THEMES[gradeThemeId] && THEMES[gradeThemeId].effectParams) || {};
            const fxKeys = Object.keys(themeFx);
            if (fxKeys.length) {
                for (const s of scenesWithMedia) {
                    if (!s) continue;
                    const ov = {};
                    for (const [fx, params] of Object.entries(themeFx)) {
                        ov[fx] = { ...params, enabled: true };
                    }
                    s.effectOverrides = ov;
                    s.effects = fxKeys.slice();
                    s.effectPreset = null;
                }
                log.dim(`   ↳ CEO grade: theme "${gradeThemeId}" effects [${fxKeys.join(', ')}] → ${scenesWithMedia.length} scenes`);
            }
        } catch (e) {
            log.warn(`CEO grade apply failed (${e.message}) — scenes keep existing effectOverrides`);
        }
    }

    // Load custom background assets for this theme (auto-discovered from assets/backgrounds/)
    let themeBgAssets = [];
    let themeBgIndex = 0;
    try {
        const { getThemeBackgrounds } = require('../data/themes');
        const bgThemeId = scriptContext?.themeId || 'standard';
        themeBgAssets = getThemeBackgrounds(bgThemeId);
        if (themeBgAssets.length > 0) {
            log.dim(`🖼️ Theme "${bgThemeId}" has ${themeBgAssets.length} custom background assets`);
        }
    } catch (e) { /* themes.js not available */ }

    let autoContainCount = 0;
    let cinematicCount = 0;
    let fullscreenCount = 0;
    let customBgCount = 0;
    for (const scene of scenesWithMedia) {
        // Editor Agent already stamped framing/bg/scale/effects upstream.
        // Skip the legacy ratio dispatcher so we don't clobber its decisions.
        if (_editorAgentOwnsFraming) continue;
        const w = scene.mediaWidth || 0;
        const h = scene.mediaHeight || 0;

        if (w > 0 && h > 0) {
            const ratio = w / h;

            if (ratio < 0.7) {
                // Vertical (9:16, portrait photos) — contain + blur, too tall to crop
                scene.fitMode = 'contain';
                scene.background = 'blur';
                scene.scale = 1;
                scene.posX = 0;
                scene.posY = 0;
                autoContainCount++;
                log.dim(`📐 Scene ${scene.index}: ${w}x${h} (vertical, ratio ${ratio.toFixed(2)}) → contain + blur`);
            } else if (ratio < 0.85) {
                // Portrait (3:4, headshots) — contain + blur
                scene.fitMode = 'contain';
                scene.background = 'blur';
                scene.scale = 1;
                scene.posX = 0;
                scene.posY = 0;
                autoContainCount++;
                log.dim(`📐 Scene ${scene.index}: ${w}x${h} (portrait, ratio ${ratio.toFixed(2)}) → contain + blur`);
            } else if (ratio < 1.2) {
                // Near-square / slightly wide (1:1 to 6:5) — cover with slight crop
                // These are close enough to 16:9 that a moderate scale looks good
                const nearScale = ratio < 0.95 ? 0.85 : ratio < 1.05 ? 0.9 : 0.95;
                scene.fitMode = 'cover';
                scene.scale = nearScale;
                scene.background = 'blur';
                scene.posX = 0;
                scene.posY = 0;
                autoContainCount++;
                const label = ratio < 0.95 ? 'near-square' : ratio < 1.05 ? 'square' : 'near-wide';
                log.dim(`📐 Scene ${scene.index}: ${w}x${h} (${label}, ratio ${ratio.toFixed(2)}) → scale ${nearScale} + blur`);
            } else if (scene.framing === 'floating') {
                // AI recommended floating frame — smaller scale, rounded corners, shadow, styled bg
                const targetRatio = 1920 / 1080;
                const fillFactor = Math.min(1, (ratio - 1.0) / (targetRatio - 1.0));
                const floatingScale = 0.45 + fillFactor * 0.10; // 0.45 → 0.55
                scene.fitMode = 'cover';
                scene.scale = Math.round(floatingScale * 100) / 100;
                scene.borderRadius = scene.borderRadius || 4; // visible rounded corners
                scene.shadow = scene.shadow !== undefined ? scene.shadow : 0.5;
                scene.floatingAnim = scene.floatingAnim || 'slideRight'; // slideRight, slideLeft, slideUp, fadeScale
                // Animation duration driven by pacing (AI Director) + scene length
                const pacing = scriptContext.pacing || 'moderate';
                const sceneDur = (scene.endTime || 0) - (scene.startTime || 0);
                const pacingBase = pacing === 'fast' ? 0.3 : pacing === 'slow' ? 0.7 : 0.5;
                const durationAdj = sceneDur < 4 ? -0.1 : sceneDur > 7 ? 0.15 : 0;
                scene.floatingAnimDuration = scene.floatingAnimDuration || Math.round((pacingBase + durationAdj) * 100) / 100;
                if (!scene.background || scene.background === 'none') {
                    scene.background = 'blur'; // default to blur, AI can override with gradient
                }
                scene.posX = scene.posX || 0;
                scene.posY = scene.posY || 0;
                cinematicCount++;
                log.dim(`🖼️ Scene ${scene.index}: ${w}x${h} (floating) → scale ${scene.scale} + ${scene.floatingAnim} ${scene.floatingAnimDuration}s + shadow ${scene.shadow} + ${scene.background}`);
            } else if (scene.framing === 'cinematic') {
                // AI recommended cinematic framing — scale based on how wide the image is
                // Wider images can fill more of the frame; narrower ones need more pullback
                // Range: 0.75 (barely wide, ratio ~1.2) to 1.0 (very wide, ratio >= 1.78)
                const targetRatio = 1920 / 1080; // 1.78
                const fillFactor = Math.min(1, (ratio - 1.0) / (targetRatio - 1.0));
                const cinematicScale = 0.75 + fillFactor * 0.25; // 0.75 → 1.0
                scene.fitMode = 'cover';
                scene.scale = Math.round(cinematicScale * 100) / 100;
                // Keep AI's background choice (blur, gradient:id, or pattern:file)
                if (!scene.background || scene.background === 'none') {
                    scene.background = 'blur';
                }
                scene.posX = 0;
                scene.posY = 0;
                cinematicCount++;
                log.dim(`🎬 Scene ${scene.index}: ${w}x${h} (cinematic) → scale ${scene.scale} + ${scene.background}`);
            } else {
                // Fullscreen — media fills the frame completely
                scene.fitMode = 'cover';
                fullscreenCount++;
            }
        } else {
            // Unknown dimensions — default to cover
            scene.fitMode = 'cover';
        }
    }

    // ── Explainer floating bias ──
    // Explainer videos (educational/documentary) feel more premium with floating
    // scenes mixed in. Convert ~40% of fullscreen wide scenes to floating with
    // slide animations. News stays as-is (urgent/raw look). Cinematic untouched.
    let explainerFloatingCount = 0;
    const isExplainer = (scriptContext?.nicheId || '').startsWith('explainer');
    // Editor Agent makes per-scene framing decisions with neighbour-awareness;
    // the bulk-bias loop is redundant when the agent is on.
    if (isExplainer && !_editorAgentOwnsFraming) {
        const FLOATING_BIAS = 0.4; // ~40% of eligible scenes flip to floating
        const FLOATING_ANIMS = ['slideRight', 'slideLeft', 'slideUp', 'fadeScale'];
        const pacing = scriptContext.pacing || 'moderate';
        const pacingBase = pacing === 'fast' ? 0.3 : pacing === 'slow' ? 0.7 : 0.5;

        // Eligible: wide-enough scenes with no AI framing tag (i.e. fellthrough to fullscreen)
        const eligible = scenesWithMedia.filter(s => {
            const w = s.mediaWidth || 0, h = s.mediaHeight || 0;
            if (w <= 0 || h <= 0) return false;
            const ratio = w / h;
            if (ratio < 1.2) return false;       // narrow — math already handled it
            if (s._framingLocked) return false;  // Visual Planner explicitly chose the framing
            if (s.framing === 'cinematic') return false; // AI chose cinematic, leave alone
            if (s.framing === 'floating') return false;  // already floating
            if (s.fullscreenMG) return false;    // MG scene, no footage framing
            return true;
        });

        // Deterministic stride pick — every Nth eligible scene becomes floating
        const stride = Math.max(2, Math.round(1 / FLOATING_BIAS)); // FLOATING_BIAS=0.4 → stride=3
        for (let i = 0; i < eligible.length; i++) {
            if (i % stride !== 1) continue; // pick 2nd, 5th, 8th...
            const scene = eligible[i];
            const w = scene.mediaWidth, h = scene.mediaHeight;
            const ratio = w / h;
            const targetRatio = 1920 / 1080;
            const fillFactor = Math.min(1, (ratio - 1.0) / (targetRatio - 1.0));
            const floatingScale = 0.45 + fillFactor * 0.10;

            scene.framing = 'floating';
            scene.fitMode = 'cover';
            scene.scale = Math.round(floatingScale * 100) / 100;
            scene.borderRadius = scene.borderRadius || 4;
            scene.shadow = scene.shadow !== undefined ? scene.shadow : 0.5;
            // Vary animation across scenes for visual rhythm
            scene.floatingAnim = scene.floatingAnim || FLOATING_ANIMS[i % FLOATING_ANIMS.length];
            const sceneDur = (scene.endTime || 0) - (scene.startTime || 0);
            const durationAdj = sceneDur < 4 ? -0.1 : sceneDur > 7 ? 0.15 : 0;
            scene.floatingAnimDuration = scene.floatingAnimDuration || Math.round((pacingBase + durationAdj) * 100) / 100;
            if (!scene.background || scene.background === 'none') {
                scene.background = 'blur';
            }
            scene.posX = scene.posX || 0;
            scene.posY = scene.posY || 0;
            // Bookkeeping — was counted as fullscreen, now floating
            fullscreenCount--;
            cinematicCount++;
            explainerFloatingCount++;
        }
    }

    // Assign custom background assets to some non-widescreen scenes (variety)
    // Every ~3rd blur scene gets a custom asset background instead.
    // Editor Agent picks per-scene backgrounds with full context, so the
    // bulk-variety pass would only fight its decisions when the agent is on.
    if (themeBgAssets.length > 0 && !_editorAgentOwnsFraming) {
        const blurScenes = scenesWithMedia.filter(s => s.background === 'blur');
        for (let i = 0; i < blurScenes.length; i++) {
            if (i % 3 === 1) { // 2nd, 5th, 8th... — roughly 1 in 3
                const bgFile = themeBgAssets[themeBgIndex % themeBgAssets.length];
                blurScenes[i].background = `pattern:${bgFile}`;
                themeBgIndex++;
                customBgCount++;
            }
        }
    }

    if (!_editorAgentOwnsFraming) {
        const framingTotal = autoContainCount + cinematicCount;
        if (framingTotal > 0) {
            log.ok(`${autoContainCount} auto-framed (non-widescreen) + ${cinematicCount} cinematic + ${fullscreenCount} fullscreen`);
        } else {
            log.ok('All scenes fullscreen — no auto-framing needed');
        }
        if (explainerFloatingCount > 0) {
            log.ok(`Explainer bias: ${explainerFloatingCount} wide scenes flipped to floating with slide animation`);
        }
        if (customBgCount > 0) {
            log.ok(`${customBgCount} scenes using custom background assets`);
        }
    }
    log.br();

    // ── Orchestrator Phase 2: Mid-Build Validation + MG Instructions ──
    let midBuildStats = {
        footageDownloaded: scenesWithMedia.filter(s => s.mediaFile).length,
        footageDirectDownloaded: scenesWithMedia.filter(s => s.mediaFile && !s.reusedFromContinuity && s.mediaDownloadStatus !== 'agenticGraphicFallback').length,
        footageContinuityFilled: scenesWithMedia.filter(s => s.reusedFromContinuity).length,
        footageAgenticFallback: scenesWithMedia.filter(s => s.mediaDownloadStatus === 'agenticGraphicFallback').length,
        footagePlanned: mediaDownloadScenes.length,
        footageFailed: scenesWithMedia.filter(s => !s.mediaFile).length,
        templateMediaPlanned: templateMediaScenes.length,
        templateMediaDownloaded: scenesWithMedia.filter(s => s._templateMediaFootage && s.mediaFile).length,
        templateMediaFailed: scenesWithMedia.filter(s => s._templateMediaFootage && !s.mediaFile).length,
        lowVisionScores: 0,
        providerBreakdown: {},
    };
    let mgInstructions = null;
    if (buildManifest) {
        try {
            const midResult = midBuildValidation(scenesWithMedia, buildManifest, scriptContext);
            midBuildStats = midResult.stats;
            mgInstructions = midResult.mgInstructions || null;
        } catch (error) {
            log.warn(`Orchestrator Phase 2 failed: ${error.message}`);
        }
    }

    // ── Vision mission complete → release the GPU here, not at build end ──────────
    // The vision-GPU consumers are Step 5 (media scoring) and Step 5.05b (CEO
    // framing/face-anchor). Everything from here on — MG, templates, motion director,
    // SFX, plan build, copy — is vision-free EXCEPT the LIGHT Step 7.6 perfectionist
    // hero-frame review, which is fine on the Bedrock fallback. Holding the machine
    // through this whole render-prep tail just burns credits idle. So stop it now (only
    // if THIS build started it — a user-pre-warmed box is left alone) and DISARM the
    // mid-build re-wake so 7.6's light usage doesn't cold-boot the GPU for nothing. The
    // end-of-build stopIfStarted then becomes an idempotent no-op.
    try {
        require('../vision/vision-rewake').disarm();
        const _visionDone = await require('../vision/vision-gpu').stopIfStarted({ onProgress: (m) => log.info(`   ${m}`) });
        if (_visionDone && _visionDone.ok && !_visionDone.skipped) {
            log.ok('🖥️  Vision GPU stopped — scoring + framing done (freed for the render-prep tail)');
        }
    } catch (e) {
        log.warn(`Vision GPU stop-after-scoring skipped: ${e.message}`);
    }

    // Step 5.9: Resolve presenter media (talking-head) — the SINGLE seam that materializes
    // the presenter source onto hold scenes BEFORE the graphics workers (MG / explainer /
    // icons) run, so they decorate the presenter like a real edit. Static image now, avatar
    // clip later (presenter-provider.js). No-op when faceless. Runs after framing (Step 5.1)
    // so the CEO's framing decisions on the hold aren't overwritten.
    try {
        const { resolvePresenterMedia } = require('../media/presenter-provider');
        // Thread the narration audio + ffmpeg so the avatar backend (Kling browser
        // bridge) can slice each hold's voice and lip-sync the presenter photo to it.
        const filled = await resolvePresenterMedia(scenesWithMedia, scriptContext, {
            log,
            audioFile: path.join(config.paths.input, audioFile),
            ffmpegPath: getFfmpegPath(),
            projectDir: PROJECT_DIR,
        });
        if (filled) {
            // Re-assert presenter framing AFTER all framing passes ran. The CEO (5.05b)
            // skips media-less holds, the editorial handoff clears framing/background, and
            // the Step 5.1 safety net forces 'fullscreen' — so a 'framed' hold would render
            // full-screen. presenterInsert.layout is the source of truth; restamp from it.
            for (const s of scenesWithMedia) {
                const ins = s && s.presenterInsert;
                if (!ins || ins.layout === 'pip' || ins.layout === 'split') continue; // pip/split keep their own framing
                s.fit = 'cover'; s.fitMode = 'cover';
                if (ins.anchor) { s.focusX = ins.anchor.x; s.focusY = ins.anchor.y; }
                // framed = "presenter stage" (fullscreen container; host card + explanation slot)
                s.framing = 'fullscreen';
                if (!s.background || /^(none|auto)$/i.test(String(s.background))) s.background = 'soft-charcoal';
            }
            log.ok(`Presenter media resolved for ${filled} hold scene(s)`);
        }
    } catch (err) {
        log.warn(`Presenter media resolution failed: ${err.message} — presenter holds skipped`);
    }

    // Step 6: AI Motion Graphics
    log.step('✨ Step 6: AI Motion Graphics');

    // Build combined instructions. In Editor Agent mode, the orchestrator is a
    // sanity/review helper only; it must not feed creative MG/template directives
    // back into the editing agent.
    let combinedInstructions = aiInstructions || '';
    const includeLegacyMgInstructions = !editorAgentOwnsEditingTasks(scriptContext);
    if (mgInstructions && includeLegacyMgInstructions) {
        const instrParts = [];
        instrParts.push(`\n[ORCHESTRATOR MG DIRECTIVES — niche: ${mgInstructions.nicheName}]`);
        instrParts.push(`Target overlay MG count: ~${mgInstructions.targetMGCount} (density: ${mgInstructions.overlayDensity})`);
        instrParts.push(`Maximum gap without MG: ${mgInstructions.maxGapSec}s`);
        if (mgInstructions.longScenes.length > 0) {
            instrParts.push(`PRIORITY: Scenes ${mgInstructions.longScenes.join(', ')} are >7s — strongly prefer adding overlay MGs to these`);
        }
        if (mgInstructions.shortScenes.length > 0) {
            instrParts.push(`SKIP: Scenes ${mgInstructions.shortScenes.join(', ')} are <2.5s — do NOT add MGs to these`);
        }
        if (mgInstructions.listicleItemScenes && mgInstructions.listicleItemScenes.length > 0) {
            instrParts.push(`LISTICLE ITEM SCENES: ${mgInstructions.listicleItemScenes.join(', ')} — already have auto-generated listicleCounter, DO NOT add any overlay MGs to these scenes`);
        }
        if (mgInstructions.listicleOverviewScene >= 0) {
            instrParts.push(`LISTICLE OVERVIEW SCENE: ${mgInstructions.listicleOverviewScene} — this is a fullscreen listicleGrid, DO NOT add any MGs to this scene`);
        }
        if (mgInstructions.listicleProtectedScenes && mgInstructions.listicleProtectedScenes.length > 0) {
            instrParts.push(`PROTECTED SCENES (no overlay MGs): ${mgInstructions.listicleProtectedScenes.join(', ')}`);
        }
        for (const hint of mgInstructions.formatHints) {
            instrParts.push(hint);
        }
        combinedInstructions += instrParts.join('\n');
    } else if (mgInstructions) {
        log.info('[Editor Agent] Ignoring legacy orchestrator MG directives; Editor Agent owns editing decisions');
    }

    // Append style block (if present) as inspiration for MG placement — Use sourceHint: "stock" — high-quality cinematic B-roll from licensed stock providers (niche allowlist still controls types)
    if (scriptContext.styleBlock) {
        combinedInstructions = (combinedInstructions ? combinedInstructions + '\n\n' : '') + scriptContext.styleBlock;
        log.info(`🎨 Style inspiration appended to MG instructions: "${scriptContext.styleProfile?.name || 'unnamed'}" (${scriptContext.styleBlock.length} chars)`);
    }
    // Editor Agent gate: route MG selection through the agent's worker so
    // the framing decisions (from Phase 1) are injected into MG instructions.
    let mgResult;
    if (process.env.EDITOR_AGENT === 'true') {
        const { runMotionGraphicsWorker } = require('../agents/workers/motion-graphics');
        const mgWorkerOut = await runMotionGraphicsWorker(scenesWithKeywords, scriptContext, {
            aiInstructions: combinedInstructions,
            log: (m) => log.dim(m),
        });
        mgResult = mgWorkerOut.result || { motionGraphics: [], mgStyle: 'clean', mapStyle: 'dark' };
    } else {
        mgResult = await processMotionGraphics(scenesWithKeywords, scriptContext, null, combinedInstructions);
    }
    let allMGs = mgResult.motionGraphics || mgResult;
    const mgStyle = mgResult.mgStyle || 'clean';
    const mapStyle = mgResult.mapStyle || 'dark';

    // Enforce maxMGs cap from quality tier
    const maxMGs = directorsBrief.tier.maxMGs;
    if (Number.isFinite(maxMGs) && allMGs.length > maxMGs) {
        const before = allMGs.length;
        // Preserve subscribeCTA if present, then take first N from the rest
        const ctaMG = allMGs.find(mg => mg.type === 'subscribeCTA');
        const rest = allMGs.filter(mg => mg.type !== 'subscribeCTA');
        const kept = rest.slice(0, ctaMG ? maxMGs - 1 : maxMGs);
        if (ctaMG) kept.push(ctaMG);
        allMGs = kept;
        log.info(`📊 MG cap: ${before} → ${allMGs.length} (${directorsBrief.qualityTier} tier, max ${maxMGs})`);
    }

    // Merge adjacent same-type fullscreen MGs into one continuous MG.
    // When the Visual Planner assigns (e.g.) mapChart to two consecutive scenes, each
    // becomes its own MG with a tiny gap between them — V1 footage from before the
    // first map peeks through that gap. Merging collapses them into a single animated
    // visual covering both scenes' data, which is the smarter planner behavior.
    const MERGE_GAP_THRESHOLD = 2.5; // seconds
    {
        const fsList = allMGs
            .filter(mg => mg.category === 'fullscreen')
            .sort((a, b) => a.startTime - b.startTime);
        const toRemove = new Set();
        let mergedCount = 0;
        const _normMapMode = (v) => {
            const s = String(v || '').toLowerCase();
            if (s === 'regionhighlight') return 'region';
            if (s === 'route' || s === 'locator' || s === 'region' || s === 'comparison') return s;
            return null;
        };
        const _mapModeOf = (mg) => {
            // _mapScene.mapMode is authoritative (reflects compiler promotions);
            // fall back to MG's own mapVariant/subType when the compiler didn't run.
            const owner = scenesWithKeywords.find(s => s && s.index === mg.sceneIndex);
            return _normMapMode(owner?._mapScene?.mapMode)
                || _normMapMode(mg.mapVariant || mg.subType);
        };
        for (let i = 0; i < fsList.length; i++) {
            const cur = fsList[i];
            if (toRemove.has(cur)) continue;
            for (let j = i + 1; j < fsList.length; j++) {
                const next = fsList[j];
                if (toRemove.has(next)) continue;
                if (next.type !== cur.type) break;
                const curEnd = cur.startTime + cur.duration;
                const gap = next.startTime - curEnd;
                if (gap > MERGE_GAP_THRESHOLD) break;
                // Policy (June 12): adjacent maps ALWAYS merge into ONE
                // continuous map JOURNEY — back-to-back separate maps (each
                // with its own basemap, camera reset and draw-on restart)
                // read as a glitchy mess. Mixed modes are fine: the journey's
                // camera honors each segment's intent in sequence (locator =
                // zoom-in stop, region = wide hold, route = glide). Only
                // 'comparison' (a static split frame) is structurally
                // unmergeable. Per-segment timing is recorded so the builder
                // syncs the camera to the narration beats.
                if (cur.type === 'mapChart' && next.type === 'mapChart') {
                    const curMode = _mapModeOf(cur);
                    const nextMode = _mapModeOf(next);
                    if (curMode === 'comparison' || nextMode === 'comparison') {
                        log.info(`   🚫 Refused mapChart merge scenes [${cur.sceneIndex}+${next.sceneIndex}]: comparison frames don't merge`);
                        break;
                    }
                    if (!Array.isArray(cur._mapSegments)) {
                        cur._mapSegments = [{ start: cur.startTime, end: cur.startTime + cur.duration, mode: curMode || null, sceneIndex: cur.sceneIndex }];
                    }
                    cur._mapSegments.push({ start: next.startTime, end: next.startTime + next.duration, mode: nextMode || null, sceneIndex: next.sceneIndex });
                }
                const nextEnd = next.startTime + next.duration;
                cur.duration = Math.max(curEnd, nextEnd) - cur.startTime;
                const curText = (cur.text || '').trim();
                const nextText = (next.text || '').trim();
                if (nextText && nextText !== curText) {
                    cur.text = curText ? `${curText}, ${nextText}` : nextText;
                }
                const curSub = (cur.subtext || '').trim();
                const nextSub = (next.subtext || '').trim();
                if (nextSub && nextSub !== curSub) {
                    cur.subtext = curSub ? `${curSub} ${nextSub}` : nextSub;
                }
                cur._mergedFrom = (cur._mergedFrom || [cur.sceneIndex]).concat(next.sceneIndex);
                // Promote map variant so the planner produces enough waypoints
                // to pan/zoom from one location to the next across the merged span.
                // locator (1-2 wp) / regionHighlight (1-3 wp) → route (3-6 wp).
                if (cur.type === 'mapChart') {
                    const v = cur.mapVariant || cur.subType;
                    if (v === 'locator' || v === 'regionHighlight' || !v) {
                        cur.mapVariant = 'route';
                        cur.subType = 'route';
                    }
                }
                toRemove.add(next);
                mergedCount++;
            }
        }
        if (mergedCount > 0) {
            allMGs = allMGs.filter(mg => !toRemove.has(mg));
            log.info(`🔀 Merged ${mergedCount} adjacent fullscreen MG(s) with same type (gap ≤ ${MERGE_GAP_THRESHOLD}s) — one continuous visual instead of neighbors with a gap`);

            // Synthesize a unified MapScene for each merged mapChart MG so the
            // planner + provider see subjects from the WHOLE merged span, not
            // just the first owning scene. Without this, a merged route that
            // spans 3 scenes would only geocode the first scene's subjects.
            try {
                const { mergeMapScenes } = require('../map/map-compiler');
                // Slice 5a: pass the resolved niche map policy so the merged
                // MapScene uses niche-specific caps/minimums, matching what
                // compileMapScenes applied upstream.
                let _mergePolicy = null;
                try {
                    _mergePolicy = require('../data/niches').getNicheMapPolicy(scriptContext?.nicheId);
                } catch (_) { /* fall through to compiler defaults */ }
                let synthesized = 0;
                for (const mg of allMGs) {
                    if (mg.type !== 'mapChart') continue;
                    if (!Array.isArray(mg._mergedFrom) || mg._mergedFrom.length < 2) continue;
                    const owners = mg._mergedFrom
                        .map(idx => scenesWithKeywords.find(s => s && s.index === idx))
                        .filter(Boolean);
                    const sources = owners.map(s => s._mapScene).filter(Boolean);
                    if (sources.length < 2) continue; // single source → scene lookup suffices
                    const merged = mergeMapScenes(sources, mg.mapVariant, _mergePolicy);
                    if (merged) {
                        // Narration-sync contract for the builder: each source
                        // map's window (relative to the merged MG start) + its
                        // intent + its subjects. The camera arrives at each
                        // segment's frame when the narration reaches it.
                        if (Array.isArray(mg._mapSegments) && mg._mapSegments.length > 1) {
                            const t0 = mg.startTime;
                            merged.segments = mg._mapSegments.map(seg => {
                                const src = sources.find(s => s && s.sceneIndex === seg.sceneIndex);
                                return {
                                    start: +Math.max(0, seg.start - t0).toFixed(2),
                                    end: +Math.max(0, seg.end - t0).toFixed(2),
                                    mode: seg.mode || src?.mapMode || null,
                                    subjects: (src?.subjects || []).map(s => s.name).filter(Boolean),
                                };
                            }).filter(s => s.end > s.start && s.subjects.length);
                        }
                        mg._mapScene = merged;
                        synthesized++;
                        log.dim(`   🔀 Merged MapScene for MG spanning scenes [${mg._mergedFrom.join(',')}]: ${merged.subjects.map(s => s.name).join(', ')} (${merged.mapMode}${merged.segments ? `, ${merged.segments.length} journey segments` : ''})`);
                    }
                }
                if (synthesized > 0) {
                    log.info(`🧭 Synthesized ${synthesized} merged MapScene(s) for multi-scene map MG(s)`);
                }
            } catch (err) {
                log.warn(`Merged MapScene synthesis failed: ${err.message} — planner/provider will use first-scene MapScene only`);
            }
        }
    }

    // Split MGs: overlay types stay in motionGraphics, full-screen types become V3 scenes
    let motionGraphics = allMGs.filter(mg => mg.category !== 'fullscreen');
    let fullscreenMGs = allMGs.filter(mg => mg.category === 'fullscreen');

    // Creator-directed numeric lower thirds are an exclusive treatment. Apply
    // this before V1 is carved so a competing stat card can be removed without
    // leaving a black hole in the final timeline.
    const numericMgGuard = enforceNumericLowerThirdExclusivity({
        fps: config.video.fps,
        mgStyle,
        scenes: scenesWithMedia,
        motionGraphics,
        mgScenes: fullscreenMGs,
        templateScenes: [],
        scriptContext,
    }, scriptContext?._directives, { allowStageRemoval: true });
    if (numericMgGuard.fixed.length > 0) {
        motionGraphics = motionGraphics.filter(mg => !mg?.disabled);
        fullscreenMGs = fullscreenMGs.filter(mg => !mg?.disabled);
        log.info(`🔢 Numeric treatment resolved ${numericMgGuard.fixed.length} competing graphic action(s) before fullscreen carving`);
    }
    // The guard can insert replacement lower thirds and disable original MGs.
    // Rebuild the canonical list so later asset workers see the replacements
    // and never spend time on disabled graphics.
    allMGs = [...motionGraphics, ...fullscreenMGs]
        .filter(mg => mg && !mg.disabled)
        .sort((a, b) => Number(a.startTime || 0) - Number(b.startTime || 0));

    // Remove overlay MGs that overlap with fullscreen MG time windows
    // (fullscreen MGs cover the entire screen — stacking overlays on top looks broken)
    if (fullscreenMGs.length > 0) {
        const fsMGRanges = fullscreenMGs.map(mg => ({
            start: mg.startTime,
            end: mg.startTime + (mg.duration || 3)
        }));
        const before = motionGraphics.length;
        // Listicle counters/trackers are designed to overlay on footage, not on the grid —
        // they should NOT be removed even if they slightly overlap the listicleGrid on V3
        const LISTICLE_OVERLAY_TYPES = new Set(['listicleCounter']);
        motionGraphics = motionGraphics.filter(mg => {
            if (LISTICLE_OVERLAY_TYPES.has(mg.type)) return true;
            const mStart = mg.startTime;
            const mEnd = mStart + (mg.duration || 3);
            return !fsMGRanges.some(r => mStart < r.end && mEnd > r.start);
        });
        const removed = before - motionGraphics.length;
        if (removed > 0) log.info(`🚫 Removed ${removed} overlay MG(s) that overlap fullscreen MGs`);
    }

    // Convert full-screen MGs into scene-like objects for V3
    let mgScenes = fullscreenMGs.map((mg) => {
        const ownerScene = scenesWithKeywords.find(scene => scene?.index === mg?.sceneIndex);
        const stableOwnerIndex = ownerScene?.originalIndex
            ?? ownerScene?.sourceSceneIndex
            ?? mg?.sourceSceneIndex
            ?? mg?.sceneIndex;
        return {
            ...mg,
            sourceSceneIndex: stableOwnerIndex,
            originalSceneIndex: stableOwnerIndex,
            isMGScene: true,
            trackId: 'video-track-3',
            mediaType: 'motion-graphic',
            endTime: mg.startTime + mg.duration,
            keyword: `MG: ${mg.type}`,
        };
    });

    // Tag each scene with its original index (footage-manager uses scene.index for filenames).
    // Keep originalIndex in the public plan so asset filenames can follow the
    // director scene number even after fullscreen-MG carving compacts V1 scenes.
    scenesWithMedia.forEach((scene) => {
        scene._fileIndex = scene.index;
        scene.originalIndex = scene.originalIndex ?? scene.index;
    });

    // Carve out gaps in V2 scenes where full-screen MGs exist
    // Full-screen MGs ARE the visual — no footage should play underneath
    if (mgScenes.length > 0) {
        // Minimum V1 fragment duration. Anything shorter is a sliver — fullscreen MGs
        // cover those moments visually on V3, and carving them produces duplicate-text
        // fragments. Absorb them into an adjacent full scene instead of keeping them.
        const MIN_FRAGMENT_DUR = 1.5;
        const mgRanges = mgScenes.map(mg => ({ start: mg.startTime, end: mg.endTime }));
        let carved = [];
        let absorbedCount = 0;
        for (const scene of scenesWithMedia) {
            let parts = [{ startTime: scene.startTime, endTime: scene.endTime }];
            for (const range of mgRanges) {
                const newParts = [];
                for (const part of parts) {
                    if (range.start >= part.endTime || range.end <= part.startTime) {
                        // No overlap — keep as is
                        newParts.push(part);
                    } else if (range.start <= part.startTime && range.end >= part.endTime) {
                        // Fully covered — remove (skip)
                    } else if (range.start > part.startTime && range.end < part.endTime) {
                        // MG in the middle — split into two parts
                        newParts.push({ startTime: part.startTime, endTime: range.start });
                        newParts.push({ startTime: range.end, endTime: part.endTime });
                    } else if (range.start <= part.startTime) {
                        // MG covers the start — trim left
                        newParts.push({ startTime: range.end, endTime: part.endTime });
                    } else {
                        // MG covers the end — trim right
                        newParts.push({ startTime: part.startTime, endTime: range.start });
                    }
                }
                parts = newParts;
            }
            // Drop sub-threshold fragments so they don't leak duplicate text onto V1
            const kept = parts.filter(p => (p.endTime - p.startTime) >= MIN_FRAGMENT_DUR);
            absorbedCount += parts.length - kept.length;
            // Create scene copies for surviving parts
            for (const part of kept) {
                const trimmedScene = { ...scene };
                const offsetFromOriginal = part.startTime - scene.startTime;
                trimmedScene.startTime = part.startTime;
                trimmedScene.endTime = part.endTime;
                trimmedScene.duration = part.endTime - part.startTime;
                if (offsetFromOriginal > 0) {
                    trimmedScene.mediaOffset = (scene.mediaOffset || 0) + offsetFromOriginal;
                }
                carved.push(trimmedScene);
            }
        }
        // Seamless coverage: extend kept scenes to close any sub-threshold gaps
        // created by dropped fragments. V1 should never have a visible gap — the
        // fullscreen MG on V3 covers the intended visual, and V1 bridges under it.
        carved.sort((a, b) => a.startTime - b.startTime);
        const mgIntersects = (s, e) => mgRanges.some(r => s < r.end && e > r.start);
        let bridged = 0;
        for (let i = 0; i < carved.length - 1; i++) {
            const cur = carved[i];
            const nxt = carved[i + 1];
            const gap = nxt.startTime - cur.endTime;
            if (gap > 0.01 && gap < MIN_FRAGMENT_DUR && !mgIntersects(cur.endTime, nxt.startTime)) {
                // Gap is not covered by any MG — extend current scene to close it
                cur.endTime = nxt.startTime;
                cur.duration = cur.endTime - cur.startTime;
                bridged++;
            }
        }
        const removed = scenesWithMedia.length - carved.length;
        scenesWithMedia = carved;
        if (removed > 0) log.info(`🔪 Carved ${removed} scene(s) to make room for full-screen MGs`);
        if (absorbedCount > 0) log.info(`🧹 Absorbed ${absorbedCount} sub-threshold fragment(s) (<${MIN_FRAGMENT_DUR}s) — prevents duplicate-text slivers`);
        if (bridged > 0) log.info(`🔗 Bridged ${bridged} V1 gap(s) left by absorbed fragments`);
    }

    log.ok(`Placed ${allMGs.length} motion graphics (style: ${log.pc.cyan(mgStyle)})`);
    if (mgScenes.length > 0) {
        log.info(`→ ${mgScenes.length} full-screen (V3), ${motionGraphics.length} overlay (MG track)`);
        for (const mg of mgScenes) {
            log.dim(`🎨 [${mg.type}] "${mg.text || ''}" @ ${mg.startTime.toFixed(1)}s-${mg.endTime.toFixed(1)}s`);
        }
    }
    log.br();

    // Merge compositor planner explainer MGs into the MG pipeline
    if (compositorExplainers.length > 0) {
        allMGs.push(...compositorExplainers);
        motionGraphics.push(...compositorExplainers);
        log.ok(`Merged ${compositorExplainers.length} compositor explainer(s) into MG pipeline`);
        const postCompositorNumericGuard = enforceNumericLowerThirdExclusivity({
            fps: config.video.fps,
            mgStyle,
            scenes: scenesWithKeywords,
            motionGraphics,
            mgScenes: [],
            templateScenes: [],
            scriptContext,
        }, scriptContext?._directives, { allowStageRemoval: true });
        if (postCompositorNumericGuard.fixed.length > 0) {
            log.info(`🔢 Numeric treatment removed ${postCompositorNumericGuard.fixed.length} competing compositor overlay action(s)`);
        }
        motionGraphics = motionGraphics.filter(mg => mg && !mg.disabled);
        allMGs = [...motionGraphics, ...fullscreenMGs]
            .filter(mg => mg && !mg.disabled)
            .sort((a, b) => Number(a.startTime || 0) - Number(b.startTime || 0));
    }

    // Step 6.05: Download explainer images (search + bg removal)
    const explainerMGs = allMGs.filter(mg => mg.type === 'explainer' && !mg.disabled);
    if (_fastMedia && explainerMGs.length > 0) {
        log.info(`⚡ Fast Test: skipped semantic explainer-image search for ${explainerMGs.length} graphic(s); text/motion layout remains active`);
        log.br();
    } else if (explainerMGs.length > 0) {
        log.step('🖼️ Step 6.05: Explainer Images');
        try {
            let count;
            if (process.env.EDITOR_AGENT === 'true') {
                const { runExplainerImagesWorker } = require('../agents/workers/explainer-images');
                const out = await runExplainerImagesWorker(explainerMGs, scriptContext, config.paths.temp, {
                    log: (m) => log.dim(m),
                });
                count = out.count || 0;
            } else {
                const { downloadExplainerImages } = require('../media/explainer-image-provider');
                count = await downloadExplainerImages(explainerMGs, config.paths.temp, scriptContext);
            }
            log.ok(`Processed ${count}/${explainerMGs.length} explainer images`);
        } catch (e) {
            log.warn(`Explainer image download failed: ${e.message} (skipping)`);
        }
        log.br();
    }

    // Slice 4 (Apr 23): AI Map Planner deleted. Waypoints are now materialized
    // deterministically from MapScene.subjects inside map-provider.js — no
    // separate pipeline step, no AI narration re-parse.

    // Step 6.06: Download static map images for mapChart MGs (via MapTiler API)
    const mapMGs = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGs.length > 0) {
        log.step('🗺️ Step 6.06: Map Images');
        try {
            // Slice 3: must pass the full compiled scene set (scenesWithKeywords) —
            // fullscreen map scenes are split out of scenesWithMedia at line 980,
            // so the provider would never find scene._mapScene there.
            let mapCount;
            if (process.env.EDITOR_AGENT === 'true') {
                const { runMapAssetsWorker } = require('../agents/workers/map-assets');
                const out = await runMapAssetsWorker(allMGs, scriptContext, config.paths.temp, scenesWithKeywords, {
                    log: (m) => log.dim(m),
                });
                mapCount = out.count || 0;
            } else {
                const { downloadMapsForMGs } = require('../map/map-provider');
                mapCount = await downloadMapsForMGs(allMGs, scriptContext, config.paths.temp, scenesWithKeywords);
            }
            if (mapCount > 0) {
                log.ok(`Downloaded ${mapCount} map image(s) for ${mapMGs.length} mapChart scene(s)`);
            } else {
                log.dim('No map images downloaded (will use Canvas2D fallback)');
            }
        } catch (e) {
            log.warn(`Map download failed: ${e.message} (will use Canvas2D fallback)`);
        }
        log.br();

        // Step 6.07: Download contextual icons for map waypoints
        const mapsWithIcons = allMGs.filter(mg => mg.type === 'mapChart' && (mg._mapWaypoints?.some(wp => wp.icon) || mg._mapSwarms?.length > 0));
        if (mapsWithIcons.length > 0) {
            log.step('🏷️ Step 6.07: Map Waypoint Icons');
            try {
                const { downloadWaypointIcons, downloadMapIcon } = require('../media/icon-provider');
                let totalIcons = 0;
                for (const mg of mapsWithIcons) {
                    // Waypoint icons
                    const iconMap = await downloadWaypointIcons(mg);
                    // Swarm icons
                    if (mg._mapSwarms) {
                        for (const sw of mg._mapSwarms) {
                            for (const loc of sw.locations) {
                                if (!loc.icon) continue;
                                const iconPath = await downloadMapIcon(loc.icon);
                                if (iconPath) {
                                    iconMap[loc.name] = iconPath;
                                    loc._iconFile = iconPath;
                                }
                            }
                        }
                    }
                    const count = Object.keys(iconMap).length;
                    if (count > 0) {
                        mg._mapIcons = iconMap;
                        totalIcons += count;
                    }
                }
                if (totalIcons > 0) log.ok(`Downloaded ${totalIcons} map icon(s)`);
                else log.dim('No map icons downloaded');
            } catch (e) {
                log.warn(`Map icon download failed: ${e.message}`);
            }
            log.br();
        }

        // Slice 6B: propagate MapScene from allMGs to mgScenes. MapScene.renderAssets
        // is the single source of truth — all legacy side-channel writes (_mapWaypoints,
        // _mapView, _osmBoundaries, etc.) were dropped; the renderer + QA context both
        // read from _mapScene.renderAssets now. We still copy mapImageFile + subType +
        // mapVariant onto the target because those are plan-level fields consumed by
        // the preview and app.js outside the map data contract.
        for (const mg of fullscreenMGs) {
            if (mg.type !== 'mapChart') continue;
            const target = mgScenes.find(s => s.type === mg.type && s.startTime === mg.startTime);
            if (!target) continue;
            const mapSceneMode = mg._mapScene?.mapMode || null;
            const modeVariant = mapSceneMode === 'region' ? 'regionHighlight' : mapSceneMode;
            const effectiveVariant = mg.subType || mg.mapVariant || modeVariant || null;
            if (effectiveVariant && !target.subType) target.subType = effectiveVariant;
            if ((mg.mapVariant || modeVariant) && !target.mapVariant) target.mapVariant = mg.mapVariant || modeVariant;
            if (target.mgData) {
                if (effectiveVariant && !target.mgData.subType) target.mgData.subType = effectiveVariant;
                if ((mg.mapVariant || modeVariant) && !target.mgData.mapVariant) target.mgData.mapVariant = mg.mapVariant || modeVariant;
            }
            if (mg.mapImageFile) target.mapImageFile = mg.mapImageFile;
            if (mg._mapScene) target._mapScene = mg._mapScene;
        }
    }

    // Step 6.5: AI Templates (fullscreen template cards on V3)
    log.step('🎴 Step 6.5: AI Templates');
    let templateScenes = [];
    try {
        let templateResult;
        if (process.env.EDITOR_AGENT === 'true') {
            const { runTemplatesWorker } = require('../agents/workers/templates');
            const out = await runTemplatesWorker(scenesWithKeywords, scriptContext, mgScenes, {
                aiInstructions: combinedInstructions,
                log: (m) => log.dim(m),
            });
            templateResult = out.result || { templateScenes: [] };
        } else {
            templateResult = await processTemplates(scenesWithKeywords, scriptContext, mgScenes, combinedInstructions);
        }
        templateScenes = templateResult.templateScenes || [];
        const numericTemplateGuard = enforceNumericLowerThirdExclusivity({
            fps: config.video.fps,
            mgStyle,
            scenes: scenesWithKeywords,
            motionGraphics,
            mgScenes,
            templateScenes,
            scriptContext,
        }, scriptContext?._directives, { allowStageRemoval: true });
        if (numericTemplateGuard.fixed.length > 0) {
            templateScenes = templateScenes.filter(template => !template?.disabled);
            log.info(`🔢 Numeric treatment resolved ${numericTemplateGuard.fixed.length} competing graphic action(s) before template carving`);
        }
        if (templateScenes.length > 0) {
            log.ok(`Placed ${templateScenes.length} template(s)`);
            for (const tpl of templateScenes) {
                if (tpl.templateContentStartTime != null) {
                    log.dim(`   reveal window: ${tpl.templateContentStartTime.toFixed(1)}s-${tpl.templateContentEndTime.toFixed(1)}s`);
                }
                log.dim(`🎴 [${tpl.type}] "${tpl.text || ''}" @ ${tpl.startTime.toFixed(1)}s-${tpl.endTime.toFixed(1)}s`);
            }


            // Download item images for templates that need them (imageShowcase)
            try {
                const itemImgCount = await downloadTemplateItemImages(templateScenes, config.paths.temp, scriptContext);
                if (itemImgCount > 0) log.ok(`Downloaded ${itemImgCount} template item image(s)`);
            } catch (itemErr) {
                log.warn(`Template item images failed: ${itemErr.message} — continuing without`);
            }

            // Attach the underlying V1 scene media to each template background.
            // Template backgrounds are downloaded by the same Step 5 media agent
            // as normal scene footage, so there is no separate optional bg pass.
            for (const tpl of templateScenes) {
                if (tpl.templateBgFile) {
                    log.dim(`   🎨 [${tpl.type}] using dedicated bg: ${tpl.templateBgFile}`);
                    continue;
                }
                const srcScene = scenesWithMedia.find(s =>
                    s.startTime <= tpl.startTime && s.endTime >= tpl.endTime
                ) || scenesWithMedia.find(s =>
                    s.startTime < tpl.endTime && s.endTime > tpl.startTime
                );
                if (srcScene && srcScene.mediaFile) {
                    tpl.templateMediaFile = srcScene.mediaFile;
                    // mediaOffset into the clip for the template's start time
                    const offsetInScene = tpl.startTime - srcScene.startTime;
                    tpl.templateMediaOffset = (srcScene.mediaOffset || 0) + Math.max(0, offsetInScene);
                    log.dim(`   🎬 [${tpl.type}] using scene footage: ${path.basename(srcScene.mediaFile)}`);
                }
            }
            const nearestTemplateBgCount = attachTemplateBackgroundsFromAvailableMedia(
                templateScenes,
                scenesWithMedia,
                mgScenes,
                [],
                { log }
            );
            if (nearestTemplateBgCount > 0) {
                log.info(`🎨 Attached rich backgrounds to ${nearestTemplateBgCount} template scene(s) from nearby media/map assets`);
            }

            // Carve V1 scenes for template scenes (same logic as fullscreen MG carving)
            if (templateScenes.length > 0) {
                const MIN_FRAGMENT_DUR = 1.5;
                const tplRanges = templateScenes.map(tpl => ({ start: tpl.startTime, end: tpl.endTime }));
                let carved = [];
                let absorbedCount = 0;
                for (const scene of scenesWithMedia) {
                    let parts = [{ startTime: scene.startTime, endTime: scene.endTime }];
                    for (const range of tplRanges) {
                        const newParts = [];
                        for (const part of parts) {
                            if (range.start >= part.endTime || range.end <= part.startTime) {
                                newParts.push(part);
                            } else if (range.start <= part.startTime && range.end >= part.endTime) {
                                // Fully covered — remove
                            } else if (range.start > part.startTime && range.end < part.endTime) {
                                newParts.push({ startTime: part.startTime, endTime: range.start });
                                newParts.push({ startTime: range.end, endTime: part.endTime });
                            } else if (range.start <= part.startTime) {
                                newParts.push({ startTime: range.end, endTime: part.endTime });
                            } else {
                                newParts.push({ startTime: part.startTime, endTime: range.start });
                            }
                        }
                        parts = newParts;
                    }
                    const kept = parts.filter(p => (p.endTime - p.startTime) >= MIN_FRAGMENT_DUR);
                    absorbedCount += parts.length - kept.length;
                    for (const part of kept) {
                        const trimmedScene = { ...scene };
                        const offsetFromOriginal = part.startTime - scene.startTime;
                        trimmedScene.startTime = part.startTime;
                        trimmedScene.endTime = part.endTime;
                        trimmedScene.duration = part.endTime - part.startTime;
                        if (offsetFromOriginal > 0) {
                            trimmedScene.mediaOffset = (scene.mediaOffset || 0) + offsetFromOriginal;
                        }
                        carved.push(trimmedScene);
                    }
                }
                // Seamless coverage: bridge sub-threshold gaps left by absorbed fragments
                carved.sort((a, b) => a.startTime - b.startTime);
                const tplIntersects = (s, e) => tplRanges.some(r => s < r.end && e > r.start);
                let bridged = 0;
                for (let i = 0; i < carved.length - 1; i++) {
                    const cur = carved[i];
                    const nxt = carved[i + 1];
                    const gap = nxt.startTime - cur.endTime;
                    if (gap > 0.01 && gap < MIN_FRAGMENT_DUR && !tplIntersects(cur.endTime, nxt.startTime)) {
                        cur.endTime = nxt.startTime;
                        cur.duration = cur.endTime - cur.startTime;
                        bridged++;
                    }
                }
                const tplRemoved = scenesWithMedia.length - carved.length;
                scenesWithMedia = carved;
                if (tplRemoved > 0) log.info(`🔪 Carved ${tplRemoved} scene(s) to make room for templates`);
                if (absorbedCount > 0) log.info(`🧹 Absorbed ${absorbedCount} sub-threshold template fragment(s) (<${MIN_FRAGMENT_DUR}s)`);
                if (bridged > 0) log.info(`🔗 Bridged ${bridged} V1 gap(s) left by absorbed template fragments`);
            }

            // Remove overlay MGs that overlap with template time windows
            if (templateScenes.length > 0) {
                const tplRanges = templateScenes.map(tpl => ({
                    start: tpl.templateContentStartTime != null ? tpl.templateContentStartTime : tpl.startTime,
                    end: tpl.templateContentEndTime != null ? tpl.templateContentEndTime : tpl.endTime,
                }));
                const LISTICLE_OVERLAY_TYPES = new Set(['listicleCounter']);
                const beforeCount = motionGraphics.length;
                motionGraphics = motionGraphics.filter(mg => {
                    if (LISTICLE_OVERLAY_TYPES.has(mg.type)) return true;
                    const mStart = mg.startTime;
                    const mEnd = mStart + (mg.duration || 3);
                    return !tplRanges.some(r => mStart < r.end && mEnd > r.start);
                });
                const tplOverlapRemoved = beforeCount - motionGraphics.length;
                if (tplOverlapRemoved > 0) log.info(`🚫 Removed ${tplOverlapRemoved} overlay MG(s) that overlap templates`);
            }
        } else {
            log.dim('No templates placed');
        }
    } catch (error) {
        log.warn(`Template step failed: ${error.message} — continuing without templates`);
    }
    log.br();

    const resolvedThemeId = scriptContext?.themeId || 'standard';
    try {
        const { getTheme } = require('../data/themes');
        const resolvedTheme = getTheme(resolvedThemeId);
        if (resolvedTheme && resolvedTheme.effectParams) {
            scriptContext.effectParams = resolvedTheme.effectParams;
        }
    } catch (e) { /* themes.js not available - skip */ }

    const repairedTemplateCoverage = repairSkippedTemplateCoverage(
        scenesWithKeywords,
        scenesWithMedia,
        mgScenes,
        templateScenes,
        motionGraphics,
        scriptContext,
        { themeId: resolvedThemeId, mgStyle }
    );
    if (repairedTemplateCoverage.length > 0) {
        log.warn(`Repaired ${repairedTemplateCoverage.length} skipped template coverage gap(s) before HyperFrames composition.`);
        for (const tpl of repairedTemplateCoverage) {
            log.dim(`   coverage template: scene ${tpl.sceneIndex} [${tpl.type}] @ ${tpl.startTime.toFixed(1)}s-${tpl.endTime.toFixed(1)}s`);
        }
    }
    const repairedTemplateBgCount = attachTemplateBackgroundsFromAvailableMedia(
        templateScenes,
        scenesWithMedia,
        mgScenes,
        [],
        { log }
    );
    if (repairedTemplateBgCount > 0) {
        log.info(`🎨 Filled ${repairedTemplateBgCount} repaired/template background(s) from existing visual assets.`);
    }

    // Step 6.9: HyperFrames Motion Director
    // Gives the renderer one structured composition decision per visual item.
    // The old template/MG variant fields remain hints; HyperFrames consumes the
    // agenticComposition object as the main creative contract.
    if (motionGraphics.length > 0 || mgScenes.length > 0 || templateScenes.length > 0) {
        log.step('Step 6.9: HyperFrames Motion Director');
        try {
            const { applyHyperframesMotionDirector } = require('../render/hyperframes-motion-director');
            const directorResult = await applyHyperframesMotionDirector({
                motionGraphics,
                mgScenes,
                templateScenes,
                scenes: scenesWithKeywords,
                scriptContext,
                style: {
                    mgStyle,
                    mapStyle,
                    mapStylePack: mgResult.mapStylePack,
                    themeId: resolvedThemeId,
                },
                log,
            });
            motionGraphics = directorResult.motionGraphics || motionGraphics;
            mgScenes = directorResult.mgScenes || mgScenes;
            templateScenes = directorResult.templateScenes || templateScenes;
        } catch (error) {
            log.warn(`Motion Director failed: ${error.message} - using derived HyperFrames compositions`);
        }
        log.br();
    }

    // Step 6.95: Download real SFX from Freesound API
    {
        const transitionTypes = new Set();
        for (const scene of scenesWithMedia) {
            if (scene.transition?.type && scene.transition.type !== 'cut' && scene.transition.type !== 'none') {
                transitionTypes.add(scene.transition.type);
            }
        }
        // Collect MG types too — fullscreenMG on scenes + overlay MGs in allMGs
        const mgTypes = new Set();
        for (const scene of scenesWithMedia) {
            if (scene.fullscreenMG) {
                const colonIdx = scene.fullscreenMG.indexOf(':');
                const t = colonIdx > 0 ? scene.fullscreenMG.substring(0, colonIdx).trim() : scene.fullscreenMG.trim();
                if (t) mgTypes.add(t);
            }
        }
        if (Array.isArray(allMGs)) {
            for (const mg of allMGs) {
                if (mg?.type) mgTypes.add(mg.type);
            }
        }
        if (Array.isArray(templateScenes)) {
            for (const tpl of templateScenes) {
                if (tpl?.type) mgTypes.add(tpl.type);
            }
        }
        if (transitionTypes.size > 0 || mgTypes.size > 0) {
            log.step('🔊 Step 6.95: SFX Download');
            try {
                const { downloadSfxForTransitions, downloadSoundDesignKit } = require('../media/sfx-provider');
                const sfxResult = await downloadSfxForTransitions([...transitionTypes], { mgTypes: [...mgTypes], log });
                // Sound designer's cinematic toolkit (impact/riser/boom) — fetched once.
                try { await downloadSoundDesignKit({ log }); } catch (_) { /* graceful — designer skips missing files */ }
                if (sfxResult.noKey) {
                    log.warn('No FREESOUND_API_KEY — using bundled SFX');
                } else if (sfxResult.downloaded > 0) {
                    log.ok(`Downloaded ${sfxResult.downloaded} real SFX (${sfxResult.skipped} cached, ${sfxResult.failed} fallback)`);
                } else {
                    log.ok(`All ${sfxResult.skipped} SFX already cached`);
                }
            } catch (e) {
                log.warn(`SFX download failed: ${e.message} — using bundled SFX`);
            }
            log.br();
        }
    }

    // Step 6.96: Music bed (OPENMONTAGE-BORROW-PLAN #14) — feeds audio-mixer's
    // sidechain ducking. DEFAULT OFF (MUSIC_BED=1). Degrades to bedless (loudnorm-only).
    let musicBedFile = null;
    try {
        const { downloadMusicBed } = require('../media/music-provider');
        const mb = await downloadMusicBed({ scriptContext, log: (m) => log.dim(m) });
        if (mb && mb.file) { musicBedFile = mb.file; log.ok(`🎵 Music bed: ${mb.file} (${mb.source})`); }
    } catch (e) { log.warn(`Music bed skipped: ${e.message}`); }

    // ── Coverage sweep: the honest final audit, and the road back ────────────────
    // This replaces an audit that asked `!mediaFile && !isMGScene && !fullscreenMG`
    // and was structurally incapable of seeing the three ways a scene ends up
    // empty (see src/media/scene-coverage.js). It ran on a build that shipped
    // eight blank/apology scenes and printed "0 missing".
    //
    // It runs HERE because this is the first moment the graphic lists are final:
    // the Motion Director (Step 6.9) above is the last stage that adds or removes
    // fullscreen graphics, and Step 7 below turns everything into the plan. A
    // graphic disabled earlier has already left the list, so a scene that was
    // counting on it now shows up as uncovered — which is the whole point.
    {
        const coverageCtx = { graphics: [...(mgScenes || []), ...(templateScenes || [])] };
        // Scenes excluded from the download set never joined the V1 track at all
        // (fullscreenMG scenes and download:'skip' lanes are filtered out before
        // Step 5). They must be in the sweep's universe or the two biggest causes
        // of a blank scene stay invisible. Presenter holds are excluded: their
        // visual is owned by the presenter system, not the footage system, and
        // handing one a stock clip would be a worse bug than the blank.
        const { isOnTrack, offTrack } = partitionTrackMembership(scenesWithMedia, scenesWithKeywords);
        const sweepUniverse = [
            ...scenesWithMedia.filter(s => s && !s._presenterAnchor && !s.presenterInsert),
            ...offTrack,
        ];

        // Which off-track scenes were ALREADY covered before the sweep touched
        // them. The merge below may only re-attach a scene the sweep actually
        // fixed. Most off-track scenes are off-track on purpose — a fullscreen
        // graphic owns their whole span, so the carve dropped them from V1 — and
        // they still carry the mediaFile they were downloaded with. Joining those
        // on "has a mediaFile" puts footage back underneath the graphic that
        // replaced it. ANY coverage counts here, not just footage: a scene drawn
        // by its own graphic is already on screen, so it has nothing to join for.
        // Judged with the sweep's own classifier, so there is no second
        // definition of success anywhere.
        const _coveredBeforeSweep = new Set();
        try {
            const { classifyScene } = require('../media/scene-coverage');
            for (const s of offTrack) {
                const v = classifyScene(s, coverageCtx);
                if (v && v.covered) _coveredBeforeSweep.add(s);
            }
        } catch (_) { /* classifier unavailable — merge falls back to mediaFile only */ }

        let rescueResult = null;
        try {
            const { rescueUncovered } = require('../media/coverage-rescue');
            rescueResult = await rescueUncovered({
                scenes: sweepUniverse,
                graphics: coverageCtx.graphics,
                scriptContext,
                nicheId: scriptContext?.nicheId || scriptContext?.niche || null,
                downloadAllMedia,
                log: { info: (m) => log.info(m), warn: (m) => log.warn(m), ok: (m) => log.ok(m), dim: (m) => log.dim(m) },
            });
        } catch (e) {
            log.warn(`Coverage sweep failed: ${e.message} — scenes keep whatever they have`);
        }

        // ── Last rung before the give-up card ────────────────────────────────
        // A scene the rescue could not fill used to get a generated slide
        // reading "DOCUMENTARY CONTEXT". That is not a visual, and on screen it
        // reads as a broken video. Meanwhile this build is normally holding
        // twenty clips it already found, downloaded and vision-scored for other
        // scenes of the same video. Handing the closest-matching one to the
        // empty scene, at a different in-point, is real footage, on topic,
        // already through every quality gate, free, and instant.
        //
        // It runs AFTER the rescue on purpose: searching for the scene's own
        // footage is always better than reusing someone else's, so borrowing
        // may only ever see what genuinely could not be found.
        let borrowResult = null;
        try {
            const { borrowForUncovered } = require('../media/footage-borrow');
            borrowResult = await borrowForUncovered({
                scenes: sweepUniverse,
                graphics: coverageCtx.graphics,
                log: { info: (m) => log.info(m), warn: (m) => log.warn(m), ok: (m) => log.ok(m), dim: (m) => log.dim(m) },
            });
        } catch (e) {
            log.warn(`Footage borrow failed: ${e.message} — scenes keep whatever they have`);
        }

        // An off-track scene that just gained real footage — whether the rescue
        // found it or the borrow handed it over — has to join the base track or
        // nothing will draw it. Same merge the presenter holds use.
        if ((rescueResult && rescueResult.rescued > 0) || (borrowResult && borrowResult.borrowed > 0)) {
            const joined = offTrack.filter(s =>
                s.mediaFile && !isOnTrack(s) && !_coveredBeforeSweep.has(s)
            );
            if (joined.length > 0) {
                scenesWithMedia = [...scenesWithMedia, ...joined]
                    .sort((a, b) => (Number(a.startTime) || 0) - (Number(b.startTime) || 0));
                log.info(`   merged ${joined.length} refilled scene(s) back onto the base track`);
            }
        }

        // Report what the viewer will actually see. `summarize` uses the same
        // classifier the rescue and the borrow used, so this line cannot
        // disagree with either. Borrowed scenes are counted apart from found
        // ones: they render real footage, but the media system did not find it
        // for them, and blurring the two would hide how much of the video is
        // reuse — the exact dishonesty the coverage module exists to stop.
        const { summarize } = require('../media/scene-coverage');
        const cover = summarize(sweepUniverse, coverageCtx);
        const reuseNote = cover.borrowed > 0
            ? ` ${cover.borrowed} scene(s) reuse footage borrowed from elsewhere in this video.`
            : '';
        if (cover.uncovered > 0) {
            log.warn(`Coverage audit: ${cover.uncovered}/${cover.total} scene(s) have no real footage `
                + `(placeholder=${cover.placeholder}, orphanedGraphic=${cover.orphanedGraphic}, `
                + `skippedLane=${cover.skippedLane}, empty=${cover.none}).${reuseNote}`);
        } else {
            log.ok(`Coverage audit: all ${cover.total} scene(s) covered `
                + `(found=${cover.footage}, borrowed=${cover.borrowed}, `
                + `graphic=${cover.graphic + cover.graphicOwner}).${reuseNote}`);
        }
    }

    // Compact timeline indexes after carving while preserving the original
    // source identity used by assets, directives, QA, and visual ownership.
    assignFinalSceneIndices(scenesWithMedia);
    timelineContract.normalizeScenes(scenesWithMedia, {
        fps: config.video.fps,
        totalDuration: actualAudioDuration,
    }).forEach((normalized, index) => Object.assign(scenesWithMedia[index], normalized));

    // Assign V2 overlay scene indices (after V1 scenes)
    const v2ScenesForPlan = plannedV2Scenes.filter(v2 => v2.mediaFile);
    v2ScenesForPlan.forEach((v2, i) => {
        v2.index = scenesWithMedia.length + i;
        v2.sourceSceneIndex = v2.index;
    });
    timelineContract.normalizeScenes(v2ScenesForPlan, {
        fps: config.video.fps,
        totalDuration: actualAudioDuration,
        prefix: 'overlay-clip',
    }).forEach((normalized, index) => Object.assign(v2ScenesForPlan[index], normalized));
    timelineContract.normalizeVisualScenes(mgScenes, {
        fps: config.video.fps,
        totalDuration: actualAudioDuration,
        prefix: 'mg',
    }).forEach((normalized, index) => Object.assign(mgScenes[index], normalized));
    timelineContract.normalizeVisualScenes(templateScenes, {
        fps: config.video.fps,
        totalDuration: actualAudioDuration,
        prefix: 'template',
        fallbackDuration: 4,
    }).forEach((normalized, index) => Object.assign(templateScenes[index], normalized));
    for (const graphic of motionGraphics) {
        if (!graphic || graphic.originalSceneIndex != null) continue;
        const ownerScene = scenesWithKeywords.find(scene => scene?.index === graphic?.sceneIndex);
        const stableOwnerIndex = ownerScene?.originalIndex
            ?? ownerScene?.sourceSceneIndex
            ?? graphic?.sourceSceneIndex
            ?? graphic?.sceneIndex;
        if (stableOwnerIndex == null) continue;
        graphic.sourceSceneIndex = stableOwnerIndex;
        graphic.originalSceneIndex = stableOwnerIndex;
    }

    // Step 7: Create video plan
    log.step('📋 Step 7: Creating video plan');
    // Merge V1 + V2 scenes into a single array for the renderer
    const allScenes = [...scenesWithMedia, ...v2ScenesForPlan];
    if (v2ScenesForPlan.length > 0) {
        log.ok(`Merged ${v2ScenesForPlan.length} V2 overlay scenes into plan`);
    }

    // Tripwire: two main-track scenes on the same (start, end, media) are the same
    // beat drawn twice. The renderer stacks them, the second copy wins, and it is
    // the copy that missed every late per-index enrichment (FX recipe, transitions).
    // This is silent by construction — the timeline contract renames the colliding
    // clipId and everything downstream looks healthy — so it has to be shouted
    // here, at the one place the main track is finalised.
    {
        const seen = new Map();
        for (const s of scenesWithMedia) {
            if (!s) continue;
            const key = `${Number(s.startTime) || 0}|${Number(s.endTime) || 0}|${s.mediaFile || ''}`;
            seen.set(key, (seen.get(key) || 0) + 1);
        }
        const dupes = [...seen.values()].filter(n => n > 1).length;
        if (dupes > 0) {
            const extra = [...seen.values()].reduce((a, n) => a + (n - 1), 0);
            log.warn(`⚠️  DUPLICATE MAIN-TRACK SCENES: ${dupes} timeline slot(s) carry more than one scene (${extra} redundant scene(s), ${scenesWithMedia.length} total).`);
            log.warn('   Every duplicated beat renders twice and the copy on top loses its per-index enrichment (effect recipe, transition).');
            log.warn('   This means a merge upstream appended scenes that were already on the track — check the coverage-sweep merge.');
        }
    }

    // Theme effectParams were resolved before HyperFrames Motion Director so
    // the editor pass and renderer share the same theme context.

    // ── Step 6.96b: Transition Director BEFORE the Sound Designer ──
    // The SFX family contract (a push never gets a fire-burn, a soft dissolve stays silent)
    // is enforced against scene.transition. The Transition Director REWRITES those types,
    // so it must run BEFORE SFX — otherwise SFX are matched to the stale algorithmic
    // transitions and then the types change out from under them (whoosh on a crossfade,
    // silent whip, etc). It's cached (.hf-tx-cache.json), so the Step 7.6 authorPlanCompositions
    // call reuses this result (0 extra AI calls). No-op when HF_TRANSITION_DIRECTOR=0.
    try {
        const { directTransitions } = require('../agents/workers/transition-director');
        const _tx = await directTransitions(
            { scenes: allScenes, mgScenes, templateScenes, motionGraphics, scriptContext },
            { projectDir: PROJECT_DIR, log: (m) => console.log(m) }
        );
        if (_tx && _tx.decided) log.ok(`Transition Director set ${_tx.decided} motivated transition(s)${_tx.cached ? ' (cached)' : ''} — SFX will gate on final types`);
    } catch (e) {
        log.warn(`Transition Director (pre-SFX) skipped: ${e.message} — SFX gate on algorithmic transitions`);
    }

    // Generate SFX clips for the video plan (used by export muxer)
    const planSfxClips = [];
    // ── Step 6.97: AI Sound Designer (agentic, motivated, tone-matched SFX) ──
    // The PRIMARY sound path: a sound designer scores the cut from the real SFX
    // palette, matched to content + beat + theme tone. The mechanical type→file
    // placement below stays as the graceful-degradation floor (used only if the
    // designer is disabled/fails). HF_SOUND_DESIGNER=0 forces the floor.
    let _soundDesigned = false;
    try {
        const { designSound } = require('../agents/workers/sound-designer');
        log.step('🔊 Step 6.97: Sound Designer (agentic SFX)');
        const _sd = await designSound(
            { scenes: allScenes, mgScenes, templateScenes, motionGraphics, scriptContext, totalDuration: actualAudioDuration },
            { projectDir: PROJECT_DIR, log: (m) => console.log(m) }
        );
        if (_sd && Array.isArray(_sd.clips) && _sd.clips.length) {
            planSfxClips.push(..._sd.clips);
            _soundDesigned = true;
            log.ok(`Sound Designer scored ${_sd.clips.length} SFX clip(s) (agentic${_sd.cached ? ', cached' : ''})`);
        }
    } catch (e) { log.warn(`Sound Designer skipped: ${e.message} — falling back to mechanical SFX`); }

    if (!_soundDesigned) try {
        const { TRANSITION_TO_SFX, MG_TO_SFX } = require('../media/sfx-provider');
        const transitionSfxDurations = {
            fade: 0.5,
            fade_to_black: 0.4,
            dissolve: 0.5,
            crossfade: 0.5,
            blur: 0.5,
            crossBlur: 0.5,
            morph: 0.5,
            dreamFade: 0.5,
            colorFade: 0.5,
            luma: 0.5,
            lumaFade: 0.5,
            lumaDark: 0.5,
            filmBurn: 0.6,
            filmGrain: 0.6,
            reveal: 0.6,
            ink: 0.6,
            shadowWipe: 0.3,
            ripple: 0.7,
            wipe: 0.3,
            slide: 0.4,
            push: 0.4,
            swipe: 0.3,
            splitWipe: 0.3,
            zoom: 0.5,
            zoomBlur: 0.5,
            zoomOut: 0.5,
            zoomRotate: 0.6,
            panLeft: 0.4,
            panRight: 0.4,
            panUp: 0.4,
            panDown: 0.4,
            whip: 0.3,
            whipPan: 0.3,
            directionalBlur: 0.3,
            spin: 0.6,
            bounce: 0.4,
            lightLeak: 0.6,
            warmLeak: 0.6,
            coolLeak: 0.6,
            flare: 0.6,
            flash: 0.3,
            cameraFlash: 0.3,
            vignetteBlink: 0.3,
            glitch: 0.4,
            pixelate: 0.4,
            mosaic: 0.4,
            dataMosh: 0.4,
            scanline: 0.5,
            rgbSplit: 0.4,
            static: 0.5,
            prismShift: 0.5,
            diagonalStripes: 0.3,
            rectangles: 0.3,
            diamonds: 0.4,
            blinds: 0.4,
            circles: 0.5,
            shutterSlice: 0.3,
        };
        const mgSfxDurations = {
            headline: 0.25,
            lowerThird: 0.35,
            callout: 0.35,
            focusWord: 0.25,
            statCounter: 0.15,
            progressBar: 0.15,
            bulletList: 0.25,
            barChart: 0.4,
            donutChart: 0.4,
            comparisonCard: 0.4,
            timeline: 0.5,
            rankingList: 0.5,
            kineticText: 0.2,
            typewriter: 0.3,
            subscribeCTA: 0.5,
            mapChart: 0.4,
            explainer: 0.35,
            listicleCounter: 0.15,
            progressTracker: 0.15,
            splitScreen: 0.35,
            infographic: 0.4,
            factCard: 0.25,
            statCard: 0.4,
            personIntro: 0.35,
            imageShowcase: 0.25,
            listicleGrid: 0.25,
            chapterCard: 0.35,
            locationCard: 0.35,
            quoteCard: 0.5,
            keyTakeaway: 0.4,
            timelineCard: 0.5,
        };

        // ── Professional sound design: MOTIVATED + SPARSE placement ──
        // A sound designer does NOT put a whoosh on every cut/dissolve or a ding
        // on every lower-third — that reads as noisy and amateur. SFX are reserved
        // for MOTIVATED moments only (hard/kinetic transitions + impactful reveals)
        // and spaced out by a minimum gap so they never stack. Gentle transitions
        // (crossfade/dissolve/fade/blur) and constant overlays (lowerThird/callout/
        // focusWord/kineticText/caption) stay SILENT. SFX_LEGACY=1 restores the old
        // dense every-boundary/every-MG behavior.
        const legacySfx = /^(1|true|on|yes)$/i.test(String(process.env.SFX_LEGACY || '').trim());
        // Motivated-transition + impact-MG gates + density come from the shared
        // build-side SFX ruleset used by the AI designer and deterministic floor.
        const { MOTIVATED_TRANSITIONS, IMPACT_MG_TYPES, DENSITY, normTx } = require('../agents/workers/sfx-rules');
        // The modern transition-director emits kebab/directional types (whip-right,
        // zoom-punch, dip-black) that don't match the camelCase TRANSITION_TO_SFX
        // keys (whip, zoom, fade_to_black). Resolve modern → SFX file robustly.
        const _txKeyIndex = {};
        for (const k of Object.keys(TRANSITION_TO_SFX || {})) _txKeyIndex[k.toLowerCase()] = k;
        const TX_SFX_ALIAS = { dipblack: 'fade_to_black', blurdissolve: 'dissolve', zoompull: 'zoom', zoompunch: 'zoom' };
        const resolveTxSfx = (type) => {
            if (TRANSITION_TO_SFX[type]) return TRANSITION_TO_SFX[type];
            const low = String(type || '').toLowerCase().replace(/[-_\s]/g, '');
            if (TX_SFX_ALIAS[low] && TRANSITION_TO_SFX[TX_SFX_ALIAS[low]]) return TRANSITION_TO_SFX[TX_SFX_ALIAS[low]];
            const baseTok = String(type || '').toLowerCase().split(/[-_\s]/)[0];
            if (_txKeyIndex[baseTok]) return TRANSITION_TO_SFX[_txKeyIndex[baseTok]];
            if (_txKeyIndex[normTx(type)]) return TRANSITION_TO_SFX[_txKeyIndex[normTx(type)]];
            return null;
        };
        const MIN_SFX_GAP = Number(process.env.SFX_MIN_GAP_SEC || DENSITY.minGapSec);
        // Role levels: an impactful reveal reads louder than a transition whoosh
        // (final mix is loudnorm-normalized by audio-mixer.js). Env-overridable.
        const SFX_VOL_WHOOSH = Number(process.env.SFX_VOL_WHOOSH || 0.3);
        const SFX_VOL_IMPACT = Number(process.env.SFX_VOL_IMPACT || 0.50); // converge on the worker's impact band (0.46-0.56)

        const sfxCandidates = [];
        // Transition SFX — motivated boundaries only
        const sortedScenes = [...allScenes].filter(s => !s.isMGScene).sort((a, b) => a.startTime - b.startTime);
        for (let i = 1; i < sortedScenes.length; i++) {
            const prev = sortedScenes[i - 1];
            const curr = sortedScenes[i];
            if (Math.abs(curr.startTime - prev.endTime) > 0.1) continue;
            const transType = curr.transition?.type;
            if (!transType || transType === 'cut' || transType === 'none') continue;
            if (!legacySfx && !MOTIVATED_TRANSITIONS.has(normTx(transType))) continue; // gentle transitions stay silent
            const sfxFile = resolveTxSfx(transType) || (legacySfx ? 'sfx-fade.mp3' : null);
            if (!sfxFile) continue;
            const sfxDuration = transitionSfxDurations[transType] || Math.max(0.3, (curr.transition?.duration || 0.5) + 0.1);
            // Whoosh leads the cut by a hair (~40ms), not 150ms.
            sfxCandidates.push({ file: sfxFile, startTime: Math.max(0, curr.startTime - 0.04), duration: sfxDuration, volume: SFX_VOL_WHOOSH, transitionType: transType, _kind: 'transition', _priority: 1 });
        }

        // MG SFX — impactful reveals only
        const allMGsForSfx = [...(motionGraphics || []), ...(mgScenes || []), ...(templateScenes || [])];
        for (const mg of allMGsForSfx) {
            if (mg.disabled) continue;
            if (!legacySfx && !IMPACT_MG_TYPES.has(mg.type)) continue; // ambient/constant overlays stay silent
            const sfxFile = MG_TO_SFX[mg.type];
            if (!sfxFile) continue;
            sfxCandidates.push({ file: sfxFile, startTime: mg.startTime || 0, duration: mgSfxDurations[mg.type] || 0.5, volume: SFX_VOL_IMPACT, transitionType: mg.type, _kind: 'mg', _priority: 2 });
        }

        // Density budget — PRIORITY-FIRST: an impactful reveal wins its slot over a
        // transition whoosh crowding the same window (a real sound designer protects
        // the important sound, not merely the earliest). Place higher-priority
        // candidates first; drop any lower one within MIN_SFX_GAP of a placed clip.
        const _bySalience = [...sfxCandidates].sort((a, b) => (b._priority - a._priority) || (a.startTime - b.startTime));
        const _kept = [];
        let _dropped = 0;
        for (const c of _bySalience) {
            if (!legacySfx && _kept.some(k => Math.abs(k.startTime - c.startTime) < MIN_SFX_GAP)) { _dropped++; continue; }
            _kept.push(c);
        }
        _kept.sort((a, b) => a.startTime - b.startTime);
        for (const c of _kept) { const { _kind, _priority, ...clip } = c; planSfxClips.push(clip); }
        if (planSfxClips.length > 0 || _dropped > 0) {
            log.ok(`Generated ${planSfxClips.length} SFX clips (sound-design: motivated + sparse${legacySfx ? ' [LEGACY dense]' : `, ≥${MIN_SFX_GAP}s apart, ${_dropped} suppressed`})`);
        }
    } catch (e) { log.warn(`SFX clip generation failed: ${e.message}`); }

    // Keep the exact creator context that produced this plan as build provenance.
    // Project settings remain canonical for the next build, but this makes a plan
    // diagnosable and recoverable if a settings envelope is ever damaged.
    scriptContext.videoTitle = String(process.env.VIDEO_TITLE || '').trim();
    scriptContext.aiInstructions = String(process.env.AI_INSTRUCTIONS || '').trim();

    const videoPlan = {
        audio: audioFile,
        totalDuration: actualAudioDuration,
        fps: config.video.fps,
        width: config.video.width,
        height: config.video.height,
        scenes: allScenes,
        mgScenes: mgScenes,
        templateScenes: templateScenes,
        motionGraphics: motionGraphics,
        sfxClips: planSfxClips,
        musicBed: musicBedFile || undefined,
        mgStyle: mgStyle,
        mapStyle: mapStyle,
        scriptContext: scriptContext,
        themeId: resolvedThemeId
    };
    videoPlan.timelineContractVersion = timelineContract.VERSION;

    const planPath = path.join(config.paths.temp, 'video-plan.json');
    writeVideoPlanAtomic(planPath, videoPlan);
    log.ok('Plan saved');
    log.br();

    // ── Orchestrator Phase 3: Post-Build Review + Gap-Filling ──
    if (buildManifest) {
        try {
            const reviewResult = await postBuildReview(videoPlan, buildManifest, midBuildStats);
            videoPlan.buildReport = reviewResult.report;
            if (reviewResult.injectedMGs && reviewResult.injectedMGs.length > 0) {
                log.ok(`Orchestrator injected ${reviewResult.injectedMGs.length} overlay MG(s) to fill gaps`);
            }
            // Re-save plan with build report + any injected MGs
            writeVideoPlanAtomic(planPath, videoPlan);
        } catch (error) {
            log.warn(`Orchestrator Phase 3 failed: ${error.message}`);
        }
    }

    // ── Step 7.6: Composition Author — agent-authored templates + fullscreen
    // MGs (HyperFrames). Runs IN the build (long AI work belongs here, not at
    // preview load). Results attach to the plan objects and serialize into
    // video-plan.json; the render-prep pass in main.js then hits the cache
    // and costs nothing. Failures degrade to fixed-template renderers.
    try {
        const { authorPlanCompositions } = require('../agents/workers/composition-author');
        log.step('🎨 Step 7.6: Composition Author (agent-authored MGs)');
        const authorRes = await authorPlanCompositions(videoPlan, {
            projectDir: PROJECT_DIR,
            fastTest: _fastMedia,
            log: (m) => console.log(m),
        });
        if (authorRes && authorRes.eligible > 0) {
            log.ok(`Composition Author: ${authorRes.authored}/${authorRes.eligible} scene(s) authored`);
            writeVideoPlanAtomic(planPath, videoPlan);
        }
    } catch (error) {
        log.warn(`Composition Author skipped: ${error.message}`);
    }

    // ── Step 7.7: Compliance Loop — verify the FINALIZED plan obeys the creator's
    // directives (global + per-scene) and deterministically fix drift BEFORE the
    // public copy. Runs last so _hfBaseLook/transitions (finalized in 7.6) are
    // present. No-op when there's no order (OFF-identical). Env COMPLIANCE_LOOP=0.
    if (process.env.COMPLIANCE_LOOP !== '0' && videoPlan.scriptContext && videoPlan.scriptContext._directives) {
        try {
            const { auditCompliance } = require('../directives/compliance-loop');
            log.step('🛡️  Step 7.7: Compliance Loop (verify + fix against creator directives)');
            const rep = await auditCompliance(videoPlan, { log: (m) => console.log(m) });
            if (!rep.skipped) {
                videoPlan.complianceReport = rep;
                if (rep.fixed && rep.fixed.length) {
                    // Re-write so the public copy below ships the fixed plan.
                    writeVideoPlanAtomic(planPath, videoPlan);
                }
                log.ok(`Compliance: ${(rep.checked || []).length} slice(s) checked · ${(rep.fixed || []).length} auto-fixed · ${(rep.unfixable || []).length} flagged${rep.ok ? '' : ' (see complianceReport)'}`);
                for (const u of (rep.unfixable || [])) log.warn(`   ⚠️ [Compliance] ${u.reason}`);
            }
        } catch (e) { log.warn(`Compliance loop skipped: ${e.message}`); }
    }

    // ── Step 7.8: Agentic Motion QA preflight ────────────────────────────────
    // The Motion Director chooses the creative treatment; this pass makes sure
    // every resulting visual has enough time for entrance + readable hold +
    // exit, and resolves same-zone collisions before the plan is published.
    // Full HyperFrames pixel/keyframe/vision verification runs automatically
    // immediately before render, when the final generated composition exists.
    try {
        const { prepareMotionPlan } = require('../agents/workers/motion-qa-agent');
        log.step('🎯 Step 7.8: Motion QA (automatic animation preflight)');
        const motionQa = prepareMotionPlan(videoPlan, { log: (message) => console.log(message) });
        videoPlan.motionQa = {
            version: motionQa.version || 1,
            status: motionQa.status,
            agentic: true,
            stage: 'build-preflight',
            checkedVisuals: motionQa.checked || 0,
            repairCount: (motionQa.repairs || []).length,
            findingCount: (motionQa.findings || []).length,
        };
        try {
            fs.writeFileSync(
                path.join(config.paths.temp, 'motion-qa-build-report.json'),
                `${JSON.stringify(motionQa, null, 2)}\n`,
                'utf8'
            );
        } catch (_) { /* report is advisory; the repaired plan is authoritative */ }
        writeVideoPlanAtomic(planPath, videoPlan);
        if ((motionQa.repairs || []).length) {
            log.ok(`Motion QA preflight repaired ${motionQa.repairs.length} animation issue(s) automatically`);
        } else {
            log.ok(`Motion QA preflight checked ${motionQa.checked || 0} visual(s) — no timing repair needed`);
        }
        for (const finding of (motionQa.findings || []).slice(0, 8)) {
            log.warn(`   [Motion QA] ${finding.code}: ${finding.message}`);
        }
    } catch (e) {
        log.warn(`Motion QA preflight skipped: ${e.message}`);
    }

    // Step 8: Copy files to public folder
    log.step('📂 Step 8: Copying files to public folder');
    const publicDir = path.join(PROJECT_DIR, 'public');

    // Ensure public folder exists
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    // Copy video plan
    copyVideoPlanAtomic(planPath, path.join(publicDir, 'video-plan.json'));

    // Copy audio file
    fs.copyFileSync(
        path.join(config.paths.input, audioFile),
        path.join(publicDir, audioFile)
    );

    // Copy media files (videos and images) with asset naming convention
    // After gap-carving, scenes may have different indices than their source files
    // Use _fileIndex (original download index) for source, array position for destination
    let copiedMediaCount = 0;
    let skippedMediaCount = 0;
    for (let i = 0; i < scenesWithMedia.length; i++) {
        const scene = scenesWithMedia[i];
        if (copyAcceptedSceneMediaToPublic(scene, i, publicDir)) copiedMediaCount++;
        else skippedMediaCount++;
    }
    if (skippedMediaCount > 0) {
        log.warn(`Skipped public media copy for ${skippedMediaCount} failed scene(s); copied ${copiedMediaCount} accepted file(s)`);
    }
    // Copy V2 overlay images
    for (let i = 0; i < v2ScenesForPlan.length; i++) {
        const v2 = v2ScenesForPlan[i];
        if (v2.mediaFile && fs.existsSync(v2.mediaFile)) {
            const ext = v2.mediaExtension || '.jpg';
            const destName = `v2-overlay-${i}-asset${ext}`;
            const destPath = path.join(publicDir, destName);
            fs.copyFileSync(v2.mediaFile, destPath);
            v2.mediaFile = path.join(publicDir, destName);
            log.dim(`📸 Copied V2 overlay: ${destName}`);
        }
        delete v2._fileIndex;
    }

    // Copy map image files (for mapChart API mode)
    for (const mg of mgScenes) {
        if (mg.mapImageFile) {
            const srcMap = path.join(config.paths.temp, mg.mapImageFile);
            const destMap = path.join(publicDir, mg.mapImageFile);
            if (fs.existsSync(srcMap)) {
                fs.copyFileSync(srcMap, destMap);
                log.dim(`🗺️ Copied map image: ${mg.mapImageFile}`);
            }
        }
    }
    // Copy template background media. `templateMediaFile` is first-class media:
    // it was downloaded for the template beat and must not be overwritten by
    // the later nearest-scene fallback pass.
    let copiedTemplateMediaCount = 0;
    let fallbackTemplateMediaCount = 0;
    for (let i = 0; i < templateScenes.length; i++) {
        const tpl = templateScenes[i];
        if (tpl.templateBgFile) {
            const srcBg = path.join(config.paths.temp, tpl.templateBgFile);
            const destBg = path.join(publicDir, tpl.templateBgFile);
            if (fs.existsSync(srcBg)) {
                fs.copyFileSync(srcBg, destBg);
                log.dim(`🖼️ Copied template bg: ${tpl.templateBgFile}`);
            }
        }
        const templateCopy = copyTemplateMediaToPublic(tpl, i, publicDir, { log });
        if (['copied', 'copied-transcoded', 'already-public'].includes(templateCopy.status)) {
            copiedTemplateMediaCount++;
        } else if (['missing', 'copy-failed'].includes(templateCopy.status)) {
            fallbackTemplateMediaCount++;
        }
        // Copy item thumbnail images (imageShowcase etc.)
        if (tpl._itemThumbnails && tpl._itemThumbnails.length > 0) {
            for (const thumb of tpl._itemThumbnails) {
                if (!thumb) continue;
                const srcThumb = path.join(config.paths.temp, thumb);
                const destThumb = path.join(publicDir, thumb);
                if (fs.existsSync(srcThumb)) {
                    fs.copyFileSync(srcThumb, destThumb);
                    log.dim(`🖼️ Copied template item image: ${thumb}`);
                }
            }
        }
    }
    if (copiedTemplateMediaCount > 0) {
        log.info(`🎨 Preserved ${copiedTemplateMediaCount} dedicated template media asset(s) in public.`);
    }
    if (fallbackTemplateMediaCount > 0) {
        log.warn(`${fallbackTemplateMediaCount} template media asset(s) were missing or failed to copy; nearest-media fallback will fill only those.`);
    }
    const publicTemplateBgCount = attachTemplateBackgroundsFromAvailableMedia(
        templateScenes,
        scenesWithMedia,
        mgScenes,
        [],
        { log }
    );
    if (publicTemplateBgCount > 0) {
        log.info(`🎨 Filled ${publicTemplateBgCount} missing template background(s) from copied public assets.`);
    }
    // Also check overlay MGs for map images
    for (const mg of motionGraphics) {
        if (mg.mapImageFile) {
            const srcMap = path.join(config.paths.temp, mg.mapImageFile);
            const destMap = path.join(publicDir, mg.mapImageFile);
            if (fs.existsSync(srcMap)) {
                fs.copyFileSync(srcMap, destMap);
                log.dim(`🗺️ Copied map image: ${mg.mapImageFile}`);
            }
        }
    }

    // Copy SFX files to public folder
    const sfxDir = path.join(__dirname, '..', '..', 'assets', 'sfx');
    if (fs.existsSync(sfxDir)) {
        const sfxFiles = fs.readdirSync(sfxDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
        for (const sfxFile of sfxFiles) {
            fs.copyFileSync(path.join(sfxDir, sfxFile), path.join(publicDir, sfxFile));
        }
        if (sfxFiles.length > 0) log.dim(`🔊 Copied ${sfxFiles.length} SFX files`);
    }

    // Copy the selected music bed (#14) to public so the renderer/audio-mixer resolves it.
    if (musicBedFile) {
        try {
            const srcBed = path.join(__dirname, '..', '..', 'assets', 'music', musicBedFile);
            if (fs.existsSync(srcBed)) { fs.copyFileSync(srcBed, path.join(publicDir, musicBedFile)); log.dim(`🎵 Copied music bed: ${musicBedFile}`); }
        } catch (e) { log.warn(`Music bed copy failed: ${e.message}`); }
    }

    // Copy background pattern files referenced by scenes
    const bgDir = path.join(__dirname, '..', '..', 'assets', 'backgrounds');
    const bgFilesCopied = new Set();
    for (const scene of scenesWithMedia) {
        if (scene.background && scene.background.startsWith('pattern:')) {
            const bgFilename = scene.background.replace('pattern:', '');
            if (!bgFilesCopied.has(bgFilename)) {
                const srcBg = path.join(bgDir, bgFilename);
                const destBg = path.join(publicDir, `bg-${bgFilename}`);
                if (fs.existsSync(srcBg)) {
                    fs.copyFileSync(srcBg, destBg);
                    bgFilesCopied.add(bgFilename);
                }
            }
        }
    }
    if (bgFilesCopied.size > 0) log.dim(`🖼️ Copied ${bgFilesCopied.size} background pattern files`);

    // Copy explainer transparent PNGs
    let explainersCopied = 0;
    for (const mg of allMGs) {
        if (mg.type === 'explainer' && mg.explainerImageFile) {
            const srcImg = path.join(config.paths.temp, mg.explainerImageFile);
            const destImg = path.join(publicDir, mg.explainerImageFile);
            if (fs.existsSync(srcImg)) {
                fs.copyFileSync(srcImg, destImg);
                explainersCopied++;
            }
        }
    }
    if (explainersCopied > 0) log.dim(`🖼️ Copied ${explainersCopied} explainer images`);

    log.ok('Files copied to public folder');

    // Re-link listicle grid thumbnails to updated public scene paths
    // Check both mgScenes (legacy) and templateScenes (new system)
    for (const container of [videoPlan.mgScenes, videoPlan.templateScenes]) {
        if (!container) continue;
        for (const mg of container) {
            if (mg.type === 'listicleGrid' && videoPlan.scriptContext?.listicleItems) {
                mg._itemThumbnails = videoPlan.scriptContext.listicleItems.map(item => {
                    const scene = scenesWithMedia[item.startSceneIndex];
                    return scene?.mediaFile || null;
                });
            }
        }
    }

    // Re-save video plan with updated public mediaFile paths
    fs.writeFileSync(
        path.join(publicDir, 'video-plan.json'),
        JSON.stringify(videoPlan, null, 2)
    );
    log.ok('Updated video-plan.json with public paths');
    log.br();

    // Fold this video's media memory into the niche's shared footage library, so the
    // next video in this niche starts from what this one learned instead of paying to
    // rediscover it. Deliberately here, on finished state, rather than inside the
    // download path: that path is the most crash-sensitive code in the pipeline and
    // must not carry library work. Entirely best-effort — a build never fails here.
    try {
        const { getMediaMemoryPath } = require('../media/media-memory-bank');
        const studioCtx = require('../project/studio-link')
            .resolveContext({ projectDir: PROJECT_DIR }) || {};
        // The creator's own niche on the channel wins when he has set one; otherwise
        // fall back to what the Director detected, because a fresh channel's
        // _channel.json still has an empty niche and would key the library on nothing.
        const libraryNiche = studioCtx.niche || scriptContext.nicheId || '';
        let bankPath = '';
        try { bankPath = getMediaMemoryPath(); } catch (_) {}
        if (!bankPath || !fs.existsSync(bankPath)) {
            bankPath = path.join(config.paths.temp, 'media-source-memory-bank.json');
        }
        if (libraryNiche && fs.existsSync(bankPath)) {
            require('../media/footage-library').mergeVideoBank({
                bankPath,
                assetDir: path.join(path.dirname(bankPath), 'media-memory-assets'),
                niche: libraryNiche,
                channelSlug: studioCtx.channelSlug || '',
                vaultId: studioCtx.vaultId ?? null,
                videoId: studioCtx.videoId || path.basename(PROJECT_DIR),
            });
        }
    } catch (e) {
        console.warn(`[Footage Library] merge skipped: ${e.message}`);
    }

    // Done!
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    log.banner('BUILD COMPLETE!');
    log.timing('Total time', elapsed);
    logCostReport(console.log);
    writeCostReport(path.join(PROJECT_DIR, 'cost-report.json'));
    log.kv('Audio', audioFile);
    log.kv('Duration', `${videoPlan.totalDuration.toFixed(2)} seconds`);
    log.kv('Scenes', `${scenesWithMedia.length} footage + ${mgScenes.length} full-screen MG + ${v2ScenesForPlan.length} V2 overlays`);
    log.br();
    log.substep('📊 All scenes (timeline order):');
    log.divider();
    // Merge footage + MG + V2 scenes and sort by startTime for unified log
    const allScenesSorted = [
        ...scenesWithMedia.map((s, i) => ({ ...s, _logIdx: i, _kind: 'footage' })),
        ...mgScenes.map((s, i) => ({ ...s, _logIdx: i, _kind: 'mg' })),
        ...v2ScenesForPlan.map((s, i) => ({ ...s, _logIdx: i, _kind: 'v2' })),
    ].sort((a, b) => a.startTime - b.startTime);
    allScenesSorted.forEach((scene, i) => {
        if (scene._kind === 'mg') {
            log.scene(i, 'mg', `[${scene.type}] "${scene.text || ''}"`, '');
        } else if (scene._kind === 'v2') {
            log.scene(i, 'v2', scene.keyword, '');
        } else {
            log.scene(i, scene.mediaType === 'image' ? 'image' : 'video', scene.keyword, scene.sourceProvider || 'unknown');
        }
    });
    log.divider();

    log.br();
    log.info(`🚀 Open the app and use the WebGL2 renderer to render your video.`);
    log.br();

    // ── Checkpoint retention (persist after success) ──
    // KEEP the post-Director/VP snapshot after a successful build so "Repeat From Step:
    // Media Download" works on this project's FIRST build (and every later one) — re-running
    // media reuses the existing Director/VP/orchestrator plan instead of paying AI credits
    // to regenerate it. This matches the stated intent at the resume block above; deleting
    // it on success was the leftover contradiction that made repeat-from-media fall back to
    // a full Director re-run after any completed build. Safe to persist: it's audioFile-keyed
    // and only read when resume/repeat is explicitly requested, normal builds ignore it, and
    // a fresh full build of the same audio overwrites it at Step 4.8. Force a clean slate
    // with BUILD_CLEAR_CHECKPOINT=true.
    try {
        if (process.env.BUILD_CLEAR_CHECKPOINT === 'true') {
            if (fs.existsSync(CHECKPOINT_FILE)) {
                fs.unlinkSync(CHECKPOINT_FILE);
                log.dim('   🗑️ Build checkpoint cleared (BUILD_CLEAR_CHECKPOINT=true)');
            }
        } else if (fs.existsSync(CHECKPOINT_FILE)) {
            log.dim('   ♻️  Build checkpoint retained — "Repeat From Step: Media Download" will reuse the Director/VP plan');
        }
    } catch (_) {}
}

// Close the Storyblocks browser and sweep any leftover stock downloads (private
// workspace + anything that leaked into the user's Downloads this session) so
// nothing piles up after the build — run on BOTH success and failure.
async function cleanupStoryblocksDownloads() {
    try {
        const sb = require('../media/providers/storyblocks-video');
        if (typeof sb.closeStoryblocksBrowser === 'function') await sb.closeStoryblocksBrowser();
        else if (typeof sb.purgeStoryblocksDownloadLeaks === 'function') sb.purgeStoryblocksDownloadLeaks();
    } catch (_) { /* provider not loaded this build */ }
}

// Stop the rented vision GPU if THIS build started it (vision is done once the build ends;
// rendering is a separate step that needs no GPU). Leaves a user-pre-warmed machine running.
async function _stopVisionGpuIfStarted() {
    try {
        const r = await require('../vision/vision-gpu').stopIfStarted({ onProgress: (m) => console.log(`   ${m}`) });
        if (r && r.ok && !r.skipped) console.log('🖥️  Vision GPU stopped (scoring done).');
    } catch (_) { /* best-effort */ }
}

// Testable helpers (safe to require without running the pipeline).
module.exports = { getFfmpegPath, getFfprobePath, probeNarration, cleanNarration };
// Test-only surface (verify-directives.js; require with BUILD_VIDEO_NO_RUN=1).
module.exports.__test = { applySceneDirectives, _applyVeoScope, assignFinalSceneIndices, partitionTrackMembership };

// Run when this file is the ENTRY POINT — true both for `node src/build-video.js`
// AND for `electron.exe src/build-video.js` (how main.js spawns it). Under
// Electron's full-app mode `require.main === module` is FALSE, so we also detect
// the entry via argv[1] === __filename. A test/tool that require()s this module
// for its helpers gets neither (and can force-skip with BUILD_VIDEO_NO_RUN=1).
const _isBuildEntry = (require.main === module)
    || (process.argv[1] && (() => { try { return path.resolve(process.argv[1]) === __filename; } catch (_) { return false; } })());
if (_isBuildEntry && process.env.BUILD_VIDEO_NO_RUN !== '1') {
    buildVideo().then(async () => {
        await cleanupStoryblocksDownloads();
        await _stopVisionGpuIfStarted();
        // Force-exit: some providers (Gemini/Vertex SDK, keep-alive HTTP agents)
        // keep the event loop alive after BUILD COMPLETE, so main.js's
        // child_process 'close' never fires and the UI hangs at "Build complete!"
        // with the Cancel button still visible. Flush logs and exit explicitly —
        // this is a CLI, not a server.
        setImmediate(() => process.exit(0));
    }).catch(async error => {
        console.error('\n❌ Build failed:', error.message);
        await cleanupStoryblocksDownloads();
        await _stopVisionGpuIfStarted();
        process.exit(1);
    });
}
