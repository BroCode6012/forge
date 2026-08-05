#!/usr/bin/env node
'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBES = {
    security: 'runtime-security-probe.js',
    export: 'runtime-export-probe.js',
    'qa-crop': 'runtime-qa-crop-probe.js',
    ui: 'runtime-ui-probe.js',
    clipboard: 'runtime-clipboard-probe.js',
};
const probeName = process.argv[2];
if (!PROBES[probeName]) {
    console.error(`usage: node scripts/verify/runtime-harness.js <${Object.keys(PROBES).join('|')}>`);
    process.exit(2);
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSilentWav(filePath, durationSeconds = 3, sampleRate = 8000) {
    const channels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
    const dataSize = sampleCount * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
}

function writeFixturePng(filePath, width = 640, height = 360) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            png.data[offset] = Math.round(40 + (x / width) * 150);
            png.data[offset + 1] = Math.round(55 + (y / height) * 130);
            png.data[offset + 2] = 190;
            png.data[offset + 3] = 255;
        }
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, PNG.sync.write(png));
}

function timedWords(text, startTime, endTime) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const step = (endTime - startTime) / Math.max(1, words.length);
    return words.map((word, index) => ({
        word,
        start: startTime + step * index,
        end: Math.min(endTime, startTime + step * (index + 0.72)),
    }));
}

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEndpoint(port, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
                const payload = await response.json();
                if (payload.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl;
            }
        } catch (_) { }
        await wait(250);
    }
    throw new Error('Timed out waiting for Electron DevTools endpoint');
}

async function terminateTree(child) {
    if (!child || child.exitCode != null) return;
    if (process.platform === 'win32') {
        await new Promise((resolve) => {
            execFile('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
                windowsHide: true,
                timeout: 15_000,
            }, () => resolve());
        });
        return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {
        try { child.kill('SIGTERM'); } catch (_) { }
    }
}

function cleanupFixture(fixtureRoot) {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(fixtureRoot);
    const relative = path.relative(tempRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || !path.basename(resolved).startsWith('yta-runtime-')) {
        throw new Error(`Refusing to clean unexpected fixture path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

function runProbe(scriptPath, endpoint, env, timeoutMs = 240_000) {
    return new Promise((resolve, reject) => {
        let output = '';
        const child = spawn(process.execPath, [scriptPath, endpoint], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const forward = (stream, target) => {
            stream.on('data', (data) => {
                const text = data.toString();
                output += text;
                target.write(data);
            });
        };
        forward(child.stdout, process.stdout);
        forward(child.stderr, process.stderr);
        const timer = setTimeout(() => {
            terminateTree(child).finally(() => {
                const error = new Error(`Runtime ${probeName} probe timed out`);
                error.probeOutput = output;
                reject(error);
            });
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            error.probeOutput = output;
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else {
                const error = new Error(`Runtime ${probeName} probe exited ${code ?? signal}`);
                error.exitCode = code;
                error.signal = signal;
                error.probeOutput = output;
                reject(error);
            }
        });
    });
}

(async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `yta-runtime-${probeName}-`));
    const userDataRoot = path.join(fixtureRoot, 'user-data');
    let agentTestMediaSource = '';
    const plan = {
        totalDuration: 2,
        fps: 30,
        width: 640,
        height: 360,
        scriptContext: { title: 'Runtime Fixture', themeId: 'standard', nicheId: 'general' },
        scenes: [{
            index: 0,
            clipId: 'runtime-scene-0',
            sourceSceneIndex: 0,
            trackId: 'video-track-1',
            startTime: 0,
            endTime: 2,
            duration: 2,
            durationUnit: 'seconds',
            text: 'Runtime fixture scene',
            keyword: 'runtime fixture',
            mediaType: 'image',
        }],
        mgScenes: [],
        motionGraphics: [],
        transitions: [],
        overlayScenes: [],
    };
    if (probeName === 'ui') {
        // Start from the exact failure mode the Editor Agent regression covers:
        // a cinematic inset with a blurred backdrop must become a true
        // edge-to-edge cover when the creator asks for fullscreen.
        Object.assign(plan.scenes[0], {
            mediaFile: 'runtime-scene-0.png',
            framing: 'cinematic',
            framingMode: 'cinematic',
            fitMode: 'contain',
            scale: 0.75,
            posX: 8,
            posY: -4,
            background: 'blur',
            backgroundId: 'blur',
            borderRadius: 4,
            shadow: 0.5,
            effects: ['grain', 'vignette'],
            effectOverrides: {
                grain: { enabled: true, intensity: 0.2 },
            },
            _effectRecipe: [
                { id: 'grain', intensity: 0.2 },
                { id: 'vignette', intensity: 0.2 },
            ],
            _iconMoments: [{
                at: 0.25,
                dur: 1.4,
                kind: 'svg',
                concept: 'Runtime scene icon',
                position: 'top-right',
                svg: '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><circle cx="60" cy="60" r="48" fill="none" stroke="currentColor" stroke-width="10"/><path d="M60 30v60M30 60h60" stroke="currentColor" stroke-width="10" stroke-linecap="round"/></svg>',
            }],
            transition: { type: 'wipe-left', duration: 0.5 },
            transitionType: 'wipe-left',
        });
        writeFixturePng(path.join(fixtureRoot, 'public', plan.scenes[0].mediaFile));
        plan._hfBaseLook = {
            grade: 'warm-film',
            texture: [{ id: 'grain', intensity: 0.12 }],
        };
        plan.motionGraphics = [{
            id: 'runtime-lower-third',
            type: 'lowerThird',
            category: 'overlay',
            text: 'This $300 system cools any home to 55 degrees',
            subtext: 'System Cost',
            startTime: 0.4,
            duration: 1.8,
            position: 'bottom-left',
            sceneIndex: 0,
            sourceSceneIndex: 0,
            style: 'editorial-light',
            subType: 'box',
            animation: 'wipeRight',
            overlayShadowStrength: 0.55,
            colors: {
                primary: '#bc641c',
                accent: '#f5ead6',
                background: 'rgba(245,234,214,0.82)',
            },
        }];
        const externalAudio = String(process.env.YTA_RUNTIME_AUDIO_PATH || '').trim();
        plan.audio = externalAudio
            ? path.basename(externalAudio)
            : 'runtime-preview.wav';
        plan.totalDuration = externalAudio
            ? Math.max(3, Number(process.env.YTA_RUNTIME_AUDIO_DURATION || 260))
            : 3;
        const boundary = externalAudio
            ? Math.min(1.5, plan.totalDuration / 2)
            : 2.5;
        plan.scenes[0].endTime = boundary;
        plan.scenes[0].duration = boundary;
        plan.scenes[0].words = timedWords(plan.scenes[0].text, 0, boundary);
        const secondScene = {
            ...JSON.parse(JSON.stringify(plan.scenes[0])),
            index: 1,
            clipId: 'runtime-scene-1',
            sourceSceneIndex: 1,
            startTime: boundary,
            endTime: plan.totalDuration,
            duration: plan.totalDuration - boundary,
            text: 'Runtime fixture second scene',
            keyword: 'runtime fixture second',
            mediaFile: 'runtime-scene-1.png',
            framing: 'fullscreen',
            framingMode: 'fullscreen',
            fitMode: 'cover',
            scale: 1,
            posX: 0,
            posY: 0,
            background: 'none',
            backgroundId: 'none',
            borderRadius: 0,
            shadow: 0,
            transition: { type: 'wipe-left', duration: 0.5 },
            transitionType: 'wipe-left',
        };
        secondScene.words = timedWords(secondScene.text, boundary, plan.totalDuration);
        plan.scenes.push(secondScene);
        writeFixturePng(path.join(fixtureRoot, 'public', secondScene.mediaFile));
        agentTestMediaSource = path.join(fixtureRoot, 'temp', 'agent-test-replacement.png');
        writeFixturePng(agentTestMediaSource, 800, 450);
        plan.transitions = [{
            fromClipId: 'runtime-scene-0',
            toClipId: 'runtime-scene-1',
            fromSceneIndex: 0,
            toSceneIndex: 1,
            startTime: boundary,
            type: 'wipe-left',
            duration: 0.5,
        }];
        plan.sfxClips = [{
            file: 'sfx-fade.mp3',
            startTime: 0.25,
            duration: 0.5,
            volume: 0.24,
            role: 'texture',
        }];
        if (externalAudio) {
            if (!fs.existsSync(externalAudio)) throw new Error(`Runtime audio fixture does not exist: ${externalAudio}`);
            fs.mkdirSync(path.join(fixtureRoot, 'input'), { recursive: true });
            fs.copyFileSync(externalAudio, path.join(fixtureRoot, 'input', plan.audio));
        } else {
            writeSilentWav(path.join(fixtureRoot, 'input', plan.audio), plan.totalDuration);
        }
    }
    writeJson(path.join(fixtureRoot, 'public', 'video-plan.json'), plan);
    writeJson(path.join(fixtureRoot, 'temp', 'video-plan.json'), plan);
    writeJson(path.join(fixtureRoot, `${path.basename(fixtureRoot)}.fvp`), {
        version: 2,
        savedAt: new Date().toISOString(),
        planSavedAt: new Date().toISOString(),
        revision: 1,
        settings: {},
        videoPlan: plan,
    });

    const electronPath = require('electron');
    const logs = [];
    const baseEnv = {
        ...process.env,
        YTA_REMOTE_DEBUG: '1',
        YTA_RUNTIME_PROJECT_DIR: fixtureRoot,
        EXPORT_V2: '0',
        ...(agentTestMediaSource ? { YTA_AGENT_TEST_MEDIA_SOURCE: agentTestMediaSource } : {}),
    };
    delete baseEnv.ELECTRON_RUN_AS_NODE;

    try {
        const probePath = path.join(__dirname, PROBES[probeName]);
        let probeCompleted = false;
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const port = await getFreePort();
            const env = {
                ...baseEnv,
                YTA_REMOTE_DEBUG_PORT: String(port),
                YTA_TEST_USER_DATA_DIR: `${userDataRoot}-${attempt}`,
            };
            let electron = null;
            const attemptLogs = [];
            try {
                electron = spawn(electronPath, [ROOT, '--dev', `--project=${fixtureRoot}`], {
                    cwd: ROOT,
                    env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    detached: process.platform !== 'win32',
                });
                electron.stdout.on('data', (data) => {
                    const text = data.toString();
                    attemptLogs.push(text);
                    logs.push(text);
                });
                electron.stderr.on('data', (data) => {
                    const text = data.toString();
                    attemptLogs.push(text);
                    logs.push(text);
                });
                const endpoint = await waitForEndpoint(port);
                await runProbe(probePath, endpoint, env);
                probeCompleted = true;
                break;
            } catch (error) {
                lastError = error;
                const diagnosticText = [
                    error.message,
                    error.probeOutput || '',
                    attemptLogs.join(''),
                ].join('\n');
                const transientSetupFailure = /ECONNREFUSED|ECONNRESET|socket hang up|WebSocket.*(?:closed|failed)|Timed out waiting for Electron DevTools endpoint/i.test(diagnosticText)
                    && attempt < 3;
                if (!transientSetupFailure) throw error;
                console.warn(`[runtime-harness] transient ${probeName} startup failure; relaunching Electron (${attempt}/3)`);
            } finally {
                await terminateTree(electron);
                await wait(650);
            }
        }
        if (!probeCompleted) throw lastError || new Error(`Runtime ${probeName} probe did not complete`);
    } catch (error) {
        const tail = logs.join('').split(/\r?\n/).slice(-60).join('\n');
        if (tail) console.error(`\n--- Electron log tail ---\n${tail}`);
        throw error;
    } finally {
        cleanupFixture(fixtureRoot);
    }
})().catch((error) => {
    console.error(`[runtime-harness] ${error.stack || error.message}`);
    process.exit(1);
});
