// src/settings/ai-connections-store.js
// ============================================================================
// Where AI Connections are kept: <userData>/ai-connections.json.
//
// Keys never sit in that file in the clear when the OS can protect them: main.js
// injects Electron's safeStorage (DPAPI on Windows) as `crypto`, and the file
// holds only the encrypted blob. The renderer never receives a key back — only
// "has a key: yes/no". The resolved setup (keys decrypted) goes to exactly two
// places: the main process's own AI calls (connections.setRuntime) and the build
// child's environment for that one build.
//
// No Electron import here, so the verify gate can drive it with a fake crypto.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const {
    BUILT_IN,
    JOBS,
    PRESETS,
    AUTH_MODES,
    TOKEN_PARAMS,
    TEMPERATURE_MODES,
    makeConnectionId,
    normalizeBaseUrl,
    presetById,
    validateConnection,
} = require('../brain/connections');

const FILE_NAME = 'ai-connections.json';
const FILE_VERSION = 1;

const PLAIN_CRYPTO = Object.freeze({
    available: () => false,
    encrypt: (text) => Buffer.from(String(text), 'utf8').toString('base64'),
    decrypt: (data) => Buffer.from(String(data), 'base64').toString('utf8'),
});

function _emptyState() {
    return { version: FILE_VERSION, connections: [], jobs: { thinking: {}, everyday: {}, eyes: {} } };
}

function _clean(conn) {
    return {
        id: String(conn.id),
        label: String(conn.label || '').trim().slice(0, 80),
        preset: presetById(conn.preset) ? conn.preset : 'custom',
        baseUrl: normalizeBaseUrl(conn.baseUrl).slice(0, 500),
        auth: AUTH_MODES.includes(conn.auth) ? conn.auth : 'bearer',
        textModel: String(conn.textModel || '').trim().slice(0, 200),
        visionModel: String(conn.visionModel || '').trim().slice(0, 200),
        canSee: conn.canSee === true,
        reasoning: conn.reasoning === true,
        tokenParam: TOKEN_PARAMS.includes(conn.tokenParam) ? conn.tokenParam : 'auto',
        temperature: TEMPERATURE_MODES.includes(conn.temperature) ? conn.temperature : 'auto',
        maxConcurrency: Math.max(1, Math.min(64, Number(conn.maxConcurrency) || 8)),
        timeoutMs: Number(conn.timeoutMs) > 0 ? Math.max(10_000, Math.min(900_000, Number(conn.timeoutMs))) : 0,
        key: conn.key && typeof conn.key === 'object' && typeof conn.key.data === 'string'
            ? { enc: conn.key.enc === 'safe' ? 'safe' : 'plain', data: conn.key.data }
            : null,
        lastTest: conn.lastTest && typeof conn.lastTest === 'object' ? conn.lastTest : null,
    };
}

function createAiConnectionsStore({ userDataDir, crypto = PLAIN_CRYPTO } = {}) {
    if (!userDataDir) throw new Error('createAiConnectionsStore needs userDataDir');
    const filePath = path.join(userDataDir, FILE_NAME);
    const cipher = crypto || PLAIN_CRYPTO;

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const state = _emptyState();
            for (const conn of Array.isArray(parsed.connections) ? parsed.connections : []) {
                if (conn && conn.id) state.connections.push(_clean(conn));
            }
            const ids = new Set(state.connections.map((c) => c.id));
            for (const jobId of Object.keys(JOBS)) {
                const job = parsed.jobs?.[jobId] || {};
                const pick = (value) => (value === BUILT_IN || ids.has(value) ? value : '');
                state.jobs[jobId] = { primary: pick(job.primary), backup: pick(job.backup) };
            }
            return state;
        } catch (_) {
            return _emptyState();
        }
    }

    function _write(state) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temp, filePath);
    }

    function _encryptKey(text) {
        const value = String(text || '').trim();
        if (!value) return null;
        if (cipher.available()) return { enc: 'safe', data: cipher.encrypt(value) };
        return { enc: 'plain', data: PLAIN_CRYPTO.encrypt(value) };
    }

    function _decryptKey(key) {
        if (!key || !key.data) return '';
        try {
            return key.enc === 'safe' ? cipher.decrypt(key.data) : PLAIN_CRYPTO.decrypt(key.data);
        } catch (_) {
            return '';
        }
    }

    /** What the UI may see: everything except the key itself. */
    function publicView() {
        const state = load();
        return {
            connections: state.connections.map(({ key, ...rest }) => ({
                ...rest,
                hasKey: !!(key && key.data),
                keyProtection: key ? (key.enc === 'safe' ? 'encrypted' : 'not encrypted') : 'none',
            })),
            jobs: state.jobs,
            meta: {
                builtIn: BUILT_IN,
                jobs: Object.values(JOBS).map((job) => ({ id: job.id, label: job.label, hint: job.hint, vision: !!job.vision })),
                presets: PRESETS,
                encryption: cipher.available(),
            },
        };
    }

    /**
     * Add or update a connection from the form. An empty key field keeps the key
     * already stored; `clearKey` removes it.
     */
    function saveConnection(input = {}) {
        const state = load();
        const existing = input.id ? state.connections.find((c) => c.id === input.id) : null;
        const preset = presetById(input.preset) || presetById('custom');
        const draft = {
            ...(existing || {}),
            label: input.label,
            preset: preset.id,
            baseUrl: input.baseUrl,
            auth: AUTH_MODES.includes(input.auth) ? input.auth : (existing?.auth || preset.auth),
            textModel: input.textModel,
            visionModel: input.visionModel,
            maxConcurrency: input.maxConcurrency ?? existing?.maxConcurrency,
            timeoutMs: input.timeoutMs ?? existing?.timeoutMs,
            tokenParam: input.tokenParam ?? existing?.tokenParam,
            temperature: input.temperature ?? existing?.temperature,
        };
        const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
        const willHaveKey = input.clearKey ? false : (!!newKey || !!existing?.key);
        const problems = validateConnection({ ...draft, apiKey: willHaveKey ? 'x' : '', needsKey: preset.needsKey }, { requireKey: true });
        if (problems.length) return { ok: false, problems };

        const id = existing?.id || makeConnectionId(draft.label, state.connections.map((c) => c.id));
        const cleaned = _clean({ ...draft, id, key: existing?.key || null });
        if (input.clearKey) cleaned.key = null;
        else if (newKey) cleaned.key = _encryptKey(newKey);
        // A changed address or model invalidates what the last test learned.
        if (existing && (existing.baseUrl !== cleaned.baseUrl || existing.textModel !== cleaned.textModel || existing.visionModel !== cleaned.visionModel)) {
            cleaned.lastTest = null;
            cleaned.canSee = false;
            cleaned.reasoning = false;
        }
        if (existing) state.connections[state.connections.indexOf(existing)] = cleaned;
        else state.connections.push(cleaned);
        _write(state);
        return { ok: true, id };
    }

    function deleteConnection(id) {
        const state = load();
        const before = state.connections.length;
        state.connections = state.connections.filter((c) => c.id !== id);
        if (state.connections.length === before) return { ok: false, problems: ['no such connection'] };
        for (const job of Object.values(state.jobs)) {
            if (job.primary === id) job.primary = '';
            if (job.backup === id) job.backup = '';
        }
        _write(state);
        return { ok: true };
    }

    function setJobs(jobs = {}) {
        const state = load();
        const ids = new Set(state.connections.map((c) => c.id));
        const problems = [];
        for (const jobId of Object.keys(JOBS)) {
            if (!jobs[jobId]) continue;
            const next = { ...state.jobs[jobId] };
            for (const slot of ['primary', 'backup']) {
                if (!(slot in jobs[jobId])) continue;
                const value = String(jobs[jobId][slot] || '');
                if (value && value !== BUILT_IN && !ids.has(value)) {
                    problems.push(`${JOBS[jobId].label}: no connection "${value}"`);
                    continue;
                }
                next[slot] = value;
            }
            if (JOBS[jobId].vision && next.primary && next.primary !== BUILT_IN) {
                const conn = state.connections.find((c) => c.id === next.primary);
                if (conn && !conn.visionModel && !conn.canSee) {
                    problems.push(`${JOBS[jobId].label}: "${conn.label}" has no model that can see — add a vision model, or run Test to confirm it sees`);
                    continue;
                }
            }
            state.jobs[jobId] = next;
        }
        if (problems.length) return { ok: false, problems };
        _write(state);
        return { ok: true };
    }

    function recordTest(id, result) {
        const state = load();
        const conn = state.connections.find((c) => c.id === id);
        if (!conn) return;
        conn.lastTest = {
            at: new Date().toISOString(),
            ok: !!result.ok,
            steps: (result.steps || []).map((step) => ({ name: step.name, ok: !!step.ok, detail: String(step.detail || '').slice(0, 300), ms: step.ms })),
        };
        if (result.canSee === true) conn.canSee = true;
        if (result.canSee === false && !conn.visionModel) conn.canSee = false;
        if (result.reasoning === true) conn.reasoning = true;
        if (result.dialect?.tokenParam && conn.tokenParam === 'auto') conn.tokenParam = result.dialect.tokenParam;
        if (result.dialect?.temperature && conn.temperature === 'auto') conn.temperature = result.dialect.temperature;
        _write(state);
    }

    /** The full setup with keys decrypted — only for AI calls, never for the UI. */
    function resolved() {
        const state = load();
        return {
            connections: state.connections.map(({ key, lastTest, ...rest }) => ({ ...rest, apiKey: _decryptKey(key) })),
            jobs: state.jobs,
        };
    }

    /**
     * A connection for the Test button: the form's values, with the stored key
     * when the form's key field was left empty.
     */
    function draftForTest(input = {}) {
        const state = load();
        const existing = input.id ? state.connections.find((c) => c.id === input.id) : null;
        const preset = presetById(input.preset) || presetById(existing?.preset) || presetById('custom');
        const draft = {
            id: existing?.id || `test-${Date.now().toString(36)}`,
            label: String(input.label || existing?.label || 'test'),
            baseUrl: normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl),
            auth: AUTH_MODES.includes(input.auth) ? input.auth : (existing?.auth || preset.auth),
            textModel: String(input.textModel ?? existing?.textModel ?? '').trim(),
            visionModel: String(input.visionModel ?? existing?.visionModel ?? '').trim(),
            apiKey: String(input.apiKey || '').trim() || _decryptKey(existing?.key),
            tokenParam: existing?.tokenParam || 'auto',
            temperature: existing?.temperature || 'auto',
            maxConcurrency: 2,
            timeoutMs: 0,
        };
        const problems = validateConnection({ ...draft, needsKey: preset.needsKey }, { requireKey: true });
        return { conn: draft, problems, existingId: existing?.id || null };
    }

    return { filePath, load, publicView, saveConnection, deleteConnection, setJobs, recordTest, resolved, draftForTest };
}

module.exports = { createAiConnectionsStore, FILE_NAME, PLAIN_CRYPTO };
