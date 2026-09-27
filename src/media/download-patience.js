'use strict';

/**
 * ADAPTIVE DOWNLOAD PATIENCE — "how long do we wait for one candidate?"
 *
 * The old answer was a single number for the whole app (75s video / 45s image),
 * and in the user's `.env` it was set to 0, which means "wait forever". A single
 * slow YouTube pull could then eat an entire scene's budget, and every rescue
 * step behind it (simplified retries, niche fallback, controlled stock) would
 * find 2 seconds left and refuse to run. In the Jul-29 build that happened 26
 * times.
 *
 * One number for every topic is the wrong shape regardless of its value. A
 * YouTube pull on a history documentary and a 1080p Pexels grab on a food short
 * do not deserve the same patience. So this module produces a different answer
 * per (topic, provider, media type, and what the scene has left), and it tunes
 * itself against what downloads actually cost during this run.
 *
 * WHAT THE BUDGET IS ACTUALLY SPENT ON (the Aug-4 correction)
 *   A "candidate" is not a download. It is download -> pre-screen -> JUDGE, and
 *   the judging step is an AI call that is itself allowed tens of seconds before
 *   it gives up. The first version of this module timed only the download half
 *   and then handed that number out as the budget for the whole job. On the
 *   Aug-4 build it measured images at ~5s, produced an 8s budget, and every
 *   candidate was killed mid-judgement — the judging step alone had a 45s
 *   deadline. Arithmetically nothing could ever finish. Ten scenes in a row got
 *   a blank placeholder card.
 *
 *   So there are two kinds of sample now:
 *     - END-TO-END (`recordCandidate`): the whole soldier, download through
 *       verdict. This is the truth and it is what the budget is built from as
 *       soon as we have a few.
 *     - DOWNLOAD-ONLY (`recordDownload`): kept, because a failed download is
 *       still evidence about download cost. When only these exist, the measured
 *       JUDGING allowance is added on top instead of being pretended away.
 *
 * The answer is built from four things:
 *
 *   1. BASE — measured, not declared. Once we have a few completed candidates
 *      from a provider we use their 75th-percentile duration times a headroom
 *      factor. On a slow network patience grows by itself; on a fast one it
 *      shrinks. Before there is evidence we fall back to the app's historical
 *      defaults so a cold start behaves like the old code. Those defaults were
 *      always WHOLE-CANDIDATE numbers — which is exactly why the download-only
 *      learner regressed below them.
 *
 *   2. TOPIC RANK — the niche's own `footagePriority` for this media type. A
 *      provider the topic ranks first is worth waiting longer for than one it
 *      ranks last. A topic that opens with youtube gives YouTube the long
 *      patience; a topic that opens with stock gives stock the long patience
 *      and YouTube the short one — same code, opposite answer, because the
 *      input came from the topic. This is the per-topic input, read from data
 *      that already exists. No provider is named anywhere in this module's
 *      ranking logic; re-tune niches.js and patience follows on its own.
 *
 *   3. LIVE RECORD — a provider that is winning scenes in this build earns a
 *      little more patience; one that keeps losing earns less. See
 *      `provider-scoreboard.js`.
 *
 *   4. SCENE SHARE — a clamp. No single candidate may consume more than
 *      MAX_SCENE_SHARE of the time the scene has left, so the rescue ladder
 *      behind it always has a real window to run in. This is the part that
 *      turns "0 footage found" into "found it on the second try".
 *
 *      It yields to the min-viable line, and it has to. A share is protection
 *      only while it still buys a whole candidate; once it drops below the
 *      one-candidate minimum, the clamp is reserving time for a rescue rung
 *      that cannot finish either, and the budget in front is a scheduled loss
 *      rather than a tight one. See the last-chance branch in
 *      `resolveCandidatePatienceMs` — it is the Aug-5 YouTube bug.
 *
 * Env overrides are still honoured for back-compat:
 *   unset / empty  -> adaptive (this module)
 *   a number > 0   -> that fixed number, no adaptation
 *   0              -> disabled, and we say so loudly, every scene
 */

const { getNiche } = require('../data/niches');
const scoreboard = require('./provider-scoreboard');

/** @typedef {'video'|'image'} MediaType */

// Historical hardcoded defaults. Used ONLY as a cold-start bootstrap, before
// this run has measured anything. Keeping the old numbers here means the first
// download of a build behaves exactly as it always did.
//
// These are WHOLE-CANDIDATE numbers — the old fixed race timeout covered
// download AND scoring — which is why they are used as-is and never get the
// judging allowance added on top.
const BOOTSTRAP_MS = { video: 75_000, image: 45_000 };

// Absolute sanity rails. Adaptation happens between these.
const FLOOR_MS = { video: 15_000, image: 8_000 };
const CEILING_MS = { video: 180_000, image: 75_000 };

// p75 of real successful downloads times this = "generous but bounded". The
// point is to kill genuine stalls, never a slow-but-working download — the
// goal is zero not-found scenes, so we err toward waiting.
const HEADROOM = 2.5;

// How much evidence before we trust a provider's own measured cost, and before
// we trust the run-wide measured cost.
const MIN_SAMPLES_PROVIDER = 3;
const MIN_SAMPLES_GLOBAL = 5;

// Judging (pre-screen + the AI verdict) is measured the same way downloads are,
// with a tighter headroom: an AI call's cost is dominated by queueing, which is
// already visible in the sample, so it needs less padding than a network pull.
const MIN_SAMPLES_JUDGE = 3;
const JUDGE_HEADROOM = 1.6;

// Rails for the judging allowance.
//   - Cold start: never more than half the historical whole-candidate default,
//     because the download half has to fit in the same budget. This also stops a
//     wild QWEN_VISION_REQUEST_TIMEOUT_MS from turning the cold-start budget
//     into a judging-only budget.
//   - Measured: allowed to grow further, because by then it is not a guess. On a
//     queued GPU a judgement really can cost a minute, and pretending otherwise
//     is the bug this whole section exists to fix.
const MAX_JUDGE_SHARE_OF_BOOTSTRAP = 0.5;
const MAX_JUDGE_SHARE_OF_CEILING = 0.6;

// The clamp that keeps the rescue ladder reachable.
const MAX_SCENE_SHARE = 0.55;

// Topic-rank multipliers. Index = the provider's position in the niche's
// footagePriority list for this media type.
const RANK_MULTIPLIER = [1.40, 1.20, 1.00];
const RANK_TAIL_MULTIPLIER = 0.85;   // ranked, but 4th or later
const UNLISTED_MULTIPLIER = 0.70;    // reachable, but this topic did not ask for it

// Live-record multiplier rails.
const RECORD_MIN_MULTIPLIER = 0.75;
const RECORD_MAX_MULTIPLIER = 1.25;

/**
 * Measured durations for this run. Three families, all in the same map so
 * `reset()` stays one line:
 *   `full:<type>:<provider>` / `full:<type>:*`  — whole candidate, download
 *                                                 through verdict (the truth)
 *   `dl:<type>:<provider>`   / `dl:<type>:*`    — download only
 *   `judge:<type>`                              — pre-screen + AI verdict only
 * @type {Map<string, number[]>}
 */
const _samples = new Map();

// Remember which env vars we have already complained about, so "patience is
// switched off" is loud once per media type instead of 60 times.
const _warned = new Set();

function _push(key, ms) {
    let arr = _samples.get(key);
    if (!arr) {
        arr = [];
        _samples.set(key, arr);
    }
    arr.push(ms);
    // Keep the window recent — a stall early in the build should not inflate
    // patience for the rest of it.
    if (arr.length > 40) arr.shift();
}

function _percentile(values, p) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

/**
 * Record how long a *successful* candidate download took. Failures are
 * deliberately not sampled: a download that died at 90s tells us nothing about
 * how long a working one needs, and feeding stalls back in would make patience
 * grow without bound.
 *
 * @param {object} p
 * @param {MediaType} p.mediaType
 * @param {string} p.providerKey
 * @param {number} p.ms wall-clock duration of the download
 */
function recordDownload({ mediaType, providerKey, ms }) {
    const duration = Number(ms);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const type = mediaType === 'image' ? 'image' : 'video';
    const key = String(providerKey || '').toLowerCase();
    if (key) _push(`dl:${type}:${key}`, duration);
    _push(`dl:${type}:*`, duration);
}

/**
 * Record how long a *whole candidate* took — the bytes AND the verdict. This is
 * the number the budget is actually spent on, so once a few of these exist they
 * replace the download-only estimate entirely.
 *
 * Only candidates that REACHED A VERDICT are sampled. A candidate the race
 * abandoned mid-flight, or one whose download errored, is not evidence about how
 * long the work takes — it is evidence about how long we were willing to wait,
 * and feeding that back is a loop that learns from its own impatience. (The
 * Aug-4 build did exactly that: abandoned soldiers finished 10-18 minutes later,
 * were sampled as successes, and produced 1113s / 840s / 624s bases that the
 * scene clamp then squashed straight back down to 8s.)
 *
 * @param {object} p
 * @param {MediaType} p.mediaType
 * @param {string} p.providerKey
 * @param {number} p.ms wall-clock duration of the whole candidate
 * @param {boolean} p.reachedVerdict true only if the judge actually answered
 */
function recordCandidate({ mediaType, providerKey, ms, reachedVerdict }) {
    if (!reachedVerdict) return;
    const duration = Number(ms);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const type = mediaType === 'image' ? 'image' : 'video';
    const key = String(providerKey || '').toLowerCase();
    if (key) _push(`full:${type}:${key}`, duration);
    _push(`full:${type}:*`, duration);
}

/**
 * Record how long the judging half took — pre-screen plus the AI verdict. Kept
 * separate from the whole-candidate sample because it is what has to be ADDED
 * when the only other evidence is download-only.
 *
 * @param {object} p
 * @param {MediaType} p.mediaType
 * @param {number} p.ms
 */
function recordJudging({ mediaType, ms }) {
    const duration = Number(ms);
    if (!Number.isFinite(duration) || duration <= 0) return;
    _push(`judge:${mediaType === 'image' ? 'image' : 'video'}`, duration);
}

/**
 * The judging step's own per-request deadline, read from the module that owns
 * it rather than copied here. Lazy + defensive so this module stays loadable on
 * its own (the verify harness requires it with no AWS/Electron around).
 * @returns {number} 0 when it cannot be read
 */
let _visionDeadlineMs = null;
function _visionRequestDeadlineMs() {
    if (_visionDeadlineMs === null) {
        _visionDeadlineMs = 0;
        try {
            const fn = require('../brain/ai-provider')?.visionRequestTimeoutMs;
            if (typeof fn === 'function') {
                const value = Number(fn());
                if (Number.isFinite(value) && value > 0) _visionDeadlineMs = value;
            }
        } catch (_) { /* not reachable from here — use the rail below */ }
    }
    return _visionDeadlineMs;
}

/**
 * How much of a candidate's budget must be reserved for judging it.
 * @param {MediaType} type
 */
function _judgingAllowanceMs(type) {
    const measured = _samples.get(`judge:${type}`) || [];
    if (measured.length >= MIN_SAMPLES_JUDGE) {
        const ms = Math.max(_percentile(measured, 75) * JUDGE_HEADROOM, _percentile(measured, 95) * 1.15);
        return Math.min(ms, CEILING_MS[type] * MAX_JUDGE_SHARE_OF_CEILING);
    }
    const cap = BOOTSTRAP_MS[type] * MAX_JUDGE_SHARE_OF_BOOTSTRAP;
    const deadline = _visionRequestDeadlineMs();
    return deadline > 0 ? Math.min(deadline, cap) : cap;
}

/**
 * The floor under any candidate budget: the shortest span in which ONE
 * candidate can plausibly finish, download and verdict. A budget below this is
 * not a tight budget, it is a guaranteed loss — the candidate is killed before
 * the judge can answer, and the scene ends up with a placeholder card.
 * @param {MediaType} type
 */
function _minViableCandidateMs(type, providerKey) {
    const key = String(providerKey || '').toLowerCase();
    const own = _samples.get(`dl:${type}:${key}`) || [];
    const all = _samples.get(`dl:${type}:*`) || [];
    const pool = own.length >= MIN_SAMPLES_PROVIDER ? own : (all.length >= MIN_SAMPLES_GLOBAL ? all : null);
    // p25 = "a quick one from this provider". Not the median: this is the
    // best case, the question being "could even a fast candidate finish?".
    const download = pool ? _percentile(pool, 25) : FLOOR_MS[type];
    // Bounded by the same ceiling every other budget obeys. Without this a run
    // that measured one very slow provider could produce a "minimum" no budget
    // is ever allowed to reach, and the last-chance grant below would quietly
    // become unreachable — the exact failure this floor exists to prevent.
    return Math.round(Math.min(
        CEILING_MS[type],
        Math.max(FLOOR_MS[type], download) + _judgingAllowanceMs(type)
    ));
}

/**
 * The measured base, before any topic or record adjustment.
 * @returns {{ms:number, source:string}}
 */
function _measuredBase(mediaType, providerKey) {
    const type = mediaType === 'image' ? 'image' : 'video';
    const key = String(providerKey || '').toLowerCase();
    // p75 x headroom is the normal answer, but a provider whose candidates have
    // a genuine long tail (big files, slow origin, a queued GPU) must not be
    // strangled by a tight middle. Respecting the observed p95 as well means we
    // only ever kill work that is slower than this provider has *ever* actually
    // been.
    const fromSamples = (values, label, addJudging) => {
        const raw = Math.max(_percentile(values, 75) * HEADROOM, _percentile(values, 95) * 1.3);
        const judging = addJudging ? _judgingAllowanceMs(type) : 0;
        return {
            ms: raw + judging,
            source: addJudging
                ? `${label} of ${values.length} + ${Math.round(judging / 1000)}s judging`
                : `${label} of ${values.length}`,
        };
    };

    // Best evidence first: whole candidates that actually reached a verdict.
    // These already contain the judging cost, so nothing is added.
    const ownFull = _samples.get(`full:${type}:${key}`) || [];
    if (ownFull.length >= MIN_SAMPLES_PROVIDER) return fromSamples(ownFull, 'end-to-end', false);
    const allFull = _samples.get(`full:${type}:*`) || [];
    if (allFull.length >= MIN_SAMPLES_GLOBAL) return fromSamples(allFull, 'run-wide end-to-end', false);

    // Only download timings so far — so the judging half has to be added, not
    // wished away. This is the branch whose missing addend produced 8-second
    // budgets for work whose judge alone had a 45-second deadline.
    const ownDl = _samples.get(`dl:${type}:${key}`) || [];
    if (ownDl.length >= MIN_SAMPLES_PROVIDER) return fromSamples(ownDl, 'measured download', true);
    const allDl = _samples.get(`dl:${type}:*`) || [];
    if (allDl.length >= MIN_SAMPLES_GLOBAL) return fromSamples(allDl, 'run-wide download', true);

    return { ms: BOOTSTRAP_MS[type], source: 'bootstrap' };
}

/**
 * Where this provider sits in the topic's own preference list, and what that
 * is worth in patience.
 * @returns {{multiplier:number, rank:number|null, listed:boolean}}
 */
function _topicRank(nicheId, mediaType, providerKey) {
    const key = String(providerKey || '').toLowerCase();
    if (!nicheId || !key) return { multiplier: 1.0, rank: null, listed: true };
    let order = null;
    try {
        order = getNiche(nicheId)?.footagePriority?.[mediaType === 'image' ? 'image' : 'video'] || null;
    } catch {
        order = null;
    }
    if (!Array.isArray(order) || order.length === 0) return { multiplier: 1.0, rank: null, listed: true };
    const rank = order.map(p => String(p).toLowerCase()).indexOf(key);
    if (rank < 0) return { multiplier: UNLISTED_MULTIPLIER, rank: null, listed: false };
    const multiplier = rank < RANK_MULTIPLIER.length ? RANK_MULTIPLIER[rank] : RANK_TAIL_MULTIPLIER;
    return { multiplier, rank, listed: true };
}

/** What this provider's live record in this build is worth in patience. */
function _recordMultiplier(mediaType, providerKey) {
    const evidence = scoreboard.opens(mediaType, providerKey);
    if (evidence < scoreboard.MIN_EVIDENCE_OPENS) return 1.0;
    // winRate is Laplace-smoothed and centred on 0.5 for an unproven provider,
    // so (rate - 0.5) is a signed "better/worse than neutral" signal.
    const delta = scoreboard.winRate(mediaType, providerKey) - 0.5;
    const multiplier = 1 + delta;
    return Math.max(RECORD_MIN_MULTIPLIER, Math.min(RECORD_MAX_MULTIPLIER, multiplier));
}

/** Read the env override for this media type / provider. */
function _envOverride(mediaType, providerKey) {
    const names = [];
    if (mediaType === 'video' && String(providerKey || '').toLowerCase() === 'storyblocks') {
        names.push('STORYBLOCKS_RACE_CANDIDATE_TIMEOUT_MS');
    }
    names.push(mediaType === 'image' ? 'IMAGE_RACE_CANDIDATE_TIMEOUT_MS' : 'FOOTAGE_RACE_CANDIDATE_TIMEOUT_MS');
    for (const name of names) {
        const raw = process.env[name];
        if (raw === undefined || String(raw).trim() === '') continue;
        const value = parseInt(raw, 10);
        if (!Number.isFinite(value)) continue;
        return { name, value };
    }
    return null;
}

/**
 * Resolve the per-candidate patience for one provider on one scene.
 *
 * @param {object} p
 * @param {MediaType} p.mediaType
 * @param {string} p.providerKey
 * @param {string} [p.nicheId] from scriptContext
 * @param {number} [p.remainingSceneMs] what the scene deadline has left; Infinity/undefined = no clamp
 * @param {(msg:string)=>void} [p.log]
 * @returns {{ms:number, disabled:boolean, explain:string, viable:boolean, minViableMs:number, lastChance:boolean}}
 *          ms = 0 means "no per-candidate cap" (only reachable via an explicit env 0)
 *          viable = false means the scene does not have enough time left for even
 *          one candidate to finish; starting a race here can only produce a
 *          placeholder, so the caller should stop instead of burning the rest.
 *          lastChance = true means the scene-share clamp was overridden because the
 *          share had fallen below the one-candidate minimum: there is room for one
 *          real attempt and no rescue rung behind it, so this race gets the whole
 *          minimum rather than a share it was guaranteed to be killed inside.
 */
function resolveCandidatePatienceMs({ mediaType, providerKey, nicheId, remainingSceneMs, log }) {
    const type = mediaType === 'image' ? 'image' : 'video';
    const emit = typeof log === 'function' ? log : (() => {});
    const minViableMs = _minViableCandidateMs(type, providerKey);
    const left = Number(remainingSceneMs);
    const sceneBounded = Number.isFinite(left) && left > 0;
    // Viability is a question about the SCENE, not about this provider's
    // ranking: "is there enough time left for one candidate to finish at all?"
    // A low-ranked provider on a fresh scene is still worth opening; any
    // provider on a scene with 12 seconds left is not.
    const viable = !sceneBounded || left >= minViableMs;

    const override = _envOverride(type, providerKey);
    if (override && override.value <= 0) {
        // Honour it — it is an explicit choice — but never let it be silent.
        // This is the setting that let one download swallow a whole scene.
        if (!_warned.has(override.name)) {
            _warned.add(override.name);
            emit(`  ⚠️  [Patience] ${override.name}=0 — per-download patience is DISABLED. `
                + `One slow download can consume the whole scene budget and starve the `
                + `retry/fallback steps behind it. Clear this variable to use adaptive patience.`);
        }
        return { ms: 0, disabled: true, explain: `${override.name}=0 (disabled)`, viable: true, minViableMs };
    }
    if (override && override.value > 0) {
        const clamped = Math.max(FLOOR_MS[type], Math.min(CEILING_MS[type], override.value));
        return { ms: clamped, disabled: false, explain: `${override.name}=${override.value} (fixed)`, viable, minViableMs };
    }

    const base = _measuredBase(type, providerKey);
    const topic = _topicRank(nicheId, type, providerKey);
    const record = _recordMultiplier(type, providerKey);

    let ms = base.ms * topic.multiplier * record;

    // A topic multiplier and a poor live record are meant to say "prefer someone
    // else", not "hand this one an impossible budget". Below the min-viable line
    // the candidate cannot reach a verdict at all, so demotion would silently
    // become deletion — and every rung it demoted would report "found nothing"
    // for a reason that had nothing to do with the footage.
    let raisedToViable = false;
    if (ms < minViableMs) {
        ms = minViableMs;
        raisedToViable = true;
    }
    ms = Math.max(FLOOR_MS[type], Math.min(CEILING_MS[type], ms));

    // The scene-share clamp. This is what keeps the fallback ladder alive —
    // but only for as long as a ladder can still run.
    //
    // THE AUG-5 BUG. The clamp had a floor of FLOOR_MS/2 and no re-check of the
    // min-viable line raised just above, so it could hand out a budget the
    // module had already computed to be too short for one candidate to finish.
    // On that build it gave YouTube 56s against a ~60s+ one-candidate minimum,
    // on scene after scene. Every pull was aborted mid-flight, the provider was
    // recorded as a loser for it, the record multiplier shortened the NEXT
    // budget, and YouTube won 0 of 47 scenes in a build whose own topic ranks it
    // first. Scene 25's best candidate — a 9/10 finalist, exactly the footage
    // the scene was about — died on that timer and the scene took a placeholder.
    //
    // Reserving 45% of the clock for a rescue rung is only protection while the
    // rung can itself finish. Once the scene has less time left than TWO
    // candidates need, the reservation protects nothing and the budget in front
    // is a scheduled loss. So: keep the share while the share still buys a whole
    // candidate; below that line the scene has room for exactly one real
    // attempt, and the honest move is to spend what is left on it.
    //
    // Nothing here is a fixed number. `minViableMs` is measured per provider,
    // per media type, from this run's own download and judging timings, so the
    // line moves with the topic, the network and the GPU queue.
    let clampedByScene = false;
    let lastChance = false;
    if (sceneBounded) {
        const share = Math.floor(left * MAX_SCENE_SHARE);
        if (share < ms) {
            if (share < minViableMs) {
                ms = Math.min(left, minViableMs);
                lastChance = true;
            } else {
                ms = share;
            }
            clampedByScene = true;
        }
    }

    ms = Math.round(ms);

    const bits = [
        `base ${Math.round(base.ms / 1000)}s (${base.source})`,
        topic.rank !== null
            ? `topic rank #${topic.rank + 1} x${topic.multiplier}`
            : (topic.listed ? 'topic neutral' : `not in topic list x${UNLISTED_MULTIPLIER}`),
    ];
    if (record !== 1.0) bits.push(`record x${record.toFixed(2)}`);
    if (raisedToViable) bits.push(`raised to the ${Math.round(minViableMs / 1000)}s one-candidate minimum`);
    if (lastChance) {
        bits.push(`last full attempt this scene — ${Math.round(left / 1000)}s left fits one candidate but not a rescue rung, `
            + `so it gets the whole ${Math.round(minViableMs / 1000)}s minimum instead of a ${Math.round(MAX_SCENE_SHARE * 100)}% share it could not finish in`);
    } else if (clampedByScene) {
        bits.push(`clamped to ${Math.round(MAX_SCENE_SHARE * 100)}% of remaining scene time`);
    }
    if (!viable) bits.push(`NOT VIABLE — ${Math.round(left / 1000)}s left, one candidate needs ~${Math.round(minViableMs / 1000)}s`);

    return { ms, disabled: false, explain: bits.join(', '), viable, minViableMs, lastChance };
}

/**
 * THE PREP CLOCK — how long a candidate may spend LOOKING at a source before it
 * starts downloading one.
 *
 * Some providers inspect a source before they fetch it. YouTube's storyboard
 * scout reads the free sprite sheet of a 13-minute video to find the one 4s
 * window that actually matches the scene — real work, worth paying for, and it
 * costs tens of seconds.
 *
 * THE AUG-5 BUG. That inspection was bounded by the SCENE deadline, which the
 * race had just pushed 120s into the future to protect the download. The
 * candidate's own budget was 56s. The scout spent 47 of them, the download began
 * with 9s left, and all four candidates were aborted mid-transfer: four opens,
 * zero verdicts, zero YouTube footage in a 64-scene build whose own topic ranked
 * YouTube first. The same shape as every clock bug in this subsystem — inner
 * work measured against the outer clock.
 *
 * So prep gets its own, tighter deadline: this candidate's own end, minus what a
 * download plus a verdict measurably needs. That reserve is `minViableMs`, which
 * this module measures per provider from the current run, so the line moves with
 * the topic, the network and the GPU queue instead of being a constant that goes
 * stale on someone else's machine.
 *
 * When the reserve eats the whole budget the answer lands in the past, the
 * provider takes its blind window, and every second goes to the bytes. That is
 * the right trade: a blind window the post-download judge still scores beats a
 * perfect window that never finishes downloading.
 *
 * @param {object} o
 * @param {number} [o.startedAt]        when this candidate started (ms epoch);
 *   defaults to now, because a missing start time must not be read as "no clock"
 * @param {number} o.candidateTimeoutMs this candidate's whole budget
 * @param {number} o.minViableMs        measured download+verdict reserve
 * @param {number} [o.sceneDeadlineAt]  the outer scene guard (ms epoch), if any
 * @returns {number} absolute ms deadline. Never 0 when a candidate budget
 *   exists — downstream, 0 means "no limit", which is the bug being closed.
 */
function resolvePrepDeadlineAt({ startedAt, candidateTimeoutMs, minViableMs, sceneDeadlineAt } = {}) {
    const budget = Number(candidateTimeoutMs) || 0;
    // A capped candidate that forgot to say when it started is the one input
    // that could still return 0 — and 0 means "unlimited" to every caller, which
    // is precisely the bug this function exists to remove. So a missing start
    // time means "now": slightly tighter than the truth, never unbounded.
    const start = Number(startedAt) > 0 ? Number(startedAt) : (budget > 0 ? Date.now() : 0);
    const reserve = Math.max(0, Number(minViableMs) || 0);
    const scene = Number(sceneDeadlineAt) || 0;

    // 1, not 0, for the same reason: a budget smaller than the reserve must come
    // back already-expired, not unlimited.
    let at = (start > 0 && budget > 0) ? Math.max(1, start + budget - reserve) : 0;

    // The scene guard still applies — prep may be tighter than the scene, never
    // looser.
    if (scene > 0) at = at > 0 ? Math.min(at, scene) : scene;
    return at;
}

/** Reset measured state. Used by tests. */
function reset() {
    _samples.clear();
    _warned.clear();
}

module.exports = {
    resolveCandidatePatienceMs,
    resolvePrepDeadlineAt,
    recordDownload,
    recordCandidate,
    recordJudging,
    reset,
    // exported for the verify harness
    BOOTSTRAP_MS,
    FLOOR_MS,
    CEILING_MS,
    MAX_SCENE_SHARE,
    RANK_MULTIPLIER,
    UNLISTED_MULTIPLIER,
};
