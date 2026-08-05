#!/usr/bin/env node
'use strict';

/**
 * Motion-variety contract
 *
 * The render-time linter has always been able to SAY "six of your nine graphics
 * arrive the same way". Nothing ever acted on it, and by the time it spoke the
 * plan was frozen. Motion QA (Step 7.8) is the last stage that can still change
 * how a graphic arrives, so that is where the acting belongs.
 *
 * Two things make that dangerous, and this gate exists for both.
 *
 * 1. GAMING THE LINTER. The renderer chooses the on-screen entrance by testing
 *    the animation NAME for substrings. Most of the vocabulary matches none of
 *    them, so `fadeSlide`, `cascade`, `staggerSlide`, `typewriter` and friends
 *    all produce the identical arrival. Swapping one for another silences the
 *    name-count and changes nothing a viewer can see. Every substitution this
 *    pass makes must therefore land in a different VISIBLE family, and the
 *    family model must stay glued to the renderer's own source.
 *
 * 2. INVENTING VARIETY. A repair that spreads speeds across a continuum, or
 *    that overrules a theme's deliberate answer, produces a different plan
 *    without producing a different video. So the pass only rewrites what
 *    nothing chose, protects a theme's voice at the first place it was spoken,
 *    and — when a card type genuinely has no second visible entrance — reports
 *    that it could not help rather than faking a fix.
 *
 * The gate proves this END TO END: it runs the real Motion QA over real plans
 * and asks the real linter and the real renderer's source about the result. It
 * deliberately does not restate either formula, because a gate that restates
 * the thing it guards is a third copy waiting to disagree with the other two.
 */

const fs = require('fs');
const path = require('path');

const {
    entranceFamily,
    snapMotionSpeed,
    ENTRANCE_LADDER,
    MOTION_SPEED_STEPS,
} = require('../../src/render/hf-video-lint');
const {
    prepareMotionPlan,
    collectVisualRefs,
    entranceVocabulary,
    motionBudget,
    samenessState,
    varietyDeps,
    _resetVarietyDeps,
} = require('../../src/agents/workers/motion-qa-agent');

let failures = 0;
let passes = 0;

function check(label, condition, detail) {
    if (condition) {
        passes += 1;
        console.log(`  ok   ${label}`);
    } else {
        failures += 1;
        console.log(`  FAIL ${label}`);
        if (detail) console.log(`       ${detail}`);
    }
}

console.log('\n[verify] motion-variety contract');

// ── 1. The family model describes what the VIEWER sees ─────────────────────
// Everything downstream rests on entranceFamily(). Prove first that it is a
// model of the screen and not a second name-counter: the names the renderer
// treats identically must collapse together, and the names it treats
// differently must stay apart. Without both halves a "different family"
// substitution proves nothing.

check(
    'the family model and the pace ladder are exported for other stages to import',
    typeof entranceFamily === 'function'
    && typeof snapMotionSpeed === 'function'
    && Array.isArray(ENTRANCE_LADDER)
    && Array.isArray(MOTION_SPEED_STEPS),
    'src/render/hf-video-lint.js must export these, otherwise Motion QA has '
    + 'nothing to import and will grow its own rival copy of the renderer'
);

const INTERCHANGEABLE = [
    'fadeSlide', 'staggerSlide', 'cascade', 'fadeIn',
    'typewriter', 'spinReveal', 'staggerBars', 'wordCascade',
];
const interchangeableFamilies = new Set(
    INTERCHANGEABLE.map(name => entranceFamily(name, { type: 'callout', kind: 'overlay' }))
);
check(
    'names the renderer treats identically are recognised as one entrance',
    interchangeableFamilies.size === 1,
    `${INTERCHANGEABLE.length} names that all produce the same arrival split into `
    + `${interchangeableFamilies.size} families (${[...interchangeableFamilies].join(', ')}) — `
    + 'if the model believed these differ, the repair could "fix" monotony by '
    + 'swapping one for another and changing nothing on screen'
);

const ladderFamilies = new Set(
    ENTRANCE_LADDER.map(step => entranceFamily(step.any[0], { type: 'callout', kind: 'overlay' }))
);
check(
    'names the renderer treats differently stay apart',
    ladderFamilies.size === ENTRANCE_LADDER.length,
    `${ENTRANCE_LADDER.length} distinct renderer branches collapsed into `
    + `${ladderFamilies.size} families — a model that merges real differences would `
    + 'refuse substitutions that genuinely change the video'
);

// ── 2. Drift tripwires against the renderer's own source ───────────────────
// The renderer's entrance dispatcher lives inside a generated HTML string, so
// it cannot be imported and compared by value. It is mirrored declaratively in
// hf-video-lint.js instead — which is only safe if something reads the other
// side and fails when the two stop agreeing.

const BRIDGE_PATH = path.join(__dirname, '..', '..', 'src', 'render', 'hyperframes-bridge.js');
const bridgeSource = fs.readFileSync(BRIDGE_PATH, 'utf8');

function sourceBlock(name) {
    const start = bridgeSource.indexOf(`function ${name}(`);
    if (start < 0) return '';
    const open = bridgeSource.indexOf('{', start);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < bridgeSource.length; i++) {
        if (bridgeSource[i] === '{') depth += 1;
        else if (bridgeSource[i] === '}') {
            depth -= 1;
            if (depth === 0) return bridgeSource.slice(open, i + 1);
        }
    }
    return '';
}

const enterBlock = sourceBlock('hfEnterState');
const speedBlock = sourceBlock('hfSpeed');
const normalizeBlock = sourceBlock('normalizeMotionSpeed');

check(
    'the renderer\'s entrance and speed code can still be located',
    Boolean(enterBlock && speedBlock && normalizeBlock),
    'hfEnterState / hfSpeed / normalizeMotionSpeed were not found in '
    + 'hyperframes-bridge.js — if they were renamed, the two tripwires below are '
    + 'silently checking nothing and the mirror can drift unnoticed'
);

function runtimeLadder(block) {
    const steps = [];
    for (const line of block.split('\n')) {
        if (!/^\s*if \(/.test(line)) continue;
        const positives = [...line.matchAll(/(?<!!)anim\.includes\('([a-z0-9-]+)'\)/g)].map(m => m[1]);
        const negatives = [...line.matchAll(/!anim\.includes\('([a-z0-9-]+)'\)/g)].map(m => m[1]);
        if (!positives.length) continue;
        steps.push({ any: positives, not: negatives });
    }
    return steps;
}

const runtimeSteps = runtimeLadder(enterBlock);
const ladderMatches = runtimeSteps.length === ENTRANCE_LADDER.length
    && runtimeSteps.every((step, i) => {
        const mirror = ENTRANCE_LADDER[i];
        const mirrorNot = Array.isArray(mirror.not) ? mirror.not : [];
        return step.any.join('|') === mirror.any.join('|')
            && step.not.join('|') === mirrorNot.join('|');
    });
check(
    'the entrance ladder still matches the renderer, branch for branch and in order',
    ladderMatches,
    'the renderer says\n         '
    + runtimeSteps.map(s => `${s.any.join('+')}${s.not.length ? ` (not ${s.not.join('+')})` : ''}`).join('\n         ')
    + '\n       the mirror says\n         '
    + ENTRANCE_LADDER.map(s => `${s.any.join('+')}${s.not?.length ? ` (not ${s.not.join('+')})` : ''}`).join('\n         ')
    + '\n       Order is load-bearing — `right` must be tested before `left`. Update '
    + 'ENTRANCE_LADDER in hf-video-lint.js in the same commit as the renderer.'
);

check(
    'the renderer still falls back on the graphic\'s shape after the names run out',
    /map-chart/.test(enterBlock)
    && /item\.kind === 'fullscreen' \|\| item\.kind === 'template'/.test(enterBlock)
    && enterBlock.indexOf('map-chart') < enterBlock.indexOf("item.kind === 'fullscreen'"),
    'the map-chart and fullscreen/template fallbacks are what entranceFamily '
    + 'returns as `mapzoom` and `takeover` — if the renderer drops or reorders '
    + 'them, every template in the video is being classified as something it is not'
);

function returnedNumbers(block) {
    return [...block.matchAll(/return (\d+(?:\.\d+)?);/g)].map(m => Number(m[1])).sort((a, b) => a - b);
}
const mirrorSteps = [...MOTION_SPEED_STEPS].sort((a, b) => a - b).join(',');
check(
    'the pace ladder still matches the speeds the renderer actually resolves to',
    returnedNumbers(speedBlock).join(',') === mirrorSteps
    && returnedNumbers(normalizeBlock).join(',') === mirrorSteps,
    `renderer runtime resolves to [${returnedNumbers(speedBlock).join(', ')}], its node-side `
    + `twin to [${returnedNumbers(normalizeBlock).join(', ')}], the mirror says [${mirrorSteps}] — `
    + 'these are the only speeds a viewer can be given, so a pace repair aiming '
    + 'anywhere else is picking a number, not a pace'
);

check(
    'a computed speed is snapped to a step a viewer can see',
    snapMotionSpeed(1.07) === 1 && snapMotionSpeed(1.5) === 1.6 && snapMotionSpeed(0.6) === 0.55,
    'snapMotionSpeed let a value through unsnapped — spreading speeds across a '
    + 'continuum satisfies a variety count without changing the video'
);

// ── 3. Motion QA imports the app's real vocabulary ─────────────────────────
// The list of entrances a card type may use is never written down here. It is
// obtained by asking the real resolver, once per shipped theme. That is what
// keeps this pass correct when a theme is added and what stops it inventing an
// animation the renderer has never heard of.

const deps = varietyDeps();
check(
    'Motion QA can reach the real resolver, themes and registry',
    Boolean(deps)
    && typeof deps.resolveVisual === 'function'
    && deps.themeIds.length >= 2
    && Object.keys(deps.registry || {}).length > 0,
    'varietyDeps() came back empty — the variety pass will silently do nothing '
    + 'on every build, which looks exactly like "no monotony found"'
);

const chapterVocab = deps ? entranceVocabulary({ item: {}, kind: 'template', type: 'chapter-card' }, deps) : [];
const chapterFamilies = new Set(chapterVocab.map(n => entranceFamily(n, { type: 'chapter-card', kind: 'template' })));
check(
    'the vocabulary is discovered from the shipped themes, not from a list kept here',
    chapterVocab.length >= 2 && chapterFamilies.size >= 2,
    `chapter-card offered [${chapterVocab.join(', ')}] in ${chapterFamilies.size} families — `
    + 'a type with fewer than two visible options cannot be varied at all'
);

check(
    'a card type the app does not ship offers nothing',
    deps ? entranceVocabulary({ item: {}, kind: 'graphic', type: 'not-a-real-card-type' }, deps).length === 0 : false,
    'an invented type came back with entrances — that means the vocabulary is '
    + 'coming from somewhere other than the app, and the pass can write an '
    + 'animation the renderer will not understand'
);

// ── Fixtures ──────────────────────────────────────────────────────────────
// Every graphic gets its own roomy scene so the timing and collision repairs
// that run before variety never interfere. This gate is about how graphics
// arrive, not about what happens when the timeline is full.

function fixture(cards, opts = {}) {
    const gap = opts.gap || 14;
    const hold = opts.hold || 6;
    return {
        fps: 30,
        totalDuration: cards.length * gap,
        scriptContext: { themeId: opts.themeId || 'standard' },
        scenes: cards.map((_, i) => ({ index: i, startTime: i * gap, endTime: (i + 1) * gap })),
        motionGraphics: [],
        mgScenes: [],
        templateScenes: cards.map((card, i) => ({
            type: card.type,
            text: card.text,
            startTime: i * gap + 2,
            endTime: i * gap + 2 + hold,
            duration: hold,
            ...(card.extra || {}),
        })),
    };
}

function run(plan) {
    const saved = process.env.HF_MOTION_QA;
    delete process.env.HF_MOTION_QA;
    try {
        return prepareMotionPlan(plan);
    } finally {
        if (saved === undefined) delete process.env.HF_MOTION_QA;
        else process.env.HF_MOTION_QA = saved;
    }
}

function familiesOf(plan) {
    return plan.templateScenes.map(item => entranceFamily(item.animation, { type: item.type, kind: 'template' }));
}

// ── 4. The repair changes what the viewer sees ────────────────────────────

const monotone = fixture(Array.from({ length: 9 }, (_, i) => ({
    type: 'chapter-card',
    text: `Chapter ${i + 1}`,
})));
const monotoneBefore = familiesOf(monotone);
const monotoneResult = run(monotone);
const entranceRepairs = monotoneResult.repairs.filter(r => r.code === 'motion_entrance_varied');

check(
    'nine identical cards really are monotonous before the pass runs',
    samenessState(monotoneBefore).offending,
    'the fixture was already varied, so every check below proves nothing'
);

check(
    'the pass acts on the monotony instead of only noting it',
    entranceRepairs.length > 0,
    'no entrance was changed — the linter has been able to report this for a '
    + 'while; the whole point of this fix is that something now answers it'
);

check(
    'the video is no longer dominated by one entrance afterwards',
    !samenessState(familiesOf(monotone)).offending,
    `families after the pass: ${familiesOf(monotone).join(', ')}`
);

check(
    'every substitution lands in a different visible entrance',
    entranceRepairs.every(r => r.before !== r.after)
    && entranceRepairs.every((r) => {
        const item = monotone.templateScenes[r.index];
        return entranceFamily(item.animation, { type: item.type, kind: 'template' }) === r.after;
    }),
    'a repair reported a change that does not survive the renderer\'s own '
    + 'classification — that is the linter being gamed, not the video being fixed'
);

check(
    'the theme keeps its voice where it actually spoke — the first card of a type',
    monotone.templateScenes[0]._motionQaEntrance !== true && !monotone.templateScenes[0].animation,
    'the first chapter-card was rewritten. A theme states one entrance per card '
    + 'type, knowing nothing about how many of them a given video contains — so '
    + 'the statement is honoured where it was made and only the repeats may vary'
);

// ── 5. What the pass must never touch ─────────────────────────────────────

const protectedPlan = fixture([
    { type: 'chapter-card', text: 'One' },
    { type: 'chapter-card', text: 'Two', extra: { animation: 'wipeRight' } },
    { type: 'chapter-card', text: 'Three', extra: { animationManual: true } },
    { type: 'chapter-card', text: 'Four', extra: { agenticComposition: false } },
    { type: 'chapter-card', text: 'Five' },
    { type: 'chapter-card', text: 'Six' },
    { type: 'chapter-card', text: 'Seven' },
    { type: 'chapter-card', text: 'Eight' },
]);
run(protectedPlan);

check(
    'a graphic that states its own entrance is left alone',
    protectedPlan.templateScenes[1].animation === 'wipeRight',
    `it came back as "${protectedPlan.templateScenes[1].animation}" — an explicit `
    + 'choice by the plan, the Motion Director or the creator outranks this pass '
    + 'unconditionally'
);

check(
    'a graphic the creator marked as hand-set is left alone',
    !protectedPlan.templateScenes[2].animation && protectedPlan.templateScenes[2]._motionQaEntrance !== true,
    `it came back as "${protectedPlan.templateScenes[2].animation}" — a manual flag `
    + 'means a human already decided'
);

check(
    'a graphic with its composer switched off does not get it switched back on',
    protectedPlan.templateScenes[3].agenticComposition === false,
    '`agenticComposition: false` is an explicit "do not compose this". Writing a '
    + 'motion object onto it would quietly re-enable a renderer somebody turned off.'
);

// ── 6. Warn, never fake ───────────────────────────────────────────────────
// timeline-card ships two entrance names that the renderer draws identically.
// There is no honest substitution available, so the only correct behaviour is
// to say so. A refusal nobody is told about is indistinguishable from a pass.

const stuck = fixture(Array.from({ length: 8 }, (_, i) => ({
    type: 'timeline-card',
    text: `Step ${i + 1}`,
})));
const stuckResult = run(stuck);

check(
    'a card type with no second visible entrance is not given a cosmetic one',
    stuckResult.repairs.filter(r => r.code === 'motion_entrance_varied').length === 0,
    'something was swapped for a name that produces the identical arrival — the '
    + 'linter goes quiet and the video is unchanged'
);

check(
    'the pass reports the variety it could not deliver',
    stuckResult.findings.some(f => f.code === 'motion_variety_unavailable'),
    'it declined silently, which reads exactly like "nothing was wrong"'
);

// ── 7. Pace comes from the content, and never costs readability ───────────

const MIXED_LOAD = [
    { type: 'chapter-card', text: 'Collapse' },
    { type: 'fact-card', text: 'Seventy percent of the harvest was lost in a single week and prices tripled inside a month' },
    { type: 'quote-card', text: 'We were told it would never happen here' },
    { type: 'stat-card', text: '1.2 million' },
    { type: 'fact-card', text: 'Only nine of the original forty two facilities are still operating anywhere in the region today' },
    { type: 'chapter-card', text: 'Aftermath' },
    { type: 'quote-card', text: 'Nobody is coming to save us' },
    { type: 'key-takeaway', text: 'The shortage was never about supply, it was about who was allowed to buy first' },
];

const paced = fixture(MIXED_LOAD, { gap: 16, hold: 6 });
const pacedResult = run(paced);
const paceRepairs = pacedResult.repairs.filter(r => r.code === 'motion_pace_varied');
const pacedSpeeds = paced.templateScenes.map(item => Number(item.animationSpeed || 1));

check(
    'the video ends up with more than one tempo',
    new Set(pacedSpeeds).size >= 3,
    `speeds after the pass: ${pacedSpeeds.join(', ')} — one tempo for a whole video `
    + 'flattens emphasis; nothing can feel urgent if everything moves at one rate'
);

check(
    'every tempo is one a viewer can actually tell apart',
    pacedSpeeds.every(speed => MOTION_SPEED_STEPS.includes(speed)),
    `speeds after the pass: ${pacedSpeeds.join(', ')} — a value between the rungs is `
    + 'a different number, not a different pace'
);

check(
    'the tempo follows the reading load in both directions',
    paceRepairs.some(r => r.after > r.before) && paceRepairs.some(r => r.after < r.before),
    'every change went the same way, so the tempo is not tracking how much there '
    + 'is to read — it is just a nudge applied to everything'
);

// The same eight graphics, but held only as long as the readable-hold repair
// insists on — which is where a slow-down actually costs something. Slower
// motion spends longer arriving and leaving, so on a tight hold it eats the
// settled, legible middle. The roomy fixture above cannot show this: it has
// seconds of slack, so every slow-down fits regardless.
const tight = fixture(MIXED_LOAD, { gap: 16, hold: 1.2 });
run(tight);
const tightRefs = collectVisualRefs(tight);
const slack = tightRefs.map(ref => ref.duration - motionBudget(ref).required);

check(
    'the tight fixture leaves no room to spare, so the guard below is really tested',
    slack.filter(s => s < 0.2).length >= 3,
    `slack per graphic: ${slack.map(s => s.toFixed(2)).join(', ')} — with seconds to `
    + 'spare a slower tempo always fits, and the check below would pass by accident'
);

const overrun = tightRefs.filter(ref => motionBudget(ref).required > ref.duration + 0.05);
check(
    'slowing a graphic down never steals the time it needs to be read',
    overrun.length === 0,
    `${overrun.length} graphic(s) ended up needing more time than they have:\n       `
    + overrun.map(ref => `${ref.type} holds ${ref.duration.toFixed(2)}s at speed `
        + `${motionBudget(ref).speed}, needs ${motionBudget(ref).required.toFixed(2)}s`).join('\n       ')
    + '\n       Fitting a graphic into its window is correctness; varying how it '
    + 'arrives is taste, and taste must never take time away from readability.'
);

const uniform = fixture(Array.from({ length: 8 }, (_, i) => ({
    type: 'chapter-card',
    text: `Chapter ${i + 1}`,
})));
const uniformResult = run(uniform);
check(
    'a video where every graphic carries the same load is not forced into fake tempo',
    uniformResult.repairs.filter(r => r.code === 'motion_pace_varied').length === 0
    && uniformResult.findings.some(f => f.code === 'pace_variety_unavailable'),
    'it manufactured a tempo spread out of eight identical cards — the pace has '
    + 'to come from the content, and when there is no difference to reflect the '
    + 'honest answer is to say the plan has to supply it'
);

// ── 8. Report what is left, and never take the build down ─────────────────

check(
    'the sameness the pass cannot fix is reported instead of swallowed',
    pacedResult.findings.some(f => f.code === 'motion_sameness_remaining')
    && pacedResult.sameness && pacedResult.sameness.stats
    && typeof pacedResult.sameness.stats.byMotionFamily === 'object',
    'nothing was reported and no snapshot was attached. Motion QA repairs what '
    + 'nobody chose; whatever remains is the plan\'s to answer, and it can only '
    + 'answer a problem it is told about.'
);

const bridgeId = require.resolve('../../src/render/hyperframes-bridge');
const realBridge = require.cache[bridgeId];
require.cache[bridgeId] = {
    id: bridgeId, filename: bridgeId, loaded: true, exports: {}, children: [], paths: [],
};
_resetVarietyDeps();
let degraded = null;
let degradedError = null;
try {
    degraded = run(fixture(Array.from({ length: 9 }, (_, i) => ({ type: 'chapter-card', text: `Chapter ${i + 1}` }))));
} catch (err) {
    degradedError = err;
} finally {
    require.cache[bridgeId] = realBridge;
    _resetVarietyDeps();
}

check(
    'if the renderer ever stops exposing what this pass imports, the build still runs',
    !degradedError
    && degraded
    && degraded.repairs.filter(r => r.code === 'motion_entrance_varied').length === 0
    && degraded.status !== 'fail',
    degradedError
        ? `Motion QA threw: ${degradedError.message}`
        : 'the pass did something without its dependencies, or failed the build. '
        + 'Variety is taste — it must degrade to doing nothing, never to blocking a render.'
);

check(
    'the dependency cache recovers afterwards',
    Boolean(varietyDeps()),
    'varietyDeps() stayed empty after the stub was removed, so the reset seam is '
    + 'one-way and this gate has poisoned the module for anything that runs after it'
);

console.log(`\n[verify] motion-variety contract: ${passes}/${passes + failures} passed`);
if (failures) {
    console.error(`[verify] motion-variety contract FAILED (${failures})`);
    process.exit(1);
}
