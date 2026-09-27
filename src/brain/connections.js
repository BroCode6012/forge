// src/brain/connections.js
// ============================================================================
// AI Connections — the one place that says WHERE an AI lives and WHICH JOB it
// does. Replaces "hand-wire a provider into five files" with data:
//
//   connection  = address + key + model name(s), on any server that speaks the
//                 OpenAI-compatible chat API (vLLM / SGLang / TGI on Modal,
//                 DigitalOcean, AWS, Google Cloud, Oracle, RunPod; Azure AI
//                 Foundry; OpenRouter; Meta Model API; Ollama / LM Studio …)
//   job         = thinking | everyday | eyes — each points at a connection, or
//                 at "built-in" (the app's existing AI Provider setup, unchanged)
//
// Pure data + lookups. No Electron, no network, no disk: main.js owns storage
// (keys encrypted at rest) and hands the resolved setup in with setRuntime();
// a build child receives the same object through FORGE_AI_CONNECTIONS.
// The transport lives in connection-transport.js; ai-provider.js asks this
// module "who serves this task?" and nothing else.
// ============================================================================
'use strict';

// Which of the app's text task types each job owns. Every task the text router
// knows must land in exactly one job (the verify gate enforces it).
const JOBS = Object.freeze({
    thinking: Object.freeze({
        id: 'thinking',
        label: 'Thinking',
        hint: 'Story, scene split, what to show, graphics design — the calls where quality shows in the video.',
        tasks: Object.freeze([
            'brain', 'planner-outline', 'planner-large', 'planner-small',
            'planner-source-audit', 'review', 'motion-graphics', 'template',
        ]),
    }),
    everyday: Object.freeze({
        id: 'everyday',
        label: 'Everyday',
        hint: 'Small text jobs: keywords, classifying, ranking, short checks. High volume, simple.',
        tasks: Object.freeze(['utility', 'general', 'classifier']),
    }),
    eyes: Object.freeze({
        id: 'eyes',
        label: 'Eyes',
        hint: 'Looking at pictures and video frames: footage checks, preview grids, framing. Needs a model that can see.',
        tasks: Object.freeze([]),
        vision: true,
    }),
});

const BUILT_IN = 'builtin';

// Ready-made starting points. A preset only pre-fills fields; the person still
// pastes their own address, key and model name. `auth` is how the key travels.
const PRESETS = Object.freeze([
    {
        id: 'modal-vllm',
        label: 'Modal (your deployed model)',
        baseUrl: 'https://<workspace>--<app>-serve.modal.run/v1',
        auth: 'bearer',
        needsKey: true,
        note: 'The URL Modal prints after "modal deploy", ending in /v1. The key is the --api-key you gave vLLM.',
    },
    {
        id: 'digitalocean-vllm',
        label: 'DigitalOcean GPU Droplet (vLLM)',
        baseUrl: 'http://<droplet-ip>:8000/v1',
        auth: 'bearer',
        needsKey: true,
        note: 'The Droplet\'s public IP, port 8000, ending in /v1. The key is the --api-key you gave vLLM.',
    },
    {
        id: 'cloud-vm-vllm',
        label: 'Any GPU server — AWS, Google Cloud, Oracle, RunPod… (vLLM / SGLang / TGI)',
        baseUrl: 'http://<server-address>:8000/v1',
        auth: 'bearer',
        needsKey: true,
        note: 'Any server started with vLLM, SGLang or TGI speaks this language. Address ending in /v1.',
    },
    {
        id: 'azure-foundry',
        label: 'Azure AI Foundry',
        baseUrl: 'https://<resource>.services.ai.azure.com/openai/v1',
        auth: 'api-key',
        needsKey: true,
        note: 'The model name is your DEPLOYMENT name exactly as the portal shows it.',
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        auth: 'bearer',
        needsKey: true,
        note: 'Model names look like "meta/muse-spark-1.3" or "qwen/qwen3-vl-30b-a3b-instruct".',
    },
    {
        id: 'meta-model-api',
        label: 'Meta Model API (Muse Spark)',
        baseUrl: 'https://api.meta.ai/v1',
        auth: 'bearer',
        needsKey: true,
        note: 'Key from dev.meta.ai. Model e.g. "muse-spark-1.3-contributor" (cheapest).',
    },
    {
        id: 'ollama-local',
        label: 'A model on this PC (Ollama)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        auth: 'none',
        needsKey: false,
        note: 'Free, but only small models run at a useful speed on most PCs.',
    },
    {
        id: 'custom',
        label: 'Other (any OpenAI-compatible address)',
        baseUrl: '',
        auth: 'bearer',
        needsKey: false,
        note: 'Anything that answers POST <address>/chat/completions.',
    },
]);

const AUTH_MODES = Object.freeze(['bearer', 'api-key', 'none']);
const TOKEN_PARAMS = Object.freeze(['auto', 'max_tokens', 'max_completion_tokens']);
const TEMPERATURE_MODES = Object.freeze(['auto', 'send', 'omit']);

function presetById(id) {
    return PRESETS.find((preset) => preset.id === id) || null;
}

/**
 * Clean an address the way people paste it: surrounding spaces, a trailing
 * slash, or the full ".../chat/completions" copied from a docs example.
 */
function normalizeBaseUrl(value) {
    let url = String(value || '').trim();
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/chat\/completions$/i, '');
    url = url.replace(/\/+$/, '');
    return url;
}

function _slug(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function makeConnectionId(label, existingIds = []) {
    const base = _slug(label) || 'connection';
    const taken = new Set(existingIds);
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }
    return `${base}-${Date.now().toString(36)}`;
}

/**
 * Plain-English problems with a connection, empty when it is usable.
 * `requireKey` is false when validating a saved connection whose key is kept
 * encrypted elsewhere.
 */
function validateConnection(conn, { requireKey = true } = {}) {
    const problems = [];
    if (!conn || typeof conn !== 'object') return ['the connection is empty'];
    if (!String(conn.label || '').trim()) problems.push('give it a name');
    const url = normalizeBaseUrl(conn.baseUrl);
    if (!url) problems.push('the address is missing');
    else if (/[<>]/.test(url)) problems.push('replace the <placeholders> in the address with your own values');
    else if (!/^https?:\/\/[^\s/]+/i.test(url)) problems.push('the address must start with http:// or https://');
    if (!String(conn.textModel || '').trim() && !String(conn.visionModel || '').trim()) {
        problems.push('the model name is missing');
    }
    if (conn.auth && !AUTH_MODES.includes(conn.auth)) problems.push(`unknown key type "${conn.auth}"`);
    if (requireKey && conn.auth !== 'none' && conn.needsKey && !String(conn.apiKey || '').trim()) {
        problems.push('the key is missing');
    }
    return problems;
}

// ── runtime (the resolved setup, keys included) ─────────────────────────────
let _runtime = null;
let _runtimeFromEnv = null;
let _runtimeEnvRaw = null;

function _emptyRuntime() {
    return { connections: [], jobs: { thinking: {}, everyday: {}, eyes: {} } };
}

function _sanitizeRuntime(raw) {
    const out = _emptyRuntime();
    if (!raw || typeof raw !== 'object') return out;
    for (const conn of Array.isArray(raw.connections) ? raw.connections : []) {
        if (!conn || !conn.id) continue;
        out.connections.push({
            id: String(conn.id),
            label: String(conn.label || conn.id),
            preset: String(conn.preset || 'custom'),
            baseUrl: normalizeBaseUrl(conn.baseUrl),
            auth: AUTH_MODES.includes(conn.auth) ? conn.auth : 'bearer',
            apiKey: String(conn.apiKey || ''),
            textModel: String(conn.textModel || '').trim(),
            visionModel: String(conn.visionModel || '').trim(),
            canSee: conn.canSee === true,
            reasoning: conn.reasoning === true,
            tokenParam: TOKEN_PARAMS.includes(conn.tokenParam) ? conn.tokenParam : 'auto',
            temperature: TEMPERATURE_MODES.includes(conn.temperature) ? conn.temperature : 'auto',
            maxConcurrency: Math.max(1, Math.min(64, Number(conn.maxConcurrency) || 8)),
            timeoutMs: Math.max(10_000, Math.min(900_000, Number(conn.timeoutMs) || 0)) || 0,
        });
    }
    const ids = new Set(out.connections.map((c) => c.id));
    const jobs = raw.jobs && typeof raw.jobs === 'object' ? raw.jobs : {};
    for (const jobId of Object.keys(JOBS)) {
        const job = jobs[jobId] || {};
        const pick = (value) => (value === BUILT_IN || ids.has(value) ? value : '');
        out.jobs[jobId] = { primary: pick(job.primary), backup: pick(job.backup) };
    }
    return out;
}

/** main.js calls this at start-up and after every save. */
function setRuntime(raw) {
    _runtime = raw ? _sanitizeRuntime(raw) : null;
}

/** Everyone else reads the current setup through this. */
function getRuntime() {
    if (_runtime) return _runtime;
    // A build child: the parent passed the resolved setup through the env.
    const raw = process.env.FORGE_AI_CONNECTIONS;
    if (!raw) return _emptyRuntime();
    if (raw !== _runtimeEnvRaw) {
        _runtimeEnvRaw = raw;
        try { _runtimeFromEnv = _sanitizeRuntime(JSON.parse(raw)); } catch (_) { _runtimeFromEnv = _emptyRuntime(); }
    }
    return _runtimeFromEnv;
}

function getConnection(id) {
    return getRuntime().connections.find((conn) => conn.id === id) || null;
}

function jobForTask(task) {
    const id = String(task || '').toLowerCase();
    for (const job of Object.values(JOBS)) {
        if (job.tasks.includes(id)) return job.id;
    }
    return 'everyday';
}

/**
 * Who serves a job right now.
 *   null                         → the job uses the built-in setup (today's behaviour)
 *   { connections, builtInBackup } → try these connections in order, then the
 *                                    built-in setup only if builtInBackup
 * A job whose primary names a connection that no longer exists falls back to
 * built-in rather than to nothing.
 */
function routeForJob(jobId) {
    const job = getRuntime().jobs[jobId] || {};
    const primary = job.primary && job.primary !== BUILT_IN ? getConnection(job.primary) : null;
    if (!primary) return null;
    const connections = [primary];
    let builtInBackup = false;
    if (job.backup === BUILT_IN) builtInBackup = true;
    else if (job.backup && job.backup !== primary.id) {
        const backup = getConnection(job.backup);
        if (backup) connections.push(backup);
    }
    const needsEyes = !!JOBS[jobId]?.vision;
    const usable = needsEyes ? connections.filter((conn) => !!modelFor(conn, 'vision')) : connections;
    // A job pointed only at connections that cannot do it (no model that sees,
    // for Eyes) must not end up with nobody serving it.
    if (!usable.length) return null;
    return { job: jobId, connections: usable, builtInBackup };
}

/** The model name a connection uses for a kind of call. */
function modelFor(conn, kind) {
    if (!conn) return '';
    if (kind === 'vision') return conn.visionModel || (conn.canSee ? conn.textModel : '') || '';
    return conn.textModel || conn.visionModel || '';
}

function describeRuntime() {
    const rt = getRuntime();
    const name = (id) => (id === BUILT_IN ? 'built-in setup' : (getConnection(id)?.label || 'built-in setup'));
    return Object.keys(JOBS).map((jobId) => {
        const job = rt.jobs[jobId] || {};
        const primary = job.primary ? name(job.primary) : 'built-in setup';
        const backup = job.backup ? ` (backup: ${name(job.backup)})` : '';
        return `${JOBS[jobId].label}: ${primary}${backup}`;
    }).join(' · ');
}

module.exports = {
    AUTH_MODES,
    BUILT_IN,
    JOBS,
    PRESETS,
    TEMPERATURE_MODES,
    TOKEN_PARAMS,
    describeRuntime,
    getConnection,
    getRuntime,
    jobForTask,
    makeConnectionId,
    modelFor,
    normalizeBaseUrl,
    presetById,
    routeForJob,
    setRuntime,
    validateConnection,
};
