#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the two vision bugs found in the 2026-07-29 build.
 *
 * A) UNREADABLE SCORECARDS (src/vision/ai-vision.js)
 *    `score = 0` was the "not parsed yet" sentinel, but every parse path clamps
 *    with Math.max(1, …) — so a parsed score can never BE 0. Every "0/10" in a
 *    build log was therefore an unread scorecard, not the model's verdict.
 *    66 of 336 judged candidates (1 in 5) were binned this way; downstream it
 *    was reported as "vision API unavailable", which tripped 9 whole-race
 *    aborts and fell the build back to placeholder scenes.
 *
 * B) MISLABELLED IMAGE BYTES (src/brain/ai-provider.js)
 *    Bedrock's `format` was declared from a mime-type LABEL instead of the
 *    bytes, producing "The detected file MIME type application/octet-stream
 *    does not match the expected type image/jpeg" (400) which killed the call
 *    and every fallback behind it.
 *
 * This file locks both fixes in. It uses no network and no AWS: the vision
 * transport is stubbed, and the Bedrock guards are asserted structurally.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
let checks = 0;
function check(label, fn) {
    checks++;
    try {
        fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stub the vision transport BEFORE requiring ai-vision, so scoreVideoFrame's
// two callVisionAI sites (initial + strict retry) are fully scripted.
// ─────────────────────────────────────────────────────────────────────────────
const providerPath = require.resolve(path.join(ROOT, 'src', 'brain', 'ai-provider.js'));
let SCRIPT = [];
let CALLS = 0;
require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
        callVisionAI: async () => {
            const next = SCRIPT[Math.min(CALLS, SCRIPT.length - 1)];
            CALLS++;
            if (next instanceof Error) throw next;
            return next;
        },
        // clip-analyzer (section D) destructures this at module load.
        callVideoAI: async () => { throw new Error('stub: no network in verify'); },
        isVisionAIAvailable: () => true,
        getVisionProviderChain: () => ['stub'],
    },
};

const aiVision = require(path.join(ROOT, 'src', 'vision', 'ai-vision.js'));
const { scoreVideoFrame, _scoreFromScoreLine } = aiVision;

const FAKE_B64 = Buffer.from('not-a-real-image').toString('base64');
async function score(responses) {
    SCRIPT = Array.isArray(responses) ? responses : [responses];
    CALLS = 0;
    return scoreVideoFrame(FAKE_B64, 'image/jpeg', 'oil pipeline', { videoTopic: 'Saudi energy' });
}

(async () => {
    console.log('\n[vision-score-parse] A1 — score-line reader accepts real model decoration');
    for (const [line, want] of [
        ['7', 7], ['10', 10], ['0', 0],
        ['**7**', 7], ['`7`', 7], ['- 7', 7], ['7.', 7], ['7/10', 7],
        ['Score: 7', 7], ['score 7', 7], ['Rating: 8', 8], ['Rating 8/10', 8],
        ['Final score: 6', 6], ['Overall rating: 9', 9], ['**Score: 5**', 5],
    ]) {
        check(`"${line}" -> ${want}`, () => {
            assert.strictEqual(_scoreFromScoreLine(line), want);
        });
    }

    console.log('\n[vision-score-parse] A2 — score-line reader REFUSES numbers embedded in prose');
    for (const line of [
        'A building with 7 floors', 'Shot in 4K resolution', 'Built in 2019',
        'Stadium capacity 80,000', 'A man walks past Route 66.', '100', '42',
        'The 7 men stand still', '', '   ', 'no digits at all',
    ]) {
        check(`"${line}" -> null`, () => {
            assert.strictEqual(_scoreFromScoreLine(line), null,
                `expected null, got ${_scoreFromScoreLine(line)}`);
        });
    }

    console.log('\n[vision-score-parse] A3 — responses that parsed BEFORE still parse identically');
    for (const [resp, wantScore, wantDesc] of [
        ['A desert refinery at dusk.\n7', 7, 'A desert refinery at dusk.'],
        ['Cat video, unrelated.\n1', 1, 'Cat video, unrelated.'],
        ['Clean aerial of a pipeline.\n9', 9, 'Clean aerial of a pipeline.'],
        // clamps are unchanged: 0 floors to 1, >10 caps at 10
        ['Totally unrelated.\n0', 1, 'Totally unrelated.'],
        ['Perfect match.\n11', 10, 'Perfect match.'],
    ]) {
        const r = await score(resp);
        checks++;
        if (r.score !== wantScore || r.description !== wantDesc || r.parseError) {
            failures++;
            console.log(`  ✗ ${JSON.stringify(resp)} -> got score=${r.score} desc=${JSON.stringify(r.description)} parseError=${!!r.parseError} (want ${wantScore} / ${JSON.stringify(wantDesc)})`);
        } else {
            console.log(`  ✓ ${JSON.stringify(resp)} -> ${r.score}`);
        }
    }

    console.log('\n[vision-score-parse] A4 — formats that USED to be binned are now read');
    const rescued = [
        ['A desert refinery at dusk.\n**7**', 7],
        ['A desert refinery at dusk.\n7.', 7],
        ['A desert refinery at dusk.\n- 7', 7],
        ['A desert refinery at dusk.\nScore: 7', 7],
        ['A desert refinery at dusk.\nFinal score: 6', 6],
        ['A desert refinery at dusk. 7', 7],
        ['A desert refinery at dusk — 8', 8],
        ['A desert refinery at dusk: 5', 5],
    ];
    for (const [resp, want] of rescued) {
        const r = await score(resp);
        checks++;
        if (r.score !== want || r.parseError) {
            failures++;
            console.log(`  ✗ ${JSON.stringify(resp)} -> got score=${r.score} parseError=${!!r.parseError} (want ${want})`);
        } else {
            console.log(`  ✓ ${JSON.stringify(resp)} -> ${r.score}`);
        }
    }

    console.log('\n[vision-score-parse] A5 — prose numbers are STILL never mistaken for a score');
    const mustNotParse = [
        'A building with 7 floors',
        'Shot in 4K resolution, handheld',
        'Archive photo built in 2019',
        'Wide shot of a stadium, capacity 80,000',
        'A man walks past a sign reading Route 66.',
    ];
    for (const resp of mustNotParse) {
        // both the first call and the strict retry return the same prose
        const r = await score([resp, resp]);
        checks++;
        if (!r.parseError || r.score !== 0) {
            failures++;
            console.log(`  ✗ ${JSON.stringify(resp)} -> got score=${r.score} parseError=${!!r.parseError} (want 0 + parseError)`);
        } else {
            console.log(`  ✓ ${JSON.stringify(resp)} -> parseError (no number invented)`);
        }
    }

    console.log('\n[vision-score-parse] A6 — the strict retry rescues a score-less first answer');
    {
        const r = await score(['The frame shows a desert refinery at dusk', 'A desert refinery at dusk\n7']);
        checks++;
        if (r.score !== 7 || !r.scoreRetried || r.parseError) {
            failures++;
            console.log(`  ✗ retry rescue -> score=${r.score} retried=${!!r.scoreRetried} parseError=${!!r.parseError}`);
        } else {
            console.log('  ✓ retry rescue -> 7 (scoreRetried)');
        }
    }
    {
        // retry answers with decoration the OLD retry parser could not read
        const r = await score(['The frame shows a desert refinery at dusk', 'A desert refinery\n**8**']);
        checks++;
        if (r.score !== 8 || !r.scoreRetried) {
            failures++;
            console.log(`  ✗ retry rescue (decorated) -> score=${r.score} retried=${!!r.scoreRetried}`);
        } else {
            console.log('  ✓ retry rescue (decorated) -> 8');
        }
    }
    {
        // the OLD retry form "7 - strong fit" must still work
        const r = await score(['no score here at all', 'A desert refinery\n7 - strong scene fit']);
        checks++;
        if (r.score !== 7) {
            failures++;
            console.log(`  ✗ retry legacy form -> score=${r.score} (want 7)`);
        } else {
            console.log('  ✓ retry legacy form -> 7');
        }
    }

    console.log('\n[vision-score-parse] A7 — the two failure modes stay distinguishable');
    {
        const r = await score(['no number anywhere', 'still no number']);
        checks++;
        if (!(r.score === 0 && r.parseError === true && !r.apiError)) {
            failures++;
            console.log(`  ✗ parse failure shape -> ${JSON.stringify(r)}`);
        } else {
            console.log('  ✓ parse failure -> {score:0, parseError:true, apiError:undefined}');
        }
    }
    {
        const r = await score(new Error('connection reset'));
        checks++;
        if (!(r.score === 0 && r.apiError === true && !r.parseError)) {
            failures++;
            console.log(`  ✗ api failure shape -> ${JSON.stringify(r)}`);
        } else {
            console.log('  ✓ api failure  -> {score:0, apiError:true, parseError:undefined}');
        }
    }
    {
        // A parsed result must NEVER be 0 — that is the whole sentinel invariant.
        const r = await score('Some description.\n0');
        checks++;
        if (r.score === 0 && !r.parseError) {
            failures++;
            console.log('  ✗ SENTINEL COLLISION: a successfully parsed score came back as 0');
        } else {
            console.log('  ✓ a successfully parsed score is never 0');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-score-parse] A8 — the sentinel is not 0 in the source');
    const visionSrc = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'ai-vision.js'), 'utf8');
    check('score sentinel is `null`, not 0', () => {
        assert.ok(/let score = null;/.test(visionSrc), 'expected `let score = null;`');
        assert.ok(!/let score = 0;/.test(visionSrc), 'found a `let score = 0;` sentinel again');
    });
    check('parse-failure return still exports score 0 + parseError (caller contract)', () => {
        assert.ok(/score: 0,\s*\n\s*description,\s*\n\s*parseError: true/.test(visionSrc),
            'the external {score:0, parseError:true} contract must not change');
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-score-parse] B — Bedrock never declares a format it did not verify');
    const providerSrc = fs.readFileSync(path.join(ROOT, 'src', 'brain', 'ai-provider.js'), 'utf8');
    const codeLines = providerSrc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const code = codeLines.join('\n');

    check('the label-based format helper is gone', () => {
        assert.ok(!/^\s*function _bedrockImageFormat\s*\(/m.test(providerSrc),
            '_bedrockImageFormat was re-added — it is what caused this bug twice');
        const callers = codeLines.filter(l => l.includes('_bedrockImageFormat('));
        assert.strictEqual(callers.length, 0, `still called from: ${callers.join(' | ')}`);
    });
    check('single-image path has no `||` fallback to a declared label', () => {
        assert.ok(!/_detectImageFormatFromBytes\([^)]*\)\s*\|\|/.test(code),
            'the || fallback re-asserts the lying label exactly when the sniff matters');
    });
    check('single-image path refuses unrecognized bytes', () => {
        assert.ok(/not a recognizable jpeg\/png\/gif\/webp/.test(providerSrc),
            'expected _bedrockVision to throw on an unknown byte signature');
    });
    check('multi-frame path sniffs every frame', () => {
        assert.ok(/dropping unreadable frame/.test(providerSrc),
            'expected _bedrockVideoVision to drop frames whose bytes are not an image');
        assert.ok(/no usable frames after byte check/.test(providerSrc),
            'expected _bedrockVideoVision to bail when no frame survives');
    });
    check('normalization failure always logs', () => {
        assert.ok(!/if \(raw\.length > maxBytes\) \{\s*\n\s*console\.log\(`  \[vision\] image normalization failed/.test(providerSrc),
            'the normalization-failure log is conditional again — small corrupt frames go silent');
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-score-parse] C — an unreadable score no longer looks like a dead API');
    const fmSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8');
    const raceSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'candidate-race.js'), 'utf8');

    check('parseError sets its own flag, not postApiError', () => {
        const m = fmSrc.match(/visionResult\?\.parseError && postScore <= 0\) \{[\s\S]{0,900}?\n\s*\}/);
        assert.ok(m, 'could not locate the parseError branch in footage-manager');
        // Drop comment lines: the branch deliberately documents the old
        // `postApiError = true` line it replaced, and that text is not code.
        const branch = m[0].split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        assert.ok(/postUnparsed = true/.test(branch), 'expected `postUnparsed = true`');
        assert.ok(!/postApiError = true/.test(branch),
            'parseError is setting postApiError again — that is what aborted 9 races');
    });
    check('unreadable score returns _visionUnparsed, not _visionApiFailed', () => {
        assert.ok(/_visionUnparsed: true/.test(fmSrc), 'expected a _visionUnparsed return');
        assert.ok(/vision score unreadable/.test(fmSrc), 'expected a distinct operator-facing message');
    });
    check('the race abort counts ONLY true API failures', () => {
        const m = raceSrc.match(/if \(visionApiFailCount > 0 && visionApiFailCount >= Math\.ceil/);
        assert.ok(m, 'could not locate the vision abort rule');
        assert.ok(/_visionUnparsed/.test(raceSrc), 'expected the unparsed count to be tracked for visibility');
        const abortBlock = raceSrc.slice(raceSrc.indexOf('if (visionApiFailCount > 0'), raceSrc.indexOf('Storyblocks auth dead'));
        assert.ok(!/_visionUnparsed|visionUnparsedCount/.test(abortBlock),
            'unreadable scores are feeding the abort rule again');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // D) THE SAME BUG IN THE DEEP CLIP CHECK (src/media/clip-analyzer.js)
    //    `_parseClipAnalysis` and `_parseWindowValidation` carried the identical
    //    `score: 0` sentinel against the identical Math.max(1, …) clamp. Worse,
    //    the clip parser's fallback took the FIRST number anywhere in the reply,
    //    so "4K aerial drone shot" scored 4 and "3 workers" scored 3 — a real
    //    verdict invented out of prose, below every accept floor.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-score-parse] D1 — clip score-line reader accepts real model decoration');
    const clip = require(path.join(ROOT, 'src', 'media', 'clip-analyzer.js'));
    const { _parseClipAnalysis, _parseWindowValidation, _scoreFromClipLine } = clip;
    for (const [line, want] of [
        ['7', 7], ['10', 10], ['0', 0],
        ['**7**', 7], ['- 7', 7], ['7.', 7], ['7/10', 7],
        ['SCORE: 7', 7], ['Score 7', 7], ['Rating: 8', 8], ['Final score: 6', 6],
    ]) {
        check(`"${line}" -> ${want}`, () => {
            assert.strictEqual(_scoreFromClipLine(line), want);
        });
    }
    for (const line of [
        'Shot in 4K resolution', '3 workers laying pipe', 'Built in 2019',
        'CONTENT: a wide aerial of a trench', 'MOTION: good', '', 'capacity 80,000',
    ]) {
        check(`"${line}" -> null`, () => {
            assert.strictEqual(_scoreFromClipLine(line), null,
                `expected null, got ${_scoreFromClipLine(line)}`);
        });
    }

    console.log('\n[vision-score-parse] D2 — clip replies that parsed BEFORE still parse identically');
    const CANON = 'CONTENT: A trench with clay pipe.\nRELEVANCE: matches the scene.\nISSUES: none\nMOTION: good\nTRIM: all good\n';
    for (const [resp, want] of [
        [`${CANON}SCORE: 7`, 7],
        [`${CANON}SCORE: 10`, 10],
        [`${CANON}SCORE: 1`, 1],
        [`${CANON}SCORE: 0`, 1],   // clamp unchanged: 0 floors to 1
        [`${CANON}SCORE: 11`, 10], // clamp unchanged: >10 caps at 10
    ]) {
        check(`${JSON.stringify(resp.slice(-12))} -> ${want}`, () => {
            const r = _parseClipAnalysis(resp);
            assert.strictEqual(r.score, want);
            assert.ok(!r.parseError, 'a readable reply must not be flagged parseError');
            assert.strictEqual(r.motion, 'good', 'the other fields must be untouched');
        });
    }

    console.log('\n[vision-score-parse] D3 — clip replies that USED to be misread are now read');
    for (const [resp, want, why] of [
        [`${CANON}**SCORE: 8**`, 8, 'markdown bold around the score line'],
        [`${CANON}- SCORE: 8`, 8, 'list marker'],
        [`${CANON}Final score: 6`, 6, 'relabelled score line'],
        [`${CANON}8/10`, 8, 'bare N/10'],
        [`${CANON}8`, 8, 'bare number on its own line'],
        ['CONTENT: 4K aerial of a trench. SCORE: 8', 8, 'all on one line, "4K" first'],
    ]) {
        check(`${why} -> ${want}`, () => {
            const r = _parseClipAnalysis(resp);
            assert.strictEqual(r.score, want, `got ${r.score}`);
            assert.ok(!r.parseError);
        });
    }

    console.log('\n[vision-score-parse] D4 — a number in prose is NEVER invented as a score');
    for (const resp of [
        'CONTENT: 4K aerial drone shot of a trench.',
        'CONTENT: 3 workers laying clay pipe.\nMOTION: good',
        'CONTENT: Archive footage from 2019.\nISSUES: none',
        'CONTENT: A stadium holding 80,000 people.',
    ]) {
        check(`${JSON.stringify(resp.slice(0, 40))} -> parseError`, () => {
            const r = _parseClipAnalysis(resp);
            assert.strictEqual(r.score, 0, `invented a score of ${r.score} out of prose`);
            assert.strictEqual(r.parseError, true, 'an unreadable reply must say so');
        });
    }

    console.log('\n[vision-score-parse] D5 — the clip sentinel invariant holds');
    check('a successfully parsed clip score is never 0', () => {
        const r = _parseClipAnalysis(`${CANON}SCORE: 0`);
        assert.ok(!(r.score === 0 && !r.parseError),
            'SENTINEL COLLISION: a parsed clip score came back as 0');
    });
    check('the external contract is unchanged (score 0 + parseError, never null)', () => {
        const r = _parseClipAnalysis('CONTENT: nothing numeric here at all.');
        assert.strictEqual(typeof r.score, 'number',
            'footage-manager gates on `typeof score !== "number"` — null would silently change the path');
        assert.strictEqual(r.score, 0);
        assert.strictEqual(r.parseError, true);
    });
    check('an empty reply is still null (not a zero-scored clip)', () => {
        assert.strictEqual(_parseClipAnalysis(''), null);
        assert.strictEqual(_parseClipAnalysis(null), null);
    });

    console.log('\n[vision-score-parse] D6 — the window judge reads the same decorations');
    check('decorated score line is read', () => {
        const r = _parseWindowValidation('WINDOW: pass\nISSUES: none\nREASON: clean\n**SCORE: 8**');
        assert.strictEqual(r.score, 8);
        assert.ok(r.ok, 'a clean explicit PASS at 8/10 must pass');
    });
    check('bare trailing number is read', () => {
        const r = _parseWindowValidation('ISSUES: none\nREASON: clean handheld shot\n7');
        assert.strictEqual(r.score, 7);
        assert.ok(r.ok, 'no explicit WINDOW line, but 7 >= 6 with no hard issue');
    });
    check('an unreadable window reply is flagged, not scored', () => {
        const r = _parseWindowValidation('ISSUES: none\nREASON: looks fine to me');
        assert.strictEqual(r.score, 0);
        assert.strictEqual(r.parseError, true);
    });
    check('an explicit PASS with no readable score still passes (unchanged)', () => {
        const r = _parseWindowValidation('WINDOW: pass\nISSUES: none\nREASON: clean');
        assert.ok(r.ok, 'the !score permissive branch must not change');
    });
    check('an explicit REJECT still rejects (unchanged)', () => {
        const r = _parseWindowValidation('WINDOW: reject\nISSUES: news ticker\nREASON: broadcast\nSCORE: 9');
        assert.ok(!r.ok);
    });

    console.log('\n[vision-score-parse] D7 — the source no longer carries the old shapes');
    const clipSrc = fs.readFileSync(path.join(ROOT, 'src', 'media', 'clip-analyzer.js'), 'utf8');
    check('no `score: 0` sentinel in either parser', () => {
        // Scope to the two parser bodies: the early-return objects elsewhere in
        // the file ("window too short", "budget exhausted") legitimately carry
        // score 0 with an explicit reason — they are refusals, not sentinels.
        for (const fn of ['_parseClipAnalysis', '_parseWindowValidation']) {
            const start = clipSrc.indexOf(`function ${fn}(`);
            assert.ok(start > 0, `${fn} not found — this gate would pass vacuously`);
            const body = clipSrc.slice(start, clipSrc.indexOf('\n}', start));
            const init = body.slice(0, body.indexOf('};'));
            assert.ok(/score: null,/.test(init), `${fn} must initialise its score sentinel to null`);
            assert.ok(!/score: 0,/.test(init),
                `${fn} re-initialises score to 0 — that is the sentinel collision`);
        }
    });
    check('the first-number-anywhere fallback is gone', () => {
        assert.ok(!/response\.match\(\/\(\\d\+\)\\s\*\(\?:\\\/\\s\*10\)\?\/\)/.test(clipSrc),
            'the greedy first-number fallback is back — it scores "4K" as 4');
    });
    check('an unreadable merged reply re-scores instead of binning', () => {
        assert.ok(/clipAnalysis\.parseError && !mapRescued && !sanityRescued/.test(fmSrc),
            'the merged path must fall through to per-frame scoring on a parse error, '
            + 'not report the unread scorecard as a 0');
        const m = fmSrc.match(/if \(clipAnalysis\.parseError && !mapRescued && !sanityRescued\) \{[\s\S]{0,300}?\n\s*\}/);
        assert.ok(m && /return null;/.test(m[0]), 'expected the branch to return null (per-frame fall-through)');
    });

    console.log(`\n[vision-score-parse] ${checks - failures}/${checks} checks passed`);
    if (failures) {
        console.log(`[vision-score-parse] FAILED — ${failures} check(s)\n`);
        process.exit(1);
    }
    console.log('[vision-score-parse] OK\n');
})().catch((err) => {
    console.error('[vision-score-parse] CRASHED:', err);
    process.exit(1);
});
