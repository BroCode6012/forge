#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const {
    normalizeMotionDirectorSpec,
} = require(path.join(ROOT, 'src', 'render', 'hyperframes-motion-director'));
const {
    generateHyperframesProject,
} = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));

function envelope(type, role = 'overlay') {
    return {
        id: `motionGraphics:${type}`,
        role,
        type,
        text: 'Test graphic',
        subtext: '',
        variants: [],
        existingVariant: '',
        existingLayout: '',
        existingSafeZone: 'center',
        existingShell: null,
        existingShellManual: false,
        transparentBackground: false,
        accentRuleVisible: true,
        hasMediaAsset: false,
    };
}

function tagById(html, id) {
    const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.match(new RegExp(`<div id="${escaped}"[^>]*>`))?.[0] || '';
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-overlay-transparency-'));
const projectDir = path.join(root, 'project');

try {
    for (const name of ['temp', 'public', 'input']) {
        fs.mkdirSync(path.join(projectDir, name), { recursive: true });
    }
    const image = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 90;
        image.data[i + 1] = 140;
        image.data[i + 2] = 70;
        image.data[i + 3] = 255;
    }
    fs.writeFileSync(path.join(projectDir, 'input', 'scene.png'), PNG.sync.write(image));

    const normalSpec = normalizeMotionDirectorSpec({
        role: 'overlay',
        mediaTreatment: 'darken-background',
        title: 'Normal overlay',
    }, envelope('callout'));
    assert.strictEqual(normalSpec.media.treatment, 'transparent', 'Motion Director allowed a normal overlay to shade the frame');

    const focusSpec = normalizeMotionDirectorSpec({
        role: 'overlay',
        mediaTreatment: 'darken-background',
        title: 'FOCUS',
    }, envelope('focus-word'));
    assert.strictEqual(focusSpec.media.treatment, 'darken-background', 'focusWord lost its allowed focus treatment');

    const fullscreenSpec = normalizeMotionDirectorSpec({
        role: 'fullscreen',
        mediaTreatment: 'image-focus',
        title: 'Fullscreen',
    }, envelope('headline', 'fullscreen'));
    assert.strictEqual(fullscreenSpec.media.treatment, 'image-focus', 'fullscreen media treatment was incorrectly suppressed');

    const plan = {
        totalDuration: 5,
        fps: 30,
        width: 1920,
        height: 1080,
        scenes: [{
            index: 0,
            clipId: 'scene-overlay-policy',
            startTime: 0,
            endTime: 5,
            duration: 5,
            text: 'Overlay policy scene',
            mediaType: 'image',
            mediaFile: 'scene.png',
            trackId: 'video-track-1',
        }],
        mgScenes: [],
        templateScenes: [],
        motionGraphics: [
            {
                id: 'normal-authored',
                clipId: 'normal-authored',
                type: 'callout',
                category: 'overlay',
                text: 'Normal authored overlay',
                startTime: 0.2,
                endTime: 1.4,
                agenticComposition: {
                    role: 'overlay',
                    type: 'callout',
                    layout: 'focus-panel',
                    media: { treatment: 'image-focus' },
                },
                _authoredNs: 'auth-normal-overlay',
                _authoredComposition: {
                    html: '<div class="auth-normal-overlay">Normal authored overlay</div>',
                    css: '.auth-normal-overlay{position:absolute;left:80px;bottom:80px;color:#fff;}',
                    timeline: 'gsap.set(".auth-normal-overlay",{opacity:0});tl.to(".auth-normal-overlay",{opacity:1,duration:0.2},0.05);tl.to(".auth-normal-overlay",{opacity:0,duration:0.2},0.9);tl.set(".auth-normal-overlay",{opacity:0,visibility:"hidden"},1.1);',
                },
            },
            {
                id: 'normal-agentic',
                clipId: 'normal-agentic',
                type: 'statCounter',
                category: 'overlay',
                text: '200 years',
                startTime: 1.5,
                endTime: 2.7,
                agenticComposition: {
                    role: 'overlay',
                    type: 'stat-counter',
                    layout: 'data-focus',
                    media: { treatment: 'darken-background' },
                },
            },
            {
                id: 'focus-agentic',
                clipId: 'focus-agentic',
                type: 'focusWord',
                category: 'overlay',
                text: 'FOCUS',
                startTime: 2.8,
                endTime: 4,
                agenticComposition: {
                    role: 'overlay',
                    type: 'focus-word',
                    layout: 'center-stack',
                    media: { treatment: 'darken-background' },
                },
            },
        ],
        transitions: [],
        sfxClips: [],
        subtitlesEnabled: false,
        scriptContext: { title: 'Overlay transparency regression', themeId: 'standard' },
        themeId: 'standard',
    };

    const result = generateHyperframesProject({
        plan,
        projectDir,
        appRoot: ROOT,
        tempDir: path.join(projectDir, 'temp'),
        publicDir: path.join(projectDir, 'public'),
        inputDir: path.join(projectDir, 'input'),
        outputRoot: path.join(projectDir, 'hyperframes'),
    });
    const html = fs.readFileSync(result.indexPath, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(result.motionManifestPath, 'utf8'));
    const authoredManifest = manifest.graphics.find(item => item.sourceClipId === 'normal-authored');
    const normalManifest = manifest.graphics.find(item => item.sourceClipId === 'normal-agentic');
    const focusManifest = manifest.graphics.find(item => item.sourceClipId === 'focus-agentic');
    assert(authoredManifest, 'authored overlay is missing from the render manifest');
    assert(normalManifest, 'normal overlay is missing from the render manifest');
    assert(focusManifest, 'focusWord overlay is missing from the render manifest');

    const authoredTag = tagById(html, authoredManifest.id);
    const normalTag = tagById(html, normalManifest.id);
    const focusTag = tagById(html, focusManifest.id);
    assert(authoredTag.includes('hf-agentic-media-transparent'), 'authored overlay retained a frame treatment class');
    assert(normalTag.includes('hf-agentic-media-transparent'), 'normal overlay retained a frame treatment class');
    assert(!authoredTag.includes('hf-agentic-media-image-focus'), 'authored overlay kept image-focus');
    assert(!normalTag.includes('hf-agentic-media-darken-background'), 'normal overlay kept darken-background');
    assert(focusTag.includes('hf-agentic-media-darken-background'), 'focusWord did not retain its focus treatment');
    assert(
        html.includes('<div class="hf-agentic-shade hf-agentic-media-darken-background"></div>'),
        'focusWord did not render its dedicated focus shade'
    );
    assert(
        html.includes('.hf-agentic-shade.hf-agentic-media-darken-background {'),
        'media treatment CSS is not scoped to the dedicated shade layer'
    );
    assert(
        !/(^|\n)\s*\.hf-agentic-media-darken-background\s*\{/.test(html),
        'an unscoped media-treatment selector can still paint the overlay root'
    );
    assert.strictEqual(normalManifest.mediaTreatment, 'transparent');
    assert.strictEqual(authoredManifest.mediaTreatment, 'transparent');
    assert.strictEqual(focusManifest.mediaTreatment, 'darken-background');

    console.log('✅ overlay transparency policy passed: normal overlays preserve footage; focusWord keeps the explicit focus exception');
} finally {
    const resolved = path.resolve(root);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-overlay-transparency-')) {
        throw new Error(`Refusing to clean unsafe test directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}
