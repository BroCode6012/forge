#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the GPU bug found in the 2026-07-31 build.
 *
 * THE BUG. The rented vision box answered 16 requests with HTTP 400 — a
 * PROTOCOL statement about the payload we uploaded ("Input length 4127 exceeds
 * model's maximum context length 4096", "Failed to load image: cannot identify
 * image file"). `_isQuotaError` bucketed 400 alongside 429/5xx and returned
 * `rate_limited`, so every one of those benched the key/model on a cooldown.
 *
 * On hosted DashScope that costs nothing — many keys × many models, the
 * rotation just moves on. On a SELF-HOSTED box there is exactly ONE key and
 * ONE model, so a single malformed request benches the entire lane:
 * `_getBestKeyAndModel` returns null, the caller is told "All Qwen image
 * model/key combos are temporarily unavailable", and the frame goes to PAID
 * Bedrock. Measured result over a 47-minute media phase: the GPU scored
 * **zero** images while 152 Bedrock vision calls errored behind it.
 *
 * THE RULE THIS FILE LOCKS IN:
 *   a 400 describes OUR REQUEST, so it may fail one call and must never
 *   bench a key/model — while a 429 still describes THEIR CAPACITY and must
 *   still bench.
 *
 * No network, no AWS: the box is a local HTTP server and the Bedrock creds are
 * blanked so the vision chain is qwen-only. Persisted qwen state is redirected
 * to a scratch dir so the real health/exhaustion files are never touched.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src', 'brain', 'ai-provider.js');

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
async function checkAsync(label, fn) {
    checks++;
    try {
        await fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

// A real 1×1 JPEG. Embedded rather than generated so this gate has no
// image-library dependency of its own.
const TINY_JPEG_B64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof'
    + 'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB'
    + 'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

// ─────────────────────────────────────────────────────────────────────────────
// A. Structural — the classification rule itself
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[gpu-bad-request] A. a 400 is classified as a request fault, not a quota fault');

const src = fs.readFileSync(SRC, 'utf8');
const quotaFn = src.slice(src.indexOf('function _isQuotaError'));
const quotaBody = quotaFn.slice(0, quotaFn.indexOf('\n}\n') + 2);

check('_isQuotaError never returns a cooldown for a 400', () => {
    assert.ok(quotaBody.length > 100, 'could not locate _isQuotaError body');
    assert.ok(!/status\s*===\s*400/.test(quotaBody),
        '400 is back in _isQuotaError — one malformed payload will bench the whole box again');
});

check('_isQuotaError still returns a cooldown for 429 and 5xx', () => {
    assert.ok(/status\s*===\s*429/.test(quotaBody), '429 must still be a cooldown');
    assert.ok(/status\s*===\s*503/.test(quotaBody), '5xx must still be a cooldown');
});

check('_isRequestDefectError exists and only ever fires on a 400', () => {
    const i = src.indexOf('function _isRequestDefectError');
    assert.ok(i > 0, 'missing _isRequestDefectError');
    const body = src.slice(i, i + 1800);
    assert.ok(/status\s*!==\s*400\)\s*return null/.test(body),
        'the 400-only guard is gone — a 403/429/5xx could now be misread as a payload fault');
});

check('the box\'s own words are surfaced, not swallowed', () => {
    assert.ok(src.includes('function _qwenErrorText'), 'missing _qwenErrorText');
    // Without this the build only printed the generic "box busy" label and the
    // real complaint ("exceeds model's maximum context length") never appeared.
    assert.ok(/box said|server said/.test(src),
        'the server\'s own error text is no longer logged');
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Structural — all three Qwen lanes, and no sticky health record
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[gpu-bad-request] B. every Qwen lane rotates without benching');

check('all three lanes (image, omni-http, omni-realtime) classify request defects', () => {
    const uses = (src.match(/_isRequestDefectError\(/g) || []).length;
    // 1 definition + 3 call sites.
    assert.ok(uses >= 4, `expected the check wired into all 3 lanes, found ${uses - 1} call site(s)`);
});

check('a tried combo is skipped call-locally instead of being benched', () => {
    const i = src.indexOf('function _getBestKeyAndModel');
    const sig = src.slice(i, i + 200);
    assert.ok(/excludeCombos/.test(sig),
        '_getBestKeyAndModel lost its call-local exclusion set — the only way to advance the '
        + 'rotation would be to bench a healthy combo again');
    const wired = (src.match(/, *triedCombos\)/g) || []).length;
    assert.ok(wired >= 3, `expected all 3 lanes to pass triedCombos, found ${wired}`);
});

check('a request defect never writes the sticky bad_param health status', () => {
    // `bad_param` is sticky (see _qwenHealthSkipReason). Recording it on a
    // one-off bad frame would sideline a healthy combo through a different
    // door — the same bug, wearing a different hat.
    const i = src.indexOf('realtimeDefect');
    assert.ok(i > 0, 'the realtime lane no longer distinguishes a payload fault');
    const branch = src.slice(i, src.indexOf('_setQwenHealthRecord', i));
    assert.ok(/continue;/.test(branch),
        'the realtime payload-fault branch must rotate before any health record is written');
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Behavioural — the real lane against a fake self-hosted box
// ─────────────────────────────────────────────────────────────────────────────
let mode = 400;
let hits = 0;
let boxScored = 0;
/** Decoded bytes of the image the box was actually sent, for the rescue check. */
let lastImage = null;

const server = http.createServer((req, res) => {
    hits++;
    if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'qwen2.5-vl' }] }));
    }
    // Drain the body so we can inspect what was really put on the wire — the
    // rescue check needs to prove a DECODABLE JPEG arrived, not just that a
    // request happened.
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
        try {
            const parts = JSON.parse(body)?.messages?.[0]?.content || [];
            const url = parts.find((p) => p?.type === 'image_url')?.image_url?.url || '';
            const m = /^data:[^;]+;base64,(.*)$/.exec(url);
            lastImage = m ? Buffer.from(m[1], 'base64') : null;
        } catch (_) { lastImage = null; }

        if (mode === 200) {
            boxScored++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: 'SCORE: 8/10 — usable B-roll.' }, finish_reason: 'stop' }],
            }));
        }
        res.writeHead(mode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: mode === 400
                ? { message: "Input length 4127 exceeds model's maximum context length 4096", type: 'BadRequestError' }
                : { message: 'server is overloaded', type: 'RateLimit' },
        }));
    });
});

server.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${server.address().port}/v1`;

    // Redirect every persisted qwen file into a scratch dir — this gate must not
    // read or write the real .qwen-vision-health.json / .qwen-exhausted-models.json.
    process.env.YTA_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-gpu-badreq-'));

    // Exactly ONE key in the pool. That is what makes a self-hosted box fatal:
    // benching the only combo takes the whole lane down.
    for (const k of Object.keys(process.env)) {
        if (/^QWEN_(VISION_|OMNI_|IMAGE_)?API_KEY(_\d+)?$/.test(k)) delete process.env[k];
    }
    process.env.VISION_BACKEND = 'lightning';
    process.env.LIGHTNING_VISION_URL = base;
    process.env.QWEN_BASE_URL = base;
    process.env.QWEN_VISION_API_KEY = 'gate-single-key';
    process.env.QWEN_VISION_MODEL = 'qwen2.5-vl';
    process.env.QWEN_IMAGE_MODELS = 'qwen2.5-vl';
    // Long enough that a bench outlives the next call in this gate.
    process.env.QWEN_VISION_BUSY_COOLDOWN_MS = '60000';
    process.env.QWEN_VISION_COOLDOWN_MS = '60000';

    const ai = require(SRC);
    const config = require(path.join(ROOT, 'src', 'settings', 'config.js'));
    if (config.qwen) { config.qwen.baseUrl = base; config.qwen.visionModel = 'qwen2.5-vl'; }
    // Blank the Bedrock creds so the chain is qwen-only: no AWS call, no spend,
    // and a qwen failure surfaces as a throw we can read.
    if (config.bedrock) { config.bedrock.accessKeyId = ''; config.bedrock.secretAccessKey = ''; }

    console.log('\n[gpu-bad-request] C. behaviour against a one-key, one-model box');

    await checkAsync('the vision chain under test is the box alone (no paid fallback)', async () => {
        assert.deepStrictEqual(ai.getVisionProviderChain(), ['qwen'],
            'this gate must exercise the box with no Bedrock behind it');
    });

    const score = () => ai.callVisionAI('score this frame', TINY_JPEG_B64, 'image/jpeg', { maxTokens: 40 });

    // NOTE on the probe: `isVisionAIAvailable()` only reports whether the
    // provider CHAIN is non-empty — it never reflects a benched key/model. The
    // only honest test of "is the box still in play" is behavioural: offer it a
    // frame it CAN answer and see whether it actually answers.

    let err400 = '';
    await checkAsync('a 400 costs one call and is blamed on the payload, not the pool', async () => {
        mode = 400; hits = 0;
        try { await score(); } catch (e) { err400 = String(e?.message || ''); }
        assert.strictEqual(hits, 1, `expected exactly 1 request to the box, saw ${hits}`);
        assert.ok(/rejected this request/i.test(err400),
            `the failure must name the payload; got "${err400.slice(0, 120)}"`);
        assert.ok(!/temporarily unavailable/i.test(err400),
            'a bad payload is still being reported as the pool running out of capacity');
    });

    await checkAsync('THE FIX — the next frame after a 400 is still scored BY THE BOX', async () => {
        mode = 200; boxScored = 0;
        const text = await score();
        assert.strictEqual(boxScored, 1, `the box scored ${boxScored} frame(s), expected 1`);
        assert.ok(/8\/10/.test(String(text || '')), 'the box\'s answer did not come back');
    });

    await checkAsync('bytes no decoder can read never reach a provider at all', async () => {
        // Random noise: neither the canvas library nor ffmpeg can make an image
        // of it. Before this fix these bytes were shipped onward still labelled
        // image/jpeg and rejected once per provider — 3 paid calls, 0 chance.
        mode = 200; hits = 0;
        const junk = Buffer.alloc(9000);
        for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
        let tagged = false;
        try {
            await ai.callVisionAI('score this frame', junk.toString('base64'), 'image/jpeg', { maxTokens: 40 });
        } catch (e) {
            tagged = e?.visionImageUnreadable === true;
        }
        assert.strictEqual(hits, 0, `undecodable bytes still reached the box ${hits} time(s)`);
        assert.ok(tagged, 'the failure is not tagged as an unreadable image, so callers cannot '
            + 'tell a broken frame from a vision outage');
    });

    // These two live checks must run BEFORE the 429 below, which deliberately
    // benches the combo for 60s — after that the box cannot answer anything.
    await checkAsync('a TIFF is routed away from the decoder instead of killing the build', async () => {
        // @napi-rs/canvas 0.1.95 SEGFAULTS on a TIFF: exit 139, no exception.
        // Every decode site is wrapped in try/catch and a try/catch cannot see a
        // segfault, so one .jpg URL serving TIFF bytes killed the whole build
        // with no error message at all. If the guard regresses, THIS GATE dies
        // at exit 139 right here — reaching the assertions is part of the proof.
        mode = 200; hits = 0;
        const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(4096, 0x5a)]);
        let tagged = false;
        try {
            await ai.callVisionAI('score this frame', tiff.toString('base64'), 'image/jpeg', { maxTokens: 40 });
        } catch (e) {
            tagged = e?.visionImageUnreadable === true;
        }
        assert.strictEqual(hits, 0, 'unreadable TIFF bytes were still sent to the box');
        assert.ok(tagged, 'a TIFF is not reported as an unreadable frame');
    });

    await checkAsync('THE PAYOFF — a format the decoder refuses is rescued, not lost', async () => {
        // A PPM: the in-process decoder throws "Unsupported image type", but
        // ffmpeg reads it fine. Before the rescue this frame was simply lost.
        // Same path that recovers a video container handed to us as a "frame".
        mode = 200; hits = 0; lastImage = null;
        const w = 64, h = 48;
        const px = Buffer.alloc(w * h * 3);
        for (let i = 0; i < px.length; i += 3) { px[i] = 200; px[i + 1] = 40; px[i + 2] = 40; }
        const ppm = Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), px]);
        assert.strictEqual(require(path.join(ROOT, 'src', 'util', 'image-bytes.js')).isCanvasSafeImage(ppm),
            false, 'a PPM is being trusted to the decoder');

        const out = await ai.callVisionAI('score this frame', ppm.toString('base64'), 'image/jpeg', { maxTokens: 40 });
        assert.strictEqual(hits, 1, `the rescued frame did not reach the box (hits=${hits})`);
        assert.ok(/8\/10/.test(String(out)), 'the box did not score the rescued frame');
        assert.ok(lastImage && lastImage.length > 100,
            'no image payload arrived — the rescue produced nothing');
        // Shape, not size: a flat test frame legitimately compresses to a few
        // hundred bytes, and a size floor here would re-create the very bug this
        // check exists to catch.
        assert.ok(lastImage[0] === 0xff && lastImage[1] === 0xd8 && lastImage[2] === 0xff,
            'what arrived is not a JPEG — the rescue shipped bytes the provider cannot read');
    });

    await checkAsync('a 429 (real capacity signal) still benches the box', async () => {
        mode = 429;
        try { await score(); } catch (_) { /* expected — chain is qwen-only */ }
        mode = 200; boxScored = 0;
        try { await score(); } catch (_) { /* expected — the combo is benched */ }
        assert.strictEqual(boxScored, 0,
            'a genuinely overloaded box must be rested, not hammered');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // D. The other half of the 400s: the box could not READ what we sent
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[gpu-bad-request] D. the box is configured to read what the app actually sends');

    const serve = fs.readFileSync(path.join(ROOT, 'lightning', 'serve-vision.sh'), 'utf8');

    check('the reading window is wide enough for a real scoring request', () => {
        const m = serve.match(/MAX_MODEL_LEN="\$\{MAX_MODEL_LEN:-(\d+)\}"/);
        assert.ok(m, 'MAX_MODEL_LEN default not found in serve-vision.sh');
        const len = parseInt(m[1], 10);
        // Measured on 2026-07-31: the app's own prompt is ~2100 tokens before any
        // image, and real requests reached 4594. 4096 rejected them all.
        assert.ok(len >= 8192,
            `reading window is ${len} tokens — real requests measured up to 4594 and grow with `
            + 'contact-sheet grids, so anything under 8192 will start silently rejecting frames again');
    });

    check('a window too large for the GPU steps down instead of leaving it dead', () => {
        assert.ok(/CONTEXT_LADDER=/.test(serve), 'the step-down ladder is gone');
        assert.ok(/BOOT_GRACE=/.test(serve),
            'without a boot grace period a crash of a PROVEN window would silently shrink it mid-build');
    });

    check('batched tokens can never fall below the window', () => {
        // vLLM refuses to start when max-num-batched-tokens < max-model-len and
        // chunked prefill is off, so these two must not be independently set.
        assert.ok(/MAX_BATCHED_TOKENS:-\}/.test(serve) || /\$\{MAX_BATCHED_TOKENS:-\$len\}/.test(serve),
            'MAX_BATCHED_TOKENS no longer tracks the window');
    });

    console.log('\n[gpu-bad-request] E. bytes no decoder can read are dropped, not paid for 3 times');

    const aiv = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'ai-vision.js'), 'utf8');

    check('an undecodable frame gets an ffmpeg rescue before being given up on', () => {
        assert.ok(src.includes('_ffmpegDecodeToJpeg'), 'the ffmpeg rescue is gone');
        assert.ok(/rescued:\s*true/.test(src), 'a rescued frame is no longer flagged');
    });

    check('unreadable bytes are never shipped to a provider anyway', () => {
        // The give-up path lives in the shared rescue helper, which BOTH routes
        // into it use: the decoder threw, or we refused to offer it the bytes.
        const r = src.indexOf('async function _rescueVisionFrame');
        assert.ok(r > 0, 'the shared rescue/give-up helper is gone');
        assert.ok(/unreadable:\s*true/.test(src.slice(r, src.indexOf('\n}\n', r))),
            'the undecodable case no longer returns an explicit marker');
        const i = src.indexOf('async function _normalizeVisionImage');
        const body = src.slice(i, src.indexOf('\n}\n', i));
        assert.ok(!/base64:\s*raw\.toString\('base64'\)/.test(body),
            'raw undecodable bytes are being passed through again — that is 1 guaranteed '
            + 'rejection per provider, which cost 54 wasted calls in the 2026-07-31 build');
    });

    check('callVisionAI stops on an unreadable image instead of walking the chain', () => {
        assert.ok(/visionImageUnreadable\s*=\s*true/.test(src),
            'callVisionAI no longer tags the undecodable case');
    });

    check('an undecodable frame is a bad CANDIDATE, not a vision outage', () => {
        // apiError makes callers KEEP the clip ("the service broke, not the
        // footage") — exactly the wrong call for a frame that is genuinely broken.
        assert.ok(/visionImageUnreadable/.test(aiv),
            'ai-vision no longer distinguishes an undecodable frame');
        const i = aiv.indexOf('visionImageUnreadable');
        const branch = aiv.slice(i, i + 500);
        assert.ok(/imageUnreadable:\s*true/.test(branch), 'the distinct outcome flag is missing');
        assert.ok(!/apiError/.test(branch.slice(0, branch.indexOf('};'))),
            'an undecodable frame is being reported as an API failure again');
    });

    console.log('\n[gpu-bad-request] F. bytes that CRASH the decoder never reach it');

    // @napi-rs/canvas 0.1.95 SEGFAULTS on a TIFF: exit 139, no exception. Every
    // decode call site is wrapped in try/catch and a try/catch cannot see a
    // segfault, so one .jpg URL serving TIFF bytes killed the whole build with
    // no error message. Measured, one isolated process per format:
    //   jpeg png webp gif bmp avif svg -> decode   ppm mp4 html -> throw safely
    //   tiff -> process death
    // NOTE: if the guard regresses, THIS GATE ITSELF dies at exit 139 mid-run.
    // That is the strongest possible assertion and is deliberate.
    const imgBytes = require(path.join(ROOT, 'src', 'util', 'image-bytes.js'));

    check('the decoder is only trusted with formats proven safe', () => {
        const tiffLE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
        const tiffBE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert.strictEqual(imgBytes.sniffImageFormat(tiffLE), 'tiff', 'little-endian TIFF not recognised');
        assert.strictEqual(imgBytes.sniffImageFormat(tiffBE), 'tiff', 'big-endian TIFF not recognised');
        assert.strictEqual(imgBytes.isCanvasSafeImage(tiffLE), false, 'TIFF would be handed to the decoder — that is a segfault');
        assert.strictEqual(imgBytes.isCanvasSafeImage(tiffBE), false, 'TIFF would be handed to the decoder — that is a segfault');

        // Positive allowlist: unknown must be treated as unsafe. A false negative
        // costs one ffmpeg call; a false positive costs the entire build process.
        assert.strictEqual(imgBytes.isCanvasSafeImage(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9])), false,
            'unrecognised bytes are being trusted to the decoder');

        // …without breaking the formats that genuinely work.
        for (const [name, head] of [
            ['jpeg', [0xff, 0xd8, 0xff, 0xe0]],
            ['png', [0x89, 0x50, 0x4e, 0x47]],
            ['gif', [0x47, 0x49, 0x46, 0x38]],
            ['bmp', [0x42, 0x4d, 0, 0]],
        ]) {
            const b = Buffer.concat([Buffer.from(head), Buffer.alloc(12)]);
            assert.strictEqual(imgBytes.isCanvasSafeImage(b), true, `${name} is wrongly refused — every real frame would take the slow path`);
        }
        const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
        assert.strictEqual(imgBytes.isCanvasSafeImage(webp), true, 'webp is wrongly refused');
        const avif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(4)]);
        assert.strictEqual(imgBytes.isCanvasSafeImage(avif), true, 'avif is wrongly refused');
    });

    check('every call site that takes arbitrary web bytes sniffs before decoding', () => {
        // These three are handed bytes straight off the internet. The other
        // loadImage sites take assets we generated ourselves.
        for (const rel of [
            ['src', 'brain', 'ai-provider.js'],
            ['src', 'media', 'footage-manager.js'],
            ['src', 'vision', 'thumbnail-vision.js'],
        ]) {
            const txt = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
            assert.ok(/isCanvasSafeImage/.test(txt),
                `${rel.join('/')} decodes arbitrary bytes with no pre-flight sniff — a TIFF there kills the build silently`);
        }
    });

    server.close();
    console.log(`\n[gpu-bad-request] ${checks - failures}/${checks} checks passed`);
    if (failures) {
        console.log(`[gpu-bad-request] FAILED — ${failures} check(s)`);
        process.exit(1);
    }
    console.log('[gpu-bad-request] OK');
    process.exit(0);
});
