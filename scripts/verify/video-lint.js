#!/usr/bin/env node
'use strict';

/**
 * video-lint.js — the permanent gate for the whole-video sameness rules.
 *
 * `slop-lint.js` guards ONE graphic. This guards the SEQUENCE: the AI tell
 * that no single-artefact checker can see, because every graphic in a samey
 * video can be individually fine.
 *
 * A sameness gate has a failure mode a normal gate does not: it can be tuned
 * until it fires on everything, at which point it is noise, or until it fires
 * on nothing, at which point it is decoration. So this check runs the rules
 * over TWO fixtures and demands the opposite verdict from each:
 *
 *   MACHINE  — the distribution actually measured from the Aug-1 build and
 *              recorded in docs/anti-ai-look-baseline.md §3. Every sameness
 *              rule must fire.
 *   HAND-CUT — the same video edited the way a person would cut it. Every
 *              sameness rule must stay silent.
 *
 * Two fixtures, opposite verdicts, is the only arrangement that proves the
 * rules are measuring the video rather than their own thresholds.
 *
 * NOTE ON ORDER: the "N in a row" findings depend on the order graphics appear
 * in, which a fixture invents. So the fixtures below interleave their repeats
 * the way a real plan does, and the assertions that matter lean on the
 * share-based findings, which order cannot fake.
 *
 * Zero AI, zero network, zero browser.
 * Kill switch: HF_VIDEO_LINT=0 (project convention).
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
    videoLint,
    motionFamily,
    longestRun,
    coefficientOfVariation,
    VIDEO_RULE_IDS,
    READ_CPS,
    MIN_DWELL,
} = require(path.join(ROOT, 'src', 'render', 'hf-video-lint'));

if (String(process.env.HF_VIDEO_LINT || '').trim() === '0') {
    console.log('video-lint: skipped (HF_VIDEO_LINT=0)');
    process.exit(0);
}

let failures = 0;
function fail(message) {
    console.error(`\n  FAIL  ${message}`);
    failures++;
    process.exitCode = 1;
}
function ok(message) { console.log(`    · ${message}`); }

const LINE = 'The reservoir lost four fifths of its volume in a decade';

// ── Fixture 1: MACHINE ─────────────────────────────────────────────────────
// The measured real distribution. Repeats are spread through the timeline
// rather than bunched, so the rules have to find them by counting, not by
// tripping over a sorted array.
function machineFixture() {
    const layouts = ['split-panel', 'cinematic-title', 'data-focus', 'evidence-board', 'lower-third', 'focus-panel'];
    const layoutPlan = [5, 4, 4, 3, 2, 2];
    const types = [
        ['key-takeaway', 5], ['comparison-card', 3], ['stat-card', 1], ['bar-chart', 1],
        ['quote-card', 1], ['timeline', 1], ['bullet-list', 1], ['fact-card', 1],
        ['title-card', 1], ['ranking-list', 1], ['location-card', 1], ['image-showcase', 1],
        ['chapter-card', 1], ['callout', 1],
    ];
    // fadeSlide 6 + fade-slide 4: one entrance, two spellings, 10 of 20.
    const anims = [
        ['fadeSlide', 6], ['fade-slide', 4], ['springScale', 3],
        ['slideLeft', 3], ['popUp', 2], ['wipeRight', 1], ['typewriter', 1],
    ];
    const spread = (pairs) => {
        const pool = [];
        for (const [v, n] of pairs) for (let i = 0; i < n; i++) pool.push(v);
        // Deal round-robin from the largest group down, which is how repeats
        // land in a real plan: scattered, never adjacent.
        const out = [];
        let cursor = 0;
        while (out.length < pool.length) {
            for (let i = cursor; i < pool.length; i += 7) out.push(pool[i]);
            cursor++;
            if (cursor > 7) break;
        }
        return out.length === pool.length ? out : pool;
    };
    const layoutList = spread(layouts.map((l, i) => [l, layoutPlan[i]]));
    const typeList = spread(types);
    const animList = spread(anims);

    const resolved = [];
    for (let i = 0; i < 20; i++) {
        resolved.push({
            type: typeList[i], kind: 'graphic', layout: layoutList[i],
            animation: animList[i], speed: 'normal', themeId: 'warm-editorial',
            startTime: 12 + i * 21,   // a graphic every 21s, forever
            duration: 5.8,            // every graphic held for exactly as long
            text: LINE,
        });
    }
    return { resolved };
}

// ── Fixture 2: HAND-CUT ────────────────────────────────────────────────────
// Same video, cut by a person: entrances chosen for the beat, layouts moved
// around the frame, durations set by how much there is to read, and graphics
// placed where the script earns them instead of on a timer.
function handCutFixture() {
    const rows = [
        ['title-card', 'cinematic-title', 'wipeRight', 'slow', 9.0, 3.5, 'Lake Chad'],
        ['stat-card', 'data-focus', 'springScale', 'fast', 24.0, 2.4, '90% gone'],
        ['key-takeaway', 'split-panel', 'fadeSlide', 'normal', 41.5, 6.2, LINE],
        ['map-chart', 'full-bleed', 'slideLeft', 'slow', 58.0, 8.5, 'Sahel basin'],
        ['quote-card', 'focus-panel', 'typewriter', 'slow', 96.0, 7.4, 'We fished here as boys'],
        ['bar-chart', 'data-focus', 'popUp', 'normal', 121.0, 5.6, '1963 to 2024'],
        ['comparison-card', 'evidence-board', 'slideLeft', 'normal', 140.5, 6.8, 'Then and now'],
        ['callout', 'lower-third', 'fadeSlide', 'fast', 168.0, 3.1, 'Nigeria'],
        ['timeline', 'split-panel', 'wipeRight', 'normal', 205.0, 7.9, 'Six decades of retreat'],
        ['fact-card', 'focus-panel', 'springScale', 'normal', 254.0, 5.2, 'Ten million people'],
        ['ranking-list', 'evidence-board', 'popUp', 'normal', 289.0, 8.1, 'Four countries affected'],
        ['chapter-card', 'cinematic-title', 'typewriter', 'slow', 330.0, 4.4, 'What happens next'],
    ];
    return {
        resolved: rows.map(([type, layout, animation, speed, startTime, duration, text]) => ({
            type, kind: 'graphic', layout, animation, speed,
            themeId: 'warm-editorial', startTime, duration, text,
        })),
    };
}

// ── 1. Normalisation is honest ─────────────────────────────────────────────
{
    const same = ['fadeSlide', 'fade-slide', 'FADE_SLIDE', 'fade slide'];
    const families = new Set(same.map(motionFamily));
    if (families.size !== 1) {
        fail(`the four spellings of one entrance collapsed to ${families.size} families (${[...families].join(', ')}) — the count would still be dishonest`);
    } else {
        ok(`entrance spellings collapse correctly: ${same.join(' / ')} → "${[...families][0]}"`);
    }
    if (motionFamily('slideLeft') === motionFamily('slideRight')) {
        fail('slideLeft and slideRight collapsed into one family — normalising must not erase real differences');
    }
}

// ── 2. The MACHINE fixture must trip every sameness rule ───────────────────
const machine = videoLint(machineFixture());
const machineIds = new Set(machine.findings.map(f => f.id));
const MUST_FIRE = [
    'motion-vocabulary-split',
    'motion-monotony',
    'pace-monotony',
    'type-monotony',
    'metronome-timing',
    'metronome-spacing',
];
for (const id of MUST_FIRE) {
    if (!machineIds.has(id)) {
        fail(`"${id}" did not fire on the distribution measured from the real build — the rule cannot see the thing it was written for`);
    }
}
if (MUST_FIRE.every(id => machineIds.has(id))) {
    ok(`machine-made fixture: ${machine.findings.length} findings across ${machineIds.size} rules`);
    for (const f of machine.findings) console.log(`        [${f.severity}] ${f.id}: ${f.snippet}`);
}

// layout-monotony must NOT fire here, and that is a result about the build
// rather than a hole in the gate. The Aug-1 build spread six layouts across
// twenty graphics with the commonest taking five — 1.5× its even share, which
// is variety. If a future change to the rule starts flagging that, the rule has
// drifted into flagging normal editing, so this assertion is a tripwire in the
// opposite direction from all the others.
if (machineIds.has('layout-monotony')) {
    const f = machine.findings.find(x => x.id === 'layout-monotony');
    fail(`layout-monotony flagged the real build's layout spread, which was measured as genuinely varied: ${f.snippet}`);
} else {
    ok('layout-monotony stays silent on the real build — its layouts were measured as genuinely varied, and the rule agrees');
}

// …but the rule still has to be able to fire, or the silence above proves
// nothing. Same twenty graphics, one layout habit.
{
    const stuck = videoLint({
        resolved: Array.from({ length: 20 }, (_, i) => ({
            type: `type-${i % 9}`, layout: i % 4 === 3 ? `alt-${i % 3}` : 'split-panel',
            animation: ['fadeSlide', 'popUp', 'slideLeft', 'wipeRight'][i % 4],
            speed: ['slow', 'normal', 'fast'][i % 3],
            startTime: 10 + i * 17 + (i % 5) * 3, duration: 4 + (i % 4) * 1.7, text: 'Short line here',
        })),
    });
    const hit = stuck.findings.find(f => f.id === 'layout-monotony');
    if (!hit) {
        fail('layout-monotony could not be made to fire even when 15 of 20 graphics share one layout — the rule is dead code');
    } else {
        ok(`layout-monotony fires when it should: ${hit.snippet}`);
    }
}

// The split must be reported with BOTH spellings and the honest total, since
// the whole point is that the raw report under-counts it.
{
    const split = machine.findings.find(f => f.id === 'motion-vocabulary-split');
    if (split && !(/fadeSlide/.test(split.snippet) && /fade-slide/.test(split.snippet) && /10 of 20/.test(split.snippet))) {
        fail(`the vocabulary-split finding must name both spellings and the honest combined count — got: ${split.snippet}`);
    } else if (split) {
        ok('vocabulary split reports both spellings and the true combined share');
    }
}

// The stats block must carry the corrected count, not the raw one.
{
    const s = machine.stats;
    if (s.byMotionFamily.fadeslide !== 10) {
        fail(`corrected motion tally should show 10 fadeslide, got ${s.byMotionFamily.fadeslide}`);
    } else if (s.byAnimationRaw.fadeSlide !== 6) {
        fail(`raw tally should be preserved alongside the corrected one (expected fadeSlide 6, got ${s.byAnimationRaw.fadeSlide})`);
    } else {
        ok('stats carry BOTH the raw tally (fadeSlide 6 / fade-slide 4) and the honest one (fadeslide 10)');
    }
}

// ── 3. The HAND-CUT fixture must stay silent ───────────────────────────────
const hand = videoLint(handCutFixture());
{
    const noisy = hand.findings.filter(f => f.severity !== 'advisory');
    if (noisy.length) {
        fail(`a hand-cut video produced ${noisy.length} finding(s) — the rules are firing on their own thresholds, not on sameness:\n        ${noisy.map(f => `${f.id}: ${f.snippet}`).join('\n        ')}`);
    } else {
        ok(`hand-cut fixture: silent across all ${VIDEO_RULE_IDS.length} rules (duration spread ${hand.stats.durationCv}, spacing spread ${hand.stats.spacingCv})`);
    }
}

// ── 4. Reading time is a defect, not a taste call ──────────────────────────
{
    const longLine = 'A hundred and twelve thousand square kilometres of open water disappeared inside a single human lifetime';
    const tooFast = videoLint({
        resolved: [{ type: 'key-takeaway', layout: 'split-panel', animation: 'fadeSlide', speed: 'normal', startTime: 5, duration: 2.0, text: longLine }],
    });
    const hit = tooFast.findings.find(f => f.id === 'unreadable-in-time');
    if (!hit) {
        fail(`${longLine.length} characters in 2.0s was not flagged — at ${READ_CPS} characters a second that needs over ${(longLine.length / READ_CPS).toFixed(1)}s`);
    } else if (hit.severity !== 'error' || !tooFast.errors.length) {
        fail('unreadable text must be an error (it feeds the repair round), not a warning');
    } else {
        ok(`unreadable text is an error: ${hit.snippet}`);
    }

    const enough = videoLint({
        resolved: [{ type: 'key-takeaway', layout: 'split-panel', animation: 'fadeSlide', speed: 'normal', startTime: 5, duration: 9.0, text: longLine }],
    });
    if (enough.findings.some(f => f.id === 'unreadable-in-time')) {
        fail('the same line given 9.0s was still flagged — the rule is not measuring reading time');
    } else {
        ok('the same line given enough time passes');
    }

    const blink = videoLint({
        resolved: [{ type: 'callout', layout: 'lower-third', animation: 'fadeSlide', speed: 'fast', startTime: 5, duration: 0.7, text: 'Eastern Mediterranean' }],
    });
    if (!blink.findings.some(f => f.id === 'unreadable-in-time')) {
        fail(`a 0.7s flash of 21 characters was not flagged — anything past a single word needs ${MIN_DWELL}s`);
    } else {
        ok(`a sub-${MIN_DWELL}s flash of real copy is flagged`);
    }
}

// ── 5. Small videos must not be accused ────────────────────────────────────
// Three graphics that share an entrance is not evidence of a template; it is
// three graphics. A rule that cannot tell the difference would flag every
// short video in the library.
{
    const tiny = videoLint({
        resolved: [0, 1, 2].map(i => ({
            type: 'key-takeaway', layout: 'split-panel', animation: 'fadeSlide',
            speed: 'normal', startTime: 10 + i * 30, duration: 5, text: 'Short line',
        })),
    });
    const majorityFindings = tiny.findings.filter(f => /of 3 graphics/.test(f.snippet));
    if (majorityFindings.length) {
        fail(`a 3-graphic video was accused of a majority pattern: ${majorityFindings.map(f => f.id).join(', ')}`);
    } else {
        ok('a 3-graphic video is not accused of a majority pattern');
    }
}

// ── 5b. A blank field is not a repeated choice ─────────────────────────────
// An authored composition carries its motion inside a GSAP timeline, so it
// records no `animation` and no `speed` at all. Counting those absences as a
// value produced "all 8 graphics use the entrance 'unknown' — the video never
// varies it once", which is a damning sentence about nothing. Absence and
// repetition are opposite failures and must never share a counter.
{
    const authored = (i) => ({
        type: 'authored', layout: `bespoke-${i}`, startTime: i * 10,
        duration: 5 + (i % 3) * 1.4, text: `Authored headline number ${i}`,
    });
    const recorded = (i, animation, speed) => ({
        type: i % 2 ? 'stat-block' : 'quote-card', layout: `layout-${i % 4}`,
        animation, speed, startTime: i * 10, duration: 5 + (i % 3) * 1.4,
        text: `Recorded headline ${i}`,
    });

    const blind = videoLint({ resolved: [0, 1, 2, 3, 4, 5, 6, 7].map(authored) });
    const invented = blind.findings.filter(f => /motion-monotony|pace-monotony/.test(f.id));
    if (invented.length) {
        fail(`graphics that record no entrance or speed were accused of repeating one: ${invented.map(f => f.snippet).join(' / ')}`);
    } else {
        ok('8 graphics that record no entrance or speed produce no entrance or speed finding');
    }

    // ...but a gap in the record must not become a loophole either. Six that
    // DO state the same entrance are still six, however many silent siblings
    // sit between them — and a run must break across the silence rather than
    // reach through it.
    const mixed = videoLint({
        resolved: [
            recorded(0, 'fadeSlide', 'slow'), recorded(1, 'fadeSlide', 'slow'), authored(2),
            recorded(3, 'fadeSlide', 'slow'), recorded(4, 'fadeSlide', 'slow'), authored(5),
            recorded(6, 'fadeSlide', 'slow'), recorded(7, 'fadeSlide', 'slow'), authored(8),
        ],
    });
    const stillSeen = mixed.findings.find(f => f.id === 'motion-monotony');
    if (!stillSeen) {
        fail('six graphics that all state the same entrance went unreported because three siblings stated none');
    } else if (!/6 graphics that record the entrance \(of 9\)/.test(stillSeen.snippet)) {
        fail(`the finding must name the population it counted, not imply the whole video: "${stillSeen.snippet}"`);
    } else {
        ok(`a partial population is counted and named: ${stillSeen.snippet}`);
    }
    if (/graphics in a row/.test(JSON.stringify(mixed.findings))) {
        fail('a run was allowed to reach through graphics that recorded nothing — a gap in the record is not a match');
    } else {
        ok('a run of identical entrances is broken by a graphic that records none');
    }
}

// ── 5c. Authored graphics are graded on their timeline, not on their label ─
// An authored composition's `animation`/`speed` come from the plan and describe
// a renderer that never runs — the motion the viewer sees is the GSAP timeline
// the agent wrote. The bridge measures that timeline and stamps the numbers on
// the report; this is the rule that reads them. Without it, the whole "vary the
// pace" instruction given to the composition author is ungradeable, and a fix
// nobody can measure is a fix nobody can trust.
{
    const authoredComp = (i, openSpan, beats) => ({
        type: i % 3 === 0 ? 'stat-block' : (i % 3 === 1 ? 'quote-card' : 'key-takeaway'),
        layout: `bespoke-${i}`, startTime: i * 11 + (i % 3), duration: 4.5 + (i % 4),
        text: `Authored headline number ${i}`,
        authoredMotion: { openSpan, beats, settle: openSpan + 0.4, ease: 'power2.out' },
    });

    const oneSpeed = videoLint({ resolved: [0, 1, 2, 3, 4, 5, 6, 7].map(i => authoredComp(i, 0.6, 1)) });
    const flagged = oneSpeed.findings.find(f => f.id === 'opening-metronome');
    if (!flagged) {
        fail('eight authored graphics that all take 0.60s to arrive were not flagged — this is the exact defect measured on the real build (one speed, twenty times out of twenty)');
    } else {
        ok(`authored graphics that all open at one speed are flagged: ${flagged.snippet}`);
    }

    const manySpeeds = videoLint({
        resolved: [[0, 0.25], [1, 1.10], [2, 0.45], [3, 0.80], [4, 0.30], [5, 1.40], [6, 0.60], [7, 0.20]]
            .map(([i, span]) => authoredComp(i, span, 1 + (i % 3))),
    });
    if (manySpeeds.findings.some(f => f.id === 'opening-metronome')) {
        fail('authored graphics with genuinely varied opening spans were still flagged — the rule is not measuring spread');
    } else {
        ok('authored graphics with varied opening spans pass');
    }

    // Registry MGs carry no authored timeline, so this rule must have nothing
    // to say about them — their pace really is the `speed` string, which
    // pace-monotony already judges.
    if (videoLint(machineFixture()).findings.some(f => f.id === 'opening-metronome')) {
        fail('the authored-pace rule fired on registry graphics, which ship no timeline for it to measure');
    } else {
        ok('the authored-pace rule stays silent on graphics that ship no timeline');
    }

    // The other half of the same truth, and the one that actually bit: every
    // authored composition carries the SAME plan-derived label ("speed 1",
    // "spring-scale"), so the label rules used to convict a genuinely varied
    // video of never varying. A stale label is worse than a missing one —
    // silence is only a gap, but a confident wrong verdict sends the next fix
    // in the wrong direction. Measured through the real bridge: six comps
    // opening at 0.22 / 1.10 / 0.45 / 0.85 / 0.30 / 1.35 seconds, all labelled
    // speed 1, all labelled spring-scale.
    const labelled = videoLint({
        resolved: [[0, 0.25], [1, 1.10], [2, 0.45], [3, 0.80], [4, 0.30], [5, 1.40], [6, 0.60], [7, 0.20]]
            .map(([i, span]) => ({
                ...authoredComp(i, span, 1 + (i % 3)),
                animation: 'spring-scale',   // the plan's label …
                speed: '1',                  // … for a renderer that never runs
            })),
    });
    const labelVerdict = labelled.findings.filter(
        f => f.id === 'pace-monotony' || f.id === 'motion-monotony' || f.id === 'motion-vocabulary-split'
    );
    if (labelVerdict.length) {
        fail(
            'a video whose graphics demonstrably opened at eight different speeds was still convicted of sameness, '
            + `on the strength of a label the renderer ignores: ${labelVerdict.map(f => `${f.id}: ${f.snippet}`).join(' | ')}`
        );
    } else {
        ok('identical plan labels on authored graphics no longer convict a video whose real motion varies');
    }

    // …and the conviction must still land when the real motion IS flat, even
    // though the labels are now ignored. Otherwise this fix bought silence
    // rather than accuracy.
    const flatButLabelled = videoLint({
        resolved: [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({
            ...authoredComp(i, 0.6, 1),
            animation: 'spring-scale',
            speed: '1',
        })),
    });
    if (!flatButLabelled.findings.some(f => f.id === 'opening-metronome')) {
        fail('dropping the labels also dropped the verdict — eight authored graphics at one real speed went unflagged');
    } else {
        ok('a genuinely flat authored video is still caught, on measured seconds rather than labels');
    }
}

// ── 6. The measurement helpers do what the rules claim ─────────────────────
{
    const run = longestRun(['a', 'b', 'b', 'b', 'c', 'b']);
    if (run.value !== 'b' || run.length !== 3 || run.startIndex !== 1) {
        fail(`longestRun mis-measured: ${JSON.stringify(run)}`);
    }
    const flat = coefficientOfVariation([5, 5, 5, 5]);
    const varied = coefficientOfVariation([2.4, 6.2, 8.5, 3.1]);
    if (!(flat === 0 && varied > 0.3)) {
        fail(`spread measure is wrong: identical=${flat}, varied=${varied}`);
    }
    if (failures === 0) ok('run-length and spread measures verified against known inputs');
}

// ── 7. Disabling a rule works, and every rule is reachable ─────────────────
{
    const off = videoLint(machineFixture(), { disable: ['metronome-spacing'] });
    if (off.findings.some(f => f.id === 'metronome-spacing')) {
        fail('disable list was ignored');
    }
    // Every rule must have been made to fire somewhere above. 'layout-monotony'
    // and 'unreadable-in-time' have their own dedicated fixtures because the
    // measured real distribution does not trip them.
    const exercised = new Set([...machineIds, 'layout-monotony', 'unreadable-in-time', 'opening-metronome']);
    const unreachable = VIDEO_RULE_IDS.filter(id => !exercised.has(id));
    if (unreachable.length) {
        fail(`rule(s) never exercised by any fixture: ${unreachable.join(', ')} — an unexercised rule is not a gate`);
    }
}

if (failures === 0) {
    console.log(`video-lint: OK — ${VIDEO_RULE_IDS.length} whole-video rules fire on the measured machine-made distribution and stay silent on a hand-cut one`);
} else {
    console.error(`video-lint: ${failures} failure(s)`);
}
