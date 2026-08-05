#!/usr/bin/env node
/**
 * LIVE verification of GPU Fix B — the widened reading window.
 *
 * This is NOT part of `npm run verify`: it boots a real paid GPU. It answers the
 * one question the offline gate cannot: the offline gate proves the app *asks*
 * for a 16384-token window; only a real boot proves vLLM *comes up* with it on a
 * T4 and that a real scoring request now fits.
 *
 * The original defect: vLLM served `--max-model-len 4096`, the app's scoring
 * request measured 4127-4594 tokens, and every image came back HTTP 400. The
 * box looked perfectly healthy the whole time -- so the proof has to be numeric,
 * not "it seemed to work".
 *
 *   node scripts/verify/live-gpu-window.js          # boot, measure, stop
 *   node scripts/verify/live-gpu-window.js --keep   # leave the box running
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const KEEP = process.argv.includes('--keep');
const OLD_WINDOW = 4096;   // what vLLM used to serve
const WANT_WINDOW = 16384; // what serve-vision.sh now asks for

const results = [];
/** okDetail is printed on a pass, failDetail on a failure (falling back to okDetail). */
function record(label, ok, okDetail, failDetail) {
    const detail = ok ? okDetail : (failDetail || okDetail);
    results.push({ label, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (detail) console.log(`       ${detail}`);
}
const log = (m) => console.log(`  … ${String(m).trim()}`);

function baseUrl() {
    const config = require('../../src/settings/config');
    const raw = String(
        (config.qwen && config.qwen.baseUrl)
        || process.env.LIGHTNING_VISION_URL
        || process.env.QWEN_BASE_URL
        || ''
    ).replace(/\/+$/, '');
    return raw.toLowerCase().endsWith('/v1') ? raw : `${raw}/v1`;
}

function authHeaders() {
    const key = process.env.QWEN_VISION_API_KEY || process.env.LIGHTNING_VISION_API_KEY || 'x';
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

/** Build a contact sheet the same shape storyboard-scout sends: 25 tiles @ 320x180. */
async function buildContactSheet(srcImage, outPath) {
    const C = require('@napi-rs/canvas');
    const cols = 5, rows = 5, tw = 320, th = 180;
    const canvas = C.createCanvas(cols * tw, rows * th);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Our own project JPEG, not arbitrary web bytes — see project_canvas_tiff_segfault
    // for why that distinction matters before handing anything to loadImage.
    const img = await C.loadImage(fs.readFileSync(srcImage));
    for (let i = 0; i < cols * rows; i++) {
        const dx = (i % cols) * tw;
        const dy = Math.floor(i / cols) * th;
        try { ctx.drawImage(img, dx, dy, tw, th); } catch (_) { /* skip tile */ }
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(dx, dy, tw, th);
    }
    // 82 is the app's own quality scale (0-100, NOT 0-1 — see
    // project_vision_jpeg_quality_bug: 0-1 silently produced 19KB smears).
    fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg', 82));
    return { path: outPath, w: canvas.width, h: canvas.height };
}

/**
 * The heaviest realistic scoring context. The prompt is ~2100 tokens before a
 * pixel is attached precisely because every one of these fields is populated in
 * a real build -- a thin context would measure small and prove nothing.
 */
function heavyContext() {
    return {
        videoTopic: 'The Amish community and the economics of horse-drawn farming in Lancaster County',
        visualIntent: 'wide establishing shot of an Amish farmer driving a six-horse hitch across a ploughed field at golden hour',
        sceneText: 'For more than three centuries the Amish have refused the tractor, and the arithmetic of that refusal '
            + 'turns out to be far stranger than outsiders assume. A team of six draft horses costs less to keep than a '
            + 'single modern combine, and the manure they leave behind is worth more per acre than the diesel they replace.',
        niche: 'explainer.business',
        theme: 'warm-editorial',
        tone: 'measured, documentary, unhurried',
        entities: ['Amish', 'Lancaster County', 'Pennsylvania', 'draft horses', 'Old Order Amish'],
        entityContext: [
            'Amish: Anabaptist Christian group, plain dress, selective technology use',
            'Lancaster County: Pennsylvania county with the oldest Amish settlement',
            'draft horses: Belgian and Percheron breeds used for field work',
            'buggy: horse-drawn passenger vehicle, orange triangle marking',
            'barn raising: communal construction tradition',
            'Ordnung: the unwritten community rules governing technology',
            'shunning: social exclusion practice for rule-breakers',
            'Rumspringa: adolescent period before baptism',
        ],
        sourceTitle: 'Amish Farming Documentary - Life Without Tractors (Full Episode)',
        mediaAgent: {
            viewerNeed: 'see the actual scale of animal-powered farming, not a posed portrait',
            minimumAcceptable: 'any clear daylight shot of working draft horses pulling farm equipment',
            acceptanceTest: 'a viewer must be able to count more than two horses in harness and see soil being worked',
            identityEvidenceMode: 'frame-visible',
            mandatoryIdentity: ['draft horses in harness', 'agricultural field'],
            mandatoryVisible: ['horses', 'plough or harrow', 'open field'],
            mustShow: ['multiple horses', 'farm implement', 'worked soil', 'daylight'],
            mustAvoid: ['tractors', 'modern machinery', 'stock watermark', 'on-screen text overlay', 'studio backdrop'],
        },
        mediaHunter: {
            lane: 'youtube',
            goodFootageMeans: 'observational documentary footage, no presenter to camera, no lower-thirds',
        },
    };
}

async function main() {
    console.log('[live-gpu-window] verifying the widened reading window on a REAL boot\n');

    // Capture the app's OWN scoring prompt, verbatim. Restating it here would
    // measure a prompt nobody sends -- and prompt LENGTH is the entire defect.
    // ai-vision destructures callVisionAI at module load, so the wrapper has to
    // be installed on the provider BEFORE ai-vision is first required.
    const aiProvider = require('../../src/brain/ai-provider');
    const sentPrompts = [];
    const _origCallVisionAI = aiProvider.callVisionAI;
    aiProvider.callVisionAI = function capturing(prompt, ...rest) {
        sentPrompts.push(String(prompt || ''));
        return _origCallVisionAI.call(this, prompt, ...rest);
    };

    const visionGpu = require('../../src/vision/vision-gpu');
    console.log(`  backend: ${visionGpu.backendLabel()}`);

    // ── 1. boot the box exactly the way a build does ─────────────────────────
    console.log('\n[1] booting the GPU through the real build path (ensureReady)…');
    const t0 = Date.now();
    const ready = await visionGpu.ensureReady({ onProgress: log });
    const bootSec = Math.round((Date.now() - t0) / 1000);
    record('the GPU boots and reports ready', !!(ready && ready.ok),
        `${bootSec}s — ${JSON.stringify(ready).slice(0, 300)}`);
    if (!ready || !ready.ok) {
        console.log('\n[live-gpu-window] cannot continue without a live box.');
        process.exit(1);
    }

    const url = baseUrl();
    console.log(`  endpoint: ${url}`);

    // ── 2. THE DIRECT PROOF: what window did vLLM actually come up with? ─────
    console.log('\n[2] asking the box what reading window it is serving…');
    let served = null;
    try {
        const res = await axios.get(`${url}/models`, {
            headers: authHeaders(), timeout: 20000, adapter: 'http', validateStatus: () => true,
        });
        const entry = (res.data && Array.isArray(res.data.data)) ? res.data.data[0] : null;
        served = entry && Number(entry.max_model_len);
        console.log(`  /v1/models -> ${JSON.stringify(entry).slice(0, 240)}`);
    } catch (e) {
        console.log(`  /v1/models failed: ${e.message}`);
    }

    record('the box reports a reading window at all', Number.isFinite(served),
        `max_model_len = ${served}`,
        'vLLM did not report max_model_len; the rest of this run is inference from behaviour only');
    record('the window is wider than the one that rejected every image',
        Number.isFinite(served) && served > OLD_WINDOW,
        `serving ${served} tokens; the broken config served ${OLD_WINDOW}`);
    record('the window is the one serve-vision.sh asks for (no silent step-down)',
        served === WANT_WINDOW,
        served === WANT_WINDOW
            ? `${WANT_WINDOW} tokens — the top rung held on this GPU`
            : `serving ${served}, asked for ${WANT_WINDOW} — the ladder stepped down, so the T4 could not hold the top rung`);

    // ── 3. how big is a REAL request, measured on the box itself? ────────────
    console.log('\n[3] measuring real scoring requests against that window…');
    const aiVision = require('../../src/vision/ai-vision');
    const SRC = 'C:/Users/user/Downloads/300$ Test/public/scene-16-asset.jpg';
    if (!fs.existsSync(SRC)) {
        record('a real project frame is available to score', false, `${SRC} is missing`);
    } else {
        const tmpDir = path.join(__dirname, '..', '..', '.tmp');
        fs.mkdirSync(tmpDir, { recursive: true });

        const cases = [{ label: 'single frame', file: SRC }];
        try {
            const sheet = await buildContactSheet(SRC, path.join(tmpDir, 'live-contact-sheet.jpg'));
            cases.push({ label: `contact sheet ${sheet.w}x${sheet.h} (25 tiles)`, file: sheet.path });
        } catch (e) {
            console.log(`  (could not build a contact sheet: ${e.message})`);
        }

        const ctx = heavyContext();
        const measured = [];
        for (const c of cases) {
            const b64 = fs.readFileSync(c.file).toString('base64');

            // 3a. THE APP'S OWN PATH -> does a score actually come back? This also
            //     captures the exact prompt the app sends, for 3b to measure.
            sentPrompts.length = 0;
            const scored = await aiVision.scoreVideoFrame(b64, 'image/jpeg', 'amish farmer horse plough field', ctx);
            const score = scored && Number(scored.score);
            console.log(`  ${c.label}: app score -> ${JSON.stringify(scored).slice(0, 260)}`);
            record(`the app gets a real score back for the ${c.label}`,
                !!scored && Number.isFinite(score) && !scored.apiError && !scored.parseError,
                scored
                    ? `score=${scored.score} apiError=${!!scored.apiError} parseError=${!!scored.parseError}`
                    : 'no result at all');

            // 3b. Replay the app's REAL prompt raw, to read the token count the
            //     box charges it. This is the number that used to exceed 4096.
            const realPrompt = sentPrompts[0];
            if (!realPrompt) {
                record(`the app's own ${c.label} prompt was captured for measurement`, false,
                    'callVisionAI was never reached — nothing to measure');
                continue;
            }
            console.log(`  ${c.label}: app prompt is ${realPrompt.length} chars`);

            let promptTokens = null;
            let rawStatus = null;
            let rawErr = '';
            try {
                const body = {
                    model: process.env.QWEN_VISION_MODEL || 'qwen2.5-vl',
                    max_tokens: 400,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: realPrompt },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
                        ],
                    }],
                };
                const r = await axios.post(`${url}/chat/completions`, body, {
                    headers: authHeaders(), timeout: 180000, adapter: 'http', validateStatus: () => true,
                });
                rawStatus = r.status;
                promptTokens = r.data && r.data.usage && Number(r.data.usage.prompt_tokens);
                if (r.status !== 200) rawErr = JSON.stringify(r.data).slice(0, 400);
            } catch (e) {
                rawErr = e.message;
            }
            console.log(`  ${c.label}: http ${rawStatus}, prompt_tokens=${promptTokens}${rawErr ? ` err=${rawErr}` : ''}`);

            record(`a real ${c.label} request is accepted, not rejected as too long`,
                rawStatus === 200, rawErr || `http ${rawStatus}`);

            if (Number.isFinite(promptTokens)) {
                measured.push({ label: c.label, promptTokens });
                console.log(`  ${c.label}: ${promptTokens} tokens`
                    + ` — ${Math.round(promptTokens / OLD_WINDOW * 100)}% of the old ${OLD_WINDOW} ceiling,`
                    + ` ${Math.round(promptTokens / served * 100)}% of the new ${served}`);
                record(`the ${c.label} request fits the new window with headroom`,
                    Number.isFinite(served) && promptTokens < served * 0.9,
                    `${promptTokens} of ${served} tokens (${Math.round(promptTokens / served * 100)}% used)`);
            }
        }

        // Not every single request exceeded 4096 — a plain frame with a lean
        // context lands just under it. That is exactly why the failure was so
        // confusing: it looked intermittent. The defect is that the ceiling sat
        // INSIDE the normal spread of request sizes, so the assertion has to be
        // about the spread, not about one request.
        if (measured.length) {
            const over = measured.filter((m) => m.promptTokens > OLD_WINDOW);
            const worst = Math.max(...measured.map((m) => m.promptTokens));
            record('a realistic request really does exceed the old ceiling',
                over.length > 0,
                `${over.length}/${measured.length} over ${OLD_WINDOW} (largest ${worst}): `
                + measured.map((m) => `${m.label}=${m.promptTokens}`).join(', '),
                `nothing measured above ${OLD_WINDOW} (largest ${worst}) — this run did not reproduce the failing size`);
            record('every measured request clears the old ceiling by less than 2x',
                worst < OLD_WINDOW * 2,
                `largest ${worst} vs ${OLD_WINDOW} — the old window sat inside the normal spread, `
                + 'which is why it failed intermittently instead of obviously');
        }
    }

    // ── 4. did anything bench the box along the way? (Fix A, live) ───────────
    console.log('\n[4] the box must still be usable after all of that…');
    const stillReady = await visionGpu.isVisionReady(8000);
    record('the box is still serving after a full round of real requests', stillReady,
        'the lane survived — nothing benched it',
        'something benched or killed the lane mid-run');

    // ── summary ─────────────────────────────────────────────────────────────
    const failed = results.filter((r) => !r.ok);
    console.log(`\n[live-gpu-window] ${results.length - failed.length}/${results.length} passed`);

    if (!KEEP) {
        console.log('\n[5] stopping the GPU (billing)…');
        try { await visionGpu.stop({ onProgress: log }); console.log('  stopped.'); }
        catch (e) { console.log(`  STOP FAILED — stop it by hand: ${e.message}`); }
    } else {
        console.log('\n[5] --keep: leaving the GPU RUNNING. Remember to stop it.');
    }

    process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
    console.error('\n[live-gpu-window] crashed:', e && e.stack || e);
    if (!KEEP) {
        try { await require('../../src/vision/vision-gpu').stop({ onProgress: log }); }
        catch (_) { console.error('  STOP ALSO FAILED — stop the GPU by hand.'); }
    }
    process.exit(1);
});
