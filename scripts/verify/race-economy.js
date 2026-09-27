#!/usr/bin/env node
// scripts/verify/race-economy.js
// ============================================================================
// Gate for screen-aware racing + the held-winner fix + cost-purpose labels.
//
//   A  with no screen verdicts the race behaves exactly as before
//   B  candidates the Thumbnail Screen declined wait behind the rest and never
//      share a batch with them
//   C  a failed probe stops the race and the rest are never downloaded
//   D  a probe that finds a good clip lets the race carry on normally
//   E  the screen must keep earning trust, per provider, inside the run
//   F  a held accepted clip is committed when a later batch finds nothing
//      (the old race deleted it and reported "no winner")
//   G  cost-purpose labels split the report without touching byTask
//   H  the build is wired to all of it
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.FOOTAGE_AI_REFEREE = 'false'; // no AI in this gate
const race = require(path.join(ROOT, 'src/media/candidate-race'));
const costs = require(path.join(ROOT, 'src/brain/cost-tracker'));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const quiet = () => {};

function pool(spec) {
    // spec: [{ id, score, verdict }] — score = what the post-download judge would say
    return spec.map((s) => ({ id: s.id, title: s.id, url: `https://example.com/${s.id}`, _score: s.score, _verdict: s.verdict }));
}

function verdictMap(candidates) {
    const map = new Map();
    for (const c of candidates) if (c._verdict) map.set(c, c._verdict);
    return map;
}

async function runRace(candidates, opts = {}) {
    const downloaded = [];
    const batches = [];
    const logs = [];
    let currentBatch = null;
    const winner = await race.runCandidateRace({
        candidates,
        providerKey: opts.providerKey || 'pexels',
        concurrency: opts.concurrency || 5,
        maxBatches: opts.maxBatches || 4,
        minAcceptScore: 6,
        perCandidateTimeoutMs: 60_000,
        refereeCollectBatches: opts.refereeCollectBatches || 1,
        earlyAcceptScore: 7,
        refereeNowScore: 7,
        refereeNowMinCandidates: 2,
        collectMoreOnBorderline: true,
        skipRefereeOnObvious: true,
        screenVerdicts: opts.screenVerdicts,
        log: (line) => {
            logs.push(line);
            const m = /batch (\d+): (?:launching|probing) (\d+)/.exec(line);
            if (m) { currentBatch = []; batches.push(currentBatch); }
        },
        processOne: async (candidate) => {
            downloaded.push(candidate.id);
            if (currentBatch) currentBatch.push(candidate.id);
            const score = candidate._score;
            return score >= 6
                ? { accepted: true, score, postScore: score, path: '' }
                : { accepted: false, score, reason: `vision ${score}/10` };
        },
    });
    return { winner, downloaded, batches, logs };
}

(async () => {
    // ── A. unchanged without verdicts ───────────────────────────────────────
    console.log('\n=== A. no screen verdicts → old behaviour ===');
    race.resetRaceEconomy();
    {
        const cands = pool([
            { id: 'a', score: 2 }, { id: 'b', score: 2 }, { id: 'c', score: 2 },
            { id: 'd', score: 2 }, { id: 'e', score: 8 }, { id: 'f', score: 2 },
        ]);
        const r = await runRace(cands);
        ok('first batch is a full concurrency batch', r.batches[0].length === 5, JSON.stringify(r.batches));
        ok('candidates race in their given order', r.downloaded.slice(0, 5).join('') === 'abcde');
        ok('the strong clip still wins', r.winner && r.winner.score === 8);
    }

    // ── B. declined candidates wait, never mixed ────────────────────────────
    console.log('\n=== B. declined candidates wait behind the rest ===');
    race.resetRaceEconomy();
    {
        // 2 the screen liked, then 8 it declined (the Sep-3 log's "2 show, 23 don't")
        const cands = pool([
            { id: 'L1', score: 8, verdict: 'yes' }, { id: 'N1', score: 2, verdict: 'no' },
            { id: 'L2', score: 3, verdict: 'yes' }, { id: 'N2', score: 2, verdict: 'no' },
            { id: 'N3', score: 1, verdict: 'no' }, { id: 'N4', score: 2, verdict: 'no' },
            { id: 'N5', score: 2, verdict: 'no' }, { id: 'N6', score: 2, verdict: 'no' },
        ]);
        const r = await runRace(cands, { screenVerdicts: verdictMap(cands) });
        ok('the first batch holds only what the screen did not decline', r.batches[0].every((id) => id.startsWith('L')), JSON.stringify(r.batches));
        ok('declined candidates are not downloaded when a liked one wins', !r.downloaded.some((id) => id.startsWith('N')), r.downloaded.join(','));
        ok('the liked winner is returned', r.winner && r.winner._candidate.id === 'L1');
        ok('it cost 2 downloads instead of a batch of 5', r.downloaded.length === 2, String(r.downloaded.length));
    }

    // ── C. failed probe stops the race ──────────────────────────────────────
    console.log('\n=== C. a failed probe stops the race ===');
    race.resetRaceEconomy();
    {
        const cands = pool([
            { id: 'L1', score: 2, verdict: 'yes' },
            ...Array.from({ length: 12 }, (_, i) => ({ id: `N${i + 1}`, score: 2, verdict: 'no' })),
        ]);
        const r = await runRace(cands, { screenVerdicts: verdictMap(cands) });
        ok('the liked candidate goes first on its own', r.batches[0].join(',') === 'L1', JSON.stringify(r.batches));
        ok('then a probe of at most 2 declined candidates', r.batches[1] && r.batches[1].length <= 2 && r.batches[1].every((id) => id.startsWith('N')), JSON.stringify(r.batches));
        ok('the race stops after the probe fails', r.batches.length === 2, JSON.stringify(r.batches));
        ok('no winner is invented', r.winner === null);
        ok('the stop is explained in the log', r.logs.some((line) => /the thumbnail screen was right/.test(line)));
        const e = race.getRaceEconomy();
        ok('the saved downloads are counted, capped by what the race could still reach', e.racesEndedByProbe === 1 && e.declinedNeverDownloaded === Math.min(10, 2 * 5), JSON.stringify(e));
        ok('it cost 3 downloads where the old race took up to 13', r.downloaded.length === 3, String(r.downloaded.length));
    }

    // ── D. probe finds something → carry on ─────────────────────────────────
    console.log('\n=== D. a successful probe lets the race continue ===');
    race.resetRaceEconomy();
    {
        const cands = pool([
            { id: 'L1', score: 2, verdict: 'yes' },
            { id: 'N1', score: 2, verdict: 'no' }, { id: 'N2', score: 8, verdict: 'no' },
            { id: 'N3', score: 2, verdict: 'no' },
        ]);
        const r = await runRace(cands, { screenVerdicts: verdictMap(cands) });
        ok('a declined candidate that really is good still wins', r.winner && r.winner._candidate.id === 'N2', r.winner ? r.winner._candidate.id : 'null');
        ok('the screen miss is recorded for learning', race.getRaceEconomy().declinedAccepted === 1);
    }

    // ── E. trust is earned per provider ─────────────────────────────────────
    console.log('\n=== E. the screen has to keep earning trust ===');
    race.resetRaceEconomy();
    {
        ok('a provider starts trusted', race.screenDeferralTrusted('pixabay') === true);
        // Declined candidates keep passing as often as liked ones do.
        for (let round = 0; round < 4; round++) {
            const cands = pool([
                { id: `L${round}`, score: 2, verdict: 'yes' },
                { id: `Na${round}`, score: 8, verdict: 'no' }, { id: `Nb${round}`, score: 7, verdict: 'no' },
            ]);
            await runRace(cands, { providerKey: 'pixabay', screenVerdicts: verdictMap(cands) });
        }
        ok('a provider whose declined clips keep passing stops being deferred', race.screenDeferralTrusted('pixabay') === false, JSON.stringify(race.getRaceEconomy()));
        ok('that is reported', race.getRaceEconomy().distrustedProviders.includes('pixabay'));
        ok('other providers keep their own record', race.screenDeferralTrusted('pexels') === true);

        const cands = pool([
            { id: 'L', score: 2, verdict: 'yes' }, { id: 'N1', score: 2, verdict: 'no' }, { id: 'N2', score: 2, verdict: 'no' },
        ]);
        const r = await runRace(cands, { providerKey: 'pixabay', screenVerdicts: verdictMap(cands) });
        ok('once distrusted, the old full batch comes back', r.batches[0].length === 3, JSON.stringify(r.batches));

        process.env.FOOTAGE_RACE_SCREEN_DEFER = '0';
        ok('FOOTAGE_RACE_SCREEN_DEFER=0 turns it off', race.screenDeferralTrusted('pexels') === false);
        delete process.env.FOOTAGE_RACE_SCREEN_DEFER;
    }

    // ── F. held winner is kept ──────────────────────────────────────────────
    console.log('\n=== F. a held clip is committed, not deleted ===');
    race.resetRaceEconomy();
    {
        // Batch 1 accepts a borderline 6/10 and holds it for comparison
        // (collect 2 batches); batch 2 finds nothing. Old race: kept going,
        // then deleted the 6/10 and returned null.
        const cands = pool([
            { id: 'a', score: 6 }, { id: 'b', score: 2 },
            { id: 'c', score: 2 }, { id: 'd', score: 2 },
            { id: 'e', score: 2 }, { id: 'f', score: 2 },
        ]);
        const r = await runRace(cands, { concurrency: 2, maxBatches: 3, refereeCollectBatches: 2 });
        ok('the held 6/10 is returned instead of "no winner"', r.winner && r.winner._candidate.id === 'a', r.winner ? r.winner._candidate.id : 'null');
        ok('the race stops once it has decided', r.batches.length === 2, JSON.stringify(r.batches));
        ok('it is counted', race.getRaceEconomy().heldWinnersKept === 1);
    }

    // ── G. cost-purpose labels ──────────────────────────────────────────────
    console.log('\n=== G. cost-purpose labels ===');
    {
        costs.resetCosts();
        const usage = { prompt_tokens: 100, completion_tokens: 10 };
        costs.recordUsage({ provider: 'x', model: 'qwen3-vl', taskType: 'vision', usage });
        await costs.withCostPurpose('footage', async () => {
            costs.recordUsage({ provider: 'x', model: 'qwen3-vl', taskType: 'vision', usage });
            await new Promise((resolve) => setTimeout(resolve, 5));
            await costs.withCostPurpose('race-candidate', async () => {
                await Promise.resolve();
                costs.recordUsage({ provider: 'x', model: 'qwen3-vl', taskType: 'vision', usage });
            });
            costs.recordUsage({ provider: 'x', model: 'qwen3-vl', taskType: 'vision', usage });
        });
        const report = costs.getCostReport();
        ok('byTask still has one vision line with every call', report.byTask.vision && report.byTask.vision.calls === 4, JSON.stringify(report.byTask));
        ok('labelled calls are split by purpose', report.byPurpose['vision:footage']?.calls === 2 && report.byPurpose['vision:race-candidate']?.calls === 1, JSON.stringify(report.byPurpose));
        ok('unlabelled calls are counted as unlabelled', report.byPurpose['vision:unlabelled']?.calls === 1);
        ok('the label survives an await', report.byPurpose['vision:footage'].calls === 2);
        ok('the label is gone after its scope ends', costs.currentCostPurpose() === '');
        const lines = [];
        costs.logCostReport((line) => lines.push(line));
        ok('the printed report shows the purposes', lines.some((line) => /By purpose/.test(line)) && lines.some((line) => /vision:race-candidate/.test(line)));
        costs.resetCosts();
    }

    // ── H. wiring ───────────────────────────────────────────────────────────
    console.log('\n=== H. wiring ===');
    {
        const fm = read('src/media/footage-manager.js');
        const tv = read('src/vision/thumbnail-vision.js');
        const bv = read('src/pipeline/build-video.js');
        const sb = read('src/media/storyboard-scout.js');
        const rc = read('src/media/candidate-race.js');
        ok('the screen hands its verdicts back', (tv.match(/\bverdicts,\n/g) || []).length >= 2);
        ok('footage-manager keeps them per search', fm.includes('thumbnailScreenVerdicts = screen.verdicts instanceof Map'));
        ok('and passes them to the race', fm.includes('screenVerdicts: thumbnailScreenVerdicts,'));
        ok('the screen is still a ranking — nothing is dropped there', tv.includes('RANKING, NOT A GATE') || fm.includes('RANKING, NOT A GATE'));
        ok('race candidates are labelled for the cost report', fm.includes("withCostPurpose('race-candidate'"));
        ok('scene fetching is labelled', fm.includes("withCostPurpose('footage'"));
        ok('the finalist scout is labelled', fm.includes("withCostPurpose('finalist-scout'"));
        ok('the preview grid is labelled', tv.includes("withCostPurpose('thumbnail-grid'"));
        ok('the storyboard look is labelled', sb.includes("withCostPurpose('storyboard'"));
        ok('the referee is labelled', rc.includes("withCostPurpose('race-referee'"));
        ok('the build prints the race economy after the media step', bv.includes("describeRaceEconomy()"));
        ok('the build saves race-economy.json beside the cost report', bv.includes("'race-economy.json'"));
    }

    console.log(`\n${fail ? '❌' : '✅'} race economy: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

void quiet;
