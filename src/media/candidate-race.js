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

function _winnerQuality(value) {
    const candidate = value?._candidate || value?.candidate || value?.selected || {};
    const baseScore = _clip(value?.score, 0, 10);
    const postScore = _clip(value?.postScore, 0, 10);
    const deepScore = _clip(value?.deepScore || value?.clipAnalysis?.score, 0, 10);
    const finalistScore = _clip(candidate?._candidateFinalistScore || value?.selected?._candidateFinalistScore, 0, 10);
    const mediaScoutScore = _clip(candidate?._mediaScoutScore || value?.selected?._mediaScoutScore, 0, 20);
    const previewScore = _clip(candidate?._previewScoutScore || value?.selected?._previewScoutScore, 0, 10);
    const thumbnailBonus = (candidate?._thumbnailVisionPassed === true || value?.selected?._thumbnailVisionPassed === true) ? 1 : 0;

    return (baseScore * 100)
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
    const quality = _winnerQuality(best);
    const runnerQuality = runner ? _winnerQuality(runner) : 0;
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

    log(`  🏁 [Candidate Race] starting: ${candidates.length} candidate(s), ${concurrency} in parallel per batch, max ${maxBatches} batches, per-candidate cap ${perCandidateTimeoutMs > 0 ? `${Math.round(perCandidateTimeoutMs / 1000)}s` : 'none'}`);

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

    const cleanupPaths = (items, keep = null) => {
        for (const item of items || []) {
            if (!item || item === keep) continue;
            const p = item.path || item.value?.path;
            if (p) {
                try { fs.unlinkSync(p); } catch (_) {}
            }
        }
    };

    while (cursor < candidates.length && batchNo < maxBatches) {
        if (shouldStop()) {
            log(`  🛑 [Candidate Race] aborted before batch ${batchNo + 1} (shouldStop=true)`);
            break;
        }
        batchNo++;
        const slice = candidates.slice(cursor, cursor + concurrency);
        cursor += slice.length;

        log(`  🏁 [Candidate Race] batch ${batchNo}: launching ${slice.length} candidate(s) in parallel`);

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
            && (Date.now() - raceStartedAt) >= maxCollectMs && cursor < candidates.length) {
            cleanupPaths(accepted);
            for (const loser of losers) {
                const p = loser.value?.path;
                if (p) { try { fs.unlinkSync(p); } catch (_) {} }
            }
            log(`  ⏱️ [Candidate Race] ${Math.round(maxCollectMs / 1000)}s budget spent with 0 accepted — bailing (no relevant media) instead of churning ${candidates.length - cursor} more candidate(s)`);
            break;
        }

        if (accepted.length > 0) {
            {
                acceptedPool.push(...accepted);
                acceptedPool.sort((a, b) => (_winnerQuality(b) - _winnerQuality(a)) || (_num(a._raceIndex) - _num(b._raceIndex)));
                const hasEnoughForReferee = acceptedPool.length >= refereeMinCandidates;
                const noMoreCandidates = cursor >= candidates.length;
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
                        verdict = await refereeAcceptedCandidates(refereePool, opts.refereeContext || {});
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
                const winnerEvidence = `quality ${_winnerQuality(winner).toFixed(1)}${runner ? ` vs runner ${_winnerQuality(runner).toFixed(1)}` : ''}`;
                const winnerTitle = String(
                    c.title
                    || c._cachedMeta?.title
                    || c._meta?.title
                    || winner.description
                    || (c.url ? `from ${c.url.replace(/^https?:\/\//, '').slice(0, 70)}` : '')
                    || (winner.path ? `file ${winner.path.split(/[\\/]/).pop()}` : '(untitled clip)')
                ).replace(/\s+/g, ' ').trim().slice(0, 100);
                log(`  [Candidate Race] winner: ${winner.score}/10 - ${winnerTitle || '(untitled clip)'}`);
                log(`  [Candidate Race] winner evidence: ${winnerEvidence}${winner._referee?.reason ? ` | referee: ${winner._referee.reason}` : ''}`);
                cleanupPaths(acceptedPool, winner);
                cleanupPaths(losers.map(l => l.value));
                return winner;
            }
            accepted.sort((a, b) => (_winnerQuality(b) - _winnerQuality(a)) || (_num(a._raceIndex) - _num(b._raceIndex)));
            const winner = accepted[0];
            const c = winner._candidate || winner.candidate || {};
            const runner = accepted[1] || null;
            const winnerEvidence = `quality ${_winnerQuality(winner).toFixed(1)}${runner ? ` vs runner ${_winnerQuality(runner).toFixed(1)}` : ''}`;
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
};
