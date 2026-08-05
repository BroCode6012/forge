// src/settings/build-env.js
// ============================================================================
// The ONE place that turns runBuild `options` into the child-process env for the
// pipeline. Extracted from main.js verbatim (behavior-preserving) so it's unit-
// testable against a frozen reference (scripts/verify-settings.js). Uniform
// settings are driven by the schema; fan-outs / conditional logic stay explicit.
// Returns { env, isSmartAI, repeatFromStep } — main.js needs isSmartAI for --dumb.
//
// ENV_LOCK_VAR — why the child is told which keys it chose
// -------------------------------------------------------
// Everything assigned below is a choice the creator made in the UI for THIS build.
// The child then loads src/settings/config.js, which reads the user-level .env with
// `override: true` (it has to, so it beats the repo .env). Without a marker, that
// file also beats the dropdown the creator just used: a stale line in the user .env
// silently replaced the live choice and the build ran on the wrong setting with no
// warning anywhere in the log (found 2026-08-04 — the Vision Backend dropdown).
// So we publish the exact key list under YTA_ENV_LOCK and config.js restores those
// values after its dotenv loads. Precedence becomes, highest first:
//   this build's UI choices > project .env > user .env > repo .env
// The list is derived, not hand-written, so a setting added later is protected
// automatically.
// ============================================================================
'use strict';
const path = require('path');
const { SETTINGS } = require('./schema');

const ENV_LOCK_VAR = 'YTA_ENV_LOCK';

function applyOptionsToEnv(options = {}, { projectDir, baseEnv = process.env } = {}) {
    // `own` = chosen by this build. Merged over baseEnv at the end; its key list is
    // what config.js protects from the .env files.
    const own = { FORCE_COLOR: '0', PROJECT_DIR: projectDir };

    // Runtime + project-scoped strings (always set, exactly as main.js did).
    if (options.audioFileName) own.BUILD_AUDIO_FILE = options.audioFileName;
    if (options.footageSources) own.FOOTAGE_SOURCES = JSON.stringify(options.footageSources);
    own.VIDEO_TITLE = String(options.videoTitle || '').trim();
    own.AI_INSTRUCTIONS = String(options.aiInstructions || '').trim();

    // Uniform conditional settings (build:'if') — set only when truthy.
    for (const s of SETTINGS) {
        if (s.build === 'if' && s.env && options[s.key]) own[s.env] = options[s.key];
    }

    // Kling avatar bridge (fan-out).
    if (options.klingAvatar) {
        own.KLING_AVATAR = '1';
        own.KLING_RESOLUTION = options.klingResolution || '1080p';
        if (options.klingAvatarPrompt) own.KLING_AVATAR_PROMPT = options.klingAvatarPrompt;
    }

    // AI-video generator (fan-out): veoBackend -> {AI_VIDEO_BACKEND, VEO_BACKEND},
    // veoResolution -> {VEO_RESOLUTION, KLING_VIDEO_RESOLUTION}.
    if (options.veoAiVideo) {
        own.VEO_AI_VIDEO = '1';
        own.VEO_SCOPE = options.veoScope || 'directives';
        const gen = String(options.veoBackend || 'kling').toLowerCase();
        if (gen === 'veo-fal') { own.AI_VIDEO_BACKEND = 'veo'; own.VEO_BACKEND = 'fal'; }
        else if (gen === 'veo-gemini') { own.AI_VIDEO_BACKEND = 'veo'; own.VEO_BACKEND = 'gemini'; }
        else { own.AI_VIDEO_BACKEND = 'kling'; }
        if (options.veoResolution) {
            own.VEO_RESOLUTION = options.veoResolution;
            own.KLING_VIDEO_RESOLUTION = options.veoResolution;
        }
    }

    if (options.fastMedia) own.BUILD_FAST_MEDIA = 'true';
    if (options.buildStyleProfile && options.buildStyleProfile !== 'none') own.BUILD_STYLE_PROFILE = options.buildStyleProfile;

    // Smart AI (also drives the --dumb CLI arg in main.js via the returned flag).
    const isSmartAI = options.smartAI !== false && options.smartAI !== 'false';
    own.SMART_AI = isSmartAI ? 'true' : 'false';

    const clipAnalyzerOn = options.clipAnalyzer !== false && options.clipAnalyzer !== 'false';
    own.CLIP_ANALYZER_ENABLED = clipAnalyzerOn ? 'true' : 'false';

    // Fresh builds are the only normal path. Repeat-from-media explicitly enables
    // checkpoint reuse; the retired standalone Resume toggle no longer exists.
    own.BUILD_RESUME = 'false';
    const repeatFromStep = String(options.repeatFromStep || '').trim();
    if (repeatFromStep) {
        own.BUILD_REPEAT_FROM = repeatFromStep;
        if (['media', 'download-media', 'footage', 'step5', 'step-5'].includes(repeatFromStep.toLowerCase())) {
            own.BUILD_RESUME = 'true';
            if (options.forceFreshFootage) own.BUILD_FORCE_FRESH_FOOTAGE = 'true';
        }
    }

    // AI thinking mode (accepts the geminiThinking alias, as main.js did).
    own.AI_THINKING = options.aiThinking || options.geminiThinking || 'off';

    // Project-local .env for the pipeline.
    own.DOTENV_PATH = path.join(projectDir, '.env');

    const env = { ...baseEnv, ...own };
    // Sorted: this is a set of key names, so its order carries no meaning and a stable
    // one keeps the value comparable against the frozen reference contract.
    env[ENV_LOCK_VAR] = Object.keys(own).sort().join(',');

    return { env, isSmartAI, repeatFromStep };
}

module.exports = { applyOptionsToEnv, ENV_LOCK_VAR };
