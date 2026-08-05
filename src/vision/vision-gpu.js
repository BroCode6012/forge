/**
 * vision-gpu.js — ONE control surface for the rented vision GPU, whichever provider it is.
 *
 * The model: the GPU machine must run ONLY while vision is actually needed — i.e. during the
 * media-download/scoring phase of a build — not during transcribe/Director/Planner (before)
 * or rendering (after). So the build pipeline starts it JUST-IN-TIME right before scoring and
 * stops it once scoring is done. This module delegates to the backend-specific controller
 * (vision-box.js = AWS EC2, lightning-box.js = Lightning Studio) based on VISION_BACKEND, and
 * remembers whether THIS process started the machine so it only stops what it started (a
 * machine the user pre-warmed by hand is left running).
 *
 * bedrock / dashscope have no machine to manage → ensureReady() is a no-op ({ ok, skipped }).
 */

'use strict';

const config = require('../settings/config');

let _weStarted = false; // did ensureReady() boot the machine in THIS process?

function backend() {
    return String(process.env.VISION_BACKEND || 'aws').toLowerCase();
}
function backendLabel() {
    const b = backend();
    return b === 'aws' ? 'AWS GPU box' : b === 'lightning' ? 'Lightning Studio' : b;
}
function _mod() {
    const b = backend();
    if (b === 'aws') return require('./vision-box');
    if (b === 'lightning') return require('./lightning-box');
    return null; // bedrock / dashscope — nothing to start/stop
}

/** Is auto-control available for the current backend? */
function isConfigured() {
    const m = _mod();
    return !!(m && m.isConfigured && m.isConfigured());
}

/** Is the vision endpoint answering right now? */
async function isVisionReady() {
    const m = _mod();
    return (m && m.isVisionReady) ? m.isVisionReady() : false;
}

/**
 * Bring the vision GPU up and BLOCK until it's ready (boot + model load + — for Lightning —
 * tunnel URL capture). No-op for backends without a machine. Marks _weStarted when it had to
 * boot a cold machine, so stopIfStarted() later knows to shut it down.
 */
async function ensureReady(opts = {}) {
    const m = _mod();
    if (!m) return { ok: true, skipped: true, reason: `${backend()} has no GPU machine` };
    if (!m.isConfigured || !m.isConfigured()) {
        return { ok: false, reason: `${backendLabel()} auto-control not configured` };
    }
    const wasReady = await (m.isVisionReady ? m.isVisionReady() : Promise.resolve(false));
    const log = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const ready = () => (m.isVisionReady ? m.isVisionReady() : Promise.resolve(false));

    // Retry the wake-up until the machine actually SERVES. A cold Studio/vLLM can
    // fail a first attempt (boot race, tunnel not up yet, model still loading, a
    // transient SDK/API hiccup) — keep trying with backoff instead of dumping the
    // whole build onto the slower/paid Bedrock vision chain. Bounded by
    // VISION_GPU_START_ATTEMPTS so a permanently-broken machine still yields to
    // Bedrock (the build never hangs forever). Crank the attempts up for more
    // persistence; set to 1 to disable retries.
    const maxAttempts = Math.max(1, Number(process.env.VISION_GPU_START_ATTEMPTS || 6));
    const baseDelayMs = Math.max(3, Number(process.env.VISION_GPU_RETRY_DELAY_SEC || 20)) * 1000;
    let r = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try { r = await m.ensureReady(opts); }
        catch (e) { r = { ok: false, reason: String(e && e.message || e).slice(0, 120) }; }
        if (r && r.ok) break;
        // A boot can report failure (timeout/parse) while the endpoint actually
        // came up moments later — verify before giving up on this attempt.
        if (await ready()) { r = { ok: true, recovered: true }; break; }
        // Account/configuration policy failures (for example Lightning requiring
        // a verified payment method) cannot heal through retries. Preserve the
        // exact reason and fall back immediately instead of waiting through six
        // identical wake-up attempts.
        if (r && r.retryable === false) {
            log(`❌ ${backendLabel()} cannot start: ${r.reason || 'non-retryable configuration failure'} — vision falls back to Bedrock for this build.`);
            break;
        }
        if (attempt < maxAttempts) {
            const delay = Math.min(baseDelayMs * attempt, 90000); // linear backoff, cap 90s
            log(`⚠️ ${backendLabel()} wake-up attempt ${attempt}/${maxAttempts} failed (${(r && r.reason) || 'unknown'}) — retrying in ${Math.round(delay / 1000)}s…`);
            await new Promise((res) => setTimeout(res, delay));
        } else {
            log(`❌ ${backendLabel()} still not up after ${maxAttempts} attempts (${(r && r.reason) || 'unknown'}) — vision falls back to Bedrock for this build.`);
        }
    }
    if (r && r.ok && !wasReady && !r.alreadyReady) _weStarted = true;
    return r;
}

/** Stop the machine unconditionally (idempotent). Clears the started flag. */
async function stop(opts = {}) {
    const m = _mod();
    if (!m || !(m.isConfigured && m.isConfigured())) return { ok: true, skipped: true };
    const r = await m.stop(opts);
    _weStarted = false;
    return r;
}

/** Stop the machine ONLY if this process started it (leave a user-warmed machine running). */
async function stopIfStarted(opts = {}) {
    if (!_weStarted) return { ok: true, skipped: true, reason: 'machine not started by this build' };
    return stop(opts);
}

module.exports = { backend, backendLabel, isConfigured, isVisionReady, ensureReady, stop, stopIfStarted };
