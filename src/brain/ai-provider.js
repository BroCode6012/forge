/**
 * Shared AI Provider Module
 *
 * Single calling layer for ALL AI interactions across the pipeline.
 * Every module imports from here instead of maintaining its own provider copies.
 *
 * Exports:
 *   callAI(prompt, options)       — text-only AI call
 *   callVisionAI(prompt, base64Image, mimeType, options) — vision AI call
 *   callVideoAI(prompt, frames, options) — multi-frame vision/deepvision call
 *
 * Options: { maxTokens, temperature, systemPrompt, taskType }
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const config = require('../settings/config');
const { recordUsage } = require('./cost-tracker');
// AI Connections — data-driven "where does each job's AI live" (see connections.js).
// Consulted first by the text router and the vision chain; a job left on
// "built-in" routes exactly as it did before connections existed.
const aiConnections = require('./connections');
const connectionTransport = require('./connection-transport');
// nvidia-client require REMOVED in 2026-05-25 cleanup.

const _qwenEnvPath = process.env.YTA_USER_ENV_PATH || path.join(__dirname, '..', '..', '.env');
const _qwenGeneratedPoolsPath = process.env.QWEN_MODEL_REGISTRY_PATH || path.join(__dirname, '..', 'qwen-vision-generated-pools.json');
let _qwenEnvLastReadAt = 0;
let _qwenEnvSignature = '';

function _parseEnvList(raw) {
    return String(raw || '')
        .split(/[,\n;]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function _parseSimpleEnv(content) {
    const out = {};
    for (const line of String(content || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

function _refreshQwenRuntimeConfig(opts = {}) {
    const refreshMs = Math.max(1000, parseInt(process.env.QWEN_KEY_REFRESH_MS || '5000', 10) || 5000);
    const now = Date.now();
    if (!opts.force && now - _qwenEnvLastReadAt < refreshMs) return false;
    _qwenEnvLastReadAt = now;

    try {
        const fs = require('fs');
        if (!fs.existsSync(_qwenEnvPath)) return false;
        const parsed = _parseSimpleEnv(fs.readFileSync(_qwenEnvPath, 'utf8'));
        const hasParsedImagePrimary = Object.prototype.hasOwnProperty.call(parsed, 'QWEN_IMAGE_API_KEY');
        const hasParsedImageLane = hasParsedImagePrimary || Object.prototype.hasOwnProperty.call(parsed, 'QWEN_VL_API_KEY');
        const hasParsedOmniLane = Object.prototype.hasOwnProperty.call(parsed, 'QWEN_OMNI_API_KEY');
        // Lightning's backend selector intentionally replaces hosted-Qwen key pools with
        // one logical self-hosted credential. Do not let the five-second .env hot-reload
        // restore old DashScope image/omni keys and turn one T4 endpoint back into several
        // fake lanes. Other backends keep the normal live-key refresh behavior.
        const lightningOwnsVisionKeys = String(process.env.VISION_BACKEND || '').toLowerCase() === 'lightning';
        const nextSharedKeys = _parseEnvList(lightningOwnsVisionKeys
            ? (process.env.QWEN_VISION_API_KEY || '')
            : (parsed.QWEN_VISION_API_KEY || process.env.QWEN_VISION_API_KEY || ''));
        const nextImageKeys = _parseEnvList(lightningOwnsVisionKeys
            ? (process.env.QWEN_IMAGE_API_KEY || process.env.QWEN_VL_API_KEY || process.env.QWEN_VISION_API_KEY || '')
            : (hasParsedImageLane
                ? (hasParsedImagePrimary ? (parsed.QWEN_IMAGE_API_KEY || '') : (parsed.QWEN_VL_API_KEY || ''))
                : (process.env.QWEN_IMAGE_API_KEY || process.env.QWEN_VL_API_KEY || '')));
        const nextOmniKeys = _parseEnvList(lightningOwnsVisionKeys
            ? (process.env.QWEN_OMNI_API_KEY || process.env.QWEN_VISION_API_KEY || '')
            : (hasParsedOmniLane
                ? (parsed.QWEN_OMNI_API_KEY || '')
                : (process.env.QWEN_OMNI_API_KEY || '')));
        const effectiveImageKeys = (hasParsedImageLane || nextImageKeys.length) ? nextImageKeys : nextSharedKeys;
        const effectiveOmniKeys = (hasParsedOmniLane || nextOmniKeys.length) ? nextOmniKeys : nextSharedKeys;
        // process.env wins over the raw .env file for the base URL + model: the VISION_BACKEND
        // selector (config.resolveVisionBackend) sets process.env authoritatively at runtime
        // (e.g. Lightning's live tunnel URL, captured mid-build). The .env file's QWEN_BASE_URL
        // is the AWS-box baseline and is intentionally NOT rewritten on backend switch — so if
        // the file took precedence here, this refresh would keep clobbering the live Lightning/
        // DashScope endpoint back to the (possibly OFF) AWS box. For VISION_BACKEND=aws the two
        // are identical, so this only changes behavior for the overriding backends (correctly).
        const nextBaseUrl = process.env.QWEN_BASE_URL || parsed.QWEN_BASE_URL || config.qwen?.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
        const nextVisionModel = process.env.QWEN_VISION_MODEL || parsed.QWEN_VISION_MODEL || config.qwen?.visionModel || 'qwen3-vl-plus';
        const signature = JSON.stringify({ sharedKeys: nextSharedKeys, imageKeys: effectiveImageKeys, omniKeys: effectiveOmniKeys, baseUrl: nextBaseUrl, visionModel: nextVisionModel });
        if (signature === _qwenEnvSignature) return false;

        const previousCount = (config.qwen?.imageApiKeys || config.qwen?.visionApiKeys || []).length + (config.qwen?.omniApiKeys || config.qwen?.visionApiKeys || []).length;
        _qwenEnvSignature = signature;
        if (config.qwen) {
            config.qwen.visionApiKeys = nextSharedKeys;
            config.qwen.imageApiKeys = effectiveImageKeys;
            config.qwen.omniApiKeys = effectiveOmniKeys;
            config.qwen.baseUrl = nextBaseUrl;
            config.qwen.visionModel = nextVisionModel;
        }
        process.env.QWEN_VISION_API_KEY = nextSharedKeys.join(',');
        process.env.QWEN_IMAGE_API_KEY = effectiveImageKeys.join(',');
        process.env.QWEN_OMNI_API_KEY = effectiveOmniKeys.join(',');
        process.env.QWEN_BASE_URL = nextBaseUrl;
        process.env.QWEN_VISION_MODEL = nextVisionModel;
        const nextCount = effectiveImageKeys.length + effectiveOmniKeys.length;
        if (previousCount !== nextCount || opts.force) {
            console.log(`  🔄 [Qwen Keys] refreshed from .env: image=${effectiveImageKeys.length}, omni=${effectiveOmniKeys.length}, shared=${nextSharedKeys.length}, model=${nextVisionModel}`);
        }
        return true;
    } catch (e) {
        console.log(`  ⚠️ [Qwen Keys] .env refresh failed: ${e.message}`);
        return false;
    }
}

// ============================================================
// AI THINKING MODE — set by build pipeline, used by _geminiText, _deepseekText
// ============================================================
// Budget map: thinking level → token budget for Gemini 2.5 models
const THINKING_BUDGET_MAP = { high: 16384, medium: 8192, low: 4096 };
let _thinkingMode = 'off'; // 'off', 'low', 'medium', 'high'

/**
 * Set the AI thinking mode for all subsequent AI calls in this process.
 * Called from build-video.js with the user's dropdown selection.
 * Affects: Gemini (thinkingConfig budget), DeepSeek (reasoning_effort).
 */
function setAIThinking(mode) {
    _thinkingMode = THINKING_BUDGET_MAP[mode] ? mode : 'off';
    if (_thinkingMode !== 'off') {
        console.log(`  🧠 AI Thinking mode: ${_thinkingMode}`);
    }
}

// Keep backward compat alias
const setGeminiThinking = setAIThinking;

function _getThinkingConfig() {
    if (_thinkingMode === 'off') return null;
    const budget = THINKING_BUDGET_MAP[_thinkingMode];
    if (!budget) return null;
    return { thinkingBudget: budget };
}

function getAIThinking() {
    return {
        mode: _thinkingMode,
        budget: _thinkingMode === 'off' ? 0 : (THINKING_BUDGET_MAP[_thinkingMode] || 0),
    };
}

/**
 * Strip <think>...</think> tags from Qwen/DeepSeek thinking responses.
 * These models wrap chain-of-thought in <think> blocks before the actual answer.
 */
function _stripThinkingTags(text) {
    if (!text) return '';
    // Remove all <think>...</think> blocks (can be multiline)
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function _readOpenAIStream(readable, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
        let text = '';
        let buffer = '';
        let settled = false;
        let timer = null;
        let finishReason = '';

        const settle = (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (err) reject(err);
            else {
                if (finishReason === 'length') {
                    console.log('  ⚠️ [Qwen Text] Stream stopped at max_tokens; response may be incomplete');
                }
                resolve(text);
            }
        };

        const processLine = (line) => {
            const trimmed = String(line || '').trim();
            if (!trimmed || !trimmed.startsWith('data:')) return;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            try {
                const json = JSON.parse(payload);
                const choice = json.choices?.[0] || {};
                const delta = choice.delta || choice.message || {};
                text += delta.content || '';
                finishReason = choice.finish_reason || finishReason;
            } catch (_) {
                // Ignore partial/malformed SSE lines; the next chunk may complete them.
            }
        };

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                const err = new Error('stream timeout');
                err.code = 'ECONNABORTED';
                try { readable.destroy(err); } catch (_) {}
                settle(err);
            }, timeoutMs);
        }

        readable.setEncoding?.('utf8');
        readable.on('data', (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                processLine(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
            }
        });
        readable.on('end', () => {
            if (buffer.trim()) processLine(buffer);
            settle(null);
        });
        readable.on('error', settle);
    });
}

// ============================================================
// QWEN MODEL ROTATION — rotate through free-quota models on 403/429
// ============================================================

/**
 * Model pool for Qwen still-image scoring and Omni/multi-frame video scoring.
 * All models use the same API key and DashScope endpoint — just swap model name.
 * On quota exhaustion (403) → mark model exhausted → try next in pool.
 * Pools are ordered by quality (best first).
 */
function _dedupeModels(models) {
    return [...new Set((models || []).map(m => String(m || '').trim()).filter(Boolean))];
}

const QWEN_VL_POOL = _dedupeModels([
    // Tier 1: largest dedicated VL/QVQ models.
    'qwen3-vl-235b-a22b-instruct',      // Qwen3-VL 235B non-thinking instruct
    'qwen3-vl-235b-a22b-thinking',
    // qvq-max needs stream:true on the OpenAI-compatible endpoint.
    'qvq-max',
    // Tier 2: Qwen3-VL Plus (newer gen, large mid).
    'qwen3-vl-plus',                    // Qwen3-VL plus alias
    'qwen3-vl-plus-2025-12-19',         // latest plus
    'qwen3-vl-plus-2025-09-23',         // earlier plus
    // Tier 3: Qwen2.5-VL commercial aliases.
    'qwen-vl-max',
    'qwen-vl-plus',
    // Tier 4: mid/small open Qwen3-VL.
    'qwen3-vl-30b-a3b-instruct',        // non-thinking instruct
    'qwen3-vl-30b-a3b-thinking',
    'qwen3-vl-8b-instruct',
    'qwen3-vl-8b-thinking',
    // Tier 5: Qwen3-VL Flash (fast, smaller).
    'qwen3-vl-flash',                   // flash alias
    'qwen3-vl-flash-2026-01-22',
    'qwen3-vl-flash-2025-10-15',
    // OCR is image-capable; keep late so general scoring prefers full VL models.
    'qwen-vl-ocr',
    'qwen-vl-ocr-2025-11-20',
]);
// REMOVED 2026-06-01 — RETIRED FROM ALIBABA MODEL STUDIO. These no longer exist
// as servable models; the intl OpenAI-compat endpoint returns 403 access_denied
// for them (NOT a quota blip — the model is gone, confirmed in Model Studio).
// Keeping them in the pool made the rotation waste a 2-min cooldown cycle on
// each one every build. Do NOT re-add without re-confirming they're live:
//   qwen-vl-max-2025-08-13, qwen-vl-plus-2025-08-15, qwen-vl-plus-2025-01-25,
//   qwen2.5-vl-32b-instruct, qwen2.5-vl-72b-instruct, qwen-vl-plus-latest,
//   qwen-vl-plus-2025-05-07, qwen2.5-vl-7b-instruct, qwen2.5-vl-3b-instruct.
// The old default QWEN_VISION_MODEL=qwen-vl-max-latest is also retired → moved
// to qwen3-vl-plus in .env (both repo and project).

// Official DashScope vision docs list Qwen3.7/Qwen3.6/Qwen3.5 families as
// accepting image/video inputs. Keep these after dedicated VL models: they are
// useful free-quota scoring capacity, but the VL/QVQ models remain preferred.
// Do NOT add plain Qwen3, Qwen Plus/Max, Coder, MT, DeepSeek, GLM, or Wan
// entries here unless live-probed as image/video-capable.
const QWEN_357_VISION_POOL = _dedupeModels([
    // Qwen3.7 family. NOTE: the -max line is TEXT-ONLY — confirmed by live pixel-probe
    // (2026-06-16): qwen3.7-max / qwen3.7-max-preview REJECT image input (400), while
    // qwen3.7-plus reads pixels. Do NOT re-add -max here (it would hallucinate scores).
    'qwen3.7-plus',
    'qwen3.7-plus-2026-05-26',
    // Qwen3.6 family.
    'qwen3.6-35b-a3b',
    'qwen3.6-27b',
    'qwen3.6-plus',
    'qwen3.6-plus-2026-04-02',
    'qwen3.6-flash',
    'qwen3.6-flash-2026-04-16',
    // qwen3.6-max-preview REMOVED — text-only (live probe returned "NO IMAGE").
    // Qwen3.5 family.
    'qwen3.5-397b-a17b',
    'qwen3.5-122b-a10b',
    'qwen3.5-35b-a3b',
    'qwen3.5-27b',
    'qwen3.5-plus',
    'qwen3.5-plus-2026-04-20',
    'qwen3.5-plus-2026-02-15',
    'qwen3.5-flash',
    'qwen3.5-flash-2026-02-23',
]);

function _loadGeneratedQwenPools() {
    if (['0', 'false', 'off', 'no'].includes(String(process.env.QWEN_DYNAMIC_MODEL_POOLS || '1').toLowerCase())) {
        return { source: 'disabled' };
    }
    try {
        if (!fs.existsSync(_qwenGeneratedPoolsPath)) return { source: 'static' };
        const parsed = JSON.parse(fs.readFileSync(_qwenGeneratedPoolsPath, 'utf8'));
        const generatedAt = Date.parse(parsed.generatedAt || '');
        if (!Number.isFinite(generatedAt)) return { source: 'static-invalid' };

        const maxAgeHours = Math.max(1, Number(process.env.QWEN_MODEL_REGISTRY_MAX_AGE_HOURS || 168) || 168);
        const stale = Date.now() - generatedAt > maxAgeHours * 3600_000;
        const pools = parsed.pools || {};
        const image = _dedupeModels(Array.isArray(pools.image) ? pools.image : []);
        const omniHttp = _dedupeModels(Array.isArray(pools.omniHttp) ? pools.omniHttp : []);
        const omniRealtime = _dedupeModels(Array.isArray(pools.omniRealtime) ? pools.omniRealtime : []);
        if (!image.length && !omniHttp.length && !omniRealtime.length) return { source: 'static-empty' };

        return {
            source: stale ? 'generated-stale' : 'generated',
            generatedAt: parsed.generatedAt,
            catalogCount: parsed.catalogCount || 0,
            image,
            omniHttp,
            omniRealtime,
        };
    } catch (err) {
        console.log(`  ⚠️ [Qwen Registry] Ignoring generated pool file: ${err.message}`);
        return { source: 'static-error' };
    }
}

const QWEN_GENERATED_POOLS = _loadGeneratedQwenPools();

// Qwen text path REMOVED — Qwen is now vision-only. Text routing goes through
// NVIDIA / Bedrock / Gemini / etc. The legacy QWEN_TEXT_POOL and per-task
// profiles are gone; nothing dispatches to qwen text anymore.

// NVIDIA_TEXT_MODELS + NVIDIA_TEXT_TASK_PROFILES REMOVED in 2026-05-25 cleanup.

const _textRouteHealth = new Map();

// Qwen Omni has TWO transport families:
//   1) Batch HTTP/OpenAI-compatible chat-completions models: usable by callVideoAI().
//   2) Realtime WebSocket models: visible in Alibaba quota dashboard, but NOT usable
//      through the normal HTTP chat/completions path. These need a dedicated
//      WebSocket lane before we can safely use them.
//
// Keep the active runtime pool HTTP-only so a key with realtime quota does not
// waste scene time on models that answer "current user api does not support
// http/stream call".
const QWEN_STATIC_OMNI_HTTP_POOL = _dedupeModels([
    'qwen3.5-omni-plus',
    'qwen3.5-omni-plus-2026-03-15',
    'qwen3.5-omni-flash',
    'qwen3.5-omni-flash-2026-03-15',
    'qwen3-omni-flash',
    'qwen3-omni-flash-2025-09-15',
    'qwen-omni-turbo',
    'qwen2.5-omni-7b',
]);

const QWEN_STATIC_OMNI_REALTIME_POOL = _dedupeModels([
    'qwen3.5-omni-plus-realtime',
    'qwen3.5-omni-plus-realtime-2026-03-15',
    'qwen3.5-omni-flash-realtime',
    'qwen3.5-omni-flash-realtime-2026-03-15',
    'qwen3-omni-flash-realtime',
    'qwen3-omni-flash-realtime-2025-09-15',
    'qwen-omni-turbo-realtime',
    'qwen-omni-turbo-realtime-2025-05-08',
]);

const QWEN_OMNI_OPENAI_UNSUPPORTED_POOL = [
    // Shows in some quota dashboards, but current OpenAI-compatible endpoint
    // returns "Unsupported model" for batch HTTP calls.
    'qwen-omni-turbo-2025-03-26',
];

const QWEN_OMNI_HTTP_POOL = QWEN_GENERATED_POOLS.omniHttp?.length
    ? QWEN_GENERATED_POOLS.omniHttp
    : QWEN_STATIC_OMNI_HTTP_POOL;
const QWEN_OMNI_REALTIME_POOL = QWEN_GENERATED_POOLS.omniRealtime?.length
    ? QWEN_GENERATED_POOLS.omniRealtime
    : QWEN_STATIC_OMNI_REALTIME_POOL;
// Self-hosted vision override: when QWEN_IMAGE_MODELS / QWEN_OMNI_MODELS is set
// (comma/space separated), the pool is exactly those model name(s) instead of the
// built-in DashScope list. Use this to point the vision pool at a self-hosted
// OpenAI-compatible server (e.g. vLLM Qwen2.5-VL on a rented GPU) via QWEN_BASE_URL —
// the round-robin then only ever asks for the model your server actually serves, so it
// never 404s on a DashScope-only name and never hits DashScope's free-tier quota.
const _envModelList = (value) => String(value || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
const QWEN_IMAGE_POOL = _dedupeModels(
    _envModelList(process.env.QWEN_IMAGE_MODELS).length
        ? _envModelList(process.env.QWEN_IMAGE_MODELS)
        : [...(QWEN_GENERATED_POOLS.image?.length ? QWEN_GENERATED_POOLS.image : [...QWEN_VL_POOL, ...QWEN_357_VISION_POOL])]
);

const QWEN_OMNI_POOL = _dedupeModels(
    _envModelList(process.env.QWEN_OMNI_MODELS).length
        ? _envModelList(process.env.QWEN_OMNI_MODELS)
        : [...QWEN_OMNI_HTTP_POOL]
);

const QWEN_OMNI_LANE_COOLDOWN_MS = Math.max(
    30_000,
    Math.min(300_000, parseInt(process.env.QWEN_OMNI_LANE_COOLDOWN_MS || '120000', 10) || 120_000)
);
const QWEN_OMNI_TRANSIENT_LIMIT = Math.max(
    3,
    Math.min(18, parseInt(process.env.QWEN_OMNI_TRANSIENT_LIMIT || '9', 10) || 9)
);
const QWEN_OMNI_TRANSIENT_WINDOW_MS = Math.max(
    15_000,
    Math.min(120_000, parseInt(process.env.QWEN_OMNI_TRANSIENT_WINDOW_MS || '60000', 10) || 60_000)
);
// How many times to quick-retry a connection-reset (ECONNRESET/EPIPE) on the SAME
// vision endpoint before cooling the lane and falling back. Catches the parallel-flood
// resets seen against the self-hosted box. QWEN_VISION_NET_RETRIES=0 disables.
const QWEN_VISION_NET_RETRIES = Math.max(0, Math.min(4, parseInt(process.env.QWEN_VISION_NET_RETRIES || '2', 10) || 2));
// BACKPRESSURE, NOT DEATH.
//
// On a hosted multi-tenant API a 429 means "your quota is spent" — the right
// answer is to bench that model and go elsewhere. On OUR OWN box it means
// "the queue is full right now", and it clears in seconds. The Jul-29 build
// treated the second case like the first: 13 cooldowns of 30s each on the only
// model/key combo there is, so `_getBestKeyAndModel` returned null, the lane
// reported "temporarily unavailable" 31 times, and every one of those frames
// went to paid Bedrock instead of the GPU we were already renting.
//
// So on a self-hosted runtime a busy signal gets a longer wait ladder and a
// seconds-scale bench instead of a half-minute one. Hosted DashScope keeps the
// old behaviour exactly. QWEN_VISION_BUSY_RETRIES=0 disables the ladder.
const QWEN_VISION_BUSY_RETRIES = Math.max(0, Math.min(8, parseInt(process.env.QWEN_VISION_BUSY_RETRIES || '4', 10) || 4));
const QWEN_VISION_BUSY_BACKOFF_MS = [500, 1200, 2500, 4000, 6000, 8000, 10000, 12000];
// HTTP statuses a saturated inference server emits: 429 too-many-requests,
// 503 unavailable (vLLM sheds load), 529 overloaded.
const VISION_BACKPRESSURE_STATUSES = new Set([429, 503, 529]);
const QWEN_OMNI_HTTP_ENABLED = !['0', 'false', 'off', 'no'].includes(String(process.env.QWEN_OMNI_HTTP_ENABLED || '1').toLowerCase());
const QWEN_OMNI_REALTIME_ENABLED = !['0', 'false', 'off', 'no'].includes(String(process.env.QWEN_OMNI_REALTIME_ENABLED || '1').toLowerCase());
const QWEN_OMNI_REALTIME_TIMEOUT_MS = Math.max(
    10_000,
    Math.min(90_000, parseInt(process.env.QWEN_OMNI_REALTIME_TIMEOUT_MS || '45000', 10) || 45_000)
);
let _qwenOmniLaneCooldownUntil = 0;
let _qwenOmniTransientWindowStartedAt = 0;
let _qwenOmniTransientBurst = 0;

// Runtime-only transport skips. These are not quota exhaustion. They mean the
// selected API transport cannot call that model shape (for example realtime
// WebSocket models through HTTP chat/completions). Keep them in memory so a
// bad transport/model pair is skipped for the current process without poisoning
// the permanent per-key quota file.
const _qwenRuntimeUnsupportedModels = new Set();

function _qwenRuntimeUnsupportedKey(model, role = 'vision') {
    return `${role}:${model}`;
}

function _isQwenRuntimeUnsupported(model, role = 'vision') {
    return _qwenRuntimeUnsupportedModels.has(_qwenRuntimeUnsupportedKey(model, role));
}

function _markQwenRuntimeUnsupported(model, error, role = 'vision') {
    const key = _qwenRuntimeUnsupportedKey(model, role);
    if (_qwenRuntimeUnsupportedModels.has(key)) return;
    _qwenRuntimeUnsupportedModels.add(key);
    const msg = String(error?.response?.data?.error?.message || error?.response?.data?.message || error?.message || '').slice(0, 180);
    console.log(`  ⛔ [Qwen ${role}] ${model} skipped for this run — unsupported by current API transport${msg ? ` (${msg})` : ''}`);
}

// ============================================================
// ROLE-SCOPED PER-KEY EXHAUSTION TRACKING
// ============================================================
// Storage shape:
//   { text:   { keyHash: { modelName: true|timestamp } },
//     vision: { keyHash: { modelName: true|timestamp } } }
//
// Why split by role: the user can put the SAME physical key in both
// QWEN_API_KEY (text pool) and QWEN_VISION_API_KEY (vision pool). When that
// key burns out on vision-side, we must NOT mark it as text-side dead, and
// vice-versa. Each (role, key, model) is tracked independently. A vision
// burn never bleeds into text tracking and never fires the text-exhausted
// notification — and vice-versa.
//
// ⚠️ QWEN PER-KEY QUOTA RULE — DO NOT FORGET ⚠️
// When a model returns AllocationQuota.FreeTierOnly (or equivalent permanent
// exhaustion signal) on a SPECIFIC API key, that model is PERMANENTLY DEAD
// on that key — the free quota NEVER refreshes for that (key, model) pair.
// HOWEVER: each API key has its own INDEPENDENT free quota. The same model
// flagged dead on Key 1 may still be perfectly alive on Key 2.
// → NEVER propose a 24h / weekly / monthly cooldown for `permanent` flags.
// → NEVER demote a `true` (permanent) entry back to a timestamp.
// → To recover a model, the user must add a NEW key, not wait for refresh.
// (The 2-minute timestamp cooldown below is ONLY for transient 429/5xx — never quota.)
const _runtimeStateRoot = process.env.YTA_USER_DATA_DIR || path.join(__dirname, '..', '..');
const _exhaustedModelsFile = path.join(_runtimeStateRoot, '.qwen-exhausted-models.json');
// Two separate per-role maps. Default to empty; populated by loader below.
let _perKeyExhaustion = {
    text:   {}, // { keyHash: { modelName: true|timestamp } }
    image:  {}, // { keyHash: { modelName: true|timestamp } }
    omni:   {}, // { keyHash: { modelName: true|timestamp } }
    vision: {}, // legacy bucket, migrated on startup
};

function _hashApiKey(key) {
    if (!key) return '';
    return require('crypto').createHash('md5').update(key).digest('hex').substring(0, 12);
}

function _qwenKeyTail(key) {
    return String(key || '').replace(/\s+/g, '').slice(-6) || 'unknown';
}

// ============================================================
// QWEN LIVE HEALTH CACHE
// ============================================================
// This is the flexible truth layer: quota and support are tracked per
// (key, model, lane). The static pools say what can be tried; this file says
// what was actually verified for the user's current keys.
const _qwenHealthFile = path.join(
    process.env.YTA_USER_DATA_DIR || path.join(__dirname, '..', '..'),
    '.qwen-vision-health.json'
);
const QWEN_HEALTH_FRESH_MS = Math.max(
    60_000,
    Math.min(7 * 24 * 60 * 60 * 1000, parseInt(process.env.QWEN_HEALTH_FRESH_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000)
);
const QWEN_HEALTH_TRANSIENT_MS = Math.max(
    30_000,
    Math.min(30 * 60 * 1000, parseInt(process.env.QWEN_HEALTH_TRANSIENT_MS || String(5 * 60 * 1000), 10) || 5 * 60 * 1000)
);
let _qwenHealthCache = null;
let _qwenHealthLoadedAt = 0;

function _loadQwenHealth(force = false) {
    if (_qwenHealthCache && !force) return _qwenHealthCache;
    try {
        if (fs.existsSync(_qwenHealthFile)) {
            const parsed = JSON.parse(fs.readFileSync(_qwenHealthFile, 'utf8'));
            _qwenHealthCache = parsed && typeof parsed === 'object' ? parsed : {};
        } else {
            _qwenHealthCache = {};
        }
    } catch (_) {
        _qwenHealthCache = {};
    }
    if (!_qwenHealthCache.version) _qwenHealthCache.version = 1;
    if (!_qwenHealthCache.keys) _qwenHealthCache.keys = {};
    _qwenHealthLoadedAt = Date.now();
    return _qwenHealthCache;
}

function _saveQwenHealth() {
    try {
        const health = _loadQwenHealth();
        health.updatedAt = new Date().toISOString();
        health.endpoint = config.qwen?.baseUrl || '';
        fs.writeFileSync(_qwenHealthFile, JSON.stringify(health, null, 2));
    } catch (_) {
        // Health is advisory. Never fail a build because the cache could not be written.
    }
}

function _qwenLaneForModel(model) {
    if (QWEN_OMNI_REALTIME_POOL.includes(model)) return 'omniRealtime';
    return QWEN_OMNI_HTTP_POOL.includes(model) ? 'omniHttp' : 'image';
}

function _qwenRoleForLane(lane) {
    return lane === 'omniHttp' || lane === 'omniRealtime' || lane === 'omni' ? 'omni' : 'image';
}

function _getQwenHealthRecord(apiKey, model, lane = null) {
    const health = _loadQwenHealth();
    const hash = _hashApiKey(apiKey);
    const bucket = health.keys?.[hash];
    if (!bucket) return null;
    const laneName = lane || _qwenLaneForModel(model);
    return bucket[laneName]?.[model] || null;
}

function _isFreshQwenHealth(record) {
    if (!record?.checkedAt) return false;
    const t = Date.parse(record.checkedAt);
    return Number.isFinite(t) && Date.now() - t <= QWEN_HEALTH_FRESH_MS;
}

function _qwenHealthSkipReason(record) {
    if (!record) return '';
    const status = String(record.status || '').toLowerCase();
    if (status === 'ok') return '';
    if (status === 'transient' || status === 'timeout' || status === 'network' || status === 'rate_limited') {
        const t = Date.parse(record.checkedAt || '');
        if (Number.isFinite(t) && Date.now() - t < QWEN_HEALTH_TRANSIENT_MS) return status;
        return '';
    }
    if (_isFreshQwenHealth(record) && ['exhausted', 'unsupported', 'invalid_key', 'bad_param'].includes(status)) {
        return status;
    }
    return '';
}

function _setQwenHealthRecord(apiKey, model, lane, status, meta = {}) {
    const health = _loadQwenHealth();
    const hash = _hashApiKey(apiKey);
    const role = _qwenRoleForLane(lane);
    const roleKeys = _getQwenKeys(role);
    if (!health.keys[hash]) {
        health.keys[hash] = {
            keyIndex: (roleKeys.findIndex(k => k === apiKey) + 1) || null,
            role,
            firstSeenAt: new Date().toISOString(),
            image: {},
            omniHttp: {},
            omniRealtime: {},
        };
    }
    const keyBucket = health.keys[hash];
    keyBucket.keyIndex = (roleKeys.findIndex(k => k === apiKey) + 1) || keyBucket.keyIndex || null;
    keyBucket.role = role;
    keyBucket.lastSeenAt = new Date().toISOString();
    if (!keyBucket[lane]) keyBucket[lane] = {};
    keyBucket[lane][model] = {
        status,
        checkedAt: new Date().toISOString(),
        ...(meta.ms !== undefined ? { ms: meta.ms } : {}),
        ...(meta.httpStatus !== undefined ? { httpStatus: meta.httpStatus } : {}),
        ...(meta.message ? { message: String(meta.message).slice(0, 240) } : {}),
        ...(meta.source ? { source: meta.source } : {}),
    };
    _saveQwenHealth();
}

function _clearModelExhaustion(model, apiKey, role = 'vision') {
    const map = _getKeyExhaustion(apiKey, role);
    if (map && Object.prototype.hasOwnProperty.call(map, model)) {
        delete map[model];
        _saveExhaustedModels();
    }
}

function _recordQwenModelHealth(apiKey, model, lane, status, meta = {}) {
    _setQwenHealthRecord(apiKey, model, lane || _qwenLaneForModel(model), status, meta);
    if (status === 'ok') {
        // A live 200 response is the highest authority. This repairs older
        // false permanent marks from previous classifier bugs without needing
        // the user to hand-edit .qwen-exhausted-models.json.
        _clearModelExhaustion(model, apiKey, _qwenRoleForLane(lane || _qwenLaneForModel(model)));
    }
}

function _classifyQwenProbeError(err) {
    const status = err?.response?.status || err?.status || 0;
    let data = err?.response?.data || err?.data || {};
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { data = { message: data }; }
    }
    const code = String(data.error?.code || data.code || '').toLowerCase();
    const msg = String(data.error?.message || data.message || err?.message || '').toLowerCase();
    if (msg.includes('incorrect api key') || code.includes('invalidapikey') || code.includes('invalid_api_key')) return 'invalid_key';
    if (_isQwenTransportUnsupportedError(err)) return 'unsupported';
    const quota = _isQuotaError(err);
    if (quota === 'exhausted') return 'exhausted';
    if (quota === 'rate_limited') return 'rate_limited';
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || msg.includes('timeout')) return 'timeout';
    if (_isTransientNetworkError(err)) return 'network';
    if (status >= 500 || status === 429) return 'transient';
    if (status === 400) return 'bad_param';
    return 'error';
}

function _createQwenProbeImageBase64() {
    const { createCanvas } = require('@napi-rs/canvas');
    const c = createCanvas(256, 256);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(64, 64, 128, 128);
    return c.toBuffer('image/png').toString('base64');
}

async function _probeQwenModel(apiKey, model, lane, probeImageB64, timeoutMs = 25000) {
    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const started = Date.now();
    const isQvq = model.startsWith('qvq');
    const body = {
        model,
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${probeImageB64}` } },
                { type: 'text', text: lane === 'omniHttp' ? 'Answer with one word: square.' : 'What shape is in the center? Answer briefly.' },
            ],
        }],
        max_tokens: 16,
    };
    if (isQvq) body.stream = true;

    try {
        const response = await axios.post(`${baseUrl}/chat/completions`, body, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: timeoutMs,
            ...(isQvq ? { responseType: 'text' } : {}),
        });
        _recordQwenModelHealth(apiKey, model, lane, 'ok', {
            ms: Date.now() - started,
            httpStatus: response.status,
            source: 'live-probe',
        });
        return { keyIndex: (_getQwenKeys(_qwenRoleForLane(lane)).findIndex(k => k === apiKey) + 1) || null, lane, model, status: 'ok', ms: Date.now() - started };
    } catch (err) {
        const status = _classifyQwenProbeError(err);
        const httpStatus = err?.response?.status || 0;
        const message = err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || '';
        if (status === 'exhausted') {
            _markModelExhausted(model, 'exhausted', apiKey, _qwenRoleForLane(lane));
            _setQwenHealthRecord(apiKey, model, lane, status, {
                ms: Date.now() - started,
                httpStatus,
                message,
                source: 'live-probe',
            });
        } else {
            _recordQwenModelHealth(apiKey, model, lane, status, {
                ms: Date.now() - started,
                httpStatus,
                message,
                source: 'live-probe',
            });
        }
        return { keyIndex: (_getQwenKeys(_qwenRoleForLane(lane)).findIndex(k => k === apiKey) + 1) || null, lane, model, status, ms: Date.now() - started, httpStatus };
    }
}

async function _runLimited(tasks, concurrency) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (next < tasks.length) {
            const task = tasks[next++];
            results.push(await task());
        }
    });
    await Promise.all(workers);
    return results;
}

function _summarizeQwenHealthResults(results) {
    const summary = {
        total: results.length,
        byLane: {},
        byKey: {},
    };
    for (const r of results) {
        if (!summary.byLane[r.lane]) summary.byLane[r.lane] = {};
        summary.byLane[r.lane][r.status] = (summary.byLane[r.lane][r.status] || 0) + 1;
        const key = String(r.keyIndex || '?');
        if (!summary.byKey[key]) summary.byKey[key] = {};
        if (!summary.byKey[key][r.lane]) summary.byKey[key][r.lane] = {};
        summary.byKey[key][r.lane][r.status] = (summary.byKey[key][r.lane][r.status] || 0) + 1;
    }
    return summary;
}

async function refreshQwenVisionHealth(options = {}) {
    _refreshQwenRuntimeConfig({ force: true });
    _loadQwenHealth(true);
    const lanes = Array.isArray(options.lanes) && options.lanes.length ? options.lanes : ['image', 'omniHttp'];
    const concurrency = Math.max(1, Math.min(12, Number(options.concurrency || process.env.QWEN_HEALTH_PROBE_CONCURRENCY || 4) || 4));
    const timeoutMs = Math.max(5000, Math.min(60000, Number(options.timeoutMs || process.env.QWEN_HEALTH_PROBE_TIMEOUT_MS || 25000) || 25000));
    const imageLimit = Number(options.imageLimit || 0);
    const omniLimit = Number(options.omniLimit || 0);
    const probeImage = _createQwenProbeImageBase64();
    const tasks = [];

    if (lanes.includes('image')) {
        const models = imageLimit > 0 ? QWEN_IMAGE_POOL.slice(0, imageLimit) : QWEN_IMAGE_POOL;
        for (const key of _getQwenKeys('image')) {
            for (const model of models) tasks.push(() => _probeQwenModel(key, model, 'image', probeImage, timeoutMs));
        }
    }
    if (lanes.includes('omniHttp')) {
        const models = omniLimit > 0 ? QWEN_OMNI_HTTP_POOL.slice(0, omniLimit) : QWEN_OMNI_HTTP_POOL;
        for (const key of _getQwenKeys('omni')) {
            for (const model of models) tasks.push(() => _probeQwenModel(key, model, 'omniHttp', probeImage, timeoutMs));
        }
    }
    if (lanes.includes('omniRealtime')) {
        // Realtime models use WebSocket and are not HTTP-probed here. Mark
        // them as unknown candidates in the health file so status output
        // can show them as a separate lane until a real runtime call proves
        // each key/model pair.
        const models = QWEN_OMNI_REALTIME_POOL;
        for (const key of _getQwenKeys('omni')) {
            for (const model of models) {
                const existing = _getQwenHealthRecord(key, model, 'omniRealtime');
                if (!existing) {
                    _setQwenHealthRecord(key, model, 'omniRealtime', 'unknown', { source: 'dashboard-candidate' });
                }
            }
        }
    }

    const results = await _runLimited(tasks, concurrency);
    _saveQwenHealth();
    return {
        keys: _getQwenKeys('vision').length,
        imageKeys: _getQwenKeys('image').length,
        omniKeys: _getQwenKeys('omni').length,
        endpoint: config.qwen?.baseUrl || '',
        lanes,
        concurrency,
        timeoutMs,
        results,
        summary: _summarizeQwenHealthResults(results),
    };
}

// Classify a model name into a role bucket. Used during one-shot migration
// of legacy flat-format JSON ({ keys: { hash: { model: state } } }) into the
// new role-scoped shape. Vision pools go to 'vision'; anything else falls
// into 'text' for backward compat with old persisted state, but the text
// bucket is no longer written to by the current code.
function _classifyModelRole(modelName) {
    if (!modelName) return 'image';
    if (QWEN_OMNI_POOL.includes(modelName) || QWEN_OMNI_REALTIME_POOL.includes(modelName) || QWEN_OMNI_OPENAI_UNSUPPORTED_POOL.includes(modelName)) return 'omni';
    if (QWEN_IMAGE_POOL.includes(modelName)) return 'image';
    const m = String(modelName).toLowerCase();
    if (m.includes('-omni')) return 'omni';
    if (m.includes('-vl-') || m.startsWith('qvq')) return 'image';
    return 'text';
}

function _migrateQwenTrackingMap(modelMap = {}, targetMap = {}) {
    for (const [hash, records] of Object.entries(modelMap || {})) {
        for (const [model, state] of Object.entries(records || {})) {
            const role = _classifyModelRole(model);
            if (!targetMap[role]) targetMap[role] = {};
            if (!targetMap[role][hash]) targetMap[role][hash] = {};
            targetMap[role][hash][model] = state;
        }
    }
}

// Load persisted state on startup
try {
    const textKeys = config.qwen?.apiKeys || [];
    const imageKeys = config.qwen?.imageApiKeys || config.qwen?.visionApiKeys || [];
    const omniKeys = config.qwen?.omniApiKeys || config.qwen?.visionApiKeys || [];

    if (fs.existsSync(_exhaustedModelsFile)) {
        const saved = JSON.parse(fs.readFileSync(_exhaustedModelsFile, 'utf8'));
        let migrated = false;

        if ((saved.text || saved.image || saved.omni || saved.vision) && !saved.keys) {
            // New role-scoped format — load directly.
            _perKeyExhaustion.text = saved.text || {};
            _perKeyExhaustion.image = saved.image || {};
            _perKeyExhaustion.omni = saved.omni || {};
            if (saved.vision) {
                _migrateQwenTrackingMap(saved.vision, _perKeyExhaustion);
                migrated = true;
            }
        } else if (saved.keys) {
            // Legacy multi-key format ({ keys: { hash: { model: state } } }).
            // Split each (hash, model) entry into the right role bucket.
            for (const [hash, modelMap] of Object.entries(saved.keys)) {
                for (const [model, state] of Object.entries(modelMap || {})) {
                    const role = _classifyModelRole(model);
                    if (!_perKeyExhaustion[role][hash]) _perKeyExhaustion[role][hash] = {};
                    _perKeyExhaustion[role][hash][model] = state;
                }
            }
            migrated = true;
            console.log(`  🔄 [Qwen Pool] Migrated legacy flat tracking → role-scoped (text/image/omni)`);
        } else if (saved._apiKeyHash) {
            // Very old single-key format. Same split-by-role migration.
            const oldHash = saved._apiKeyHash;
            for (const [model, state] of Object.entries(saved)) {
                if (model === '_apiKeyHash') continue;
                const role = _classifyModelRole(model);
                if (!_perKeyExhaustion[role][oldHash]) _perKeyExhaustion[role][oldHash] = {};
                _perKeyExhaustion[role][oldHash][model] = state;
            }
            migrated = true;
            console.log(`  🔄 [Qwen Pool] Migrated single-key legacy → role-scoped (text/image/omni)`);
        }

        if (migrated) _saveExhaustedModels();

        // Log per role × per key.
        const seenImage = new Set();
        imageKeys.forEach((k, i) => {
            const h = _hashApiKey(k);
            if (seenImage.has(h)) return;
            seenImage.add(h);
            const map = _perKeyExhaustion.image[h] || {};
            const count = Object.values(map).filter(v => v === true).length;
            if (count > 0) console.log(`  🔑 [Qwen Image Key ${i + 1}] ${count} models permanently exhausted`);
        });
        const seenOmni = new Set();
        omniKeys.forEach((k, i) => {
            const h = _hashApiKey(k);
            if (seenOmni.has(h)) return;
            seenOmni.add(h);
            const map = _perKeyExhaustion.omni[h] || {};
            const count = Object.values(map).filter(v => v === true).length;
            if (count > 0) console.log(`  🔑 [Qwen Omni Key ${i + 1}] ${count} models permanently exhausted`);
        });
        const seenText = new Set();
        textKeys.forEach((k, i) => {
            const h = _hashApiKey(k);
            if (seenText.has(h)) return;
            seenText.add(h);
            const map = _perKeyExhaustion.text[h] || {};
            const count = Object.values(map).filter(v => v === true).length;
            if (count > 0) console.log(`  🔑 [Qwen Text Key ${i + 1}] ${count} models permanently exhausted`);
        });
    }
} catch (e) { /* fresh start */ }

function _saveExhaustedModels() {
    try {
        require('fs').writeFileSync(
            _exhaustedModelsFile,
            JSON.stringify({
                text: _perKeyExhaustion.text || {},
                image: _perKeyExhaustion.image || {},
                omni: _perKeyExhaustion.omni || {},
            }, null, 2)
        );
    } catch (e) { /* non-fatal */ }
}

/**
 * Get exhaustion map for a specific (role, key) pair. A vision burn lives
 * in `_perKeyExhaustion.vision[hash]` and is INVISIBLE to text-side calls
 * that look up the same key under the 'text' bucket — and vice-versa.
 *
 * @param {string} apiKey - the actual API key string
 * @param {'text'|'vision'} role - which side is asking
 */
function _getKeyExhaustion(apiKey, role = 'vision') {
    const bucketName = role === 'text' ? 'text' : role === 'omni' ? 'omni' : 'image';
    const bucket = _perKeyExhaustion[bucketName] || (_perKeyExhaustion[bucketName] = {});
    const hash = _hashApiKey(apiKey);
    if (!bucket[hash]) bucket[hash] = {};
    return bucket[hash];
}

/**
 * Resolve which Qwen key pool to use for a given role.
 *   role === 'vision' → config.qwen.visionApiKeys (separate vision-only pool)
 *   role === 'text'   → config.qwen.apiKeys      (main text pool)
 *
 * If QWEN_VISION_API_KEY is unset, visionApiKeys falls back to apiKeys at
 * config-load time, so legacy single-pool setups keep working unchanged.
 */
function _getQwenKeys(role) {
    _refreshQwenRuntimeConfig();
    if (role === 'image') return config.qwen?.imageApiKeys || config.qwen?.visionApiKeys || [];
    if (role === 'omni') return config.qwen?.omniApiKeys || config.qwen?.visionApiKeys || [];
    if (role === 'vision') {
        const merged = [
            ...(config.qwen?.imageApiKeys || []),
            ...(config.qwen?.omniApiKeys || []),
            ...(config.qwen?.visionApiKeys || []),
        ];
        return [...new Set(merged.filter(Boolean))];
    }
    return config.qwen?.apiKeys || [];
}

/**
 * Friendly "Vision Key N" / "Text Key N" log label.
 *
 * @param {string} apiKey - the actual key
 * @param {'text'|'vision'} role - which role's pool index to resolve against.
 *        If a key is shared across pools, this picks the right index for the
 *        role that's currently calling, so log lines never mis-attribute a
 *        text burn as a vision burn.
 */
function _qwenKeyLabel(apiKey, role = 'vision') {
    const keys = _getQwenKeys(role);
    const idx = keys.findIndex(k => k === apiKey);
    const prefix = role === 'text' ? 'Text Key' : role === 'image' ? 'Image Key' : role === 'omni' ? 'Omni Key' : 'Vision Key';
    if (idx >= 0) return `${prefix} ${idx + 1}`;
    // Fallback: scan the other pool (rare — caller passed a key not in the
    // expected role's pool). Still label by role for honesty.
    return `${prefix} ?`;
}

/**
 * Check if a Qwen API error indicates quota exhaustion.
 *
 * Permanent (`exhausted`) is RESERVED for real free-tier depletion only, because
 * once a model is marked permanent on a key it is NEVER retried on that key again
 * — quota does not refill per-key on Alibaba. False positives permanently burn a
 * live model. We therefore require an EXPLICIT marker in the error payload
 * (DashScope's canonical code `AllocationQuota.FreeTierOnly` or
 * `QuotaExceeded.FreeTier`). Every other failure mode — generic 403, 404, 429,
 * 5xx, timeouts — is a cooldown (`rate_limited`).
 */
function _isQuotaError(err) {
    const status = err.response?.status;
    let data = err.response?.data || {};
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (_) {
            data = { message: data };
        }
    }
    const code = String(data.error?.code || data.error?.type || data.code || data.type || '').toLowerCase();
    const msg = String(data.error?.message || data.message || err.message || '').toLowerCase();

    // Real free-tier exhaustion — DashScope emits a canonical code. Match the code
    // first (authoritative), then fall back to an exact phrase match on the
    // message to catch cases where only the message carries it.
    const explicitExhausted =
        code.includes('allocationquota.freetieronly') ||
        code.includes('quotaexceeded.freetier') ||
        msg.includes('allocationquota.freetieronly') ||
        msg.includes('quotaexceeded.freetier') ||
        msg.includes('free tier quota');
    if (explicitExhausted) return 'exhausted';

    // Everything else that can reasonably be a transient or model-specific error
    // is a cooldown, NOT permanent. This covers: generic 403s, regional 404s,
    // rate-limit 429s, server errors 5xx.
    //
    // 400 IS DELIBERATELY ABSENT — see _isRequestDefectError. A 400 is the
    // protocol describing the payload we just sent, never the pool's capacity,
    // so it must fail one call and never bench a key/model.
    if (status === 403 || status === 404) return 'rate_limited';
    if (status === 429) return 'rate_limited';
    if (status === 500 || status === 502 || status === 503) return 'rate_limited';
    return null;
}

/**
 * Pull the server's OWN error text out of an axios error.
 *
 * Without this the box's real complaint ("Input length 4127 exceeds model's
 * maximum context length 4096") never reached a log line — the build only ever
 * printed the generic "box busy" label, which is why a request-shaped fault
 * looked like a capacity fault for an entire build.
 */
function _qwenErrorText(err) {
    let data = err?.response?.data ?? err?.data ?? {};
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { return data.slice(0, 400); }
    }
    const fromBody = data?.error?.message || data?.message
        || (data && typeof data === 'object' && Object.keys(data).length ? JSON.stringify(data).slice(0, 400) : '');
    return String(fromBody || err?.message || '');
}

/**
 * Is this a REQUEST defect (our payload) rather than a POOL defect (their capacity)?
 *
 * HTTP 400 means "the request you sent was malformed". That is a statement about
 * the bytes we just uploaded — it says nothing about whether the key is valid,
 * the model is alive, or the server is busy. Benching a key/model for it is a
 * category error, and on a self-hosted box it is fatal: there is exactly ONE key
 * and ONE model, so a single bad payload benches the whole lane,
 * `_getBestKeyAndModel` returns null, and every remaining frame in the build
 * falls through to paid Bedrock.
 *
 * Measured on the Jul-31 build: the box's own log recorded 16×400 (prompt+image
 * over the context window, plus undecodable image bytes) across a 47-minute
 * media phase — and the GPU scored ZERO images. 16 bad requests should cost 16
 * requests.
 *
 * ORDERING MATTERS. This is consulted only AFTER the two 400s that ARE genuine
 * pool facts, both of which keep their existing behaviour:
 *   - `_isQuotaError`'s explicit free-tier codes (DashScope can carry quota on a 400)
 *   - `_isQwenTransportUnsupportedError` ("this model can't be called this way")
 *
 * The DECISION is the HTTP status alone — no phrase matching — so it holds for
 * any OpenAI-compatible server (vLLM, DashScope, or anything added later). The
 * phrases below only choose a friendly label for the log line.
 *
 * @returns {string|null} short human reason, or null if this is not a request defect
 */
function _isRequestDefectError(err) {
    const status = err?.response?.status || err?.status || 0;
    if (status !== 400) return null;
    const msg = _qwenErrorText(err).toLowerCase();
    if (msg.includes('context length') || msg.includes('context_length') || msg.includes('input length')) {
        return 'prompt + image is longer than this model can read';
    }
    if (msg.includes('image') && (msg.includes('cannot identify') || msg.includes('failed to load')
        || msg.includes('decode') || msg.includes('corrupt'))) {
        return 'image bytes could not be decoded';
    }
    if (msg.includes('may be provided in one prompt') || msg.includes('limit_mm_per_prompt')
        || msg.includes('limit-mm-per-prompt')) {
        return 'too many images for one request';
    }
    return 'malformed request';
}

function _isQwenTransportUnsupportedError(err) {
    const status = err.response?.status;
    let data = err.response?.data || {};
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (_) {
            data = { message: data };
        }
    }
    const code = String(data.error?.code || data.code || '').toLowerCase();
    const msg = String(data.error?.message || data.message || err.message || '').toLowerCase();
    if (!(status === 400 || status === 404)) return false;
    return (
        code.includes('model_not') ||
        code.includes('invalid_model') ||
        msg.includes('unsupported model') ||
        msg.includes('does not support http call') ||
        msg.includes('does not support stream call') ||
        msg.includes('not supported for openai compatibility')
    );
}

function _isTransientNetworkError(err) {
    const code = String(err?.code || '').toUpperCase();
    const msg = String(err?.message || '').toLowerCase();
    return [
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNRESET',
        'ECONNREFUSED',
        'ECONNABORTED',
        'ETIMEDOUT',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'ERR_NETWORK',
    ].includes(code) ||
        msg.includes('getaddrinfo') ||
        msg.includes('socket hang up') ||
        msg.includes('network error') ||
        msg.includes('timeout');
}

// Task-type aliasing — used to normalize the taskType label across callers
// before NVIDIA / Bedrock routing picks a profile. (Qwen text path is gone.)
const _TEXT_TASK_ALIASES_LARGE = {
    planner: 'planner-large',
    visual: 'planner-large',
    visualplanner: 'planner-large',
    'visual-planner': 'planner-large',
};
const _TEXT_TASK_ALIASES_SMALL = {
    planner: 'planner-small',
    visual: 'planner-small',
    visualplanner: 'planner-small',
    'visual-planner': 'planner-small',
};
const _TEXT_TASK_ALIASES = {
    outline: 'planner-outline',
    classify: 'classifier',
    classifier: 'classifier',
    classification: 'classifier',
    sceneclassifier: 'classifier',
    'scene-classifier': 'classifier',
    director: 'brain',
    orchestrator: 'review',
    templates: 'template',
    mg: 'motion-graphics',
    motion: 'motion-graphics',
    keyword: 'utility',
    search: 'utility',
};
// `planner-source-audit` (ai-visual-planner.js) is a reasoning task, but until it
// was listed here it fell through to the 'general' profile — which made it
// unaddressable by a task gate, so it could not be routed to the thinking brain
// separately from the cheap default tier. It is in _DIRECTIVE_TASKS below for the
// same reason 'general' is, so promoting it does not change what the prompt carries.
const _TEXT_TASK_PROFILES = new Set([
    'brain', 'classifier', 'planner-outline', 'planner-large', 'planner-small',
    'planner-source-audit', 'utility', 'template', 'motion-graphics', 'review', 'general',
]);

function _normalizeTextTaskType(taskType, { promptLength = 0, maxTokens = 800 } = {}) {
    const inferred = taskType || (maxTokens <= 220 && promptLength < 8000 ? 'utility' : 'general');
    const isLargePrompt = promptLength > 12000 || maxTokens > 1200;
    const raw = String(inferred || '').trim().toLowerCase();
    const sizeAliases = isLargePrompt ? _TEXT_TASK_ALIASES_LARGE : _TEXT_TASK_ALIASES_SMALL;
    const normalized = sizeAliases[raw] || _TEXT_TASK_ALIASES[raw] || raw || 'general';
    return _TEXT_TASK_PROFILES.has(normalized) ? normalized : 'general';
}

// ── Production directives (the user's one instruction field → the WHOLE pipeline).
// AI_INSTRUCTIONS (set from the UI "AI Instructions" box per build) is prepended as
// the HIGHEST-priority block to every DECISION brain's call — Director, Visual
// Planner, templates, motion-graphics, the editor-agent directors, orchestrator.
// Tiny utility/keyword/classifier calls are intentionally skipped (they shouldn't be
// steered by "95% footage, no templates"). Empty instructions → injected nothing →
// zero behaviour change. Disable entirely with AI_INSTRUCTIONS_GLOBAL=0.
const _DIRECTIVE_TASKS = new Set([
    'brain', 'planner-outline', 'planner-large', 'planner-small',
    'planner-source-audit', 'template', 'motion-graphics', 'review', 'general',
]);
function _productionDirectives(normalizedTask) {
    if (/^(0|false|off|no)$/i.test(String(process.env.AI_INSTRUCTIONS_GLOBAL || '').trim())) return '';
    const raw = String(process.env.AI_INSTRUCTIONS || '').trim();
    if (!raw) return '';
    if (normalizedTask && !_DIRECTIVE_TASKS.has(normalizedTask)) return '';
    return `🚦 PRODUCTION DIRECTIVES — user-set rules for THIS specific video. They are the HIGHEST authority and OVERRIDE any default or house guidance that follows (more/fewer templates, more footage, a target length, a style, a banned element — the user's word wins). Apply them through the lens of your own role:\n"""\n${raw}\n"""`;
}

// _nvidiaTextTaskProfile REMOVED in 2026-05-25 cleanup.

function _textRouteKey(entry, taskType) {
    const model = entry.model || '*';
    return `${taskType || 'general'}|${entry.provider || entry}|${model}`;
}

function _textRouteGlobalKey(entry) {
    const model = entry.model || '*';
    return `*|${entry.provider || entry}|${model}`;
}

function _textRouteLabel(entry) {
    if (typeof entry === 'string') return entry;
    if (entry.label) return entry.label;
    return entry.model ? `${entry.provider}:${entry.model}` : entry.provider;
}

function _csvList(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

// A task gate of `all` (or `*`) means the WHOLE text surface, not the Sonnet tier.
// An explicit CSV list silently misses any profile added to _TEXT_TASK_PROFILES later,
// which strands that task on the fallback provider. Empty still means "off" — the brain
// dropdown clears the gate of the brains it did not select, so empty must not mean all.
function _csvTaskGate(value) {
    const list = _csvList(value);
    if (list.some(t => t.toLowerCase() === 'all' || t === '*')) return [..._TEXT_TASK_PROFILES];
    return list;
}

function _liveAilinkTaskTypes() {
    const al = config.ailink || {};
    if (process.env.AILINK_TASK_TYPES !== undefined) {
        return _csvTaskGate(process.env.AILINK_TASK_TYPES);
    }
    return _csvTaskGate((Array.isArray(al.allowedTasks) ? al.allowedTasks : []).join(','));
}

function _liveAplinkTaskTypes() {
    const ap = config.aplink || {};
    if (process.env.APLINK_TASK_TYPES !== undefined) {
        return _csvTaskGate(process.env.APLINK_TASK_TYPES);
    }
    return _csvTaskGate((Array.isArray(ap.allowedTasks) ? ap.allowedTasks : []).join(','));
}

function _liveAzureTaskTypes() {
    const az = config.azure || {};
    if (process.env.AZURE_TASK_TYPES !== undefined) {
        return _csvTaskGate(process.env.AZURE_TASK_TYPES);
    }
    return _csvTaskGate((Array.isArray(az.allowedTasks) ? az.allowedTasks : []).join(','));
}

function _liveAzureOpenAITaskTypes() {
    const az = config.azureOpenAI || {};
    if (process.env.AZURE_OPENAI_TASK_TYPES !== undefined) {
        return _csvTaskGate(process.env.AZURE_OPENAI_TASK_TYPES);
    }
    return _csvTaskGate((Array.isArray(az.allowedTasks) ? az.allowedTasks : []).join(','));
}

function _liveAzureManagedTaskTypes() {
    const am = config.azureManaged || {};
    if (process.env.AZURE_MANAGED_BRAIN_TASK_TYPES !== undefined) {
        return _csvTaskGate(process.env.AZURE_MANAGED_BRAIN_TASK_TYPES);
    }
    return am.brainTaskTypes || [];
}

function _textTaskTier(task) {
    const cfg = config.bedrock || {};
    if (cfg.utilityModel && new Set(cfg.utilityTaskTypes || []).has(task)) return 'bedrock-utility';
    if (cfg.plannerModel && new Set(cfg.plannerTaskTypes || []).has(task)) return 'sonnet-tier';
    return 'bedrock-default';
}

function _textRouteMode(task, route, { providerOverride = false } = {}) {
    if (providerOverride) return 'forced-provider';
    const first = route?.[0] || {};
    if (first.connectionId) return 'ai-connection';
    if (first.provider === 'ailink') return 'hybrid-ailink-primary';
    if (first.provider === 'aplink') return 'hybrid-aplink-primary';
    if (first.provider === 'azure-claude') return 'hybrid-azure-primary';
    if (first.provider === 'azure-openai') return 'hybrid-azure-openai-primary';
    return _textTaskTier(task);
}

function _textRouteDecisionLine(task, route, { providerOverride = false } = {}) {
    const labels = (route || []).map(_textRouteLabel);
    const primary = labels[0] || 'none';
    const fallback = labels.length > 1 ? labels.slice(1).join(' -> ') : 'none';
    return `task=${task} tier=${_textTaskTier(task)} mode=${_textRouteMode(task, route, { providerOverride })} primary=${primary} fallback=${fallback}`;
}

function _textRouteFailureReason(error) {
    const status = error?.response?.status;
    const msg = String(error?.message || '');
    if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || error?.code === 'ERR_CANCELED' || /timeout|timed out|canceled/i.test(msg)) return 'timeout';
    if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNRESET' || error?.code === 'EAI_AGAIN' || error?.code === 'ETIMEDOUT') return 'network';
    if (status === 429) return 'rate_limited';
    if (status === 404 || status === 410) return 'unavailable';
    if (status >= 500) return 'server';
    if (/empty response/i.test(msg)) return 'empty';
    return 'error';
}

// Consecutive-failure counter per (route, task). A single transient blip (e.g. one
// aplink.top 504) should NOT cool a route and demote a whole run of tasks to the fallback
// model — require TEXT_ROUTE_FAIL_THRESHOLD strikes first. "unavailable" (404/410 = model
// genuinely gone) trips immediately. Reset on any success via _clearTextRouteFailures.
const _textRouteFailCounts = new Map();
const TEXT_ROUTE_FAIL_THRESHOLD = Math.max(1, Math.min(5, parseInt(process.env.TEXT_ROUTE_FAIL_THRESHOLD || '2', 10) || 2));
// Floor for 'brain' (CEO/editor) max_tokens — those decisions were truncating (stop=length)
// when a caller passed a low cap, cutting a decision off mid-thought. BRAIN_MIN_MAX_TOKENS=0 disables.
const BRAIN_MIN_MAX_TOKENS = Math.max(0, parseInt(process.env.BRAIN_MIN_MAX_TOKENS || '5000', 10) || 5000);

// The same truncation, one tier down. A GPT-5.x primary is a REASONING model: it spends
// completion budget thinking before it emits one visible character, so the 200–800 cap
// that suits a non-reasoning model is swallowed whole and the call returns "" with
// finish=length. Measured on the 2026-08-15 build: 99 empty text responses, all on the
// small tasks below, and each one also burns a fallback attempt on the dead Bedrock route.
// This is the text twin of _visionCompletionBudget — a modest floor (these outputs are
// short; the model only needs room to reason THEN write), applied ONLY when the primary is
// a reasoning model, so every other model keeps its current cap byte-for-byte. 'brain' and
// the planner-* tasks are excluded: they have their own, much larger floor above.
// TEXT_MIN_MAX_TOKENS overrides; TEXT_MIN_MAX_TOKENS=0 disables.
const TEXT_REASONING_MIN_TOKENS = 1200;
const _TEXT_REASONING_FLOOR_TASKS = new Set(['utility', 'general', 'classifier', 'motion-graphics', 'template']);

// The planner tier had NO floor at all. The note above used to say these tasks were
// excluded because they "have their own, much larger floor" — but that floor
// (BRAIN_MIN_MAX_TOKENS) only ever applied to task === 'brain'. Measured 2026-08-27:
// planner-outline arrived with 8000 tokens against a 37k-char prompt and planner-large
// with 3600 against 74k, and the reasoning primary spent every one of them thinking,
// returning "" at finish=length. These outputs are big structured plans, so the floor
// has to be big too. TEXT_PLANNER_MIN_MAX_TOKENS overrides; 0 disables.
const TEXT_REASONING_PLANNER_MIN_TOKENS = 8000;
const _TEXT_PLANNER_FLOOR_TASKS = new Set([
    'planner-outline', 'planner-large', 'planner-small', 'planner-source-audit', 'review',
]);

function _textCompletionBudget(entry, task, maxTokens) {
    const asked = Number(maxTokens) || 800;
    const isPlanner = _TEXT_PLANNER_FLOOR_TASKS.has(task);
    if (!isPlanner && !_TEXT_REASONING_FLOOR_TASKS.has(task)) return asked;
    if (!_isReasoningModel(entry?.model) && entry?.reasoning !== true) return asked;
    if (isPlanner) {
        const rawP = process.env.TEXT_PLANNER_MIN_MAX_TOKENS;
        const floorP = rawP === undefined || rawP === ''
            ? TEXT_REASONING_PLANNER_MIN_TOKENS
            : Math.max(0, parseInt(rawP, 10) || 0);
        return Math.max(asked, floorP);
    }
    const raw = process.env.TEXT_MIN_MAX_TOKENS;
    const floor = raw === undefined || raw === '' ? TEXT_REASONING_MIN_TOKENS : Math.max(0, parseInt(raw, 10) || 0);
    return Math.max(asked, floor);
}

function _clearTextRouteFailures(entry, taskType) {
    _textRouteFailCounts.delete(_textRouteKey(entry, taskType));
}

function _markTextRouteUnhealthy(entry, taskType, error) {
    const reason = _textRouteFailureReason(error);
    const key = _textRouteKey(entry, taskType);
    const fails = (_textRouteFailCounts.get(key) || 0) + 1;
    _textRouteFailCounts.set(key, fails);
    const threshold = reason === 'unavailable' ? 1 : TEXT_ROUTE_FAIL_THRESHOLD;
    if (fails < threshold) {
        console.log(`  [Text Router] ${_textRouteLabel(entry)} ${reason} for task=${taskType} (strike ${fails}/${threshold}) — retrying next time, not cooling`);
        return;
    }
    // Shorter cooldowns for transient relay hiccups (504/timeout recover fast) so the
    // smarter primary is retried sooner instead of being abandoned for many minutes.
    const ttlMs = {
        timeout: 2 * 60 * 1000,
        rate_limited: 2 * 60 * 1000,
        network: 2 * 60 * 1000,
        server: 90 * 1000,
        unavailable: 60 * 60 * 1000,
        empty: 2 * 60 * 1000,
        error: 2 * 60 * 1000,
    }[reason] || (2 * 60 * 1000);
    const record = {
        reason,
        message: String(error?.message || reason).slice(0, 240),
        at: Date.now(),
        until: Date.now() + ttlMs,
    };
    _textRouteHealth.set(key, record);
    if (reason === 'unavailable') {
        _textRouteHealth.set(_textRouteGlobalKey(entry), record);
    }
    _textRouteFailCounts.delete(key);
    console.log(`  [Text Router] Marked unhealthy for task=${taskType}: ${_textRouteLabel(entry)} (${reason}, cooldown ${Math.round(ttlMs / 1000)}s after ${fails} strike(s))`);
}

function _textRouteSkipReason(entry, taskType) {
    const taskKey = _textRouteKey(entry, taskType);
    const globalKey = _textRouteGlobalKey(entry);
    const taskRecord = _textRouteHealth.get(taskKey);
    const globalRecord = _textRouteHealth.get(globalKey);
    const record = taskRecord || globalRecord;
    if (record && record.until && record.until <= Date.now()) {
        if (taskRecord) _textRouteHealth.delete(taskKey);
        if (globalRecord) _textRouteHealth.delete(globalKey);
        return '';
    }
    return record ? `${record.reason}: ${record.message}` : '';
}

function _hasProviderKey(provider) {
    // After 2026-05-25 cleanup: only Bedrock (text) and Qwen (vision) are valid.
    switch (provider) {
        case 'qwen': return !!(_getQwenKeys('image') || []).length;
        case 'bedrock': return !!(config.bedrock?.accessKeyId && config.bedrock?.secretAccessKey);
        case 'ailink': return !!config.ailink?.apiKey;
        case 'aplink': return !!config.aplink?.apiKey;
        case 'azure-claude': return !!(config.azure?.apiKey && config.azure?.baseUrl && config.azure?.model);
        case 'azure-openai': return !!(config.azureOpenAI?.apiKey && config.azureOpenAI?.baseUrl && config.azureOpenAI?.model);
        case 'azure-managed': return !!(config.azureManaged?.apiKey && config.azureManaged?.baseUrl);
        case 'bedrock-nova':
        case 'bedrock-qwen-vl':
        case 'bedrock-claude':
            return !!(config.bedrock?.accessKeyId && config.bedrock?.secretAccessKey);
        default: return false;
    }
}

/**
 * Mark a model as exhausted or rate-limited FOR A SPECIFIC KEY.
 *
 * QWEN PER-KEY QUOTA RULE (the one I keep forgetting):
 *   `reason === 'exhausted'` → free quota burned on THIS key for THIS model.
 *   That mark is PERMANENT on this (key, model) pair — quota never refreshes.
 *   But the SAME model on a DIFFERENT key has its own independent quota and
 *   may still work. So this stores per-key only — never globally.
 *   Do not add cooldowns for `exhausted`. Do not auto-clear permanent flags.
 *   Recovery = user adds a new key.
 */
function _markModelExhausted(model, reason, apiKey, role = 'vision') {
    const map = _getKeyExhaustion(apiKey, role);
    const label = _qwenKeyLabel(apiKey, role);
    const lane = _qwenLaneForModel(model);
    if (reason === 'exhausted') {
        map[model] = true; // permanent ON THIS (role, key)
        _saveExhaustedModels();
        _setQwenHealthRecord(apiKey, model, lane, 'exhausted', { source: 'runtime' });
        console.log(`  💀 [${label}] ${model} — QUOTA EXHAUSTED (permanent on this key)`);
        _maybeNotifyKeyVisionExhausted(apiKey);
    } else {
        // Transient cooldown for 429/network/timeout. A rate-limited FREE model recovers
        // in SECONDS — the old 2-min bench sidelined healthy models for the whole build
        // (536 rate-limit hits in one run → the free Qwen pool depleted in minutes → vision
        // fell to PAID Bedrock 298×, which then 429-throttled 476× → the ~3h media phase).
        // 30s keeps the free pool alive and usable. Override with QWEN_VISION_COOLDOWN_MS.
        //
        // ONE EXCEPTION — our own box. On hosted DashScope there are many models
        // across many keys, so benching one for 30s costs nothing. On a rented
        // GPU there is exactly one model on one key, so the same 30s benches the
        // ENTIRE lane: `_getBestKeyAndModel` returns null, the caller is told
        // "all combos temporarily unavailable", and the frame goes to paid
        // Bedrock. That happened 31 times in the Jul-29 build off 13 cooldowns.
        // A busy queue drains in seconds, so wait seconds.
        const selfHostedBusy = reason === 'rate_limited' && _isSelfHostedVisionRuntime();
        const cooldownMs = selfHostedBusy
            ? Math.max(1_000, parseInt(process.env.QWEN_VISION_BUSY_COOLDOWN_MS, 10) || 4_000)
            : Math.max(5_000, parseInt(process.env.QWEN_VISION_COOLDOWN_MS, 10) || 30_000);
        map[model] = Date.now() + cooldownMs;
        const reasonLabel = reason === 'network'
            ? 'network transient'
            : reason === 'timeout'
                ? 'timeout'
                : selfHostedBusy
                    ? 'box busy'
                    : 'rate limited';
        const healthStatus = reason === 'network'
            ? 'network'
            : reason === 'timeout'
                ? 'timeout'
                : 'rate_limited';
        _setQwenHealthRecord(apiKey, model, lane, healthStatus, { source: 'runtime' });
        console.log(`  🔄 [${label}] ${model} — ${reasonLabel} (${Math.round(cooldownMs / 1000)}s cooldown)`);
    }
}

// Per-process guard so the "vision key fully exhausted" alert fires at most
// once per key per build run.
const _notifiedKeysVisionExhausted = new Set();

/**
 * Check whether the given key now has its ENTIRE vision pool permanently
 * exhausted (role='vision' tracking only). If yes, emit a sentinel stdout
 * line that main.js parses to fire OS notification + in-app toast.
 *
 * Only counts permanent (`true`) marks under the vision bucket. Text-side
 * burns on the same physical key are stored separately and don't affect
 * this check.
 */
function _maybeNotifyKeyVisionExhausted(apiKey) {
    const map = _getKeyExhaustion(apiKey, 'image');
    const allDead = QWEN_IMAGE_POOL.every(m => map[m] === true);
    if (!allDead) return;
    const hash = _hashApiKey(apiKey);
    if (_notifiedKeysVisionExhausted.has(hash)) return;
    _notifiedKeysVisionExhausted.add(hash);
    const imageKeys = _getQwenKeys('image');
    const keyIdx = imageKeys.findIndex(k => k === apiKey) + 1;
    console.log(`🚨 QWEN_KEY_VISION_EXHAUSTED|key=${keyIdx}|tail=${_qwenKeyTail(apiKey)}|pool=${QWEN_IMAGE_POOL.length}`);
    console.log(`  ⚠️  Qwen Image Key ${keyIdx} is FULLY exhausted on vision — swap or reorder QWEN_VISION_API_KEY in .env`);
}

/**
 * Check if a model is available for a specific (role, key) pair.
 */
function _isModelAvailable(model, apiKey, role = 'vision') {
    if (_isQwenRuntimeUnsupported(model, role)) return false;
    const health = _getQwenHealthRecord(apiKey, model, _qwenLaneForModel(model));
    if (health?.status === 'ok' && _isFreshQwenHealth(health)) return true;
    if (_qwenHealthSkipReason(health)) return false;
    const map = _getKeyExhaustion(apiKey, role);
    const state = map[model];
    if (!state) return true;
    if (state === true) return false;
    return state < Date.now(); // cooldown expired
}

/**
 * Get the next available model from a pool for a specific (role, key) pair.
 */
function _getAvailableModel(pool, configuredModel, apiKey, role = 'vision') {
    if (configuredModel && _isModelAvailable(configuredModel, apiKey, role)) {
        return configuredModel;
    }
    for (const model of pool) {
        if (_isModelAvailable(model, apiKey, role)) return model;
    }
    return null;
}

/**
 * Get the best key + model combo. Tries models in quality order, then keys.
 * Alibaba free quota is per (key, model), so if Key 1 burns qwen-plus we
 * should try Key 2 qwen-plus before dropping to a smaller model.
 * `role` selects BOTH the key pool to draw from AND the exhaustion bucket
 * to consult — text and vision are isolated end-to-end.
 * Returns { apiKey, model, keyIndex } or null if everything exhausted.
 */
const _qwenRoundRobinIdx = {}; // role -> monotonic counter, spreads calls across combos

/**
 * @param {Set<string>} [excludeCombos] - `${_hashApiKey(key)}:${model}` entries the
 *        CALLER has already tried in this one call. Purely call-local: it lets a
 *        retry loop advance to a fresh combo WITHOUT benching the current one in
 *        global state. Before this existed, the only way to move the rotation
 *        forward was `_markModelExhausted(..., 'rate_limited')`, which meant a
 *        one-off bad payload sidelined a perfectly healthy key/model for every
 *        later call in the build. Omit it and behaviour is exactly as before.
 */
function _getBestKeyAndModel(pool, configuredModel, role = 'vision', excludeCombos = null) {
    const keys = _getQwenKeys(role);
    if (keys.length === 0) return null;

    const orderedModels = [
        ...(configuredModel ? [configuredModel] : []),
        ...pool.filter(model => model !== configuredModel)
    ];

    // Collect EVERY currently-available (model, key) combo — only the ones that are alive
    // (not quota-dead, not in a cooldown window) survive _isModelAvailable.
    const available = [];
    for (const model of orderedModels) {
        for (let i = 0; i < keys.length; i++) {
            if (excludeCombos && excludeCombos.has(`${_hashApiKey(keys[i])}:${model}`)) continue;
            if (_isModelAvailable(model, keys[i], role)) {
                available.push({ apiKey: keys[i], model, keyIndex: i + 1 });
            }
        }
    }
    if (available.length === 0) return null; // all keys × all models exhausted

    // SPREAD the load: round-robin across every available combo instead of always returning
    // the first one. Parallel vision calls each grab a DIFFERENT model+key, so no single
    // model/key gets hammered into a rate-limit — and as combos cool down they drop out of
    // `available` and the rotation skips them automatically. This replaces the old "follow
    // one model across all keys until it's exhausted" behaviour. QWEN_ROTATION_SPREAD=0
    // restores stick-to-first.
    if (process.env.QWEN_ROTATION_SPREAD === '0') return available[0];
    const n = (_qwenRoundRobinIdx[role] = (_qwenRoundRobinIdx[role] || 0) + 1);
    return available[(n - 1) % available.length];
}

function _describeQwenPoolUnavailable(pool, role = 'image') {
    const keys = _getQwenKeys(role);
    if (keys.length === 0) return `No Qwen ${role} API keys configured`;

    const now = Date.now();
    const counts = {
        available: 0,
        exhausted: 0,
        unsupported: 0,
        invalid_key: 0,
        bad_param: 0,
        timeout: 0,
        network: 0,
        rate_limited: 0,
        transient: 0,
        cooldown: 0,
        other: 0,
    };
    let soonestCooldownAt = 0;

    for (const model of pool) {
        for (const apiKey of keys) {
            if (_isQwenRuntimeUnsupported(model, role)) {
                counts.unsupported++;
                continue;
            }

            const health = _getQwenHealthRecord(apiKey, model, _qwenLaneForModel(model));
            const healthReason = _qwenHealthSkipReason(health);
            if (healthReason) {
                if (Object.prototype.hasOwnProperty.call(counts, healthReason)) counts[healthReason]++;
                else counts.other++;
                continue;
            }

            const state = _getKeyExhaustion(apiKey, role)[model];
            if (!state) {
                counts.available++;
            } else if (state === true) {
                counts.exhausted++;
            } else if (Number(state) > now) {
                counts.cooldown++;
                if (!soonestCooldownAt || Number(state) < soonestCooldownAt) soonestCooldownAt = Number(state);
            } else {
                counts.available++;
            }
        }
    }

    if (counts.available > 0) return '';

    const roleLabel = role === 'omni' ? 'Omni' : 'image';
    const total = Math.max(1, keys.length * pool.length);
    const transientCount = counts.timeout + counts.network + counts.rate_limited + counts.transient + counts.cooldown;
    const selfHostedBase = String(config.qwen?.baseUrl || process.env.QWEN_BASE_URL || '').trim();
    const isSelfHosted = selfHostedBase && !/dashscope/i.test(selfHostedBase);

    if (transientCount > 0) {
        const reasons = [];
        if (counts.timeout) reasons.push('timeouts');
        if (counts.network) reasons.push('network errors');
        if (counts.rate_limited) reasons.push('rate limits');
        if (counts.transient || counts.cooldown) reasons.push('cooldowns');
        const wait = soonestCooldownAt > now ? `; next retry in about ${Math.ceil((soonestCooldownAt - now) / 1000)}s` : '';
        const mixed = counts.exhausted || counts.unsupported || counts.invalid_key || counts.bad_param
            ? ` (${transientCount}/${total} transient, ${counts.exhausted}/${total} quota-exhausted, ${counts.unsupported}/${total} unsupported)`
            : '';
        const boxHint = isSelfHosted
            ? ` Check the self-hosted Qwen vision box at ${selfHostedBase}; it may be down, still booting, or overloaded.`
            : '';
        return `All Qwen ${roleLabel} model/key combos are temporarily unavailable after ${reasons.join(', ') || 'transient failures'}${wait}${mixed}.${boxHint}`;
    }

    if (counts.exhausted === total) {
        return `All Qwen ${roleLabel}-capable models exhausted across all API keys - no quota left`;
    }
    if (counts.unsupported === total) {
        return `All Qwen ${roleLabel}-capable models are unsupported by the configured endpoint`;
    }
    if (counts.invalid_key + counts.bad_param === total) {
        return `All Qwen ${roleLabel} keys/models are unusable due to invalid-key or bad-parameter errors`;
    }

    return `No Qwen ${roleLabel} model/key combo is currently usable (${counts.exhausted}/${total} quota-exhausted, ${counts.unsupported}/${total} unsupported, ${counts.invalid_key + counts.bad_param}/${total} invalid/bad-param, ${counts.other}/${total} other)`;
}

/**
 * Get pool status across all keys for a given role. Reads the role-scoped
 * exhaustion bucket only.
 */
function _getPoolStatus(pool, role = 'vision') {
    const keys = _getQwenKeys(role);
    let totalAvailable = 0;
    let totalVerifiedOk = 0;
    const perKey = [];
    for (let i = 0; i < keys.length; i++) {
        let available = 0;
        let verifiedOk = 0;
        let healthSkipped = 0;
        for (const m of pool) {
            const health = _getQwenHealthRecord(keys[i], m, _qwenLaneForModel(m));
            if (health?.status === 'ok' && _isFreshQwenHealth(health)) verifiedOk++;
            else if (_qwenHealthSkipReason(health)) healthSkipped++;
            if (_isModelAvailable(m, keys[i], role)) available++;
        }
        totalAvailable += available;
        totalVerifiedOk += verifiedOk;
        perKey.push({ keyIndex: i + 1, keyTail: _qwenKeyTail(keys[i]), available, total: pool.length, verifiedOk, healthSkipped });
    }
    return { available: totalAvailable, total: pool.length * keys.length, verifiedOk: totalVerifiedOk, perKey };
}

function _getInactiveQwenTrackingSummary(role = 'vision') {
    const activeHashes = new Set(_getQwenKeys(role).map(k => _hashApiKey(k)).filter(Boolean));
    const bucketName = role === 'text' ? 'text' : role === 'omni' ? 'omni' : 'image';
    const bucket = _perKeyExhaustion[bucketName] || {};
    let inactiveKeys = 0;
    let inactiveModelMarks = 0;
    for (const [hash, records] of Object.entries(bucket || {})) {
        if (activeHashes.has(hash)) continue;
        inactiveKeys++;
        inactiveModelMarks += Object.keys(records || {}).length;
    }
    return { inactiveKeys, inactiveModelMarks };
}

function _buildQwenVisionDiagnostics(status) {
    const warnings = [];
    const recommendations = [];
    const now = Date.now();
    const updatedAt = status?.health?.updatedAt ? Date.parse(status.health.updatedAt) : 0;
    if (!updatedAt) {
        warnings.push('No live health probe recorded yet.');
        recommendations.push('Run `node scripts/qwen-vision-status.js --live` after changing keys.');
    } else if (Number.isFinite(updatedAt) && now - updatedAt > status.health.freshMs) {
        const ageMin = Math.round((now - updatedAt) / 60000);
        warnings.push(`Health probe is stale (${ageMin} min old).`);
        recommendations.push('Run a live probe before long builds or keep QWEN_PREFLIGHT=1.');
    }

    for (const img of status?.image?.perKey || []) {
        if (img.available === 0) {
            warnings.push(`Image key ${img.keyIndex} (...${img.keyTail || 'unknown'}) has no available Image/VL models.`);
            recommendations.push(`Keep that physical key in the Omni lane if it still has multimodal quota; remove it only from Image/VL keys.`);
        } else if (img.verifiedOk === 0) {
            warnings.push(`Image key ${img.keyIndex} (...${img.keyTail || 'unknown'}) has no fresh live-verified Image/VL model.`);
        }
    }
    for (const omni of status?.omniHttp?.perKey || []) {
        if (omni.available === 0) {
            warnings.push(`Omni key ${omni.keyIndex} (...${omni.keyTail || 'unknown'}) has no available Omni HTTP models.`);
        } else if (omni.verifiedOk === 0) {
            warnings.push(`Omni key ${omni.keyIndex} (...${omni.keyTail || 'unknown'}) has no fresh live-verified Omni HTTP model.`);
        }
    }

    if ((status?.image?.available || 0) === 0) {
        warnings.push('No Qwen image/VL capacity is currently available.');
        recommendations.push('Add a fresh QWEN_IMAGE_API_KEY/QWEN_VL_API_KEY for image scoring; keep older keys in QWEN_OMNI_API_KEY if their Omni quota is still alive.');
    }

    const inactiveImage = _getInactiveQwenTrackingSummary('image');
    const inactiveOmni = _getInactiveQwenTrackingSummary('omni');
    const inactive = {
        inactiveKeys: inactiveImage.inactiveKeys + inactiveOmni.inactiveKeys,
        inactiveModelMarks: inactiveImage.inactiveModelMarks + inactiveOmni.inactiveModelMarks,
        image: inactiveImage,
        omni: inactiveOmni,
    };
    if (inactive.inactiveKeys > 0) {
        warnings.push(`${inactive.inactiveKeys} old Qwen lane key record(s) remain in local tracking (${inactive.inactiveModelMarks} model marks).`);
        recommendations.push('This is harmless for current keys, but you can delete .qwen-exhausted-models.json if you want a clean dashboard.');
    }

    return { warnings: [...new Set(warnings)], recommendations: [...new Set(recommendations)], inactiveTracking: inactive };
}

function getQwenVisionStatus() {
    _refreshQwenRuntimeConfig({ force: true });
    const health = _loadQwenHealth(true);
    const keys = _getQwenKeys('vision');
    const imageKeys = _getQwenKeys('image');
    const omniKeys = _getQwenKeys('omni');
    const omniRealtimeStatus = _getPoolStatus(QWEN_OMNI_REALTIME_POOL, 'omni');
    const status = {
        keys: keys.length,
        keyTails: keys.map(_qwenKeyTail),
        imageKeys: imageKeys.length,
        imageKeyTails: imageKeys.map(_qwenKeyTail),
        omniKeys: omniKeys.length,
        omniKeyTails: omniKeys.map(_qwenKeyTail),
        sharedKeys: (config.qwen?.visionApiKeys || []).length,
        sharedKeyTails: (config.qwen?.visionApiKeys || []).map(_qwenKeyTail),
        endpoint: config.qwen?.baseUrl || '',
        visionModel: config.qwen?.visionModel || '',
        registry: {
            file: _qwenGeneratedPoolsPath,
            source: QWEN_GENERATED_POOLS.source || 'static',
            generatedAt: QWEN_GENERATED_POOLS.generatedAt || null,
            catalogCount: QWEN_GENERATED_POOLS.catalogCount || 0,
            imageModels: QWEN_IMAGE_POOL.length,
            omniHttpModels: QWEN_OMNI_HTTP_POOL.length,
            omniRealtimeModels: QWEN_OMNI_REALTIME_POOL.length,
        },
        health: {
            file: _qwenHealthFile,
            updatedAt: health.updatedAt || null,
            freshMs: QWEN_HEALTH_FRESH_MS,
            transientMs: QWEN_HEALTH_TRANSIENT_MS,
        },
        image: _getPoolStatus(QWEN_IMAGE_POOL, 'image'),
        omniHttp: _getPoolStatus(QWEN_OMNI_HTTP_POOL, 'omni'),
        omniRealtime: {
            transport: 'websocket-required',
            ...omniRealtimeStatus,
            totalPerKey: QWEN_OMNI_REALTIME_POOL.length,
            totalAcrossKeys: QWEN_OMNI_REALTIME_POOL.length * omniKeys.length,
            activeInCurrentRuntime: QWEN_OMNI_REALTIME_ENABLED,
        },
        omniUnsupportedOpenAI: {
            totalPerKey: QWEN_OMNI_OPENAI_UNSUPPORTED_POOL.length,
            totalAcrossKeys: QWEN_OMNI_OPENAI_UNSUPPORTED_POOL.length * omniKeys.length,
        },
    };
    status.diagnostics = _buildQwenVisionDiagnostics(status);
    return status;
}

function _isQwenOmniUsable() {
    if (!QWEN_OMNI_HTTP_ENABLED) return false;
    if (Date.now() < _qwenOmniLaneCooldownUntil) return false;
    const keys = _getQwenKeys('omni');
    if (keys.length === 0) return false;
    const configuredModel = process.env.QWEN_OMNI_MODEL || 'qwen-omni-turbo';
    return _getBestKeyAndModel(QWEN_OMNI_POOL, configuredModel, 'omni') !== null;
}

function _cooldownQwenOmniLane(reason) {
    _qwenOmniLaneCooldownUntil = Math.max(_qwenOmniLaneCooldownUntil, Date.now() + QWEN_OMNI_LANE_COOLDOWN_MS);
    _qwenOmniTransientWindowStartedAt = 0;
    _qwenOmniTransientBurst = 0;
    console.log(`  ⏸️ [qwen-omni] lane cooldown ${Math.round(QWEN_OMNI_LANE_COOLDOWN_MS / 1000)}s (${reason})`);
}

function _recordQwenOmniTransient(reason) {
    const now = Date.now();
    if (!_qwenOmniTransientWindowStartedAt || now - _qwenOmniTransientWindowStartedAt > QWEN_OMNI_TRANSIENT_WINDOW_MS) {
        _qwenOmniTransientWindowStartedAt = now;
        _qwenOmniTransientBurst = 0;
    }
    _qwenOmniTransientBurst++;
    if (_qwenOmniTransientBurst >= QWEN_OMNI_TRANSIENT_LIMIT) {
        _cooldownQwenOmniLane(`${_qwenOmniTransientBurst} ${reason} failures in ${Math.round(QWEN_OMNI_TRANSIENT_WINDOW_MS / 1000)}s`);
        return true;
    }
    return false;
}

// ── Self-hosted vision concurrency limiter ──────────────────────────────────────────────
// A cloudflared tunnel (Lightning backend) rate-limits / 524-times-out under the build's
// parallel vision flood (hundreds of concurrent scoring calls). And with a SINGLE self-hosted
// model, one 429 cools the only combo for 2 min → everything falls to Bedrock. Capping in-flight
// requests keeps the tunnel + the single configured GPU/vLLM under their limit. 0 = unlimited (a direct-IP
// AWS box needs no cap). QWEN_VISION_MAX_CONCURRENCY is auto-set to a safe value for Lightning.
let _visionInFlight = 0;
const _visionWaiters = [];
// QWEN_VISION_MAX_CONCURRENCY named the limiter after the only lane that used it.
// The cap itself is provider-neutral — it counts in-flight vision calls, and every
// backend with ONE deployment behind it has the same problem the Qwen box had.
// VISION_MAX_CONCURRENCY is the backend-agnostic spelling; the Qwen name still wins
// when set, so the Lightning auto-config in config.js keeps working byte-for-byte.
function _visionConfiguredConcurrency() {
    const raw = process.env.QWEN_VISION_MAX_CONCURRENCY || process.env.VISION_MAX_CONCURRENCY || '0';
    return parseInt(raw, 10) || 0;
}

// The configured cap is the box's ADVERTISED capacity (vLLM's MAX_NUM_SEQS),
// not what it sustains for this build's prompt sizes on this GPU on this run.
// When our own requests start timing out, we are the ones overloading it — so
// the cap floats down; when they flow again it floats back up. Classic
// additive-increase / multiplicative-decrease: slow to trust, quick to back
// off, which is the right asymmetry when guessing high stalls the build on a
// paid fallback. Nothing here is niche- or topic-specific; the only input is
// the box's own behaviour during this run.
let _visionAdaptiveCap = 0;
let _visionOkStreak = 0;
function _visionConcurrencyLimit() {
    const configured = _visionConfiguredConcurrency();
    if (configured <= 0) return 0;
    if (_visionAdaptiveCap <= 0 || _visionAdaptiveCap > configured) _visionAdaptiveCap = configured;
    return _visionAdaptiveCap;
}
function _narrowVisionConcurrency(why) {
    if (_visionConfiguredConcurrency() <= 0) return;
    const before = _visionConcurrencyLimit();
    if (before <= 1) return;
    _visionAdaptiveCap = Math.max(1, Math.floor(before / 2));
    _visionOkStreak = 0;
    console.log(`  🎚️ [Qwen Image] easing off the box: ${before} → ${_visionAdaptiveCap} in flight (${why})`);
}
function _widenVisionConcurrency() {
    const configured = _visionConfiguredConcurrency();
    if (configured <= 0) return;
    const current = _visionConcurrencyLimit();
    if (current >= configured) { _visionOkStreak = 0; return; }
    // One clean pass per open slot before asking for another one back.
    if (++_visionOkStreak < current * 3) return;
    _visionAdaptiveCap = current + 1;
    _visionOkStreak = 0;
    console.log(`  🎚️ [Qwen Image] box keeping up: ${current} → ${_visionAdaptiveCap} in flight`);
}
function _isLightningVisionRuntime() {
    return String(process.env.VISION_BACKEND || '').toLowerCase() === 'lightning';
}

/**
 * Are we scoring against a box WE rent (Lightning studio / the AWS GPU
 * instance), rather than a hosted multi-tenant API?
 *
 * The URL is authoritative when we have one — `config.qwen.baseUrl` is the
 * cached object `_applyUrl()` pushes the ephemeral tunnel URL into, and it is
 * what the call sites actually read. Backend name is only the fallback.
 */
function _isSelfHostedVisionRuntime() {
    const url = String(config.qwen?.baseUrl || process.env.QWEN_BASE_URL || '').toLowerCase();
    if (url) return !/aliyuncs\.com|dashscope|openrouter|siliconflow|api\.together/.test(url);
    const backend = String(process.env.VISION_BACKEND || '').toLowerCase();
    return backend === 'lightning' || backend === 'aws';
}

/** A busy signal from our own box — the queue is full, not the quota. */
function _isVisionBackpressure(err) {
    return VISION_BACKPRESSURE_STATUSES.has(err?.response?.status) && _isSelfHostedVisionRuntime();
}

/**
 * A timeout from a box WE rent is the same signal as a 429 — the queue is deep,
 * not the box dead. vLLM under load simply doesn't answer inside the window; it
 * has no spare capacity to send a status code with.
 *
 * Treating it as death is expensive because there is exactly ONE of these boxes:
 * the timeout benched the only key+model combo for 30s, which made every other
 * in-flight scoring call fail instantly with "all combos unavailable" and drop
 * to paid Bedrock. In one 67-scene run that turned a handful of real timeouts
 * into 61 failures, two multi-minute stalls, and not a single successful GPU
 * score — while the box itself answered a probe in 2.4s.
 */
function _isSelfHostedVisionTimeout(err) {
    if (!_isSelfHostedVisionRuntime()) return false;
    return err?.code === 'ECONNABORTED'
        || err?.code === 'ETIMEDOUT'
        || /timeout/i.test(String(err?.message || ''));
}
function _qwenVisionRequestTimeoutMs() {
    const defaultMs = _isLightningVisionRuntime() ? 45_000 : 25_000;
    const configured = parseInt(process.env.QWEN_VISION_REQUEST_TIMEOUT_MS || String(defaultMs), 10) || defaultMs;
    return Math.max(5_000, Math.min(120_000, configured));
}
function _releaseVisionSlot() {
    // Always give the slot back first, then admit as many waiters as the CURRENT
    // cap allows. Handing our slot straight to the next waiter (the old shape)
    // meant a narrowed cap never took effect — the same number of requests kept
    // flowing no matter how hard the box was struggling.
    _visionInFlight = Math.max(0, _visionInFlight - 1);
    const limit = _visionConcurrencyLimit();
    while (_visionWaiters.length && (limit <= 0 || _visionInFlight < limit)) {
        _visionInFlight++;
        _visionWaiters.shift()();
    }
}
async function _acquireVisionSlot() {
    const limit = _visionConcurrencyLimit();
    if (limit <= 0) return () => {};
    if (_visionInFlight < limit) { _visionInFlight++; return _releaseVisionSlot; }
    await new Promise((res) => _visionWaiters.push(res)); // a slot is handed to us on resume
    return _releaseVisionSlot;
}

/**
 * Call Qwen VL with multi-key auto-rotation through model pool.
 * Each API key has independent model exhaustion tracking.
 * Primary key is used first; fallback keys activate only when primary's pool is fully exhausted.
 * On quota/rate error → rotate model (same key) → if all models dead → next key from top of pool.
 * Wrapped by a concurrency limiter so a tunnelled self-hosted endpoint isn't flooded.
 */
async function _qwenVisionWithRotation(prompt, base64Image, mimeType, maxTokens) {
    const release = await _acquireVisionSlot();
    try { return await _qwenVisionWithRotationInner(prompt, base64Image, mimeType, maxTokens); }
    finally { release(); }
}

async function _qwenVisionWithRotationInner(prompt, base64Image, mimeType, maxTokens) {
    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const configuredModel = config.qwen.visionModel;
    const allKeys = _getQwenKeys('image');
    if (allKeys.length === 0) throw new Error('No Qwen image/VL API keys configured (set QWEN_IMAGE_API_KEY, QWEN_VL_API_KEY, or QWEN_VISION_API_KEY)');

    // Track what we've tried across all keys to avoid infinite loops
    const triedCombos = new Set(); // "keyHash:model"
    const maxAttempts = allKeys.length * (QWEN_IMAGE_POOL.length + 1);

    // Fast-fail guard: abort Qwen only after timeouts span enough distinct
    // keys. This preserves the "fresh key rescue" behavior: Key 1/2 can stall
    // without preventing Key 3 from being tried on long builds.
    let consecutiveTimeouts = 0;
    const timeoutKeyHashes = new Set();
    const defaultTimeoutKeyThreshold = Math.max(1, Math.min(allKeys.length, 4));
    const QWEN_VISION_TIMEOUT_KEY_THRESHOLD = Math.max(
        1,
        Math.min(allKeys.length, parseInt(process.env.QWEN_IMAGE_FAST_FAIL_TIMEOUT_KEYS || String(defaultTimeoutKeyThreshold), 10) || defaultTimeoutKeyThreshold)
    );

    // Request defects (HTTP 400) seen during THIS one call. They describe the
    // payload we uploaded, so they never bench a combo — but if every combo
    // rejects the same payload we must say so plainly rather than blaming the
    // pool's capacity, which is what sent a whole build to paid Bedrock.
    const requestDefects = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Find best available key+model combo (vision pool). Passing `triedCombos`
        // advances the rotation WITHOUT benching anything in global state.
        const combo = _getBestKeyAndModel(QWEN_IMAGE_POOL, configuredModel, 'image', triedCombos);
        if (!combo) {
            if (requestDefects.length) {
                throw new Error(`Qwen vision rejected this request — ${requestDefects[0]}`
                    + ` (${requestDefects.length} combo(s) agreed; the box is healthy, the payload is not)`);
            }
            throw new Error(_describeQwenPoolUnavailable(QWEN_IMAGE_POOL, 'image')
                || 'All Qwen image-capable models exhausted across all API keys - no quota left');
        }

        const { apiKey, model, keyIndex } = combo;
        const comboKey = `${_hashApiKey(apiKey)}:${model}`;
        // Defensive only — the selector above already excludes tried combos.
        if (triedCombos.has(comboKey)) break;
        triedCombos.add(comboKey);

        // Pace DashScope calls so the candidate race's parallel vision scores don't
        // burst past the free-tier RPM → 429 → 2-min benches → pool depletes → paid
        // Bedrock. The RPM guard keeps the free pool alive (QWEN_VISION_MAX_RPM, 0=off).
        await _throttleQwenVision();

        try {
            // QVQ models REQUIRE stream:true — non-streaming returns 400
            const isQvq = model.startsWith('qvq');
            const body = {
                model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                    ]
                }],
                max_tokens: maxTokens,
            };
            if (isQvq) body.stream = true;

            let text = '';
            if (isQvq) {
                // Stream response — collect chunks
                const response = await axios.post(`${baseUrl}/chat/completions`, body, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000,
                    responseType: 'text',
                });
                const lines = (response.data || '').split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
                    try {
                        const chunk = JSON.parse(line.slice(6));
                        const delta = chunk.choices?.[0]?.delta?.content || '';
                        text += delta;
                    } catch (_) { /* skip malformed chunks */ }
                }
            } else {
                // Quick in-place retry for connection-reset blips (ECONNRESET / EPIPE /
                // "socket hang up"). These are momentary drops when many parallel scoring
                // calls flood the (often self-hosted) endpoint at once — the server is
                // healthy, the connection just got reset. Retrying the SAME combo a couple
                // times beats cooling the lane and cascading to the Bedrock fallback chain.
                // Does NOT retry ECONNREFUSED (server actually down) or timeouts.
                const netRetries = QWEN_VISION_NET_RETRIES;
                let response;
                for (let r = 0; ; r++) {
                    try {
                        response = await axios.post(`${baseUrl}/chat/completions`, body, {
                            headers: {
                                'Authorization': `Bearer ${apiKey}`,
                                'Content-Type': 'application/json'
                            },
                            timeout: _qwenVisionRequestTimeoutMs(),
                        });
                        break;
                    } catch (e) {
                        const resetLike = e.code === 'ECONNRESET' || e.code === 'EPIPE'
                            || /socket hang up|ECONNRESET/i.test(String(e.message || ''));
                        // Backpressure from our own box gets a longer ladder than a
                        // connection blip: the queue genuinely needs seconds to
                        // drain, and waiting for it is strictly cheaper than
                        // benching the only combo we have and paying Bedrock.
                        const busy = _isVisionBackpressure(e);
                        // Same ladder for a timeout on our own box: it means the
                        // queue is deep, and easing off is strictly cheaper than
                        // benching the only combo we have and paying Bedrock for
                        // the rest of the build.
                        const slowBox = _isSelfHostedVisionTimeout(e);
                        if (slowBox) _narrowVisionConcurrency('request timed out');
                        const queued = busy || slowBox;
                        const tries = queued ? Math.max(netRetries, QWEN_VISION_BUSY_RETRIES) : netRetries;
                        if ((resetLike || queued) && r < tries) {
                            const backoff = queued
                                ? QWEN_VISION_BUSY_BACKOFF_MS[Math.min(r, QWEN_VISION_BUSY_BACKOFF_MS.length - 1)]
                                : [250, 600][Math.min(r, 1)];
                            const reason = busy ? `server busy (${e.response?.status})`
                                : slowBox ? 'box queue deep (timeout)'
                                : 'connection reset';
                            console.log(`  🔁 [Qwen Image] ${reason} on ${model} — quick retry ${r + 1}/${tries} in ${backoff}ms (staying on box)`);
                            await new Promise(res => setTimeout(res, backoff));
                            continue;
                        }
                        throw e;
                    }
                }
                text = response.data?.choices?.[0]?.message?.content || '';
            }

            if (text.trim()) {
                _recordQwenModelHealth(apiKey, model, 'image', 'ok', { source: 'runtime' });
                if (model !== configuredModel || keyIndex > 1) {
                    console.log(`  👁️ [Qwen Image] Key ${keyIndex}, model: ${model}`);
                }
                consecutiveTimeouts = 0; // success resets the streak
                timeoutKeyHashes.clear();
                _widenVisionConcurrency(); // the box is coping — hand a slot back
                return text;
            }
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
            const isNetwork = _isTransientNetworkError(err) && !isTimeout;
            const transportUnsupported = _isQwenTransportUnsupportedError(err);
            const quotaErr = transportUnsupported ? null : _isQuotaError(err);
            const requestDefect = transportUnsupported ? null : _isRequestDefectError(err);
            if (transportUnsupported) {
                _markQwenRuntimeUnsupported(model, err, 'image');
                _setQwenHealthRecord(apiKey, model, 'image', 'unsupported', {
                    httpStatus: err?.response?.status || 0,
                    message: err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || '',
                    source: 'runtime',
                });
                consecutiveTimeouts = 0;
                timeoutKeyHashes.clear();
                continue;
            }
            if (requestDefect) {
                // OUR payload, not THEIR capacity. Rotate to another combo for this
                // one frame, but do NOT bench, and do NOT write a sticky `bad_param`
                // health record — that would sideline a healthy combo through a
                // different door and reproduce the exact bug this branch removes.
                requestDefects.push(requestDefect);
                console.log(`  ✋ [Qwen Image] Key ${keyIndex} rejected this request on ${model} — ${requestDefect}`);
                const said = _qwenErrorText(err).slice(0, 300);
                if (said) console.log(`     box said: ${said}`);
                consecutiveTimeouts = 0;
                timeoutKeyHashes.clear();
                continue;
            }
            if (quotaErr || isTimeout || isNetwork) {
                if (isTimeout) {
                    console.log(`  ⏱️ [Qwen Image] Key ${keyIndex} timeout on ${model} — rotating`);
                    // Mark cooldown IMMEDIATELY (consistent with the text path
                    // at line ~1888). Without this, the next iteration of
                    // _getBestKeyAndModel returns the same combo, wastes a
                    // call, then triedCombos marks it. Marking up-front skips
                    // the wasted iteration so we reach the next model faster.
                    _markModelExhausted(model, 'timeout', apiKey, 'image');
                    consecutiveTimeouts++;
                    timeoutKeyHashes.add(_hashApiKey(apiKey));
                    if (timeoutKeyHashes.size >= QWEN_VISION_TIMEOUT_KEY_THRESHOLD) {
                        // Whole Qwen vision lane is stalling — bail out so
                // callVisionAI's outer fallback picks up Bedrock.
                        console.log(`  ⛔ [Qwen Image] timeouts on ${timeoutKeyHashes.size}/${allKeys.length} key(s), ${consecutiveTimeouts} total — falling back to next vision provider`);
                        throw new Error(`Qwen vision fast-fail: ${timeoutKeyHashes.size} key(s) timed out`);
                    }
                } else if (isNetwork) {
                    console.log(`  🌐 [Qwen Image] Key ${keyIndex} network error (${err.code || err.message}) on ${model} — rotating`);
                    _markModelExhausted(model, 'network', apiKey, 'image');
                    consecutiveTimeouts = 0;
                    timeoutKeyHashes.clear();
                } else {
                    _markModelExhausted(model, quotaErr, apiKey, 'image');
                    consecutiveTimeouts = 0;
                    timeoutKeyHashes.clear();
                }
                continue; // try next model or next key
            }
            throw err; // non-quota error — bubble up
        }
    }

    throw new Error(_describeQwenPoolUnavailable(QWEN_IMAGE_POOL, 'image')
        || 'All Qwen image-capable models failed across all keys');
}

/**
 * Call Qwen Omni with multi-key auto-rotation through model pool.
 * Same multi-key logic as VL pool — each key has independent exhaustion tracking.
 * Shares the global vision concurrency limiter (same tunnel/box as the image lane).
 */
async function _qwenOmniWithRotation(content, maxTokens, configuredModel) {
    const release = await _acquireVisionSlot();
    try { return await _qwenOmniWithRotationInner(content, maxTokens, configuredModel); }
    finally { release(); }
}

async function _qwenOmniWithRotationInner(content, maxTokens, configuredModel) {
    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    // Omni (multi-frame video) is a vision-side feature — uses the vision pool.
    const allKeys = _getQwenKeys('omni');
    if (allKeys.length === 0) throw new Error('No Qwen Omni API keys configured (set QWEN_OMNI_API_KEY or QWEN_VISION_API_KEY)');

    const triedCombos = new Set();
    const maxAttempts = allKeys.length * (QWEN_OMNI_POOL.length + 1);
    let transientFailures = 0;
    // HTTP 400s seen in this call — payload faults, never benched. See _isRequestDefectError.
    const requestDefects = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (Date.now() < _qwenOmniLaneCooldownUntil) {
            throw new Error('Qwen Omni lane is cooling down after transient failures');
        }
        // `triedCombos` advances the rotation without benching — see _getBestKeyAndModel.
        const combo = _getBestKeyAndModel(QWEN_OMNI_POOL, configuredModel, 'omni', triedCombos);
        if (!combo) {
            if (requestDefects.length) {
                throw new Error(`Qwen Omni rejected this request — ${requestDefects[0]}`
                    + ` (${requestDefects.length} combo(s) agreed; the payload is the problem, not the pool)`);
            }
            throw new Error('All Qwen Omni models exhausted across all API keys');
        }

        const { apiKey, model, keyIndex } = combo;
        const comboKey = `${_hashApiKey(apiKey)}:${model}`;
        // Defensive only — the selector above already excludes tried combos.
        if (triedCombos.has(comboKey)) break;
        triedCombos.add(comboKey);

        try {
            // Qwen Omni plus/turbo/2.5-7b variants reject max_tokens < 10 with
            // a 400 "Range of max_tokens should be [10, ...]" — clamp to ≥10
            // so the rotation can reach those models on small-output tasks.
            const safeMaxTokens = Math.max(10, Number(maxTokens) || 10);
            const response = await axios.post(`${baseUrl}/chat/completions`, {
                model,
                messages: [{ role: 'user', content }],
                max_tokens: safeMaxTokens,
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            });

            const text = response.data?.choices?.[0]?.message?.content || '';
            if (text.trim()) {
                _recordQwenModelHealth(apiKey, model, 'omniHttp', 'ok', { source: 'runtime' });
                if (model !== configuredModel || keyIndex > 1) {
                    console.log(`  🎥 [Qwen Omni] Key ${keyIndex}, model: ${model}`);
                }
                return text;
            }
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
            const isNetwork = _isTransientNetworkError(err) && !isTimeout;
            const transportUnsupported = _isQwenTransportUnsupportedError(err);
            const quotaErr = transportUnsupported ? null : _isQuotaError(err);
            if (transportUnsupported) {
                _markQwenRuntimeUnsupported(model, err, 'omni');
                _setQwenHealthRecord(apiKey, model, 'omniHttp', 'unsupported', {
                    httpStatus: err?.response?.status || 0,
                    message: err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || '',
                    source: 'runtime',
                });
                transientFailures = 0;
                continue;
            }
            if (!transportUnsupported) {
                const requestDefect = _isRequestDefectError(err);
                if (requestDefect) {
                    // Payload fault — rotate for this call, never bench the combo and
                    // never write a sticky health record. Same rule as the image lane.
                    requestDefects.push(requestDefect);
                    console.log(`  ✋ [Qwen Omni] Key ${keyIndex} rejected this request on ${model} — ${requestDefect}`);
                    const said = _qwenErrorText(err).slice(0, 300);
                    if (said) console.log(`     server said: ${said}`);
                    transientFailures = 0;
                    continue;
                }
            }
            if (quotaErr || isTimeout || isNetwork) {
                if (isTimeout) console.log(`  ⏱️ [Qwen Omni] Key ${keyIndex} timeout on ${model} — rotating`);
                else if (isNetwork) console.log(`  🌐 [Qwen Omni] Key ${keyIndex} network error (${err.code || err.message}) on ${model} — rotating`);

                let transientReason = null;
                if (isTimeout) {
                    _markModelExhausted(model, 'timeout', apiKey, 'omni');
                    transientReason = 'timeout';
                } else if (isNetwork) {
                    _markModelExhausted(model, 'network', apiKey, 'omni');
                    transientReason = 'network';
                } else if (quotaErr === 'rate_limited') {
                    _markModelExhausted(model, quotaErr, apiKey, 'omni');
                    transientReason = 'rate-limit';
                } else {
                    _markModelExhausted(model, quotaErr, apiKey, 'omni');
                }

                if (transientReason) {
                    transientFailures++;
                    const globalCooldown = _recordQwenOmniTransient(transientReason);
                    if (globalCooldown || transientFailures >= QWEN_OMNI_TRANSIENT_LIMIT) {
                        if (!globalCooldown) _cooldownQwenOmniLane(`${transientFailures} transient failures in one call`);
                        throw new Error(`Qwen Omni fast-fail: ${transientFailures} transient failures`);
                    }
                }
                continue;
            }
            throw err;
        }
    }

    throw new Error('All Qwen Omni models failed across all keys');
}

function _qwenRealtimeUrl(model) {
    if (process.env.QWEN_REALTIME_URL) {
        const sep = process.env.QWEN_REALTIME_URL.includes('?') ? '&' : '?';
        return `${process.env.QWEN_REALTIME_URL}${sep}model=${encodeURIComponent(model)}`;
    }
    const base = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    let host = 'dashscope-intl.aliyuncs.com';
    try { host = new URL(base).host; } catch (_) {}
    if (host.includes('dashscope.aliyuncs.com') && !host.includes('intl')) {
        return `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
    }
    return `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}

function _qwenRealtimeEvent(type, body = {}) {
    return {
        event_id: `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        ...body,
    };
}

function _silentPcmBase64(ms = 120) {
    const samples = Math.max(1600, Math.round(16000 * (ms / 1000)));
    return Buffer.alloc(samples * 2).toString('base64');
}

function _base64Bytes(value) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    const text = String(value || '').trim();
    const data = text.includes(',') && /^data:/i.test(text) ? text.split(',').pop() : text;
    return Buffer.from(data || '', 'base64');
}

let _visionFfmpegPath;
function _visionFfmpeg() {
    if (_visionFfmpegPath !== undefined) return _visionFfmpegPath;
    try {
        const p = require('ffmpeg-static');
        _visionFfmpegPath = (p && require('fs').existsSync(p)) ? p : false;
    } catch (_) {
        _visionFfmpegPath = false;
    }
    if (!_visionFfmpegPath) {
        _visionFfmpegPath = process.env.FFMPEG_PATH
            || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
    }
    return _visionFfmpegPath;
}

/**
 * Last-resort decode for bytes @napi-rs/canvas refuses.
 *
 * The canvas decoder is strict: a frame that is truncated, in an unusual pixel
 * format, or wrapped in a container it doesn't know comes back as a throw. The
 * old catch then shipped those raw bytes onward still LABELLED image/jpeg, so
 * every model in the chain rejected them in turn — 54 "not a recognizable
 * jpeg/png" errors in the 2026-07-31 build (18 distinct images × 3 models),
 * every one of them a paid call that could not have succeeded. All 18 came from
 * video lanes (YouTube 10, Pexels 3, Reddit 1), i.e. extracted frames.
 *
 * ffmpeg decodes a far wider range than the canvas library, including partial
 * frames, so most of those images are recoverable rather than lost.
 *
 * @returns {Promise<Buffer|null>} JPEG bytes, or null if even ffmpeg can't read it
 */
async function _ffmpegDecodeToJpeg(raw, maxSide, quality = 4) {
    const bin = _visionFfmpeg();
    if (!bin) return null;
    return new Promise((resolve) => {
        let child;
        try {
            child = require('child_process').spawn(bin, [
                '-hide_banner', '-loglevel', 'error',
                '-i', 'pipe:0',
                '-frames:v', '1',
                // Only shrink; never upscale a small frame into a big soft one.
                '-vf', `scale='min(${maxSide},iw)':-2`,
                '-q:v', String(quality),
                '-f', 'mjpeg', 'pipe:1',
            ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (_) {
            return resolve(null);
        }
        const chunks = [];
        let settled = false;
        const done = (val) => { if (!settled) { settled = true; resolve(val); } };
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} done(null); }, 15_000);
        child.stdout.on('data', (d) => chunks.push(d));
        child.stderr.on('data', () => {});
        child.on('error', () => { clearTimeout(timer); done(null); });
        child.on('close', () => {
            clearTimeout(timer);
            const out = Buffer.concat(chunks);
            // Validate the SHAPE, not the size. A byte-count floor is a guess: a
            // small or flat frame compresses to a few hundred bytes and was being
            // discarded as "failed" even though ffmpeg had decoded it perfectly.
            // A JPEG SOI marker is the actual proof that a frame came out.
            const isJpeg = out.length > 100
                && out[0] === 0xff && out[1] === 0xd8 && out[2] === 0xff;
            done(isJpeg ? out : null);
        });
        // A truncated source makes ffmpeg exit before draining stdin; that EPIPE
        // is expected and must not crash the build.
        child.stdin.on('error', () => {});
        try { child.stdin.end(raw); } catch (_) { /* handled above */ }
    });
}

/**
 * ffmpeg rescue, or an explicit "nothing can read this" marker.
 *
 * Shared by BOTH ways we get here: the in-process decoder threw, or we refused
 * to even offer it the bytes (see _normalizeVisionImage's pre-flight sniff).
 *
 * @returns {Promise<object>} a normalized-image result
 */
async function _rescueVisionFrame(raw, maxSide, mimeType, reason) {
    const rescued = await _ffmpegDecodeToJpeg(raw, maxSide);
    if (rescued) {
        console.log(`  [vision] ffmpeg rescued the frame — ${Math.round(rescued.length / 1024)}KB JPEG`);
        return {
            base64: rescued.toString('base64'),
            mimeType: 'image/jpeg',
            bytes: rescued.length,
            changed: true,
            rescued: true,
        };
    }

    // Nothing can read these bytes. Shipping them anyway is a guaranteed
    // failure at EVERY provider in the chain — 3 paid calls that cannot
    // succeed — so hand back an explicit "unreadable" marker and let the
    // caller stop. This is a defect in THIS candidate, not a vision outage:
    // callers must not report it as an API failure or one bad frame aborts
    // the whole race (see the score-parse sentinel bug).
    console.log('  [vision] ffmpeg could not read it either — dropping this frame instead of paying for 3 refusals');
    return {
        base64: '',
        mimeType: mimeType || 'image/jpeg',
        bytes: 0,
        changed: false,
        unreadable: true,
        reason,
    };
}

// ── Native decode gate ────────────────────────────────────────────────────────
//
// Scene concurrency and NATIVE IMAGE concurrency are not the same number, and conflating
// them is what broke the 2026-08-31 run: at MEDIA_SCENE_CONCURRENCY=32 the build had up
// to ~160 vision calls in flight, each doing a full-size skia decode, a canvas
// allocation and a JPEG encode. It died after 20 minutes with 0xC0000005
// ACCESS_VIOLATION — a native crash, no exception, nothing to catch, whole build lost.
//
// The exact faulting call was never isolated. Tested and ruled out individually:
// canvas at 256 concurrent, canvas under 6GB of memory pressure, 128 concurrent ffmpeg
// spawns, the specific image it died on, and every image in temp. None reproduce it
// alone, which points at an interaction under full load.
//
// So bound the surface instead of chasing the line. Scene concurrency stays high — that
// is where the speed comes from, and it parallelises downloads, searches and agent calls
// too — while the native decode stays at a level that has never crashed. Everything past
// the gate queues rather than piling into skia at once.
//
// VISION_DECODE_CONCURRENCY tunes it; 0 disables the gate entirely.
const _DECODE_LIMIT = (() => {
    const raw = process.env.VISION_DECODE_CONCURRENCY;
    if (raw !== undefined && String(raw).trim() === '0') return 0;
    return Math.max(1, parseInt(raw, 10) || 8);
})();
let _decodeActive = 0;
const _decodeQueue = [];
function _acquireDecode() {
    if (_DECODE_LIMIT === 0) return Promise.resolve(() => {});
    return new Promise((resolve) => {
        const grant = () => {
            _decodeActive++;
            resolve(() => {
                _decodeActive--;
                const next = _decodeQueue.shift();
                if (next) next();
            });
        };
        if (_decodeActive < _DECODE_LIMIT) grant();
        else _decodeQueue.push(grant);
    });
}

async function _normalizeVisionImage(base64Image, mimeType = 'image/jpeg', options = {}) {
    // Serialise the native work behind the gate; release on every exit path.
    const release = await _acquireDecode();
    try {
        return await _normalizeVisionImageInner(base64Image, mimeType, options);
    } finally {
        release();
    }
}

async function _normalizeVisionImageInner(base64Image, mimeType = 'image/jpeg', options = {}) {
    const raw = _base64Bytes(base64Image);
    if (!raw.length) return { base64: '', mimeType: mimeType || 'image/jpeg', bytes: 0, changed: false };

    const maxBytes = Math.max(120_000, parseInt(String(options.maxBytes || process.env.VISION_IMAGE_MAX_BYTES || '750000'), 10) || 750_000);
    const maxSide = Math.max(320, parseInt(String(options.maxSide || process.env.VISION_IMAGE_MAX_SIDE || '1280'), 10) || 1280);
    // @napi-rs/canvas takes JPEG quality as 0-100, NOT the 0-1 fraction the DOM canvas
    // uses. Passing 0.82 floored to quality 1 and shipped a 19KB smear of a 1600x900
    // frame to the vision model — signs, faces and small subjects were unreadable in
    // every scoring call. Keep the ladder as human-readable percentages.
    const qualities = [82, 74, 66, 58, 50, 42];

    // PRE-FLIGHT SNIFF — this must happen BEFORE loadImage, and no try/catch can
    // replace it. @napi-rs/canvas SEGFAULTS on a TIFF (exit 139, no exception),
    // so a single .jpg URL that actually serves TIFF bytes kills the whole build
    // silently. Unknown formats go to ffmpeg, which usually reads them fine.
    const { isCanvasSafeImage, sniffImageFormat } = require('../util/image-bytes');
    if (!isCanvasSafeImage(raw)) {
        const fmt = sniffImageFormat(raw) || 'unrecognised bytes';
        console.log(`  [vision] ${fmt} is not safe to decode in-process (${Math.round(raw.length / 1024)}KB) — going straight to ffmpeg`);
        return await _rescueVisionFrame(raw, maxSide, mimeType, `${fmt} cannot be decoded in-process`);
    }

    try {
        const { createCanvas, loadImage } = require('@napi-rs/canvas');
        const img = await loadImage(raw);
        const sourceW = img.width || maxSide;
        const sourceH = img.height || maxSide;
        const scale = Math.min(1, maxSide / Math.max(sourceW, sourceH));
        const w = Math.max(2, Math.round(sourceW * scale));
        const h = Math.max(2, Math.round(sourceH * scale));
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        let out = null;
        for (const q of qualities) {
            out = canvas.toBuffer('image/jpeg', q);
            if (out.length <= maxBytes) break;
        }
        return {
            base64: out.toString('base64'),
            mimeType: 'image/jpeg',
            bytes: out.length,
            width: w,
            height: h,
            changed: out.length !== raw.length || w !== sourceW || h !== sourceH || !/jpe?g/i.test(String(mimeType || '')),
        };
    } catch (err) {
        // ALWAYS log. This used to fire only for oversized images, so a small
        // corrupt/truncated frame was passed through still labelled image/jpeg
        // with no trace in the log — the downstream Bedrock 400 ("detected file
        // MIME type application/octet-stream does not match image/jpeg") then
        // looked like it came from nowhere.
        console.log(`  [vision] image normalization failed (${err.message}); ${Math.round(raw.length / 1024)}KB — trying ffmpeg`);
        return await _rescueVisionFrame(raw, maxSide, mimeType, err.message);
    }
}

async function _qwenRealtimeImageBase64(frame) {
    const normalized = await _normalizeVisionImage(frame?.base64 || '', frame?.mimeType || 'image/jpeg', {
        maxBytes: parseInt(process.env.QWEN_OMNI_REALTIME_IMAGE_MAX_BYTES || String(500 * 1024), 10) || (500 * 1024),
        maxSide: parseInt(process.env.QWEN_OMNI_REALTIME_IMAGE_MAX_SIDE || '960', 10) || 960,
    });
    return normalized.base64;
}

async function _qwenRealtimeFramePayloads(frames) {
    const limit = Math.max(1, Math.min(8, parseInt(process.env.QWEN_OMNI_REALTIME_MAX_FRAMES || '4', 10) || 4));
    const list = Array.isArray(frames) ? frames.filter(f => f?.base64) : [];
    if (!list.length) return [];
    const picked = [];
    if (list.length <= limit) picked.push(...list);
    else {
        for (let i = 0; i < limit; i++) {
            picked.push(list[Math.round(i * (list.length - 1) / (limit - 1))]);
        }
    }
    const out = [];
    for (const f of picked) {
        try {
            // '' means the bytes are undecodable even by ffmpeg — sending an empty
            // image part is a guaranteed request rejection, so drop the frame.
            const b64 = await _qwenRealtimeImageBase64(f);
            if (b64) out.push(b64);
        } catch (_) {
            // Skip bad frame decode; the HTTP lane or fallback can still carry the call.
        }
    }
    return out;
}

function _qwenRealtimeError(message, status = 'error') {
    const err = new Error(message || status);
    err.qwenRealtimeStatus = status;
    return err;
}

async function _qwenOmniRealtimeCall(apiKey, model, prompt, frames, maxTokens) {
    const started = Date.now();
    const url = _qwenRealtimeUrl(model);
    const imagePayloads = await _qwenRealtimeFramePayloads(frames);
    if (!imagePayloads.length) throw _qwenRealtimeError('No valid frames for Qwen realtime Omni', 'bad_param');

    return new Promise((resolve, reject) => {
        let settled = false;
        let text = '';
        let ws = null;
        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws?.close(); } catch (_) {}
            if (err) reject(err);
            else resolve(value);
        };
        const timer = setTimeout(() => {
            finish(_qwenRealtimeError('Qwen Omni realtime timeout', 'timeout'));
        }, QWEN_OMNI_REALTIME_TIMEOUT_MS);

        ws = new WebSocket(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });

        const send = (type, body = {}) => {
            ws.send(JSON.stringify(_qwenRealtimeEvent(type, body)));
        };

        ws.on('open', () => {
            send('session.update', {
                session: {
                    modalities: ['text'],
                    input_audio_format: 'pcm',
                    output_audio_format: 'pcm',
                    instructions: [
                        'You are a precise video-vision judge. Answer the user task using only the supplied frames.',
                        'Return concise text only. Do not mention that silent audio was supplied.',
                        String(prompt || ''),
                    ].join('\n\n'),
                    turn_detection: null,
                },
            });
            // The realtime API requires at least one audio append before images.
            send('input_audio_buffer.append', { audio: _silentPcmBase64() });
            for (const image of imagePayloads) {
                send('input_image_buffer.append', { image });
            }
            send('input_audio_buffer.commit');
            send('response.create');
        });

        ws.on('message', (raw) => {
            let event = null;
            try { event = JSON.parse(String(raw)); } catch (_) { return; }
            const type = event?.type || '';
            if (type === 'error') {
                const msg = event.error?.message || event.error?.code || 'Qwen Omni realtime error';
                finish(_qwenRealtimeError(msg, _classifyQwenProbeError({ message: msg, response: { status: event.error?.status || 0, data: event.error } })));
                return;
            }
            if (type === 'response.text.delta') text += event.delta || '';
            else if (type === 'response.text.done') text = event.text || text;
            else if (type === 'response.audio_transcript.delta') text += event.delta || '';
            else if (type === 'response.audio_transcript.done') text = event.transcript || text;
            else if (type === 'response.done') {
                const responseText = String(text || '').trim();
                if (responseText) {
                    finish(null, { text: responseText, ms: Date.now() - started, frames: imagePayloads.length });
                } else {
                    finish(_qwenRealtimeError('Qwen Omni realtime empty response', 'error'));
                }
            }
        });

        ws.on('error', (err) => finish(err));
        ws.on('close', () => {
            if (!settled && String(text || '').trim()) {
                finish(null, { text: String(text).trim(), ms: Date.now() - started, frames: imagePayloads.length });
            } else if (!settled) {
                finish(_qwenRealtimeError('Qwen Omni realtime connection closed before response', 'network'));
            }
        });
    });
}

async function _qwenOmniRealtimeWithRotation(prompt, frames, maxTokens, configuredModel) {
    if (!QWEN_OMNI_REALTIME_ENABLED) throw new Error('Qwen Omni realtime lane disabled');
    const allKeys = _getQwenKeys('omni');
    if (allKeys.length === 0) throw new Error('No Qwen Omni API keys configured');
    const triedCombos = new Set();
    const maxAttempts = allKeys.length * (QWEN_OMNI_REALTIME_POOL.length + 1);
    const preferred = configuredModel || process.env.QWEN_OMNI_REALTIME_MODEL || 'qwen3.5-omni-plus-realtime';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // `triedCombos` advances the rotation without benching — see _getBestKeyAndModel.
        const combo = _getBestKeyAndModel(QWEN_OMNI_REALTIME_POOL, preferred, 'omni', triedCombos);
        if (!combo) throw new Error('All Qwen Omni realtime models exhausted across all API keys');
        const { apiKey, model, keyIndex } = combo;
        const comboKey = `${_hashApiKey(apiKey)}:${model}`;
        // Defensive only — the selector above already excludes tried combos.
        if (triedCombos.has(comboKey)) break;
        triedCombos.add(comboKey);

        const started = Date.now();
        try {
            const result = await _qwenOmniRealtimeCall(apiKey, model, prompt, frames, maxTokens);
            _recordQwenModelHealth(apiKey, model, 'omniRealtime', 'ok', {
                ms: result.ms ?? (Date.now() - started),
                source: 'runtime',
            });
            console.log(`  📡 [Qwen Omni Realtime] Key ${keyIndex}, model: ${model}, frames=${result.frames || 0}`);
            return result.text;
        } catch (err) {
            const status = err.qwenRealtimeStatus || _classifyQwenProbeError(err);
            if (status === 'unsupported') {
                _markQwenRuntimeUnsupported(model, err, 'omni');
                _setQwenHealthRecord(apiKey, model, 'omniRealtime', 'unsupported', { message: err.message, source: 'runtime' });
                continue;
            }
            if (status === 'exhausted') {
                _markModelExhausted(model, 'exhausted', apiKey, 'omni');
                continue;
            }
            if (['timeout', 'network', 'rate_limited', 'transient'].includes(status)) {
                _markModelExhausted(model, status === 'network' ? 'network' : status === 'timeout' ? 'timeout' : 'rate_limited', apiKey, 'omni');
                continue;
            }
            const realtimeDefect = status === 'bad_param' ? (_isRequestDefectError(err) || 'invalid payload') : null;
            if (realtimeDefect) {
                // Payload fault — rotate, but do NOT persist `bad_param`. That status
                // is STICKY (see _qwenHealthSkipReason), so recording it here would
                // sideline a healthy combo for the whole freshness window over one
                // bad frame — the same mistake as benching, through a different door.
                console.log(`  ✋ [Qwen Omni Realtime] Key ${keyIndex} rejected this request on ${model} — ${realtimeDefect}`);
                continue;
            }
            _setQwenHealthRecord(apiKey, model, 'omniRealtime', status || 'error', { message: err.message, source: 'runtime' });
            continue;
        }
    }

    throw new Error('All Qwen Omni realtime models failed across all keys');
}

// Log models once on first call
let _modelsLogged = false;
function _logModelsOnce() {
    if (_modelsLogged) return;
    _modelsLogged = true;
    const p = config.aiProvider || 'ollama';
    const hostOf = (url) => {
        try { return new URL(url).host; } catch { return url || ''; }
    };
    if (p === 'qwen') {
        // Qwen is vision-only now. AI_PROVIDER=qwen means "vision goes via Qwen";
        // text routing still picks NVIDIA/Bedrock/etc. via the normal text route.
        const status = getQwenVisionStatus();
        const keyCount = status.keys;
        console.log(`  ðŸŒ DashScope endpoint: ${hostOf(config.qwen?.baseUrl)}`);
        const vlStatus = status.image;
        const omniStatus = status.omniHttp;
        console.log(`  👁️ Vision model: ${config.qwen?.visionModel || 'qwen-vl-plus'} (image pool: ${vlStatus.available}/${vlStatus.total} available)`);
        console.log(`  🎥 Omni HTTP model: ${process.env.QWEN_OMNI_MODEL || 'qwen-omni-turbo'} (pool: ${omniStatus.available}/${omniStatus.total} available)`);
        console.log(`  📡 Omni realtime models: ${status.omniRealtime.available}/${status.omniRealtime.total} available via WebSocket lane`);
        if (keyCount > 1) {
            for (let i = 0; i < keyCount; i++) {
                const img = vlStatus.perKey[i] || { available: 0, total: QWEN_IMAGE_POOL.length };
                const omni = omniStatus.perKey[i] || { available: 0, total: QWEN_OMNI_HTTP_POOL.length };
                const rt = status.omniRealtime.perKey[i] || { available: 0, total: QWEN_OMNI_REALTIME_POOL.length };
                console.log(`     🔑 Key ${i + 1}: image ${img.available}/${img.total}, omni-http ${omni.available}/${omni.total}, omni-realtime ${rt.available}/${rt.total}`);
            }
        }
    } else if (p === 'bedrock') {
        const region = config.bedrock?.region || 'us-east-1';
        const primary = config.bedrock?.model || 'deepseek.v3.2';
        const planner = config.bedrock?.plannerModel || '';
        const utility = config.bedrock?.utilityModel || '';
        const fallback = config.bedrock?.fallbackModel || '';
        const plannerTasks = (config.bedrock?.plannerTaskTypes || []).join(', ');
        const utilityTasks = (config.bedrock?.utilityTaskTypes || []).join(', ');
        console.log(`  ☁️  AWS Bedrock (${region})`);
        console.log(`     🤖 Default text:    ${primary}`);
        if (planner) {
            console.log(`     🧠 Director + VP:   ${planner}`);
            console.log(`        (task types: ${plannerTasks})`);
        } else {
            console.log(`     🧠 Director + VP:   (same as default — set BEDROCK_PLANNER_MODEL to split)`);
        }
        if (utility) {
            console.log(`     ⚡ Utility (fast):  ${utility}`);
            console.log(`        (task types: ${utilityTasks})`);
        } else {
            console.log(`     ⚡ Utility (fast):  (same as default — set BEDROCK_UTILITY_MODEL to split)`);
        }
        if (fallback) {
            console.log(`     🛟 Fallback model:  ${fallback} (auto-retry on primary failure)`);
        } else {
            console.log(`     ⚠️  No fallback set (BEDROCK_FALLBACK_MODEL empty)`);
        }
        const ailinkTasks = _liveAilinkTaskTypes();
        const ailinkModel = config.ailink?.plannerModel || config.ailink?.model || 'gpt-5.5';
        const aplinkTasks = _liveAplinkTaskTypes();
        const aplinkModel = config.aplink?.plannerModel || config.aplink?.model || 'claude-opus-4-6';
        const azureTasks = _liveAzureTaskTypes();
        const azureModel = config.azure?.plannerModel || config.azure?.model || 'claude-sonnet-4-6';
        const azureOpenAITasks = _liveAzureOpenAITaskTypes();
        const azureOpenAIModel = config.azureOpenAI?.plannerModel || config.azureOpenAI?.model || 'grok-4.3';
        const brainOverrides = [];
        if (config.ailink?.apiKey && ailinkTasks.length > 0) brainOverrides.push(`ailink:${ailinkModel} for [${ailinkTasks.join(', ')}]`);
        if (config.aplink?.apiKey && aplinkTasks.length > 0) brainOverrides.push(`aplink:${aplinkModel} for [${aplinkTasks.join(', ')}]`);
        if (config.azure?.apiKey && config.azure?.baseUrl && azureTasks.length > 0) brainOverrides.push(`azure-claude:${azureModel} for [${azureTasks.join(', ')}]`);
        if (config.azureOpenAI?.apiKey && config.azureOpenAI?.baseUrl && azureOpenAITasks.length > 0) brainOverrides.push(`azure-openai:${azureOpenAIModel} for [${azureOpenAITasks.join(', ')}]`);
        if (brainOverrides.length > 0) {
            console.log(`     [Brain Router] Sonnet-tier override: ${brainOverrides.join(' | ')}`);
            console.log(`     [Brain Router] Bedrock still owns default/utility tasks and remains fallback for hybrid-routed tasks.`);
            if (config.aplink?.apiKey && (azureTasks.length > 0 || azureOpenAITasks.length > 0) && !/^(0|false|off|no)$/i.test(String(process.env.AZURE_LARGE_PROMPT_APLINK || 'on').trim())) {
                console.log(`     [Brain Router] Azure large-prompt detour: APlink handles [${process.env.AZURE_LARGE_PROMPT_APLINK_TASKS || 'planner-large'}] before Bedrock fallback.`);
            }
        } else {
            console.log(`     [Brain Router] Sonnet-tier override: off; Bedrock planner model owns Director/VP tasks.`);
        }
        const gated = config.bedrock?.allowedTasks || [];
        if (gated.length > 0) {
            console.log(`     🔒 Task gate:       only [${gated.join(', ')}] allowed to hit Bedrock`);
        }
    }
    // claude, openai, gemini, groq startup-logging branches REMOVED in 2026-05-25 cleanup.
    // Show text router preview
    const textRoutePreview = _getTextRoute(p, { taskType: 'general', promptLength: 0, maxTokens: 800 }).entries;
    if (textRoutePreview.length > 1) {
        console.log(`  [Text Router] default route: ${textRoutePreview.map(_textRouteLabel).join(' -> ')}`);
    }
    // Show vision provider chain
    const visionChain = _getVisionChain();
    if (visionChain.length > 1) {
        console.log(`  👁️ Vision chain: ${visionChain[0]} → ${visionChain.slice(1).join(' → ')} (fallback)`);
    } else {
        console.log(`  👁️ Vision provider: ${visionChain[0]}`);
    }
    if (visionChain.includes('qwen')) {
        const qwenStatus = getQwenVisionStatus();
        const registry = qwenStatus.registry || {};
        const registryPart = registry.generatedAt ? `${registry.source} @ ${registry.generatedAt}` : registry.source;
        console.log(`  🧭 Qwen model registry: ${registryPart || 'static'} (${registry.file})`);
        console.log(`  👁️ Qwen image scoring pool: ${QWEN_IMAGE_POOL.length} models (${QWEN_VL_POOL.length} VL/QVQ/OCR + ${QWEN_357_VISION_POOL.length} Qwen3.5/3.6/3.7); available ${qwenStatus.image.available}/${qwenStatus.image.total}`);
        console.log(`  🎥 Qwen video scoring pool: ${QWEN_OMNI_HTTP_POOL.length} Omni HTTP + ${QWEN_OMNI_REALTIME_POOL.length} realtime candidates; HTTP available ${qwenStatus.omniHttp.available}/${qwenStatus.omniHttp.total}`);
    }
}

// ============================================================
// TEXT AI — callAI(prompt, options)
// ============================================================

/**
 * Call the configured AI provider with a text prompt.
 * @param {string} prompt - The prompt to send
 * @param {object} [options] - Optional settings
 * @param {number} [options.maxTokens=800] - Max tokens in response
 * @param {number} [options.temperature] - Temperature (0-1)
 * @param {string} [options.systemPrompt] - System prompt (if supported)
 * @param {string} [options.taskType='general'] - Router hint for model order/budget
 * @returns {Promise<string>} The AI response text
 */
function _pushUniqueRoute(route, entry) {
    const normalized = typeof entry === 'string' ? { provider: entry } : { ...entry };
    if (!normalized.provider || !_hasProviderKey(normalized.provider)) return;
    // Qwen is vision-only — never route text through it.
    if (normalized.provider === 'qwen') return;

    const key = `${normalized.provider}:${normalized.model || '*'}`;
    if (route.some(r => `${r.provider}:${r.model || '*'}` === key)) return;
    route.push(normalized);
}

function _aplinkEntryForTask(task) {
    const ap = config.aplink || {};
    if (!ap.apiKey) return null;
    const apPlanner = ap.plannerModel && new Set(ap.plannerTaskTypes || []).has(task);
    return { provider: 'aplink', model: apPlanner ? ap.plannerModel : (ap.model || 'claude-opus-4-6') };
}

function _azureLargePromptAplinkEntry(task, { promptLength = 0, maxTokens = 800 } = {}) {
    const disabled = /^(0|false|off|no)$/i.test(String(process.env.AZURE_LARGE_PROMPT_APLINK || 'on').trim());
    if (disabled) return null;

    // `!== undefined`, not `||`: an explicitly emptied list means "no task-name trigger,
    // size thresholds only". With `||` an empty value fell back to the default and the
    // detour could not be narrowed at all without disabling it outright.
    const taskList = _csvList(process.env.AZURE_LARGE_PROMPT_APLINK_TASKS !== undefined
        ? process.env.AZURE_LARGE_PROMPT_APLINK_TASKS
        : 'planner-large');
    const minChars = Math.max(0, parseInt(process.env.AZURE_LARGE_PROMPT_APLINK_MIN_CHARS || '20000', 10) || 0);
    const minMaxTokens = Math.max(0, parseInt(process.env.AZURE_LARGE_PROMPT_APLINK_MIN_MAX_TOKENS || '4800', 10) || 0);
    const isLarge = taskList.includes(task)
        || (minChars > 0 && Number(promptLength || 0) >= minChars)
        || (minMaxTokens > 0 && Number(maxTokens || 0) >= minMaxTokens);
    if (!isLarge) return null;
    return _aplinkEntryForTask(task);
}

// _nvidiaRouteEntriesForTask REMOVED in 2026-05-25 cleanup.

let _amUnconfiguredWarned = false;
function _warnAzureManagedUnconfigured() {
    if (_amUnconfiguredWarned) return;
    _amUnconfiguredWarned = true;
    const am = config.azureManaged || {};
    const missing = [!am.apiKey && 'AZURE_MANAGED_API_KEY', !am.baseUrl && 'AZURE_MANAGED_ENDPOINT']
        .filter(Boolean).join(' + ');
    console.warn(`  [Text Router] AI_PROVIDER=azure-managed but it is NOT configured (missing ${missing}) — falling back to the Bedrock/hybrid routes.`);
}

// The text router's front door. A job pointed at an AI Connection is served by
// that connection (then its backup, then — only if asked for — the built-in
// setup). Everything else, and every forced-provider call, takes the built-in
// route below byte-for-byte as before.
function _getTextRoute(primary, opts = {}) {
    const builtIn = _getBuiltInTextRoute(primary, opts);
    if (opts.providerOverride) return builtIn;
    const assigned = aiConnections.routeForJob(aiConnections.jobForTask(builtIn.task));
    if (!assigned) return builtIn;
    const entries = assigned.connections.map((conn) => ({
        provider: `connection:${conn.id}`,
        connectionId: conn.id,
        model: aiConnections.modelFor(conn, 'text'),
        label: `${conn.label} (${aiConnections.modelFor(conn, 'text')})`,
        reasoning: conn.reasoning === true,
    }));
    if (assigned.builtInBackup) entries.push(...builtIn.entries);
    return { task: builtIn.task, entries };
}

function _getBuiltInTextRoute(primary, { taskType, promptLength = 0, maxTokens = 800, providerOverride = false } = {}) {
    // Provider-aware text route. Bedrock is the base brain; AiLink can sit beside
    // it for Sonnet-tier tasks when AILINK_TASK_TYPES names the task.
    const task = _normalizeTextTaskType(taskType, { promptLength, maxTokens });

    // ── Azure Managed Compute: single endpoint, two models, replaces Bedrock entirely.
    // Brain-tier tasks → ornith (reasoning), everything else (default/utility/vision scoring) → qwen.
    // No Bedrock fallback — this IS the brain when selected.
    //
    // This block MUST sit below `const task` above: it returns `task`, and when it
    // stood before the declaration every azure-managed route hit the temporal dead
    // zone instead of returning. The gate matches the NORMALIZED task (like every
    // other *_TASK_TYPES gate in this function) and also the raw taskType, so a list
    // written in either vocabulary works.
    if (!providerOverride && primary === 'azure-managed') {
        const am = config.azureManaged || {};
        const amConfigured = Boolean(am.apiKey && am.baseUrl);
        const brainTasks = _liveAzureManagedTaskTypes();
        const isBrain = brainTasks.length > 0
            && (brainTasks.includes(task) || brainTasks.includes(taskType));
        const brainEntry = { provider: 'azure-managed', model: am.brainModel || 'deepreinforce-ai--ornith-10-397b' };
        const defaultEntry = { provider: 'azure-managed', model: am.defaultModel || 'qwen--qwen38-27b' };
        if (amConfigured && isBrain) return { task, entries: [brainEntry] };
        if (amConfigured) return { task, entries: [defaultEntry] };
        // Selected but not configured: say so ONCE rather than silently falling through
        // to the hybrid Azure gates below, which point at a different endpoint and key
        // and produce a baffling 401 against a deployment name that does exist.
        _warnAzureManagedUnconfigured();
    }

    const provider = 'bedrock';
    const cfg = config[provider] || {};
    const defaultModel = cfg.model || 'deepseek.v3.2';
    const plannerModel = cfg.plannerModel || '';
    const usePlanner = plannerModel && new Set(cfg.plannerTaskTypes || []).has(task);
    const utilityModel = cfg.utilityModel || '';
    const useUtility = utilityModel && new Set(cfg.utilityTaskTypes || []).has(task);
    const entry = {
        provider,
        model: useUtility ? utilityModel : (usePlanner ? plannerModel : defaultModel),
    };

    // ── Hybrid brain (AiLink GPT-5.5 beside Bedrock):
    // when primary is bedrock, AiLink has a key, and AILINK_TASK_TYPES (live env)
    // names this task → AiLink serves it FIRST with Bedrock as automatic fallback.
    const al = config.ailink || {};
    const ailinkConfigured = Boolean(al.apiKey);
    const ailinkTasks = _liveAilinkTaskTypes();
    if (!providerOverride && ailinkConfigured
        && ailinkTasks.length > 0 && ailinkTasks.includes(task)) {
        const alPlanner = al.plannerModel && new Set(al.plannerTaskTypes || []).has(task);
        const ailinkEntry = { provider: 'ailink', model: alPlanner ? al.plannerModel : (al.model || 'gpt-5.5') };
        return { task, entries: [ailinkEntry, entry] };
    }

    // ── Hybrid brain (APlink Claude-Opus-4-6 beside Bedrock): same pattern as AiLink.
    // When primary is bedrock, APlink has a key, and APLINK_TASK_TYPES names this task →
    // APlink serves it FIRST with Bedrock as the automatic fallback (relay channels drop).
    const ap = config.aplink || {};
    const aplinkConfigured = Boolean(ap.apiKey);
    const aplinkTasks = _liveAplinkTaskTypes();
    if (!providerOverride && aplinkConfigured
        && aplinkTasks.length > 0 && aplinkTasks.includes(task)) {
        const aplinkEntry = _aplinkEntryForTask(task);
        return { task, entries: [aplinkEntry, entry] };
    }

    // ── Hybrid brain (Azure Foundry Claude Sonnet beside Bedrock): same pattern as AiLink/APlink.
    // When primary is bedrock, Azure has a key/base/model, and AZURE_TASK_TYPES names this task →
    // Azure Claude serves it FIRST with Bedrock as automatic fallback.
    // SKIPPED when primary=azure-managed: that provider owns ALL tasks through its own endpoint.
    const az = config.azure || {};
    const azureConfigured = Boolean(az.apiKey && az.baseUrl && az.model);
    const azureTasks = _liveAzureTaskTypes();
    if (!providerOverride && primary !== 'azure-managed' && azureConfigured
        && azureTasks.length > 0 && azureTasks.includes(task)) {
        const azPlanner = az.plannerModel && new Set(az.plannerTaskTypes || []).has(task);
        const azureEntry = { provider: 'azure-claude', model: azPlanner ? az.plannerModel : (az.model || 'claude-sonnet-4-6') };
        // The large-prompt detour prefers APlink, but it must not skip Azure on the way
        // down: relay channels drop, and landing straight on Bedrock strands the biggest
        // call in the pipeline (Visual Planner) if Bedrock is unavailable.
        const aplinkLargeEntry = _azureLargePromptAplinkEntry(task, { promptLength, maxTokens });
        if (aplinkLargeEntry) return { task, entries: [aplinkLargeEntry, azureEntry, entry] };
        return { task, entries: [azureEntry, entry] };
    }

    // ── Hybrid brain (Azure OpenAI-compatible deployments such as Grok beside Bedrock).
    // Same task-gated Sonnet-tier replacement, but through /chat/completions instead
    // of the Azure Anthropic Messages endpoint.
    const azOpenAI = config.azureOpenAI || {};
    const azureOpenAIConfigured = Boolean(azOpenAI.apiKey && azOpenAI.baseUrl && azOpenAI.model);
    const azureOpenAITasks = _liveAzureOpenAITaskTypes();
    if (!providerOverride && azureOpenAIConfigured
        && azureOpenAITasks.length > 0 && azureOpenAITasks.includes(task)) {
        const azPlanner = azOpenAI.plannerModel && new Set(azOpenAI.plannerTaskTypes || []).has(task);
        const azureOpenAIEntry = { provider: 'azure-openai', model: azPlanner ? azOpenAI.plannerModel : (azOpenAI.model || 'grok-4.3') };
        const aplinkLargeEntry = _azureLargePromptAplinkEntry(task, { promptLength, maxTokens });
        if (aplinkLargeEntry) return { task, entries: [aplinkLargeEntry, azureOpenAIEntry, entry] };
        return { task, entries: [azureOpenAIEntry, entry] };
    }

    return { task, entries: [entry] };
}

async function callAI(prompt, options = {}) {
    let { maxTokens = 800 } = options;
    const { temperature, systemPrompt, provider: providerOverride, taskType, returnMeta = false } = options;
    const provider = providerOverride || config.aiProvider || 'ollama';
    _logModelsOnce();

    const promptText = String(prompt || '');
    const routeInfo = _getTextRoute(provider, {
        taskType,
        promptLength: promptText.length,
        maxTokens,
        providerOverride: !!providerOverride,
    });
    // Brain (CEO/editor) decisions need room to finish — bump a low caller cap to the floor
    // so the response doesn't get cut off mid-thought (stop=length). Applied after routing so
    // it never changes which provider is chosen.
    if (routeInfo.task === 'brain' && BRAIN_MIN_MAX_TOKENS > 0 && maxTokens < BRAIN_MIN_MAX_TOKENS) {
        maxTokens = BRAIN_MIN_MAX_TOKENS;
    }
    // Same reason, small tasks: a reasoning primary needs headroom to think before it
    // writes, or it answers "" at finish=length. Also applied after routing, so it can
    // never change which provider is chosen.
    const _reasoningFloor = _textCompletionBudget(routeInfo.entries[0], routeInfo.task, maxTokens);
    if (_reasoningFloor > maxTokens) {
        console.log(`  [Text Router] max_tokens ${maxTokens} → ${_reasoningFloor} (reasoning floor: ${_textRouteLabel(routeInfo.entries[0])} task=${routeInfo.task})`);
        maxTokens = _reasoningFloor;
    }
    const route = routeInfo.entries;
    console.log(`  [Text Router] task=${routeInfo.task} prompt=${promptText.length} chars max_tokens=${maxTokens} route=${route.map(_textRouteLabel).join(' -> ')}`);
    console.log(`  [Text Router] decision ${_textRouteDecisionLine(routeInfo.task, route, { providerOverride: !!providerOverride })}`);

    // Production directives: the user's instruction field steers every decision brain.
    const _directives = _productionDirectives(routeInfo.task);
    let _dispatchPrompt = prompt;
    let _dispatchSystem = systemPrompt;
    if (_directives) {
        if (_dispatchSystem) _dispatchSystem = `${_directives}\n\n${_dispatchSystem}`;
        else _dispatchPrompt = `${_directives}\n\n${String(prompt || '')}`;
        console.log(`  [Text Router] + production directives applied (task=${routeInfo.task})`);
    }

    let lastError = null;
    let attempts = 0;
    for (let i = 0; i < route.length; i++) {
        const entry = route[i];
        const label = _textRouteLabel(entry);
        const skipReason = _textRouteSkipReason(entry, routeInfo.task);
        if (skipReason) {
            console.log(`  [Text Router] skip ${label} for task=${routeInfo.task} (${skipReason})`);
            continue;
        }

        attempts++;
        const started = Date.now();
        const isFallback = attempts > 1;
        const role = isFallback ? 'fallback' : 'primary';
        const timeoutPart = entry.timeoutMs ? ` timeout=${Math.round(entry.timeoutMs / 1000)}s` : '';
        const emergencyPart = entry.emergency ? ' emergency' : '';
        console.log(`  [Text Router] attempt ${attempts}/${route.length} ${role}: ${label}${timeoutPart}${emergencyPart}`);

        try {
            const dispatched = await _dispatchText(entry, _dispatchPrompt, {
                maxTokens,
                temperature,
                systemPrompt: _dispatchSystem,
                skipThinking: isFallback,
                taskType: routeInfo.task,
                returnMeta,
            });
            const text = typeof dispatched === 'string' ? dispatched : (dispatched?.text || '');
            const meta = typeof dispatched === 'string' ? null : (dispatched?.meta || null);

            if (!text || text.trim().length === 0) {
                throw new Error('Empty response');
            }

            _clearTextRouteFailures(entry, routeInfo.task); // success resets the strike counter

            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            console.log(`  [Text Router] selected ${label} for task=${routeInfo.task} role=${role} in ${elapsed}s`);
            if (returnMeta) {
                return {
                    text,
                    meta: {
                        ...(meta || {}),
                        routeTask: routeInfo.task,
                        routeLabel: label,
                        routeTier: _textTaskTier(routeInfo.task),
                        routeMode: _textRouteMode(routeInfo.task, route, { providerOverride: !!providerOverride }),
                        routeRole: role,
                        routeFallbackLabels: route.slice(i + 1).map(_textRouteLabel),
                        maxTokens,
                    },
                };
            }
            return text;
        } catch (error) {
            lastError = error;
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            const nextPart = i < route.length - 1 ? ' (trying next route)' : '';
            console.log(`  [Text Router] ${role} ${label} failed for task=${routeInfo.task} in ${elapsed}s: ${error.message}${nextPart}`);
            _markTextRouteUnhealthy(entry, routeInfo.task, error);
        }
    }

    if (lastError) throw lastError;
    throw new Error(`No available text route for task=${routeInfo.task}`);
}

// ── AI Connection calls ─────────────────────────────────────────────────────
// Thin adapters from the router's calling convention to connection-transport.
// Timeouts follow the same size-scaled rule as the Azure paths: a big planner
// answer is allowed to take minutes, a vision scorecard is not.
function _connectionTimeoutMs(conn, maxTokens) {
    return conn.timeoutMs || Math.max(120_000, Math.min(420_000, 90_000 + (Number(maxTokens) || 800) * 35));
}

async function _connectionText(entry, prompt, { maxTokens, temperature, systemPrompt, taskType, returnMeta = false }) {
    const conn = aiConnections.getConnection(entry.connectionId);
    if (!conn) throw new Error(`AI connection "${entry.connectionId}" no longer exists`);
    const reply = await connectionTransport.chatText(conn, {
        prompt,
        systemPrompt,
        maxTokens,
        temperature,
        taskType,
        model: entry.model,
        timeoutMs: _connectionTimeoutMs(conn, maxTokens),
        recordUsage,
        log: (line) => console.log(line),
    });
    // A server that returns a separate reasoning field is a reasoning model,
    // whatever it is called: give it the reasoning floor from now on.
    if (reply.hadReasoning && conn.reasoning !== true) conn.reasoning = true;
    if (!reply.text) console.log(`  [AI:${conn.label}] ⚠️ EMPTY response (stop=${reply.finish})`);
    if (returnMeta) {
        return { text: reply.text, meta: { provider: 'connection', connectionId: conn.id, modelId: reply.model, stopReason: reply.finish, usage: reply.usage } };
    }
    return reply.text;
}

async function _connectionVision(connId, prompt, images, maxTokens) {
    const conn = aiConnections.getConnection(connId);
    if (!conn) throw new Error(`AI connection "${connId}" no longer exists`);
    const model = aiConnections.modelFor(conn, 'vision');
    const budget = _visionCompletionBudget(model, maxTokens);
    const reply = await connectionTransport.chatVision(conn, {
        prompt,
        images,
        maxTokens: conn.reasoning ? Math.max(budget, VISION_REASONING_MIN_TOKENS) : budget,
        model,
        timeoutMs: conn.timeoutMs || _azureVisionTimeout(budget),
        recordUsage,
        log: (line) => console.log(line),
    });
    if (!reply.text) console.log(`  [AI:${conn.label}] ⚠️ EMPTY vision response (stop=${reply.finish})`);
    return reply.text;
}

async function _dispatchText(target, prompt, { maxTokens, temperature, systemPrompt, skipThinking, taskType, returnMeta = false }) {
    // Text is Bedrock-based after the 2026-05-25 cleanup, with optional AiLink
    // overlay for Sonnet-tier tasks. Bedrock owns DeepSeek/Sonnet/Haiku routing
    // internally via plannerTaskTypes / utilityTaskTypes.
    const entry = typeof target === 'string' ? { provider: target } : (target || {});
    const provider = entry.provider || target;
    if (entry.connectionId) {
        return await _connectionText(entry, prompt, { maxTokens, temperature, systemPrompt, taskType, returnMeta });
    }
    if (provider === 'ailink') {
        return await _ailinkText(prompt, maxTokens, temperature, systemPrompt, { taskType, model: entry.model, returnMeta });
    }
    if (provider === 'aplink') {
        return await _aplinkText(prompt, maxTokens, temperature, systemPrompt, { taskType, model: entry.model, returnMeta });
    }
    if (provider === 'azure-claude') {
        return await _azureClaudeText(prompt, maxTokens, temperature, systemPrompt, { taskType, model: entry.model, returnMeta });
    }
    if (provider === 'azure-openai') {
        return await _azureOpenAIText(prompt, maxTokens, temperature, systemPrompt, { taskType, model: entry.model, returnMeta });
    }
    if (provider === 'azure-managed') {
        return await _azureManagedText(prompt, maxTokens, temperature, systemPrompt, { taskType, model: entry.model, returnMeta });
    }
    if (provider !== 'bedrock') {
        throw new Error(`Text provider "${provider}" is not supported. Use AI_PROVIDER=bedrock with an optional hybrid brain gate (AILINK_TASK_TYPES, APLINK_TASK_TYPES, AZURE_TASK_TYPES, or AZURE_OPENAI_TASK_TYPES).`);
    }
    return await _bedrockText(prompt, maxTokens, temperature, systemPrompt, { taskType, model: entry.model, returnMeta });
}

// ──────────────────────────────────────────────────────────────────────────
// AiLink (ai.ailink1.com) text — OpenAI-compatible chat/completions proxy
// (GPT-5.5 etc.). Bearer API key auth; endpoint + model fully config-driven.
// Slots into the same route/fallback machinery as Bedrock.
// ──────────────────────────────────────────────────────────────────────────
async function _ailinkText(prompt, maxTokens, temperature, systemPrompt, opts = {}) {
    const { taskType, returnMeta = false } = opts;
    const al = config.ailink || {};
    // Task allowlist gate (same protection pattern as Bedrock).
    const _liveGate = process.env.AILINK_TASK_TYPES;
    const _gateTasks = _liveGate !== undefined
        ? _csvTaskGate(_liveGate)
        : _csvTaskGate((Array.isArray(al.allowedTasks) ? al.allowedTasks : []).join(','));
    if (_gateTasks.length > 0 && taskType && !_gateTasks.includes(taskType)) {
        throw new Error(`AiLink blocked: taskType=${taskType} not in AILINK_TASK_TYPES`);
    }
    if (!al.apiKey) throw new Error('AiLink not configured: set AILINK_API_KEY');

    const axios = require('axios');
    const model = opts.model || al.model || 'gpt-5.5';
    const baseUrl = String(al.baseUrl || 'https://ai.ailink1.com/v1').replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt || '') });
    const body = {
        model,
        messages,
        max_tokens: maxTokens || 800,
        ...(temperature !== undefined ? { temperature } : {}),
    };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${al.apiKey}` };

    // GPT-5.5 is a slow reasoning model on this proxy. A flat 120s timeout was fine for
    // the small brain calls but TOO SHORT for the big planner-large outputs (max_tokens
    // 8000) — those hit 120s, got benched for 600s, and fell back to Sonnet. Scale the
    // timeout with the output budget (~30ms/token over a 90s base; 120s floor, 360s
    // ceiling). Override with AILINK_TIMEOUT_MS.
    const _ailinkTimeout = parseInt(process.env.AILINK_TIMEOUT_MS, 10)
        || Math.max(120_000, Math.min(360_000, 90_000 + (Number(maxTokens) || 800) * 30));

    const started = Date.now();
    try {
        const resp = await axios({ url, method: 'POST', data: body, headers, timeout: _ailinkTimeout, adapter: 'http' });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const choice = resp.data?.choices?.[0];
        const text = String(choice?.message?.content || choice?.text || '').trim();
        const usage = resp.data?.usage || {};
        const finish = choice?.finish_reason || 'unknown';
        console.log(`  [AiLink] ${model} task=${taskType || '?'} ${elapsed}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${finish}`);
        recordUsage({ provider: 'ailink', model, taskType, kind: 'text', usage });
        if (!text) console.log(`  [AiLink] ⚠️ EMPTY response (finish=${finish})`);
        if (returnMeta) {
            return { text, meta: { provider: 'ailink', modelId: model, stopReason: finish, usage } };
        }
        return text;
    } catch (err) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [AiLink] ✗ ${model} ${elapsed}s HTTP ${status || '?'} ${detail}`);
        throw err;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// APlink (aplink.top) text — OpenAI-compatible Claude relay (claude-opus-4-6 etc.).
// Bearer API key; endpoint + model config-driven. Same route/fallback machinery.
// ──────────────────────────────────────────────────────────────────────────
async function _aplinkText(prompt, maxTokens, temperature, systemPrompt, opts = {}) {
    const { taskType, returnMeta = false } = opts;
    const ap = config.aplink || {};
    const _liveGate = process.env.APLINK_TASK_TYPES;
    const _gateTasks = _liveGate !== undefined
        ? _csvTaskGate(_liveGate)
        : _csvTaskGate((Array.isArray(ap.allowedTasks) ? ap.allowedTasks : []).join(','));
    if (_gateTasks.length > 0 && taskType && !_gateTasks.includes(taskType)) {
        throw new Error(`APlink blocked: taskType=${taskType} not in APLINK_TASK_TYPES`);
    }
    if (!ap.apiKey) throw new Error('APlink not configured: set APLINK_API_KEY');

    const axios = require('axios');
    const model = opts.model || ap.model || 'claude-opus-4-6';
    const baseUrl = String(ap.baseUrl || 'https://aplink.top/v1').replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt || '') });
    const body = {
        model,
        messages,
        max_tokens: maxTokens || 800,
        ...(temperature !== undefined ? { temperature } : {}),
    };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ap.apiKey}` };

    // Opus-4-6 on this relay runs ~42 tok/s, so a big planner output (~5k tokens) takes
    // ~120s. Scale the timeout with the output budget (90s base + ~30ms/token, 120s floor,
    // 360s ceiling) so big calls finish instead of falling back. Override APLINK_TIMEOUT_MS.
    const _aplinkTimeout = parseInt(process.env.APLINK_TIMEOUT_MS, 10)
        || Math.max(120_000, Math.min(360_000, 90_000 + (Number(maxTokens) || 800) * 30));

    const started = Date.now();
    try {
        const resp = await axios({ url, method: 'POST', data: body, headers, timeout: _aplinkTimeout, adapter: 'http' });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const choice = resp.data?.choices?.[0];
        const text = String(choice?.message?.content || choice?.text || '').trim();
        const usage = resp.data?.usage || {};
        const finish = choice?.finish_reason || 'unknown';
        console.log(`  [APlink] ${model} task=${taskType || '?'} ${elapsed}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${finish}`);
        recordUsage({ provider: 'aplink', model, taskType, kind: 'text', usage });
        if (!text) console.log(`  [APlink] ⚠️ EMPTY response (finish=${finish})`);
        if (returnMeta) {
            return { text, meta: { provider: 'aplink', modelId: model, stopReason: finish, usage } };
        }
        return text;
    } catch (err) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [APlink] ✗ ${model} ${elapsed}s HTTP ${status || '?'} ${detail}`);
        throw err;
    }
}

// Azure Foundry meters per DEPLOYMENT, not per account, and a trial-tier deployment can
// sit as low as 3 requests / 2500 uncached input tokens per 60s. A build fires hundreds of
// text calls, so 429s are routine rather than exceptional — and since Bedrock is the
// fallback, a 429 that is not retried here silently demotes the call to whatever Bedrock
// state the operator has. Honour the server's own retry-after instead of guessing.
// AZURE_RATE_LIMIT_RETRIES=0 restores the old fail-fast behaviour.
function _azureRetryAfterMs(err) {
    const h = err?.response?.headers || {};
    const ms = parseFloat(h['retry-after-ms']);
    if (Number.isFinite(ms) && ms > 0) return ms;
    const secs = parseFloat(h['retry-after'] ?? h['x-ratelimit-timeremaining']);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    return 0;
}

async function _azureRetrying(label, model, taskType, fn) {
    const maxRetries = Math.max(0, parseInt(process.env.AZURE_RATE_LIMIT_RETRIES || '4', 10) || 0);
    const capMs = Math.max(1000, parseInt(process.env.AZURE_RATE_LIMIT_MAX_WAIT_MS || '75000', 10) || 75000);
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.response?.status;
            // A dropped connection is the MOST retryable failure there is, and it was the
            // only one not retried: this tested `status` alone, but a transport error has
            // no HTTP response at all, so status is undefined, retryable was false, and the
            // call was thrown on the first blip. Measured 2026-08-29: `connect ETIMEDOUT`
            // and `read ECONNRESET` to the Azure endpoint sent 18 candidates down the
            // fallback chain to "left unjudged" — footage accepted or dropped without ever
            // being scored — while the vision model itself was perfectly healthy either
            // side of the blip. Codes come from Node's net/dns layer; ECONNABORTED is what
            // axios raises for its own timeout.
            const code = String(err?.code || err?.cause?.code || '');
            const transport = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)$/.test(code);
            const retryable = status === 429 || status === 503 || status === 529 || transport;
            if (!retryable || attempt >= maxRetries) throw err;
            const waitMs = Math.min(capMs, _azureRetryAfterMs(err) || Math.min(capMs, 2000 * Math.pow(2, attempt)));
            const why = transport ? `network ${code}` : `HTTP ${status} rate-limited`;
            console.log(`  [${label}] ${model} task=${taskType || '?'} ${why} — waiting ${(waitMs / 1000).toFixed(1)}s (retry ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
}

function _azureAnthropicBaseUrl(value = '') {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/anthropic$/i.test(raw)) return raw;
    if (/\/anthropic\/v1\/messages$/i.test(raw)) return raw.replace(/\/v1\/messages$/i, '');
    if (/\/openai\/v1$/i.test(raw)) return raw.replace(/\/openai\/v1$/i, '/anthropic');
    if (/\.services\.ai\.azure\.com\/api\/projects\//i.test(raw)) {
        return raw.replace(/\/api\/projects\/.*$/i, '/anthropic');
    }
    if (/\.services\.ai\.azure\.com$/i.test(raw)) return `${raw}/anthropic`;
    if (/\.openai\.azure\.com$/i.test(raw)) return raw.replace(/\.openai\.azure\.com$/i, '.services.ai.azure.com/anthropic');
    return raw;
}

function _azureOpenAIBaseUrl(value = '') {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '');
    if (/\/openai\/v1$/i.test(raw)) return raw;
    if (/\.openai\.azure\.com$/i.test(raw)) return `${raw}/openai/v1`;
    if (/\.services\.ai\.azure\.com\/api\/projects\//i.test(raw)) {
        return raw.replace(/\/api\/projects\/.*$/i, '/openai/v1');
    }
    if (/\.services\.ai\.azure\.com$/i.test(raw)) return `${raw}/openai/v1`;
    return raw;
}

// GPT-5.x deployments reject the legacy chat/completions knobs that every older
// Azure deployment (grok-4.3, gpt-4o) requires. Measured against gpt-5.6-terra on
// 2026-08-14: `max_tokens` → HTTP 400 "use 'max_completion_tokens' instead", and
// any explicit temperature other than 1 → HTTP 400 "only the default (1) value is
// supported". So the request shape has to be chosen per model, never swapped
// globally, or fixing GPT-5 breaks grok.
function _isGpt5Model(model) {
    return /^gpt-5/i.test(String(model || '').trim());
}

// Does this model spend completion budget THINKING before it emits a visible character?
//
// The two budget floors above used to ask _isGpt5Model, i.e. they matched ONE VENDOR BY
// NAME. That silently covered exactly the family it was written for. The moment a
// different reasoning model was deployed — deepreinforce ornith, 2026-08-27 — it matched
// nothing, got no headroom on any task, and returned "" at finish=length on every
// planner call. Raising TEXT_MIN_MAX_TOKENS could not help, because the value is only
// read AFTER the name check that already rejected it.
//
// So this is a PROPERTY of the model, declared, not a vendor prefix. Keep _isGpt5Model
// for what it is genuinely about — the GPT-5 request dialect (max_completion_tokens,
// temperature must be 1) — and ask this instead for anything about thinking budget.
// REASONING_MODEL_PATTERN adds to the list without a code change.
const _REASONING_MODEL_DEFAULT_RE =
    /(^gpt-5)|(^o[1-9](-|$))|ornith|qwq|deepseek-r1|[-_.]thinking|[-_.]reasoning/i;
function _isReasoningModel(model) {
    const id = String(model || '').trim();
    if (!id) return false;
    const extra = String(process.env.REASONING_MODEL_PATTERN || '').trim();
    if (extra) {
        try { if (new RegExp(extra, 'i').test(id)) return true; } catch (_) { /* bad regex → ignore */ }
    }
    return _REASONING_MODEL_DEFAULT_RE.test(id);
}

function _azureOpenAITuning(model, maxTokens, temperature, defaultMaxTokens) {
    const budget = maxTokens || defaultMaxTokens;
    if (_isGpt5Model(model)) {
        return {
            max_completion_tokens: budget,
            ...(temperature === 1 ? { temperature } : {}),
        };
    }
    return {
        max_tokens: budget,
        ...(temperature !== undefined ? { temperature } : {}),
    };
}

// The Anthropic surface has the same generational split. Measured on 2026-08-14:
// claude-opus-4-8 400s on any explicit temperature other than 1 ("`temperature` is
// deprecated for this model"), while claude-sonnet-4-6 on the same endpoint accepts
// 0.7 happily. Callers pass a temperature on most planner/director calls, so without
// this the whole thinking tier would 400 straight through to dead Bedrock.
function _anthropicDeprecatesTemperature(model) {
    return /^claude-opus-4-8/i.test(String(model || '').trim());
}

function _azureAnthropicTuning(model, temperature) {
    if (temperature === undefined) return {};
    if (_anthropicDeprecatesTemperature(model) && temperature !== 1) return {};
    return { temperature };
}

function _anthropicMessageText(data) {
    const parts = Array.isArray(data?.content) ? data.content : [];
    const text = parts
        .map(part => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text') return part.text || '';
            return part?.text || '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    return text || String(data?.completion || data?.text || '').trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Azure AI Foundry Claude text — Anthropic Messages API hosted through Azure.
// x-api-key auth, deployment/model name config-driven. Same route/fallback
// machinery as AiLink/APlink.
// ──────────────────────────────────────────────────────────────────────────
async function _azureClaudeText(prompt, maxTokens, temperature, systemPrompt, opts = {}) {
    const { taskType, returnMeta = false } = opts;
    const az = config.azure || {};
    const _liveGate = process.env.AZURE_TASK_TYPES;
    const _gateTasks = _liveGate !== undefined
        ? _csvTaskGate(_liveGate)
        : _csvTaskGate((Array.isArray(az.allowedTasks) ? az.allowedTasks : []).join(','));
    if (_gateTasks.length > 0 && taskType && !_gateTasks.includes(taskType)) {
        throw new Error(`Azure Claude blocked: taskType=${taskType} not in AZURE_TASK_TYPES`);
    }
    if (!az.apiKey) throw new Error('Azure Claude not configured: set AZURE_API_KEY or AZURE_OPENAI_API_KEY');
    if (!az.baseUrl) throw new Error('Azure Claude not configured: set AZURE_ANTHROPIC_BASE_URL or AZURE_OPENAI_ENDPOINT');

    const axios = require('axios');
    const model = opts.model || az.model || 'claude-sonnet-4-6';
    const baseUrl = _azureAnthropicBaseUrl(az.baseUrl);
    const url = `${baseUrl}/v1/messages`;
    const messages = [{ role: 'user', content: String(prompt || '') }];
    const body = {
        model,
        messages,
        max_tokens: maxTokens || 800,
        ...(systemPrompt ? { system: String(systemPrompt) } : {}),
        ..._azureAnthropicTuning(model, temperature),
        stream: false,
    };
    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': az.apiKey,
        'anthropic-version': az.apiVersion || '2023-06-01',
    };
    const _azureTimeout = parseInt(process.env.AZURE_TIMEOUT_MS, 10)
        || Math.max(120_000, Math.min(420_000, 90_000 + (Number(maxTokens) || 800) * 35));

    const started = Date.now();
    try {
        const resp = await _azureRetrying('Azure Claude', model, taskType, () =>
            axios({ url, method: 'POST', data: body, headers, timeout: _azureTimeout, adapter: 'http' }));
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const text = _anthropicMessageText(resp.data);
        const usage = {
            prompt_tokens: resp.data?.usage?.input_tokens || 0,
            completion_tokens: resp.data?.usage?.output_tokens || 0,
            total_tokens: (resp.data?.usage?.input_tokens || 0) + (resp.data?.usage?.output_tokens || 0),
        };
        const stop = resp.data?.stop_reason || 'unknown';
        console.log(`  [Azure Claude] ${model} task=${taskType || '?'} ${elapsed}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${stop}`);
        recordUsage({ provider: 'azure-claude', model, taskType, kind: 'text', usage });
        if (!text) console.log(`  [Azure Claude] ⚠️ EMPTY response (stop=${stop})`);
        if (returnMeta) {
            return { text, meta: { provider: 'azure-claude', modelId: model, stopReason: stop, usage } };
        }
        return text;
    } catch (err) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [Azure Claude] ✗ ${model} ${elapsed}s HTTP ${status || '?'} ${detail}`);
        throw err;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Azure OpenAI-compatible text — Azure Foundry deployments such as Grok/DeepSeek.
// api-key auth; endpoint + model are config-driven. Same route/fallback
// machinery as AiLink/APlink/Azure Claude.
// ──────────────────────────────────────────────────────────────────────────
async function _azureOpenAIText(prompt, maxTokens, temperature, systemPrompt, opts = {}) {
    const { taskType, returnMeta = false } = opts;
    const az = config.azureOpenAI || {};
    const _liveGate = process.env.AZURE_OPENAI_TASK_TYPES;
    const _gateTasks = _liveGate !== undefined
        ? _csvTaskGate(_liveGate)
        : _csvTaskGate((Array.isArray(az.allowedTasks) ? az.allowedTasks : []).join(','));
    if (_gateTasks.length > 0 && taskType && !_gateTasks.includes(taskType)) {
        throw new Error(`Azure OpenAI blocked: taskType=${taskType} not in AZURE_OPENAI_TASK_TYPES`);
    }
    if (!az.apiKey) throw new Error('Azure OpenAI not configured: set AZURE_OPENAI_API_KEY or AZURE_API_KEY');
    if (!az.baseUrl) throw new Error('Azure OpenAI not configured: set AZURE_OPENAI_ENDPOINT');

    const axios = require('axios');
    const model = opts.model || az.model || 'grok-4.3';
    const baseUrl = _azureOpenAIBaseUrl(az.baseUrl);
    const url = `${baseUrl}/chat/completions`;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt || '') });
    const body = {
        model,
        messages,
        ..._azureOpenAITuning(model, maxTokens, temperature, 800),
    };
    const headers = {
        'Content-Type': 'application/json',
        'api-key': az.apiKey,
    };
    const _azureTimeout = parseInt(process.env.AZURE_OPENAI_TIMEOUT_MS, 10)
        || parseInt(process.env.AZURE_TIMEOUT_MS, 10)
        || Math.max(120_000, Math.min(420_000, 90_000 + (Number(maxTokens) || 800) * 35));

    const started = Date.now();
    try {
        const resp = await _azureRetrying('Azure OpenAI', model, taskType, () =>
            axios({ url, method: 'POST', data: body, headers, timeout: _azureTimeout, adapter: 'http' }));
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const choice = resp.data?.choices?.[0] || {};
        const content = choice?.message?.content ?? choice?.text ?? '';
        const text = Array.isArray(content)
            ? content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('\n').trim()
            : String(content || '').trim();
        const usage = resp.data?.usage || {};
        const finish = choice?.finish_reason || 'unknown';
        console.log(`  [Azure OpenAI] ${model} task=${taskType || '?'} ${elapsed}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${finish}`);
        recordUsage({ provider: 'azure-openai', model, taskType, kind: 'text', usage });
        if (!text) console.log(`  [Azure OpenAI] ⚠️ EMPTY response (finish=${finish})`);
        if (returnMeta) {
            return { text, meta: { provider: 'azure-openai', modelId: model, stopReason: finish, usage } };
        }
        return text;
    } catch (err) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [Azure OpenAI] ✗ ${model} ${elapsed}s HTTP ${status || '?'} ${detail}`);
        throw err;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Azure Managed Compute — single endpoint, two models.
// Brain-tier tasks → AZURE_MANAGED_BRAIN_MODEL (ornith), everything else
// (default, utility, vision, scoring) → AZURE_MANAGED_DEFAULT_MODEL (qwen).
// The dropdown option "Azure Managed" sets AZURE_MANAGED_TASK_TYPES to gate
// which tasks go to the brain model; all other text + all vision uses qwen.
// ──────────────────────────────────────────────────────────────────────────
async function _azureManagedText(prompt, maxTokens, temperature, systemPrompt, opts = {}) {
    const { taskType, returnMeta = false } = opts;
    const am = config.azureManaged || {};
    if (!am.apiKey) throw new Error('Azure Managed not configured: set AZURE_MANAGED_API_KEY');
    if (!am.baseUrl) throw new Error('Azure Managed not configured: set AZURE_MANAGED_ENDPOINT');

    const axios = require('axios');
    // Brain model for gated tasks, default model for everything else.
    const brainTasks = am.brainTaskTypes.length > 0
        ? am.brainTaskTypes
        : _csvTaskGate((process.env.AZURE_MANAGED_BRAIN_TASK_TYPES || '').length
            ? process.env.AZURE_MANAGED_BRAIN_TASK_TYPES : 'brain,planner-outline,planner-large,planner-small');
    const isBrain = brainTasks.includes(taskType);
    const model = isBrain ? (am.brainModel || 'deepreinforce-ai--ornith-10-397b')
                          : (am.defaultModel || 'qwen--qwen38-27b');
    const baseUrl = _azureOpenAIBaseUrl(am.baseUrl);
    const url = `${baseUrl}/chat/completions`;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt || '') });
    const body = {
        model,
        messages,
        ..._azureOpenAITuning(model, maxTokens, temperature, 800),
    };
    const headers = {
        'Content-Type': 'application/json',
        'api-key': am.apiKey,
    };
    const _amTimeout = parseInt(process.env.AZURE_MANAGED_TIMEOUT_MS, 10)
        || parseInt(process.env.AZURE_TIMEOUT_MS, 10)
        || Math.max(120_000, Math.min(420_000, 90_000 + (Number(maxTokens) || 800) * 35));

    const started = Date.now();
    try {
        const resp = await _azureRetrying('Azure Managed', model, taskType, () =>
            axios({ url, method: 'POST', data: body, headers, timeout: _amTimeout, adapter: 'http' }));
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const choice = resp.data?.choices?.[0] || {};
        const content = choice?.message?.content ?? choice?.text ?? '';
        const text = Array.isArray(content)
            ? content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('\n').trim()
            : String(content || '').trim();
        const usage = resp.data?.usage || {};
        const finish = choice?.finish_reason || 'unknown';
        const label = isBrain ? 'brain' : 'default';
        console.log(`  [Azure Managed] ${model} (${label}) task=${taskType || '?'} ${elapsed}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${finish}`);
        recordUsage({ provider: 'azure-managed', model, taskType, kind: 'text', usage });
        if (!text) console.log(`  [Azure Managed] ⚠️ EMPTY response (finish=${finish})`);
        if (returnMeta) {
            return { text, meta: { provider: 'azure-managed', modelId: model, stopReason: finish, usage } };
        }
        return text;
    } catch (err) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [Azure Managed] ✗ ${model} ${elapsed}s HTTP ${status || '?'} ${detail}`);
        throw err;
    }
}

// ============================================================
// VISION AI — callVisionAI(prompt, base64Image, mimeType, options)
// ============================================================

/**
 * Call the configured AI provider with a vision (image + text) prompt.
 * @param {string} prompt - The text prompt
 * @param {string} base64Image - Base64-encoded image data
 * @param {string} [mimeType='image/jpeg'] - Image MIME type
 * @param {object} [options] - Optional settings
 * @param {number} [options.maxTokens=200] - Max tokens in response
 * @returns {Promise<string>} The AI response text
 */
// Creator directives on the VISION route. The text-brain route already hears the
// order via _productionDirectives; footage/clip vetting was deaf to it. This adds
// a short, footage-scoped prepend so "prefer real footage / no stock-looking
// clips / no on-image text" reach clip scoring. Gated: DIRECTIVE_VISION default-on,
// shares the AI_INSTRUCTIONS_GLOBAL kill-switch. Empty order → '' → unchanged.
function _visionDirectives() {
    if (/^(0|false|off|no)$/i.test(String(process.env.DIRECTIVE_VISION || '').trim())) return '';
    if (/^(0|false|off|no)$/i.test(String(process.env.AI_INSTRUCTIONS_GLOBAL || '').trim())) return '';
    const raw = String(process.env.AI_INSTRUCTIONS || '').trim();
    if (!raw) return '';
    return `The video's creator set production rules. When judging whether this footage fits, ALSO honor any that affect footage SELECTION (source, real-vs-stock, on-image text, subject) — ignore rules that don't apply to a still image:\n"""\n${raw}\n"""\n\n`;
}

async function callVisionAI(prompt, base64Image, mimeType = 'image/jpeg', options = {}) {
    const { maxTokens = 200 } = options;
    const normalized = await _normalizeVisionImage(base64Image, mimeType, options);
    if (normalized.unreadable) {
        // Stop here. Walking the chain with bytes nothing can decode costs one
        // paid call per provider and cannot possibly succeed. The tag lets the
        // caller record a DEFECTIVE CANDIDATE rather than a vision outage —
        // an outage makes callers keep the clip and can abort a whole race.
        const err = new Error(`vision image is undecodable (${normalized.reason || 'unknown format'})`);
        err.visionImageUnreadable = true;
        throw err;
    }
    base64Image = normalized.base64;
    mimeType = normalized.mimeType;
    if (normalized.changed && options.logVisionCompression !== false) {
        console.log(`  [vision] normalized image ${normalized.width || '?'}x${normalized.height || '?'} ${Math.round(normalized.bytes / 1024)}KB`);
    }
    const _vdir = _visionDirectives();
    if (_vdir) prompt = _vdir + String(prompt || '');

    // Vision chain: direct DashScope Qwen primary, then configured fallbacks.
    // …unless the caller pinned one specific judge (options.visionProvider), in
    // which case the chain is exactly that one seat, with NO failover. That is
    // deliberate: the judge panel needs each seat to be a known model, because a
    // seat that silently falls back to its neighbour would make the panel two
    // votes from the SAME model — i.e. one judge wearing two hats — and destroy
    // the whole point of averaging two models that fail in opposite directions.
    // A pinned seat that dies throws; the panel drops that seat and uses the rest.
    const chain = _visionChainFor(options);

    for (let i = 0; i < chain.length; i++) {
        const provider = chain[i];
        const isFallback = i > 0;

        try {
            const text = await _dispatchVision(provider, prompt, base64Image, mimeType, maxTokens);

            if (!text || text.trim().length === 0) {
                // Retry once on same provider before moving to fallback
                try {
                    console.log(`  ⚠️ [${provider}] Empty vision response, retrying...`);
                    const retry = await _dispatchVision(provider, prompt, base64Image, mimeType, maxTokens);
                    if (retry && retry.trim().length > 0) {
                        try { require('../vision/vision-rewake').observe(provider); } catch (_) {}
                        return retry;
                    }
                } catch (e) { /* fall through to next provider */ }

                if (i < chain.length - 1) {
                    console.log(`  🔄 [${provider}] Vision failed, falling back to ${chain[i + 1]}...`);
                    continue;
                }
                return '';
            }

            if (isFallback) {
                console.log(`  ✅ [${provider}] Vision fallback succeeded`);
            }
            // Mid-build watchdog: note which backend actually served this call. A run of
            // Bedrock fallbacks (free GPU asleep) triggers a background rotate/re-wake.
            try { require('../vision/vision-rewake').observe(provider); } catch (_) {}
            return text;
        } catch (error) {
            console.log(`  ⚠️ [${provider}] Vision error: ${error.message}`);
            // Entitlement/config failures are permanent — flag once, loudly, and stop
            // paying a doomed roundtrip for them on every remaining frame.
            const permanent = _permanentVisionFailure(error);
            if (permanent) _markVisionProviderDead(provider, permanent, i === 0);
            if (i < chain.length - 1) {
                console.log(`  🔄 Falling back to ${chain[i + 1]} for vision...`);
                continue;
            }
            throw error;
        }
    }

    return '';
}

/**
 * Check if Qwen vision has ANY usable model right now (across all keys).
 * Returns false when every model is either permanently exhausted OR in active cooldown.
 * Used to short-circuit qwen out of the vision chain when the whole pool is dead —
 * otherwise every vision call wastes a roundtrip + logs spam ("All Qwen image-capable models exhausted")
 * before falling back to gemini/nvidia.
 */
function _isQwenVisionUsable() {
    const keys = _getQwenKeys('image');
    if (keys.length === 0) return false;
    return _getBestKeyAndModel(QWEN_IMAGE_POOL, config.qwen?.visionModel, 'image') !== null;
}

// The automatic failover chain. `bedrock-nova-pro` is deliberately ABSENT: it is
// a valid, callable judge (see _bedrockVisionOptions) but it is over-literal —
// it rejects good footage — so it must never drift into the chain by default.
// It is reachable only when something names it explicitly (VISION_FALLBACK_ORDER,
// VISION_PROVIDER, or a panel seat).
const VISION_PROVIDER_ORDER = ['qwen', 'azure-openai', 'bedrock-qwen-vl', 'bedrock-claude', 'bedrock-nova'];
const VISION_PROVIDER_ALIASES = {
    bedrock: 'bedrock-qwen-vl',
    'bedrock-qwen': 'bedrock-qwen-vl',
    'qwen-vl': 'bedrock-qwen-vl',
    'qwen-bedrock': 'bedrock-qwen-vl',
    nova: 'bedrock-nova',
    'nova-lite': 'bedrock-nova',
    'bedrock-nova-lite': 'bedrock-nova',
    'nova-pro': 'bedrock-nova-pro',
    claude: 'bedrock-claude',
    dashscope: 'qwen',
    alibaba: 'qwen',
    azure: 'azure-openai',
    'azure-vision': 'azure-openai',
    'azure-grok': 'azure-openai',
    grok: 'azure-openai',
    'azure-sonnet': 'azure-claude',
};

function _hasBedrockVision() {
    return !!(config.bedrock?.accessKeyId && config.bedrock?.secretAccessKey);
}

function _hasAzureVision(provider) {
    const az = _normalizeVisionProviderName(provider) === 'azure-claude'
        ? config.azure
        : config.azureOpenAI;
    return !!(az?.apiKey && az?.baseUrl && az?.model);
}

function _normalizeVisionProviderName(value) {
    const id = String(value || '').trim().toLowerCase();
    if (!id) return '';
    return VISION_PROVIDER_ALIASES[id] || id;
}

function _visionProviderAvailable(provider) {
    switch (_normalizeVisionProviderName(provider)) {
        case 'bedrock-qwen-vl':
        case 'bedrock-claude':
        case 'bedrock-nova':
        case 'bedrock-nova-pro':
            return _hasBedrockVision();
        case 'azure-openai':
        case 'azure-claude':
            return _hasAzureVision(provider);
        case 'azure-managed':
            return !!(config.azureManaged?.apiKey && config.azureManaged?.baseUrl);
        case 'qwen':
            return _getQwenKeys('image').length > 0 && _isQwenVisionUsable();
        default: {
            const id = String(provider || '');
            if (!id.startsWith('connection:')) return false;
            const conn = aiConnections.getConnection(id.slice('connection:'.length));
            return !!(conn && aiConnections.modelFor(conn, 'vision'));
        }
    }
}

function _configuredVisionOrder() {
    // Runtime scene actions temporarily override VISION_PROVIDER (for example,
    // manual retries route straight to Bedrock). Read the live environment
    // before the startup snapshot in config so those scoped overrides work.
    const overridePrimary = _normalizeVisionProviderName(process.env.VISION_PROVIDER || config.visionProvider || '');
    const fallbackOrder = _parseEnvList(process.env.VISION_FALLBACK_ORDER || '')
        .map(_normalizeVisionProviderName)
        .filter(Boolean);
    const ordered = [
        overridePrimary || 'qwen',
        ...fallbackOrder,
        ...VISION_PROVIDER_ORDER,
    ];
    let chain = [...new Set(ordered)].filter(Boolean);
    // Per-scene Retry routes vision straight to Bedrock (the GPU box is slow to boot and
    // not worth waking for one scene). VISION_EXCLUDE_QWEN=1 drops the box from the chain.
    if (process.env.VISION_EXCLUDE_QWEN === '1') chain = chain.filter(p => p !== 'qwen');
    // Only a primary that SURVIVED that filter is a real pin. When Retry drops the
    // box, the old head ('qwen') is gone and whatever VISION_FALLBACK_ORDER lists
    // first simply slides into seat 0 — that is an accident, not a choice, and it
    // must not be protected from the hoist below.
    const pinnedFirst = !!overridePrimary && chain[0] === overridePrimary;
    return _hoistAzureAboveBedrock(chain, pinnedFirst);
}

// Azure outranks Bedrock in the FALLBACK tail, wherever that tail came from.
// VISION_FALLBACK_ORDER is spliced in AHEAD of VISION_PROVIDER_ORDER and ships as
// `bedrock-qwen-vl,bedrock-claude,bedrock-nova`, so adding Azure to the constant
// alone would still leave it stranded behind three Bedrock seats.
//
// That ordering is the whole bug (2026-08-14). With the AWS account dead, every
// Bedrock seat is a guaranteed UnrecognizedClientException per frame. When the
// self-hosted Qwen box went down mid-build the chain had no live provider left:
// each candidate scored 1/10, was rejected, and re-entered the race — 25k vision
// errors, a 142k-line log, and 2h20m of build producing only generic footage.
//
// A surviving explicit VISION_PROVIDER pin keeps seat 0 — per-scene Retry
// deliberately routes to Bedrock, and that choice is honoured.
function _hoistAzureAboveBedrock(chain, pinnedFirst) {
    const from = pinnedFirst ? 1 : 0;
    const firstBedrock = chain.findIndex((p, i) => i >= from && _isBedrockVisionProvider(p));
    if (firstBedrock < 0) return chain;
    const azure = chain.filter((p, i) => i > firstBedrock && _isAzureVisionProvider(p));
    if (azure.length === 0) return chain;
    const rest = chain.filter(p => !azure.includes(p));
    return [...rest.slice(0, firstBedrock), ...azure, ...rest.slice(firstBedrock)];
}

// ── Permanently-dead vision providers ───────────────────────────────────────
// A vision provider fails in two very different ways. A timeout, a 429 or a 5xx
// is TRANSIENT — retry it, fall back, try again on the next frame. An
// AccessDenied, a 403 or a bad model id is PERMANENT for this run: the account
// has no entitlement, or the id doesn't exist, and no amount of retrying changes
// that.
//
// Before this gate the two were indistinguishable — each just printed a warning
// and fell through to the next provider. On a build that scores ~2000 frames a
// permanent failure is 2000 identical warnings scrolling past at one per
// candidate, while the real judge quietly becomes whatever sits second in the
// chain. That happened for real (2026-08-04, `us.anthropic.claude-sonnet-5`,
// which this account has never been entitled to): the stand-in judge scored 0/3
// on footage a human would happily use, scenes came back as placeholder cards,
// and nothing in the log read like an error.
//
// So: say it once, loudly, with the exact fix — then stop calling the dead
// provider. Dropping it also removes a doomed roundtrip from every remaining
// vision call, which is pure latency back.
const _visionDead = new Map(); // normalized provider -> reason

function _permanentVisionFailure(error) {
    // The AWS SDK puts the reason in .message; an axios error says only "Request
    // failed with status code 404" and keeps the reason in the response body. Read
    // both, or the Azure seats can never be diagnosed as permanently dead and a
    // typo'd deployment costs one doomed roundtrip on every remaining frame.
    const body = error?.response?.data;
    const bodyText = typeof body === 'string' ? body : (() => {
        try { return JSON.stringify(body || ''); } catch (_) { return ''; }
    })();
    const msg = `${(error && error.name) || ''} ${(error && error.message) || ''} ${bodyText}`;
    if (/AccessDenied|not available for this account|\bhttp=403\b|don'?t have access to the model/i.test(msg)) {
        return 'this AWS account is not entitled to that model';
    }
    if (/model identifier is invalid|invalid model|ResourceNotFound|NOT IN REGION/i.test(msg)) {
        return 'that model id does not exist in this region';
    }
    if (/DeploymentNotFound/i.test(msg)) {
        return 'that Azure deployment does not exist on this endpoint';
    }
    // Dead/rotated AWS keys. Every Bedrock seat 403s identically and forever, so
    // reading this as transient means re-paying a doomed roundtrip on every frame
    // for every seat — which is exactly how one build logged 25k vision errors
    // (2026-08-14). Say it once, drop the seat, let the chain move on.
    if (/UnrecognizedClientException|security token included in the request is invalid|InvalidSignatureException|ExpiredToken/i.test(msg)) {
        return 'these AWS credentials are invalid or expired';
    }
    if (/on-demand throughput isn.?t supported|inference profile/i.test(msg)) {
        return "that model needs its cross-region 'us.*' inference-profile id, not the bare model id";
    }
    return null; // transient — leave it in the chain
}

function _visionProviderModelLabel(provider) {
    const opts = _bedrockVisionOptions(provider) || _azureVisionOptions(provider);
    if (!opts) return '';
    return process.env[opts.modelEnv] || opts.defaultModel || '';
}

function _markVisionProviderDead(provider, reason, isPrimary) {
    if (_visionDead.has(provider)) return;
    _visionDead.set(provider, reason);
    const model = _visionProviderModelLabel(provider);
    const bar = '='.repeat(74);
    console.error(`\n${bar}`);
    console.error(`❌ VISION JUDGE UNUSABLE${isPrimary ? ' (this was the PRIMARY judge)' : ''}: ${provider}`);
    if (model) console.error(`   model: ${model}`);
    console.error(`   why:   ${reason}`);
    if (isPrimary) {
        console.error('   Footage scoring is now being done by the next judge in the chain.');
        console.error('   A backup judge is not tuned for this job and tends to reject good');
        console.error('   footage, which is what produces "no footage — placeholder" scenes.');
    }
    if (_isAzureVisionProvider(provider)) {
        console.error('   fix:   check the deployment exists on AZURE_OPENAI_ENDPOINT / AZURE_ANTHROPIC_BASE_URL,');
        console.error('          then set AZURE_OPENAI_VISION_MODEL=<deployment> in the user .env');
    } else {
        console.error('   fix:   node scripts/bedrock-vision-probe.js     (what can this account call?)');
        console.error('          node scripts/vision-judge-bench.js       (which of those judges well?)');
        console.error('          then set VISION_BEDROCK_PRIMARY_MODEL=<id> in the user .env');
    }
    console.error('   Dropping it from the vision chain for the rest of this run.');
    console.error(`${bar}\n`);
}

function getDeadVisionProviders() {
    return [..._visionDead.entries()].map(([provider, reason]) => ({
        provider, reason, model: _visionProviderModelLabel(provider),
    }));
}

// The vision chain's front door. When the Eyes job points at AI Connections,
// they are the chain (then the built-in chain only if chosen as the backup).
// Otherwise the built-in chain below is returned exactly as before.
function _getVisionChain() {
    const eyes = aiConnections.routeForJob('eyes');
    if (!eyes) return _getBuiltInVisionChain();
    const seats = eyes.connections.map((conn) => `connection:${conn.id}`);
    const live = seats.filter((seat) => !_visionDead.has(seat));
    if (!eyes.builtInBackup) return live.length ? live : seats;
    let builtIn = [];
    try { builtIn = _getBuiltInVisionChain(); } catch (_) { builtIn = []; }
    const chain = [...(live.length ? live : seats), ...builtIn.filter((seat) => !seats.includes(seat))];
    return chain;
}

function _getBuiltInVisionChain() {
    // Default cost-safe route:
    //   1. qwen            — direct DashScope Qwen free-quota pool
    //   2. azure-managed   — Azure Managed Compute (Qwen model) when configured
    //   3. bedrock-qwen-vl — Qwen3 VL 235B on AWS Bedrock fallback
    //   4. bedrock-claude  — Claude Haiku 4.5 on Bedrock fallback
    //   5. bedrock-nova    — Amazon Nova Lite emergency fallback
    const chain = _configuredVisionOrder().filter(_visionProviderAvailable);
    // Insert azure-managed after qwen when it's configured (single-endpoint brain+vision).
    const am = config.azureManaged || {};
    const amConfigured = Boolean(am.apiKey && am.baseUrl);
    const primary = process.env.AI_PROVIDER || config.aiProvider || 'bedrock';
    if (amConfigured && primary === 'azure-managed' && !chain.includes('azure-managed')) {
        const qwenIdx = chain.indexOf('qwen');
        if (qwenIdx >= 0) {
            chain.splice(qwenIdx + 1, 0, 'azure-managed');
        } else {
            chain.unshift('azure-managed');
        }
    }
    // Skip providers this run has already proven unusable. If that would empty the
    // chain, keep the full one: a real error from a real call is far more useful
    // than a synthetic "nothing available" thrown from a bookkeeping map.
    const live = chain.filter((p) => !_visionDead.has(p));
    if (live.length > 0) return live;
    if (chain.length > 0) return chain;

    throw new Error('No usable vision provider — Bedrock vision creds missing and direct Qwen pool unavailable');
}

function getVisionProviderChain() {
    return _getVisionChain().slice();
}

/**
 * Resolve the chain for ONE callVisionAI call.
 *
 * Normal calls get the configured failover chain. A caller that passes
 * `options.visionProvider` gets a one-seat chain instead — that exact judge, no
 * failover, throw on failure. See the comment at the call site for why a panel
 * seat must never silently become a different model.
 */
function _visionChainFor(options) {
    const pinned = _normalizeVisionProviderName(options && options.visionProvider);
    if (!pinned) return _getVisionChain();

    if (!_visionProviderAvailable(pinned)) {
        const err = new Error(`vision provider "${pinned}" is not available (missing credentials, or its key pool is exhausted)`);
        err.visionProviderUnavailable = true;
        throw err;
    }
    if (_visionDead.has(pinned)) {
        const err = new Error(`vision provider "${pinned}" is unusable this run: ${_visionDead.get(pinned)}`);
        err.visionProviderUnavailable = true;
        throw err;
    }
    return [pinned];
}

/** Is this judge callable right now? Used to size a panel before paying for it. */
function isVisionProviderUsable(provider) {
    const id = _normalizeVisionProviderName(provider);
    if (!id) return false;
    return _visionProviderAvailable(id) && !_visionDead.has(id);
}

function isVisionAIAvailable() {
    try {
        return _getVisionChain().length > 0;
    } catch (_) {
        return false;
    }
}

function _isBedrockVisionProvider(provider) {
    return ['bedrock-qwen-vl', 'bedrock-claude', 'bedrock-nova', 'bedrock-nova-pro']
        .includes(_normalizeVisionProviderName(provider));
}

function _isAzureVisionProvider(provider) {
    return ['azure-openai', 'azure-claude', 'azure-managed'].includes(_normalizeVisionProviderName(provider));
}

// Vision deployment is configured separately from the text one: the same Azure
// resource can host a strong text model and a different vision-capable one, and
// moving text must not silently move the footage judge. Unset → the text model.
function _azureVisionOptions(provider) {
    switch (_normalizeVisionProviderName(provider)) {
        case 'azure-openai':
            return {
                modelEnv: 'AZURE_OPENAI_VISION_MODEL',
                defaultModel: config.azureOpenAI?.model || 'grok-4.3',
                tag: 'azure-openai',
            };
        case 'azure-claude':
            return {
                modelEnv: 'AZURE_CLAUDE_VISION_MODEL',
                defaultModel: config.azure?.model || 'claude-sonnet-4-6',
                tag: 'azure-claude',
            };
        default:
            return null;
    }
}

function _bedrockVisionOptions(provider, kind = 'image') {
    const suffix = kind === 'video' ? '-video' : '';
    switch (_normalizeVisionProviderName(provider)) {
        case 'bedrock-qwen-vl':
            return {
                modelEnv: 'BEDROCK_VISION_QWEN_MODEL',
                defaultModel: 'qwen.qwen3-vl-235b-a22b',
                tag: `bedrock-qwen-vl${suffix}`,
            };
        case 'bedrock-claude':
            return {
                modelEnv: 'BEDROCK_VISION_CLAUDE_MODEL',
                defaultModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
                tag: `bedrock-claude${suffix}`,
            };
        case 'bedrock-nova':
            return {
                modelEnv: 'BEDROCK_VISION_NOVA_MODEL',
                defaultModel: 'us.amazon.nova-lite-v1:0',
                tag: `bedrock-nova${suffix}`,
            };
        case 'bedrock-nova-pro':
            // Separate seat from bedrock-nova ON PURPOSE. They are different
            // models with different quotas and OPPOSITE biases (Lite is lenient,
            // Pro is literal), and Bedrock meters RPM per model — so sharing one
            // provider id would have meant sharing one pacer between two limits,
            // which is the exact bug the per-model pacer was written to kill.
            return {
                modelEnv: 'BEDROCK_VISION_NOVA_PRO_MODEL',
                defaultModel: 'us.amazon.nova-pro-v1:0',
                tag: `bedrock-nova-pro${suffix}`,
            };
        default:
            return null;
    }
}

async function _dispatchVision(provider, prompt, base64Image, mimeType, maxTokens) {
    if (String(provider).startsWith('connection:')) {
        return await _connectionVision(String(provider).slice('connection:'.length), prompt, [{ base64: base64Image, mimeType }], maxTokens);
    }
    // Active vision providers:
    //   qwen            — direct DashScope free-quota pool
    //   azure-openai    — Azure Foundry chat/completions, first fallback off the box
    //   azure-claude    — Azure Foundry Anthropic messages, named-only (see below)
    //   bedrock-qwen-vl — paid quality fallback
    //   bedrock-claude  — instruction fallback
    //   bedrock-nova    — cheap/emergency fallback
    switch (provider) {
        case 'qwen':
            return await _qwenVision(prompt, base64Image, mimeType, maxTokens);
        case 'azure-openai':
            return await _azureOpenAIVision(prompt, base64Image, mimeType, maxTokens, _azureVisionOptions(provider));
        case 'azure-managed':
            return await _azureManagedVision(prompt, base64Image, mimeType, maxTokens, _azureVisionOptions(provider));
        case 'azure-claude':
            return await _azureClaudeVision(prompt, base64Image, mimeType, maxTokens, _azureVisionOptions(provider));
        case 'bedrock-nova':
        case 'bedrock-nova-pro':
        case 'bedrock-qwen-vl':
        case 'bedrock-claude':
            return await _bedrockVision(prompt, base64Image, mimeType, maxTokens, _bedrockVisionOptions(provider));
        default:
            throw new Error(`Vision provider "${provider}" was removed in 2026-05-25 cleanup. Use qwen / azure-openai / azure-claude / bedrock-nova / bedrock-nova-pro / bedrock-qwen-vl / bedrock-claude.`);
    }
}

// ── Azure vision ────────────────────────────────────────────────────────────
// The same two Azure surfaces the text brain already routes through, handed an
// image. Both were measured on this account (2026-08-14, 5 concurrent 72KB PNG
// frames), and the numbers decide which one the chain gets:
//
//   azure-openai / grok-4.3      50 req/min, 50k tok/min   5/5 ok   ~6s
//   azure-claude / sonnet-4-6     3 req/min,  2.5k tok/min  4/5 ok   ~2s
//
// Only azure-openai sits in VISION_PROVIDER_ORDER. Sonnet is the better judge —
// it is the single clean sweep in the bench recorded in config.js — but 3 req/min
// cannot carry a build that scores thousands of frames, and this file already has
// the scar tissue from trying: Bedrock Sonnet's quota produced 800 rate-limit
// waits and ~2 hours of dead time in one run. A judge that is right and never
// arrives loses to a judge that is nearly right and does. So azure-claude stays a
// named-only seat — reachable via VISION_PROVIDER, VISION_FALLBACK_ORDER or a
// panel seat — exactly like bedrock-nova-pro above it.
// GPT-5.x is a REASONING model: `max_completion_tokens` budgets the private
// reasoning pass AND the visible answer out of one pool, and the reasoning is
// spent FIRST. The scorecard the vision prompts ask for is short — measured on
// gpt-5.6-terra across 3702 successful calls: p50 90, p90 171, p99 561, max 774
// completion tokens — but the 200-token default that suits the non-reasoning Qwen
// judge is swallowed whole by the thinking before one visible character is
// emitted, and the call returns "" with finish_reason=length. Measured on the
// 2026-08-15 build: 442 of 4144 vision calls came back empty exactly that way,
// and every one of them costs a same-provider retry plus a walk down the fallback
// chain — so the low cap was more expensive than the headroom it saved.
// Non-reasoning judges keep the old budget byte-for-byte.
const VISION_REASONING_MIN_TOKENS = 1500;

// A NON-reasoning judge needs room to answer too. Measured 2026-08-28 against
// qwen--qwen38-27b using ai-vision.js's real detectSubjectFocus prompt: at the 60 the
// app passes it returned "" with finish=length; at 120 (the overlay check's budget) the
// same; only at 400 did it answer, using 354 completion tokens. Both call sites fail
// SILENTLY BY DESIGN — detectSubjectFocus returns a centre crop, the overlay check
// returns null — so face anchoring and burned-in-text rejection were quietly dead with
// nothing in any log. Gating the floor on a model NAME left every non-gpt-5 judge here.
// VISION_MIN_MAX_TOKENS overrides.
const VISION_MIN_TOKENS = 400;

function _visionCompletionBudget(model, maxTokens) {
    const asked = Number(maxTokens) || 200;
    const floor = _isReasoningModel(model)
        ? (parseInt(process.env.VISION_MAX_TOKENS, 10) || VISION_REASONING_MIN_TOKENS)
        : (parseInt(process.env.VISION_MIN_MAX_TOKENS, 10) || VISION_MIN_TOKENS);
    return Math.max(asked, floor);
}

function _azureVisionTimeout(maxTokens) {
    return parseInt(process.env.AZURE_VISION_TIMEOUT_MS, 10)
        || parseInt(process.env.AZURE_TIMEOUT_MS, 10)
        || Math.max(120_000, Math.min(420_000, 90_000 + (Number(maxTokens) || 200) * 35));
}

function _azureVisionLog(tag, model, started, usage, stop, text, budget) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  [${tag}] ${model} ${elapsed}s in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} stop=${stop}`);
    if (!text) {
        console.log(`  [${tag}] ⚠️ EMPTY response (stop=${stop})`);
        // Naming the cap makes the "judge said nothing" case self-diagnosing: an
        // empty answer that stopped at exactly its budget is a truncation, not a
        // refusal, and the fix is VISION_MAX_TOKENS — not a different judge.
        if (stop === 'length' && budget) {
            const reasoning = usage.completion_tokens_details?.reasoning_tokens;
            console.log(`  [${tag}] ⚠️ truncated at the completion cap (${budget} tokens`
                + `${Number.isFinite(reasoning) ? `, ${reasoning} spent reasoning` : ''})`
                + ' — raise VISION_MAX_TOKENS');
        }
    }
}

async function _azureOpenAIVision(prompt, base64Image, mimeType, maxTokens, opts) {
    const az = config.azureOpenAI || {};
    if (!az.apiKey) throw new Error('Azure OpenAI vision not configured: set AZURE_OPENAI_API_KEY or AZURE_API_KEY');
    if (!az.baseUrl) throw new Error('Azure OpenAI vision not configured: set AZURE_OPENAI_ENDPOINT');

    const axios = require('axios');
    const model = process.env[opts.modelEnv] || opts.defaultModel;
    const url = `${_azureOpenAIBaseUrl(az.baseUrl)}/chat/completions`;
    const budget = _visionCompletionBudget(model, maxTokens);
    const body = {
        model,
        ..._azureOpenAITuning(model, budget, undefined, 200),
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: String(prompt || '') },
                { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64Image}` } },
            ],
        }],
    };

    const started = Date.now();
    try {
        const resp = await _azureRetrying(opts.tag, model, 'vision', () => axios({
            url, method: 'POST', data: body, adapter: 'http',
            headers: { 'Content-Type': 'application/json', 'api-key': az.apiKey },
            timeout: _azureVisionTimeout(budget),
        }));
        const choice = resp.data?.choices?.[0] || {};
        const content = choice?.message?.content ?? choice?.text ?? '';
        const text = Array.isArray(content)
            ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n').trim()
            : String(content || '').trim();
        const usage = resp.data?.usage || {};
        recordUsage({ provider: opts.tag, model, taskType: 'vision', kind: 'vision', usage });
        _azureVisionLog(opts.tag, model, started, usage, choice?.finish_reason || 'unknown', text, budget);
        return text;
    } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [${opts.tag}] ❌ ${model} http=${status || '?'} ${detail}`);
        throw err;
    }
}

// Wrapped by the SAME in-flight limiter as the Qwen lanes. Azure Managed Compute is a
// hosted API, but "hosted" here means one deployment on a fixed number of accelerators —
// it has exactly the finite queue a rented box has, not an elastic multi-tenant pool.
// The number of instances is chosen at deploy time and Azure's H100 pool is often short:
// on 2026-09-01 only 1 accelerator was free where the run wanted 8. At
// MEDIA_SCENE_CONCURRENCY=32 that is ~160 scoring calls aimed at a single GPU, which
// does not fail cleanly — it stretches latency until calls time out, and a timed-out
// judge reads downstream as `unjudged`, i.e. silently worse footage rather than a visible
// error. Cap is opt-in: unset/0 keeps the previous unlimited behaviour exactly.
async function _azureManagedVision(prompt, base64Image, mimeType, maxTokens, opts) {
    const release = await _acquireVisionSlot();
    try { return await _azureManagedVisionInner(prompt, base64Image, mimeType, maxTokens, opts); }
    finally { release(); }
}

async function _azureManagedVisionInner(prompt, base64Image, mimeType, maxTokens, opts) {
    const am = config.azureManaged || {};
    if (!am.apiKey) throw new Error('Azure Managed vision not configured: set AZURE_MANAGED_API_KEY');
    if (!am.baseUrl) throw new Error('Azure Managed vision not configured: set AZURE_MANAGED_ENDPOINT');

    const axios = require('axios');
    // Vision uses the vision deployment when one is named, else the default (qwen)
    // deployment — the brain model is text-only either way.
    const model = am.visionModel || am.defaultModel || 'qwen--qwen38-27b';
    const url = `${_azureOpenAIBaseUrl(am.baseUrl)}/chat/completions`;
    const budget = _visionCompletionBudget(model, maxTokens);
    const body = {
        model,
        ..._azureOpenAITuning(model, budget, undefined, 200),
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: String(prompt || '') },
                { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64Image}` } },
            ],
        }],
    };

    const started = Date.now();
    try {
        const resp = await _azureRetrying('Azure Managed', model, 'vision', () => axios({
            url, method: 'POST', data: body, adapter: 'http',
            headers: { 'Content-Type': 'application/json', 'api-key': am.apiKey },
            timeout: _azureVisionTimeout(budget),
        }));
        const choice = resp.data?.choices?.[0] || {};
        const content = choice?.message?.content ?? choice?.text ?? '';
        const text = Array.isArray(content)
            ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n').trim()
            : String(content || '').trim();
        const usage = resp.data?.usage || {};
        recordUsage({ provider: 'azure-managed', model, taskType: 'vision', kind: 'vision', usage });
        _azureVisionLog('Azure Managed', model, started, usage, choice?.finish_reason || 'unknown', text, budget);
        return text;
    } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [Azure Managed] ❌ ${model} http=${status || '?'} ${detail}`);
        throw err;
    }
}

async function _azureClaudeVision(prompt, base64Image, mimeType, maxTokens, opts) {
    const az = config.azure || {};
    if (!az.apiKey) throw new Error('Azure Claude vision not configured: set AZURE_API_KEY or AZURE_OPENAI_API_KEY');
    if (!az.baseUrl) throw new Error('Azure Claude vision not configured: set AZURE_ANTHROPIC_BASE_URL or AZURE_OPENAI_ENDPOINT');

    const axios = require('axios');
    const model = process.env[opts.modelEnv] || opts.defaultModel;
    const url = `${_azureAnthropicBaseUrl(az.baseUrl)}/v1/messages`;
    const body = {
        model,
        max_tokens: maxTokens || 200,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64Image } },
                { type: 'text', text: String(prompt || '') },
            ],
        }],
        stream: false,
    };

    const started = Date.now();
    try {
        const resp = await _azureRetrying(opts.tag, model, 'vision', () => axios({
            url, method: 'POST', data: body, adapter: 'http',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': az.apiKey,
                'anthropic-version': az.apiVersion || '2023-06-01',
            },
            timeout: _azureVisionTimeout(maxTokens),
        }));
        const text = _anthropicMessageText(resp.data);
        const usage = {
            prompt_tokens: resp.data?.usage?.input_tokens || 0,
            completion_tokens: resp.data?.usage?.output_tokens || 0,
        };
        recordUsage({ provider: opts.tag, model, taskType: 'vision', kind: 'vision', usage });
        _azureVisionLog(opts.tag, model, started, usage, resp.data?.stop_reason || 'unknown', text);
        return text;
    } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200);
        console.log(`  [${opts.tag}] ❌ ${model} http=${status || '?'} ${detail}`);
        throw err;
    }
}

// ── Bedrock vision call via ConverseCommand ──
// ConverseCommand normalizes the multimodal message format across Bedrock
// vision providers (Nova, Anthropic Claude, Qwen, Meta Llama 3.2 Vision),
// so the same call shape works for all three of our fallbacks. The image
// is passed as raw bytes; mimeType is mapped to Bedrock's `format` enum.
// NOTE: a `_bedrockImageFormat(mimeType)` helper used to live here, mapping a
// *declared* mime type to Bedrock's format enum. It is deliberately gone: every
// call site that trusted a label instead of the bytes produced the 400 described
// below. Sniff the bytes with _detectImageFormatFromBytes and refuse the payload
// when the signature is unknown — do not re-add a label-based fallback.

// Detect image format from the leading bytes (magic numbers) so Bedrock's declared
// `format` always matches the actual bytes. Returns null when unrecognized.
function _detectImageFormatFromBytes(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
    return null;
}

function _shortBedrockModel(modelId) {
    return String(modelId || '').split('.').slice(-2).join('.').replace(/-v\d+:?\d*$/, '');
}

function _isBedrockTruncated(stopReason) {
    return /max[_-]?tokens?|length/i.test(String(stopReason || ''));
}

function _nextVisionMaxTokens(maxTokens) {
    const current = Math.max(32, Number(maxTokens) || 800);
    const cap = Math.max(current, parseInt(process.env.BEDROCK_VISION_TRUNCATION_MAX_TOKENS || '1200', 10) || 1200);
    return Math.min(cap, Math.max(current + 160, Math.ceil(current * 1.75)));
}

// ── Bedrock vision pacing — per model, learned in-run ────────────────────────
// Bedrock enforces requests-per-minute PER MODEL, and the ceiling differs by
// model, by region and by account. One flat number cannot describe that.
//
// What this replaced, and what it cost (2026-08-04, log app-2026-08-04T21-03-06):
// a single shared bucket at a flat BEDROCK_VISION_MAX_RPM=80 covering every
// Bedrock vision model. Two failures compounded. Qwen-VL's calls spent Sonnet's
// budget and Sonnet's spent Qwen-VL's, so neither model's pacing described its
// own limit; and 80 was simply above what this account allows for Sonnet 4.6,
// with nothing in the loop able to discover that. Result: 89 Throttling-
// Exceptions in 11 minutes, and because the vision chain reads any thrown error
// as "this provider failed", all 89 of those frames were handed to the weaker
// fallback judge — the exact judge the run had been set up to stop using. Only
// 36 of ~125 judgements were made by the model that was supposed to be judging.
//
// The shape here is additive-increase / multiplicative-decrease, the same
// congestion control TCP uses, for the same reason: the real limit is not
// knowable up front and does not stay put. Every throttle cuts the ceiling
// hard; a sustained clean stretch *while saturated* eases it back up. It
// converges on whatever the account actually allows, per model, inside the run,
// with no per-model constant to maintain. BEDROCK_VISION_MAX_RPM stops being
// the rate and becomes the upper bound the search starts from.
const VISION_PACE_FLOOR_RPM = 4;      // never pace below this; a stall is worse than a throttle
const VISION_PACE_EASE_MS = 45_000;   // clean stretch required before probing upward again
const _visionPacers = new Map();      // model id -> { times, ceiling, lastThrottleAt, lastEaseAt, saturated }

function _visionPaceCap() {
    const raw = parseInt(process.env.BEDROCK_VISION_MAX_RPM || '80', 10);
    return Number.isFinite(raw) ? raw : 80;
}

function _visionPacer(key) {
    const id = String(key || 'default');
    let p = _visionPacers.get(id);
    if (!p) {
        p = { times: [], ceiling: null, lastThrottleAt: 0, lastEaseAt: 0, saturated: false };
        _visionPacers.set(id, p);
    }
    if (p.ceiling == null) p.ceiling = _visionPaceCap();
    return p;
}

// AWS just said "too fast". That is the only measurement of the real ceiling we
// will ever get, so treat it as authoritative and cut hard: guessing low costs a
// few seconds of pacing, guessing high costs another frame judged by the wrong
// model.
function _noteVisionThrottle(tag, modelId) {
    if (_visionPaceCap() <= 0) return;
    const p = _visionPacer(modelId || tag);
    const before = p.ceiling;
    p.ceiling = Math.max(VISION_PACE_FLOOR_RPM, Math.floor(p.ceiling * 0.6));
    p.lastThrottleAt = Date.now();
    p.saturated = true;
    if (p.ceiling !== before) {
        console.log(`  [${tag}] pace: throttled at ${before}/min → tightening ${_shortBedrockModel(modelId || tag)} to ${p.ceiling}/min`);
    }
}

async function _throttleBedrockVision(tag = 'bedrock-vision', modelId = '') {
    if (_visionPaceCap() <= 0) return; // 0 disables pacing entirely, as before
    const cap = _visionPaceCap();
    const p = _visionPacer(modelId || tag);

    const windowMs = 60_000;
    while (true) {
        const now = Date.now();
        while (p.times.length && now - p.times[0] >= windowMs) p.times.shift();

        // Probe upward only while actually pushing against the ceiling. Easing
        // after an idle gap would "prove" headroom that was never tested, and
        // the next burst would rediscover the limit the expensive way.
        if (p.saturated && p.ceiling < cap
            && now - p.lastThrottleAt > VISION_PACE_EASE_MS
            && now - p.lastEaseAt > VISION_PACE_EASE_MS) {
            p.ceiling = Math.min(cap, p.ceiling + 2);
            p.lastEaseAt = now;
            console.log(`  [${tag}] pace: clean for ${Math.round(VISION_PACE_EASE_MS / 1000)}s — easing ${_shortBedrockModel(modelId || tag)} up to ${p.ceiling}/min`);
        }

        if (p.times.length < p.ceiling) {
            p.times.push(now);
            return;
        }
        p.saturated = true;
        const waitMs = Math.max(250, p.times[0] + windowMs - now + 50);
        console.log(`  [${tag}] RPM guard: waiting ${(waitMs / 1000).toFixed(1)}s (${p.times.length}/${p.ceiling} vision calls in rolling minute)`);
        await _sleep(waitMs);
    }
}

function _isVisionThrottleError(err) {
    if ((err && err.$metadata && err.$metadata.httpStatusCode) === 429) return true;
    return /Throttling|TooManyRequests|too many requests|rate ?limit|slow down/i
        .test(`${(err && err.name) || ''} ${(err && err.message) || ''}`);
}

// A throttle is a "wait", not a "this model cannot do it".
//
// The vision chain treats any thrown error as "this provider failed, use the
// next one". For a 403 that is exactly right. For a 429 it is exactly wrong:
// the model is entitled, capable, and already chosen, and the only thing it
// asked for was a moment. Falling back there trades the best judge in the chain
// for the weakest one to save about a second.
//
// So absorb throttles here, in the transport, *below* the chain — retry the
// same model with backoff and let the error out only when it genuinely will not
// clear. From the chain's point of view nothing changed except that a throttled
// call takes longer to fail, which is the one case where waiting is the correct
// answer. Each retry re-enters the pacer, so it is already running at the
// tightened rate rather than straight back into the wall.
async function _withVisionThrottleRetry(tag, modelId, fn) {
    const attempts = Math.max(1, parseInt(process.env.BEDROCK_VISION_THROTTLE_RETRIES || '4', 10) || 4);
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            if (!_isVisionThrottleError(err)) throw err;
            lastErr = err;
            _noteVisionThrottle(tag, modelId);
            if (i === attempts - 1) break;
            // Jitter is not decoration here: the candidate race issues these in
            // parallel, so a fixed delay would resynchronize every waiter into
            // one burst and throttle the whole group again together.
            const base = Math.min(15_000, 800 * Math.pow(2, i));
            const waitMs = Math.round(base * (0.5 + Math.random()));
            console.log(`  [${tag}] throttled — retrying same model in ${(waitMs / 1000).toFixed(1)}s (${i + 1}/${attempts - 1})`);
            await _sleep(waitMs);
        }
    }
    throw lastErr;
}

// Pace direct DashScope Qwen vision calls to stay under the free-tier RPM. Without it,
// the candidate race's parallel vision scores burst → 429 rate-limit → models benched →
// the free pool depletes → vision falls to PAID Bedrock (the ~3h media phase). Rolling
// 60s window, shared across keys/models. Tune with QWEN_VISION_MAX_RPM (0 disables).
const _qwenVisionCallTimes = [];
async function _throttleQwenVision() {
    const maxRpm = parseInt(process.env.QWEN_VISION_MAX_RPM || '120', 10) || 0;
    if (maxRpm <= 0) return;
    const windowMs = 60_000;
    while (true) {
        const now = Date.now();
        while (_qwenVisionCallTimes.length && now - _qwenVisionCallTimes[0] >= windowMs) {
            _qwenVisionCallTimes.shift();
        }
        if (_qwenVisionCallTimes.length < maxRpm) {
            _qwenVisionCallTimes.push(now);
            return;
        }
        const waitMs = Math.max(250, _qwenVisionCallTimes[0] + windowMs - now + 50);
        console.log(`  [qwen] RPM guard: waiting ${(waitMs / 1000).toFixed(1)}s (${_qwenVisionCallTimes.length}/${maxRpm} vision calls in rolling minute)`);
        await _sleep(waitMs);
    }
}

async function _bedrockVision(prompt, base64Image, mimeType, maxTokens, opts = {}) {
    const tag = opts.tag || 'bedrock-vision';
    const modelId = process.env[opts.modelEnv] || opts.defaultModel || 'us.amazon.nova-lite-v1:0';
    const client = _getBedrockClient();
    const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

    const imageBytes = Buffer.isBuffer(base64Image)
        ? base64Image
        : Buffer.from(String(base64Image || ''), 'base64');

    // Detect the REAL format from the byte signature (Bedrock Nova/Claude reject a
    // declared format that doesn't match the bytes — "octet-stream does not match
    // image/jpeg").
    //
    // This used to be `_detectImageFormatFromBytes(bytes) || <mimeType-label fallback>`.
    // That `||` re-asserted the lying label in the exact case the sniff exists to
    // catch: bytes that are not a decodable image at ALL (truncated download, an
    // HTML error page, a normalization that failed and passed the original through).
    // The sniff only ever protected against a valid image of the *wrong* format.
    // Bedrock's Converse API accepts exactly these four, so an unknown signature is
    // never sendable — fail fast and locally instead of burning a paid call, the
    // throttle wait, and every fallback behind it on a guaranteed 400.
    const format = _detectImageFormatFromBytes(imageBytes);
    if (!format) {
        throw new Error(`[${tag}] image bytes are not a recognizable jpeg/png/gif/webp (${imageBytes.length}B, declared ${mimeType || 'unknown'})`);
    }

    const invoke = async (tokenLimit, retryLabel = '') => {
        await _throttleBedrockVision(tag, modelId);
        const started = Date.now();
        const command = new ConverseCommand({
        modelId,
        messages: [{
            role: 'user',
            content: [
                { image: { format, source: { bytes: imageBytes } } },
                { text: String(prompt || '') },
            ],
        }],
        inferenceConfig: {
            maxTokens: tokenLimit || 800,
            temperature: 0.2,
        },
        });

        // Same deadline rule as the text path. These are the vision FALLBACKS,
        // so a stall here stalls footage scoring; the caller's provider chain
        // already knows what to do with a thrown error, it just never got one.
        const response = await client.send(command, { requestTimeout: _bedrockRequestTimeoutMs(tokenLimit) });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const u = response.usage || {};
        const stopReason = response.stopReason || 'unknown';
        const blocks = response.output?.message?.content || [];
        const text = blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).join('').trim();
        console.log(`  [${tag}] ${_shortBedrockModel(modelId)}${retryLabel} ${elapsed}s in=${u.inputTokens || 0} out=${u.outputTokens || 0} stop=${stopReason}`);
        recordUsage({ provider: tag, model: modelId, taskType: 'vision', kind: 'vision', usage: u });
        if (!text) console.log(`  [${tag}] ⚠️ EMPTY response`);
        return { text, stopReason };
    };

    try {
        const first = await _withVisionThrottleRetry(tag, modelId, () => invoke(maxTokens || 800));
        if (_isBedrockTruncated(first.stopReason)) {
            const retryMax = _nextVisionMaxTokens(maxTokens || 800);
            if (retryMax > (maxTokens || 800)) {
                console.log(`  [${tag}] stop=${first.stopReason}; retrying with maxTokens=${retryMax}`);
                const retry = await _withVisionThrottleRetry(tag, modelId, () => invoke(retryMax, ' retry'));
                if (retry.text) return retry.text;
            }
        }
        return first.text;
    } catch (err) {
        const code = err.$metadata?.httpStatusCode || '?';
        console.log(`  [${tag}] ❌ ${_shortBedrockModel(modelId)} ${err.name || 'Error'} http=${code} → ${err.message}`);
        throw err;
    }
}

// ============================================================
// TEXT PROVIDER IMPLEMENTATION — Bedrock only after 2026-05-25 cleanup.
// ============================================================

// AWS Bedrock Runtime text path.
// Uses the generic Converse API so Bedrock-hosted DeepSeek, Claude, etc. all
// bill through AWS Bedrock instead of direct vendor APIs.
async function _bedrockVideoVision(prompt, frames, maxTokens, opts = {}) {
    const tag = opts.tag || 'bedrock-video';
    const modelId = process.env[opts.modelEnv] || opts.defaultModel || 'us.amazon.nova-lite-v1:0';
    const client = _getBedrockClient();
    const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

    const usableFrames = (frames || []).filter(f => f && f.base64);
    if (usableFrames.length === 0) return '';

    const maxFrames = Math.max(1, Math.min(12, parseInt(process.env.BEDROCK_VIDEO_MAX_FRAMES || '4', 10) || 4));
    const picked = usableFrames.length <= maxFrames
        ? usableFrames
        : Array.from({ length: maxFrames }, (_, i) => usableFrames[Math.round(i * (usableFrames.length - 1) / (maxFrames - 1))]);

    // Sniff each frame's REAL format before declaring it. This path had no byte
    // check at all — it trusted `frame.mimeType`, so one corrupt/truncated frame
    // made Bedrock reject the ENTIRE multi-frame call ("The detected file MIME
    // type application/octet-stream does not match the expected type image/jpeg")
    // and took every fallback provider down with it. Drop the bad frame instead:
    // a clip judged on 3 good frames still beats a clip not judged at all.
    const prepared = [];
    for (const frame of picked) {
        const bytes = Buffer.from(String(frame.base64 || ''), 'base64');
        const format = _detectImageFormatFromBytes(bytes);
        if (!format) {
            console.log(`  [${tag}] dropping unreadable frame (${bytes.length}B, declared ${frame.mimeType || 'unknown'}) — not a jpeg/png/gif/webp`);
            continue;
        }
        prepared.push({ frame, bytes, format });
    }
    if (prepared.length === 0) {
        console.log(`  [${tag}] no usable frames after byte check (${picked.length} dropped) — skipping call`);
        return '';
    }

    const frameNotes = prepared
        .map(({ frame: f }, i) => `Frame ${i + 1}${Number.isFinite(Number(f.timestamp)) ? ` at ${Number(f.timestamp).toFixed(1)}s` : ''}`)
        .join('; ');
    const content = [
        { text: `${String(prompt || '')}\n\nEvaluate the provided video frames as one clip, not as unrelated still images. Frame order: ${frameNotes || 'unknown'}.` },
    ];
    for (const { bytes, format } of prepared) {
        content.push({ image: { format, source: { bytes } } });
    }

    const invoke = async (tokenLimit, retryLabel = '') => {
        await _throttleBedrockVision(tag, modelId);
        const started = Date.now();
        const command = new ConverseCommand({
            modelId,
            messages: [{ role: 'user', content }],
            inferenceConfig: {
                maxTokens: tokenLimit || 800,
                temperature: 0.1,
            },
        });
        console.log(`  [${tag}] multi-frame: ${prepared.length}/${usableFrames.length} frame(s) via ${_shortBedrockModel(modelId)}${retryLabel}`);
        const response = await client.send(command, { requestTimeout: _bedrockRequestTimeoutMs(tokenLimit) });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const u = response.usage || {};
        const stopReason = response.stopReason || 'unknown';
        const blocks = response.output?.message?.content || [];
        const text = blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).join('').trim();
        console.log(`  [${tag}] ${_shortBedrockModel(modelId)}${retryLabel} ${elapsed}s frames=${prepared.length} in=${u.inputTokens || 0} out=${u.outputTokens || 0} stop=${stopReason}`);
        recordUsage({ provider: tag, model: modelId, taskType: 'vision', kind: 'vision', usage: u });
        if (!text) console.log(`  [${tag}] EMPTY response`);
        return { text, stopReason };
    };

    try {
        const first = await _withVisionThrottleRetry(tag, modelId, () => invoke(maxTokens || 800));
        if (_isBedrockTruncated(first.stopReason)) {
            const retryMax = _nextVisionMaxTokens(maxTokens || 800);
            if (retryMax > (maxTokens || 800)) {
                console.log(`  [${tag}] stop=${first.stopReason}; retrying with maxTokens=${retryMax}`);
                const retry = await _withVisionThrottleRetry(tag, modelId, () => invoke(retryMax, ' retry'));
                if (retry.text) return retry.text;
            }
        }
        return first.text;
    } catch (err) {
        const code = err.$metadata?.httpStatusCode || '?';
        console.log(`  [${tag}] ${_shortBedrockModel(modelId)} ${err.name || 'Error'} http=${code} -> ${err.message}`);
        throw err;
    }
}

// ── Bedrock request deadlines ────────────────────────────────────────────────
// The AWS SDK ships with NO request timeout: @smithy/node-http-handler's
// `setRequestTimeout` defaults to 0 and returns without arming anything, so a
// socket that stops producing bytes is waited on forever. Every text call in
// this app routes through one client, and the router runs `attempt 1/1
// fallback=none`, so a single stalled socket is a permanent build freeze — one
// 58-scene run sat on Visual Planner batch 1 for over an hour with the process
// alive and idle. Every stage already degrades gracefully on a THROWN error
// (the planner drops to per-scene planning); the only thing missing was
// something to throw.
//
// `requestTimeout` on its own is a trap: without `throwOnRequestTimeout` the
// handler only prints "a request has exceeded the configured N ms" and lets the
// call run to completion. Both are required.
const BEDROCK_TIMEOUT_CEILING_MS = 240_000;

// How fast Bedrock is actually generating during THIS run, in ms per output
// token. A flat deadline is wrong in both directions — too tight for a large
// plan on a slow day, useless for a small utility call — so the budget is
// derived from the call's own token ceiling and from the pace we are measuring
// as we go. Slow day, deadlines stretch; fast day, they tighten. Nothing here
// is niche- or topic-specific.
let _bedrockMsPerOutToken = 20;
function _noteBedrockPace(elapsedMs, outTokens) {
    // Only a call that actually generated something says anything about pace.
    // A 2-token reply is almost entirely connect + prompt upload + time-to-
    // first-token, and dividing that by 2 reports a wildly inflated ms/token
    // that would drag every later deadline up to the ceiling. The fixed
    // allowance in _bedrockRequestTimeoutMs is what covers that overhead.
    if (!(elapsedMs > 0) || !(outTokens >= 200)) return;
    const observed = elapsedMs / outTokens;
    if (!Number.isFinite(observed) || observed <= 0) return;
    // Cap a single sample's influence so one pathological call can't pin the
    // deadline at the ceiling for the rest of the build.
    _bedrockMsPerOutToken = (_bedrockMsPerOutToken * 0.7) + (Math.min(observed, 120) * 0.3);
}
function _bedrockRequestTimeoutMs(maxTokens) {
    const override = parseInt(process.env.BEDROCK_REQUEST_TIMEOUT_MS || '', 10);
    if (Number.isFinite(override) && override > 0) {
        return Math.max(15_000, Math.min(BEDROCK_TIMEOUT_CEILING_MS, override));
    }
    const want = Math.max(1, Number(maxTokens) || 800);
    // Fixed allowance covers connect + prompt upload + time-to-first-token
    // (an 81k-char prompt is ~20k input tokens); the rest is generation at
    // twice the pace we are currently observing.
    const ms = 25_000 + (want * _bedrockMsPerOutToken * 2);
    return Math.max(45_000, Math.min(BEDROCK_TIMEOUT_CEILING_MS, Math.round(ms)));
}

let _bedrockClient = null;
function _getBedrockClient() {
    if (_bedrockClient) return _bedrockClient;
    const { accessKeyId, secretAccessKey, region } = config.bedrock;
    if (!accessKeyId || !secretAccessKey) {
        throw new Error('Bedrock credentials not set (BEDROCK_ACCESS_KEY_ID / BEDROCK_SECRET_ACCESS_KEY)');
    }
    const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
    _bedrockClient = new BedrockRuntimeClient({
        region,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
        // Plain-object handler options; the SDK builds the NodeHttpHandler from
        // them, which keeps @smithy/node-http-handler a transitive dependency
        // instead of an undeclared direct require. The ceiling here is the
        // backstop — each call passes its own tighter deadline to send().
        requestHandler: {
            connectionTimeout: 10_000,
            requestTimeout: BEDROCK_TIMEOUT_CEILING_MS,
            throwOnRequestTimeout: true,
        },
    });
    return _bedrockClient;
}

async function _bedrockText(prompt, maxTokens, temperature, systemPrompt, opts = {}) {
    const { taskType, returnMeta = false } = opts;
    // Gate: if BEDROCK_TASK_TYPES is set and the current task isn't listed, refuse.
    // This protects $200 of credits from being burned by accidental routing.
    const allowed = config.bedrock.allowedTasks;
    if (allowed.length > 0 && taskType && !allowed.includes(taskType)) {
        throw new Error(`Bedrock blocked: taskType=${taskType} not in BEDROCK_TASK_TYPES`);
    }

    const client = _getBedrockClient();
    const primary = opts.model || config.bedrock.model || 'deepseek.v3.2';
    const fallback = config.bedrock.fallbackModel || '';
    const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

    const shortModel = (m) => String(m).split('.').slice(-2).join('.').replace(/-v1:0$/, '');

    const invoke = async (modelId, isFallback = false) => {
        const tag = isFallback ? '[Bedrock fallback]' : '[Bedrock]';
        const started = Date.now();
        const command = new ConverseCommand({
            modelId,
            messages: [{ role: 'user', content: [{ text: String(prompt || '') }] }],
            inferenceConfig: {
                maxTokens: maxTokens || 800,
                ...(temperature !== undefined ? { temperature } : {}),
            },
            ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
        });
        const deadlineMs = _bedrockRequestTimeoutMs(maxTokens);
        try {
            // A stalled socket must end as an error, not as a build that never
            // finishes. One retry on the same model first: the deadline is a
            // guess about the network, and dropping straight to the fallback
            // path costs real quality (the planner re-plans scene-by-scene,
            // which is the thing the batch call exists to avoid).
            let response;
            for (let attempt = 0; ; attempt++) {
                try {
                    response = await client.send(command, { requestTimeout: deadlineMs });
                    break;
                } catch (sendErr) {
                    const timedOut = sendErr?.name === 'TimeoutError'
                        || sendErr?.code === 'ETIMEDOUT'
                        || /exceeded the configured .* requestTimeout/i.test(String(sendErr?.message || ''));
                    if (!timedOut || attempt >= 1) throw sendErr;
                    const waited = ((Date.now() - started) / 1000).toFixed(0);
                    console.log(`  ${tag} ⏱️ ${shortModel(modelId)} task=${taskType || '?'} no response in ${waited}s (limit ${Math.round(deadlineMs / 1000)}s) — retrying once`);
                }
            }
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            const u = response.usage || {};
            const stopReason = response.stopReason || 'unknown';
            _noteBedrockPace(Date.now() - started, u.outputTokens);
            console.log(`  ${tag} ${shortModel(modelId)} task=${taskType || '?'} ${elapsed}s in=${u.inputTokens || 0} out=${u.outputTokens || 0} total=${u.totalTokens || 0} stop=${stopReason}`);
            recordUsage({ provider: 'bedrock', model: modelId, taskType, kind: 'text', usage: u });
            const blocks = response.output?.message?.content || [];
            const text = blocks.map(block => (typeof block?.text === 'string' ? block.text : '')).join('').trim();
            if (!text) {
                console.log(`  ${tag} ⚠️ EMPTY response (stopReason=${stopReason}, blocks=${blocks.length})`);
            }
            if (returnMeta) {
                return {
                    text,
                    meta: {
                        provider: 'bedrock',
                        modelId,
                        stopReason,
                        usage: u,
                    },
                };
            }
            return text;
        } catch (err) {
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            const code = err.$metadata?.httpStatusCode || '?';
            const name = err.name || 'Error';
            console.log(`  ${tag} ❌ ${shortModel(modelId)} task=${taskType || '?'} ${elapsed}s ${name} http=${code} → ${err.message}`);
            throw err;
        }
    };

    try {
        return await invoke(primary, false);
    } catch (err) {
        if (fallback && fallback !== primary) {
            console.log(`  [Bedrock] 🛟 falling back to ${shortModel(fallback)} after ${shortModel(primary)} failure`);
            return await invoke(fallback, true);
        }
        throw err;
    }
}

// _claudeText, _openaiText, _deepseekText REMOVED in 2026-05-25 cleanup.
// All standalone-API text providers are gone. Bedrock-hosted Claude/DeepSeek
// remain accessible via _bedrockText (Converse API).

// _qwenText REMOVED — Qwen is no longer used for text. Vision still uses
// _qwenVisionWithRotation / _qwenOmniWithRotation below.

// Gemini key-rotation infrastructure REMOVED in 2026-05-25 cleanup.

// _geminiText REMOVED in 2026-05-25 cleanup.

// _nvidiaText REMOVED in 2026-05-25 cleanup.

// ============================================================
// VISION PROVIDER IMPLEMENTATIONS
// ============================================================

// _ollamaVision, _claudeVision, _openaiVision REMOVED in 2026-05-25 cleanup.
// _deepseekVision was already removed 2026-05-19 (text-only API).

async function _qwenVision(prompt, base64Image, mimeType, maxTokens) {
    const keys = _getQwenKeys('image');
    if (keys.length === 0) throw new Error('No Qwen image/VL API keys configured (set QWEN_IMAGE_API_KEY, QWEN_VL_API_KEY, or QWEN_VISION_API_KEY)');
    return _qwenVisionWithRotation(prompt, base64Image, mimeType, maxTokens);
}

// _geminiVision, _nvidiaVision, _groqText, _groqVision REMOVED in 2026-05-25 cleanup.

// ============================================================
// VIDEO VISION (Multi-frame / Omni models)
// ============================================================

/**
 * Send multiple video frames to a vision-capable AI model for holistic video analysis.
 * Uses the same provider chain as still-image vision, with direct Qwen free
 * quota first and Bedrock Qwen VL as paid fallback.
 *
 * @param {string} prompt - Analysis prompt
 * @param {Array<{base64: string, mimeType: string, timestamp?: number}>} frames - Array of frame objects
 * @param {Object} [options] - { maxTokens, model }
 * @returns {Promise<string>} AI response text
 */
async function callVideoAI(prompt, frames, options = {}) {
    const { maxTokens = 400, model } = options;

    if (!frames || frames.length === 0) return '';
    const normalizedFrames = [];
    for (const frame of frames) {
        if (!frame?.base64) continue;
        try {
            const normalized = await _normalizeVisionImage(frame.base64, frame.mimeType || 'image/jpeg', {
                ...options,
                logVisionCompression: false,
            });
            if (normalized.base64) {
                normalizedFrames.push({
                    ...frame,
                    base64: normalized.base64,
                    mimeType: normalized.mimeType,
                    _visionBytes: normalized.bytes,
                });
            }
        } catch (_) {
            normalizedFrames.push(frame);
        }
    }
    frames = normalizedFrames;
    if (!frames.length) return '';

    // Build content array: text prompt + all frames as images
    const content = [{ type: 'text', text: prompt }];

    for (const frame of frames) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:${frame.mimeType || 'image/jpeg'};base64,${frame.base64}` }
        });
    }

    // Eyes on an AI Connection: every frame goes in ONE request, the way the
    // OpenAI-compatible API carries several images.
    const eyes = aiConnections.routeForJob('eyes');
    if (eyes) {
        for (const conn of eyes.connections) {
            try {
                const text = await _connectionVision(conn.id, prompt, frames.map((frame) => ({ base64: frame.base64, mimeType: frame.mimeType || 'image/jpeg' })), maxTokens);
                if (text && text.trim()) return text;
            } catch (err) {
                console.log(`  [AI:${conn.label}] multi-frame look failed: ${err.message}`);
            }
        }
        if (!eyes.builtInBackup) return '';
    }

    const visionChain = _getVisionChain();

    const tryBedrockVideoChain = async () => {
        const bedrockVideoChain = visionChain
            .filter(_isBedrockVisionProvider)
            .map(provider => _bedrockVisionOptions(provider, 'video'))
            .filter(Boolean);
        for (const entry of bedrockVideoChain) {
            try {
                const text = await _bedrockVideoVision(prompt, frames, maxTokens, entry);
                if (text && text.trim()) return text;
            } catch (err) {
                console.log(`  [${entry.tag}] Video fallback failed: ${err.message}`);
                // Same permanent-vs-transient split as callVisionAI. The deep-clip
                // check is the other place a dead model can hide behind a fallback.
                const permanent = _permanentVisionFailure(err);
                if (permanent) _markVisionProviderDead(entry.tag.replace(/-video$/, ''), permanent, false);
            }
        }
        return '';
    };

    const primaryIsDirectQwen = visionChain[0] === 'qwen';

    // Default deepvision route follows the configured vision chain. If Qwen is
    // primary, use Omni/realtime first; otherwise run the Bedrock video chain.
    if (!primaryIsDirectQwen) {
        const bedrockText = await tryBedrockVideoChain();
        if (bedrockText) return bedrockText;
    }

    // Direct Qwen Omni remains available when explicitly made primary or when
    // Bedrock has failed. Exhausted DashScope pools short-circuit before paid
    // fallback work is attempted.
    if (_getQwenKeys('omni').length > 0 && _isQwenOmniUsable()) {
        try {
            const omniModel = model || process.env.QWEN_OMNI_MODEL || 'qwen-omni-turbo';
            const text = await _qwenOmniWithRotation(content, maxTokens, omniModel);
            if (text && text.trim()) return text;
        } catch (err) {
            console.log(`  ⚠️ [qwen-omni] Video AI failed: ${err.message}`);
        }
    }

    // Realtime Omni models use WebSocket, not HTTP. Try them before falling
    // back to single-frame/Bedrock so the dashboard-only realtime quota can
    // actually help video scoring.
    if (_getQwenKeys('omni').length > 0 && QWEN_OMNI_REALTIME_ENABLED) {
        try {
            const realtimeModel = process.env.QWEN_OMNI_REALTIME_MODEL || 'qwen3.5-omni-plus-realtime';
            const text = await _qwenOmniRealtimeWithRotation(prompt, frames, maxTokens, realtimeModel);
            if (text && text.trim()) return text;
        } catch (err) {
            console.log(`  ⚠️ [qwen-omni-realtime] Video AI failed: ${err.message}`);
        }
    }

    // Gemini multi-frame fallback REMOVED in 2026-05-25 cleanup.
    if (_getQwenKeys('omni').length > 0 && Date.now() < _qwenOmniLaneCooldownUntil) {
        console.log('  ⏭️ [qwen-omni] skipped: lane cooling down, using Bedrock/video fallback chain');
    }

    if (primaryIsDirectQwen) {
        const bedrockText = await tryBedrockVideoChain();
        if (bedrockText) return bedrockText;
    }

    // Last resort: single-frame callVisionAI with the middle frame.
    const midFrame = frames[Math.floor(frames.length / 2)];
    return callVisionAI(prompt, midFrame.base64, midFrame.mimeType, { maxTokens });
}

/**
 * Re-validate vision models that are marked PERMANENTLY exhausted (`true`) by actually
 * probing them. A model is un-marked ONLY if it returns a live 200 (it genuinely works now —
 * its free allocation reset / a key gained credit). Rate-limited / still-quota-dead probes
 * leave the `true` mark untouched. This is NOT a timer-based revival — revival is driven by a
 * real working response. Without it, a once-exhausted model is skipped forever and the pool
 * only ever shrinks. Probes run in parallel (concurrency-capped so the probe burst doesn't
 * itself trip the rate limit). Disable with QWEN_REVALIDATE_EXHAUSTED=0.
 */
async function revalidateExhaustedVisionModels() {
    if (process.env.QWEN_REVALIDATE_EXHAUSTED === '0') return { probed: 0, revived: 0 };
    const targets = [];
    for (const [role, pool] of [['image', QWEN_IMAGE_POOL], ['omni', QWEN_OMNI_POOL]]) {
        const seen = new Set();
        for (const key of _getQwenKeys(role)) {
            const h = _hashApiKey(key);
            if (seen.has(h)) continue;
            seen.add(h);
            const map = _perKeyExhaustion[role]?.[h] || {};
            for (const [model, state] of Object.entries(map)) {
                if (state === true && pool.includes(model)) {
                    targets.push({ apiKey: key, model, lane: _qwenLaneForModel(model) });
                }
            }
        }
    }
    if (targets.length === 0) return { probed: 0, revived: 0 };

    const probeImg = _createQwenProbeImageBase64();
    const conc = Math.max(1, Math.min(12, parseInt(process.env.QWEN_REVALIDATE_CONCURRENCY || '6', 10) || 6));
    let revived = 0;
    let cursor = 0;
    async function worker() {
        while (cursor < targets.length) {
            const t = targets[cursor++];
            // _probeQwenModel un-marks the model on a live 200 (via _recordQwenModelHealth →
            // _clearModelExhaustion) and re-marks it on a real quota error; rate-limit/other
            // leaves the permanent mark intact. So we just count the 200s.
            const r = await _probeQwenModel(t.apiKey, t.model, t.lane, probeImg, 20_000).catch(() => null);
            if (r && r.status === 'ok') revived++;
        }
    }
    await Promise.all(Array.from({ length: Math.min(conc, targets.length) }, worker));
    return { probed: targets.length, revived };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    callAI,
    callVisionAI,
    callVideoAI,
    revalidateExhaustedVisionModels,
    isVisionAIAvailable,
    getVisionProviderChain,
    isVisionProviderUsable,
    // Vision providers this run has proven permanently unusable (403 / bad model
    // id). Lets a caller surface "your judge is dead" instead of quietly scoring
    // with a backup.
    getDeadVisionProviders,
    // Exported so the gate can be tested without a network call. Returns a reason
    // string for permanent entitlement/config failures, null for transient ones —
    // and the "null for transient" half is the important half: an over-eager
    // classifier would retire a healthy judge over one timeout.
    classifyVisionFailure: _permanentVisionFailure,
    // Effective completion cap for a text call, after the reasoning-model floor.
    // Exported so the floor can be proven without spending a call: (routeEntry, task,
    // askedMaxTokens) → the number that actually reaches max_completion_tokens.
    textCompletionBudget: _textCompletionBudget,
    // Which route a task would take right now, without sending anything — the
    // AI Connections gate proves "built-in stays built-in" with this.
    textRouteFor: (taskType) => _getTextRoute(config.aiProvider || 'bedrock', { taskType }),
    setAIThinking,
    setGeminiThinking,
    getAIThinking,
    getQwenVisionStatus,
    refreshQwenVisionHealth,
    // Read-only view of how long a single vision judgement is allowed to take.
    // The media race needs this to size its own per-candidate budget: a budget
    // smaller than one judgement's deadline can never produce a verdict.
    visionRequestTimeoutMs: _qwenVisionRequestTimeoutMs,
};
