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
//   2. rule compliance    — several cases are traps: images that LOOK like a
//      perfect topical match but must be rejected on a rule (illustration or
//      text slide, supplier watermark, AI render). A judge that only does topic
//      matching passes them and poisons the video.
//   3. brief reading      — one image appears twice against two different
//      scenes. Same pixels, opposite correct answers. A model that scores
//      generic image quality gets exactly one of them right.
//   3b. over-literalism   — two PASS cases are deliberately imperfect matches
//      (a phone whose screen is not visible; a brick suburban house that is not
//      literally 1970s). This is the axis that failed in production: a judge
//      demanding every noun of the brief appear in the pixels rejects everything
//      and every scene falls back to a placeholder card.
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
// The first labelled set lived in <project>/temp and was wiped by the next
// build's Step 0 temp clean, which silently disarmed this bench. The set now
// lives in a sibling folder no build step touches; temp is only a fallback for
// a project where the frames have not been promoted yet.
const FRAMES_DIR_CANDIDATES = [
    path.join(PROJECT, '.bench-frames'),
    path.join(PROJECT, 'temp'),
];
const FRAMES = FRAMES_DIR_CANDIDATES.find((d) => fs.existsSync(d)) || FRAMES_DIR_CANDIDATES[0];

// ── the models worth deciding between ──
// `via` selects which provider branch shapes the request; all three model envs
// get pinned regardless, so a fallback hop can only re-call the same model.
//
// Round 2 (2026-08-05). Dropped: Haiku 4.5 and Pixtral Large — round 1 proved
// both degenerate (0/3 good kept, Pixtral also errored on 7/9). Not available
// on this account at all, despite appearing in the AWS quota tables: Gemma 3
// and Nemotron Nano 2 VL (absent from ListFoundationModels).
// Qwen3-VL is kept deliberately as a CONTROL: it was degenerate on the round-1
// frames, so if it suddenly aces this set the new labels are wrong, not the model.
const CANDIDATES = [
    { id: 'us.anthropic.claude-sonnet-4-6', via: 'bedrock-claude', label: 'Sonnet 4.6 (quality ref)' },
    { id: 'qwen.qwen3-vl-235b-a22b', via: 'bedrock-qwen-vl', label: 'Qwen3-VL 235B (control)' },
    { id: 'us.amazon.nova-lite-v1:0', via: 'bedrock-nova', label: 'Nova Lite' },
    { id: 'us.amazon.nova-pro-v1:0', via: 'bedrock-nova', label: 'Nova Pro' },
    { id: 'us.amazon.nova-premier-v1:0', via: 'bedrock-nova', label: 'Nova Premier' },
    { id: 'amazon.nova-2-lite-v1:0', via: 'bedrock-nova', label: 'Nova 2 Lite' },
];

// ── real scene briefs, copied verbatim out of the build's own plan ──
// Source: <project>/.build-checkpoint.json, scenes 0 / 1 / 5 / 7 of the
// 2026-08-05 build. Not paraphrased — the judge must be tested against the
// exact wording the pipeline actually hands it, including its awkward bits.
const SCENES = {
    amishFarmhouse: {
        keyword: 'Holmes County Ohio Amish farmhouse aerial',
        visualIntent: 'Wide establishing shot of a traditional Amish farmhouse in Holmes County Ohio, green rolling hills, stone or earthen foundation visible, mysterious and documentary tone',
        sceneText: "You're standing at the mouth of a tunnel that runs underneath an Amish farmhouse in Holmes County Ohio.",
        sourceHint: 'web-image',
    },
    tunnelWalls: {
        keyword: 'earth tube geothermal tunnel walls',
        visualIntent: 'Close-up of bare earthen or concrete tunnel walls with no wiring, no compressor, no thermostat visible — pure raw underground passage with cool dark atmosphere',
        sceneText: 'No wires, no compressor, no thermostat, and the air coming out of it is 55 degrees in the middle of August.',
        sourceHint: 'web-image',
    },
    commentScreen: {
        keyword: 'person scrolling smartphone screen',
        visualIntent: 'Close-up of a phone or desktop screen showing a YouTube comment asking about summer cooling, conversational and relatable documentary reset beat',
        sceneText: 'After the last video, many of you asked the same thing, what about summer? What about keeping a home cool?',
        sourceHint: 'web-image',
    },
    suburbanHome: {
        keyword: '1970s suburban American home exterior',
        visualIntent: 'Classic 1970s American suburban single-family home exterior, brick or siding, modest front yard, daylight shot conveying the relatable existing-home viewer context',
        sceneText: 'And yes, this works even if your house was built 50 years ago.',
        sourceHint: 'web-image',
    },
};

const VIDEO_TOPIC = 'The underground earth-tube cooling system the air conditioning industry buried in 1930';

// ── the labelled set ──
// Every band below was assigned by looking at the actual pixels. The build
// accepts at >=6, so PASS means "should score >=6" and REJECT "should score <=5".
// `trap` marks a case where topic-matching alone gives the wrong answer.
const CASES = [
    // ── frames a human editor would happily cut into the video ──
    {
        id: 'farmland-aerial/farmhouse',
        file: 'scene-0.race-5-msg4sjou.jpg',
        scene: 'amishFarmhouse',
        band: 'PASS',
        truth: 'Real, clean, unwatermarked aerial photograph of Ohio Amish farmland — white farmhouses, a red barn with silo, mown green fields and a country road. The build itself accepted this exact frame at 8/10.',
    },
    {
        id: 'amish-buggy/farmhouse',
        file: 'scene-5.race-4-msg4yvpu.jpg',
        scene: 'amishFarmhouse',
        band: 'PASS',
        truth: 'Real, clean, unwatermarked photo of an Amish horse-and-buggy on a country road, with red barns, a silo, a windmill and green rolling hills behind. Correct culture, correct county, no defects.',
    },
    {
        id: 'tunnel-wall-closeup/tunnel-walls',
        file: 'scene-1.race-5-msg4v3xu.jpg',
        scene: 'tunnelWalls',
        band: 'PASS',
        truth: 'Real, clean, unwatermarked shallow-depth close-up of a bare concrete tunnel wall with the passage receding into distant lights. Exactly the brief, no equipment in frame.',
    },
    {
        id: 'hand-on-phone/comment-screen',
        file: 'scene-5.race-1-msg4w8f2.jpg',
        scene: 'commentScreen',
        band: 'PASS',
        truth: 'Real, clean, unwatermarked photo of a person in a sweater about to tap a phone. The screen contents are not visible — no stock photo can show one specific YouTube comment — but this is the shot an editor cuts to on a "you asked in the comments" beat. Rejecting it for the missing screen is the over-literal failure that leaves scenes with no footage.',
    },
    {
        id: 'brick-suburban-home/suburban-home',
        file: 'scene-7.race-1-msg4xgrp.jpg',
        scene: 'suburbanHome',
        band: 'PASS',
        truth: 'Real, clean, unwatermarked photo of a red-brick American suburban single-family house: garage, mown front lawn, blue sky, daylight. Newer than 1970s, but it is the relatable existing-home establishing shot the brief describes. Rejecting it on the decade alone is over-literal.',
    },

    // ── frames a human editor would not use ──
    {
        id: 'amish-buggy/comment-screen',
        file: 'scene-5.race-4-msg4yvpu.jpg',
        scene: 'commentScreen',
        band: 'REJECT',
        trap: 'brief-reading',
        truth: 'The same pixels as amish-buggy/farmhouse, judged against a completely different brief (a phone or desktop screen showing a viewer comment). A judge scoring generic quality — or just "is this on topic for the video" — gives both the same number. A judge reading the brief does not.',
    },
    {
        id: 'teri-slide/tunnel-walls',
        file: 'scene-1.race-7-msg4tco9.jpg',
        scene: 'tunnelWalls',
        band: 'REJECT',
        trap: 'editorial-overlay',
        truth: 'A PowerPoint slide: half a page of body copy about earth air tunnels beside a labelled cutaway diagram carrying a "teri" corporate logo. Topically a near-perfect match for the video — which is exactly why it is the trap. It is a text slide and an illustration, not footage.',
    },
    {
        id: 'magnific-render/tunnel-walls',
        file: 'scene-1.race-9-msg4tcot.jpg',
        scene: 'tunnelWalls',
        band: 'REJECT',
        trap: 'watermark+ai-render',
        truth: 'AI-generated fantasy render of a vast underground industrial tunnel complex, tiled "Magnific" watermarks across the whole frame plus a logo bottom-right. Two disqualifiers at once: supplier watermark and synthetic imagery.',
    },
    {
        id: 'neon-rail-tunnel/tunnel-walls',
        file: 'scene-1.race-2-msg4uaij.jpg',
        scene: 'tunnelWalls',
        band: 'REJECT',
        trap: 'ai-render',
        truth: 'Stylised AI render of a railway tunnel lit with impossible cyan and orange glow along the rock. Wrong subject (rail tunnel, tracks in frame) and obviously synthetic — the "looks amazing, is fake" case that makes a finished video read as AI-made.',
    },
    {
        id: 'wall-thermometer/tunnel-walls',
        file: 'scene-1.race-1-msg4u9ue.jpg',
        scene: 'tunnelWalls',
        band: 'REJECT',
        truth: 'Real, clean, unwatermarked close-up of a dual-scale wall thermometer on wood. No rule violation at all — simply the wrong subject for a brief asking for bare tunnel walls, and that brief explicitly excludes a visible thermostat.',
    },
    {
        id: 'designer-brick-house/suburban-home',
        file: 'scene-7.race-1-msg4z5k4.jpg',
        scene: 'suburbanHome',
        band: 'REJECT',
        truth: 'Real, clean photo — but a tall portrait-crop architectural detail of a contemporary designer home: rear timber deck, potted olive tree, golden-hour styling. Not an American suburban front-yard establishing shot, and portrait framing cannot fill a 16:9 scene.',
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
        console.log('\nThese are real race frames from a real build, promoted out of temp/ into');
        console.log('.bench-frames/ so a later build\'s Step 0 clean cannot delete the labelled set.');
        console.log('Point BENCH_PROJECT_DIR at a project that has them.');
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
