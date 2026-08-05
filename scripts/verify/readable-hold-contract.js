#!/usr/bin/env node
'use strict';

/**
 * Readable-hold contract
 *
 * One fact — "how long does this text take to read" — was being answered twice
 * by two different stages that never compared notes.
 *
 *   Step 7.8 Motion QA (src/agents/workers/motion-qa-agent.js) runs during the
 *   build, is the only stage that can actually lengthen a graphic's hold, and
 *   estimated reading time from a WORD count.
 *
 *   The sameness linter (src/render/hf-video-lint.js) runs at render time, is
 *   diagnostics-only by then, and measures CHARACTERS.
 *
 * Per character the word-count estimate's slope was roughly a quarter of the
 * real reading rate, so past a short headline it stopped tracking the text and
 * behaved like a flat number. On a real build a 63-character line was declared
 * comfortable at 2.6s, shipped holding 3.2s, and then flagged as needing 4.3s
 * by a linter running too late to do anything about it.
 *
 * Motion QA now imports the linter's model instead of restating it. This gate
 * exists so the two can never drift apart again, and it proves that
 * END TO END — it runs the real Motion QA repair over a real plan and then
 * runs the real linter over the repaired result — rather than by re-deriving
 * either formula here. A gate that restates the thing it guards is just a
 * third copy waiting to disagree with the other two.
 */

const {
    minimumReadableDuration,
    videoLint,
    READ_CPS,
    ENTRANCE_BLIND,
    MIN_DWELL,
    READ_TOLERANCE,
} = require('../../src/render/hf-video-lint');
const { prepareMotionPlan } = require('../../src/agents/workers/motion-qa-agent');

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

console.log('\n[verify] readable-hold contract');

// ── The shared model is exported and is genuinely text-sensitive ───────────
// Everything below rests on this function, so prove first that it is a real
// function of the text and not a constant wearing a parameter. A flat number
// would satisfy every "did it get longer" test by accident.

check(
    'the reading model is exported for other stages to import',
    typeof minimumReadableDuration === 'function',
    'src/render/hf-video-lint.js must export minimumReadableDuration, otherwise '
    + 'Motion QA has nothing to import and will grow its own rival copy again'
);

const short = minimumReadableDuration('a short line');
const long = minimumReadableDuration('a short line'.repeat(6));
check(
    'the reading model scales with the amount of text',
    long > short * 2,
    `six times the text asked for ${long.toFixed(2)}s against ${short.toFixed(2)}s `
    + 'for one — a model that barely moves with the text is the flat constant '
    + 'this fix exists to remove'
);

check(
    'the reading model ignores nothing-strings',
    minimumReadableDuration('') === 0 && minimumReadableDuration('a') === 0,
    'a single character is not reading; it must not create a hold requirement'
);

// ── The exported model really is the linter's own boundary ────────────────
// Motion QA aims at exactly this number. If it were a hair below what the
// linter demands, every repair would still ship a flagged graphic.

function lintFindings(items, totalDuration = 60) {
    const plan = { fps: 30, totalDuration, motionGraphics: items };
    return videoLint(plan).findings.filter(f => f.id === 'unreadable-in-time');
}

const probeText = 'Seventy two characters of perfectly ordinary on-screen headline text';
const boundary = minimumReadableDuration(probeText);

check(
    'a graphic held for exactly the model\'s answer passes the linter',
    lintFindings([{ type: 'callout', text: probeText, startTime: 1, duration: boundary }]).length === 0,
    `held ${boundary.toFixed(3)}s and was still flagged — Motion QA aims at this `
    + 'exact number, so if the boundary is off by anything the repair is useless'
);

check(
    'a graphic held just under the model\'s answer is caught by the linter',
    lintFindings([{ type: 'callout', text: probeText, startTime: 1, duration: boundary - 0.05 }]).length === 1,
    'the boundary does not bite, so every check below is measuring nothing'
);

check(
    'the linter still uses the published reading constants',
    READ_CPS > 0 && ENTRANCE_BLIND > 0 && MIN_DWELL > 0 && READ_TOLERANCE >= 0,
    'the constants Motion QA reasons about are missing from the export surface'
);

// ── End to end: the real repair, then the real linter ─────────────────────

function fixture() {
    // Each graphic gets its own roomy scene so the repair is never blocked by
    // the timeline — this gate is about whether Motion QA ASKS for enough time,
    // not about what happens when there is none to give.
    return {
        fps: 30,
        totalDuration: 60,
        scenes: [
            { index: 0, startTime: 0, endTime: 12 },
            { index: 1, startTime: 12, endTime: 24 },
            { index: 2, startTime: 24, endTime: 36 },
            { index: 3, startTime: 36, endTime: 48 },
        ],
        motionGraphics: [
            {
                // The real-build case: 63 characters shipped holding 3.2s.
                type: 'callout',
                text: 'The pipeline shipped this line holding barely three seconds',
                startTime: 1,
                endTime: 4.2,
                duration: 3.2,
                position: 'bottom-left',
            },
            {
                type: 'keyTakeaway',
                text: 'A much longer takeaway that keeps going well past the point where a '
                    + 'word count stops tracking how much there is to actually read here',
                startTime: 13,
                endTime: 16.2,
                duration: 3.2,
                position: 'center-right',
            },
        ],
        mgScenes: [],
        templateScenes: [
            {
                type: 'statCard',
                title: 'A fullscreen card whose title alone takes real time to finish reading',
                startTime: 25,
                endTime: 28,
                duration: 3,
            },
        ],
    };
}

const before = fixture();
const beforeFindings = lintFindings(
    [...before.motionGraphics, ...before.templateScenes],
    before.totalDuration
);
check(
    'the fixture really is unreadable before Motion QA touches it',
    beforeFindings.length === 3,
    `the linter found ${beforeFindings.length} of 3 — if the fixture is already `
    + 'fine then the repair below proves nothing'
);

const originalFlag = process.env.HF_MOTION_QA;
delete process.env.HF_MOTION_QA;

let after = null;
let afterFindings = null;
let repairs = [];
try {
    after = fixture();
    const result = prepareMotionPlan(after);
    repairs = Array.isArray(result?.repairs) ? result.repairs : [];
    afterFindings = lintFindings(
        [...after.motionGraphics, ...after.templateScenes],
        after.totalDuration
    );
} finally {
    if (originalFlag === undefined) delete process.env.HF_MOTION_QA;
    else process.env.HF_MOTION_QA = originalFlag;
}

check(
    'Motion QA no longer ships a graphic the linter calls unreadable',
    afterFindings && afterFindings.length === 0,
    afterFindings && afterFindings.length
        ? `${afterFindings.length} still unreadable after repair:\n       `
          + afterFindings.map(f => f.snippet).join('\n       ')
          + '\n       Motion QA is the last stage that can extend a hold. If it '
          + 'still under-measures, the linter is only writing the obituary.'
        : 'the repair pass did not run'
);

check(
    'the repair pass said what it did',
    repairs.some(r => r?.code === 'readable_hold_extended'),
    'no readable_hold_extended repair was recorded, so the graphics either were '
    + 'not extended or were extended silently'
);

// ── The extension tracks the text, it is not one blanket number ───────────
// The banned shape is a flat constant. Two graphics with very different amounts
// of text must not come out of the repair holding the same length.

if (after) {
    const shortItem = after.motionGraphics[0];
    const longItem = after.motionGraphics[1];
    check(
        'more text earns more time',
        longItem.duration > shortItem.duration + 0.5,
        `${shortItem.text.length} chars got ${Number(shortItem.duration).toFixed(2)}s and `
        + `${longItem.text.length} chars got ${Number(longItem.duration).toFixed(2)}s — `
        + 'a repair that hands every graphic the same hold is the flat constant again'
    );
}

// ── Nothing that already fits gets shortened ──────────────────────────────
// The reading requirement is a floor. If it could also pull a hold down it
// would quietly re-cut graphics that were deliberately given room.

const generous = {
    fps: 30,
    totalDuration: 60,
    scenes: [{ index: 0, startTime: 0, endTime: 30 }],
    motionGraphics: [{
        type: 'callout',
        text: 'Short line',
        startTime: 2,
        endTime: 12,
        duration: 10,
        position: 'bottom-left',
    }],
    mgScenes: [],
    templateScenes: [],
};

const generousFlag = process.env.HF_MOTION_QA;
delete process.env.HF_MOTION_QA;
try {
    prepareMotionPlan(generous);
} finally {
    if (generousFlag === undefined) delete process.env.HF_MOTION_QA;
    else process.env.HF_MOTION_QA = generousFlag;
}

check(
    'a graphic that already has room is never trimmed to fit the reading time',
    generous.motionGraphics[0].duration >= 10,
    `a 10s hold on a 10-character line came back as `
    + `${Number(generous.motionGraphics[0].duration).toFixed(2)}s — the reading `
    + 'requirement is a floor, never a ceiling, or every deliberate long hold regresses'
);

console.log(`\n[verify] readable-hold contract: ${passes}/${passes + failures} passed`);
if (failures) {
    console.error(`[verify] readable-hold contract FAILED (${failures})`);
    process.exit(1);
}
