/**
 * lightning-box.js — start/stop the Lightning.ai vision Studio on demand, the Lightning
 * counterpart to vision-box.js (which controls the AWS EC2 GPU box).
 *
 * Lightning's control SDK is Python, so this shells out to src/lightning-control.py
 * (spawns `python lightning-control.py <start|stop|status>`), which uses lightning_sdk to
 * start the Studio, launch vLLM + a cloudflared tunnel on it, and return the public URL.
 *
 * MULTI-ACCOUNT: when lightning-accounts.json exists (see lightning-rotation.js), ensureReady()
 * rotates across the account pool — picking a viable account, injecting ITS creds into the
 * Python helper's env, and on a start failure cooling that account down and trying the next.
 * Usage (Studio start→stop seconds) is billed back to the rotation manager so it can exhaust
 * accounts as they burn their free credit. With no pool file it falls back to the single
 * LIGHTNING_* account from .env (legacy behavior).
 *
 * Lightning's tunnel URL is EPHEMERAL — known only after the Studio boots — so ensureReady()
 * captures the URL the helper reports and repoints the vision endpoint (process.env +
 * config.qwen.baseUrl + .env) at it.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const config = require('../settings/config');
const rotation = require('./lightning-rotation');

// Tracks the account whose Studio we currently have running, so stop() can bill its usage.
let _activeSession = null; // { account, startedAt }

function _python() {
    return process.env.LIGHTNING_PYTHON || 'python';
}
function _script() {
    return path.join(__dirname, '..', 'lightning-control.py');
}
function _visionUrl() {
    return String(process.env.LIGHTNING_VISION_URL || process.env.QWEN_BASE_URL || '').replace(/\/+$/, '');
}

/** Build a per-account env for the Python helper from a rotation account object. */
function _accountEnv(acct) {
    return {
        ...process.env,
        LIGHTNING_USER_ID: acct.userId,
        LIGHTNING_API_KEY: acct.apiKey,
        LIGHTNING_STUDIO_NAME: acct.studioName,
        LIGHTNING_TEAMSPACE: acct.teamspace || '',
        LIGHTNING_USER: acct.user || '',
        LIGHTNING_ORG: acct.org || '',
        LIGHTNING_MACHINE: acct.machine || process.env.LIGHTNING_MACHINE || 'T4',
    };
}

// How long a caller is willing to sit waiting for a cooling account. Anything longer and
// falling back to Bedrock now beats a GPU that arrives after the media phase is over.
function _poolWaitBudgetMs() {
    return Math.max(0, Number(process.env.LIGHTNING_POOL_WAIT_BUDGET_MS || 60000));
}

function isConfigured() {
    if (String(process.env.VISION_BACKEND || '').toLowerCase() !== 'lightning') return false;
    // Pooled: configured if the pool has at least one account.
    if (rotation.isEnabled()) return rotation.loadAccounts().length > 0;
    // Single-account fallback.
    return !!(process.env.LIGHTNING_API_KEY && process.env.LIGHTNING_USER_ID && process.env.LIGHTNING_STUDIO_NAME);
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe one endpoint and report WHY it isn't serving.
 *
 * `reachable` is the load-bearing part: a name that does not resolve is DEAD (no amount of
 * waiting fixes it, and no other account can fix it either), whereas a 404/502/refused means
 * the address is alive and the model is simply still loading. Collapsing those two into one
 * boolean is what made the app stop a healthy, fully-loaded, already-paid-for GPU.
 */
async function _probe(url, timeoutMs = 4000) {
    if (!url) return { ready: false, reachable: false, reason: 'no url' };
    try {
        const res = await axios.get(`${url.replace(/\/+$/, '')}/models`, {
            timeout: timeoutMs, adapter: 'http', validateStatus: () => true,
        });
        const ready = res.status === 200 && Array.isArray(res.data?.data) && res.data.data.length > 0;
        return { ready, reachable: true, reason: `http ${res.status}` };
    } catch (e) {
        const code = String((e && e.code) || '');
        // Only a name-resolution failure proves the address itself is gone. Refused/reset/
        // timeout all mean something answered for that name — treat those as "still booting".
        const dead = code === 'ENOTFOUND' || code === 'EAI_AGAIN';
        return { ready: false, reachable: !dead, reason: code || (e && e.message) || 'error' };
    }
}

/** Is the vLLM endpoint answering right now? */
async function isVisionReady(timeoutMs = 4000) {
    const url = _visionUrl();
    if (!url) return false;
    return (await _probe(url, timeoutMs)).ready;
}

/** Spawn the Python control helper for one subcommand; resolve its JSON result. */
function _runPy(cmd, { timeoutMs = 360000, onProgress, env } = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let proc;
        try {
            proc = spawn(_python(), [_script(), cmd], { env: { ...(env || process.env), PYTHONIOENCODING: 'utf-8' } });
        } catch (e) {
            return resolve({ ok: false, error: `spawn failed: ${e.message}` });
        }
        const killer = setTimeout(() => {
            try { proc.kill(); } catch (_) {}
            resolve({ ok: false, error: `python timeout after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        // Forward EVERY diagnostic line, not just the last one of each chunk. The helper
        // explains itself here (dead address, fallback taken, no-domain relaunch); keeping
        // only the chunk tail silently hid the reason a start behaved the way it did.
        // A chunk can split mid-line, so hold the unterminated tail until more arrives.
        let errBuf = '';
        const pumpErr = (chunk, flush) => {
            errBuf += chunk;
            const lines = errBuf.split(/\r?\n/);
            errBuf = flush ? '' : (lines.pop() || '');
            for (const l of lines) {
                const t = l.trim();
                if (t && onProgress) onProgress(t);
            }
        };
        proc.stderr.on('data', (d) => pumpErr(d.toString(), false));
        proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: e.message }); });
        proc.on('close', () => {
            clearTimeout(killer);
            pumpErr('', true);
            const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
            try { resolve(JSON.parse(last)); }
            catch (_) { resolve({ ok: false, error: `bad helper output: ${(last || 'empty').slice(0, 200)}` }); }
        });
    });
}

/** Studio state via the SDK (running | stopped | ...). */
async function getInstanceState() {
    if (!isConfigured()) return { ok: false, reason: 'not configured' };
    const env = _activeSession ? _accountEnv(_activeSession.account) : process.env;
    const r = await _runPy('status', { timeoutMs: 90000, env });
    return r.ok ? { ok: true, state: String(r.state || 'unknown') } : { ok: false, reason: r.error };
}

/** Persist the captured tunnel URL into .env so retries/restart reuse it. */
function _persistVisionUrl(url) {
    try {
        const envPath = path.join(process.env.PROJECT_DIR || process.cwd(), '.env');
        let txt = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        if (/^LIGHTNING_VISION_URL=.*$/m.test(txt)) {
            txt = txt.replace(/^LIGHTNING_VISION_URL=.*$/m, `LIGHTNING_VISION_URL=${url}`);
        } else {
            txt += `${txt.endsWith('\n') || txt === '' ? '' : '\n'}LIGHTNING_VISION_URL=${url}\n`;
        }
        fs.writeFileSync(envPath, txt);
    } catch (_) { /* best-effort */ }
}

/**
 * The OpenAI-compatible base of an address. vLLM serves /v1/models, never /models, so every
 * address must pass through here before it is probed or stored — a raw host would 404 forever
 * and read as "the model never loaded".
 */
function _v1(rawUrl) {
    const u = String(rawUrl || '').replace(/\/+$/, '');
    return /\/v1$/.test(u) ? u : `${u}/v1`;
}

/** Repoint the vision endpoint at the freshly captured tunnel URL. */
function _applyUrl(rawUrl, log) {
    const full = _v1(rawUrl);
    process.env.LIGHTNING_VISION_URL = full;
    try { config.resolveVisionBackend(); } catch (_) {}
    // The vision call sites read config.qwen.baseUrl (cached object), NOT process.env at call
    // time — push the live URL into the config object or scoring hits the stale endpoint.
    try { if (config.qwen) config.qwen.baseUrl = process.env.QWEN_BASE_URL; } catch (_) {}
    _persistVisionUrl(full);
    if (log) log(`Lightning endpoint: ${full}`);
}

/**
 * Poll every candidate address until the model answers on one of them.
 *
 * Returns { ready, url, sawAddress }. `sawAddress` is false only when NOT ONE candidate ever
 * responded — i.e. we have no live address for the GPU at all. That is a different failure from
 * "the model never loaded", and the caller must treat it differently: it is not this account's
 * fault, so rotating to another account can only waste more paid GPU time.
 */
async function _waitModel(log, candidates) {
    const modelTimeoutMs = Number(process.env.LIGHTNING_MODEL_TIMEOUT_MS || 900000); // 15 min for cold T4
    // If nothing has answered by now, no address we hold is alive. Fail fast instead of paying
    // out the full model timeout for a name that will never resolve.
    const noAddressMs = Number(process.env.LIGHTNING_NO_ADDRESS_MS || 90000);
    // Normalise first: a candidate straight from the helper has no /v1 suffix.
    const urls = [...new Set((candidates || []).filter(Boolean).map(_v1))];
    if (!urls.length) return { ready: false, url: '', sawAddress: false };

    const t0 = Date.now();
    let ticks = 0;
    let sawAddress = false;
    let lastReason = '';
    while (Date.now() - t0 < modelTimeoutMs) {
        for (const url of urls) {
            const p = await _probe(url);
            lastReason = p.reason;
            if (p.reachable) sawAddress = true;
            if (p.ready) {
                log(`Lightning vision ready ✓ (${Math.round((Date.now() - t0) / 1000)}s)`);
                return { ready: true, url, sawAddress: true };
            }
        }
        if (!sawAddress && Date.now() - t0 >= noAddressMs) {
            log(`No address for the GPU responded in ${Math.round(noAddressMs / 1000)}s (${lastReason}) — not waiting out the model timeout.`);
            return { ready: false, url: '', sawAddress: false };
        }
        if (++ticks % 4 === 0) log(`Model loading… ${Math.round((Date.now() - t0) / 1000)}s`);
        await _sleep(5000);
    }
    return { ready: false, url: '', sawAddress };
}

/** One start attempt for a specific env (account or single .env). Returns { ok, reason }. */
async function _startWith(env, log) {
    const r = await _runPy('start', { timeoutMs: 420000, onProgress: log, env });
    if (!r.ok) {
        return {
            ok: false,
            reason: r.error || 'start failed',
            retryable: r.retryable !== false,
        };
    }
    if (!r.url) {
        return {
            ok: false,
            reason: r.error || 'no tunnel URL captured',
            retryable: r.retryable !== false,
            globalFailure: r.globalFailure === true,
        };
    }
    _applyUrl(r.url, log);
    // The helper hands back every address it could find for this GPU (the configured tunnel and
    // Lightning's own direct port). Poll them all — whichever comes alive first wins.
    const candidates = [r.url, ...(Array.isArray(r.altUrls) ? r.altUrls : [])];
    const wait = await _waitModel(log, candidates);
    if (wait.ready) {
        if (wait.url && wait.url !== _v1(r.url)) {
            log('Primary address never answered — switched to the backup.');
            _applyUrl(wait.url, log);
        }
        return { ok: true, startedByApp: r.startedByApp === true, startMethod: r.startMethod || null };
    }
    if (r.startedByApp === true) {
        log(wait.sawAddress
            ? 'Model did not become ready; stopping the Studio to prevent billing.'
            : 'No address reached this GPU; stopping the Studio to prevent billing.');
        await _runPy('stop', { timeoutMs: 120000, onProgress: log, env });
    }
    // Nothing ever answered: the addresses are broken, not this account. Every other account
    // would fail identically, so mark it non-retryable and let the caller stop the rotation.
    if (!wait.sawAddress) {
        return {
            ok: false,
            reason: 'no reachable address for the GPU — the endpoint is unreachable, not the account',
            retryable: false,
            globalFailure: true,
        };
    }
    return { ok: false, reason: 'model not ready in time', retryable: true };
}

/**
 * Ensure a Lightning vision endpoint is up and answering. Rotates the account pool when one is
 * configured; otherwise uses the single .env account. Captures + repoints the tunnel URL.
 */
async function ensureReady({ onProgress } = {}) {
    const log = onProgress || (() => {});
    // Belt and braces: isConfigured() already requires VISION_BACKEND=lightning, and
    // vision-gpu only ever loads this module for that backend. Assert it here anyway,
    // because the cost of a caller reaching this function by another route is minutes of
    // a build spent booting a GPU nobody asked for — the exact failure of 2026-08-27,
    // where the brain was switched to Azure Managed and Lightning woke up regardless.
    // A start is expensive and billable; the guard belongs at the thing that spends.
    const backend = String(process.env.VISION_BACKEND || '').toLowerCase();
    if (backend !== 'lightning') {
        return {
            ok: false,
            retryable: false,
            reason: `Lightning is not the selected vision backend (VISION_BACKEND=${backend || 'unset'}) — refusing to start a Studio`,
        };
    }
    if (!isConfigured()) {
        return { ok: false, reason: 'Lightning not configured (need an account pool or LIGHTNING_API_KEY/USER_ID/STUDIO_NAME)' };
    }

    // ── Pooled rotation ──
    if (rotation.isEnabled()) {
        const tried = new Set();
        const failures = [];
        let acct = rotation.pickAccount();
        if (!acct) {
            // Nothing to hand out. Whether waiting could ever help is arithmetic, not a
            // guess: report it so the caller stops instead of retrying a pool that cannot
            // change. Retrying only ever pays off for the 45s env-error cooldown — the
            // 15-minute failure cooldown outlives the whole retry budget, and `exhausted`
            // outlives the build. See rotation.nextViableAt().
            const next = rotation.nextViableAt();
            const retryable = next.soonestMs !== null && next.soonestMs <= _poolWaitBudgetMs();
            return {
                ok: false,
                reason: `all Lightning accounts are exhausted or cooling down (${next.detail}`
                    + (next.soonestMs === null ? ', none recover this cycle)'
                        : `, soonest in ${Math.ceil(next.soonestMs / 1000)}s)`),
                retryable,
                retryAfterMs: retryable ? next.soonestMs : undefined,
            };
        }
        while (acct && !tried.has(acct.id)) {
            tried.add(acct.id);
            const st = rotation.status().find((s) => s.id === acct.id);
            log(`Account: ${acct.label || acct.id} (${st ? st.usedHours : 0}/${acct.monthlyBudgetHours}h used)`);
            const res = await _startWith(_accountEnv(acct), log);
            if (res.ok) {
                rotation.markHealthy(acct);
                if (res.startedByApp) {
                    rotation.beginSession(acct);
                    _activeSession = { account: acct, startedAt: Date.now() };
                } else {
                    _activeSession = null;
                }
                return {
                    ok: true,
                    account: acct.id,
                    alreadyReady: !res.startedByApp,
                    startedByApp: res.startedByApp,
                };
            }
            // A failure that is not the ACCOUNT's fault (no reachable address for the GPU) is
            // identical for every account in the pool. Rotating through the rest can only burn
            // more paid GPU minutes on a wall that will not move — stop here, and leave the
            // account's health record untouched so it isn't struck for someone else's problem.
            if (res.globalFailure === true) {
                log(`Not an account problem (${res.reason}) — stopping the rotation instead of burning the other accounts.`);
                return { ok: false, reason: res.reason, retryable: false };
            }
            log(`Account ${acct.label || acct.id} unavailable (${res.reason}) — rotating to next`);
            failures.push({
                account: acct.label || acct.id,
                reason: res.reason || 'start failed',
                retryable: res.retryable !== false,
            });
            rotation.markFailure(acct, res.reason);
            acct = rotation.pickAccount();
        }
        const uniqueReasons = [...new Set(failures.map((f) => f.reason).filter(Boolean))];
        return {
            ok: false,
            reason: uniqueReasons.length === 1
                ? uniqueReasons[0]
                : `No Lightning account could be started. ${uniqueReasons.join(' | ')}`,
            retryable: failures.some((f) => f.retryable),
        };
    }

    // ── Single-account (.env) fallback ──
    if (await isVisionReady()) { log('Lightning vision already ready ✓'); return { ok: true, alreadyReady: true }; }
    log('Starting Lightning Studio + vLLM…');
    const res = await _startWith(process.env, log);
    if (res.ok) {
        _activeSession = null;
        return {
            ok: true,
            alreadyReady: !res.startedByApp,
            startedByApp: res.startedByApp,
        };
    }
    return { ok: false, reason: res.reason, retryable: res.retryable !== false && res.globalFailure !== true };
}

/** Stop the active Studio (idempotent) and bill its usage back to the rotation manager. */
async function stop({ onProgress } = {}) {
    const log = onProgress || (() => {});
    if (!isConfigured()) return { ok: false, reason: 'not configured' };
    let env = process.env;
    if (_activeSession) {
        const seconds = Math.round((Date.now() - _activeSession.startedAt) / 1000);
        try { rotation.endSession(_activeSession.account, seconds); } catch (_) {}
        env = _accountEnv(_activeSession.account);
        log(`Billing ${Math.round(seconds / 60)}m to ${_activeSession.account.label || _activeSession.account.id}`);
    }
    const r = await _runPy('stop', { timeoutMs: 120000, env });
    _activeSession = null;
    if (r.ok) log('Lightning Studio stopping ✓ (billing stops)');
    return r.ok ? { ok: true } : { ok: false, reason: r.error };
}

/** Combined status for the UI (matches vision-box.status shape). */
async function status() {
    const ready = await isVisionReady();
    let state = 'unknown';
    if (isConfigured()) {
        const st = await getInstanceState();
        if (st.ok) state = st.state;
    }
    return { configured: isConfigured(), ready, instanceState: state, pool: rotation.isEnabled() ? rotation.status() : null };
}

module.exports = {
    isConfigured, isVisionReady, getInstanceState, status, ensureReady, stop,
    // Exported so the verify harness can prove a dead hostname is reported as unreachable
    // while a live-but-not-serving one is not.
    probeEndpoint: _probe,
};
