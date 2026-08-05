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
const {
    chooseAdaptiveContrast,
} = require(path.join(ROOT, 'src', 'render', 'hf-adaptive-contrast'));
const {
    generateHyperframesProject,
} = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));
const {
    auditAdaptiveContrast,
} = require(path.join(ROOT, 'src', 'agents', 'workers', 'motion-qa-agent'));

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

function writeSolidPng(filePath, color) {
    const image = new PNG({ width: 320, height: 180 });
    for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = color[0];
        image.data[offset + 1] = color[1];
        image.data[offset + 2] = color[2];
        image.data[offset + 3] = 255;
    }
    fs.writeFileSync(filePath, PNG.sync.write(image));
}

async function inspectAt(page, time, textNeedle) {
    return page.evaluate(({ time: requestedTime, textNeedle: needle }) => {
        window.__HF_PREVIEW__.seek(requestedTime);
        if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();
        const report = window.__HF_ADAPTIVE_CONTRAST__.update(requestedTime, true);
        const graphic = report.graphics.find((entry) => (
            entry.nodes.some((node) => node.text.includes(needle))
        ));
        if (!graphic) return { report, graphic: null, dom: null };
        const root = document.getElementById(graphic.id);
        const node = Array.from(root.querySelectorAll('*')).find((element) => (
            String(element.textContent || '').replace(/\s+/g, ' ').trim().includes(needle)
            && Array.from(element.childNodes).some((child) => (
                child.nodeType === 3 && String(child.textContent || '').trim()
            ))
        ));
        const protection = Array.from(root.querySelectorAll('.hf-adaptive-protection'))
            .find((element) => getComputedStyle(element).display !== 'none');
        return {
            report,
            graphic,
            dom: node ? {
                color: getComputedStyle(node).color,
                textShadow: getComputedStyle(node).textShadow,
                explicit: root.dataset.hfTextExplicit,
                contrastStatus: root.dataset.hfContrastStatus,
                protectionDisplay: protection ? getComputedStyle(protection).display : 'none',
                protectionZIndex: protection ? getComputedStyle(protection).zIndex : '',
                protectionBackground: protection ? getComputedStyle(protection).background : '',
                protectionOpacity: protection ? getComputedStyle(protection).opacity : '',
                rootIsolation: getComputedStyle(root).isolation,
                rootZIndex: getComputedStyle(root).zIndex,
                contentLayers: Array.from(root.children).map((element) => ({
                    className: element.className,
                    zIndex: getComputedStyle(element).zIndex,
                    position: getComputedStyle(element).position,
                })),
                stage: (() => {
                    const stage = root.querySelector('.hf-agentic-stage, .hf-template-stage');
                    if (!stage) return null;
                    const rect = stage.getBoundingClientRect();
                    const rootRect = root.getBoundingClientRect();
                    return {
                        position: getComputedStyle(stage).position,
                        width: rect.width,
                        height: rect.height,
                        rootWidth: rootRect.width,
                        rootHeight: rootRect.height,
                        centerY: rect.top + rect.height / 2,
                        rootCenterY: rootRect.top + rootRect.height / 2,
                    };
                })(),
                protectionRect: protection ? (() => {
                    const rect = protection.getBoundingClientRect();
                    return {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    };
                })() : null,
            } : null,
        };
    }, { time, textNeedle });
}

async function main() {
    const inherited = chooseAdaptiveContrast({
        preferredText: '#2c2218',
        preferredAccent: '#a8662e',
        samples: Array.from({ length: 20 }, () => ({ r: 58, g: 48, b: 40 })),
    });
    assert.strictEqual(inherited.adjustedText, true, 'inherited low-contrast text should be recolored');
    assert.ok(inherited.ratio >= 4.5, 'inherited text repair should meet WCAG AA contrast');

    const explicit = chooseAdaptiveContrast({
        preferredText: '#ef4444',
        preferredAccent: '#ef4444',
        explicitText: true,
        samples: Array.from({ length: 20 }, () => ({ r: 239, g: 68, b: 68 })),
    });
    assert.strictEqual(explicit.textColor.toLowerCase(), '#ef4444', 'explicit text color must be preserved');
    assert.ok(explicit.scrimAlpha > 0, 'explicit low-contrast text should receive local protection');
    assert.ok(explicit.ratio >= 4.5, 'explicit-color protection should meet WCAG AA contrast');

    const stableLightOnBright = chooseAdaptiveContrast({
        preferredText: '#2c2218',
        preferredAccent: '#a8662e',
        contrastTone: 'light',
        samples: Array.from({ length: 20 }, () => ({ r: 232, g: 220, b: 196 })),
    });
    const stableLightOnDark = chooseAdaptiveContrast({
        preferredText: '#2c2218',
        preferredAccent: '#a8662e',
        contrastTone: 'light',
        samples: Array.from({ length: 20 }, () => ({ r: 28, g: 24, b: 22 })),
    });
    assert.strictEqual(stableLightOnBright.textColor.toLowerCase(), '#fffaf2');
    assert.strictEqual(stableLightOnDark.textColor.toLowerCase(), '#fffaf2');
    assert.ok(stableLightOnBright.scrimAlpha > 0, 'stable light copy needs dark protection over bright footage');
    assert.strictEqual(stableLightOnBright.scrimColor, '#000000');

    const browserPath = findBrowser();
    assert.ok(browserPath, 'Chrome or Edge is required for adaptive-contrast browser verification');

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-adaptive-contrast-'));
    const projectDir = path.join(testRoot, 'project');
    let browser;
    try {
        for (const name of ['temp', 'public', 'input']) {
            fs.mkdirSync(path.join(projectDir, name), { recursive: true });
        }
        writeSolidPng(path.join(projectDir, 'input', 'dark-brown.png'), [58, 48, 40]);
        writeSolidPng(path.join(projectDir, 'input', 'red.png'), [239, 68, 68]);

        const plan = {
            audio: null,
            totalDuration: 6,
            fps: 30,
            width: 1280,
            height: 720,
            scenes: [
                {
                    index: 0,
                    clipId: 'contrast-dark-scene',
                    startTime: 0,
                    endTime: 2,
                    duration: 2,
                    mediaType: 'image',
                    mediaFile: 'dark-brown.png',
                    fitMode: 'cover',
                    trackId: 'video-track-1',
                },
                {
                    index: 1,
                    clipId: 'contrast-red-scene',
                    startTime: 2,
                    endTime: 4,
                    duration: 2,
                    mediaType: 'image',
                    mediaFile: 'red.png',
                    fitMode: 'cover',
                    trackId: 'video-track-1',
                },
                {
                    index: 2,
                    clipId: 'contrast-stage-scene',
                    startTime: 4,
                    endTime: 6,
                    duration: 2,
                    mediaType: 'image',
                    mediaFile: 'dark-brown.png',
                    fitMode: 'cover',
                    trackId: 'video-track-1',
                },
            ],
            motionGraphics: [
                {
                    id: 'inherited-contrast',
                    clipId: 'inherited-contrast',
                    type: 'lowerThird',
                    text: 'Inherited theme text',
                    startTime: 0.2,
                    endTime: 1.8,
                    position: 'bottom-left',
                    variant: 'underline',
                    variantManual: true,
                    transparentBackground: true,
                    cardStyle: 'transparent',
                },
                {
                    id: 'explicit-contrast',
                    clipId: 'explicit-contrast',
                    type: 'lowerThird',
                    text: 'Explicit red text',
                    startTime: 2.2,
                    endTime: 3.8,
                    position: 'bottom-left',
                    variant: 'underline',
                    variantManual: true,
                    transparentBackground: true,
                    cardStyle: 'transparent',
                    colors: {
                        text: '#ef4444',
                        accent: '#ef4444',
                        background: 'rgba(0,0,0,0)',
                    },
                    textColorManual: true,
                },
                {
                    id: 'centered-agentic-stage',
                    clipId: 'centered-agentic-stage',
                    type: 'headline',
                    text: 'Centered stage should stay centered',
                    subtext: 'Adaptive contrast must not collapse the full-frame layout stage',
                    startTime: 4.1,
                    endTime: 5.9,
                    duration: 1.8,
                    graphicShell: {
                        surface: 'none',
                        accent: 'underline',
                        geometry: 'square',
                        hierarchy: 'stacked',
                        width: 'content',
                        emphasis: 'balanced',
                    },
                    agenticComposition: {
                        role: 'overlay',
                        type: 'headline',
                        layout: 'focus-panel',
                        safeZone: 'center',
                        title: 'Centered stage should stay centered',
                        subtitle: 'Adaptive contrast must not collapse the full-frame layout stage',
                        motion: { entrance: 'fadeSlide', speed: 1 },
                    },
                },
            ],
            mgScenes: [],
            templateScenes: [],
            transitions: [],
            sfxClips: [],
            scriptContext: {
                title: 'Adaptive contrast verification',
                themeId: 'warm-editorial',
            },
            themeId: 'warm-editorial',
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
        assert.strictEqual(generated.success, true);
        const generatedHtml = fs.readFileSync(generated.indexPath, 'utf8');
        const inheritedTag = generatedHtml.match(/<[^>]+id="mg-\d+-lower-third"[^>]+>/)?.[0] || '';
        assert.ok(
            inheritedTag.includes('data-hf-style="editorial-light"'),
            'warm-editorial graphics still inherited the stale generic clean style'
        );
        assert.ok(
            inheritedTag.includes('data-hf-contrast-tone="light"'),
            'transparent footage overlays must keep a stable light-copy contrast policy'
        );
        assert.ok(
            !generatedHtml.includes('> .hf-adaptive-content-layer {\n      position: relative;'),
            'adaptive contrast CSS still overrides positioned full-frame stages'
        );

        const manifest = JSON.parse(fs.readFileSync(
            path.join(generated.projectDir, 'hyperframes-motion-manifest.json'),
            'utf8'
        ));
        const centeredManifest = manifest.graphics.find((graphic) => (
            graphic.sourceClipId === 'centered-agentic-stage'
        ));
        assert.ok(centeredManifest, 'surface-less focus-panel fixture is missing from the motion manifest');
        assert.strictEqual(
            centeredManifest.contrastTone,
            'light',
            'surface-less focus-panel overlays must use stable light copy'
        );
        assert.strictEqual(
            centeredManifest.contrastProtection,
            'guarded',
            'surface-less focus-panel overlays must receive deterministic local protection'
        );
        const qaAudit = await auditAdaptiveContrast({
            project: generated,
            manifest,
            browserPath,
        });
        assert.strictEqual(qaAudit.status, 'pass', `Motion QA contrast audit failed: ${qaAudit.reason || ''}`);
        assert.strictEqual(qaAudit.checked, 3, 'Motion QA did not inspect every adaptive-contrast graphic');
        assert.ok(qaAudit.adjusted > 0, 'Motion QA did not observe inherited-color adaptation');
        assert.ok(qaAudit.protected > 0, 'Motion QA did not observe explicit-color protection');

        const productionGenerated = generateHyperframesProject({
            plan,
            projectDir,
            appRoot: ROOT,
            tempDir: path.join(projectDir, 'temp'),
            publicDir: path.join(projectDir, 'public'),
            inputDir: path.join(projectDir, 'input'),
            outputRoot: path.join(projectDir, 'hyperframes-production'),
            options: { preview: false },
        });
        const productionManifest = JSON.parse(fs.readFileSync(
            path.join(productionGenerated.projectDir, 'hyperframes-motion-manifest.json'),
            'utf8'
        ));
        const productionAudit = await auditAdaptiveContrast({
            project: productionGenerated,
            manifest: productionManifest,
            browserPath,
        });
        assert.strictEqual(
            productionAudit.status,
            'pass',
            `Final-render contrast audit failed: ${productionAudit.reason || ''}`
        );
        assert.strictEqual(productionAudit.checked, 3, 'Final-render audit missed adaptive-contrast graphics');

        browser = await puppeteer.launch({
            executablePath: browserPath,
            headless: 'new',
            defaultViewport: { width: 1280, height: 720 },
            args: [
                '--allow-file-access-from-files',
                '--disable-gpu-sandbox',
                '--no-sandbox',
            ],
        });
        const page = await browser.newPage();
        const consoleErrors = [];
        page.on('pageerror', (error) => consoleErrors.push(error.message));
        await page.goto(`${pathToFileURL(generated.indexPath).href}?preview=1`, {
            waitUntil: 'load',
            timeout: 30_000,
        });
        await page.waitForFunction(() => (
            Boolean(window.__HF_PREVIEW__ && window.__HF_ADAPTIVE_CONTRAST__)
            && Array.from(document.images).every((image) => image.complete)
        ), { timeout: 15_000 });

        const inheritedProof = await inspectAt(page, 1, 'Inherited theme text');
        assert.ok(inheritedProof.graphic, 'inherited-color graphic did not produce a contrast report');
        assert.ok(inheritedProof.graphic.minRatio >= 4.5, 'inherited-color graphic remained below target contrast');
        assert.ok(inheritedProof.graphic.adjustedNodes > 0, 'inherited-color graphic was not adaptively recolored');
        assert.notStrictEqual(
            inheritedProof.dom.color,
            'rgb(44, 34, 24)',
            'inherited warm-editorial text stayed dark over dark footage'
        );
        assert.notStrictEqual(inheritedProof.dom.textShadow, 'none', 'readability shadow was not applied');

        const explicitProof = await inspectAt(page, 3, 'Explicit red text');
        assert.ok(explicitProof.graphic, 'explicit-color graphic did not produce a contrast report');
        assert.ok(explicitProof.graphic.minRatio >= 4.5, 'explicit-color graphic remained below target contrast');
        assert.strictEqual(explicitProof.dom.explicit, '1', 'explicit text intent was not rendered');
        assert.strictEqual(explicitProof.dom.color, 'rgb(239, 68, 68)', 'adaptive contrast overwrote the explicit red color');
        assert.ok(
            explicitProof.graphic.protection.darkAlpha > 0.02
            || explicitProof.graphic.protection.lightAlpha > 0.02,
            'explicit red-on-red text did not receive a local contrast plate'
        );
        assert.strictEqual(explicitProof.dom.protectionDisplay, 'block', 'local contrast plate was not rendered');
        assert.strictEqual(explicitProof.dom.protectionZIndex, '1', 'contrast plate must use the protected under-copy layer');
        const explicitScreenshot = PNG.sync.read(await page.screenshot({ type: 'png' }));
        const plateRect = explicitProof.dom.protectionRect;
        assert.ok(plateRect && plateRect.width > 10 && plateRect.height > 10, 'local contrast plate has no visible bounds');
        const sampleX = Math.max(0, Math.min(explicitScreenshot.width - 1, Math.round(plateRect.x + 10)));
        const sampleY = Math.max(
            0,
            Math.min(explicitScreenshot.height - 1, Math.round(plateRect.y + plateRect.height / 2))
        );
        const sampleOffset = (sampleY * explicitScreenshot.width + sampleX) * 4;
        const platePixel = [
            explicitScreenshot.data[sampleOffset],
            explicitScreenshot.data[sampleOffset + 1],
            explicitScreenshot.data[sampleOffset + 2],
        ];
        const plateDifference = Math.abs(platePixel[0] - 239)
            + Math.abs(platePixel[1] - 68)
            + Math.abs(platePixel[2] - 68);
        assert.ok(
            plateDifference > 25,
            `local contrast plate exists in DOM but is not visibly composited (${JSON.stringify({
                plateRect,
                platePixel,
                plateDifference,
                dom: explicitProof.dom,
            })})`
        );

        const centeredProof = await inspectAt(page, 5, 'Centered stage should stay centered');
        assert.ok(centeredProof.graphic, 'centered agentic stage did not produce a contrast report');
        assert.ok(centeredProof.dom.stage, 'centered agentic stage was not rendered');
        assert.strictEqual(
            centeredProof.dom.stage.position,
            'absolute',
            'adaptive contrast changed the full-frame stage positioning mode'
        );
        assert.ok(
            centeredProof.dom.stage.height >= centeredProof.dom.stage.rootHeight * 0.9,
            `adaptive contrast collapsed the stage height: ${JSON.stringify(centeredProof.dom.stage)}`
        );
        assert.ok(
            Math.abs(centeredProof.dom.stage.centerY - centeredProof.dom.stage.rootCenterY) < 30,
            `centered stage moved away from the composition center: ${JSON.stringify(centeredProof.dom.stage)}`
        );
        assert.deepStrictEqual(consoleErrors, [], `adaptive-contrast preview raised browser errors: ${consoleErrors.join('; ')}`);

        console.log('✅ Adaptive contrast renderer and explicit-color protection passed');
    } finally {
        if (browser) await browser.close().catch(() => {});
        const resolved = path.resolve(testRoot);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-adaptive-contrast-')) {
            throw new Error(`Refusing to clean unsafe adaptive-contrast directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
