#!/usr/bin/env node
'use strict';

/**
 * THE RACE CLOCK GATE — "never kill a download we asked for."
 *
 * The user's words after the Aug-5 build: "no mercy — i'm tired of fixing the
 * same shit over and over." This file is the "over and over" part. Three
 * separate clock bugs shipped in this subsystem, all with the same shape:
 * inner work measured against the wrong, outer clock. Each one produced the
 * same visible symptom — a provider the topic ranked FIRST won nothing at all,
 * and scenes fell through to placeholder cards the user has called unusable.
 *
 *   1. THE IMPOSSIBLE BUDGET. The scene-share clamp handed out budgets shorter
 *      than download-patience's own measured one-candidate minimum. YouTube got
 *      56s against a ~60s minimum, scene after scene. Nothing could ever finish.
 *
 *   2. THE DEATH SPIRAL. A candidate killed by that clock was recorded as a
 *      quality LOSS. The provider's win rate fell, the record multiplier shrank
 *      its NEXT budget, it was killed sooner, the record fell further. A budget
 *      bug wearing a quality bug's clothes. Final score of that build: 29 Pexels,
 *      22 Bing, 4 Pexels images, 1 Reddit, ZERO YouTube — from 24 missions that
 *      ranked YouTube first.
 *
 *   3. THE PREP CLOCK. YouTube's storyboard scout — which reads a free sprite
 *      sheet to find the right 4s window inside a 13-minute video — was bounded
 *      by the SCENE deadline, which the race had just pushed 120s out to protect
 *      the download. The candidate's own budget was 56s. The scout spent 47 of
 *      them; the download began with 9s left; all four candidates were aborted
 *      mid-transfer.
 *
 * This gate pins the three fixes BEHAVIOURALLY — it runs the real modules and
 * checks what they answer, not what their comments claim. It also pins the rule
 * the user set for this whole subsystem: one global mechanism, measured from
 * the run in front of it. "A flat global constant is as wrong as a per-niche
 * if." So the estimates here must MOVE when the evidence moves; a check that
 * only asserts a number would pass against a hardcoded constant, and is not
 * allowed to be the only check.
 */

// download-patience reads env overrides; a developer's own .env must not
// decide whether this gate passes.
delete process.env.DOWNLOAD_PATIENCE_MS;
delete process.env.DOWNLOAD_PATIENCE_VIDEO_MS;
delete process.env.DOWNLOAD_PATIENCE_IMAGE_MS;
delete process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS;

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const failures = [];
const checks = [];

function check(label, fn) {
    try {
        const note = fn();
        checks.push(`  ✓ ${label}${note ? ` — ${note}` : ''}`);
    } catch (err) {
        failures.push(`  ✗ ${label}\n      ${err.message}`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const patience = require(path.join(ROOT, 'src/media/download-patience.js'));
const scoreboard = require(path.join(ROOT, 'src/media/provider-scoreboard.js'));
const scout = require(path.join(ROOT, 'src/media/storyboard-scout.js'));

// ── 1. The impossible budget ────────────────────────────────────────────────
// A race is only worth opening if the budget it hands out can actually reach a
// verdict. The clamp that reserves time for the rescue ladder must never cut
// below the module's own measured one-candidate minimum.

check('a viable budget is never shorter than the measured one-candidate minimum', () => {
    patience.reset();
    const seen = [];
    // Sweep the whole range where the scene-share clamp bites, for both media
    // types. The bug only appeared in a narrow band, so one sample proves
    // nothing.
    for (const mediaType of ['video', 'image']) {
        for (let remaining = 5000; remaining <= 400000; remaining += 5000) {
            const p = patience.resolveCandidatePatienceMs({
                mediaType,
                providerKey: 'youtube',
                nicheId: 'news.politics',
                remainingSceneMs: remaining,
                log: () => {},
            });
            if (!p.viable || p.disabled || p.ms === 0) continue;
            const floor = Math.min(remaining, p.minViableMs);
            assert(p.ms >= floor,
                `${mediaType} with ${remaining}ms left got ${p.ms}ms, below the ${floor}ms it needs to reach a verdict `
                + `(minViable ${p.minViableMs}ms) — that is the Aug-5 impossible budget`);
            seen.push(p.ms);
        }
    }
    assert(seen.length > 20, `only ${seen.length} viable budgets sampled — the sweep is not exercising the clamp`);
    return `${seen.length} budgets swept, none below the verdict line`;
});

check('the last-chance branch spends the whole minimum instead of an unfinishable share', () => {
    patience.reset();
    const probe = patience.resolveCandidatePatienceMs({
        mediaType: 'video', providerKey: 'youtube', remainingSceneMs: Infinity, log: () => {},
    });
    // Just above the min-viable line, the 55% share is guaranteed too short.
    const remaining = Math.round(probe.minViableMs * 1.2);
    const p = patience.resolveCandidatePatienceMs({
        mediaType: 'video', providerKey: 'youtube', remainingSceneMs: remaining, log: () => {},
    });
    assert(p.lastChance === true, 'lastChance was not flagged where the share falls under the minimum');
    assert(p.ms >= Math.min(remaining, p.minViableMs),
        `last-chance budget ${p.ms}ms is still under the ${p.minViableMs}ms minimum`);
    return `${Math.round(remaining / 1000)}s left → ${Math.round(p.ms / 1000)}s, not a ${Math.round(remaining * 0.55 / 1000)}s share`;
});

// ── 2. The death spiral ─────────────────────────────────────────────────────
// A candidate the clock killed produced no verdict. That is evidence about our
// budget, not about the provider's footage, and it must not be filed as quality.

check('clock-kills leave a provider unproven, not bad', () => {
    scoreboard.reset();
    for (let i = 0; i < 6; i++) scoreboard.recordOpen('video', 'youtube');
    for (let i = 0; i < 6; i++) scoreboard.recordNoContest('video', 'youtube', 'soldier timeout');
    assert(scoreboard.opens('video', 'youtube') === 0,
        `6 clock-kills counted as ${scoreboard.opens('video', 'youtube')} contested openings — they are not evidence`);
    assert(scoreboard.winRate('video', 'youtube') === 0.5,
        `win rate ${scoreboard.winRate('video', 'youtube')} after only clock-kills; must stay neutral at 0.5`);
    return '6 timeouts → 0 evidence, rate 0.5';
});

check('real losses still punish — the fix did not blind the scoreboard', () => {
    scoreboard.reset();
    for (let i = 0; i < 5; i++) { scoreboard.recordOpen('video', 'pixabay'); scoreboard.recordLoss('video', 'pixabay', 'watermarked'); }
    const rate = scoreboard.winRate('video', 'pixabay');
    assert(scoreboard.opens('video', 'pixabay') === 5, 'real losses must count as evidence');
    assert(rate < 0.3, `win rate after 5 judged failures is ${rate}; the scoreboard has stopped punishing bad footage`);
    return `5 judged failures → rate ${rate.toFixed(3)}`;
});

check('a clock-killed provider is not demoted below a proven-worse one', () => {
    scoreboard.reset();
    // youtube: never got to a verdict. pexels: judged and genuinely poor.
    for (let i = 0; i < 6; i++) { scoreboard.recordOpen('video', 'youtube'); scoreboard.recordNoContest('video', 'youtube', 'soldier timeout'); }
    for (let i = 0; i < 6; i++) { scoreboard.recordOpen('video', 'pexels'); scoreboard.recordLoss('video', 'pexels', 'off topic'); }
    const { order } = scoreboard.adjustOrder(['youtube', 'pexels'], 'video');
    assert(order[0] === 'youtube',
        `order came back ${JSON.stringify(order)} — a provider we never let finish was demoted beneath one we judged and rejected`);
    return 'timed-out youtube keeps its rank over judged-bad pexels';
});

check('the summary reports no-contests separately from losses', () => {
    scoreboard.reset();
    scoreboard.recordOpen('video', 'youtube');
    scoreboard.recordNoContest('video', 'youtube', 'soldier timeout');
    scoreboard.recordOpen('video', 'youtube');
    scoreboard.recordLoss('video', 'youtube', 'off topic');
    const rows = scoreboard.summary();
    const row = (Array.isArray(rows) ? rows : []).find(r => String(r.provider || r.key || '').includes('youtube'));
    assert(row, `summary() produced no youtube row: ${JSON.stringify(rows).slice(0, 200)}`);
    assert(Number(row.noContests) === 1, `noContests reads ${row.noContests}, expected 1 — a timeout is being folded back into losses`);
    assert(Number(row.contestedOpens) === 1, `contestedOpens reads ${row.contestedOpens}, expected 1`);
    return 'noContests and contestedOpens both surfaced';
});

// ── 3. The prep clock ───────────────────────────────────────────────────────
// Looking inside a source is real work worth paying for, but it must be paid
// for out of the candidate's own budget, with the download's share reserved.

check('prep time is the candidate budget minus the measured download+verdict reserve', () => {
    const now = 1_000_000;
    const at = patience.resolvePrepDeadlineAt({
        startedAt: now, candidateTimeoutMs: 56_000, minViableMs: 40_000, sceneDeadlineAt: now + 120_000,
    });
    assert(at === now + 16_000,
        `prep deadline ${at - now}ms into the run; expected 16000ms (56s budget − 40s reserve)`);
    return '56s budget, 40s reserve → 16s of look-inside time';
});

check('the reserve is measured evidence, not a constant — a different reserve moves the answer', () => {
    const now = 1_000_000;
    const tight = patience.resolvePrepDeadlineAt({ startedAt: now, candidateTimeoutMs: 90_000, minViableMs: 20_000 });
    const roomy = patience.resolvePrepDeadlineAt({ startedAt: now, candidateTimeoutMs: 90_000, minViableMs: 70_000 });
    assert(tight > roomy,
        'the prep deadline did not move when the measured reserve changed — it is ignoring its input');
    assert(tight - now === 70_000 && roomy - now === 20_000,
        `expected 70s and 20s of prep, got ${(tight - now) / 1000}s and ${(roomy - now) / 1000}s`);
    return 'reserve 20s → 70s prep; reserve 70s → 20s prep';
});

check('the scene deadline never loosens the prep clock', () => {
    const now = 1_000_000;
    // The exact Aug-5 shape: Deadline Grace pushed the scene 120s out while the
    // candidate only had 56s. Prep must follow the 56s, not the 120s.
    const at = patience.resolvePrepDeadlineAt({
        startedAt: now, candidateTimeoutMs: 56_000, minViableMs: 40_000, sceneDeadlineAt: now + 120_000,
    });
    assert(at < now + 56_000, `prep deadline ran past the candidate's own budget (${(at - now) / 1000}s)`);
    // And it must still tighten when the SCENE is the shorter of the two.
    const tightened = patience.resolvePrepDeadlineAt({
        startedAt: now, candidateTimeoutMs: 200_000, minViableMs: 10_000, sceneDeadlineAt: now + 30_000,
    });
    assert(tightened === now + 30_000, `scene guard did not tighten prep: ${(tightened - now) / 1000}s`);
    return 'candidate clock wins when tighter, scene clock wins when tighter';
});

check('a capped candidate can never come back with 0, which means "unlimited"', () => {
    const now = 1_000_000;
    // Reserve larger than the budget: no prep time at all.
    const spent = patience.resolvePrepDeadlineAt({ startedAt: now, candidateTimeoutMs: 20_000, minViableMs: 90_000 });
    assert(spent !== 0, 'a candidate with no spare time got 0 — every caller reads that as UNLIMITED');
    assert(spent < now, `expected a deadline already in the past, got ${spent - now}ms relative`);

    // The other route to 0, and the realistic one: a capped candidate whose
    // start time never arrived. Answering 0 here would hand the scout an
    // unbounded clock again while the candidate still had a 40s budget.
    const noStart = patience.resolvePrepDeadlineAt({ candidateTimeoutMs: 40_000, minViableMs: 10_000 });
    assert(noStart > 0,
        'a capped candidate with a missing start time got prep deadline 0 — the Aug-5 unbounded scout is reachable again');
    assert(noStart <= Date.now() + 40_000,
        `a missing start time bought MORE prep time than the whole budget (${noStart - Date.now()}ms)`);
    return 'no spare time → already expired; missing start time → assumed now';
});

check('no candidate budget still means no prep cap (nothing else regressed)', () => {
    assert(patience.resolvePrepDeadlineAt({ startedAt: 1_000_000, candidateTimeoutMs: 0, minViableMs: 40_000 }) === 0,
        'an uncapped candidate gained a prep cap out of nowhere');
    assert(patience.resolvePrepDeadlineAt({}) === 0, 'an empty call must be a no-op');
    return 'uncapped stays uncapped';
});

// ── 4. The scout knows what it costs ────────────────────────────────────────
// The caller can only skip a scout run it cannot afford if the scout can say
// what a run costs. That answer has to come from this run's own completed runs.

check('with no evidence the scout quotes its ceiling, so a tight scene will not gamble', () => {
    scout._resetRunMs();
    process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS = '90000';
    try {
        assert(scout.estimatedRunMs() === 90_000, `unproven estimate is ${scout.estimatedRunMs()}, expected the 90000 ceiling`);
        process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS = '45000';
        assert(scout.estimatedRunMs() === 45_000,
            'the unproven estimate ignored the configured ceiling — it is a hardcoded number');
    } finally {
        delete process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS;
        scout._resetRunMs();
    }
    return 'ceiling honoured at 90s and at 45s';
});

check('once runs complete the estimate is measured from them, and it moves with them', () => {
    process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS = '90000';
    try {
        scout._resetRunMs();
        [8000, 9000, 10000, 11000].forEach(scout._seedRunMs);
        const fast = scout.estimatedRunMs();
        assert(fast < 90_000, `estimate stayed at the ceiling (${fast}) after 4 fast runs — evidence is being ignored`);
        assert(fast >= 8000 && fast <= 11000, `estimate ${fast} is outside the samples it was built from`);

        scout._resetRunMs();
        [40000, 45000, 50000, 55000].forEach(scout._seedRunMs);
        const slow = scout.estimatedRunMs();
        assert(slow > fast,
            `a slower machine measured ${slow} vs ${fast} on a faster one — the estimate is not derived from evidence`);

        // p75, not the mean: an overrun costs the download, a skip costs only a
        // blind window the post-download judge still checks.
        scout._resetRunMs();
        [10000, 10000, 10000, 60000].forEach(scout._seedRunMs);
        const skewed = scout.estimatedRunMs();
        assert(skewed > 22_500, `estimate ${skewed} sits at or below the mean; a long tail must not be averaged away`);
    } finally {
        delete process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS;
        scout._resetRunMs();
    }
    return 'fast runs → low estimate, slow runs → high, tail respected';
});

check('the estimate can never exceed the ceiling it is allowed to spend', () => {
    process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS = '30000';
    try {
        scout._resetRunMs();
        [80000, 85000, 90000, 95000].forEach(scout._seedRunMs);
        assert(scout.estimatedRunMs() <= 30_000,
            `estimate ${scout.estimatedRunMs()} exceeds the 30000 ceiling, so the caller would skip a run it could actually afford`);
    } finally {
        delete process.env.YOUTUBE_STORYBOARD_TIMEOUT_MS;
        scout._resetRunMs();
    }
    return 'clamped to the ceiling';
});

check('runs that were cut short are never sampled', () => {
    const src = read('src/media/storyboard-scout.js');
    // The self-serving loop: sampling a run we abandoned early makes the
    // estimate shrink every time we were in a hurry, which makes us hurry more.
    const guarded = /if \(result\) \{[\s\S]{0,600}?_recordRunMs\(result\.elapsedMs\)/.test(src);
    assert(guarded, 'the run sample is no longer taken inside the completed-result branch');
    const calls = (src.match(/_recordRunMs\(/g) || []).length;
    // definition + the one guarded call + the _seedRunMs test hook
    assert(calls <= 3, `_recordRunMs is called ${calls} times; an unguarded sample would feed cut-short runs back in`);
    return 'sampling stays inside the completed-run branch';
});

// ── 5. The wiring ───────────────────────────────────────────────────────────
// The pieces above are correct in isolation. These checks are what stops the
// bug returning by simply not being called.

check('the race passes a prep deadline built by download-patience, not an inline formula', () => {
    const src = read('src/media/footage-manager.js');
    assert(/downloadPatience\.resolvePrepDeadlineAt\(/.test(src),
        'footage-manager no longer asks download-patience for the prep deadline');
    assert(/candidateTimeoutMs:\s*racePerCandidateTimeoutMs/.test(src),
        "the prep deadline is not derived from the soldier's own per-candidate budget");
    assert(/minViableMs:\s*patience\?\.minViableMs/.test(src),
        'the download+verdict reserve is no longer the measured minViableMs');
    assert(/prepDeadlineAt:\s*_prepDeadlineAt/.test(src),
        'the prep deadline is computed but never handed to the provider');
    assert(/deadlineAt:\s*_sceneDeadlineAt/.test(src),
        'the scene deadline stopped being passed — the outer guard is gone');
    return 'computed from the soldier budget and passed downstream';
});

check('YouTube prefers the prep clock over the scene clock and refuses runs it cannot afford', () => {
    const src = read('src/media/providers/youtube-video.js');
    const block = (src.match(/const prepDeadline[\s\S]{0,1400}/) || [])[0] || '';
    assert(block, 'the storyboard-scout call site no longer resolves a prep deadline');
    const prepIdx = block.indexOf('options.prepDeadlineAt');
    const sceneIdx = block.indexOf('options.deadlineAt');
    assert(prepIdx >= 0, 'youtube-video ignores prepDeadlineAt');
    assert(sceneIdx > prepIdx,
        'the scene deadline is consulted before the prep deadline — the tighter clock must win');
    assert(/estimatedRunMs\(\)/.test(block),
        'the scout is started without asking what a run costs — the 47s-of-56s bug is reachable again');
    assert(/prepLeftMs\s*<\s*scoutCostMs\s*\?\s*null\s*:/.test(block),
        'there is no skip path: a scout run that does not fit will still be started');
    assert(/deadline:\s*prepDeadline/.test(block),
        'the scout is still handed something other than the prep deadline');
    return 'prep clock wins, unaffordable runs skipped';
});

check('the skip is visible in the log, not silent', () => {
    const src = read('src/media/providers/youtube-video.js');
    assert(/Storyboard Scout\][^\n]*skipped/.test(src),
        'skipping the scout prints nothing, so a build that silently stops looking inside videos reads as healthy');
    return 'skip prints a reason';
});

check('nothing in the new path hardcodes a provider, niche or fixed cost', () => {
    // The user's standing rule: one global mechanism, per-topic inputs, learns
    // in-run. "A flat global constant is as wrong as a per-niche if."
    const prep = (read('src/media/download-patience.js').match(/function resolvePrepDeadlineAt[\s\S]*?\n\}/) || [])[0];
    assert(prep, 'resolvePrepDeadlineAt not found');
    assert(!/niche|youtube|pexels|storyboard/i.test(prep.replace(/^\s*\*.*$/gm, '')),
        'the prep clock names a provider or niche; it must work the same for every lane');
    const magic = (prep.match(/\b\d{4,}\b/g) || []);
    assert(magic.length === 0,
        `the prep clock contains hardcoded millisecond constants (${magic.join(', ')}) — the reserve must be measured`);
    return 'provider-agnostic, no baked-in durations';
});

// ── Report ──────────────────────────────────────────────────────────────────
console.log('\nRace clock — YouTube must be allowed to finish what we started\n');
checks.forEach(l => console.log(l));
if (failures.length) {
    console.log('\nFAILED:');
    failures.forEach(l => console.log(l));
    console.log(`\n${failures.length} of ${failures.length + checks.length} checks failed.\n`);
    process.exit(1);
}
console.log(`\n${checks.length} checks passed.\n`);
