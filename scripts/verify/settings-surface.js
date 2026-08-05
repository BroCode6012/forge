#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const html = read('ui/index.html');
const app = read('ui/js/app.js');
const css = read('ui/css/style.css');
const main = read('main.js');
const preload = read('preload.js');
const pipeline = read('src/pipeline/build-video.js');
const schema = read('src/settings/schema.js');
const buildEnv = read('src/settings/build-env.js');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

for (const retiredId of [
    'sfx-enabled',
    'btn-download-sfx',
    'sfx-volume',
    'sfx-volume-label',
    'build-resume-toggle',
    'ollama-model',
    'ollama-vision-model',
    'music-track',
]) {
    check(!html.includes(`id="${retiredId}"`), `retired control remains in markup: ${retiredId}`);
}

check(!preload.includes('downloadRealSfx'), 'manual SFX downloader remains exposed to the renderer');
check(!main.includes("ipcMain.handle('download-real-sfx'"), 'manual SFX downloader IPC remains');
check(!app.includes('generateSfxClips'), 'editor still generates a second mechanical SFX track');
check(!app.includes('const SFX_MAP'), 'duplicate renderer SFX mapping remains');
check(!app.includes('state.sfxEnabled'), 'retired SFX enable state remains');
check(!app.includes('state.sfxVolume'), 'retired SFX volume state remains');
check(!pipeline.includes('sfxDesigned:'), 'retired SFX editor hint remains in the build plan');
check(app.includes('hydratePlanSfx(Array.isArray(plan.sfxClips) ? plan.sfxClips : [])'), 'editor does not hydrate the exact build-authored SFX track');
check(!main.includes('plan.sfxEnabled !== false'), 'export still honors the retired SFX toggle');
check(pipeline.includes("require('../agents/workers/sound-designer')"), 'agentic Sound Designer is not wired into the build');
check(pipeline.includes('downloadSfxForTransitions'), 'automatic build-time SFX acquisition is missing');
check(pipeline.includes('sfxClips: planSfxClips'), 'build plan does not persist Sound Designer clips');

check(!schema.includes('ollamaModel') && !schema.includes('ollamaVisionModel'), 'retired Ollama settings remain in the schema');
check(!app.includes('elements.ollamaModel'), 'retired Ollama UI code remains');
check(!app.includes('buildResumeToggle'), 'retired Resume UI code remains');
check(!buildEnv.includes('options.buildResume'), 'retired Resume option still changes build behavior');
// Name-agnostic: the assignment target was renamed once already (2026-08-04, when
// build-env started tracking which keys the build itself chose). What matters is that
// BUILD_RESUME is explicitly stamped false, not what the local object is called.
check(/\.BUILD_RESUME = 'false';/.test(buildEnv), 'normal builds are not explicitly fresh');
check(!css.includes('music-track'), 'removed fake Music track still has CSS');
check(schema.includes("key: 'fastMedia'") && schema.includes("persist: [], group: 'Diagnostics'"), 'fast media still persists like a production preference');
check(html.includes('id="fast-media-group" class="diagnostic-settings"'), 'fast media is not isolated under pipeline diagnostics');
check(app.includes('elements.fastMediaToggle.checked = false;') && app.includes('Run Pipeline Test (Random Media)'), 'fast media is not visibly one-shot in the UI');
check(html.includes('<option value="motion-graphics">Motion Graphics + QA'), 'graphics-only rebuild option is missing from Repeat From Step');
check(app.includes('Rebuild Motion Graphics + Test'), 'graphics-only rebuild action is not visible in the UI');
check(pipeline.includes("repeatFromStep === 'motion-graphics'"), 'build pipeline does not route graphics-only rebuilds before media/planning');

check(html.includes('id="subtitles-enabled"'), 'active subtitle render control was accidentally removed');
check(read('src/render/hyperframes-bridge.js').includes('if (!plan || !plan.subtitlesEnabled) return [];'), 'subtitle control no longer affects rendering');

for (const activeModeControl of [
    'production-mode-summary',
    'fallback-media-settings',
    'veo-ai-video-mode-badge',
]) {
    check(html.includes(`id="${activeModeControl}"`), `production-mode control is missing: ${activeModeControl}`);
}
// AI Videos category was removed (moved to its own app). The AI-video FOOTAGE lane
// (Veo/Kling, opt-in beside a normal faceless build) is retained — see verify-veo.js.
check(!html.includes('id="ai-videos-script"'), 'removed AI Videos script control remains in markup');
check(!app.includes('aiVideos'), 'removed AI Videos renderer code remains');
check(!buildEnv.includes('aiVideosMode'), 'removed AI Videos build-env logic remains');
check(!main.includes("ipcMain.handle('run-ai-videos'"), 'removed AI Videos IPC handler remains');
check(!main.includes("ipcMain.handle('read-ai-script-file'"), 'removed story file import IPC remains');
check(!main.includes("ipcMain.handle('load-ai-script-url'"), 'removed story URL import IPC remains');
check(buildEnv.includes("if (options.veoAiVideo)"), 'retained Veo/Kling footage lane is no longer env-driven');

if (failures.length) {
    console.error('[settings-surface] failed');
    failures.forEach((failure) => console.error(`  ❌ ${failure}`));
    process.exit(1);
}

console.log('✅ settings surface contains only active controls; SFX authority stays in the build');
