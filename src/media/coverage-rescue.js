/**
 * coverage-rescue.js — the road back for a scene that ended up with nothing.
 *
 * WHY THIS EXISTS
 *
 * Three things can leave a scene visually empty, and none of them had a repair
 * path (see `scene-coverage.js` for how each is detected):
 *
 *   - every provider missed and we drew a placeholder card;
 *   - the scene was skipped during the download because a fullscreen graphic was
 *     going to cover it, and that graphic was later disabled;
 *   - the scene's lane was marked `download: 'skip'` and nothing filled it.
 *
 * In all three the build simply carried on. This module sends those scenes back
 * out to look for footage — through the REAL media system, not a shortcut, so
 * every improvement to the downloader benefits the rescue automatically.
 *
 * WHY THE SECOND ATTEMPT IS BETTER THAN THE FIRST
 *
 * A retry that repeats the first attempt is worth nothing. This one differs in
 * two ways, and both are per-topic rather than a fixed rule:
 *
 *   1. IT RUNS ON EVIDENCE. By the time the sweep fires, the whole build has
 *      happened. `provider-scoreboard.js` knows which sources actually won
 *      scenes in THIS video, and the topic's own ranking still applies
 *      underneath. A news video that kept winning on YouTube rescues from
 *      YouTube first; a nature video that kept winning on stock rescues from
 *      stock first. Same code, opposite order, because the run taught it.
 *
 *   2. IT DROPS THE CONSTRAINT THAT FAILED. The first pass honours the
 *      planner's lane ("this scene is stock", "this scene is a web image").
 *      That lane is exactly what came back empty. The rescue's job is coverage,
 *      so it opens every source. A locked lane is a preference; a blank scene
 *      is a defect, and the defect wins.
 *
 * The time budget is measured, not declared: it comes from the same adaptive
 * patience the run has been calibrating all along, so a fast network rescues
 * more scenes and a slow one still finishes.
 */

'use strict';

const patience = require('./download-patience');
const { classifyScene, findUncovered } = require('./scene-coverage');

/** How many candidate attempts' worth of time each rescued scene gets. */
const ATTEMPTS_PER_SCENE = 3;

/** Rails on the budget so one pathological measurement cannot run away. */
const SCENE_BUDGET_FLOOR_MS = 45_000;
const SCENE_BUDGET_CEILING_MS = 240_000;

/**
 * With many broken scenes it is better to rescue several than to perfect one.
 * Anything past this keeps its placeholder card — which is still a picture, not
 * a blank, and is now honestly reported as a failure.
 */
const MAX_SCENES_PER_SWEEP = 12;

function _firstUsable(...values) {
    for (const v of values) {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s && !/^(none|null|undefined|n\/a)$/i.test(s)) return s;
    }
    return '';
}

function _duration(scene) {
    const span = Number(scene?.endTime || 0) - Number(scene?.startTime || 0);
    if (Number.isFinite(span) && span > 0) return span;
    return Number(scene?.duration) || 0;
}

/**
 * The per-scene time budget, derived from what THIS run measured for this media
 * type. Not a constant — a slow network or an expensive topic gets more, a fast
 * one gets less.
 */
function _sceneBudgetMs(scene, nicheId) {
    const mediaType = scene?.mediaType === 'image' ? 'image' : 'video';
    let per = 0;
    try {
        const p = patience.resolveCandidatePatienceMs({
            mediaType,
            // No provider yet — we want the topic's baseline, not one source's.
            providerKey: null,
            nicheId,
            remainingSceneMs: Infinity,
        });
        // `disabled` means an env var switched per-candidate patience off. That
        // is a statement about single downloads, not about how long a rescue may
        // run, so fall through to the bootstrap rather than inheriting "forever".
        per = p && !p.disabled ? Number(p.ms) || 0 : 0;
    } catch {
        per = 0;
    }
    if (!(per > 0)) per = patience.BOOTSTRAP_MS?.[mediaType] || 60_000;
    return Math.max(SCENE_BUDGET_FLOOR_MS, Math.min(SCENE_BUDGET_CEILING_MS, per * ATTEMPTS_PER_SCENE));
}

/**
 * Put a broken scene into a state the downloader can actually work with, and
 * remember exactly what we changed so a failed rescue can be undone.
 */
function _prepareForRescue(scene, kind) {
    const restore = {
        fullscreenMG: scene.fullscreenMG,
        mediaFile: scene.mediaFile,
        mediaExtension: scene.mediaExtension,
        sourceProvider: scene.sourceProvider,
        mediaType: scene.mediaType,
        mediaWidth: scene.mediaWidth,
        mediaHeight: scene.mediaHeight,
        mediaDownloadStatus: scene.mediaDownloadStatus,
        agenticFallback: scene.agenticFallback,
        mediaIntent: scene.mediaIntent,
        keyword: scene.keyword,
        _aborted: scene._aborted,
    };

    // The graphic that was going to cover this scene is gone. Leaving the marker
    // set makes every downstream stage keep treating it as a graphic scene —
    // framing skips it, the V1 carve skips it — so footage we find now would
    // never actually be shown.
    if (kind === 'orphaned-graphic') scene.fullscreenMG = null;

    // Drop the placeholder so nothing mistakes it for a real find mid-rescue.
    // Put back verbatim if the rescue also comes back empty.
    scene.mediaFile = null;
    scene.sourceProvider = null;
    scene.mediaWidth = 0;
    scene.mediaHeight = 0;
    scene.mediaDownloadStatus = null;
    scene.agenticFallback = false;
    scene._aborted = false;

    // Open every source. The lane that was locked is the lane that failed.
    // A map image is the one exception: its asset is generated, not searched,
    // and opening it to stock would put a random photo where a map belongs.
    const priorLane = scene.mediaIntent?.lane || null;
    const keepLane = priorLane === 'mapImage';
    scene.mediaIntent = {
        ...(scene.mediaIntent || {}),
        lane: keepLane ? priorLane : 'coverageRescue',
        policy: {
            ...(scene.mediaIntent?.policy || {}),
            download: 'require',
            allowProviderFallback: true,
            allowStockFallback: true,
            ...(keepLane ? {} : { allowedSources: undefined, allowedSourcesByType: undefined }),
        },
    };

    // A scene that was never meant to download may have no searchable keyword —
    // its `visualIntent` describes a treatment, not a subject. Prefer the clean
    // footage-query fields the planner already wrote.
    scene.keyword = _firstUsable(
        scene.keyword,
        scene.searchKeyword,
        scene.templateBgQuery,
        scene.bgQuery,
        scene.stockQuery,
        scene.webQuery,
        scene.visualIntent,
        typeof scene.text === 'string' ? scene.text.split(/[.!?]/)[0] : '',
    );

    // A rescue with no subject is worse than a placeholder — it would download
    // something arbitrary. The caller drops these rather than guessing.
    if (!scene.keyword) {
        _rollback(scene, restore);
        return null;
    }

    if (!scene.mediaType || scene.mediaType === 'motion-graphic') scene.mediaType = 'video';

    return restore;
}

function _rollback(scene, restore) {
    if (!scene || !restore) return;
    for (const [k, v] of Object.entries(restore)) {
        if (v === undefined) delete scene[k];
        else scene[k] = v;
    }
}

/**
 * Find every uncovered scene and try to fill it with real footage.
 *
 * @param {object} args
 * @param {Array}  args.scenes    the base (V1) scenes
 * @param {Array}  args.graphics  the FINAL fullscreen graphics + template scenes.
 *        A graphic that was disabled must not be in this list — that a disabled
 *        graphic still counted as coverage is one of the three original defects.
 * @param {object} args.scriptContext
 * @param {string} [args.nicheId]
 * @param {Function} args.downloadAllMedia  injected, so this module never has to
 *        pull in the 10k-line footage manager at load time and the verify
 *        harness can drive it without a network.
 * @param {object} [args.log] {info,warn,ok,dim} — defaults to console.log
 * @returns {Promise<{attempted:number, rescued:number, stillBroken:Array,
 *                    skipped:number, uncovered:number, byKind:object}>}
 */
async function rescueUncovered({ scenes, graphics, scriptContext, nicheId, downloadAllMedia, log } = {}) {
    const out = { attempted: 0, rescued: 0, stillBroken: [], skipped: 0, uncovered: 0, byKind: {} };
    const say = typeof log === 'function' ? log : null;
    const L = {
        info: say || log?.info || console.log,
        warn: say || log?.warn || console.log,
        ok: say || log?.ok || console.log,
        dim: say || log?.dim || console.log,
    };

    const ctx = { graphics };
    const uncovered = findUncovered(scenes, ctx);
    out.uncovered = uncovered.length;
    if (uncovered.length === 0) return out;

    out.byKind = uncovered.reduce((acc, u) => { acc[u.kind] = (acc[u.kind] || 0) + 1; return acc; }, {});
    L.warn(`Coverage sweep: ${uncovered.length} scene(s) would render with no real footage — `
        + Object.entries(out.byKind).map(([k, n]) => `${k}=${n}`).join(', '));
    for (const u of uncovered) {
        L.dim(`   scene ${u.scene?.index ?? u.index} (${_duration(u.scene).toFixed(1)}s): ${u.reason}`);
    }

    // Longest on screen first: a 15-second blank hurts far more than a 1.5-second
    // one, so if the sweep has to stop short it stops on the least damage.
    const ordered = [...uncovered].sort((a, b) => _duration(b.scene) - _duration(a.scene));
    if (ordered.length > MAX_SCENES_PER_SWEEP) {
        out.skipped = ordered.length - MAX_SCENES_PER_SWEEP;
        L.warn(`   rescuing the ${MAX_SCENES_PER_SWEEP} longest; ${out.skipped} shorter scene(s) keep their placeholder card`);
    }
    const shortlist = ordered.slice(0, MAX_SCENES_PER_SWEEP);

    if (typeof downloadAllMedia !== 'function') {
        L.warn('   coverage rescue unavailable (no downloader supplied) — scenes keep their placeholder');
        out.stillBroken = shortlist.map(t => t.scene);
        return out;
    }

    // Prepare, remembering how to undo each one.
    const prepared = [];
    for (const target of shortlist) {
        const restore = _prepareForRescue(target.scene, target.kind);
        if (!restore) {
            L.warn(`   scene ${target.scene?.index ?? target.index} has no searchable subject — leaving it as is`);
            out.stillBroken.push(target.scene);
            continue;
        }
        prepared.push({ ...target, restore });
    }
    if (prepared.length === 0) return out;

    out.attempted = prepared.length;
    const budgetMs = Math.max(...prepared.map(p => _sceneBudgetMs(p.scene, nicheId)));
    L.info(`   ↻ re-searching ${prepared.length} scene(s) with every source open, `
        + `${Math.round(budgetMs / 1000)}s each: `
        + prepared.map(p => `${p.scene.index ?? p.index}="${p.scene.keyword}"`).join(', '));

    try {
        await downloadAllMedia(prepared.map(p => p.scene), scriptContext, {
            label: 'coverage rescue',
            sceneTimeoutMs: budgetMs,
            // MUST preserve: the media cache carries this run's used-URL, used-hash
            // and used-description sets. Clearing them would let the rescue hand a
            // scene the exact clip another scene is already showing.
            preserveCache: true,
        });
    } catch (err) {
        L.warn(`   coverage rescue pass errored: ${err?.message || err}`);
    }

    // Re-ask the SAME question that flagged them. There is no second definition
    // of success anywhere — that is why this module and the audit cannot drift.
    for (const p of prepared) {
        const scene = p.scene;
        const sceneNo = scene?.index ?? p.index;
        const verdict = classifyScene(scene, ctx);
        if (verdict.covered && verdict.kind === 'footage') {
            out.rescued++;
            L.ok(`   ✓ scene ${sceneNo} rescued → ${scene.sourceProvider}`);
            continue;
        }
        // Never leave a scene worse off than we found it. If the rescue came back
        // with nothing at all, the original placeholder goes back exactly as it
        // was; if it produced a fresh placeholder, that one stands.
        if (!scene.mediaFile) _rollback(scene, p.restore);
        else if (p.kind === 'orphaned-graphic') scene.fullscreenMG = null;
        out.stillBroken.push(scene);
        L.warn(`   ✗ scene ${sceneNo} still has no real footage (${verdict.reason})`);
    }

    if (out.rescued > 0) {
        L.ok(`Coverage sweep rescued ${out.rescued}/${out.attempted} scene(s) with real footage`);
    }
    if (out.stillBroken.length > 0) {
        L.warn(`${out.stillBroken.length} scene(s) still have no real footage — `
            + `they render a placeholder card and are reported as failures, not as ready`);
    }
    return out;
}

module.exports = {
    rescueUncovered,
    ATTEMPTS_PER_SCENE,
    MAX_SCENES_PER_SWEEP,
    SCENE_BUDGET_FLOOR_MS,
    SCENE_BUDGET_CEILING_MS,
    // exported for the verify harness
    _sceneBudgetMs,
    _prepareForRescue,
};
