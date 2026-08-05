'use strict';

/**
 * PACKAGING INTENT — "is the packaging the thing we asked for?"
 *
 * The downloader runs most video scenes in `strictRaw` mode: clean real-world
 * B-roll only, no news graphics, no burned-in text, no presenter talking to
 * camera. That is the right default for a faceless video, and it stays.
 *
 * What it got wrong is the case where the scene's OWN request is a graphic.
 * Jul-29 build, scene 59 — the Media Agent's mission for that scene read:
 *
 *     query      : "earth tube diagram cross section"
 *     must show  : "earth tube diagram", "Temperature indicators", "Soil layers",
 *                  "Animation of airflow"
 *
 * The race found this, on the first batch:
 *
 *     "Cross-section diagram shows air entering above ground, cooling
 *      underground, with temperature indicators and soil layers."  → 7/10
 *
 * That is the brief, satisfied line for line. The strict-raw gate then demoted
 * it for being "a packaged graphic", it landed under the accept floor, and the
 * scene finished the build with NO MEDIA AT ALL. We asked for a diagram,
 * deleted the word "diagram" from the search, and then punished the result for
 * being a diagram.
 *
 * ── Why this is topic-adaptive and not a niche rule ──────────────────────────
 * There is no niche list here and no `if (niche === ...)`. The question asked is
 * per-scene and answered from data the pipeline already produced for THAT scene:
 * the live search query, the planner's full visual intent, and the Media Agent's
 * own must-show list. A DIY explainer whose scene asks for a cutaway gets the
 * relief; the very next scene in the same video, asking for "excavated clay pipe
 * trench", does not. Same code, opposite answer, decided by the scene.
 *
 * The third input is evidence collected DURING the run: if this build keeps
 * looking at strict-raw candidates and essentially never sees a clean one, then
 * clean raw footage is not retrievable for this topic, and holding the same bar
 * only produces empty scenes. The penalty softens by a point, then two. A nature
 * build never triggers it (clean footage is everywhere); a technical explainer
 * does. Learned from the run, not declared in a table.
 *
 * ── What is deliberately NOT read as evidence ────────────────────────────────
 * The narration, `templateHint` and `fullscreenMG`. Those describe the OVERLAY
 * the renderer will draw on top, not the footage to download — a scene whose
 * narration says "the chart shows" still wants real footage underneath. That
 * distinction is exactly why `_isGraphicScene` in media-hunter.js cannot be
 * reused here: it reads narration, so it fires on scenes that only *mention* a
 * graphic. This module reads only fields that state WHAT TO FETCH.
 *
 * Module-level state = one build child process, like provider-scoreboard.js.
 * Nothing persists across builds on purpose.
 */

/**
 * Artifact vocabulary, keyed to the same three buckets `classifyStrictRawVisual`
 * already returns, so a request and a verdict are directly comparable.
 *
 * These are not "niche words" — they name the packaging LAYER a clip carries
 * (drawn explanation / burned-in text / person addressing camera). They mean the
 * same thing in a crime video and a cooking video.
 */
const ARTIFACT_RE = {
    graphic: /\b(diagram|diagrams|diagrammatic|schematic|schematics|cross[-\s]?section(?:al|s)?|cutaway|blueprint|blueprints|floor\s?plan|exploded\s+view|infographic|infographics|chart|charts|graph|graphs|graphed|plotted|map|maps|illustration|illustrations|illustrated|animation|animated|rendering|3d\s+render|simulation|visualization|visualisation)\b/i,
    text: /\b(caption|captions|subtitle|subtitles|lower\s+third|headline|headlines|title\s+card|text\s+overlay|labeled|labelled|labels?|annotated|annotation|annotations|callout|callouts|legend)\b/i,
    presenter: /\b(presenter|host|anchor|spokesperson|talking\s+head|piece\s+to\s+camera|to\s+camera|interview|interviewee|testimonial|demonstrator)\b/i,
};

const KINDS = ['graphic', 'text', 'presenter'];

/**
 * Severity of each packaging layer for a scene that did NOT ask for it.
 *
 * A presenter is the worst: a face addressing the lens is the one thing a
 * faceless video cannot use at all. A drawn explanation is a real miss but still
 * on-topic. Burned-in text is the mildest — most of it sits in a corner and gets
 * covered or cropped.
 */
const BUCKET_WEIGHT = { presenter: 4, graphic: 2, text: 1 };

/** Below this many strict-raw observations, the run has not learned anything yet. */
const MIN_LEARN_OBSERVATIONS = 8;
/** Second relief tier needs roughly double the evidence. */
const STRONG_LEARN_OBSERVATIONS = 16;

function _str(v) {
    return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function _collect(list, out) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
        const s = _str(item).trim();
        if (s) out.push(s);
    }
}

/**
 * Did THIS scene's own request ask for packaging?
 *
 * Evidence is read only from fields that state what to fetch:
 *   • the live search query (what we are literally typing into the provider),
 *   • the planner's full visual intent for the scene,
 *   • the Media Agent's must-show / mandatory-visible / subject-anchor list.
 *
 * One such source is enough. If the string we are searching with says "diagram",
 * the downloader is hunting a diagram, and demoting the diagram it finds is
 * incoherent no matter how many other fields stay silent.
 *
 * `opts.ignoreQuery` drops source group 1 (the query itself). Callers that are
 * EDITING the query must pass it, otherwise the query is its own justification
 * for keeping its own words and the edit can never fire. Callers that are
 * JUDGING a downloaded clip should leave it off: by then the query is a
 * statement of what the run went looking for.
 *
 * @returns {{graphic:boolean,text:boolean,presenter:boolean,kinds:string[],evidence:string[]}}
 */
function detectRequestedPackaging(input = {}) {
    const scene = input.scene || null;
    const mediaHunter = input.mediaHunter || scene?._mediaHunterProfile || null;
    const agentPlan = input.agentPlan || mediaHunter?.agentPlan || scene?._mediaAgentPlan || null;

    const sources = [];
    // 1. what we are searching with, right now
    if (!input.ignoreQuery) {
        _collect([
            input.keyword,
            scene?._forcedSearchKeyword,
            scene?.searchKeyword,
            scene?.stockQuery,
            scene?.webQuery,
            scene?.keyword,
        ], sources);
    }
    // 2. the planner's full, untrimmed statement of the shot
    _collect([input.visualIntent, scene?.visualIntent, scene?.visualDescription], sources);
    // 3. the Media Agent's explicit "this must be visible" list
    _collect(agentPlan?.mustShow, sources);
    _collect(agentPlan?.mandatoryVisible, sources);
    _collect(agentPlan?.subjectAnchors, sources);
    _collect(agentPlan?.niceToShow, sources);
    _collect(mediaHunter?.mandatoryVisible, sources);
    _collect(mediaHunter?.prefer, sources);

    const found = { graphic: false, text: false, presenter: false };
    const evidence = [];
    for (const src of sources) {
        for (const kind of KINDS) {
            if (found[kind]) continue;
            if (ARTIFACT_RE[kind].test(src)) {
                found[kind] = true;
                evidence.push(`${kind}:"${src.slice(0, 60)}"`);
            }
        }
    }

    // A drawn explanation carries its own labels — dimensions, temperatures,
    // layer names. Asking for the diagram and then rejecting it for having
    // writing on it is the same self-defeating loop one level down.
    if (found.graphic) found.text = true;

    return {
        ...found,
        kinds: KINDS.filter(k => found[k]),
        evidence: evidence.slice(0, 4),
    };
}

/**
 * Which packaging complaints survive once the request is taken into account.
 * Anything the scene explicitly asked for stops being a defect.
 */
function survivingBuckets(buckets, requested) {
    const list = Array.isArray(buckets) ? buckets : [];
    if (!requested) return [...new Set(list)];
    return [...new Set(list)].filter(b => !requested[b]);
}

// ── In-run evidence: is clean raw footage even findable for this topic? ────────
let _observations = 0;
let _cleanObservations = 0;

/**
 * Record one strict-raw candidate the gate looked at.
 * @param {boolean} packaged true when the clip tripped the packaging classifier
 */
function noteGateObservation(packaged) {
    _observations++;
    if (!packaged) _cleanObservations++;
}

/**
 * How many points to shave off the packaging penalty because THIS build has
 * shown that clean raw footage is not retrievable for THIS topic.
 * 0 until there is enough evidence to be sure it is the topic and not luck.
 */
function packagingRelief() {
    if (_observations < MIN_LEARN_OBSERVATIONS) return 0;
    const cleanRate = _cleanObservations / _observations;
    if (_observations >= STRONG_LEARN_OBSERVATIONS && cleanRate < 0.10) return 2;
    if (cleanRate < 0.25) return 1;
    return 0;
}

/**
 * Monotonic, severity-scaled demotion for a packaged clip.
 *
 * Monotonic matters more than the exact numbers. The old rule was
 * `Math.min(6, base - 2)`, which is not a demotion at all above 8 — it is a
 * flattening. 8, 9 and 10 all came out as exactly 6, so the best packaged clip
 * in the race was indistinguishable from the worst one that still passed, while
 * 7 — the most common good score there is — came out at 5 and died against an
 * accept floor of 6. A one-point difference in the raw verdict decided
 * accept-vs-reject, and three points of difference decided nothing.
 *
 * Straight subtraction keeps the order intact: the better clip stays the better
 * clip, and a packaged clip can never outrank a clean one that scored the same,
 * because the clean one is not demoted at all.
 *
 * @returns {{penalty:number, relief:number, buckets:string[]}}
 */
function packagingPenalty(buckets) {
    const list = [...new Set(Array.isArray(buckets) ? buckets : [])].filter(b => BUCKET_WEIGHT[b]);
    if (!list.length) return { penalty: 0, relief: 0, buckets: [] };

    const worst = Math.max(...list.map(b => BUCKET_WEIGHT[b]));
    const base = Math.min(5, worst + (list.length - 1));   // stacked layers hurt a little more

    // A presenter keeps a hard floor even under full relief: an empty scene is
    // bad, but a stranger's face talking to the lens in the middle of a faceless
    // video is worse, and it is the one defect a viewer cannot help noticing.
    const floor = list.includes('presenter') ? 3 : 1;
    const relief = Math.min(packagingRelief(), Math.max(0, base - floor));
    return { penalty: base - relief, relief, buckets: list };
}

function summary() {
    return {
        observations: _observations,
        clean: _cleanObservations,
        cleanRate: _observations ? _cleanObservations / _observations : null,
        relief: packagingRelief(),
    };
}

function reset() {
    _observations = 0;
    _cleanObservations = 0;
}

module.exports = {
    detectRequestedPackaging,
    survivingBuckets,
    packagingPenalty,
    packagingRelief,
    noteGateObservation,
    summary,
    reset,
    ARTIFACT_RE,
    BUCKET_WEIGHT,
    MIN_LEARN_OBSERVATIONS,
    STRONG_LEARN_OBSERVATIONS,
};
