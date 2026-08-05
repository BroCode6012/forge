#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the CHART DATA HAND-OFF.
 *
 * THE WASTE THIS LOCKS OUT (measured on the 2026-07-31 build)
 *   A data chart is thrown away when its content carries no "Label: Number"
 *   pairs. That gate kept firing on charts whose numbers were sitting one field
 *   away, inside the scene's own narration — the planner had picked the right
 *   graphic for the right beat and simply hadn't copied the digits across.
 *
 *   Throwing it away cost twice over. The scene lost its graphic, AND the
 *   rejected chart's own title was handed to the footage hunter as a stock
 *   search term. "Coefficient of Performance" is a metric, not something a
 *   camera can point at, so the scene spent its entire budget proving stock
 *   libraries have no footage of it: five such scenes took five of the nine
 *   coverage-rescue slots at 225 seconds each.
 *
 * THE TWO PROPERTIES THAT MUST NEVER REGRESS
 *   1. RECOVERY CAN ADD A CHART, NEVER DAMAGE ONE. A chart with invented labels
 *      is worse than no chart — it is the one failure a viewer can actually
 *      read. So recovery must return null on anything it cannot prove, and
 *      whatever it does return must still clear the very same validator every
 *      other chart clears. Section A proves the rejections; section B proves
 *      the two gates share one module and re-validate its output.
 *   2. A CARD BACKGROUND IS JUDGED FOR SEARCHABILITY LIKE ANY OTHER FOOTAGE.
 *      Section C. That judgement is where an un-findable query gets rewritten
 *      into findable B-roll, and card backgrounds were structurally excluded
 *      from it — which is why a chart title reached the downloader unjudged.
 *
 * Section D covers the sweep de-duplication that was wasting rescue slots on
 * scenes it had already rescued.
 *
 * No network and no AI: the one AI call in this path is stubbed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

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
async function checkAsync(label, fn) {
    checks++;
    try {
        await fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

// Stub the one AI call before anything requires it.
let AI_REPLY = { rescued: [] };
let AI_CALLS = 0;
let LAST_ROWS = '';
{
    const resolved = require.resolve(path.join(ROOT, 'src', 'brain', 'strict-json.js'));
    require.cache[resolved] = {
        id: resolved, filename: resolved, loaded: true, children: [], paths: [],
        exports: {
            callAIJson: async (prompt) => { AI_CALLS++; LAST_ROWS = String(prompt || ''); return AI_REPLY; },
            parseJsonObject: (s) => JSON.parse(s),
        },
    };
}

const { recoverDataPairs } = require(path.join(ROOT, 'src', 'agents', 'mg-data-recovery.js'));
const { applyRetrievabilityRescue } = require(path.join(ROOT, 'src', 'media', 'retrievability-rescue.js'));
const coverage = require(path.join(ROOT, 'src', 'media', 'scene-coverage.js'));

const narr = (text) => ({ index: 1, text });

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nA) Recovery is deliberately hard to satisfy');
// ═════════════════════════════════════════════════════════════════════════════

check('finds the pairs a comparison sentence really states', () => {
    const r = recoverDataPairs(narr('The system reached a coefficient of performance of 28.7, compared to 3.5 for a standard heat pump.'), 'barChart', 'Coefficient of Performance');
    assert.ok(r, 'a plainly stated comparison was not recovered');
    assert.strictEqual(r.content, 'Coefficient of Performance | Coefficient of Performance: 28.7 | Standard Heat Pump: 3.5');
    assert.strictEqual(r.source, 'narration');
});

check('the second number is named after ITSELF, not after the first', () => {
    // The whole fix. Without a clause window the 3.5 above inherits the first
    // number's words, both bars get named "Coefficient of Performance", and the
    // chart passes every check while being wrong on screen.
    const r = recoverDataPairs(narr('Norway hit 82% adoption while Sweden sat at 54% adoption.'), 'barChart', 'Adoption');
    assert.ok(r);
    const labels = r.pairs.map(p => p.label);
    assert.deepStrictEqual(labels, ['Norway', 'Sweden'], `labels leaked across the clause boundary: ${labels.join(' / ')}`);
});

check('a reporting verb never becomes part of a bar label', () => {
    const r = recoverDataPairs(narr('Poland now spends 4.2% of GDP on defence, against 1.5% for Germany.'), 'barChart', 'Defence Spending');
    assert.ok(r);
    for (const p of r.pairs) {
        assert.ok(!/\b(spends|hit|sat|reached|recorded)\b/i.test(p.label), `verb survived into label "${p.label}"`);
    }
});

check('two bars can never share a name', () => {
    const r = recoverDataPairs(narr('The northern front recorded 1,200 casualties compared with 340 in the south.'), 'barChart', 'Casualties');
    assert.ok(r);
    const lower = r.pairs.map(p => p.label.toLowerCase());
    assert.strictEqual(new Set(lower).size, lower.length, `duplicate bar labels: ${lower.join(' / ')}`);
});

const REJECTS = [
    ['no numbers at all', 'The engineers were quietly confident about the result.'],
    ['a single number is not a comparison', 'Roughly 40% of the grid now runs on wind.'],
    ['the same value twice charts as one bar', 'Both plants produced 12 megawatts and 12 megawatts respectively.'],
    ['numbers in different sentences are two separate facts', 'The north site made 40 units. Separately, morale improved.'],
    ['a unit is an axis, not a bar', 'It reached 20 percent and then 30 percent.'],
];
for (const [label, text] of REJECTS) {
    check(`rejects: ${label}`, () => {
        assert.strictEqual(recoverDataPairs(narr(text), 'barChart', 'Something'), null,
            'recovery invented a chart it could not prove');
    });
}

check('only the pair-shaped charts are recoverable', () => {
    const text = 'Norway hit 82% adoption while Sweden sat at 54% adoption.';
    for (const type of ['barChart', 'donutChart', 'rankingList', 'timeline']) {
        assert.ok(recoverDataPairs(narr(text), type, 'Adoption'), `${type} should be recoverable`);
    }
    // A bulletList recovered from prose is sentence fragments pretending to be
    // bullets; a comparisonCard needs rhetoric no numeric scan can supply.
    for (const type of ['bulletList', 'comparisonCard', 'quoteCard', 'statCard']) {
        assert.strictEqual(recoverDataPairs(narr(text), type, 'Adoption'), null, `${type} must not be recovered`);
    }
});

check('kill switch MG_DATA_RECOVERY=0 turns it off completely', () => {
    process.env.MG_DATA_RECOVERY = '0';
    try {
        assert.strictEqual(recoverDataPairs(narr('Norway hit 82% adoption while Sweden sat at 54% adoption.'), 'barChart', 'Adoption'), null);
    } finally {
        delete process.env.MG_DATA_RECOVERY;
    }
});

check('the richest field wins — the MG\'s own content beats the narration', () => {
    const scene = { index: 3, text: 'Norway hit 82% adoption while Sweden sat at 54% adoption.' };
    const r = recoverDataPairs(scene, 'barChart', 'Adoption | Norway: 91 | Denmark: 12');
    assert.ok(r);
    assert.strictEqual(r.source, 'mgContent', 'a usable field was skipped in favour of the noisiest one');
});

check('no topic, niche or subject word is hardcoded anywhere in the module', () => {
    const src = read('src', 'agents', 'mg-data-recovery.js');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const word of ['nature', 'crime', 'politics', 'military', 'explainer', 'news.', 'heat pump', 'turbine', 'wolves']) {
        assert.ok(!body.toLowerCase().includes(word.toLowerCase()),
            `"${word}" is subject knowledge — this module must behave identically for every niche`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nB) Both gates share ONE recovery, and re-validate what it returns');
// ═════════════════════════════════════════════════════════════════════════════
// Two independent gates rejected these charts. Two independent recoveries would
// drift apart the first time either was touched, and the user's standing rule is
// that a fix must not need re-fixing later.

const ORCH = read('src', 'pipeline', 'build-orchestrator.js');
const AIMG = read('src', 'agents', 'ai-motion-graphics.js');

check('the orchestrator gate uses the shared module', () => {
    assert.ok(/require\(['"]\.\.\/agents\/mg-data-recovery['"]\)/.test(ORCH), 'orchestrator does not require the shared recovery');
    assert.ok(/recoverDataPairs\(s,\s*mgType,\s*mgContent/.test(ORCH), 'orchestrator never calls it');
});

check('the motion-graphics gate uses the SAME module', () => {
    assert.ok(/require\(['"]\.\/mg-data-recovery['"]\)/.test(AIMG), 'ai-motion-graphics does not require the shared recovery');
    assert.ok(/recoverDataPairs\(scene,\s*mgType,\s*mgContent\)/.test(AIMG), 'ai-motion-graphics never calls it');
});

check('the orchestrator tries recovery BEFORE repairing the graphic away', () => {
    const at = ORCH.indexOf('recoverDataPairs(s,');
    const repairAt = ORCH.indexOf('_repairInvalidFullscreenMG(s, mgType, mgContent, res.reason)');
    assert.ok(at > 0 && repairAt > at, 'recovery must run before the repair, or it can never save anything');
});

check('recovered content must clear the same validator every other chart clears', () => {
    assert.ok(/_validateDataMGContent\(mgType,\s*recovered\.content\)\.valid/.test(ORCH),
        'recovery output is trusted without re-validation — that is how a broken chart gets through');
});

check('the motion-graphics gate still rejects when recovery finds nothing', () => {
    const at = AIMG.indexOf('recoverDataPairs(scene,');
    const tail = AIMG.slice(at, at + 900);
    assert.ok(/rejected — no real data pairs/.test(tail), 'the original rejection path was removed instead of kept as the fallback');
});

// Behavioural: the shared module decides both, so proving it on the exact
// strings the gates parse proves the gates.
check('a chart whose numbers are in the narration survives, in the gates\' own format', () => {
    const scene = { index: 7, text: 'The system reached a coefficient of performance of 28.7, compared to 3.5 for a standard heat pump.' };
    const r = recoverDataPairs(scene, 'barChart', 'Coefficient of Performance');
    assert.ok(r);
    // Both gates read "<Title> | Label: Value | Label: Value".
    const segs = r.content.split(/\s*\|\s*/);
    const pairs = segs.filter(s => /^[^:]+:\s*[\d.,%$+\-]+/.test(s));
    assert.ok(pairs.length >= 2, `the recovered string is not in the format the gates parse: "${r.content}"`);
    assert.ok(!/^[^:]+:\s*[\d.,%$+\-]+/.test(segs[0]), 'the first segment must stay a human title');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nC) A card background is judged for searchability like any footage');
// ═════════════════════════════════════════════════════════════════════════════

const card = (over = {}) => ({
    index: 5,
    templateHint: 'factCard: Coefficient of Performance',
    templateBgQuery: 'Coefficient of Performance',
    text: 'Heat pumps move heat rather than making it.',
    ...over,
});

(async () => {
    const resetAI = () => { AI_CALLS = 0; AI_REPLY = { rescued: [] }; };

    await checkAsync('the rejected chart\'s background query now reaches the judge', async () => {
        resetAI();
        await applyRetrievabilityRescue([card()], { nicheId: 'explainer.tech' }, { log: false });
        assert.strictEqual(AI_CALLS, 1, 'card backgrounds are still invisible to the searchability judge');
        assert.ok(/Coefficient of Performance/.test(LAST_ROWS), 'the card background was not among the judged queries');
    });

    await checkAsync('an un-findable card background is rewritten into findable B-roll', async () => {
        resetAI();
        AI_REPLY = { rescued: [{ i: 5, q: 'modern heat pump unit outside a house', why: 'metric, not a filmable subject' }] };
        const s = card();
        const out = await applyRetrievabilityRescue([s], {}, { log: false });
        assert.strictEqual(s.templateBgQuery, 'modern heat pump unit outside a house');
        assert.strictEqual(out.rescued.length, 1);
    });

    await checkAsync('rewriting a card background does NOT turn it into a footage scene', async () => {
        resetAI();
        AI_REPLY = { rescued: [{ i: 5, q: 'modern heat pump unit outside a house', why: 'x' }] };
        const s = card();
        await applyRetrievabilityRescue([s], {}, { log: false });
        for (const field of ['keyword', 'stockQuery', 'searchKeyword', 'webQuery']) {
            assert.ok(!s[field], `the card grew a downloader field "${field}" — that is a different decision than this pass may make`);
        }
        assert.ok(!s.sourceHint, 'the card had a source lane forced onto it');
    });

    await checkAsync('a real footage scene is rewritten exactly as before (unchanged path)', async () => {
        resetAI();
        AI_REPLY = { rescued: [{ i: 9, q: 'wind turbines on a ridge', why: 'x' }] };
        const s = { index: 9, keyword: 'RightGrip wrench bolt contact', stockQuery: 'RightGrip wrench bolt contact', text: 'n', mediaIntent: { policy: {} } };
        await applyRetrievabilityRescue([s], {}, { log: false });
        assert.strictEqual(s.keyword, 'wind turbines on a ridge');
        assert.strictEqual(s.stockQuery, 'wind turbines on a ridge');
        assert.strictEqual(s.webQuery, 'wind turbines on a ridge');
        assert.strictEqual(s.mediaIntent.policy.allowStockFallback, true, 'the footage path lost its lane unlock');
    });

    await checkAsync('a scene still owned by a graphic is never sent to the judge', async () => {
        resetAI();
        await applyRetrievabilityRescue([{ index: 2, fullscreenMG: 'barChart: A: 1 | B: 2', templateBgQuery: 'x y z', text: 'n' }], {}, { log: false });
        assert.strictEqual(AI_CALLS, 0, 'a live graphic scene needs no footage and must not be judged for it');
    });

    await checkAsync('a card with no background query costs nothing', async () => {
        resetAI();
        await applyRetrievabilityRescue([card({ templateBgQuery: '' })], {}, { log: false });
        assert.strictEqual(AI_CALLS, 0);
    });

    // ═════════════════════════════════════════════════════════════════════════
    console.log('\nD) The rescue sweep never spends a slot on the same scene twice');
    // ═════════════════════════════════════════════════════════════════════════
    // The sweep's universe is built by concatenating lists. A scene in two of
    // them arrived twice, and two of the nine rescue slots on the 2026-07-31
    // build went to scenes 1 and 56 for the second time — ~7 minutes buying
    // nothing, while shorter broken scenes were dropped for lack of a slot.

    const blank = (index) => ({ index, startTime: 0, endTime: 8, mediaFile: null });

    check('the same scene object twice counts once', () => {
        const s = blank(1);
        const found = coverage.findUncovered([s, s, blank(2)], { graphics: [] });
        assert.strictEqual(found.length, 2, `the duplicate took a second rescue slot (${found.length} targets)`);
    });

    check('two copies of the same scene NUMBER count once', () => {
        const found = coverage.findUncovered([blank(1), { ...blank(1) }, blank(56)], { graphics: [] });
        assert.strictEqual(found.length, 2, 'a re-wrapped scene is still the same beat on the timeline');
        assert.deepStrictEqual(found.map(f => f.scene.index), [1, 56]);
    });

    check('the first copy wins — the one the renderer will actually draw', () => {
        const onTrack = { ...blank(1), _which: 'onTrack' };
        const offTrack = { ...blank(1), _which: 'offTrack' };
        const found = coverage.findUncovered([onTrack, offTrack], { graphics: [] });
        assert.strictEqual(found[0].scene._which, 'onTrack');
    });

    check('genuinely distinct scenes are all still rescued', () => {
        const found = coverage.findUncovered([blank(1), blank(2), blank(3)], { graphics: [] });
        assert.strictEqual(found.length, 3, 'de-duplication must never swallow a real broken scene');
    });

    check('the audit line and the sweep can never disagree on the count', () => {
        const s = blank(1);
        const universe = [s, s, blank(2)];
        const sum = coverage.summarize(universe, { graphics: [] });
        const found = coverage.findUncovered(universe, { graphics: [] });
        assert.strictEqual(sum.total, 2, 'the audit still double-counts');
        assert.strictEqual(sum.uncovered, found.length, 'the audit and the rescue read different numbers');
    });

    console.log(`\n${failures === 0 ? '✅' : '❌'} Chart data hand-off: ${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
})();
