#!/usr/bin/env node
// scripts/bedrock-vision-probe.js
// ============================================================================
// Answers ONE question: which Bedrock vision models can THIS account actually
// call right now, and how fast is each one?
//
// Why this exists (2026-08-04): the build picked `us.anthropic.claude-sonnet-5`
// as the primary vision judge and every single call came back
//   AccessDeniedException http=403 "... is not available for this account"
// then silently fell back to bedrock-qwen-vl. scripts/list-bedrock-models.js
// can't catch that: ListFoundationModels returns every model in the REGION,
// including ones the account has no entitlement for. The only proof of access
// is a real Converse call, so this script makes one — with a 64x64 generated
// PNG and a 5-token reply, i.e. a fraction of a cent per model.
//
// Env layering mirrors src/settings/config.js: repo .env, then the user-level
// .env with override:true (that layer is the one that keeps surprising us —
// see the YTA_ENV_LOCK note in src/settings/build-env.js).
//
// Prints model IDs, latencies and error CLASSES only. Never prints a secret.
//
// Run:  node scripts/bedrock-vision-probe.js
//       node scripts/bedrock-vision-probe.js --all     (probe every candidate,
//                                                       not just the shortlist)
// ============================================================================
'use strict';

const path = require('path');
const zlib = require('zlib');

// ── env layers, weakest first (same order config.js uses) ──
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const userEnvPath = process.env.YTA_USER_ENV_PATH
    || path.join(process.env.APPDATA || process.env.HOME || '', 'yta-empire-webgl', '.env');
try { require('dotenv').config({ path: userEnvPath, override: true }); } catch (_) {}

const REGION = process.env.BEDROCK_REGION || 'us-east-1';
const KEY_ID = process.env.BEDROCK_ACCESS_KEY_ID || '';
const SECRET = process.env.BEDROCK_SECRET_ACCESS_KEY || '';
const PROBE_ALL = process.argv.includes('--all');

// ── a real PNG, generated: 64x64 grayscale with a black bar across the middle.
// Some judges reject 1x1 images with a validation error, which would be
// indistinguishable from a real access failure. Building one is 20 lines and
// removes that ambiguity entirely.
function makeProbePng() {
    const W = 64, H = 64;
    const raw = Buffer.alloc(H * (W + 1));
    for (let y = 0; y < H; y++) {
        const row = y * (W + 1);
        raw[row] = 0; // filter: none
        const shade = (y > 26 && y < 38) ? 0x00 : 0xC0;
        raw.fill(shade, row + 1, row + 1 + W);
    }
    const crcTable = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c;
        }
        return t;
    })();
    const crc32 = (buf) => {
        let c = -1;
        for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ -1) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── classify an AWS error so the table says WHY, without dumping stack noise ──
function classifyError(err) {
    const name = String(err && (err.name || err.__type) || '');
    const msg = String(err && err.message || '');
    if (/AccessDenied/i.test(name) || /not available for this account/i.test(msg)) {
        return { code: 'NO ACCESS', hint: 'account is not entitled to this model' };
    }
    if (/ValidationException/i.test(name)) {
        if (/on-demand throughput isn.?t supported|inference profile/i.test(msg)) {
            return { code: 'NEEDS PROFILE', hint: 'call the us.* inference profile id, not the bare model id' };
        }
        if (/model identifier is invalid|Invalid model/i.test(msg)) {
            return { code: 'BAD ID', hint: 'that model id string does not exist' };
        }
        return { code: 'VALIDATION', hint: msg.slice(0, 90) };
    }
    if (/ResourceNotFound/i.test(name)) return { code: 'NOT IN REGION', hint: `absent from ${REGION}` };
    if (/Throttling|TooManyRequests/i.test(name)) return { code: 'THROTTLED', hint: 'rate limited — access itself is fine' };
    if (/ServiceUnavailable|ModelNotReady/i.test(name)) return { code: 'UNAVAILABLE', hint: 'transient' };
    return { code: name || 'ERROR', hint: msg.slice(0, 90) };
}

(async () => {
    console.log(`\nRegion: ${REGION}`);
    console.log(`Credentials present: ${KEY_ID ? 'yes' : 'NO — BEDROCK_ACCESS_KEY_ID is empty'}` +
        `${SECRET ? '' : ' / BEDROCK_SECRET_ACCESS_KEY is empty'}`);
    console.log(`User env layer: ${userEnvPath}\n`);
    if (!KEY_ID || !SECRET) {
        console.log('Cannot probe without credentials.');
        process.exit(1);
    }

    const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } =
        require('@aws-sdk/client-bedrock');
    const { BedrockRuntimeClient, ConverseCommand } =
        require('@aws-sdk/client-bedrock-runtime');
    const credentials = { accessKeyId: KEY_ID, secretAccessKey: SECRET };
    const ctl = new BedrockClient({ region: REGION, credentials });
    const rt = new BedrockRuntimeClient({ region: REGION, credentials });

    // ── 1. every vision-capable model the region advertises ──
    let models = [];
    try {
        const res = await ctl.send(new ListFoundationModelsCommand({}));
        models = (res.modelSummaries || []).filter((m) =>
            (m.inputModalities || []).includes('IMAGE') &&
            (m.outputModalities || []).includes('TEXT') &&
            (m.modelLifecycle || {}).status !== 'LEGACY');
    } catch (e) {
        console.log(`ListFoundationModels failed: ${e.message}`);
        process.exit(1);
    }

    // ── 2. inference profiles, so INFERENCE_PROFILE-only models get a callable id ──
    const profileFor = new Map(); // bare modelId -> us.* profile id
    try {
        const res = await ctl.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
        for (const p of res.inferenceProfileSummaries || []) {
            const pid = String(p.inferenceProfileId || '');
            // "us.anthropic.claude-x-v1:0" -> "anthropic.claude-x-v1:0"
            const bare = pid.replace(/^[a-z]{2,3}\./, '');
            if (bare && !profileFor.has(bare)) profileFor.set(bare, pid);
        }
    } catch (e) {
        console.log(`(inference profiles unavailable: ${e.message})`);
    }

    // ── 3. build the callable candidate list, deduped ──
    const candidates = [];
    for (const m of models) {
        const types = m.inferenceTypesSupported || [];
        const onDemand = types.includes('ON_DEMAND');
        const profile = profileFor.get(m.modelId);
        const callable = onDemand ? m.modelId : profile;
        if (!callable) continue; // provisioned-only: not usable here
        candidates.push({
            callable,
            provider: m.providerName || '?',
            name: m.modelName || m.modelId,
            via: onDemand ? 'on-demand' : 'profile',
        });
    }
    // Prefer the profile form when both a bare id and a profile exist for one model.
    const byName = new Map();
    for (const c of candidates) {
        const k = `${c.provider}::${c.name}`;
        const prev = byName.get(k);
        if (!prev || (prev.via === 'on-demand' && profileFor.get(prev.callable))) {
            byName.set(k, profileFor.get(c.callable)
                ? { ...c, callable: profileFor.get(c.callable), via: 'profile' }
                : c);
        }
    }
    let probeList = [...byName.values()];

    // Cheap+fast+smart is the ask, so lead with the tiers we'd actually pick as a
    // scorer. --all probes everything the region exposes.
    const SHORTLIST = /haiku|sonnet|nova-(lite|pro)|qwen.*vl|llama.*(vision|4)|pixtral|mistral-small/i;
    if (!PROBE_ALL) {
        const short = probeList.filter((c) => SHORTLIST.test(c.callable));
        if (short.length) probeList = short;
    }
    probeList.sort((a, b) => a.callable.localeCompare(b.callable));

    console.log(`Vision-capable + callable models in ${REGION}: ${byName.size}` +
        `${PROBE_ALL ? '' : ` (probing ${probeList.length} shortlisted — pass --all for every one)`}\n`);

    // ── 4. the only real test: call each one ──
    const png = makeProbePng();
    const results = [];
    for (const c of probeList) {
        const started = Date.now();
        try {
            const out = await rt.send(new ConverseCommand({
                modelId: c.callable,
                messages: [{
                    role: 'user',
                    content: [
                        { image: { format: 'png', source: { bytes: png } } },
                        { text: 'Answer with one word: is there a dark horizontal bar in this image? yes or no.' },
                    ],
                }],
                inferenceConfig: { maxTokens: 8, temperature: 0 },
            }));
            const ms = Date.now() - started;
            const text = ((out.output && out.output.message && out.output.message.content) || [])
                .map((b) => b.text || '').join(' ').trim().slice(0, 20);
            const u = out.usage || {};
            results.push({
                ...c, ok: true, ms, text,
                tokens: `${u.inputTokens || '?'}in/${u.outputTokens || '?'}out`,
                // The bar IS there; a judge that says "no" to a trivially obvious
                // feature is a bad scorer regardless of how fast it is.
                sane: /yes/i.test(text),
            });
            console.log(`  ✅ ${String(ms).padStart(6)}ms  ${c.callable}   → "${text}"`);
        } catch (e) {
            const { code, hint } = classifyError(e);
            results.push({ ...c, ok: false, code, hint });
            console.log(`  ❌ ${code.padStart(13)}  ${c.callable}   (${hint})`);
        }
    }

    // ── 5. verdict ──
    const working = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
    console.log(`\n=== ${working.length} of ${results.length} probed models are usable by this account ===`);
    if (working.length) {
        console.log('\n  fastest first:');
        for (const r of working) {
            console.log(`   ${String(r.ms).padStart(6)}ms  ${r.sane ? '  ' : '⚠️'} ${r.callable}  [${r.tokens}]`);
        }
        console.log('\n  ⚠️ = answered the trivial image question wrong; do not make it the primary judge.');
        // Passing the trivial question means "can see an image", NOT "judges footage well".
        // Measured 2026-08-04: nova-lite is the fastest model here and answers this probe
        // correctly, yet on real build frames it hallucinated image content outright
        // (called a line-art diagram a photo of a house, 7/10). Ranking by latency and
        // stopping there is how a hallucinating judge gets promoted. Say so here, next to
        // the tempting number, not only in the benchmark nobody remembers to run.
        console.log('     Passing it only proves the model can SEE. It does not prove the model');
        console.log('     JUDGES well — the fastest model here has hallucinated image content on');
        console.log('     real frames. Rank with scripts/vision-judge-bench.js before promoting.');
        console.log('\n  To use one, set in the user .env:');
        console.log(`     VISION_BEDROCK_PRIMARY_MODEL=${(working.find((r) => r.sane) || working[0]).callable}`);
        console.log('     ↑ fastest that passed the SEE check — confirm with the bench first.');
    }

    // Read the fallback default out of config.js rather than restating it here. It was
    // pinned as a literal once and went stale the moment the default changed
    // (2026-08-04, sonnet-5 → sonnet-4-6) — at which point the one script whose entire
    // job is "is the configured judge alive?" was answering about a model that is no
    // longer configured. A diagnostic that can drift is worse than no diagnostic.
    let fallbackDefault = '';
    try {
        const cfgSrc = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'settings', 'config.js'), 'utf8');
        fallbackDefault = (cfgSrc.match(
            /BEDROCK_VISION_CLAUDE_MODEL\s*=\s*[\s\S]{0,200}?\|\|\s*'([^']+)'/) || [])[1] || '';
    } catch (_) {}
    const current = process.env.VISION_BEDROCK_PRIMARY_MODEL || fallbackDefault || '(unknown)';
    const cur = results.find((r) => r.callable === current);
    console.log(`\n  currently configured primary: ${current}` +
        (cur ? (cur.ok ? '  → WORKS' : `  → BROKEN (${cur.code})`) : '  → not in the probe list'));
    console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
