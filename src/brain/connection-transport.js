// src/brain/connection-transport.js
// ============================================================================
// The ONE network path for every AI Connection (see connections.js): the
// OpenAI-compatible chat API that vLLM, SGLang, TGI, Azure AI Foundry,
// OpenRouter, Meta's Model API, Ollama and LM Studio all speak.
//
//   chatText(conn, {...})     → { text, usage, finish, model }
//   chatVision(conn, {...})   → same, with one or more images attached
//   listModels(conn)          → model ids the server offers (if it says)
//   testConnection(conn)      → plain-English step results for the UI
//
// Every server family speaks a slightly different DIALECT of the same API —
// GPT-5-style deployments refuse `max_tokens` and any temperature but 1, some
// gateways refuse `temperature` outright. Rather than guess from the model name
// (the trap this codebase already fell into twice), the transport LEARNS: a 400
// that names the offending parameter is retried once with the other spelling,
// and the answer is remembered for that connection for the rest of the process.
// ============================================================================
'use strict';

const http = require('http');
const https = require('https');

// connection id -> { tokenParam, temperature } learned from the server itself
const _learned = new Map();
// connection id -> { active, queue } — per-connection concurrency limit
const _slots = new Map();

// Keep-alive: a build sends thousands of requests to the same server.
const _agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
};

const TRANSIENT_CODES = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET)$/;

function _dialect(conn) {
    const learned = _learned.get(conn.id) || {};
    const tokenParam = conn.tokenParam && conn.tokenParam !== 'auto'
        ? conn.tokenParam
        : (learned.tokenParam || 'max_tokens');
    const temperature = conn.temperature && conn.temperature !== 'auto'
        ? conn.temperature
        : (learned.temperature || 'send');
    return { tokenParam, temperature };
}

function _learn(conn, patch) {
    _learned.set(conn.id, { ...(_learned.get(conn.id) || {}), ...patch });
}

function forgetDialect(connId) {
    if (connId) _learned.delete(connId);
    else _learned.clear();
}

function learnedDialect(connId) {
    return { ...(_learned.get(connId) || {}) };
}

async function _acquire(conn) {
    const limit = Math.max(1, Number(conn.maxConcurrency) || 8);
    let slot = _slots.get(conn.id);
    if (!slot) { slot = { active: 0, queue: [] }; _slots.set(conn.id, slot); }
    if (slot.active < limit) { slot.active++; return () => _release(conn.id); }
    await new Promise((resolve) => slot.queue.push(resolve));
    slot.active++;
    return () => _release(conn.id);
}

function _release(connId) {
    const slot = _slots.get(connId);
    if (!slot) return;
    slot.active = Math.max(0, slot.active - 1);
    const next = slot.queue.shift();
    if (next) next();
}

function _headers(conn) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const key = String(conn.apiKey || '').trim();
    if (key && conn.auth === 'api-key') headers['api-key'] = key;
    else if (key && conn.auth !== 'none') headers.Authorization = `Bearer ${key}`;
    return headers;
}

/** One HTTP request, JSON in and out. Rejects with .status / .body / .code like axios. */
function _request(method, url, { headers, body, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(url); } catch (_) {
            reject(Object.assign(new Error(`not a valid address: ${url}`), { code: 'EBADURL' }));
            return;
        }
        const lib = target.protocol === 'https:' ? https : http;
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = lib.request(target, {
            method,
            agent: _agents[target.protocol],
            headers: payload ? { ...headers, 'Content-Length': payload.length } : headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, data, text, headers: res.headers });
                    return;
                }
                const detail = data?.error?.message || data?.message || data?.detail || text.slice(0, 300);
                const err = new Error(`HTTP ${res.statusCode}: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}`);
                err.status = res.statusCode;
                err.body = text.slice(0, 2000);
                err.headers = res.headers;
                err.response = { status: res.statusCode, data: data ?? text };
                reject(err);
            });
        });
        req.setTimeout(Math.max(1000, timeoutMs || 120_000), () => {
            req.destroy(Object.assign(new Error(`timed out after ${Math.round((timeoutMs || 120_000) / 1000)}s`), { code: 'ETIMEDOUT' }));
        });
        req.on('error', (error) => reject(error));
        if (payload) req.write(payload);
        req.end();
    });
}

function _retryAfterMs(err) {
    const raw = err?.headers?.['retry-after'];
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

async function _withRetries(label, fn, { retries = 4, capMs = 60_000, log = () => {} } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const code = String(err?.code || err?.cause?.code || '');
            const transport = TRANSIENT_CODES.test(code);
            const status = err?.status;
            const retryable = transport || status === 429 || status === 502 || status === 503 || status === 504 || status === 529;
            if (!retryable || attempt >= retries) throw err;
            const waitMs = Math.min(capMs, _retryAfterMs(err) || 1500 * Math.pow(2, attempt));
            log(`  [${label}] ${transport ? `network ${code}` : `HTTP ${status}`} — waiting ${(waitMs / 1000).toFixed(1)}s (retry ${attempt + 1}/${retries})`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
}

// Reasoning models served by vLLM/SGLang often put their private reasoning in a
// leading <think>…</think> block of the visible answer. The app's parsers expect
// the answer alone.
function stripThinking(text) {
    return String(text || '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim();
}

function _contentText(choice) {
    const content = choice?.message?.content ?? choice?.text ?? '';
    const raw = Array.isArray(content)
        ? content.map((part) => (typeof part === 'string' ? part : (part?.text || part?.content || ''))).join('\n')
        : String(content || '');
    return stripThinking(raw);
}

function _body(conn, model, messages, { maxTokens, temperature }) {
    const { tokenParam, temperature: tempMode } = _dialect(conn);
    const body = { model, messages, stream: false };
    body[tokenParam] = Math.max(1, Number(maxTokens) || 800);
    if (temperature !== undefined && tempMode === 'send') body.temperature = temperature;
    return body;
}

/**
 * Send one chat request, learning the server's dialect from its own 400s.
 * At most one correction per parameter per call, so a server that refuses
 * both spellings still fails fast with its real message.
 */
async function _chat(conn, model, messages, opts) {
    const url = `${conn.baseUrl}/chat/completions`;
    const headers = _headers(conn);
    const timeoutMs = opts.timeoutMs || conn.timeoutMs || 180_000;
    const label = `AI:${conn.label}`;
    const corrected = new Set();
    for (;;) {
        const body = _body(conn, model, messages, opts);
        try {
            return await _withRetries(label, () => _request('POST', url, { headers, body, timeoutMs }), {
                log: opts.log || (() => {}),
                retries: Number.isInteger(opts.retries) ? opts.retries : 4,
            });
        } catch (err) {
            const text = String(err?.body || err?.message || '').toLowerCase();
            if (err?.status === 400 || err?.status === 422) {
                const { tokenParam, temperature } = _dialect(conn);
                if (!corrected.has('tokens') && conn.tokenParam !== 'max_tokens' && conn.tokenParam !== 'max_completion_tokens'
                    && text.includes('max_tokens') && (text.includes('max_completion_tokens') || text.includes('unsupported') || text.includes('not supported'))) {
                    corrected.add('tokens');
                    _learn(conn, { tokenParam: tokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens' });
                    continue;
                }
                if (!corrected.has('temperature') && conn.temperature !== 'send' && body.temperature !== undefined
                    && text.includes('temperature')) {
                    corrected.add('temperature');
                    _learn(conn, { temperature: temperature === 'send' ? 'omit' : 'send' });
                    continue;
                }
            }
            throw err;
        }
    }
}

function _record(opts, conn, model, kind, usage) {
    if (typeof opts.recordUsage !== 'function') return;
    try {
        opts.recordUsage({ provider: `conn:${conn.id}`, model, taskType: kind === 'vision' ? 'vision' : (opts.taskType || 'general'), kind, usage: usage || {} });
    } catch (_) { /* accounting must never break a call */ }
}

async function chatText(conn, opts = {}) {
    const model = opts.model || conn.textModel || conn.visionModel;
    if (!model) throw new Error(`AI connection "${conn.label}" has no model name`);
    const messages = [];
    if (opts.systemPrompt) messages.push({ role: 'system', content: String(opts.systemPrompt) });
    messages.push({ role: 'user', content: String(opts.prompt || '') });
    const release = await _acquire(conn);
    const started = Date.now();
    try {
        const resp = await _chat(conn, model, messages, opts);
        const choice = resp.data?.choices?.[0] || {};
        const text = _contentText(choice);
        const usage = resp.data?.usage || {};
        const finish = choice?.finish_reason || 'unknown';
        _record(opts, conn, model, 'text', usage);
        if (opts.log) opts.log(`  [AI:${conn.label}] ${model} task=${opts.taskType || '?'} ${((Date.now() - started) / 1000).toFixed(1)}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${finish}`);
        return { text, usage, finish, model, hadReasoning: !!choice?.message?.reasoning_content };
    } finally {
        release();
    }
}

async function chatVision(conn, opts = {}) {
    const model = opts.model || conn.visionModel || (conn.canSee ? conn.textModel : '');
    if (!model) throw new Error(`AI connection "${conn.label}" has no model that can see`);
    const images = Array.isArray(opts.images) ? opts.images.filter((image) => image && image.base64) : [];
    if (!images.length) throw new Error('no image to look at');
    const content = [{ type: 'text', text: String(opts.prompt || '') }];
    for (const image of images) {
        content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}` } });
    }
    const release = await _acquire(conn);
    const started = Date.now();
    try {
        const resp = await _chat(conn, model, [{ role: 'user', content }], { ...opts, temperature: undefined });
        const choice = resp.data?.choices?.[0] || {};
        const text = _contentText(choice);
        const usage = resp.data?.usage || {};
        const finish = choice?.finish_reason || 'unknown';
        _record(opts, conn, model, 'vision', usage);
        if (opts.log) opts.log(`  [AI:${conn.label}] ${model} vision x${images.length} ${((Date.now() - started) / 1000).toFixed(1)}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${finish}`);
        return { text, usage, finish, model };
    } finally {
        release();
    }
}

async function listModels(conn, { timeoutMs = 15_000 } = {}) {
    const resp = await _request('GET', `${conn.baseUrl}/models`, { headers: _headers(conn), timeoutMs });
    const list = Array.isArray(resp.data?.data) ? resp.data.data : (Array.isArray(resp.data?.models) ? resp.data.models : []);
    return list.map((entry) => String(entry?.id || entry?.name || entry || '')).filter(Boolean);
}

// A 16x16 solid red PNG — small enough for any server, unambiguous for any
// model that can actually see.
const RED_SQUARE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8BAEmAaVTCqYFQBAgAfAAH/6IzWEQAAAABJRU5ErkJggg==';

function _explain(err) {
    const status = err?.status;
    const code = String(err?.code || '');
    if (code === 'EBADURL') return 'the address is not a valid web address';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'nothing answers at that address (check it, or the server is switched off)';
    if (code === 'ECONNREFUSED') return 'the server refused the connection (is it running, and is the port right?)';
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return 'the server did not answer in time (it may still be starting — try again in a minute)';
    if (status === 401 || status === 403) return 'the key was refused';
    if (status === 404) return 'the address answers, but not with this API — check it ends in /v1, and check the model name';
    if (status === 429) return 'the server is busy or out of quota';
    if (status >= 500) return `the server had an internal error (HTTP ${status})`;
    return String(err?.message || err).slice(0, 200);
}

/**
 * Check a connection end to end, the way the app will use it. Every step says
 * in plain words what happened; nothing here throws.
 */
async function testConnection(conn, { timeoutMs = 60_000 } = {}) {
    const steps = [];
    const result = { ok: false, steps, models: [], canSee: null, reasoning: false, dialect: null };
    const step = async (name, fn) => {
        const started = Date.now();
        try {
            const detail = await fn();
            steps.push({ name, ok: true, detail, ms: Date.now() - started });
            return true;
        } catch (err) {
            steps.push({ name, ok: false, detail: _explain(err), ms: Date.now() - started });
            return false;
        }
    };

    await step('Reach the server', async () => {
        const models = await listModels(conn, { timeoutMs: Math.min(20_000, timeoutMs) });
        result.models = models;
        const wanted = [conn.textModel, conn.visionModel].filter(Boolean);
        const missing = wanted.filter((model) => models.length && !models.includes(model));
        if (missing.length) {
            return `answered, but it does not list "${missing.join('", "')}" — it offers: ${models.slice(0, 8).join(', ')}`;
        }
        return models.length ? `answered — offers ${models.slice(0, 5).join(', ')}${models.length > 5 ? '…' : ''}` : 'answered';
    }).catch(() => false);
    // Some servers do not implement /models; the chat test below is what counts.
    if (!steps[0].ok && /answers, but not with this API/.test(steps[0].detail)) steps[0].detail = 'this server does not list its models (that is fine)';

    const textOk = conn.textModel || !conn.visionModel
        ? await step('Write text', async () => {
            const reply = await chatText(conn, { prompt: 'Reply with exactly the word: READY', maxTokens: 400, temperature: 0.2, timeoutMs, retries: 0 });
            result.reasoning = !!reply.hadReasoning;
            if (!reply.text) return 'answered, but with an empty reply (a "thinking" model may need more room — it still works)';
            return /ready/i.test(reply.text) ? `replied "${reply.text.slice(0, 40)}"` : `replied, but not as asked: "${reply.text.slice(0, 60)}"`;
        })
        : true;

    const visionModel = conn.visionModel || conn.textModel;
    await step('See a picture', async () => {
        const reply = await chatVision({ ...conn, canSee: true }, {
            model: visionModel,
            prompt: 'What single colour fills this image? Answer with one word.',
            images: [{ base64: RED_SQUARE_PNG, mimeType: 'image/png' }],
            maxTokens: 300,
            timeoutMs,
            retries: 0,
        });
        result.canSee = /red/i.test(reply.text);
        return result.canSee ? `saw it correctly ("${reply.text.slice(0, 30)}")` : `answered "${reply.text.slice(0, 40)}" — it may not really see images`;
    }).then((seen) => { if (!seen) result.canSee = false; });

    result.dialect = learnedDialect(conn.id);
    // Usable = it writes (when it has a text model) and, when a separate model
    // was named for seeing, that one really sees.
    const seeStep = steps.find((entry) => entry.name === 'See a picture');
    result.ok = !!textOk && (conn.visionModel ? !!(seeStep && seeStep.ok && result.canSee) : true);
    return result;
}

module.exports = {
    RED_SQUARE_PNG,
    chatText,
    chatVision,
    forgetDialect,
    learnedDialect,
    listModels,
    stripThinking,
    testConnection,
};
