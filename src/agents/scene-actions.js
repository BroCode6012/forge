/**
 * scene-actions.js — per-scene, on-demand actions invoked from the timeline
 * right-click menu (single scene or a batch of highlighted scenes).
 *
 * These reuse the SAME building blocks as the full build pipeline:
 *   - Retry footage  → Media Agent (fresh plan) → footage download → swap the file
 *                      (src/media-agent.js + src/qa-replacer.js)
 *   - CEO edit       → editor-agent CEO + its workers (src/editor-agent/ceo.js)
 *
 * Nothing here re-runs the Director/VP — it operates on the existing build's
 * scenes + scriptContext, exactly like a resume.
 */

const { buildMediaAgentPlan, getMediaAgentQueries } = require('../media/media-agent');
const { applyRetrievabilityRescue } = require('../media/retrievability-rescue');
const { replaceSceneMedia } = require('../studio/qa-replacer');
const { editOneScene } = require('./ceo');
const { applyOrderToScene } = require('../directives/directive-actuator');

function _sceneDurationSec(scene) {
    const d = (Number(scene?.endTime) - Number(scene?.startTime));
    if (Number.isFinite(d) && d > 0.5 && d < 120) return Math.round(d);
    return 8;
}

function _normalizeMediaType(value) {
    const type = String(value || '').trim().toLowerCase();
    return type === 'image' || type === 'video' ? type : '';
}

function _isAgenticFallbackScene(scene) {
    const status = String(scene?.mediaDownloadStatus || '').toLowerCase();
    const provider = String(scene?.sourceProvider || '').toLowerCase();
    return status === 'agenticgraphicfallback'
        || provider.includes('agentic visual fallback');
}

function _resolveRetryMediaType(scene) {
    const current = _normalizeMediaType(scene?.mediaType) || 'video';
    if (!_isAgenticFallbackScene(scene)) return current;

    // Agentic fallback plates are always PNGs, so the downloader overwrites the
    // scene's mediaType with "image". For a manual retry, recover the planner's
    // original request instead of searching for another still image.
    const planned = [
        scene?._aiChose?.mediaType,
        scene?.mediaIntent?.requestedMediaType,
        scene?.mediaIntent?.requestedType,
        scene?.mediaIntent?.preferredMediaType,
        scene?.mediaIntent?.preferredType,
        scene?.mediaIntent?.mediaType,
    ].map(_normalizeMediaType).find(Boolean);

    return planned || current;
}

function _snapshotMediaState(scene) {
    const fields = [
        'mediaFile', 'mediaPath', 'assetFile', 'assetPath',
        'mediaExtension', 'mediaType', 'sourceProvider', 'sourceHint',
        'mediaDownloadStatus', 'visionScore', 'mediaWidth', 'mediaHeight',
        'aspectRatio', 'isVertical',
    ];
    return Object.fromEntries(fields.map((field) => [
        field,
        Object.prototype.hasOwnProperty.call(scene || {}, field)
            ? { present: true, value: scene[field] }
            : { present: false },
    ]));
}

function _restoreMediaState(scene, snapshot) {
    if (!scene || !snapshot) return;
    for (const [field, saved] of Object.entries(snapshot)) {
        if (saved.present) scene[field] = saved.value;
        else delete scene[field];
    }
}

function _resetRetryDiagnostics(scene) {
    if (!scene) return;
    scene.mediaDiagnostics = {
        planner: {},
        intent: scene.mediaIntent || null,
        mediaAgent: null,
        hunter: null,
        providers: [],
        final: null,
        retry: true,
        startedAt: new Date().toISOString(),
    };
}

/**
 * Retry finding + downloading this scene's asset with a FRESH Media Agent plan
 * (new keywords/queries), then replace the scene asset. Normal scenes keep their
 * current media type; agentic fallback PNGs recover the planner's original type.
 *
 * @param {Object} scene          — scene object from video-plan.json
 * @param {Object} scriptContext  — the build's scriptContext
 * @param {Object} opts           — { mediaFilePath (absolute), onProgress }
 * @returns {Promise<{success:boolean, error?:string, keyword?:string, mediaType?:string, sourceHint?:string, visionScore?:number, mediaFile?:string}>}
 */
async function retrySceneMedia(scene, scriptContext = {}, opts = {}) {
    const log = opts.onProgress || (() => {});
    const mediaFile = opts.mediaFilePath;
    if (!scene) return { success: false, error: 'no scene supplied' };
    if (!mediaFile) return { success: false, error: 'no media file path resolved for this scene' };

    const originalMediaState = _snapshotMediaState(scene);
    const currentMediaType = _normalizeMediaType(scene.mediaType) || 'video';
    const mediaType = _resolveRetryMediaType(scene);
    if (mediaType !== currentMediaType) {
        log(`Restoring planner media type for retry: ${currentMediaType} fallback → ${mediaType}`);
    }
    scene.mediaType = mediaType;
    _resetRetryDiagnostics(scene);

    // Reset the STALE per-scene budget. The scene still carries `_deadlineAt` from the
    // ORIGINAL build run — a timestamp now in the past — so the downloader reports
    // "Scene deadline: 0s left" and skips every provider BEFORE any search or vision
    // scoring runs (this is why retry "failed really fast"). A manual retry gets a fresh,
    // generous budget so it actually searches all providers and scores candidates.
    const retryBudgetMs = Math.max(60_000, parseInt(process.env.RETRY_SCENE_BUDGET_MS || '', 10) || (mediaType === 'image' ? 240_000 : 360_000));
    delete scene._aborted;
    delete scene._abortSignal;
    delete scene._timeoutFired;
    delete scene._inFlightCandidate;
    delete scene._inFlightCandidateReason;
    delete scene._inFlightCandidateReasons;
    delete scene._inFlightCandidateCount;
    delete scene._inFlightCandidateSince;
    scene._deadlineAt = Date.now() + retryBudgetMs;
    scene._maxDeadlineAt = scene._deadlineAt;
    log(`Fresh retry budget: ${Math.round(retryBudgetMs / 1000)}s (was stale/expired)`);

    // STEP 1 — the SAME broaden brain the real build runs (build-orchestrator step 4.8).
    // If the scene's visual intent is un-findable (proprietary / meta / hyper-specific /
    // exact-archival like "1950s backstage dressing room"), this rewrites it into a
    // findable, context-honest B-roll phrase ("1960s Hollywood theater") and unlocks stock.
    // Reused verbatim from the media system — NOT retry-only logic — so the real build and
    // the retry stay identical. Disable globally with RETRIEVABILITY_RESCUE=off.
    try {
        const rescue = await applyRetrievabilityRescue([scene], scriptContext);
        if (rescue?.changes?.length) {
            log(`Broadened: ${rescue.changes[0]}`);
        }
    } catch (e) {
        log(`Searchability broaden skipped (${e.message})`);
    }

    // Force a fresh plan — drop the cached one so the Media Agent re-derives queries
    // (now from the possibly-rescued, broadened scene query).
    delete scene._mediaAgentPlan;
    delete scene._sceneEntityPlan;

    log('Re-planning with Media Agent…');
    let plan = null;
    try {
        plan = await buildMediaAgentPlan(scene, scriptContext, { mediaType, sourceHint: scene.sourceHint || '' });
    } catch (e) {
        log(`Media Agent plan failed (${e.message}); falling back to scene keyword`);
    }

    const providerKey = mediaType === 'image' ? 'bing' : 'youtube';
    const queries = plan ? getMediaAgentQueries(plan, providerKey, 4) : [];
    const keyword = (queries[0]
        || scene.searchKeyword
        || scene.keyword
        || String(scene.text || '').split(/[.,;]/)[0].trim().split(/\s+/).slice(0, 8).join(' ')
        || '').trim();
    const sourceHint = plan?.sourceHint || scene.sourceHint || '';

    if (!keyword) return { success: false, error: 'could not derive a search keyword for this scene' };

    log(`Retry "${keyword}" (${mediaType}${sourceHint ? ', ' + sourceHint : ''})…`);
    const result = await replaceSceneMedia({
        mediaFile,
        keyword,
        sourceHint,
        mediaType,
        sceneDuration: _sceneDurationSec(scene),
        scriptContext,
        scene, // give the download pipeline the real scene (context + avoids null-deref)
        onProgress: log,
        allowExtensionChange: true,
    });

    if (!result?.success) {
        _restoreMediaState(scene, originalMediaState);
    } else {
        scene.keyword = keyword;
        scene.searchKeyword = keyword;
        if (sourceHint) scene.sourceHint = sourceHint;
    }

    // Forward the formatted per-scene MEDIA REPORT (candidates, scores, links, winner) to
    // the caller's log sink so it lands in the in-app Media Log panel, not just the console.
    try {
        const lines = scene.mediaDiagnostics?.reportLines;
        if (Array.isArray(lines)) for (const ln of lines) log(ln);
    } catch (_) {}

    return {
        ...result,
        keyword,
        sourceHint,
        mediaType: _normalizeMediaType(scene.mediaType) || mediaType,
        mediaFile: result?.newFile || mediaFile,
        scene,
    };
}

/**
 * Run a CEO-editor action on this scene. The CEO sequences its workers.
 * Phase 1 wires the framing worker (re-frame); other worker actions are added
 * here in Phase 2 (templates, motion-graphics, explainer-images, map-assets,
 * transitions) + free-text instruction interpretation.
 *
 * @param {string} action        — 'reframe' | 'template' | 'mg' | 'explainer' | 'map' | 'transition' | 'instruction'
 * @param {Object} scene
 * @param {Object} scriptContext
 * @param {number} idx           — scene index within allScenes
 * @param {Array}  allScenes     — full scenes array (workers need neighbours)
 * @param {Object} opts          — { instruction, onProgress }
 * @returns {Promise<{success:boolean, error?:string, scene?:Object, change?:string}>}
 */
async function ceoEditScene(action, scene, scriptContext = {}, idx = 0, allScenes = [], opts = {}) {
    const log = opts.onProgress || (() => {});
    if (!scene) return { success: false, error: 'no scene supplied' };

    try {
        switch (action) {
            case 'reframe': {
                log('CEO → framing worker…');
                const res = await editOneScene(scene, scriptContext, idx, allScenes, opts);
                if (res?.error) return { success: false, error: res.error };
                if (res?.skipped) return { success: false, error: res.skipped };
                const fr = res?.framing?.framing || res?.scene?.framing || 'unchanged';
                return { success: true, scene: res.scene || scene, change: `framing → ${fr}` };
            }
            case 'transition': {
                // Direct param action from the acting agent: set the scene's transition.
                const type = String(opts.type || opts.params?.type || 'cut').trim();
                scene.transition = { type, duration: type === 'cut' ? 0 : Number(opts.duration || opts.params?.duration) || 0.5 };
                scene._txDirected = true;
                if (!Array.isArray(scene._directiveLock)) scene._directiveLock = [];
                if (!scene._directiveLock.includes('transition')) scene._directiveLock.push('transition');
                return { success: true, scene, change: `transition → ${type}` };
            }
            case 'effect': {
                // noGrain / grade on this scene (merged by the FX director at render-prep).
                const p = opts.params || opts;
                scene._directiveEffect = { ...(scene._directiveEffect || {}), ...(p.noGrain ? { noGrain: true } : {}), ...(p.grade ? { grade: p.grade } : {}) };
                if (p.noGrain && Array.isArray(scene._effectRecipe)) {
                    scene._effectRecipe = scene._effectRecipe.filter(e => !['grain', 'dust', 'vhsband', 'staticNoise', 'flicker', 'scanlines'].includes(e && e.id));
                }
                return { success: true, scene, change: `effect → ${Object.keys(scene._directiveEffect).join(', ')}` };
            }
            case 'instruction': {
                // Free-text order on this scene → compile via the directive actuator
                // and apply its slices to this one scene (reuses the build-time contract).
                log('Interpreting instruction…');
                const res = await applyOrderToScene(scene, opts.instruction || '', scriptContext, { log });
                return res;
            }
            // Batch-only workers (template/mg/explainer/map) run in the whole-plan
            // acting path (qa-apply-order IPC), not per single scene here.
            case 'template':
            case 'mg':
            case 'explainer':
            case 'map':
                return { success: false, error: `"${action}" runs via the whole-video chat order, not a single-scene action` };
            default:
                return { success: false, error: `unknown CEO action: ${action}` };
        }
    } catch (err) {
        return { success: false, error: err?.message || String(err) };
    }
}

module.exports = { retrySceneMedia, ceoEditScene, _resolveRetryMediaType };
