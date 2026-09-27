/**
 * Candidate Race — parallel download + score
 *
 * "Many editors, one verdict." Instead of trying candidates one-by-one (serial
 * loop), we pull the top-N ranked candidates from Candidate Finalist Scout and
 * run them through download + vision scoring in parallel. The highest-scoring
 * winner is kept; losers are cleaned up.
 *
 * Why this exists:
 *   Serial per-candidate loop pays the full download + ffprobe + vision cost
 *   on every miss. A scene with 5 bad clips burns 5 × ~30s = 2.5 minutes
 *   before bailing. Running 3 in parallel cuts that to ~30s for the batch.
 *
 * Concurrency caps per provider:
 *   - Storyblocks   : 4 — browser provider is now page-isolated/session-gated.
 *   - YouTube       : 4 — yt-dlp + cookie pool tolerate parallel pulls.
 *   - Reddit        : 4 — fallback_url HTTP downloads are plain HTTP.
 *   - Bing          : 5 — HTTP image search/download.
 *   - default       : 3.
 *
 * Budget interactions:
 *   - Vision quota: N parallel candidates = N vision calls per batch. Cost
 *     trade-off is documented in the call site; this orchestrator does not
 *     gate on quota itself.
 *   - Scene Omni: caller is responsible for reserving frames. This module
 *     just sequences the work.
 */

const fs = require('fs');
const { refereeAcceptedCandidates } = require('./candidate-referee');
const { footageSourceClass, realSourceScoreBonus } = require('./niche-strictness');
const { withCostPurpose } = require('../brain/cost-tracker');

// ── Screen-aware racing ─────────────────────────────────────────────────────
// Before any download, the Thumbnail Screen looks at up to 25 preview pictures
// in ONE vision call and says, per candidate, whether it shows the subject.
// Without this, a batch of 5 soldiers was filled straight past the 2 the screen
// had confirmed and into 3 it had just watched show something else — each one
// downloaded and judged again, at a vision call apiece, to learn what the grid
// already said. On the Sep-3 bench build 68% of downloaded clips scored 3/10 or
// lower, and 71% of races ended with no winner at all.
//
// Still a RANKING, never a gate — nothing the screen declined is thrown away:
//   1. candidates it declined race only after every other candidate has had
//      its turn, and never in the same batch as them;
//   2. when their turn comes, a small PROBE goes first. If the probe finds
//      nothing either, the screen has now been confirmed twice and the race
//      stops instead of downloading the rest;
//   3. the screen has to keep earning that trust. Every probe is scored, and a
//      provider whose declined candidates win about as often as the ones the
//      screen liked stops being deferred for the rest of the run.
// Learns inside the run only — nothing here is persisted between builds.
const SCREEN_TRUST_MIN_PROBED = 6;
const _screenRecord = new Map(); // providerKey -> { lead, leadAccepted, declined, declinedAccepted }
const _economy = {
    races: 0,
    screenedRaces: 0,
    soldiers: 0,
    leadSoldiers: 0,
    leadAccepted: 0,
    declinedSoldiers: 0,
    declinedAccepted: 0,
    probes: 0,
    racesEndedByProbe: 0,
    declinedNeverDownloaded: 0,
    heldWinnersKept: 0,
    distrustedProviders: [],
};

function _screenRecordFor(providerKey) {
    const key = providerKey || 'unknown';
    if (!_screenRecord.has(key)) _screenRecord.set(key, { lead: 0, leadAccepted: 0, declined: 0, declinedAccepted: 0 });
    return _screenRecord.get(key);
}

/**
 * Is this provider's "the picture shows something else" still worth acting on?
 * It is until the probes prove otherwise: once enough declined candidates have
 * been raced, they must win clearly less often than the ones the screen liked.
 */
function screenDeferralTrusted(providerKey) {
    if (String(process.env.FOOTAGE_RACE_SCREEN_DEFER || '').trim() === '0') return false;
    const rec = _screenRecordFor(providerKey);
    if (rec.declined < SCREEN_TRUST_MIN_PROBED) return true;
    const declinedRate = rec.declinedAccepted / Math.max(1, rec.declined);
    const leadRate = rec.leadAccepted / Math.max(1, rec.lead);
    return declinedRate < leadRate * 0.5;
}

function _noteSoldiers(providerKey, band, count, acceptedCount) {
    const rec = _screenRecordFor(providerKey);
    if (band === 'declined') {
        rec.declined += count;
        rec.declinedAccepted += acceptedCount;
        _economy.declinedSoldiers += count;
        _economy.declinedAccepted += acceptedCount;
    } else {
        rec.lead += count;
        rec.leadAccepted += acceptedCount;
        _economy.leadSoldiers += count;
        _economy.leadAccepted += acceptedCount;
    }
}

function getRaceEconomy() {
    return JSON.parse(JSON.stringify(_economy));
}

function resetRaceEconomy() {
    _screenRecord.clear();
    for (const key of Object.keys(_economy)) {
        _economy[key] = Array.isArray(_economy[key]) ? [] : 0;
    }
}

function describeRaceEconomy() {
    const e = _economy;
    if (!e.races) return '';
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
    return [
        `[Race Economy] ${e.races} race(s), ${e.soldiers} candidate(s) downloaded + judged`,
        `  screen-liked candidates: ${e.leadSoldiers} raced, ${e.leadAccepted} passed (${pct(e.leadAccepted, e.leadSoldiers)})`,
        `  screen-declined candidates: ${e.declinedSoldiers} raced as probes, ${e.declinedAccepted} passed (${pct(e.declinedAccepted, e.declinedSoldiers)})`,
        `  ${e.racesEndedByProbe} race(s) stopped after a probe confirmed the screen — ${e.declinedNeverDownloaded} declined candidate(s) never downloaded`,
        `  ${e.heldWinnersKept} held winner(s) committed after a later batch found nothing (the old race kept searching and could delete them)`,
        e.distrustedProviders.length ? `  screen stopped being trusted for: ${e.distrustedProviders.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

// Per-provider parallel concurrency. The "army size" per batch.
// Keep public/video scrapers conservative so full builds survive rate limits.
// Free-stock APIs can run slightly wider because they are authenticated APIs.
const PROVIDER_CONCURRENCY = {
    pexels:      3,
    pixabay:     3,
    storyblocks: 1,
    youtube:     2,
    reddit:      2,
    bing:        5,
    brave:       5,
};

function getProviderConcurrency(providerKey, cap = 6) {
    const key = String(providerKey || '').toLowerCase();
    const fromTable = PROVIDER_CONCURRENCY[key];
    const envOverride = parseInt(process.env.FOOTAGE_RACE_CONCURRENCY || '0', 10);
    if (Number.isFinite(envOverride) && envOverride > 0) return Math.min(envOverride, cap);
    return Math.min(fromTable || 3, cap);
}

function _num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function _clip(value, min, max) {
    return Math.max(min, Math.min(max, _num(value)));
}

function _candidateLabel(candidate, fallback = '') {
    const text = String(
        candidate?.title
        || candidate?._cachedMeta?.title
        || candidate?._meta?.title
        || candidate?.url
        || fallback
        || ''
    ).replace(/\s+/g, ' ').trim();
    return text.slice(0, 100) || '(untitled clip)';
}

/**
 * Where did this candidate actually come from? A race pool is normally one
 * provider's results, but topic-bank and media-memory candidates are merged into
 * it and carry their own origin — so the candidate's own field is read first and
 * the race's provider is only the fallback.
 */
function _candidateSourceClass(value, fallbackProviderKey) {
    const candidate = value?._candidate || value?.candidate || value?.selected || {};
    const own = candidate._provider
        || candidate._topicScout?.providerKey
        || candidate._topicScout?.providerName
        || candidate.provider
        || value?.providerKey
        || value?.provider;
    const fromCandidate = footageSourceClass(own);
    if (fromCandidate !== 'unknown') return fromCandidate;
    return footageSourceClass(fallbackProviderKey);
}

/**
 * `baseScore * 100` is the dominant term, so one point of vision score is worth
 * 100 quality points. The real-source bonus is expressed on the same 0-10 scale
 * and scaled the same way, which is what makes "stock must beat real by MORE than
 * the tolerance" a statement about vision scores and not about weights.
 */
function _winnerQuality(value, opts = {}) {
    const candidate = value?._candidate || value?.candidate || value?.selected || {};
    const baseScore = _clip(value?.score, 0, 10);
    const postScore = _clip(value?.postScore, 0, 10);
    const deepScore = _clip(value?.deepScore || value?.clipAnalysis?.score, 0, 10);
    const finalistScore = _clip(candidate?._candidateFinalistScore || value?.selected?._candidateFinalistScore, 0, 10);
    const mediaScoutScore = _clip(candidate?._mediaScoutScore || value?.selected?._mediaScoutScore, 0, 20);
    const previewScore = _clip(candidate?._previewScoutScore || value?.selected?._previewScoutScore, 0, 10);
    const thumbnailBonus = (candidate?._thumbnailVisionPassed === true || value?.selected?._thumbnailVisionPassed === true) ? 1 : 0;
    const realBonus = opts.niche
        ? realSourceScoreBonus(opts.niche, _candidateSourceClass(value, opts.providerKey))
        : 0;

    return (baseScore * 100)
        + (realBonus * 100)
        + (deepScore * 8)
        + (postScore * 5)
        + (finalistScore * 4)
        + (mediaScoutScore * 1.5)
        + (previewScore * 3)
        + (thumbnailBonus * 6);
}

function _obviousWinnerVerdict(best, runner, opts = {}) {
    if (!best) return null;
    const score = _clip(best.score, 0, 10);
    const postScore = _clip(best.postScore, 0, 10);
    const deepScore = _clip(best.deepScore || best.clipAnalysis?.score, 0, 10);
    const quality = _winnerQuality(best, opts);
    const runnerQuality = runner ? _winnerQuality(runner, opts) : 0;
    const qualityGap = runner ? quality - runnerQuality : Infinity;

    const minScore = _clip(opts.earlyAcceptScore || process.env.FOOTAGE_RACE_EARLY_ACCEPT_SCORE || 8, 1, 10);
    const minPost = _clip(opts.earlyAcceptPostScore || process.env.FOOTAGE_RACE_EARLY_ACCEPT_POST_SCORE || minScore, 1, 10);
    const minDeep = _clip(opts.earlyAcceptDeepScore || process.env.FOOTAGE_RACE_EARLY_ACCEPT_DEEP_SCORE || 6, 1, 10);
    const minGap = Math.max(0, Number(opts.earlyAcceptQualityGap || process.env.FOOTAGE_RACE_EARLY_ACCEPT_QUALITY_GAP || 140));

    // Decisive winner: when the top candidate scores at/above this threshold,
    // commit it IMMEDIATELY regardless of how close the runner-up is. The
    // quality-gap rule below assumes a near-tie means "unclear, ask the referee"
    // — but when several candidates are all excellent (e.g. four 9/10 clips),
    // the gap is tiny yet ANY of them is a great pick. Splitting hairs with the
    // AI referee + a winner re-download there just burns the scene deadline:
    // scene 19 of the Bab el-Mandeb build had a 9/10 winner and still TIMED OUT
    // in the referee phase. A high score is sufficient on its own.
    const decisiveScore = _clip(opts.refereeDecisiveScore || process.env.FOOTAGE_RACE_DECISIVE_SCORE || 9, 1, 10);
    const decisive = score >= decisiveScore && (deepScore === 0 || deepScore >= minDeep) && (postScore === 0 || postScore >= minPost);

    if (score < minScore) return null;
    if (postScore > 0 && postScore < minPost) return null;
    if (deepScore > 0 && deepScore < minDeep) return null;
    // Gap requirement only applies BELOW the decisive threshold — a decisive
    // top candidate doesn't need to out-distance the runner-up to win.
    if (!decisive && runner && qualityGap < minGap) return null;

    return {
        winner: best,
        skipped: true,
        confidence: decisive ? 9 : (runner ? 8 : 7),
        compared: runner ? 2 : 1,
        reason: decisive
            ? `decisive winner (${score}/10); committed without AI referee`
            : runner
                ? `clear quality leader (${quality.toFixed(1)} vs ${runnerQuality.toFixed(1)}); skipped AI referee`
                : `single strong accepted candidate (${score}/10); skipped AI referee`,
    };
}

/**
 * Orchestrator. Pulls candidates in batches of N (per-provider concurrency),
 * runs processOne() on each in parallel, picks the highest-scoring accepted
 * candidate, cleans up loser files. Returns the winner or null.
 *
 * processOne(candidate, attempt, { signal }) MUST return either:
 *   { accepted: true,  score: number, path: string, ...extra }   → considered for winner
 *   { accepted: false, path?: string, reason?: string }          → loser, file cleaned up
 *   null / undefined / thrown error                              → loser, swallowed
 *
 * `signal` aborts when this candidate's own timeout fires. Its result will be
 * ignored from that moment on, so processOne should check `signal.aborted`
 * before each expensive step (download, AI judgement, deep analysis) and clean
 * up its own temp file if it bails — the orchestrator can only unlink files it
 * is handed back, and an abandoned soldier hands nothing back.
 *
 * @param {Object} opts
 * @param {Array}  opts.candidates    — already-ranked candidate list (best first)
 * @param {Function} opts.processOne  — async per-candidate processor
 * @param {string} opts.providerKey   — controls concurrency
 * @param {number} [opts.maxBatches]  — stop after N batches (default 3)
 * @param {number} [opts.minAcceptScore] — winning score threshold (default 5)
 * @param {number} [opts.perCandidateTimeoutMs] — kill any soldier slower than this (default 75000; <=0 disables)
 * @param {Function} [opts.log]       — log sink, default console.log
 * @param {Function} [opts.shouldStop] — return true to abort between batches
 * @param {Object} [opts.stats]       — out-param, filled with how the race ended:
 *        `{soldiersRun, soldiersTimedOut, soldiersErrored, soldiersReturned}`.
 *        The caller needs this to tell "this provider's footage was bad" from
 *        "we never let this provider finish" — the return value alone cannot
 *        say, because a quality rejection and an abandoned download both come
 *        back as a plain `{accepted:false}`. Accumulated across every batch, so
 *        it is already correct at each of this function's exits.
 */
async function runCandidateRace(opts = {}) {
    const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
    const processOne = typeof opts.processOne === 'function' ? opts.processOne : null;
    if (!candidates.length || !processOne) return null;

    const providerKey = String(opts.providerKey || '').toLowerCase();
    const requestedConcurrency = Number(opts.concurrency);
    const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.max(1, Math.min(6, Math.floor(requestedConcurrency)))
        : getProviderConcurrency(providerKey);
    const maxBatches = Math.max(1, Math.min(8, Number(opts.maxBatches || 3)));
    const minAcceptScore = Number.isFinite(Number(opts.minAcceptScore)) ? Number(opts.minAcceptScore) : 5;
    const requestedTimeoutMs = Number(opts.perCandidateTimeoutMs);
    const perCandidateTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs <= 0
        ? 0
        : Math.max(20_000, Math.min(600_000, Number(opts.perCandidateTimeoutMs || 75_000)));
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;
    const refereeEnabled = opts.refereeEnabled !== false && process.env.FOOTAGE_AI_REFEREE !== 'false';
    const refereeMinCandidates = Math.max(2, Math.min(8, Number(opts.refereeMinCandidates || process.env.FOOTAGE_AI_REFEREE_MIN_CANDIDATES || 2)));
    const refereeCollectBatches = Math.max(1, Math.min(maxBatches, Number(opts.refereeCollectBatches || process.env.FOOTAGE_AI_REFEREE_COLLECT_BATCHES || 2)));
    const refereeMaxCandidates = Math.max(2, Math.min(10, Number(opts.refereeMaxCandidates || process.env.FOOTAGE_AI_REFEREE_MAX_CANDIDATES || 6)));
    const collectMoreOnBorderline = opts.collectMoreOnBorderline !== false;
    const skipRefereeOnObvious = opts.skipRefereeOnObvious !== false;
    const maxCollectMsRaw = Number(opts.maxCollectMs || process.env.FOOTAGE_RACE_MAX_COLLECT_MS || 0);
    const maxCollectMs = Number.isFinite(maxCollectMsRaw) && maxCollectMsRaw > 0 ? maxCollectMsRaw : 0;
    const refereeNowScore = _clip(opts.refereeNowScore || process.env.FOOTAGE_RACE_REFEREE_NOW_SCORE || 8, 1, 10);
    const refereeNowMinCandidates = Math.max(2, Math.min(10, Number(opts.refereeNowMinCandidates || process.env.FOOTAGE_RACE_REFEREE_NOW_MIN_CANDIDATES || 4)));

    // Screen-aware order — see the note at the top of this file. `ordered` keeps
    // every candidate; the ones the Thumbnail Screen declined simply move behind
    // the rest, keeping their relative order, and `leadCount` marks where they
    // start so no batch ever mixes the two.
    const screenVerdicts = opts.screenVerdicts instanceof Map && opts.screenVerdicts.size ? opts.screenVerdicts : null;
    const isDeclined = (candidate) => !!screenVerdicts && screenVerdicts.get(candidate) === 'no';
    const deferDeclined = !!screenVerdicts && screenDeferralTrusted(providerKey);
    let ordered = candidates;
    let leadCount = candidates.length;
    if (deferDeclined) {
        const leads = [];
        const declined = [];
        for (const candidate of candidates) (isDeclined(candidate) ? declined : leads).push(candidate);
        if (declined.length) {
            ordered = [...leads, ...declined];
            leadCount = leads.length;
        }
    }
    const probeSize = Math.max(1, Math.min(2, concurrency));
    let probeDone = false;
    _economy.races++;
    if (leadCount < ordered.length) _economy.screenedRaces++;

    log(`  🏁 [Candidate Race] starting: ${candidates.length} candidate(s), ${concurrency} in parallel per batch, max ${maxBatches} batches, per-candidate cap ${perCandidateTimeoutMs > 0 ? `${Math.round(perCandidateTimeoutMs / 1000)}s` : 'none'}`
        + (leadCount < ordered.length ? `; ${ordered.length - leadCount} the thumbnail screen declined wait behind the other ${leadCount}` : ''));

    // Wrap a processOne call with a timeout. Slow stragglers don't drag the
    // batch wall-clock — they get killed and counted as losers.
    //
    // "Killed" used to be a lie. The timer resolved the OUTER promise and walked
    // away; the soldier itself kept running — still downloading, still queueing
    // vision calls, still holding a temp file nobody would ever unlink (the
    // orchestrator's loser cleanup needs a `path`, and an abandoned soldier
    // never returns one). A build with a 20s cap and 6-minute stragglers ended
    // up with a dozen ghosts competing with the live batch for the same GPU,
    // which made the live batch slower, which made more soldiers time out. Every
    // "done in 20.0s" in that log was followed minutes later by the ghost's own
    // completion line.
    //
    // Now each soldier gets its own abort signal. On timeout we abort FIRST and
    // resolve second, so the soldier learns it was abandoned at its next
    // checkpoint, stops before paying for anything else, and cleans up after
    // itself.
    const withTimeout = (candidate, attemptIdx) => new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const ctl = new AbortController();
        if (perCandidateTimeoutMs > 0) {
            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                const reason = `per-candidate timeout (${Math.round(perCandidateTimeoutMs / 1000)}s)`;
                try { ctl.abort(new Error(reason)); } catch (_) {}
                resolve({ accepted: false, reason, timedOut: true });
            }, perCandidateTimeoutMs);
        }
        Promise.resolve()
            .then(() => processOne(candidate, attemptIdx, { signal: ctl.signal }))
            .then((value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve(value || { accepted: false });
            })
            .catch((err) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve({ accepted: false, error: err?.message || String(err) });
            });
    });

    let cursor = 0;
    let batchNo = 0;
    let acceptedPool = [];
    const raceStartedAt = Date.now();

    // See the `opts.stats` doc above. Written through, never replaced, so the
    // caller's own object is the one that gets filled.
    const stats = (opts.stats && typeof opts.stats === 'object') ? opts.stats : null;
    if (stats) {
        stats.soldiersRun = _num(stats.soldiersRun);
        stats.soldiersTimedOut = _num(stats.soldiersTimedOut);
        stats.soldiersErrored = _num(stats.soldiersErrored);
        stats.soldiersReturned = _num(stats.soldiersReturned);
    }

    const cleanupPaths = (items, keep = null) => {
        for (const item of items || []) {
            if (!item || item === keep) continue;
            const p = item.path || item.value?.path;
            if (p) {
                try { fs.unlinkSync(p); } catch (_) {}
            }
        }
    };

    while (cursor < ordered.length && batchNo < maxBatches) {
        if (shouldStop()) {
            log(`  🛑 [Candidate Race] aborted before batch ${batchNo + 1} (shouldStop=true)`);
            break;
        }
        batchNo++;
        // A batch stops at the edge of the declined band, and the first batch
        // inside it is a small probe.
        let batchSize = concurrency;
        let probing = false;
        if (cursor < leadCount) {
            batchSize = Math.min(concurrency, leadCount - cursor);
        } else if (leadCount < ordered.length && !probeDone) {
            batchSize = Math.min(probeSize, ordered.length - cursor);
            probing = true;
            probeDone = true;
            _economy.probes++;
        }
        const slice = ordered.slice(cursor, cursor + batchSize);
        cursor += slice.length;

        log(probing
            ? `  🏁 [Candidate Race] batch ${batchNo}: probing ${slice.length} candidate(s) the thumbnail screen declined`
            : `  🏁 [Candidate Race] batch ${batchNo}: launching ${slice.length} candidate(s) in parallel`);

        const startedAt = Date.now();
        const outcomes = await Promise.allSettled(
            slice.map((candidate, i) => withTimeout(candidate, cursor - slice.length + i))
        );
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

        const accepted = [];
        const losers = [];
        for (let i = 0; i < outcomes.length; i++) {
            const settled = outcomes[i];
            const value = settled.status === 'fulfilled' ? settled.value : null;
            if (value && value.accepted && Number(value.score || 0) >= minAcceptScore) {
                accepted.push({ ...value, _candidate: slice[i], _raceIndex: cursor - slice.length + i });
            } else {
                losers.push({ value, candidate: slice[i] });
            }
        }

        const timedOutCount = losers.filter(l => l.value?.timedOut).length;
        const visionApiFailCount = losers.filter(l => l.value?._visionApiFailed).length;
        // Reported for visibility only — an unreadable scorecard means the vision
        // service ANSWERED, so it must never feed the abort rule below.
        const visionUnparsedCount = losers.filter(l => l.value?._visionUnparsed).length;
        const storyblocksAuthDeadCount = losers.filter(l => l.value?._storyblocksAuthDead).length;

        // Record how this batch's soldiers ended, for the caller's provider
        // record. `errored` is a soldier that threw or came back empty — a real
        // failure. `returned` is one that finished and had an answer, whether
        // that answer was "accepted" or "not good enough". Only `timedOut` means
        // we ended it ourselves, and that is the one the caller must not hold
        // against the provider.
        if (stats) {
            const erroredCount = losers.filter(l => !l.value?.timedOut && (!l.value || l.value.error)).length;
            stats.soldiersRun += slice.length;
            stats.soldiersTimedOut += timedOutCount;
            stats.soldiersErrored += erroredCount;
            stats.soldiersReturned += Math.max(0, slice.length - timedOutCount - erroredCount);
        }

        // What this batch teaches about the screen. Only soldiers that came back
        // with a real verdict count: a timeout, a crash or a vision outage says
        // nothing about whether the preview picture told the truth.
        _economy.soldiers += slice.length;
        if (screenVerdicts) {
            const wasTrusted = screenDeferralTrusted(providerKey);
            const tally = { lead: [0, 0], declined: [0, 0] };
            for (let i = 0; i < outcomes.length; i++) {
                const value = outcomes[i].status === 'fulfilled' ? outcomes[i].value : null;
                if (!value || value.timedOut || value.error || value._visionApiFailed || value._abandoned) continue;
                const band = isDeclined(slice[i]) ? 'declined' : 'lead';
                tally[band][0]++;
                if (value.accepted && Number(value.score || 0) >= minAcceptScore) tally[band][1]++;
            }
            if (tally.lead[0]) _noteSoldiers(providerKey, 'lead', tally.lead[0], tally.lead[1]);
            if (tally.declined[0]) _noteSoldiers(providerKey, 'declined', tally.declined[0], tally.declined[1]);
            if (wasTrusted && !screenDeferralTrusted(providerKey) && !_economy.distrustedProviders.includes(providerKey)) {
                _economy.distrustedProviders.push(providerKey);
                log(`  [Race Economy] ${providerKey}: candidates the thumbnail screen declined keep passing — no longer deferring them this run`);
            }
        }

        const tagBits = [];
        if (timedOutCount) tagBits.push(`${timedOutCount} timed out`);
        if (visionApiFailCount) tagBits.push(`${visionApiFailCount} vision API failed`);
        if (visionUnparsedCount) tagBits.push(`${visionUnparsedCount} score unreadable`);
        if (storyblocksAuthDeadCount) tagBits.push(`${storyblocksAuthDeadCount} storyblocks auth dead`);
        log(`  🏁 [Candidate Race] batch ${batchNo} done in ${elapsed}s: ${accepted.length} accepted, ${losers.length} rejected/errored${tagBits.length ? ` (${tagBits.join(', ')})` : ''}`);

        // Abort the entire race if vision API is broken: when ≥ half the
        // batch failed due to vision-API errors (Qwen + NVIDIA both down),
        // there's no point downloading more candidates — they'll all
        // score 0 because we can't judge them.
        if (visionApiFailCount > 0 && visionApiFailCount >= Math.ceil(slice.length / 2)) {
            cleanupPaths(acceptedPool);
            cleanupPaths(accepted);
            log(`  🛑 [Candidate Race] vision API unavailable for ≥half the batch — aborting race (saves budget on un-judgable candidates)`);
            for (const loser of losers) {
                const p = loser.value?.path;
                if (p) { try { fs.unlinkSync(p); } catch (_) {} }
            }
            return null;
        }

        // Abort if Storyblocks auth-dead is the dominant cause (kill switch
        // tripped mid-batch). Race won't find anything from Storyblocks now.
        if (storyblocksAuthDeadCount > 0 && storyblocksAuthDeadCount >= Math.ceil(slice.length / 2)) {
            cleanupPaths(acceptedPool);
            cleanupPaths(accepted);
            log(`  🛑 [Candidate Race] Storyblocks auth dead — aborting race for this provider`);
            for (const loser of losers) {
                const p = loser.value?.path;
                if (p) { try { fs.unlinkSync(p); } catch (_) {} }
            }
            return null;
        }

        // Empty-pool wall-clock bail: if the collection budget has elapsed and
        // NOTHING has been accepted across all batches so far, stop churning the
        // (often expanded) army budget over the whole per-scene deadline. No
        // candidate cleared the accept floor → there is no relevant media here, so
        // bail fast to the scene's fallback/continuity instead of burning 6-13 min
        // on ~20 doomed candidates. The OUTCOME is unchanged (continuity either
        // way); this only stops the wasted time. (Global.)
        //
        // `accepted.length === 0` is load-bearing: this batch's winners are not
        // pushed into acceptedPool until below, so testing the pool alone reads
        // "empty" for a batch that just accepted 5 clips — and the cleanup on the
        // next line then DELETES them. Measured on a real 64-scene build: 55 bails,
        // 34 of them one line after a batch reported 1-5 accepted, 84 already-scored
        // candidates destroyed (including 7/10 exact matches). Whichever clip a scene
        // ended up with was decided by vision latency, not by footage quality.
        // With this guard the batch falls through to `collectBudgetSpent` below,
        // which already says "budget spent → commit the best held candidate (even 1)".
        if (maxCollectMs > 0 && acceptedPool.length === 0 && accepted.length === 0
            && (Date.now() - raceStartedAt) >= maxCollectMs && cursor < ordered.length) {
            cleanupPaths(accepted);
            for (const loser of losers) {
                const p = loser.value?.path;
                if (p) { try { fs.unlinkSync(p); } catch (_) {} }
            }
            log(`  ⏱️ [Candidate Race] ${Math.round(maxCollectMs / 1000)}s budget spent with 0 accepted — bailing (no relevant media) instead of churning ${ordered.length - cursor} more candidate(s)`);
            break;
        }

        // The probe found nothing and nothing is held: the screen said "this
        // shows something else" and two downloads just agreed. Stop here rather
        // than download the rest of what it declined. Only the candidates this
        // race could still have reached are counted as saved.
        const probeConfirmedScreen = probing && accepted.length === 0;
        if (probeConfirmedScreen && acceptedPool.length === 0) {
            const remaining = ordered.length - cursor;
            const reachable = Math.min(remaining, Math.max(0, maxBatches - batchNo) * concurrency);
            _economy.racesEndedByProbe++;
            _economy.declinedNeverDownloaded += reachable;
            for (const loser of losers) {
                const p = loser.value?.path;
                if (p) { try { fs.unlinkSync(p); } catch (_) {} }
            }
            log(`  🛑 [Candidate Race] probe of ${slice.length} screen-declined candidate(s) found nothing — the thumbnail screen was right; not downloading the other ${remaining}`);
            break;
        }

        // Decide whenever something is HELD, not only when this batch accepted.
        // Before, a race that was holding an accepted clip for comparison and
        // then drew a batch with nothing in it walked past the decision, kept
        // launching batches, and at the end deleted the clip it was holding and
        // reported "no winner" — paying for a vision verdict it then threw away.
        if (accepted.length > 0 || acceptedPool.length > 0) {
            {
                const decidingOnHeldOnly = accepted.length === 0;
                acceptedPool.push(...accepted);
                acceptedPool.sort((a, b) => (_winnerQuality(b, opts) - _winnerQuality(a, opts)) || (_num(a._raceIndex) - _num(b._raceIndex)));
                const hasEnoughForReferee = acceptedPool.length >= refereeMinCandidates;
                const noMoreCandidates = cursor >= ordered.length;
                const collectionDone = batchNo >= refereeCollectBatches;
                const bestHeld = acceptedPool[0];
                const runnerHeld = acceptedPool.find(item => item !== bestHeld) || null;
                const obviousVerdict = skipRefereeOnObvious
                    ? _obviousWinnerVerdict(bestHeld, runnerHeld, opts)
                    : null;
                const raceElapsedMs = Date.now() - raceStartedAt;
                const enoughStrongCandidates = hasEnoughForReferee
                    && acceptedPool.length >= refereeNowMinCandidates
                    && _clip(bestHeld.score, 0, 10) >= refereeNowScore;
                // Hard ceiling: once the collection budget is spent, COMMIT the
                // best-held candidate with whatever we have (even 1). Holding for
                // "more/clearer" candidates past the budget is what let scenes burn
                // the whole per-scene deadline and then get discarded → no media.
                // A relevant 7/10 in hand always beats a timeout. (Global.)
                const collectBudgetSpent = maxCollectMs > 0
                    && raceElapsedMs >= maxCollectMs
                    && acceptedPool.length >= 1;
                const forceDecisionReason = enoughStrongCandidates
                    ? `${acceptedPool.length} accepted candidate(s), best ${bestHeld.score}/10`
                    : collectBudgetSpent
                        ? `collection budget ${Math.round(maxCollectMs / 1000)}s spent with ${acceptedPool.length} accepted candidate(s)`
                        : probeConfirmedScreen
                            ? `probe of screen-declined candidates found nothing better than the ${acceptedPool.length} held`
                            : '';
                if (!obviousVerdict && forceDecisionReason) {
                    log(`  [Candidate Race] forcing referee/score decision now (${forceDecisionReason}); not launching another batch`);
                }
                if (!obviousVerdict && !forceDecisionReason && collectMoreOnBorderline && !noMoreCandidates && !collectionDone) {
                    log(`  [Candidate Race] holding ${acceptedPool.length} accepted candidate(s); batch ${batchNo}/${refereeCollectBatches} was not a clear winner yet`);
                    log(`  [Candidate Race] current best: ${bestHeld.score}/10 - ${_candidateLabel(bestHeld._candidate || bestHeld.selected, bestHeld.description)}`);
                    cleanupPaths(losers.map(l => l.value));
                    continue;
                }
                if (process.env.FOOTAGE_AI_REFEREE_HOLD_SINGLE === 'true' && !hasEnoughForReferee && !noMoreCandidates && !collectionDone) {
                    log(`  [AI Referee] holding ${acceptedPool.length} accepted candidate(s); collecting one more batch for comparison`);
                    log(`  [AI Referee] current best: ${bestHeld.score}/10 - ${_candidateLabel(bestHeld._candidate || bestHeld.selected, bestHeld.description)}`);
                    cleanupPaths(losers.map(l => l.value));
                    continue;
                }

                const refereePool = acceptedPool.slice(0, refereeMaxCandidates);
                let verdict = obviousVerdict;
                if (verdict?.winner) {
                    verdict.winner._referee = {
                        skipped: true,
                        reason: verdict.reason,
                        confidence: verdict.confidence || 0,
                        compared: verdict.compared || refereePool.length,
                    };
                    log(`  [AI Referee] skipped (${verdict.reason})`);
                }
                if (!verdict && refereeEnabled && refereePool.length >= 2) {
                    try {
                        log(`  [AI Referee] comparing ${refereePool.length} accepted candidate(s)`);
                        verdict = await withCostPurpose('race-referee', () => refereeAcceptedCandidates(refereePool, opts.refereeContext || {}));
                        if (verdict?.rejectAll) {
                            log(`  [AI Referee] rejected shortlist: ${verdict.reason || 'no editorial fit'}`);
                            cleanupPaths(acceptedPool);
                            cleanupPaths(losers.map(l => l.value));
                            acceptedPool = [];
                            continue;
                        }
                        if (verdict?.winner) {
                            const picked = verdict.winner;
                            picked._referee = {
                                ai: !verdict.skipped && !verdict.fallback,
                                fallback: !!verdict.fallback,
                                skipped: !!verdict.skipped,
                                reason: verdict.reason || '',
                                confidence: verdict.confidence || 0,
                                compared: verdict.compared || refereePool.length,
                                choice: verdict.choice || null,
                            };
                            log(`  [AI Referee] picked C${verdict.choice || '?'} (${picked.score}/10, confidence ${verdict.confidence || 0}/10): ${verdict.reason || 'best editorial fit'}`);
                        }
                    } catch (e) {
                        log(`  [AI Referee] skipped (${String(e?.message || e).slice(0, 120)}); using score fallback`);
                        verdict = null;
                    }
                } else if (refereePool.length === 1) {
                    log(`  [AI Referee] single accepted candidate; no comparison needed`);
                }

                const winner = verdict?.winner || refereePool[0] || acceptedPool[0];
                const c = winner._candidate || winner.candidate || winner.selected || {};
                const runner = acceptedPool.find(item => item !== winner) || null;
                const winnerEvidence = `quality ${_winnerQuality(winner, opts).toFixed(1)}${runner ? ` vs runner ${_winnerQuality(runner, opts).toFixed(1)}` : ''}`;
                const winnerTitle = String(
                    c.title
                    || c._cachedMeta?.title
                    || c._meta?.title
                    || winner.description
                    || (c.url ? `from ${c.url.replace(/^https?:\/\//, '').slice(0, 70)}` : '')
                    || (winner.path ? `file ${winner.path.split(/[\\/]/).pop()}` : '(untitled clip)')
                ).replace(/\s+/g, ' ').trim().slice(0, 100);
                if (decidingOnHeldOnly) {
                    _economy.heldWinnersKept++;
                    log(`  [Candidate Race] committing the held candidate — batch ${batchNo} found nothing better`);
                }
                log(`  [Candidate Race] winner: ${winner.score}/10 - ${winnerTitle || '(untitled clip)'}`);
                log(`  [Candidate Race] winner evidence: ${winnerEvidence}${winner._referee?.reason ? ` | referee: ${winner._referee.reason}` : ''}`);
                cleanupPaths(acceptedPool, winner);
                cleanupPaths(losers.map(l => l.value));
                return winner;
            }
            accepted.sort((a, b) => (_winnerQuality(b, opts) - _winnerQuality(a, opts)) || (_num(a._raceIndex) - _num(b._raceIndex)));
            const winner = accepted[0];
            const c = winner._candidate || winner.candidate || {};
            const runner = accepted[1] || null;
            const winnerEvidence = `quality ${_winnerQuality(winner, opts).toFixed(1)}${runner ? ` vs runner ${_winnerQuality(runner, opts).toFixed(1)}` : ''}`;
            const winnerTitle = String(
                c.title
                || c._cachedMeta?.title
                || c._meta?.title
                || winner.description
                || (c.url ? `from ${c.url.replace(/^https?:\/\//, '').slice(0, 70)}` : '')
                || winner.path ? `file ${winner.path.split(/[\\/]/).pop()}` : '(untitled clip)'
            ).replace(/\s+/g, ' ').trim().slice(0, 100);
            log(`  🏆 [Candidate Race] winner: ${winner.score}/10 — ${winnerTitle || '(untitled clip)'}`);

            log(`  [Candidate Race] winner evidence: ${winnerEvidence}`);

            // Clean up any other accepted candidates (only one winner per scene)
            // and any loser files that produced a path.
            for (const loser of accepted.slice(1)) {
                if (loser.path) {
                    try { fs.unlinkSync(loser.path); } catch (_) {}
                }
            }
            for (const loser of losers) {
                const p = loser.value?.path;
                if (p) {
                    try { fs.unlinkSync(p); } catch (_) {}
                }
            }
            return winner;
        }

        // No winner — clean up any files the losers produced
        for (const loser of losers) {
            const p = loser.value?.path;
            if (p) {
                try { fs.unlinkSync(p); } catch (_) {}
            }
        }
    }

    log(`  ❌ [Candidate Race] no winner after ${batchNo} batch(es)`);
    cleanupPaths(acceptedPool);
    return null;
}

module.exports = {
    runCandidateRace,
    getProviderConcurrency,
    screenDeferralTrusted,
    getRaceEconomy,
    resetRaceEconomy,
    describeRaceEconomy,
};
