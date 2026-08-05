// src/settings/schema.js
// ============================================================================
// SINGLE SOURCE OF TRUTH for build/UI settings. One declarative entry per setting;
// config.js, main.js (buildEnv), PROJECT_OVERRIDE_KEYS, and the UI persistence all
// derive from THIS. Adding a setting = one entry here (+ its HTML control).
//
// Dual-loadable: `require()` in Node (main/config/build) AND <script> in the
// renderer (window.SETTINGS_SCHEMA) — it's pure data, no Node deps.
//
// Per-setting fields:
//   key       camelCase — the runBuild-options key AND the localStorage/.fvp key
//   el        DOM id of its control (null if state-backed, e.g. presenterImage)
//   env       buildEnv var it maps to (null if not passed to the build process)
//   build     how key -> env is applied by build-env.js:
//               'if'    set env=value only when value is truthy
//               'bool'  env='true'/'false' (default true unless value is false/'false')
//               'trueIf' env='true' only when truthy (else leave unset)
//               'str'   env=String(value||'').trim() (always set)
//               'json'  env=JSON.stringify(value) when present
//               'style' set when value && value!=='none'
//               'custom' handled explicitly in build-env.js (fan-outs / conditionals)
//               null    not passed to the build
//   def       default value
//   persist   where it's saved: 'ls'=localStorage(global), 'fvp'=project file
//   projEnv   true = a project .env may override its env var (legacy PROJECT_OVERRIDE set)
//   group     UI grouping label
// ============================================================================
(function (root, factory) {
    const mod = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (typeof window !== 'undefined') window.SETTINGS_SCHEMA = mod;
})(typeof self !== 'undefined' ? self : this, function () {
    const SETTINGS = [
        // ── AI brain ──
        { key: 'smartAI', el: 'smart-ai-toggle', env: 'SMART_AI', build: 'bool', def: true, persist: ['ls', 'fvp'], projEnv: true, group: 'AI' },
        { key: 'aiProvider', el: 'ai-provider', env: null, build: null, def: 'bedrock', persist: ['ls', 'fvp'], group: 'AI' },
        { key: 'aiThinking', el: 'ai-thinking', env: 'AI_THINKING', build: 'custom', def: 'off', persist: ['ls'], group: 'AI' },

        // ── Build config ──
        { key: 'buildQuality', el: 'build-quality', env: 'BUILD_QUALITY_TIER', build: 'if', def: 'standard', persist: ['ls', 'fvp'], projEnv: true, group: 'Build' },
        { key: 'buildFormat', el: 'build-format', env: 'BUILD_FORMAT', build: 'if', def: 'auto', persist: ['ls', 'fvp'], projEnv: true, group: 'Format' },
        { key: 'buildNiche', el: 'build-niche', env: 'BUILD_NICHE', build: 'if', def: 'auto', persist: ['ls', 'fvp'], projEnv: true, group: 'Build' },
        { key: 'buildTheme', el: 'build-theme', env: 'BUILD_THEME', build: 'if', def: 'auto', persist: ['ls', 'fvp'], projEnv: true, group: 'Build' },
        { key: 'buildMapStylePack', el: 'build-map-style-pack', env: 'BUILD_MAP_STYLE_PACK', build: 'if', def: 'auto', persist: ['ls', 'fvp'], projEnv: true, group: 'Build' },
        // buildProductionMode = the CATEGORY axis (faceless / talking-head).
        { key: 'buildProductionMode', el: 'build-production-mode', env: 'BUILD_PRODUCTION_MODE', build: 'if', def: 'faceless', persist: ['ls', 'fvp'], projEnv: true, group: 'Category' },
        { key: 'buildLanguage', el: 'build-language', env: 'BUILD_LANGUAGE', build: 'if', def: 'auto', persist: ['ls', 'fvp'], group: 'Build' },
        { key: 'buildStyleProfile', el: 'build-style-profile', env: 'BUILD_STYLE_PROFILE', build: 'style', def: 'none', persist: ['ls', 'fvp'], projEnv: true, special: true, group: 'Build' },
        // WHERE footage gets scored. This MUST reach the build child: it decides which
        // judge every candidate clip is shown to, and picking the wrong one is invisible
        // (footage still gets scored, just by another model). It was env:null/build:null
        // until 2026-08-04, so the dropdown only ever changed the app, never the build.
        { key: 'visionBackend', el: 'build-vision-backend', env: 'VISION_BACKEND', build: 'if', def: 'aws', persist: ['ls', 'fvp'], group: 'Vision' },

        // ── Presenter (talking-head category) ──
        { key: 'presenterImage', el: null, env: 'BUILD_PRESENTER_IMAGE', build: 'if', def: '', persist: ['ls', 'fvp'], projEnv: true, group: 'Presenter' },
        { key: 'klingAvatar', el: 'kling-avatar-enabled', env: 'KLING_AVATAR', build: 'custom', def: false, persist: ['ls', 'fvp'], projEnv: true, group: 'Presenter' },
        { key: 'klingResolution', el: 'kling-resolution', env: 'KLING_RESOLUTION', build: 'custom', def: '1080p', persist: ['ls', 'fvp'], projEnv: true, group: 'Presenter' },
        { key: 'klingAvatarPrompt', el: 'kling-avatar-prompt', env: 'KLING_AVATAR_PROMPT', build: 'custom', def: '', persist: ['ls', 'fvp'], projEnv: true, group: 'Presenter' },

        // ── AI video (Kling/Veo generation) ──
        { key: 'veoAiVideo', el: 'veo-ai-video-enabled', env: 'VEO_AI_VIDEO', build: 'custom', def: false, persist: ['ls', 'fvp'], projEnv: true, group: 'AIVideo' },
        { key: 'veoScope', el: 'veo-scope', env: 'VEO_SCOPE', build: 'custom', def: 'directives', persist: ['ls', 'fvp'], projEnv: true, group: 'AIVideo' },
        { key: 'veoResolution', el: 'veo-resolution', env: 'VEO_RESOLUTION', build: 'custom', def: '720p', persist: ['ls', 'fvp'], projEnv: true, group: 'AIVideo' },
        { key: 'veoBackend', el: 'veo-backend', env: 'AI_VIDEO_BACKEND', build: 'custom', def: 'kling', persist: ['ls', 'fvp'], projEnv: true, group: 'AIVideo' },

        // ── Media / pipeline toggles ──
        { key: 'footageSources', el: null, env: 'FOOTAGE_SOURCES', build: 'json', def: null, persist: ['ls', 'fvp'], group: 'Media' },
        { key: 'clipAnalyzer', el: 'clip-analyzer-toggle', env: 'CLIP_ANALYZER_ENABLED', build: 'bool', def: true, persist: ['ls', 'fvp'], group: 'Media' },
        // Deliberately not persisted: this is a destructive one-shot pipeline diagnostic,
        // not a production preference. Every app/project load returns it to OFF.
        { key: 'fastMedia', el: 'fast-media-toggle', env: 'BUILD_FAST_MEDIA', build: 'trueIf', def: false, persist: [], group: 'Diagnostics' },
        { key: 'repeatFromStep', el: 'repeat-from-step', env: 'BUILD_REPEAT_FROM', build: 'custom', def: 'visual-planner', persist: ['ls', 'fvp'], group: 'Build' },
        { key: 'forceFreshFootage', el: 'force-fresh-footage-toggle', env: 'BUILD_FORCE_FRESH_FOOTAGE', build: 'custom', def: false, persist: ['ls', 'fvp'], group: 'Media' },

        // ── Project-scoped (from state, not a control) ──
        { key: 'videoTitle', el: null, env: 'VIDEO_TITLE', build: 'str', def: '', persist: ['fvp'], group: 'Project' },
        { key: 'aiInstructions', el: null, env: 'AI_INSTRUCTIONS', build: 'str', def: '', persist: ['fvp'], group: 'Project' },

        // ── Editor/render settings (state-backed; not passed to build env) ──
        { key: 'mutedTracks', el: null, env: null, build: null, def: null, persist: ['ls', 'fvp'], group: 'Editor' },
    ];

    // Fan-out env vars a build-env.js custom setting can emit beyond its own s.env
    // (veoBackend -> VEO_BACKEND; veoResolution -> KLING_VIDEO_RESOLUTION; +reserved).
    const FANOUT_ENV = ['VEO_BACKEND', 'KLING_VIDEO_RESOLUTION', 'KLING_VIDEO_MODE', 'KLING_VIDEO_URL', 'VEO_MODEL'];

    // Env vars a project .env may override (flagged settings + fan-outs). config.js
    // unions these with its operational keys to build PROJECT_OVERRIDE_KEYS.
    const projectEnvVars = () => SETTINGS.filter(s => s.projEnv && s.env).map(s => s.env).concat(FANOUT_ENV);

    const byKey = (k) => SETTINGS.find(s => s.key === k) || null;
    const persistedFor = (scope) => SETTINGS.filter(s => (s.persist || []).includes(scope) && !s.deprecated);

    return { SETTINGS, FANOUT_ENV, projectEnvVars, byKey, persistedFor };
});
