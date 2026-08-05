#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const { generateHyperframesProject } = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));

function findBrowser() {
    const candidates = [
        process.env.HYPERFRAMES_BROWSER_PATH,
        process.env.PRODUCER_HEADLESS_SHELL_PATH,
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function writeSolidPng(filePath, rgb) {
    const image = new PNG({ width: 320, height: 180 });
    for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = rgb[0];
        image.data[offset + 1] = rgb[1];
        image.data[offset + 2] = rgb[2];
        image.data[offset + 3] = 255;
    }
    fs.writeFileSync(filePath, PNG.sync.write(image));
}

async function inspect(page, time, stageId, incomingId) {
    return page.evaluate(({ time: requestedTime, stageId: stage, incomingId: incoming }) => {
        window.__HF_PREVIEW__.seek(requestedTime, false);
        if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();
        const stageNode = document.getElementById(stage);
        const incomingNode = document.getElementById(incoming);
        const holdNode = document.querySelector('[data-hf-continuity-hold="1"]');
        const state = (node) => {
            if (!node) return null;
            const style = getComputedStyle(node);
            return {
                opacity: Number(style.opacity),
                visibility: style.visibility,
                display: style.display,
            };
        };
        return {
            stage: state(stageNode),
            incoming: state(incomingNode),
            hold: state(holdNode),
        };
    }, { time, stageId, incomingId });
}

async function main() {
    const browserPath = findBrowser();
    assert.ok(browserPath, 'Chrome or Edge is required for stage-handoff verification');

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-stage-handoff-'));
    const projectDir = path.join(testRoot, 'project');
    let browser;
    try {
        for (const name of ['temp', 'public', 'input']) {
            fs.mkdirSync(path.join(projectDir, name), { recursive: true });
        }
        writeSolidPng(path.join(projectDir, 'input', 'previous.png'), [180, 28, 28]);
        writeSolidPng(path.join(projectDir, 'input', 'incoming.png'), [25, 80, 205]);

        const plan = {
            audio: null,
            totalDuration: 3,
            fps: 30,
            width: 1920,
            height: 1080,
            scenes: [
                {
                    index: 0,
                    clipId: 'previous-scene',
                    startTime: 0,
                    endTime: 1,
                    mediaType: 'image',
                    mediaFile: 'previous.png',
                    trackId: 'video-track-1',
                },
                {
                    index: 1,
                    clipId: 'incoming-scene',
                    startTime: 2,
                    endTime: 3,
                    mediaType: 'image',
                    mediaFile: 'incoming.png',
                    trackId: 'video-track-1',
                },
            ],
            motionGraphics: [],
            mgScenes: [],
            templateScenes: [{
                id: 'handoff-takeaway',
                clipId: 'handoff-takeaway',
                type: 'keyTakeaway',
                templateType: 'keyTakeaway',
                text: 'The stage owns the frame',
                subtext: 'Previous footage must never flash through',
                startTime: 1,
                endTime: 2,
                duration: 1,
                trackId: 'video-track-3',
                style: 'editorial-light',
                agenticComposition: {
                    role: 'template',
                    type: 'key-takeaway',
                    layout: 'focus-panel',
                    safeZone: 'center',
                    title: 'The stage owns the frame',
                    subtitle: 'Previous footage must never flash through',
                    motion: { entrance: 'fadeSlide', exit: 'fade' },
                },
            }],
            transitions: [],
            sfxClips: [],
            scriptContext: {
                title: 'Stage handoff verification',
                themeId: 'warm-editorial',
            },
            themeId: 'warm-editorial',
            mgStyle: 'editorial-light',
        };

        const generated = generateHyperframesProject({
            plan,
            projectDir,
            appRoot: ROOT,
            tempDir: path.join(projectDir, 'temp'),
            publicDir: path.join(projectDir, 'public'),
            inputDir: path.join(projectDir, 'input'),
            outputRoot: path.join(projectDir, 'hyperframes'),
            options: { preview: true },
        });
        const manifest = JSON.parse(fs.readFileSync(generated.motionManifestPath, 'utf8'));
        const stage = manifest.graphics.find((graphic) => graphic.sourceClipId === 'handoff-takeaway');
        const incoming = manifest.scenes.find((scene) => scene.stageHandoffIn);
        assert.ok(stage, 'stage visual is missing from the motion manifest');
        assert.strictEqual(stage.holdsFrameToEnd, true, 'stage visual did not claim its complete frame window');
        assert.strictEqual(stage.handoffMode, 'scene', 'stage visual did not resolve a direct scene handoff');
        assert.ok(incoming, 'incoming footage was not marked for immediate stage handoff');
        assert.strictEqual(incoming.stageHandoffFrom, stage.id);
        assert.strictEqual(stage.handoffTo, incoming.id);

        const html = fs.readFileSync(generated.indexPath, 'utf8');
        assert.ok(html.includes('item._motionIn || item._stageIn'));
        assert.ok(html.includes('!item.seamOut && !isStageVisual'));
        assert.ok(html.includes('(isStageVisual ? 0.001 : 0.025)'));

        browser = await puppeteer.launch({
            executablePath: browserPath,
            headless: 'new',
            defaultViewport: { width: 1920, height: 1080 },
            args: ['--allow-file-access-from-files', '--disable-gpu-sandbox', '--no-sandbox'],
        });
        const page = await browser.newPage();
        await page.goto(`${pathToFileURL(generated.indexPath).href}?preview=1`, {
            waitUntil: 'load',
            timeout: 30_000,
        });
        await page.waitForFunction(() => Boolean(window.__HF_PREVIEW__ && window.__timelines?.['yta-hyperframes']), {
            timeout: 15_000,
        });

        for (const time of [1.7, 1.8, 1.9, 1.99]) {
            const proof = await inspect(page, time, stage.id, incoming.id);
            assert.ok(
                proof.stage && proof.stage.opacity >= 0.99 && proof.stage.visibility !== 'hidden',
                `stage pre-faded at ${time.toFixed(2)}s and exposed the previous scene: ${JSON.stringify(proof)}`
            );
        }
        const after = await inspect(page, 2.04, stage.id, incoming.id);
        assert.ok(
            after.incoming && after.incoming.opacity >= 0.99 && after.incoming.visibility !== 'hidden',
            `incoming scene was not fully opaque after the stage boundary: ${JSON.stringify(after)}`
        );
        assert.ok(
            !after.stage || after.stage.opacity <= 0.01 || after.stage.visibility === 'hidden',
            `stage container did not release the frame after handoff: ${JSON.stringify(after)}`
        );

        console.log('✅ fullscreen graphic → scene handoff stays flash-free');
    } finally {
        if (browser) await browser.close().catch(() => {});
        const resolved = path.resolve(testRoot);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-stage-handoff-')) {
            throw new Error(`Refusing to clean unsafe stage-handoff directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
