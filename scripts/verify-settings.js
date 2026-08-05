// scripts/verify-settings.js
// Proves the settings contract:
//  1) build-env.js produces the expected child-process env across option combos.
//  2) the schema covers every build-bound env var the old PROJECT_OVERRIDE_KEYS had.
'use strict';
const path = require('path');
const assert = require('assert');
const { applyOptionsToEnv, ENV_LOCK_VAR } = require('../src/settings/build-env');
const schema = require('../src/settings/schema');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

// ── REFERENCE CONTRACT: options → build environment ──
function referenceBuildEnv(options, PROJECT_DIR) {
    const buildEnv = { FORCE_COLOR: '0', PROJECT_DIR };
    if (options.visionBackend) buildEnv.VISION_BACKEND = options.visionBackend;
    if (options.audioFileName) buildEnv.BUILD_AUDIO_FILE = options.audioFileName;
    if (options.footageSources) buildEnv.FOOTAGE_SOURCES = JSON.stringify(options.footageSources);
    buildEnv.VIDEO_TITLE = String(options.videoTitle || '').trim();
    buildEnv.AI_INSTRUCTIONS = String(options.aiInstructions || '').trim();
    if (options.buildQuality) buildEnv.BUILD_QUALITY_TIER = options.buildQuality;
    if (options.buildFormat) buildEnv.BUILD_FORMAT = options.buildFormat;
    if (options.buildNiche) buildEnv.BUILD_NICHE = options.buildNiche;
    if (options.buildTheme) buildEnv.BUILD_THEME = options.buildTheme;
    if (options.buildMapStylePack) buildEnv.BUILD_MAP_STYLE_PACK = options.buildMapStylePack;
    if (options.buildProductionMode) buildEnv.BUILD_PRODUCTION_MODE = options.buildProductionMode;
    if (options.presenterImage) buildEnv.BUILD_PRESENTER_IMAGE = options.presenterImage;
    if (options.klingAvatar) {
        buildEnv.KLING_AVATAR = '1';
        buildEnv.KLING_RESOLUTION = options.klingResolution || '1080p';
        if (options.klingAvatarPrompt) buildEnv.KLING_AVATAR_PROMPT = options.klingAvatarPrompt;
    }
    if (options.veoAiVideo) {
        buildEnv.VEO_AI_VIDEO = '1';
        buildEnv.VEO_SCOPE = options.veoScope || 'directives';
        const gen = String(options.veoBackend || 'kling').toLowerCase();
        if (gen === 'veo-fal') { buildEnv.AI_VIDEO_BACKEND = 'veo'; buildEnv.VEO_BACKEND = 'fal'; }
        else if (gen === 'veo-gemini') { buildEnv.AI_VIDEO_BACKEND = 'veo'; buildEnv.VEO_BACKEND = 'gemini'; }
        else { buildEnv.AI_VIDEO_BACKEND = 'kling'; }
        if (options.veoResolution) {
            buildEnv.VEO_RESOLUTION = options.veoResolution;
            buildEnv.KLING_VIDEO_RESOLUTION = options.veoResolution;
        }
    }
    if (options.fastMedia) buildEnv.BUILD_FAST_MEDIA = 'true';
    if (options.buildLanguage) buildEnv.BUILD_LANGUAGE = options.buildLanguage;
    if (options.buildStyleProfile && options.buildStyleProfile !== 'none') buildEnv.BUILD_STYLE_PROFILE = options.buildStyleProfile;
    const isSmartAI = options.smartAI !== false && options.smartAI !== 'false';
    buildEnv.SMART_AI = isSmartAI ? 'true' : 'false';
    const clipAnalyzerOn = options.clipAnalyzer !== false && options.clipAnalyzer !== 'false';
    buildEnv.CLIP_ANALYZER_ENABLED = clipAnalyzerOn ? 'true' : 'false';
    buildEnv.BUILD_RESUME = 'false';
    const repeatFromStep = String(options.repeatFromStep || '').trim();
    if (repeatFromStep) {
        buildEnv.BUILD_REPEAT_FROM = repeatFromStep;
        if (['media', 'download-media', 'footage', 'step5', 'step-5'].includes(repeatFromStep.toLowerCase())) {
            buildEnv.BUILD_RESUME = 'true';
            if (options.forceFreshFootage) buildEnv.BUILD_FORCE_FRESH_FOOTAGE = 'true';
        }
    }
    const thinkMode = options.aiThinking || options.geminiThinking || 'off';
    buildEnv.AI_THINKING = thinkMode;
    buildEnv.DOTENV_PATH = path.join(PROJECT_DIR, '.env');
    // Everything above is a choice made in the UI for THIS build, so it must outrank
    // every .env file the child loads. build-env.js publishes the key list; config.js
    // restores those values after its dotenv loads. See ENV_LOCK_VAR in build-env.js.
    buildEnv[ENV_LOCK_VAR] = Object.keys(buildEnv).sort().join(',');
    return { buildEnv, isSmartAI };
}

const PROJECT_DIR = path.join('X:', 'proj');
const COMBOS = [
    {},
    { audioFileName: 'a.mp3', videoTitle: 'T', aiInstructions: 'hard cuts', footageSources: { pexels: true, youtube: false } },
    { buildQuality: 'pro', buildFormat: 'documentary', buildNiche: 'crime', buildTheme: 'crime', buildMapStylePack: 'neon', buildProductionMode: 'faceless', buildLanguage: 'en' },
    { buildProductionMode: 'talkingHead', presenterImage: 'C:/p.png', klingAvatar: true, klingResolution: '720p', klingAvatarPrompt: 'calm' },
    { buildProductionMode: 'faceless', buildFormat: 'listicle', veoAiVideo: false, veoResolution: '1080p', fastMedia: true },
    { klingAvatar: true }, // resolution default
    { veoAiVideo: true, veoBackend: 'veo-fal', veoScope: 'all', veoResolution: '1080p' },
    { veoAiVideo: true, veoBackend: 'veo-gemini', veoResolution: '720p' },
    { veoAiVideo: true, veoBackend: 'kling' },
    { veoAiVideo: true }, // backend default
    { fastMedia: true, buildStyleProfile: 'none' },
    { buildStyleProfile: '/x/style.json' },
    { smartAI: false, clipAnalyzer: false },
    { smartAI: 'false', clipAnalyzer: 'false' },
    { repeatFromStep: 'media', forceFreshFootage: true },
    { repeatFromStep: 'media', forceFreshFootage: false },
    { repeatFromStep: 'visual-planner', forceFreshFootage: true },
    { repeatFromStep: 'motion-graphics', forceFreshFootage: true },
    { aiThinking: 'high' },
    { geminiThinking: 'low' },
    { veoAiVideo: false, klingAvatar: false, smartAI: true, clipAnalyzer: true },
    // The Vision Backend dropdown decides which judge scores every candidate clip.
    // It reached the app but never the build until 2026-08-04; these combos keep it
    // in the child env contract.
    { visionBackend: 'bedrock' },
    { visionBackend: 'lightning', buildTheme: 'crime', smartAI: false },
];

console.log('\n=== build-env.js === main.js reference (across ' + COMBOS.length + ' option combos) ===');
let allEq = true;
for (let i = 0; i < COMBOS.length; i++) {
    const o = COMBOS[i];
    const ref = referenceBuildEnv(o, PROJECT_DIR);
    const got = applyOptionsToEnv(o, { projectDir: PROJECT_DIR, baseEnv: {} });
    let eq = true, why = '';
    try { assert.deepStrictEqual(got.env, ref.buildEnv); } catch (e) { eq = false; why = e.message.split('\n').slice(0, 4).join(' '); }
    if (got.isSmartAI !== ref.isSmartAI) { eq = false; why += ' [isSmartAI mismatch]'; }
    if (!eq) { allEq = false; console.log(`  ❌ combo ${i}: ${why}`); console.log(`     opts=${JSON.stringify(o)}`); }
}
ok(`all ${COMBOS.length} combos produce identical env + isSmartAI`, allEq);

console.log('\n=== PROJECT_OVERRIDE_KEYS === old set EXACTLY (behavior-preserving) ===');
// The complete OLD hardcoded PROJECT_OVERRIDE_KEYS (config.js before P2), frozen.
const OLD_FULL = [
    'AI_PROVIDER', 'BUILD_QUALITY_TIER', 'BUILD_FORMAT', 'BUILD_THEME', 'BUILD_NICHE', 'BUILD_MAP_STYLE_PACK',
    'BUILD_STYLE_PROFILE', 'BUILD_PRODUCTION_MODE', 'BUILD_PRESENTER_IMAGE',
    'KLING_AVATAR', 'KLING_RESOLUTION', 'KLING_AVATAR_PROMPT',
    'VEO_AI_VIDEO', 'VEO_SCOPE', 'VEO_RESOLUTION', 'VEO_BACKEND', 'VEO_MODEL',
    'AI_VIDEO_BACKEND', 'KLING_VIDEO_RESOLUTION', 'KLING_VIDEO_MODE', 'KLING_VIDEO_URL', 'SMART_AI',
    'LOW_BANDWIDTH_MODE', 'DATA_SAVER_MODE', 'NETWORK_PROFILE',
    'DOWNLOAD_CONCURRENCY', 'SCENE_DOWNLOAD_CONCURRENCY', 'MEDIA_SCENE_CONCURRENCY', 'SCENE_DOWNLOAD_TIMEOUT_MS',
    'STRICT_RAW_SCENE_TIMEOUT_MS', 'STRICT_RAW_BACKUP_TIMEOUT_MS',
    'MEDIA_DOWNLOAD_TIMEOUT_MS', 'MEDIA_DOWNLOAD_RETRIES',
    'YTDLP_PATH', 'YTDLP_CHECK_TIMEOUT_MS', 'YTDLP_TIMEOUT_SCALE',
];
// Must mirror config.js's operational list (single source for build vars = schema).
const OPERATIONAL = [
    'AI_PROVIDER', 'LOW_BANDWIDTH_MODE', 'DATA_SAVER_MODE', 'NETWORK_PROFILE',
    'DOWNLOAD_CONCURRENCY', 'SCENE_DOWNLOAD_CONCURRENCY', 'MEDIA_SCENE_CONCURRENCY', 'SCENE_DOWNLOAD_TIMEOUT_MS',
    'STRICT_RAW_SCENE_TIMEOUT_MS', 'STRICT_RAW_BACKUP_TIMEOUT_MS',
    'MEDIA_DOWNLOAD_TIMEOUT_MS', 'MEDIA_DOWNLOAD_RETRIES',
    'YTDLP_PATH', 'YTDLP_CHECK_TIMEOUT_MS', 'YTDLP_TIMEOUT_SCALE',
];
const generated = new Set([...OPERATIONAL, ...schema.projectEnvVars()]);
const oldSet = new Set(OLD_FULL);
const missing = [...oldSet].filter(k => !generated.has(k));
const extra = [...generated].filter(k => !oldSet.has(k));
ok('generated PROJECT_OVERRIDE_KEYS === old set (no missing)', missing.length === 0);
ok('generated PROJECT_OVERRIDE_KEYS === old set (no extra)', extra.length === 0);
if (missing.length) console.log('     missing: ' + missing.join(', '));
if (extra.length) console.log('     extra: ' + extra.join(', '));

console.log('\n=== schema integrity ===');
ok('every setting has a unique key', new Set(schema.SETTINGS.map(s => s.key)).size === schema.SETTINGS.length);
ok('every build:if/bool/str/trueIf/json/style setting has an env var', schema.SETTINGS.every(s => !s.build || s.build === 'custom' || !!s.env));

console.log(`\n${fail === 0 ? '✅ ALL SETTINGS CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
