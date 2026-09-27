#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the two-judge footage panel (src/vision/ai-vision.js).
 *
 * WHY THE PANEL EXISTS
 * --------------------
 * Scoring a candidate frame decides whether a scene gets real footage or a
 * placeholder card, and every judge this account can call fails in one of two
 * directions:
 *
 *   OVER-LITERAL  (Qwen3-VL, Nova Pro) — rejects footage that is fine.
 *                 Costs the whole scene. Unrecoverable.
 *   OVER-LENIENT  (Nova Lite)          — passes AI renders and watermarks.
 *                 Costs one weak clip. Recoverable (retry / referee / swap).
 *
 * The one model that got all 11 bench frames right — Sonnet 4.6 — cannot carry
 * a build: this account's vision quota for it measured 4-16 frames/minute, and
 * a real 50-scene run spent ~2 hours in the rate limiter and reached scene 9.
 *
 * So two fast judges score the same frame and the scores are AVERAGED. That is
 * not redundancy — it is error cancellation: the two models' mistakes point in
 * opposite directions, so alone they score 8/11 each and averaged they score
 * 10/11, at ~100 frames/minute and ~1/5 of Sonnet's cost.
 *
 * WHAT THIS GATE DOES
 * -------------------
 * It replays logs/vision-judge-bench.json — 11 hand-labelled real race frames,
 * with every model's ACTUAL recorded score — through the real _panelVerdict().
 * No network, no AWS, no stubbed arithmetic: if someone changes how votes are
 * combined, the recorded numbers stop reproducing the measured accuracy and
 * this fails.
 *
 * Re-record the bench with `node scripts/vision-judge-bench.js` (that one DOES
 * spend money and needs the frames in <project>/.bench-frames).
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
// Stub the vision transport BEFORE requiring ai-vision. _judgePanel captures
// isVisionProviderUsable at require time, so the stub has to be in place first.
// ─────────────────────────────────────────────────────────────────────────────
const providerPath = require.resolve(path.join(ROOT, 'src', 'brain', 'ai-provider.js'));
let USABLE = new Set();
// Scripted transport: ANSWERS maps a pinned provider id (or '*' for an unpinned
// chain call) to the text that judge returns. CALLS records what was asked of whom,
// which is how section J proves the panel actually ran instead of the old path.
let ANSWERS = {};
let CALLS = [];
require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
        callVisionAI: async (prompt, b64, mime, options = {}) => {
            const seat = options.visionProvider || '*';
            CALLS.push(seat);
            const answer = ANSWERS[seat];
            if (answer === undefined) throw new Error(`stub: no scripted answer for "${seat}"`);
            if (answer instanceof Error) throw answer;
            return answer;
        },
        callVideoAI: async () => { throw new Error('stub: no network in verify'); },
        isVisionAIAvailable: () => true,
        getVisionProviderChain: () => ['stub'],
        isVisionProviderUsable: (p) => USABLE.has(p),
    },
};

const { _panelVerdict, _judgePanel, scoreVideoFrame } = require(path.join(ROOT, 'src', 'vision', 'ai-vision.js'));

// The two seats the Bedrock backend ships with, and the escalation judge.
const SEAT_LITE = 'us.amazon.nova-lite-v1:0';
const SEAT_QWEN = 'qwen.qwen3-vl-235b-a22b';
const SEAT_PRO = 'us.amazon.nova-pro-v1:0';
const SONNET = 'us.anthropic.claude-sonnet-4-6';

const BENCH_PATH = path.join(ROOT, 'logs', 'vision-judge-bench.json');

(async () => {
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] A — the bench the design rests on is still here');

    let bench = null;
    check('logs/vision-judge-bench.json exists and is readable', () => {
        assert.ok(fs.existsSync(BENCH_PATH),
            'the bench is the ONLY evidence that averaging beats either judge alone. '
            + 'Re-record it with `node scripts/vision-judge-bench.js` before deleting it.');
        bench = JSON.parse(fs.readFileSync(BENCH_PATH, 'utf8'));
    });

    if (!bench) {
        console.log('\n[vision-judge-panel] FAILED — no bench to replay\n');
        process.exit(1);
    }

    const THRESHOLD = bench.threshold;
    check('the bench records the accept threshold it was scored against', () => {
        assert.strictEqual(typeof THRESHOLD, 'number');
        assert.ok(THRESHOLD >= 1 && THRESHOLD <= 10, `implausible threshold ${THRESHOLD}`);
    });
    check('the bench has both PASS and REJECT cases', () => {
        // A bench of only-PASS cases would make an always-10 judge look perfect,
        // and a bench of only-REJECT would make an always-1 judge look perfect.
        const pass = bench.cases.filter(c => c.band === 'PASS').length;
        const rej = bench.cases.filter(c => c.band === 'REJECT').length;
        assert.ok(pass >= 3, `only ${pass} PASS cases — cannot detect an over-literal judge`);
        assert.ok(rej >= 3, `only ${rej} REJECT cases — cannot detect an over-lenient judge`);
    });

    // model id -> { caseId -> score }
    const byModel = new Map();
    for (const key of Object.keys(bench.raw || {})) {
        const row = bench.raw[key];
        const scores = new Map();
        for (const r of row.results || []) {
            if (typeof r.score === 'number' && r.score > 0 && !r.parseError) scores.set(r.case, r.score);
        }
        byModel.set(row.id, scores);
    }

    check('both panel seats are present in the bench', () => {
        for (const seat of [SEAT_LITE, SEAT_QWEN]) {
            assert.ok(byModel.has(seat), `${seat} was never benched — its accuracy is unmeasured`);
            assert.strictEqual(byModel.get(seat).size, bench.cases.length,
                `${seat} has ${byModel.get(seat).size}/${bench.cases.length} readable scores`);
        }
    });

    /** How many of the 11 cases does this set of scores get right? */
    function accuracy(scoreFor) {
        let ok = 0;
        const misses = [];
        for (const c of bench.cases) {
            const s = scoreFor(c.id);
            if (s == null) continue;
            const kept = s >= THRESHOLD;
            const shouldKeep = c.band === 'PASS';
            if (kept === shouldKeep) ok++;
            else misses.push(`${c.id} (${c.band}, scored ${s})`);
        }
        return { ok, total: bench.cases.length, misses };
    }

    const solo = {
        lite: accuracy(id => byModel.get(SEAT_LITE).get(id)),
        qwen: accuracy(id => byModel.get(SEAT_QWEN).get(id)),
    };

    /** Run the REAL panel combiner over the recorded votes for one case. */
    function panelScore(caseId, seats = [SEAT_LITE, SEAT_QWEN]) {
        const votes = seats
            .map(m => ({ provider: m, score: byModel.get(m).get(caseId), description: '' }))
            .filter(v => typeof v.score === 'number');
        return _panelVerdict(votes, false).score;
    }
    const panel = accuracy(id => panelScore(id));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] B — averaging still beats either judge alone');
    console.log(`      Nova Lite alone : ${solo.lite.ok}/${solo.lite.total}`);
    console.log(`      Qwen3-VL alone  : ${solo.qwen.ok}/${solo.qwen.total}`);
    console.log(`      PANEL (averaged): ${panel.ok}/${panel.total}`);

    check('the panel is strictly better than Nova Lite alone', () => {
        assert.ok(panel.ok > solo.lite.ok,
            `panel ${panel.ok}/${panel.total} vs Lite ${solo.lite.ok} — two calls per frame must buy something`);
    });
    check('the panel is strictly better than Qwen3-VL alone', () => {
        assert.ok(panel.ok > solo.qwen.ok,
            `panel ${panel.ok}/${panel.total} vs Qwen ${solo.qwen.ok} — two calls per frame must buy something`);
    });
    check('the panel reproduces its measured 10/11', () => {
        assert.ok(panel.ok >= 10,
            `panel dropped to ${panel.ok}/${panel.total}; missed: ${panel.misses.join(', ') || '(none)'}`);
    });
    check('the panel keeps EVERY good clip (no new placeholder cards)', () => {
        // This is the asymmetry the whole design turns on. A regression that
        // costs a REJECT is a weak clip; one that costs a PASS is a dead scene.
        const lost = bench.cases
            .filter(c => c.band === 'PASS' && panelScore(c.id) < THRESHOLD)
            .map(c => c.id);
        assert.strictEqual(lost.length, 0,
            `the panel now rejects usable footage: ${lost.join(', ')} — these become placeholder cards`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] C — the average is FLOORED, never rounded');
    // Every gate downstream asks "is score >= N" for a whole N, and
    // floor(x) >= N is true exactly when x >= N. So flooring preserves the
    // panel's real decision at every threshold that exists. Rounding does not:
    // an average of 5.5 rounds up and admits a clip BOTH judges put below the
    // bar. That is a real bench case, not a hypothetical.
    check('a half-point average rounds DOWN (5 + 6 -> 5)', () => {
        const v = _panelVerdict([
            { provider: 'a', score: 5, description: '' },
            { provider: 'b', score: 6, description: '' },
        ], false);
        assert.strictEqual(v.score, 5, 'Math.round would give 6 and pass a clip on one judge\'s vote');
        assert.strictEqual(v.panelAverage, 5.5, 'the true average must still be reported for diagnostics');
    });
    check('a clip both judges put below the bar stays rejected', () => {
        const roundMisses = accuracy((id) => {
            const a = byModel.get(SEAT_LITE).get(id);
            const b = byModel.get(SEAT_QWEN).get(id);
            return Math.round((a + b) / 2);
        });
        assert.ok(panel.ok > roundMisses.ok,
            `rounding scores ${roundMisses.ok}/${panel.total} vs flooring ${panel.ok} — `
            + 'if these ever tie, this gate has stopped proving anything and the bench needs a wider case');
    });
    check('a unanimous verdict is passed through untouched', () => {
        for (const s of [1, 4, 6, 8, 10]) {
            const v = _panelVerdict([
                { provider: 'a', score: s, description: '' },
                { provider: 'b', score: s, description: '' },
            ], false);
            assert.strictEqual(v.score, s, `two ${s}s must average to ${s}, got ${v.score}`);
        }
    });
    check('the verdict stays inside 1-10', () => {
        assert.strictEqual(_panelVerdict([{ provider: 'a', score: 1, description: '' }], false).score, 1);
        assert.strictEqual(_panelVerdict([{ provider: 'a', score: 10, description: '' }], false).score, 10);
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] D — the verdict is shaped like a single-judge one');
    // Every caller of scoreVideoFrame reads .score / .description / .apiError /
    // .parseError. The panel adds fields; it must not change or drop those.
    check('verdict carries score + description', () => {
        const v = _panelVerdict([
            { provider: 'a', score: 7, description: 'a red barn in a green field' },
            { provider: 'b', score: 6, description: '' },
        ], false);
        assert.strictEqual(typeof v.score, 'number');
        assert.strictEqual(v.description, 'a red barn in a green field',
            'an empty description must never win over a real one');
        assert.ok(!('apiError' in v) && !('parseError' in v),
            'a successful panel verdict must not carry a failure flag');
    });
    check('the description comes from the judge closest to the average', () => {
        // The kept text has to match the kept number, or the operator log and
        // the memory bank record a reason that belongs to a different verdict.
        const v = _panelVerdict([
            { provider: 'a', score: 9, description: 'flawless' },
            { provider: 'b', score: 4, description: 'watermark bottom-right' },
            { provider: 'c', score: 5, description: 'soft focus' },
        ], false);
        assert.strictEqual(v.description, 'soft focus', `got "${v.description}" (avg 6.0, closest is 5)`);
    });
    check('per-judge scores are kept for diagnostics', () => {
        const v = _panelVerdict([
            { provider: SEAT_LITE, score: 8, description: '' },
            { provider: SEAT_QWEN, score: 4, description: '' },
        ], false);
        assert.ok(Array.isArray(v.panel) && v.panel.length === 2, 'expected a .panel breakdown');
        assert.deepStrictEqual(v.panel.map(p => p.score), [8, 4]);
        assert.strictEqual(v.panelAverage, 6);
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] E — the panel degrades instead of failing');
    const ENV_KEYS = ['VISION_PANEL', 'VISION_PANEL_JUDGES', 'VISION_PANEL_ESCALATE_GAP', 'VISION_PANEL_LOG'];
    const SAVED = {};
    for (const k of ENV_KEYS) SAVED[k] = process.env[k];
    const setEnv = (o) => {
        for (const k of ENV_KEYS) delete process.env[k];
        for (const [k, v] of Object.entries(o)) process.env[k] = v;
    };

    check('no VISION_PANEL -> null (the ordinary chain runs, untouched)', () => {
        setEnv({});
        USABLE = new Set(['bedrock-nova', 'bedrock-qwen-vl']);
        assert.strictEqual(_judgePanel(), null);
    });
    check('VISION_PANEL=0 -> null', () => {
        setEnv({ VISION_PANEL: '0' });
        assert.strictEqual(_judgePanel(), null);
    });
    check('VISION_PANEL=1 with two usable judges -> a two-seat panel', () => {
        setEnv({ VISION_PANEL: '1' });
        const p = _judgePanel();
        assert.ok(p, 'expected a panel');
        assert.deepStrictEqual(p.seats, ['bedrock-nova', 'bedrock-qwen-vl'],
            'the shipped default pair is the measured one — changing it needs a fresh bench');
    });
    check('one judge dies mid-run -> null (fall back to the chain, which has failover)', () => {
        setEnv({ VISION_PANEL: '1' });
        USABLE = new Set(['bedrock-nova']);
        assert.strictEqual(_judgePanel(), null,
            'a one-seat "panel" is the single-judge path minus its failover — it must not be used');
    });
    check('every judge dies -> null, never a throw', () => {
        setEnv({ VISION_PANEL: '1' });
        USABLE = new Set();
        assert.strictEqual(_judgePanel(), null);
    });
    check('a duplicated judge is not two votes from one model', () => {
        setEnv({ VISION_PANEL: '1', VISION_PANEL_JUDGES: 'bedrock-nova,bedrock-nova' });
        USABLE = new Set(['bedrock-nova']);
        assert.strictEqual(_judgePanel(), null,
            'one model voting twice averages to itself — that is a single judge wearing two hats');
    });
    check('escalation ships OFF (it is fitted to one bench case)', () => {
        setEnv({ VISION_PANEL: '1' });
        USABLE = new Set(['bedrock-nova', 'bedrock-qwen-vl']);
        assert.strictEqual(_judgePanel().escalateGap, 0,
            'VISION_PANEL_ESCALATE_GAP defaults to 0 on purpose: the only wide-gap frame in the '
            + 'bench is one that SHOULD be rejected, so the rule has never been tested where it '
            + 'could destroy good footage. Turn it on with evidence, not by changing the default.');
    });
    check('escalation is reachable when explicitly asked for', () => {
        setEnv({ VISION_PANEL: '1', VISION_PANEL_ESCALATE_GAP: '4' });
        assert.strictEqual(_judgePanel().escalateGap, 4);
    });
    for (const k of ENV_KEYS) {
        if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
    }

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] F — a seat cannot quietly become a different model');
    const providerSrc = fs.readFileSync(path.join(ROOT, 'src', 'brain', 'ai-provider.js'), 'utf8');

    check('callVisionAI resolves its chain through _visionChainFor', () => {
        assert.ok(/const chain = _visionChainFor\(options\);/.test(providerSrc),
            'callVisionAI is back on the unconditional chain — a pinned seat would fail over');
    });
    check('a pinned provider yields a ONE-seat chain', () => {
        const m = providerSrc.match(/function _visionChainFor\(options\)[\s\S]*?\n\}/);
        assert.ok(m, '_visionChainFor is gone');
        assert.ok(/return \[pinned\];/.test(m[0]),
            'a pinned seat must resolve to exactly itself — anything longer is silent failover');
    });
    check('a dead pinned provider throws instead of substituting a neighbour', () => {
        const m = providerSrc.match(/function _visionChainFor\(options\)[\s\S]*?\n\}/);
        assert.ok(/visionProviderUnavailable = true/.test(m[0]),
            'a dead seat must throw so the panel can drop it, not silently become the other judge');
    });
    check('isVisionProviderUsable is exported (the panel sizes itself with it)', () => {
        assert.ok(/^\s{4}isVisionProviderUsable,\s*$/m.test(providerSrc));
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] G — the over-literal judges stay out of the default chain');
    // Nova Pro is callable and is a legitimate escalation seat, but it rejects
    // 2 of every 5 usable clips. If it ever drifts into the automatic failover
    // chain, a throttle storm turns straight into placeholder cards.
    check('bedrock-nova-pro is NOT in VISION_PROVIDER_ORDER', () => {
        const m = providerSrc.match(/const VISION_PROVIDER_ORDER = \[[^\]]*\]/);
        assert.ok(m, 'VISION_PROVIDER_ORDER is gone');
        assert.ok(!/nova-pro/.test(m[0]),
            'Nova Pro is in the automatic chain — it is over-literal and must be opt-in only');
    });
    check('bedrock-nova-pro is still reachable when named explicitly', () => {
        assert.ok(/'nova-pro': 'bedrock-nova-pro'/.test(providerSrc), 'the alias is gone');
        assert.ok(/case 'bedrock-nova-pro':/.test(providerSrc), 'the dispatch case is gone');
        assert.ok(/BEDROCK_VISION_NOVA_PRO_MODEL/.test(providerSrc), 'the model env override is gone');
    });
    check('Nova Pro has its own provider id, not a shared one', () => {
        // Bedrock meters RPM per MODEL. Sharing an id with bedrock-nova would
        // mean sharing one AIMD pacer between two separate quotas — the exact
        // bug the per-model pacer was written to kill.
        assert.ok(/'bedrock-qwen-vl', 'bedrock-claude', 'bedrock-nova', 'bedrock-nova-pro'/.test(providerSrc),
            '_isBedrockVisionProvider must list nova-pro separately from nova');
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] H — the panel is scoped to the Bedrock backend');
    const configSrc = fs.readFileSync(path.join(ROOT, 'src', 'settings', 'config.js'), 'utf8');

    check('the bedrock branch turns the panel on', () => {
        assert.ok(/process\.env\.VISION_PANEL = process\.env\.VISION_BEDROCK_PANEL \|\| '1';/.test(configSrc),
            'nothing enables the panel — it would ship dead');
    });
    check('the shipped seats are the two that were benched', () => {
        const m = configSrc.match(/VISION_BEDROCK_PANEL_JUDGES \|\| '([^']+)'/);
        assert.ok(m, 'the default judge pair is not set in config.js');
        assert.strictEqual(m[1], 'bedrock-nova,bedrock-qwen-vl',
            `shipping ${m[1]} — that pair has no bench behind it`);
    });
    check('the panel keys are restored when the backend changes', () => {
        // _RAW_VISION_ENV is snapshotted once and re-applied on every call so the
        // UI dropdown can switch backends live. A key that is written by the
        // bedrock branch but missing from the snapshot stays set forever — so
        // picking the GPU box afterwards would still run a Bedrock-only panel.
        const m = configSrc.match(/const _RAW_VISION_ENV = \{[\s\S]*?\n\};/);
        assert.ok(m, '_RAW_VISION_ENV is gone');
        for (const key of ['VISION_PANEL', 'VISION_PANEL_JUDGES']) {
            assert.ok(new RegExp(`^\\s*${key}: process\\.env\\.${key},`, 'm').test(m[0]),
                `${key} is written by the bedrock branch but not in _RAW_VISION_ENV — it will stack across backend switches`);
        }
    });
    check('Sonnet is no longer the primary judge', () => {
        // Right answer, cannot arrive: 4-16 frames/minute on this account.
        assert.ok(!/VISION_BEDROCK_PRIMARY_MODEL \|\| 'us\.anthropic\.claude-sonnet/.test(configSrc),
            'Sonnet is the default primary again — a real build reached scene 9 of 50 in 23 minutes on it');
    });
    check('the descriptive-vision chain leads with a model that can keep up', () => {
        const m = configSrc.match(/VISION_BEDROCK_FALLBACK_ORDER \|\| '([^']+)'/);
        assert.ok(m, 'the bedrock fallback order is not set');
        assert.ok(!/^bedrock-claude/.test(m[1]),
            `fallback order "${m[1]}" puts the scarcest quota on the account first`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] I — both paths read a score the same way');
    const visionSrc = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'ai-vision.js'), 'utf8');
    check('there is exactly ONE score parser', () => {
        // Two parsers means two definitions of what a score is, and this one has
        // already been fixed twice for bugs that only appeared at build scale.
        assert.ok(/function _parseScoreResponse\(response\)/.test(visionSrc), '_parseScoreResponse is gone');
        const callers = (visionSrc.match(/_parseScoreResponse\(/g) || []).length;
        assert.ok(callers >= 3, `only ${callers} references — the panel or scoreVideoFrame has forked its own parser`);
    });
    check('the panel falls through to the chain when nobody returns a score', () => {
        assert.ok(/if \(verdict\) return verdict;/.test(visionSrc),
            'a null panel verdict must fall through to the ordinary chain, not become a 0');
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[vision-judge-panel] J — end to end through the real scoreVideoFrame');
    // Everything above tests the pieces. This drives the ACTUAL function the
    // footage manager calls, with a scripted transport, so a panel that is wired
    // up wrong — never reached, called with the wrong argument shape, or
    // swallowing its own result — fails here rather than in a build.
    const FAKE_B64 = Buffer.from('not-a-real-image').toString('base64');
    const runScore = async () => {
        CALLS = [];
        return scoreVideoFrame(FAKE_B64, 'image/jpeg', 'amish farmhouse', { videoTopic: 'Ohio' });
    };

    const setPanelEnv = (o) => {
        for (const k of ENV_KEYS) delete process.env[k];
        for (const [k, v] of Object.entries(o)) process.env[k] = v;
    };

    {
        setPanelEnv({ VISION_PANEL: '1', VISION_PANEL_LOG: '0' });
        USABLE = new Set(['bedrock-nova', 'bedrock-qwen-vl']);
        ANSWERS = {
            'bedrock-nova': 'Clean aerial of Amish farmland.\n8',
            'bedrock-qwen-vl': 'Farmland, but the barn is not clearly Amish.\n4',
            '*': 'chain judge should not have been asked\n1',
        };
        const r = await runScore();
        check('both seats are asked, and only the seats', () => {
            assert.deepStrictEqual(CALLS.sort(), ['bedrock-nova', 'bedrock-qwen-vl'],
                `called ${JSON.stringify(CALLS)} — the chain must not run when the panel answered`);
        });
        check('the averaged score comes out of the real function (8 + 4 -> 6)', () => {
            assert.strictEqual(r.score, 6, `got ${r.score}`);
            assert.ok(!r.parseError && !r.apiError, 'a good panel verdict must carry no failure flag');
        });
        check('the per-judge breakdown survives the return', () => {
            assert.deepStrictEqual((r.panel || []).map(p => p.score), [8, 4]);
        });
    }

    {
        // One judge dies mid-frame. The survivor's score stands — one real vote
        // beats no verdict, and the alternative is a scene with no footage.
        setPanelEnv({ VISION_PANEL: '1', VISION_PANEL_LOG: '0' });
        USABLE = new Set(['bedrock-nova', 'bedrock-qwen-vl']);
        ANSWERS = {
            'bedrock-nova': 'Clean aerial of Amish farmland.\n8',
            'bedrock-qwen-vl': new Error('ThrottlingException'),
            '*': 'chain judge should not have been asked\n1',
        };
        const r = await runScore();
        check('one seat throwing does not lose the other seat\'s vote', () => {
            assert.strictEqual(r.score, 8, `got ${r.score}`);
            assert.strictEqual((r.panel || []).length, 1, 'expected a one-vote panel');
        });
    }

    {
        // Nobody on the panel returns a readable score. Falling through to the
        // ordinary chain is deliberate: the chain has judges the panel does not,
        // and one more call beats inventing a verdict.
        setPanelEnv({ VISION_PANEL: '1', VISION_PANEL_LOG: '0' });
        USABLE = new Set(['bedrock-nova', 'bedrock-qwen-vl']);
        ANSWERS = {
            'bedrock-nova': 'I am unable to rate this image.',
            'bedrock-qwen-vl': 'No numeric answer here either.',
            '*': 'Clean aerial of Amish farmland.\n7',
        };
        const r = await runScore();
        check('an unreadable panel falls through to the chain instead of scoring 0', () => {
            assert.ok(CALLS.includes('*'), `chain never ran (calls: ${JSON.stringify(CALLS)})`);
            assert.strictEqual(r.score, 7, `got ${r.score}`);
            assert.ok(!r.parseError, 'the chain answered readably — this must not be a parse failure');
        });
    }

    {
        // Panel off: the path the aws/lightning backends take must be untouched.
        setPanelEnv({});
        USABLE = new Set(['bedrock-nova', 'bedrock-qwen-vl']);
        ANSWERS = { '*': 'Clean aerial of Amish farmland.\n7' };
        const r = await runScore();
        check('with the panel off, exactly one ordinary chain call is made', () => {
            assert.deepStrictEqual(CALLS, ['*'], `called ${JSON.stringify(CALLS)}`);
            assert.strictEqual(r.score, 7);
            assert.ok(!r.panel, 'a non-panel verdict must not carry panel diagnostics');
        });
    }

    for (const k of ENV_KEYS) {
        if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
    }

    console.log(`\n[vision-judge-panel] ${checks - failures}/${checks} checks passed`);
    if (failures) {
        console.log(`[vision-judge-panel] FAILED — ${failures} check(s)\n`);
        process.exit(1);
    }
    console.log('[vision-judge-panel] OK\n');
})().catch((err) => {
    console.error('[vision-judge-panel] CRASHED:', err);
    process.exit(1);
});
