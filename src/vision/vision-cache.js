// Per-URL vision/deep-clip cache. Makes scoring deterministic across re-runs:
// the first run scores via AI; subsequent runs of the same URL+segment reuse
// the saved verdict. Eliminates the "same scene succeeds once, fails once"
// inconsistency that comes from Qwen-VL / deep-clip temperature noise.
//
// Storage: one JSON file at config.paths.temp/media-vision-cache.json
// Schema: { items: { [key]: { kind, score, description, issues?, motion?, raw?, savedAt } } }
// Key:    `${kind}::${normalizedUrl}#${Math.round(startTime||0)}s`  (kind = "vision" | "deep")
// TTL:    14 days (cap stale entries from drifting forever; tunable via env)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../settings/config');
const { normalizeUrlForDedup } = require('../util/url-utils');

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TTL_MS = Math.max(
    60 * 60 * 1000, // 1h floor
    parseInt(process.env.VISION_CACHE_TTL_MS || '', 10) || DEFAULT_TTL_MS
);
// Bumped 2026-08-04 alongside the move from the self-hosted Qwen2.5-VL-7B box to Claude
// on Bedrock. The key encodes the URL and the scope but NOT which model produced the
// verdict, so without a bump a stale entry from the old judge is served as though the new
// judge had scored it — silently mixing two rubrics. Bump whenever the scoring model
// changes. (Folding the model into the key would end this by construction, but the key
// shape is deliberately frozen; see the refactor rule in scripts/verify/README.md.)
//
// v4, same day: the v3 entries are NOT from the judge v3 was bumped for. The configured
// primary (us.anthropic.claude-sonnet-5) turned out to be un-entitled on this account and
// 403'd on every call, so the chain fell through and bedrock-qwen-vl scored everything.
// Measured on 9 labelled real frames, that stand-in kept 0 of 3 clips a human would use
// (scripts/vision-judge-bench.js). Every v3 verdict is therefore a verdict from a judge we
// have now proven rejects good footage; serving them would make the fix look like it did
// nothing. Discard them. Measured cost of this bump on the live cache at the time: zero —
// the only file on disk still held 31 v2-era entries, already unreachable since the v3
// bump. The bump is insurance against v3 entries on any other project dir or machine.
const CACHE_VERSION = String(process.env.VISION_CACHE_VERSION || 'vision-v4-2026-08-04');

let _loaded = false;
let _items = new Map();
let _dirty = false;
let _disabled = String(process.env.VISION_CACHE || 'on').toLowerCase() === 'off';

function _cacheFile() {
    return path.join(config.paths?.temp || process.cwd(), 'media-vision-cache.json');
}

function _load() {
    if (_loaded) return;
    _loaded = true;
    if (_disabled) return;
    try {
        const file = _cacheFile();
        if (!fs.existsSync(file)) return;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const obj = parsed && parsed.items ? parsed.items : {};
        const now = Date.now();
        for (const [key, val] of Object.entries(obj)) {
            if (!val || typeof val !== 'object') continue;
            const at = Number(val.savedAt || 0);
            if (at && now - at > TTL_MS) continue;
            _items.set(key, val);
        }
    } catch (_) {}
}

function _save() {
    if (_disabled || !_dirty) return;
    try {
        const file = _cacheFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const obj = {};
        for (const [k, v] of _items.entries()) obj[k] = v;
        fs.writeFileSync(file, JSON.stringify({ items: obj }, null, 2));
        _dirty = false;
    } catch (_) {}
}

function _scopeHash(scope) {
    if (!scope) return '';
    const raw = typeof scope === 'string' ? scope : JSON.stringify(scope);
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

function makeScope(parts = {}) {
    return _scopeHash({ cacheVersion: CACHE_VERSION, ...parts });
}

function _makeKey(kind, url, startTime, scope) {
    const norm = normalizeUrlForDedup(String(url || '')) || String(url || '').trim();
    if (!norm) return null;
    const t = Math.round(Math.max(0, Number(startTime) || 0));
    const scopePart = scope ? `::${_scopeHash(scope)}` : '';
    return `${CACHE_VERSION}::${kind}::${norm}#${t}s${scopePart}`;
}

function get(kind, url, startTime, scope) {
    if (_disabled) return null;
    _load();
    const key = _makeKey(kind, url, startTime, scope);
    if (!key) return null;
    const v = _items.get(key);
    if (!v) return null;
    const at = Number(v.savedAt || 0);
    if (at && Date.now() - at > TTL_MS) {
        _items.delete(key);
        _dirty = true;
        return null;
    }
    return v;
}

function set(kind, url, startTime, value, scope) {
    if (_disabled) return;
    _load();
    const key = _makeKey(kind, url, startTime, scope);
    if (!key || !value || typeof value !== 'object') return;
    _items.set(key, { ...value, kind, cacheVersion: CACHE_VERSION, savedAt: Date.now() });
    _dirty = true;
    // Lazy autosave — writes batched, but flush on every set is cheap enough
    // for the volumes involved (a few hundred entries per build) and ensures
    // the next process can read them even if this one is killed.
    _save();
}

function invalidate(url, startTime) {
    if (_disabled) return;
    _load();
    let removed = 0;
    for (const kind of ['vision', 'deep']) {
        const prefix = `${CACHE_VERSION}::${kind}::`;
        const exactKey = _makeKey(kind, url, startTime);
        if (exactKey && _items.delete(exactKey)) removed++;
        for (const key of Array.from(_items.keys())) {
            if (!key.startsWith(prefix)) continue;
            if (key.includes(`${normalizeUrlForDedup(String(url || '')) || String(url || '').trim()}#${Math.round(Math.max(0, Number(startTime) || 0))}s`)) {
                if (_items.delete(key)) removed++;
            }
        }
    }
    if (removed) {
        _dirty = true;
        _save();
    }
    return removed;
}

function clearAll() {
    _items = new Map();
    _dirty = true;
    _save();
}

function isEnabled() {
    return !_disabled;
}

function setEnabled(enabled) {
    _disabled = !enabled;
}

module.exports = {
    get,
    set,
    invalidate,
    clearAll,
    isEnabled,
    setEnabled,
    makeScope,
};
