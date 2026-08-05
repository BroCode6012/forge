/**
 * scene-coverage.js — the one honest answer to "will this scene actually show
 * something?"
 *
 * WHY THIS EXISTS
 *
 * A build can leave a scene visually empty in three different ways, and before
 * this module each of them was invisible to a different check:
 *
 *   1. PLACEHOLDER. When every provider fails, the footage manager paints a
 *      generated card and stores it as the scene's media. The scene then has a
 *      `mediaFile`, so every `!scene.mediaFile` test in the codebase called it
 *      solved. It is not solved — it is a failure wearing a success's clothes.
 *
 *   2. ORPHANED GRAPHIC. A scene marked `fullscreenMG` is deliberately skipped
 *      during the media download, because the graphic IS the visual. If that
 *      graphic is later disabled (numeric-exclusivity guard, niche gate, an
 *      author or lint rejection), nothing puts footage back — the scene owns no
 *      media and no graphic, and it renders blank.
 *
 *   3. SKIPPED LANE. `mediaIntent.policy.download === 'skip'` scenes are
 *      excluded from the download set on the same assumption: something else
 *      will cover them. When that something else does not arrive, same result.
 *
 * The old final audit looked for `!scene.mediaFile && !scene.isMGScene &&
 * !scene.fullscreenMG` — which is blind to all three. Case 1 has a mediaFile;
 * cases 2 and 3 are excluded by the very flags that caused the problem. That is
 * how a build shipped eight empty scenes under a line reading "0 missing".
 *
 * Everything that wants to know whether a scene is covered asks THIS module, so
 * the audit and the rescue can never disagree about what "covered" means.
 */

'use strict';

/**
 * Media statuses that mean "we gave up and drew something". A scene in one of
 * these states has a file on disk and is still a failure.
 */
const PLACEHOLDER_STATUSES = new Set(['agenticGraphicFallback']);

/** Providers that only ever emit placeholders. */
const PLACEHOLDER_PROVIDERS = new Set(['agentic visual fallback']);

/**
 * Media statuses that mean "real footage, but won by a different scene".
 * `footage-borrow.js` hands a still-empty scene the closest-matching clip this
 * build already owns, at a different in-point. The scene IS covered — a real
 * clip is drawn — but calling it plain `footage` would let the audit line read
 * as though the media system found it, which is the exact dishonesty this
 * module exists to prevent. It gets its own kind so the count stays truthful.
 */
const BORROWED_STATUSES = new Set(['borrowedFromScene']);

const EPS = 0.05; // seconds of slop when testing time-window overlap

function _num(v, dflt = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
}

function _start(s) { return _num(s?.startTime, 0); }

function _end(s) {
    const e = _num(s?.endTime, NaN);
    if (Number.isFinite(e) && e > _start(s)) return e;
    return _start(s) + _num(s?.duration, 0);
}

/** True when `outer` covers essentially all of `inner`'s time on screen. */
function _covers(outer, inner) {
    const os = _start(outer);
    const oe = _end(outer);
    const is = _start(inner);
    const ie = _end(inner);
    if (!(oe > os) || !(ie > is)) return false;
    return os <= is + EPS && oe >= ie - EPS;
}

/**
 * Is this scene's media a real find, or the card we draw when we give up?
 * Exported because the footage manager needs the same answer while it is still
 * deciding what to record.
 */
function isPlaceholderMedia(scene) {
    if (!scene) return false;
    if (scene.agenticFallback === true) return true;
    if (PLACEHOLDER_STATUSES.has(String(scene.mediaDownloadStatus || ''))) return true;
    if (PLACEHOLDER_PROVIDERS.has(String(scene.sourceProvider || '').toLowerCase())) return true;
    return false;
}

/**
 * Is this scene showing footage another scene won? Exported so the borrow pass
 * can never build a donor bank that includes its own output — a borrow chain
 * would spread one clip across the whole video.
 */
function isBorrowedMedia(scene) {
    if (!scene) return false;
    if (BORROWED_STATUSES.has(String(scene.mediaDownloadStatus || ''))) return true;
    return scene.borrowedFromScene !== undefined && scene.borrowedFromScene !== null;
}

/**
 * Classify one scene.
 *
 * @param {object} scene
 * @param {object} [ctx]
 * @param {Array}  [ctx.graphics] every visual that can cover a scene's whole
 *        window on its own — fullscreen MG scenes and fullscreen template
 *        scenes. Pass the FINAL lists; a graphic that was disabled must not be
 *        in here, which is the entire point.
 * @returns {{covered:boolean, kind:string, reason:string}}
 *          kind: 'graphic' | 'graphic-owner' | 'footage' | 'borrowed'
 *              | 'placeholder' | 'orphaned-graphic' | 'skipped-lane' | 'none'
 */
function classifyScene(scene, ctx = {}) {
    if (!scene) return { covered: false, kind: 'none', reason: 'no scene' };

    // The scene IS a graphic (it lives on V3). It renders itself.
    if (scene.isMGScene || scene.isTemplateScene) {
        return { covered: true, kind: 'graphic', reason: 'scene is the graphic' };
    }

    // Real media beats everything else. Footage borrowed from another scene is
    // real media and really renders, so it is covered — but it is named apart
    // from `footage`, because the media system did NOT find it for this scene
    // and an audit that blurred the two would hide exactly how much of the
    // video is reuse.
    if (scene.mediaFile && !isPlaceholderMedia(scene)) {
        if (isBorrowedMedia(scene)) {
            const from = scene.borrowedFromScene;
            return {
                covered: true,
                kind: 'borrowed',
                reason: `reusing scene ${from ?? '?'}'s ${String(scene.sourceProvider || 'media')} clip at a different in-point`,
            };
        }
        return { covered: true, kind: 'footage', reason: String(scene.sourceProvider || 'media') };
    }

    // A fullscreen graphic may be standing in front of this scene. Only a
    // graphic that survived to the FINAL list counts.
    const graphics = Array.isArray(ctx.graphics) ? ctx.graphics : null;
    if (graphics && graphics.length > 0) {
        for (const g of graphics) {
            if (!g || g.disabled) continue;
            if (_covers(g, scene)) {
                return {
                    covered: true,
                    kind: 'graphic-owner',
                    reason: `covered by ${g.type || 'fullscreen graphic'}`,
                };
            }
        }
    }

    // Nothing is covering it. Say precisely why, because the three causes need
    // different repairs and the log is how the user finds out.
    if (scene.mediaFile && isPlaceholderMedia(scene)) {
        return {
            covered: false,
            kind: 'placeholder',
            reason: 'media is a generated give-up card, not real footage',
        };
    }
    if (scene.fullscreenMG) {
        return {
            covered: false,
            kind: 'orphaned-graphic',
            reason: `planned as fullscreen "${String(scene.fullscreenMG).split(':')[0].trim()}" but no graphic survived to cover it`,
        };
    }
    if (scene.mediaIntent?.policy?.download === 'skip') {
        return {
            covered: false,
            kind: 'skipped-lane',
            reason: `download was skipped for lane "${scene.mediaIntent?.lane || 'unknown'}" and nothing filled it`,
        };
    }
    return { covered: false, kind: 'none', reason: 'no media and no graphic' };
}

/**
 * One entry per real scene, in the order given.
 *
 * The sweep's universe is assembled by concatenating lists (on-track scenes,
 * then off-track ones), and a scene that sits in more than one of them arrives
 * twice. That is invisible in a count but expensive in a rescue: the 2026-07-31
 * build spent two of its nine rescue slots re-searching scenes 1 and 56 for the
 * second time — roughly seven minutes buying nothing, while shorter broken
 * scenes were dropped for lack of a slot.
 *
 * Identity is checked first (the same object twice is unambiguous). A scene
 * number is then used as a secondary key, because a scene can be re-wrapped
 * upstream and still be the same beat on the timeline. The FIRST copy wins: the
 * lists are concatenated on-track first, and the on-track copy is the one the
 * renderer will actually draw.
 */
function _uniqueScenes(list) {
    const out = [];
    const seenObjects = new Set();
    const seenNumbers = new Set();
    for (const scene of (Array.isArray(list) ? list : [])) {
        if (!scene) continue;
        if (seenObjects.has(scene)) continue;
        const no = Number(scene.index);
        if (Number.isFinite(no)) {
            if (seenNumbers.has(no)) continue;
            seenNumbers.add(no);
        }
        seenObjects.add(scene);
        out.push(scene);
    }
    return out;
}

/**
 * Every scene that will render blank (or render an apology card), with the
 * reason attached. Returns `{scene, index, kind, reason}` so a caller can act
 * without re-deriving anything.
 */
function findUncovered(scenes, ctx = {}) {
    const out = [];
    const list = _uniqueScenes(scenes);
    for (let i = 0; i < list.length; i++) {
        const scene = list[i];
        const verdict = classifyScene(scene, ctx);
        if (verdict.covered) continue;
        out.push({ scene, index: Number.isFinite(Number(scene.index)) ? Number(scene.index) : i, kind: verdict.kind, reason: verdict.reason });
    }
    return out;
}

/** Counts for logging: how many scenes are covered, and by what. */
function summarize(scenes, ctx = {}) {
    const counts = {
        total: 0, covered: 0, uncovered: 0,
        footage: 0, borrowed: 0, graphic: 0, graphicOwner: 0,
        placeholder: 0, orphanedGraphic: 0, skippedLane: 0, none: 0,
    };
    const KEY = {
        footage: 'footage', borrowed: 'borrowed',
        graphic: 'graphic', 'graphic-owner': 'graphicOwner',
        placeholder: 'placeholder', 'orphaned-graphic': 'orphanedGraphic',
        'skipped-lane': 'skippedLane', none: 'none',
    };
    // Same de-duplication as the sweep, for the same reason: the audit line and
    // the rescue must never be able to disagree about how many scenes there are.
    for (const scene of _uniqueScenes(scenes)) {
        counts.total++;
        const v = classifyScene(scene, ctx);
        counts[v.covered ? 'covered' : 'uncovered']++;
        const key = KEY[v.kind];
        if (key) counts[key]++;
    }
    return counts;
}

module.exports = {
    classifyScene,
    findUncovered,
    summarize,
    isPlaceholderMedia,
    isBorrowedMedia,
    PLACEHOLDER_STATUSES,
    BORROWED_STATUSES,
};
