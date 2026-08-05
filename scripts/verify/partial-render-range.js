#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { gsap } = require('gsap');
const { clipPlanForRange } = require('../../src/project/plan-range');
const { prepareMotionPlan } = require('../../src/agents/workers/motion-qa-agent');
const { generateHyperframesProject } = require('../../src/render/hyperframes-bridge');

const ROOT = path.resolve(__dirname, '..', '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-partial-render-range-'));

function closeTo(actual, expected, tolerance = 0.001) {
    assert.ok(
        Math.abs(Number(actual) - Number(expected)) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

try {
    const tempDir = path.join(testRoot, 'temp');
    const publicDir = path.join(testRoot, 'public');
    const inputDir = path.join(testRoot, 'input');
    const projectDir = path.join(testRoot, 'project');
    for (const directory of [tempDir, publicDir, inputDir, projectDir]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const image = new PNG({ width: 16, height: 9 });
    for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = 36;
        image.data[offset + 1] = 84;
        image.data[offset + 2] = 112;
        image.data[offset + 3] = 255;
    }
    fs.writeFileSync(path.join(inputDir, 'range.png'), PNG.sync.write(image));

    const sourcePlan = {
        fps: 30,
        width: 1920,
        height: 1080,
        totalDuration: 30,
        audio: null,
        scenes: [{
            index: 0,
            clipId: 'range-scene',
            startTime: 0,
            endTime: 30,
            duration: 30,
            mediaType: 'image',
            mediaFile: 'range.png',
            trackId: 'video-track-1',
        }],
        mgScenes: [],
        motionGraphics: [],
        templateScenes: [{
            id: 'range-stat-card',
            clipId: 'range-stat-card',
            type: 'statCard',
            templateType: 'statCard',
            text: '$300 System',
            subtext: 'Complete build',
            items: [{ value: '$300', label: 'System' }],
            sceneIndex: 0,
            startTime: 13.72,
            endTime: 23.18,
            duration: 9.46,
            _authoredNs: 'auth-range-stat',
            _authoredComposition: {
                html: '<div id="auth-range-stat-root"><strong id="auth-range-stat-value">$300</strong></div>',
                css: '#auth-range-stat-root{position:absolute;inset:0;display:grid;place-items:center;color:#fff}#auth-range-stat-value{font-size:180px}',
                timeline: [
                    'tl.fromTo("#auth-range-stat-root",{opacity:0},{opacity:1,duration:0.40,ease:"power2.out"},0);',
                    'tl.to("#auth-range-stat-root",{opacity:0,duration:0.30,ease:"power1.in"},9.16);',
                ].join('\n'),
            },
        }],
        transitions: [],
        overlayScenes: [],
        sfxClips: [],
        scriptContext: { title: 'Partial range regression', themeId: 'standard' },
        themeId: 'standard',
    };

    const rangeStart = 23 + 2 / 30;
    const rangeEnd = rangeStart + 1;
    const clipped = clipPlanForRange(sourcePlan, rangeStart, rangeEnd);
    const fragment = clipped.templateScenes[0];
    closeTo(fragment.duration, 0.113333, 0.00001);
    closeTo(fragment._renderRangeClip.sourceOffset, 9.346667, 0.00001);
    closeTo(fragment._renderRangeClip.sourceDuration, 9.46, 0.00001);
    assert.strictEqual(fragment._renderRangeClip.clippedAtStart, true);
    assert.strictEqual(fragment._renderRangeClip.clippedAtEnd, false);

    const preflight = prepareMotionPlan(clipped);
    assert.notStrictEqual(preflight.status, 'fail', 'partial range fragment failed Motion QA preflight');
    assert.ok(
        !preflight.findings.some((finding) => finding.code === 'visual_window_too_short'),
        'partial range fragment was incorrectly treated as a tiny new graphic'
    );

    const generated = generateHyperframesProject({
        plan: clipped,
        projectDir,
        appRoot: ROOT,
        tempDir,
        publicDir,
        inputDir,
        outputRoot: path.join(projectDir, 'hyperframes'),
    });
    assert.strictEqual(generated.success, true);

    const manifest = JSON.parse(fs.readFileSync(generated.motionManifestPath, 'utf8'));
    assert.strictEqual(manifest.graphics.length, 1);
    const graphic = manifest.graphics[0];
    assert.strictEqual(graphic.rangeFragment, true);
    closeTo(graphic.duration, 0.113333, 0.00001);
    closeTo(graphic.sourceOffset, 9.346667, 0.00001);
    closeTo(graphic.sourceDuration, 9.46, 0.00001);
    assert.strictEqual(graphic.timingClamped, false, 'bridge inflated the exact partial duration');

    const html = fs.readFileSync(generated.indexPath, 'utf8');
    assert.ok(
        html.includes('__master.fromTo(tl,{time:9.347},{time:9.460,duration:0.113,ease:"none"},0.000)'),
        'authored visual timeline was not sliced from the original In-marker animation time'
    );
    assert.ok(
        html.includes('const rangeTimeline = sourceItem.rangeFragment ? gsap.timeline({ paused: true }) : null;'),
        'fixed-renderer visual timeline is missing range slicing support'
    );

    const state = { value: 0 };
    const master = gsap.timeline({ paused: true });
    const child = gsap.timeline({ paused: true });
    child.fromTo(state, { value: 0 }, { value: 10, duration: 10, ease: 'none' }, 0);
    child.progress(1, true).progress(0, true);
    master.fromTo(child, { time: 9 }, { time: 9.1, duration: 0.1, ease: 'none' }, 0);
    master.time(0.05, false);
    closeTo(state.value, 9.05, 0.0001);

    console.log('✅ partial render range slicing checks passed');
} finally {
    const resolved = path.resolve(testRoot);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-partial-render-range-')) {
        throw new Error(`Refusing to clean unsafe partial-render test directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}
