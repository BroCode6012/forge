/**
 * lightning-rotation.js — rotate across multiple Lightning.ai accounts to pool their free
 * monthly GPU credit. Lightning exposes NO reliable credit-balance API here, so
 * exhaustion is detected by a hybrid: (a) proactive usage accounting against a per-account
 * GPU-hour budget, and (b) reactive failure handling (a start failure cools the account down,
 * repeated failures exhaust it). The monthly credit refresh is MANUAL — the user clicks
 * "Reset monthly credit" per account in the UI (resetCycle), since Lightning's reset day
 * varies and can't be queried.
 *
 * Pool config: lightning-accounts.json (gitignored, holds creds). Live state:
 * .lightning-rotation-state.json (gitignored). If lightning-accounts.json is absent, rotation
 * is DISABLED and lightning-box falls back to the single-account .env config (legacy behavior).
 *
 * Policy = STICKY: keep using the most-recently-used viable account until it's exhausted, then
 * advance (switching accounts = a different Studio = fresh 6.5GB model download + cold start).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// The account pool is GLOBAL to the app (shared across all projects), so always resolve to the
// app root (src/..) — NOT process.env.PROJECT_DIR, which points at the currently-open project
// and would scatter the pool into each project folder.
function _root() { return path.join(__dirname, '..', '..'); }
function _accountsFile() { return path.join(_root(), 'lightning-accounts.json'); }
function _stateFile() { return path.join(_root(), '.lightning-rotation-state.json'); }

const FAIL_COOLDOWN_MS = Number(process.env.LIGHTNING_FAIL_COOLDOWN_MS || 15 * 60 * 1000); // 15 min
const FAIL_STRIKES = Number(process.env.LIGHTNING_FAIL_STRIKES || 3); // failures → exhaust for cycle
const DEFAULT_BUDGET_HOURS = Number(process.env.LIGHTNING_DEFAULT_BUDGET_HOURS || 18);

function _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function _writeJson(file, obj) {
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return true; } catch (_) { return false; }
}

/** Rotation is enabled only when a pool file exists. */
function isEnabled() {
    return fs.existsSync(_accountsFile());
}

function _rawAccounts() {
    const arr = _readJson(_accountsFile(), []);
    return Array.isArray(arr) ? arr : [];
}

/** Valid accounts from the pool (must have creds + studio identity). */
function loadAccounts() {
    return _rawAccounts()
        .filter((a) => a && a.id && a.apiKey && a.userId && a.studioName)
        .map((a) => ({ ...a, monthlyBudgetHours: Number(a.monthlyBudgetHours || DEFAULT_BUDGET_HOURS) }));
}

let _state = null;
function _loadState() { _state = _readJson(_stateFile(), {}); return _state; }
function _saveState() { if (_state) _writeJson(_stateFile(), _state); }
function _s(id) {
    const st = _loadState();
    if (!st[id]) {
        st[id] = { usedSeconds: 0, exhausted: false, healthy: true, failCount: 0, cooldownUntil: 0, lastUsedAt: null, lastError: null };
    }
    return st[id];
}

function _budgetSeconds(acct) { return Math.max(0, Number(acct.monthlyBudgetHours || DEFAULT_BUDGET_HOURS)) * 3600; }

function _viable(acct) {
    const s = _s(acct.id);
    if (!s.healthy) return false;
    if (s.exhausted) return false;
    if (Date.now() < (s.cooldownUntil || 0)) return false;
    if ((s.usedSeconds || 0) >= _budgetSeconds(acct)) { s.exhausted = true; _saveState(); return false; }
    return true;
}

/** Manual override: pin builds to one account (null/'' = automatic rotation). Stored in state. */
function _meta() { const st = _loadState(); if (!st.__meta) st.__meta = {}; return st.__meta; }
function getForcedAccount() { return _meta().forcedAccountId || null; }
function setForcedAccount(id) { _meta().forcedAccountId = id || null; _saveState(); return { ok: true, id: id || null }; }

/**
 * Pick the account for this build. If a specific account is pinned (manual override) and it's
 * viable, use it; otherwise fall through to STICKY auto-rotation (most-recently-used viable).
 */
function pickAccount() {
    const accounts = loadAccounts();
    if (!accounts.length) return null;
    const forced = getForcedAccount();
    if (forced) {
        const f = accounts.find((a) => a.id === forced);
        if (f && _viable(f)) return f; // pinned + usable → honor it
        // pinned but exhausted/cooling → fall through to rotation so the build still runs
    }
    const st = _loadState();
    const ordered = [...accounts].sort((a, b) => String(st[b.id]?.lastUsedAt || '').localeCompare(String(st[a.id]?.lastUsedAt || '')));
    for (const a of ordered) if (_viable(a)) return a;
    return null; // all exhausted / cooling down
}

function beginSession(acct) {
    const s = _s(acct.id);
    s.lastUsedAt = new Date().toISOString();
    _saveState();
}

/** Record billed GPU time (Studio start→stop seconds) against the account's budget. */
function endSession(acct, seconds) {
    const s = _s(acct.id);
    const secs = Math.max(0, Math.round(Number(seconds) || 0));
    s.usedSeconds = (s.usedSeconds || 0) + secs;
    if (s.usedSeconds >= _budgetSeconds(acct)) s.exhausted = true;
    _saveState();
}

// Local-environment failures (interpreter/SDK/config missing) are NOT the account's fault and
// hit EVERY account identically — counting them as strikes would exhaust the whole pool over a
// bug that a one-line env fix resolves (exactly the "spawn python ENOENT" state we found). Treat
// them as a brief cool-down (enough to advance rotation within one ensureReady pass) with NO
// strike and NO exhaustion, so accounts self-heal the moment the environment is fixed.
const _ENV_ERR_RE = /ENOENT|spawn\b|not recognized|no such file|MODULE_NOT_FOUND|command not found|cannot find module|python/i;
const ENV_ERR_COOLDOWN_MS = Number(process.env.LIGHTNING_ENV_ERR_COOLDOWN_MS || 45 * 1000);

/** A start/boot failure: cool the account down; after N strikes, exhaust it for the cycle. */
function markFailure(acct, reason) {
    const s = _s(acct.id);
    const r = String(reason || 'start failed');
    if (_ENV_ERR_RE.test(r)) {
        s.cooldownUntil = Date.now() + ENV_ERR_COOLDOWN_MS; // brief — forces rotation to advance
        s.lastError = r;
        _saveState();
        return; // no strike, no exhaustion — environment problem, not an account problem
    }
    s.failCount = (s.failCount || 0) + 1;
    s.cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
    s.lastError = r;
    if (s.failCount >= FAIL_STRIKES) s.exhausted = true;
    _saveState();
}

/** Clear the failure streak after a clean start. */
function markHealthy(acct) {
    const s = _s(acct.id);
    s.failCount = 0;
    s.cooldownUntil = 0;
    s.healthy = true;
    s.lastError = null;
    _saveState();
}

/** Hard-disable an account (bad creds etc.). */
function markExhausted(acct, reason) {
    const s = _s(acct.id);
    s.exhausted = true;
    s.lastError = reason || 'exhausted';
    _saveState();
}

/** MANUAL monthly reset (the "Reset monthly credit" button): wipe usage + exhaustion. */
function resetCycle(id) {
    const st = _loadState();
    st[id] = { usedSeconds: 0, exhausted: false, healthy: true, failCount: 0, cooldownUntil: 0, lastUsedAt: st[id]?.lastUsedAt || null, lastError: null };
    _saveState();
    return { ok: true, id };
}

// ── Pool editing (used by the no-code UI) ─────────────────────────────────────────────
function _slugId(label) {
    const base = String(label || 'acct').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'acct';
    const ids = new Set(_rawAccounts().map((a) => a.id));
    if (!ids.has(base)) return base;
    let i = 2; while (ids.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
}

/** Add an account to the pool. Returns { ok, id } or { ok:false, error }. */
function addAccount(input) {
    const a = input || {};
    const required = ['userId', 'apiKey', 'studioName'];
    for (const k of required) {
        if (!String(a[k] || '').trim()) return { ok: false, error: `missing required field: ${k}` };
    }
    const accounts = _rawAccounts();
    const id = String(a.id || '').trim() || _slugId(a.label || a.studioName);
    if (accounts.some((x) => x.id === id)) return { ok: false, error: `id already exists: ${id}` };
    accounts.push({
        id,
        label: String(a.label || a.studioName).trim(),
        userId: String(a.userId).trim(),
        apiKey: String(a.apiKey).trim(),
        studioName: String(a.studioName).trim(),
        teamspace: String(a.teamspace || '').trim(),
        user: String(a.user || '').trim(),
        machine: String(a.machine || 'T4').trim(),
        monthlyBudgetHours: Number(a.monthlyBudgetHours) > 0 ? Number(a.monthlyBudgetHours) : DEFAULT_BUDGET_HOURS,
    });
    if (!_writeJson(_accountsFile(), accounts)) return { ok: false, error: 'could not write lightning-accounts.json' };
    return { ok: true, id };
}

/** Edit fields on an existing account (e.g. budget). Returns { ok } or { ok:false, error }. */
function updateAccount(id, patch) {
    const accounts = _rawAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: 'account not found: ' + id };
    const p = patch || {};
    for (const k of ['label', 'userId', 'apiKey', 'studioName', 'teamspace', 'user', 'machine']) {
        if (typeof p[k] === 'string' && p[k].trim()) accounts[idx][k] = p[k].trim();
    }
    if (p.monthlyBudgetHours !== undefined && Number(p.monthlyBudgetHours) > 0) {
        accounts[idx].monthlyBudgetHours = Number(p.monthlyBudgetHours);
    }
    if (!_writeJson(_accountsFile(), accounts)) return { ok: false, error: 'could not write lightning-accounts.json' };
    return { ok: true };
}

/** Remove an account from the pool (and its state). */
function removeAccount(id) {
    const accounts = _rawAccounts().filter((a) => a.id !== id);
    if (!_writeJson(_accountsFile(), accounts)) return { ok: false, error: 'could not write pool file' };
    const st = _loadState();
    if (st[id]) { delete st[id]; _saveState(); }
    return { ok: true };
}

/** Human-readable status of the pool (for logs). */
function status() {
    return loadAccounts().map((a) => {
        const s = _s(a.id);
        return {
            id: a.id,
            label: a.label || a.id,
            usedHours: +(((s.usedSeconds || 0) / 3600).toFixed(2)),
            budgetHours: a.monthlyBudgetHours,
            exhausted: !!s.exhausted,
            healthy: s.healthy !== false,
            coolingDown: Date.now() < (s.cooldownUntil || 0),
        };
    });
}

/** Full pool details for the UI (apiKey masked — never leak the full key to the renderer). */
function poolDetails() {
    return loadAccounts().map((a) => {
        const s = _s(a.id);
        const used = (s.usedSeconds || 0) / 3600;
        return {
            id: a.id,
            label: a.label || a.id,
            studioName: a.studioName,
            teamspace: a.teamspace || '',
            user: a.user || '',
            machine: a.machine || 'T4',
            apiKeyMasked: '••••' + String(a.apiKey).slice(-4),
            usedHours: +used.toFixed(2),
            budgetHours: a.monthlyBudgetHours,
            remainingHours: +Math.max(0, a.monthlyBudgetHours - used).toFixed(2),
            exhausted: !!s.exhausted,
            healthy: s.healthy !== false,
            coolingDown: Date.now() < (s.cooldownUntil || 0),
            lastError: s.lastError || null,
        };
    });
}

module.exports = {
    isEnabled, loadAccounts, pickAccount,
    beginSession, endSession, markFailure, markHealthy, markExhausted,
    resetCycle, addAccount, updateAccount, removeAccount, status, poolDetails,
    getForcedAccount, setForcedAccount,
};
