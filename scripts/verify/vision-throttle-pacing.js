#!/usr/bin/env node
/**
 * VERIFY: a Bedrock rate-limit can never again silently demote the footage judge.
 *
 * The failure this pins (2026-08-04 build, log app-2026-08-04T21-03-06):
 *
 *     [21:23:42] [bedrock-claude] ❌ anthropic.claude-sonnet-4-6 ThrottlingException http=429
 *                ⚠️ [bedrock-claude] Vision error: Too many requests, please wait...
 *                🔄 Falling back to bedrock-qwen-vl for vision...
 *     ... 89 more times over the next 11 minutes ...
 *
 * Sonnet 4.6 was entitled, reachable and working — it had already scored dozens
 * of frames in 3–7s each. Two bugs then compounded:
 *
 *   1. ONE SHARED PACING BUCKET at a flat BEDROCK_VISION_MAX_RPM=80 for every
 *      Bedrock vision model. Bedrock's quotas are PER MODEL, so Qwen-VL's calls
 *      spent Sonnet's budget and vice versa — neither model's pacing described
 *      its own limit — and 80 was simply above what this account allows for
 *      Sonnet, with nothing in the loop able to discover that.
 *   2. A 429 WAS TREATED AS PROVIDER FAILURE. The vision chain reads any thrown
 *      error as "this provider failed, use the next one". True for a 403.
 *      Catastrophic for a 429: the model is entitled, capable and already
 *      chosen, and asked only for a moment. All 89 throttled frames went to the
 *      weaker fallback judge — the exact judge that run existed to stop using.
 *      Only 36 of ~125 judgements were made by the intended model.
 *
 * That is the same silent-demotion shape as the 2026-08-04 `claude-sonnet-5`
 * entitlement bug, reached by a different road: nothing in the log reads as a
 * build error, footage quality quietly drops, and scenes come back as
 * placeholders.
 *
 * Two properties make it impossible now, and both are executed below against
 * the real shipped functions rather than restated:
 *
 *   A. Pacing is per model and LEARNED in-run (AIMD). A throttle is the only
 *      measurement of the true ceiling we ever get, so it cuts hard; a clean
 *      stretch while saturated probes back up. No per-model constant to keep
 *      correct, and no flat global rate pretending to describe every model.
 *   B. A throttle is absorbed in the transport, BELOW the chain — same model,
 *      backoff, retry. The chain only sees an error when it genuinely will not
 *      clear, so falling back stays the last resort instead of the first.
 *
 * The negative cases matter as much as the positive ones: a 403 must still fail
 * FAST (the dead-provider gate depends on seeing it immediately), and a throttle
 * that never clears must still surface, or the chain loses its ability to fall
 * back at all and the frame is simply lost.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC_PATH = path.join(ROOT, 'src', 'brain', 'ai-provider.js');

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}`);
        if (detail) console.log(`       ${detail}`);
    }
}

// Normalized to LF: the anchors below are bare newlines, which never match on a
// CRLF working copy — the gate then reports its own subject as missing and the
// `npm run verify` && chain aborts before every later check. Found 2026-08-28.
const src = fs.readFileSync(SRC_PATH, 'utf8')
    .split(String.fromCharCode(13)).join('');

// ---------------------------------------------------------------------------
// The shape of the code
// ---------------------------------------------------------------------------
function checkShape() {
    check(
        'pacing is keyed per model, not one shared bucket',
        /_visionPacers\s*=\s*new Map\(/.test(src) && !/const\s+_bedrockVisionCallTimes\s*=\s*\[\]/.test(src),
        'the single shared `_bedrockVisionCallTimes` array is back — Bedrock quotas '
        + "are per model, so one bucket makes every model spend the others' budget"
    );

    check(
        'the pacer is told which model it is pacing',
        /_throttleBedrockVision\(tag,\s*modelId\)/.test(src),
        'a call site still paces by tag alone; two models behind one tag would '
        + 'share a ceiling again'
    );

    check(
        'both vision paths absorb throttles before the chain sees them',
        (src.match(/_withVisionThrottleRetry\(tag,\s*modelId,/g) || []).length >= 4,
        'the still-image path and the multi-frame clip path must BOTH retry, on '
        + 'both their first and their retry invoke — the clip path judges video '
        + 'candidates, which is most of the footage race'
    );

    const floor = /VISION_PACE_FLOOR_RPM\s*=\s*(\d+)/.exec(src);
    check(
        'the learned ceiling cannot collapse into a stall',
        floor && Number(floor[1]) > 0,
        `floor is ${floor ? floor[1] : '(not found)'} — without one, a burst of `
        + 'throttles drives the rate toward zero and the media phase stops '
        + 'making progress at all'
    );
}

// ---------------------------------------------------------------------------
// The real functions, executed against a stand-in clock and SDK
//
// Restating this logic here would let the gate drift into passing while the
// shipped code regressed, so pull the actual code out of ai-provider.js and run
// it. `Date` and `Math` are injected so easing and backoff can be checked
// deterministically instead of by sleeping 45 real seconds and hoping.
// ---------------------------------------------------------------------------
const sliceStart = src.indexOf('const VISION_PACE_FLOOR_RPM');
const retryStart = src.indexOf('async function _withVisionThrottleRetry(');
const sliceEnd = retryStart >= 0 ? src.indexOf('\n}\n', retryStart) : -1;

const quiet = { log() {}, warn() {}, error() {} };

function makeLoader(body) {
    return function load(env = {}, rand = 0.5) {
        const clock = { t: 1_000_000 };
        const sleeps = [];
        const FakeDate = { now: () => clock.t };
        const FakeMath = Object.create(Math);
        FakeMath.random = () => rand;
        const fakeProcess = { env: Object.assign({ BEDROCK_VISION_MAX_RPM: '80' }, env) };
        const _sleep = async (ms) => { sleeps.push(ms); clock.t += ms; };
        const _shortBedrockModel = (m) => String(m || '').split('.').slice(-2).join('.');
        // eslint-disable-next-line no-new-func
        const api = new Function(
            'Date', 'Math', 'process', 'console', '_sleep', '_shortBedrockModel',
            `${body}\nreturn { _throttleBedrockVision, _noteVisionThrottle, `
            + '_withVisionThrottleRetry, _isVisionThrottleError, _visionPacers };'
        )(FakeDate, FakeMath, fakeProcess, quiet, _sleep, _shortBedrockModel);
        return Object.assign(api, { clock, sleeps });
    };
}

const throttleErr = () => Object.assign(
    new Error('Too many requests, please wait before trying again.'),
    { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }
);
const accessErr = () => Object.assign(
    new Error("You don't have access to the model with the specified model ID."),
    { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }
);

async function checkBehaviour(load) {
    const SONNET = 'us.anthropic.claude-sonnet-4-6';
    const QWEN = 'qwen.qwen3-vl-235b-a22b';

    // A) One model saturating its quota must not pace a different model.
    //    Order matters here: prove isolation while the clock is untouched, then
    //    prove the bucket is real — otherwise "nobody ever waits" would pass.
    {
        const api = load({ BEDROCK_VISION_MAX_RPM: '3' });
        for (let i = 0; i < 3; i++) await api._throttleBedrockVision('bedrock-claude', SONNET);

        const beforeOther = api.sleeps.length;
        await api._throttleBedrockVision('bedrock-qwen-vl', QWEN);
        check(
            'a saturated model does not make a different model wait',
            api.sleeps.length === beforeOther,
            `the second model slept ${api.sleeps.length - beforeOther} time(s) — `
            + 'Bedrock quotas are per model, so that is throughput stolen from a '
            + 'model the account was still willing to serve'
        );

        const beforeSame = api.sleeps.length;
        await api._throttleBedrockVision('bedrock-claude', SONNET);
        check(
            'a model that IS over its own ceiling does wait',
            api.sleeps.length > beforeSame,
            'the pacer never waits at all, so the isolation check above passes '
            + 'vacuously and nothing is actually being paced'
        );
    }

    // B) A throttle tightens that model's ceiling, and only that model's.
    {
        const api = load({ BEDROCK_VISION_MAX_RPM: '80' });
        await api._throttleBedrockVision('bedrock-claude', SONNET);
        await api._throttleBedrockVision('bedrock-qwen-vl', QWEN);
        const otherBefore = api._visionPacers.get(QWEN).ceiling;

        api._noteVisionThrottle('bedrock-claude', SONNET);
        const tightened = api._visionPacers.get(SONNET).ceiling;

        check(
            'a throttle lowers the ceiling of the model that was throttled',
            tightened < 80,
            `ceiling stayed at ${tightened}/min — the run keeps walking into the `
            + 'same wall because nothing learned from the only measurement AWS '
            + 'ever gives us'
        );
        check(
            'a throttle does not punish a model that was not throttled',
            api._visionPacers.get(QWEN).ceiling === otherBefore,
            `the unrelated model dropped from ${otherBefore} to `
            + `${api._visionPacers.get(QWEN).ceiling}/min`
        );
    }

    // C) Repeated throttles converge; they do not collapse into a stall.
    {
        const api = load({ BEDROCK_VISION_MAX_RPM: '80' });
        for (let i = 0; i < 40; i++) api._noteVisionThrottle('bedrock-claude', SONNET);
        const ceiling = api._visionPacers.get(SONNET).ceiling;
        check(
            'the ceiling never decays to a stall, however many throttles land',
            ceiling >= 4,
            `ceiling bottomed out at ${ceiling}/min — at or near zero the media `
            + 'phase stops finishing scenes at all, which is worse than throttling'
        );
    }

    // D) THE BUG ITSELF: a throttle is retried on the same model and must never
    //    reach the chain, because the chain reads any error as "provider failed".
    {
        const api = load();
        let calls = 0;
        const result = await api._withVisionThrottleRetry('bedrock-claude', SONNET, async () => {
            calls++;
            if (calls === 1) throw throttleErr();
            return { text: 'VERDICT 8/10', stopReason: 'end_turn' };
        });
        check(
            'a throttled frame is retried on the SAME model instead of falling back',
            result && result.text === 'VERDICT 8/10' && calls === 2,
            `calls=${calls}, result=${JSON.stringify(result)} — if this throws, the `
            + 'chain hands the frame to the weaker judge, which is the entire bug'
        );
        check(
            'the retry waits before trying again',
            api.sleeps.length === 1 && api.sleeps[0] > 0,
            `waits were ${JSON.stringify(api.sleeps)} — retrying instantly just `
            + 'walks straight back into the same rate limit'
        );
    }

    // E) NEGATIVE: an entitlement failure must still fail fast. The dead-provider
    //    gate depends on seeing it on the first try, and retrying a 403 four
    //    times just quadruples the latency of a permanently doomed provider.
    {
        const api = load();
        let calls = 0;
        let threw = null;
        try {
            await api._withVisionThrottleRetry('bedrock-claude', SONNET, async () => {
                calls++;
                throw accessErr();
            });
        } catch (e) { threw = e; }
        check(
            'a 403 entitlement failure is NOT retried and propagates immediately',
            calls === 1 && threw && threw.name === 'AccessDeniedException',
            `called ${calls}×, threw=${threw && threw.name} — a permanent failure `
            + 'must reach the chain at once so the provider is marked dead and dropped'
        );
        check(
            'no pacing penalty is applied for a non-throttle error',
            !api._visionPacers.has(SONNET) || api._visionPacers.get(SONNET).ceiling === 80,
            'a 403 tightened the learned rate limit; entitlement has nothing to do '
            + 'with speed, so the run would pace itself on a false signal'
        );
    }

    // F) NEGATIVE: a throttle that never clears must still surface, or the chain
    //    can never fall back and the frame is lost instead of degraded.
    {
        const api = load({ BEDROCK_VISION_THROTTLE_RETRIES: '3' });
        let calls = 0;
        let threw = null;
        try {
            await api._withVisionThrottleRetry('bedrock-claude', SONNET, async () => {
                calls++;
                throw throttleErr();
            });
        } catch (e) { threw = e; }
        check(
            'a throttle that never clears still throws, so the chain can fall back',
            calls === 3 && threw && threw.$metadata.httpStatusCode === 429,
            `called ${calls}×, threw=${threw && threw.name} — retrying forever hangs `
            + 'the media phase instead of degrading to the fallback judge'
        );
        check(
            'backoff grows between attempts instead of hammering at a fixed rate',
            api.sleeps.length === 2 && api.sleeps[1] > api.sleeps[0],
            `waits were ${JSON.stringify(api.sleeps)}`
        );
    }

    // G) Jitter is load-bearing, not decoration: the candidate race issues these
    //    calls in parallel, so a fixed delay resynchronizes every waiter into one
    //    burst that throttles the whole group together, over and over.
    {
        const low = load({ BEDROCK_VISION_THROTTLE_RETRIES: '2' }, 0);
        const high = load({ BEDROCK_VISION_THROTTLE_RETRIES: '2' }, 1);
        for (const api of [low, high]) {
            try {
                await api._withVisionThrottleRetry('bedrock-claude', SONNET, async () => {
                    throw throttleErr();
                });
            } catch { /* expected */ }
        }
        check(
            'the retry delay is jittered, so parallel candidates do not re-burst together',
            low.sleeps.length === 1 && high.sleeps.length === 1 && low.sleeps[0] !== high.sleeps[0],
            `both ends of the random range produced ${JSON.stringify(low.sleeps)} and `
            + `${JSON.stringify(high.sleeps)} — an unjittered delay makes every racer `
            + 'wake at the same instant and throttle as one group again'
        );
    }

    // H) The ceiling probes back up, but only after a clean stretch WHILE
    //    saturated. Easing across an idle gap would "prove" headroom that was
    //    never tested, and the next burst rediscovers the limit the expensive way.
    {
        const api = load({ BEDROCK_VISION_MAX_RPM: '80' });
        await api._throttleBedrockVision('bedrock-claude', SONNET);
        api._noteVisionThrottle('bedrock-claude', SONNET);
        const tightened = api._visionPacers.get(SONNET).ceiling;

        api.clock.t += 10_000; // too soon
        await api._throttleBedrockVision('bedrock-claude', SONNET);
        check(
            'the ceiling does not spring back after a few quiet seconds',
            api._visionPacers.get(SONNET).ceiling === tightened,
            `eased to ${api._visionPacers.get(SONNET).ceiling}/min after only 10s — `
            + 'easing that fast just re-enters the throttle loop'
        );

        api.clock.t += 60_000; // a genuinely clean stretch
        await api._throttleBedrockVision('bedrock-claude', SONNET);
        check(
            'a sustained clean stretch lets the learned ceiling recover',
            api._visionPacers.get(SONNET).ceiling > tightened,
            `ceiling stuck at ${tightened}/min — one early burst would then throttle `
            + 'the entire rest of the build to a crawl'
        );
    }

    // I) The disable switch still works: 0 means "do not pace at all".
    {
        const api = load({ BEDROCK_VISION_MAX_RPM: '0' });
        for (let i = 0; i < 200; i++) await api._throttleBedrockVision('bedrock-claude', SONNET);
        check(
            'BEDROCK_VISION_MAX_RPM=0 still disables pacing entirely',
            api.sleeps.length === 0,
            `slept ${api.sleeps.length}× with pacing explicitly disabled`
        );
    }

    // J) The classifier is what routes an error down the retry path at all, so
    //    pin the wordings AWS actually returns alongside the status code.
    {
        const api = load();
        check(
            'a throttle is recognised by status code and by message wording',
            api._isVisionThrottleError(throttleErr())
            && api._isVisionThrottleError({ name: 'TooManyRequestsException', message: '' })
            && api._isVisionThrottleError({ message: 'Rate limit exceeded' })
            && !api._isVisionThrottleError(accessErr())
            && !api._isVisionThrottleError(new Error('ValidationException: image too large')),
            'the classifier either misses a real throttle (the frame gets demoted) '
            + 'or catches a genuine failure (four retries on something permanent)'
        );
    }
}

(async () => {
    console.log('[verify] bedrock vision throttle pacing');
    checkShape();

    if (sliceStart < 0 || sliceEnd < 0) {
        check('the pacing functions are extractable', false,
            'could not slice the pacer/retry block out of ai-provider.js');
    } else {
        await checkBehaviour(makeLoader(src.slice(sliceStart, sliceEnd + 2)));
    }

    console.log(`\n[verify] bedrock vision throttle pacing: ${checks - failures}/${checks} passed`);
    if (failures > 0) {
        console.error(`[verify] FAILED (${failures})`);
        process.exit(1);
    }
})().catch((e) => {
    console.error(`[verify] FAILED — gate itself crashed: ${(e && e.stack) || e}`);
    process.exit(1);
});
