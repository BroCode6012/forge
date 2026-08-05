#!/usr/bin/env node
// scripts/vision-judge-bench.js
// ============================================================================
// Picks the footage judge on evidence instead of reputation.
//
// Why (2026-08-04): the configured primary `us.anthropic.claude-sonnet-5`
// AccessDenied-403s on every call for this account (see
// scripts/bedrock-vision-probe.js), so the chain has silently been falling
// back to bedrock-qwen-vl for 100% of footage scoring. Replacing it is not a
// matter of picking the biggest name — the judge has to be fast AND obey the
// scoring rulebook, and those two do not correlate.
//
// What this measures, on REAL frames from a REAL build:
//   1. decision agreement — the build accepts at >=6, so what matters is not
//      the exact number but whether the model lands on the same side of that
//      line a careful human does.
//   2. rule compliance    — three cases are traps: images that LOOK like a
//      perfect topical match but must be rejected on a rule (illustration,
//      supplier watermark, editorial caption). A judge that only does topic
//      matching passes them and poisons the video.
//   3. brief reading      — one image appears twice against two different
//      scenes. Same pixels, opposite correct answers. A model that scores
//      generic image quality gets exactly one of them right.
//   4. latency            — median ms per scored frame.
//   5. contract cost      — parseError (broke the 2-line reply contract) and
//      scoreRetried (needed a second paid call), both from the real parser.
//
// It drives the REAL scoreVideoFrame() in src/vision/ai-vision.js, so the
// real prompt and the real tolerant parser are exercised. scoreVideoFrame has
// no cache of its own (caching lives in the caller), so models cannot read
// each other's verdicts.
//
// Each model runs in its OWN child process with every BEDROCK_VISION_*_MODEL
// pinned to the model under test and the fallback tail emptied — so a silent
// fallback cannot hand one model another model's score. That is the exact
// failure this whole exercise exists to stop repeating.
//
// Run:  node scripts/vision-judge-bench.js
//       node scripts/vision-judge-bench.js --models a,b,c
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const PROJECT = process.env.BENCH_PROJECT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads', '300$ Test');
const FRAMES = path.join(PROJECT, 'temp');

// ── the models worth deciding between ──
// `via` selects which provider branch shapes the request; all three model envs
// get pinned regardless, so a fallback hop can only re-call the same model.
const CANDIDATES = [
    { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', via: 'bedrock-claude', label: 'Haiku 4.5' },
    { id: 'us.anthropic.claude-sonnet-4-6', via: 'bedrock-claude', label: 'Sonnet 4.6' },
    { id: 'qwen.qwen3-vl-235b-a22b', via: 'bedrock-qwen-vl', label: 'Qwen3-VL 235B (incumbent)' },
    { id: 'us.amazon.nova-lite-v1:0', via: 'bedrock-nova', label: 'Nova Lite (cheap floor)' },
    { id: 'us.mistral.pixtral-large-2502-v1:0', via: 'bedrock-claude', label: 'Pixtral Large' },
];

// ── real scene briefs, copied verbatim out of the build's own plan ──
const SCENES = {
    amishFarmhouse: {
        keyword: 'Amish farmhouse Holmes County Ohio tunnel foundation',
        visualIntent: 'Wide establishing shot of a rustic Amish farmhouse in Holmes County Ohio, dark earthy tones, low angle showing the foundation base suggesting underground structure, moody pre-dawn light',
        sceneText: "You're standing at the mouth of a tunnel that runs underneath an Amish farmhouse in Holmes County Ohio.",
        sourceHint: 'web-image',
    },
    earthTube: {
        keyword: 'earth tube cooling air temperature',
        visualIntent: 'Close-up of air flowing from a pipe embedded in a wall or ground, thermometer visible reading near 55F, no mechanical equipment in frame, clean documentary shot',
        sceneText: 'No wires, no compressor, no thermostat, and the air coming out of it is 55 degrees in the middle of August.',
        sourceHint: 'youtube',
    },
    amishFarmstead: {
        keyword: 'Amish farmstead hand-built Holmes County',
        visualIntent: 'Archival-style wide shot of a traditional Amish wooden farmstead in Holmes County, warm sepia tones, hand-crafted wooden structures, fields in background, timeless pastoral atmosphere',
        sceneText: 'The Amish have been building it for 200 years.',
        sourceHint: 'web-image',
    },
    vintageAc: {
        keyword: '1930s air conditioning unit vintage',
        visualIntent: 'Vintage 1930s era industrial cooling or air conditioning unit photograph, heavy mechanical equipment, factory setting, sepia or desaturated tone suggesting historical era',
        sceneText: 'The cooling industry has known about it since 1930.',
        sourceHint: 'web-image',
    },
    boardroom: {
        keyword: 'corporate boardroom shadowed documents',
        visualIntent: 'Dark moody image of shadowed hands over corporate documents or patent files, dramatic low-key lighting, sinister atmosphere suggesting concealment, vintage industrial aesthetic',
        sceneText: 'And in 1930, they made sure you would never find out.',
        sourceHint: 'web-image',
    },
};

const VIDEO_TOPIC = 'The underground earth-tube cooling system the air conditioning industry buried in 1930';

// ── the labelled set ──
// Every band below was assigned by looking at the actual pixels. The build
// accepts at >=6, so PASS means "should score >=6" and REJECT "should score <=5".
// `trap` marks a case where topic-matching alone gives the wrong answer.
const CASES = [
    {
        id: 'amish-family/farmstead',
        file: 'scene-0.race-7-msewmu5n.jpg',
        scene: 'amishFarmstead',
        band: 'PASS',
        truth: 'Real, clean, unwatermarked photo of an Amish family walking through green countryside by a river — correct culture and pastoral setting, no defects.',
    },
    {
        id: 'amish-family/boardroom',
        file: 'scene-0.race-7-msewmu5n.jpg',
        scene: 'boardroom',
        band: 'REJECT',
        trap: 'brief-reading',
        truth: 'Same pixels as the case above, judged against a completely different brief (shadowed hands over patent files). A judge rating generic image quality scores this the same as the case above; a judge reading the brief does not.',
    },
    {
        id: 'archival-trencher/vintage-ac',
        file: 'scene-4.race-6-msewoksa.jpg',
        scene: 'vintageAc',
        band: 'PASS',
        truth: 'Genuine archival black-and-white photograph of a steam-powered trenching machine with clay pipes beside the trench — real, correct era, correct heavy machinery, desaturated historical tone.',
    },
    {
        id: 'thermometer/earth-tube',
        file: 'scene-4.race-3-msewnwmc.jpg',
        scene: 'earthTube',
        band: 'PASS',
        truth: 'Real, clean, unwatermarked close-up of a dual-scale wall thermometer. The brief explicitly asks for a visible thermometer.',
    },
    {
        id: 'earth-cutaway/earth-tube',
        file: 'scene-1.race-4-msewodaj.jpg',
        scene: 'earthTube',
        band: 'REJECT',
        truth: '3D CGI cutaway of the planet Earth (crust/mantle/core) on white. Illustration where real footage is required, and the wrong subject entirely.',
    },
    {
        id: 'adobe-stock-loop/earth-tube',
        file: 'scene-1.race-9-msewmu08.jpg',
        scene: 'earthTube',
        band: 'REJECT',
        trap: 'watermark+illustration',
        truth: 'Stock cross-section diagram of an underground geothermal pipe loop — topically almost perfect, but it is an illustration AND carries tiled "Adobe Stock" watermarks with a stock ID.',
    },
    {
        id: 'earth-tubes-caption/earth-tube',
        file: 'scene-2.race-5-msewo9po.jpg',
        scene: 'earthTube',
        band: 'REJECT',
        trap: 'editorial-overlay',
        truth: 'Real construction photo of earth tubes being installed — on-topic and real footage, but carries a large editorial caption block, a corporate logo and a site watermark.',
    },
    {
        id: 'foundation-lineart/amish-farmhouse',
        file: 'scene-2.race-9-msewm9u2.jpg',
        scene: 'amishFarmhouse',
        band: 'REJECT',
        truth: 'Vendor line-art diagram of a house foundation with callout labels and a brand name. Illustration plus overlaid text, and not an Amish farmhouse.',
    },
    {
        id: 'tropical-hut/amish-farmhouse',
        file: 'scene-0.race-9-msewoksi.jpg',
        scene: 'amishFarmhouse',
        band: 'REJECT',
        truth: 'Real, clean photo of a tropical stilt hut in a dry harvested field with palms on the horizon. No rule violation at all — it is simply the wrong subject and wrong part of the world.',
    },
];

const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// ══════════════════════════════════════════════════════════════════════════
// CHILD: one model, every case, JSON to stdout
// ══════════════════════════════════════════════════════════════════════════
async function runChild(modelId) {
    const { scoreVideoFrame } = require('../src/vision/ai-vision');
    const out = [];
    for (const c of CASES) {
        const scene = SCENES[c.scene];
        const file = path.join(FRAMES, c.file);
        const buf = fs.readFileSync(file);
        const mime = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
        const context = {
            videoTopic: VIDEO_TOPIC,
            visualIntent: scene.visualIntent,
            sceneText: scene.sceneText,
            niche: 'explainer.diy',
            theme: 'warm-editorial',
            mediaType: 'image',
            sourceHint: scene.sourceHint,
        };
        const t0 = Date.now();
        let r = null, err = null;
        try {
            r = await scoreVideoFrame(buf.toString('base64'), mime, scene.keyword, context);
        } catch (e) {
            err = String((e && e.message) || e).slice(0, 120);
        }
        out.push({
            case: c.id,
            ms: Date.now() - t0,
            score: r && typeof r.score === 'number' ? r.score : null,
            description: String((r && r.description) || '').slice(0, 150),
            parseError: Boolean(r && r.parseError),
            scoreRetried: Boolean(r && r.scoreRetried),
            error: err,
        });
    }
    process.stdout.write('@@BENCH@@' + JSON.stringify({ modelId, results: out }) + '\n');
}

// ══════════════════════════════════════════════════════════════════════════
// PARENT
// ══════════════════════════════════════════════════════════════════════════
function runParent() {
    const only = (process.argv.find((a) => a.startsWith('--models=')) || '').split('=')[1];
    const list = only
        ? CANDIDATES.filter((c) => only.split(',').some((s) => c.id.includes(s.trim())))
        : CANDIDATES;

    const missing = [...new Set(CASES.map((c) => c.file))]
        .filter((f) => !fs.existsSync(path.join(FRAMES, f)));
    if (missing.length) {
        console.log(`\nMissing benchmark frames in ${FRAMES}:`);
        missing.forEach((m) => console.log(`   ${m}`));
        console.log('\nThese are real race frames from the build. Point BENCH_PROJECT_DIR at a project that has them.');
        process.exit(1);
    }

    console.log(`\nFootage-judge benchmark — ${CASES.length} labelled real frames x ${list.length} models`);
    console.log(`Frames: ${FRAMES}`);
    console.log(`Accept threshold: score >= 6 (same as the build)\n`);

    const all = [];
    for (const cand of list) {
        process.stdout.write(`  running ${cand.label} …`);
        const env = {
            ...process.env,
            VISION_BACKEND: 'bedrock',
            VISION_PROVIDER: cand.via,
            VISION_BEDROCK_PRIMARY_MODEL: cand.id,
            // Pin all three so even an unexpected fallback hop re-calls the SAME
            // model. No model can be credited with another model's answer.
            BEDROCK_VISION_CLAUDE_MODEL: cand.id,
            BEDROCK_VISION_QWEN_MODEL: cand.id,
            BEDROCK_VISION_NOVA_MODEL: cand.id,
            VISION_FALLBACK_ORDER: '',
            VISION_EXCLUDE_QWEN: '1',
            BENCH_PROJECT_DIR: PROJECT,
            FORCE_COLOR: '0',
        };
        const t0 = Date.now();
        const res = spawnSync(process.execPath, [__filename, '--child', cand.id], {
            env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000,
        });
        const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('@@BENCH@@'));
        if (!line) {
            console.log(` FAILED`);
            const why = String(res.stderr || res.stdout || 'no output').trim().split('\n').slice(-3).join(' | ');
            console.log(`     ${why.slice(0, 240)}`);
            all.push({ ...cand, dead: true });
            continue;
        }
        const parsed = JSON.parse(line.slice('@@BENCH@@'.length));
        console.log(` done in ${Math.round((Date.now() - t0) / 1000)}s`);
        all.push({ ...cand, results: parsed.results });
    }

    // ── scorecard ──
    console.log(`\n${'='.repeat(78)}\nRESULTS\n${'='.repeat(78)}\n`);
    const rows = [];
    for (const m of all) {
        if (m.dead) { rows.push({ label: m.label, dead: true }); continue; }
        let trapsPassed = 0, traps = 0, parseErrors = 0, retries = 0, errors = 0;
        let accOk = 0, accTotal = 0, rejOk = 0, rejTotal = 0;
        const lat = [], scores = [];
        for (const c of CASES) {
            const r = m.results.find((x) => x.case === c.id);
            if (!r) continue;
            if (r.error) { errors++; continue; }
            if (r.parseError) parseErrors++;
            if (r.scoreRetried) retries++;
            lat.push(r.ms);
            if (typeof r.score === 'number') scores.push(r.score);
            const decided = r.score >= 6 ? 'PASS' : 'REJECT';
            const right = decided === c.band;
            if (c.band === 'PASS') { accTotal++; if (right) accOk++; }
            else { rejTotal++; if (right) rejOk++; }
            if (c.trap) { traps++; if (right) trapsPassed++; }
        }
        // A judge that answers the same number to everything scores well on a
        // reject-heavy set while being useless. Overall accuracy hides that;
        // the two bands reported separately do not.
        const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
        rows.push({
            label: m.label, id: m.id,
            correct: accOk + rejOk, total: CASES.length,
            accOk, accTotal, rejOk, rejTotal, spread,
            degenerate: accOk === 0 || rejOk === 0 || spread <= 2,
            trapsPassed, traps,
            median: median(lat), parseErrors, retries, errors,
        });
    }

    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('model', 26) + pad('keeps good', 12) + pad('kills bad', 11) + pad('traps', 7)
        + pad('median', 9) + pad('spread', 8) + pad('unread', 8) + 'retries');
    console.log('-'.repeat(88));
    for (const r of rows) {
        if (r.dead) { console.log(pad(r.label, 26) + 'could not run'); continue; }
        console.log(
            pad(r.label, 26) +
            pad(`${r.accOk}/${r.accTotal}`, 12) +
            pad(`${r.rejOk}/${r.rejTotal}`, 11) +
            pad(`${r.trapsPassed}/${r.traps}`, 7) +
            pad(`${r.median}ms`, 9) +
            pad(String(r.spread), 8) +
            pad(String(r.parseErrors) + (r.errors ? `+${r.errors}e` : ''), 8) +
            String(r.retries) +
            (r.degenerate ? '   ⚠️ answers the same to everything' : '')
        );
    }
    console.log('\n  "keeps good" = correctly accepted the frames a human would use.');
    console.log('  "kills bad"  = correctly rejected the frames a human would not.');
    console.log('  A model can score well on "kills bad" alone by rejecting everything —');
    console.log('  that is the failure mode that leaves scenes with no footage.');

    // ── per-case detail, so a wrong call can be inspected rather than trusted ──
    console.log(`\n${'-'.repeat(78)}\nPER-CASE SCORES (expected band in brackets)\n${'-'.repeat(78)}`);
    for (const c of CASES) {
        console.log(`\n  ${c.id}  [${c.band}]${c.trap ? `  ← trap: ${c.trap}` : ''}`);
        console.log(`    ${c.truth}`);
        for (const m of all) {
            if (m.dead) continue;
            const r = m.results.find((x) => x.case === c.id);
            if (!r) continue;
            const decided = r.score >= 6 ? 'PASS' : 'REJECT';
            const mark = r.error ? '  ' : (decided === c.band ? ' ✅' : ' ❌');
            console.log(`   ${mark} ${pad(m.label, 26)} ${r.error ? 'ERROR: ' + r.error : `${String(r.score).padStart(2)}/10  ${r.description}`}`);
        }
    }

    // Ranking deliberately disqualifies the degenerate "reject everything" judge
    // before comparing anything else: a judge that never keeps good footage is
    // not a fast judge, it is a broken one.
    const live = rows.filter((r) => !r.dead && !r.parseErrors && !r.errors && !r.degenerate);
    const best = live.sort((a, b) =>
        (b.correct - a.correct) || (b.trapsPassed - a.trapsPassed) || (a.median - b.median))[0];
    // Persist, so the next person comparing judges starts from evidence instead
    // of re-running 45 paid calls to rediscover the same table.
    try {
        const outFile = path.join(__dirname, '..', 'logs', 'vision-judge-bench.json');
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify({
            ranAt: new Date().toISOString(),
            threshold: 6,
            cases: CASES.map((c) => ({ id: c.id, band: c.band, trap: c.trap || null, truth: c.truth })),
            summary: rows,
            raw: all.filter((m) => !m.dead).map((m) => ({ id: m.id, label: m.label, results: m.results })),
        }, null, 2));
        console.log(`\n  full results written to logs/vision-judge-bench.json`);
    } catch (e) {
        console.log(`\n  (could not write results file: ${e.message})`);
    }

    console.log(`\n${'='.repeat(88)}`);
    if (best) {
        console.log(`Winner (usable judgment first, then traps, then speed): ${best.label}`);
        console.log(`  keeps ${best.accOk}/${best.accTotal} good · kills ${best.rejOk}/${best.rejTotal} bad · traps ${best.trapsPassed}/${best.traps} · ${best.median}ms median`);
        console.log(`\n  To make it the judge, set in the user .env:`);
        console.log(`     VISION_BEDROCK_PRIMARY_MODEL=${best.id}`);
    } else {
        console.log('No model produced usable judgment — every candidate was degenerate,');
        console.log('unreadable, or errored. Do NOT wire any of them in as the primary judge.');
    }
    console.log('');
}

if (process.argv.includes('--child')) {
    const modelId = process.argv[process.argv.indexOf('--child') + 1];
    runChild(modelId).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
} else {
    runParent();
}
