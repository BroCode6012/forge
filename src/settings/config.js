const path = require('path');

// ── What this build explicitly chose, before any file can touch it ───────────
// build-env.js lists the env keys the creator picked in the UI for THIS build
// under YTA_ENV_LOCK. Snapshot them NOW: the user .env below loads with
// override:true and would otherwise replace a live dropdown choice with a stale
// line in a file (2026-08-04 — a build ran footage scoring on the wrong judge for
// exactly this reason, with nothing in the log to show it). Restored at the end of
// the env stack so the final precedence is:
//     this build's UI choices > project .env > user .env > repo .env
const _lockedEnv = new Map(
    String(process.env.YTA_ENV_LOCK || '')
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k && process.env[k] !== undefined)
        .map((k) => [k, process.env[k]])
);

// Load app root .env first (has all API keys — single source of truth for credentials)
const appRootEnv = path.join(__dirname, '..', '..', '.env');
require('dotenv').config({ path: appRootEnv, quiet: true });
const userEnvPath = process.env.YTA_USER_ENV_PATH ? path.resolve(process.env.YTA_USER_ENV_PATH) : null;
if (userEnvPath && userEnvPath !== appRootEnv) {
    require('dotenv').config({ path: userEnvPath, quiet: true, override: true });
}

// If a project-specific .env exists, only override PROJECT-SPECIFIC settings (not API keys).
// This prevents stale API keys in old project .env files from breaking builds.
// Build/UI setting env vars come from the settings schema (single source of truth);
// only operational tuning vars are listed here. verify-settings.js asserts the
// generated set equals the old hardcoded set exactly (behavior-preserving).
const _settingsSchema = require('./schema');
const OPERATIONAL_OVERRIDE_KEYS = [
    'AI_PROVIDER',
    'LOW_BANDWIDTH_MODE', 'DATA_SAVER_MODE', 'NETWORK_PROFILE',
    'DOWNLOAD_CONCURRENCY', 'SCENE_DOWNLOAD_CONCURRENCY', 'MEDIA_SCENE_CONCURRENCY', 'SCENE_DOWNLOAD_TIMEOUT_MS',
    'STRICT_RAW_SCENE_TIMEOUT_MS', 'STRICT_RAW_BACKUP_TIMEOUT_MS',
    'MEDIA_DOWNLOAD_TIMEOUT_MS', 'MEDIA_DOWNLOAD_RETRIES',
    'YTDLP_PATH', 'YTDLP_CHECK_TIMEOUT_MS', 'YTDLP_TIMEOUT_SCALE',
];
const PROJECT_OVERRIDE_KEYS = new Set([...OPERATIONAL_OVERRIDE_KEYS, ..._settingsSchema.projectEnvVars()]);
if (process.env.DOTENV_PATH
    && process.env.DOTENV_PATH !== appRootEnv
    && process.env.DOTENV_PATH !== userEnvPath) {
    const fs = require('fs');
    try {
        const projEnvContent = fs.readFileSync(process.env.DOTENV_PATH, 'utf8');
        for (const line of projEnvContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx <= 0) continue;
            const key = trimmed.substring(0, eqIdx).trim();
            const value = trimmed.substring(eqIdx + 1).trim();
            if (PROJECT_OVERRIDE_KEYS.has(key) && value) {
                process.env[key] = value;
            }
        }
    } catch (e) {} // project .env missing is fine
}

// Last word goes to the UI: put this build's own choices back on top of every file
// that just loaded. See the YTA_ENV_LOCK note at the top of this file.
for (const [key, value] of _lockedEnv) {
    if (process.env[key] !== value) process.env[key] = value;
}

// Project directory for isolated data (input/output/temp)
const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..', '..');
const LOW_BANDWIDTH_MODE = ['1', 'true', 'yes', 'slow', '3g', 'mobile']
    .includes(String(process.env.LOW_BANDWIDTH_MODE || process.env.DATA_SAVER_MODE || process.env.NETWORK_PROFILE || '').toLowerCase());

function parseEnvList(raw) {
    return String(raw || '')
        .split(/[,\n;]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

// ── Vision backend selector ──────────────────────────────────────────────────
// Pick WHERE image/omni vision scoring runs. Every option resolves to the SAME
// OpenAI-compatible endpoint the Qwen vision path already speaks — this just flips
// which one, so you change ONE setting instead of hand-editing QWEN_BASE_URL/model/key:
//   aws       — self-hosted vLLM on the AWS GPU box (whatever QWEN_BASE_URL is now)
//   lightning — Lightning.ai serverless vLLM endpoint (LIGHTNING_VISION_URL/MODEL/API_KEY)
//   bedrock   — AWS Bedrock vision (no self-hosted endpoint; routes the chain to Bedrock)
//   dashscope — Alibaba DashScope hosted Qwen-VL
// 'aws'/'dashscope' leave QWEN_* as configured; 'lightning'/'bedrock' override at load.
//
// resolveVisionBackend() is re-runnable: it snapshots the raw .env baseline ONCE, then
// every call restores that baseline before applying the chosen backend. That makes it safe
// to call again after a LIVE switch (the UI dropdown writes VISION_BACKEND then re-invokes
// this) — switching aws⇄lightning⇄bedrock mid-session recomputes QWEN_* correctly instead
// of stacking overrides or losing the AWS-box URL.
const _RAW_VISION_ENV = {
    QWEN_BASE_URL: process.env.QWEN_BASE_URL,
    QWEN_VISION_MODEL: process.env.QWEN_VISION_MODEL,
    QWEN_IMAGE_MODELS: process.env.QWEN_IMAGE_MODELS,
    QWEN_OMNI_MODELS: process.env.QWEN_OMNI_MODELS,
    QWEN_VISION_API_KEY: process.env.QWEN_VISION_API_KEY,
    QWEN_IMAGE_API_KEY: process.env.QWEN_IMAGE_API_KEY,
    QWEN_VL_API_KEY: process.env.QWEN_VL_API_KEY,
    QWEN_OMNI_API_KEY: process.env.QWEN_OMNI_API_KEY,
    VISION_PROVIDER: process.env.VISION_PROVIDER,
    VISION_EXCLUDE_QWEN: process.env.VISION_EXCLUDE_QWEN,
    QWEN_VISION_MAX_CONCURRENCY: process.env.QWEN_VISION_MAX_CONCURRENCY,
    // Set by the 'bedrock' branch below. Listed here so switching back to aws/lightning
    // restores the cheap fallback-tier model instead of leaving Sonnet stacked on a path
    // where Claude is only the emergency fallback.
    BEDROCK_VISION_CLAUDE_MODEL: process.env.BEDROCK_VISION_CLAUDE_MODEL,
};
function _restoreRawVisionEnv() {
    for (const [k, v] of Object.entries(_RAW_VISION_ENV)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}
function resolveVisionBackend() {
    _restoreRawVisionEnv(); // always start from the raw baseline (idempotent + switchable)
    const backend = String(process.env.VISION_BACKEND || 'aws').toLowerCase();
    if (backend === 'lightning' && process.env.LIGHTNING_VISION_URL) {
        process.env.QWEN_BASE_URL = process.env.LIGHTNING_VISION_URL;
        const model = process.env.LIGHTNING_VISION_MODEL;
        if (model) {
            process.env.QWEN_VISION_MODEL = model;
            process.env.QWEN_IMAGE_MODELS = model;
            process.env.QWEN_OMNI_MODELS = model;
        }
        // A Lightning Studio is one self-hosted endpoint, not a pool of independent
        // DashScope keys. Force every vision lane onto one logical credential so the
        // runtime cannot multiply retries against the same T4 when the root .env has
        // several hosted-Qwen keys. vLLM normally ignores Authorization, but the client
        // still needs a non-empty bearer value when no tunnel auth key is configured.
        const lightningVisionKey = String(process.env.LIGHTNING_VISION_API_KEY || '').trim() || 'lightning-local';
        process.env.QWEN_VISION_API_KEY = lightningVisionKey;
        process.env.QWEN_IMAGE_API_KEY = lightningVisionKey;
        process.env.QWEN_VL_API_KEY = lightningVisionKey;
        process.env.QWEN_OMNI_API_KEY = lightningVisionKey;
        // Lightning serves through a cloudflared tunnel that rate-limits/times-out under the
        // build's parallel vision flood — cap concurrency so we don't trip 429/524/529 (which
        // would cool the single self-hosted combo and cascade to Bedrock). Tunable; unset/0=off.
        // The bundled server runs with MAX_NUM_SEQS=4. A named tunnel removes the tunnel's
        // request cap, but it does not add GPU capacity, so never default above the server.
        if (!process.env.QWEN_VISION_MAX_CONCURRENCY) process.env.QWEN_VISION_MAX_CONCURRENCY = '4';
        console.log(`👁️  Vision backend: Lightning.ai (${process.env.QWEN_BASE_URL}, ${process.env.CF_TUNNEL_TOKEN ? 'named tunnel' : 'quick tunnel'}, max-concurrency ${process.env.QWEN_VISION_MAX_CONCURRENCY})`);
    } else if (backend === 'bedrock') {
        // Every provider in this mode is a Bedrock one, so a VISION_PROVIDER left over from
        // GPU-box config (typically 'qwen') is not merely inert — VISION_EXCLUDE_QWEN drops
        // it from the chain, which silently hands the primary slot to whatever happens to be
        // next in VISION_PROVIDER_ORDER (bedrock-qwen-vl). Honour an explicit *Bedrock*
        // choice; ignore a stale non-Bedrock one. VISION_PROVIDER is in _RAW_VISION_ENV, so
        // the .env value comes back untouched when the user switches away.
        if (!/^bedrock/.test(String(process.env.VISION_PROVIDER || '').toLowerCase())) {
            process.env.VISION_PROVIDER = 'bedrock-claude';
        }
        // Bedrock mode promotes Claude from emergency fallback to PRIMARY judge for every
        // candidate, so it runs at the reasoning tier. The scoring rulebook in
        // vision/ai-vision.js is ~20 rules with an override hierarchy plus one genuinely
        // subtle call (truthful proxy evidence vs symbolism); that call decides the 5-vs-7
        // band, and the 5-vs-7 band decides whether a scene gets footage or a placeholder
        // card. A wrong verdict costs a rebuild, the upgrade costs about a dollar.
        // BEDROCK_VISION_CLAUDE_MODEL is deliberately NOT consulted as the input here: it
        // carries the cheap fallback-tier value the aws/lightning chains want, where
        // bedrock-claude is only an emergency backstop. Override the primary with
        // VISION_BEDROCK_PRIMARY_MODEL. Writing the resolved value back into
        // BEDROCK_VISION_CLAUDE_MODEL is safe because that key is in _RAW_VISION_ENV.
        //
        // 2026-08-04: the default was `us.anthropic.claude-sonnet-5`, which this account
        // has NO entitlement for — every call 403'd and silently fell back to
        // bedrock-qwen-vl. Measured on 9 labelled real race frames
        // (scripts/vision-judge-bench.js), that stand-in judge scored 0/3 on footage a
        // human would happily use, which is exactly the "no footage — placeholder stands
        // in" symptom. Sonnet 4.6 was the only probed model that both keeps good footage
        // and catches all three rule-traps. Re-measure with the bench before changing it;
        // scripts/bedrock-vision-probe.js proves entitlement, `ListFoundationModels`
        // does not.
        process.env.BEDROCK_VISION_CLAUDE_MODEL =
            process.env.VISION_BEDROCK_PRIMARY_MODEL || 'us.anthropic.claude-sonnet-4-6';
        process.env.VISION_EXCLUDE_QWEN = '1';
        const _primary = process.env.VISION_PROVIDER === 'bedrock-claude'
            ? process.env.BEDROCK_VISION_CLAUDE_MODEL
            : process.env.VISION_PROVIDER;
        console.log(`👁️  Vision backend: AWS Bedrock (primary ${_primary}, fallback Qwen3 VL 235B → Nova)`);
    } else if (backend === 'dashscope') {
        process.env.QWEN_BASE_URL = process.env.QWEN_DASHSCOPE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
        console.log('👁️  Vision backend: DashScope (hosted Qwen-VL)');
    } else if (backend === 'lightning') {
        console.warn('⚠️  VISION_BACKEND=lightning but LIGHTNING_VISION_URL is empty — falling back to the AWS box / QWEN_BASE_URL');
    } else {
        // 'aws' (default) → raw QWEN_BASE_URL (the GPU box) stays as configured.
        console.log(`👁️  Vision backend: AWS GPU box (${process.env.QWEN_BASE_URL || 'QWEN_BASE_URL unset'})`);
    }
    return backend;
}
resolveVisionBackend();

const config = {
    // Text provider is always Bedrock (DeepSeek V3.2 + Claude Sonnet/Haiku).
    // Other providers (ollama, openai, claude, deepseek, gemini, nvidia, groq)
    // were removed 2026-05-25.
    aiProvider: 'bedrock',
    // Vision provider override. When empty, _getVisionChain picks direct
    // DashScope Qwen first to use free quota, then Bedrock quality fallbacks.
    visionProvider: process.env.VISION_PROVIDER || '',

    // Qwen / Alibaba DashScope — VISION ONLY (text was removed 2026-05-25; all
    // text now routes through Bedrock). The pool rotates across the listed
    // vision keys when quota exhausts a model.
    qwen: {
        // No text apiKey — Qwen text path removed. visionApiKeys is the only
        // surface used by the vision chain.
        visionApiKeys: parseEnvList(process.env.QWEN_VISION_API_KEY || ''),
        imageApiKeys: parseEnvList(process.env.QWEN_IMAGE_API_KEY || process.env.QWEN_VL_API_KEY || process.env.QWEN_VISION_API_KEY || ''),
        omniApiKeys: parseEnvList(process.env.QWEN_OMNI_API_KEY || process.env.QWEN_VISION_API_KEY || ''),
        baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        visionModel: process.env.QWEN_VISION_MODEL || 'qwen3-vl-plus',
        // apiKey kept as a compatibility shim for any leftover read sites — we
        // surface the first vision key here so existing `config.qwen.apiKey`
        // checks still work as a "do we have qwen vision?" signal.
        get apiKey() { return this.visionApiKeys[0] || ''; },
    },

    // AWS Bedrock — TEXT (DeepSeek/Sonnet/Haiku) and fallback VISION
    // (Qwen-VL/Claude-Haiku/Nova via the vision chain in ai-provider.js).
    bedrock: {
        region: process.env.BEDROCK_REGION || 'us-east-1',
        accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY || '',
        // Primary Bedrock model for text calls.
        model: process.env.BEDROCK_DIRECTOR_MODEL || 'deepseek.v3.2',
        // Optional override for Director + Visual Planner (Sonnet 4.6).
        plannerModel: process.env.BEDROCK_PLANNER_MODEL || '',
        plannerTaskTypes: ['brain', 'planner-outline', 'planner-large', 'planner-small'],
        // Optional override for tiny utility calls (Haiku 4.5).
        utilityModel: process.env.BEDROCK_UTILITY_MODEL || '',
        utilityTaskTypes: ['utility'],
        // Optional fallback model on failures.
        fallbackModel: process.env.BEDROCK_FALLBACK_MODEL || '',
        // Which taskType values are allowed to hit Bedrock. Empty = no restriction.
        allowedTasks: (process.env.BEDROCK_TASK_TYPES || '')
            .split(',').map(s => s.trim()).filter(Boolean),
    },

    // AiLink (ai.ailink1.com) — OpenAI-compatible proxy serving GPT-5.5 etc.
    // An optional alternate text brain that runs BESIDE Bedrock. The UI option sets
    // AILINK_TASK_TYPES to Bedrock's Sonnet tier (brain + planner-*), so the Visual
    // Planner / Director scene-split / creative directors route to GPT-5.5, while the
    // DeepSeek default tier and Haiku utility tier always stay on Bedrock (which is
    // also the automatic fallback). Inert until AILINK_API_KEY is set.
    ailink: {
        apiKey: process.env.AILINK_API_KEY || '',
        baseUrl: process.env.AILINK_BASE_URL || 'https://ai.ailink1.com/v1',
        model: process.env.AILINK_MODEL || 'gpt-5.5',
        // Optional override for Director + Planner brain tasks (defaults to model).
        plannerModel: process.env.AILINK_PLANNER_MODEL || '',
        plannerTaskTypes: ['brain', 'planner-outline', 'planner-large', 'planner-small'],
        // Which taskType values route to AiLink (live-overridable via AILINK_TASK_TYPES).
        allowedTasks: (process.env.AILINK_TASK_TYPES || '')
            .split(',').map(s => s.trim()).filter(Boolean),
    },

    // APlink (aplink.top) — OpenAI-compatible relay serving Claude models cheaply
    // (claude-opus-4-6 ≈ $0.22/$1.11 per 1M). Same hybrid pattern as AiLink: set
    // APLINK_TASK_TYPES to the Sonnet tier and the Visual Planner / Director / creative
    // directors route to Claude-Opus-4-6, while DeepSeek + Haiku stay on Bedrock (also
    // the automatic fallback — important, since relay channels can drop). Inert until
    // APLINK_API_KEY is set.
    aplink: {
        apiKey: process.env.APLINK_API_KEY || '',
        baseUrl: process.env.APLINK_BASE_URL || 'https://aplink.top/v1',
        model: process.env.APLINK_MODEL || 'claude-opus-4-6',
        plannerModel: process.env.APLINK_PLANNER_MODEL || '',
        plannerTaskTypes: ['brain', 'planner-outline', 'planner-large', 'planner-small'],
        allowedTasks: (process.env.APLINK_TASK_TYPES || '')
            .split(',').map(s => s.trim()).filter(Boolean),
    },

    // Azure AI Foundry Claude — Anthropic Messages endpoint hosted through Azure.
    // Azure OpenAI-compatible deployments (Grok/DeepSeek/etc.) live beside it
    // under azureOpenAI. Both use the same hybrid pattern as AiLink/APlink:
    // when their task gate is set by the dropdown, they take over the Bedrock
    // Sonnet tier while DeepSeek, Haiku utility, and Bedrock fallback remain.
    azure: {
        apiKey: process.env.AZURE_API_KEY || process.env.AZURE_OPENAI_API_KEY || '',
        baseUrl: process.env.AZURE_ANTHROPIC_BASE_URL
            || process.env.AZURE_CLAUDE_BASE_URL
            || process.env.AZURE_OPENAI_ENDPOINT
            || '',
        model: process.env.AZURE_CLAUDE_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || 'claude-sonnet-4-6',
        plannerModel: process.env.AZURE_CLAUDE_PLANNER_MODEL || '',
        apiVersion: process.env.AZURE_ANTHROPIC_VERSION || '2023-06-01',
        plannerTaskTypes: ['brain', 'planner-outline', 'planner-large', 'planner-small'],
        allowedTasks: (process.env.AZURE_TASK_TYPES || '')
            .split(',').map(s => s.trim()).filter(Boolean),
    },

    azureOpenAI: {
        apiKey: process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || '',
        baseUrl: process.env.AZURE_OPENAI_ENDPOINT || '',
        model: process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || 'grok-4.3',
        plannerModel: process.env.AZURE_OPENAI_PLANNER_MODEL || '',
        plannerTaskTypes: ['brain', 'planner-outline', 'planner-large', 'planner-small'],
        allowedTasks: (process.env.AZURE_OPENAI_TASK_TYPES || '')
            .split(',').map(s => s.trim()).filter(Boolean),
    },

    // Tavily Search API (web context + article discovery)
    tavily: {
        apiKey: process.env.TAVILY_API_KEY || ''
    },

    // Brave Search API — real WEB image search (Bing replacement). Inert until
    // BRAVE_API_KEY is set. Free key at https://brave.com/search/api/
    brave: {
        apiKey: process.env.BRAVE_API_KEY || ''
    },

    // Free stock providers. These use free-tier API keys and replace the
    // suspended Storyblocks stock lane.
    pexels: {
        apiKey: process.env.PEXELS_API_KEY || ''
    },
    pixabay: {
        apiKey: process.env.PIXABAY_API_KEY || ''
    },

    // YouTube (via yt-dlp + Data API)
    youtube: {
        // YOUTUBE_API_KEY may be ONE key or comma-separated keys (one per Google Cloud
        // project). Each project has its own 100-searches/day quota, so multiple keys
        // multiply daily capacity; the provider rotates to the next key on quotaExceeded.
        // apiKey stays the FIRST key so existing "has a key?" truthiness checks still work.
        apiKey: (process.env.YOUTUBE_API_KEY || '').split(',')[0].trim(),
        apiKeys: (process.env.YOUTUBE_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean),
        ytdlpPath: process.env.YTDLP_PATH || '',
        maxHeight: Number(process.env.MAX_VIDEO_HEIGHT || 0) > 0
            ? Number(process.env.MAX_VIDEO_HEIGHT)
            : null,
        creativeCommonsOnly: false,
        cookiesFile: process.env.YTDLP_COOKIES_FILE || '',
        cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || '',
    },

    // Network resilience knobs for travel / mobile data builds.
    network: {
        lowBandwidth: LOW_BANDWIDTH_MODE,
        mediaDownloadTimeoutMs: parseInt(
            process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || (LOW_BANDWIDTH_MODE ? '120000' : '45000'),
            10
        ),
        mediaDownloadRetries: parseInt(
            process.env.MEDIA_DOWNLOAD_RETRIES || (LOW_BANDWIDTH_MODE ? '4' : '2'),
            10
        ),
        ytdlpCheckTimeoutMs: parseInt(
            process.env.YTDLP_CHECK_TIMEOUT_MS || (LOW_BANDWIDTH_MODE ? '30000' : '15000'),
            10
        ),
        ytdlpTimeoutScale: Number(process.env.YTDLP_TIMEOUT_SCALE || (LOW_BANDWIDTH_MODE ? '2.5' : '1')),
    },

    // Reddit — public JSON API, no keys needed
    reddit: {},

    // Freesound (SFX downloads, Step 6.95)
    freesound: {
        apiKey: process.env.FREESOUND_API_KEY || ''
    },

    // Map providers
    geoapify: {
        apiKey: process.env.GEOAPIFY_API_KEY || ''
    },
    maptiler: {
        apiKey: process.env.MAPTILER_API_KEY || ''
    },

    // Freepik / Flaticon (icon provider, same API key)
    flaticon: {
        apiKey: process.env.FREEPIK_API_KEY || ''
    },
    freepik: {
        apiKey: process.env.FREEPIK_API_KEY || ''
    },

    // Clip Analyzer — multi-frame vision understanding (via callVideoAI route)
    clipAnalyzer: {
        enabled: process.env.CLIP_ANALYZER_ENABLED !== 'false',
        maxFramesPerBuild: parseInt(process.env.CLIP_ANALYZER_MAX_FRAMES || '200', 10),
        reserveFrames: parseInt(process.env.CLIP_ANALYZER_RESERVE_FRAMES || '36', 10),
        framesPerClip: parseInt(process.env.CLIP_ANALYZER_FRAMES_PER_CLIP || '8', 10),
        segmentFrames: parseInt(process.env.CLIP_ANALYZER_SEGMENT_FRAMES || '3', 10),
        dynamicSegmentFrames: process.env.CLIP_ANALYZER_DYNAMIC_SEGMENT_FRAMES !== '0',
        segmentMaxFrames: parseInt(process.env.CLIP_ANALYZER_SEGMENT_MAX_FRAMES || '16', 10),
        segmentWindowFrames: parseInt(process.env.CLIP_ANALYZER_SEGMENT_WINDOW_FRAMES || '8', 10),
        rejectThreshold: parseInt(process.env.CLIP_ANALYZER_REJECT_THRESHOLD || '3', 10),
    },

    topicFootageScout: {
        enabled: process.env.TOPIC_FOOTAGE_SCOUT_ENABLED !== 'false',
        maxNeeds: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_MAX_NEEDS || '8', 10),
        queriesPerProvider: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_QUERIES_PER_PROVIDER || '2', 10),
        maxResultsPerQuery: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_MAX_RESULTS_PER_QUERY || '50', 10),
        maxCandidatesPerNeed: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_MAX_CANDIDATES_PER_NEED || '30', 10),
        maxCandidatesPerScene: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_MAX_CANDIDATES_PER_SCENE || '20', 10),
        maxSceneAssignmentsPerCandidate: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_MAX_SCENE_ASSIGNMENTS_PER_CANDIDATE || '2', 10),
        maxCandidatesPerProviderPerScene: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_MAX_PROVIDER_CANDIDATES_PER_SCENE || '10', 10),
        minSceneScore: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_MIN_SCENE_SCORE || '16', 10),
        searchTimeoutMs: parseInt(process.env.TOPIC_FOOTAGE_SCOUT_SEARCH_TIMEOUT_MS || '18000', 10),
        providers: (process.env.TOPIC_FOOTAGE_SCOUT_PROVIDERS || 'youtube,reddit,pexels,pixabay')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean),
    },

    mediaAgent: {
        enabled: process.env.MEDIA_AGENT_ENABLED !== 'false',
        useAI: process.env.MEDIA_AGENT_AI !== 'false',
        // Mission output is a ~25-field JSON object (role, asset class, must/avoid
        // lists, provider order/lock/exclusions, query lanes for 4 providers,
        // fallback queries, acceptance test). At 1100 tokens deepseek.v3.2
        // routinely hit stop=max_tokens mid-object → invalid JSON → the whole
        // mission silently fell back to a metadata draft (and burned 12–23s per
        // scene doing it). 2000 gives the full object headroom to close.
        maxTokens: parseInt(process.env.MEDIA_AGENT_MAX_TOKENS || '2000', 10),
        timeoutMs: parseInt(process.env.MEDIA_AGENT_TIMEOUT_MS || '45000', 10),
        entityMaxTokens: parseInt(process.env.MEDIA_AGENT_ENTITY_MAX_TOKENS || '520', 10),
        entityTimeoutMs: parseInt(process.env.MEDIA_AGENT_ENTITY_TIMEOUT_MS || '14000', 10),
    },

    // Paths (resolved from PROJECT_DIR for multi-instance isolation)
    paths: {
        input: path.join(PROJECT_DIR, 'input'),
        output: path.join(PROJECT_DIR, 'output'),
        temp: path.join(PROJECT_DIR, 'temp')
    },

    // Video settings
    video: {
        fps: 30,
        width: 1920,
        height: 1080
    }
};

config.resolveVisionBackend = resolveVisionBackend;
module.exports = config;
