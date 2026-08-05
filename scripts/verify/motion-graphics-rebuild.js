#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectStore = require('../../src/project/project-store');
const {
    rebuildMotionGraphicsOnly,
} = require('../../src/pipeline/rebuild-motion-graphics');

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-mg-rebuild-'));
    const publicDir = path.join(root, 'public');
    const tempDir = path.join(root, 'temp');
    const inputDir = path.join(root, 'input');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });

    const mediaFile = path.join(publicDir, 'scene-0-asset.jpg');
    const audioFile = path.join(publicDir, 'voiceover.mp3');
    fs.writeFileSync(mediaFile, Buffer.from('preserved-media'));
    fs.writeFileSync(audioFile, Buffer.from('preserved-audio'));

    const plan = {
        audio: 'voiceover.mp3',
        totalDuration: 6,
        fps: 30,
        width: 1920,
        height: 1080,
        scenes: [{
            index: 0,
            originalIndex: 0,
            clipId: 'preserved-scene',
            startTime: 0,
            endTime: 6,
            mediaType: 'image',
            mediaFile,
            sourceProvider: 'test',
            transition: { type: 'cut', duration: 0 },
        }],
        transitions: [{ type: 'cut', startTime: 0 }],
        sfxClips: [{ file: 'impact.mp3', startTime: 1, duration: 0.4 }],
        motionGraphics: [],
        mgScenes: [{
            id: 'comparison-rebuild',
            clipId: 'comparison-rebuild',
            type: 'comparisonCard',
            text: 'Before vs After',
            subtext: 'A deliberately old subtitle',
            startTime: 1,
            endTime: 5,
            motionQaSafeLayout: true,
            motionQaSafeLayoutReason: 'motion-qa old fallback',
            authoredCompositionMode: 'fixed-renderer',
            authoredCompositionReason: 'motion-qa-safe-layout',
            _authoredComposition: {
                html: '<div>old authored composition</div>',
                css: '',
                timeline: 'tl.to("#old",{opacity:1})',
            },
        }],
        templateScenes: [],
        scriptContext: { themeId: 'modern', nicheId: 'general' },
        themeId: 'modern',
        mgStyle: 'clean',
        mapStyle: 'dark',
    };

    projectStore.saveProjectState({
        projectDir: root,
        publicDir,
        tempDir,
        settings: { repeatFromStep: 'motion-graphics' },
        videoPlan: plan,
    });

    const beforeScene = JSON.stringify(plan.scenes);
    const beforeTransitions = JSON.stringify(plan.transitions);
    const beforeSfx = JSON.stringify(plan.sfxClips);
    const beforeMediaHash = hashFile(mediaFile);
    const beforeAudioHash = hashFile(audioFile);

    try {
        const result = await rebuildMotionGraphicsOnly({
            projectDir: root,
            appRoot: path.resolve(__dirname, '..', '..'),
            verify: false,
            log: () => {},
            dependencies: {
                applyMotionDirector: async (payload) => {
                    payload.mgScenes[0].agenticComposition = {
                        role: 'fullscreen',
                        type: 'comparison-card',
                        layout: 'split-panel',
                        density: 'compact',
                        title: 'Before vs After',
                        subtitle: 'Rebuilt concise subtitle',
                    };
                    return payload;
                },
                authorPlanCompositions: async (workingPlan, options) => {
                    assert.strictEqual(options.graphicsOnly, true);
                    workingPlan.mgScenes[0]._authoredComposition = {
                        html: '<div>rebuilt authored composition</div>',
                        css: '',
                        timeline: 'tl.to("#rebuilt",{opacity:1})',
                    };
                    workingPlan.mgScenes[0]._authoredNs = 'auth-rebuilt';
                    return { authored: 1, eligible: 1 };
                },
                prepareMotionPlan: () => ({
                    version: 3,
                    status: 'pass',
                    checked: 1,
                    repairs: [],
                    findings: [],
                }),
            },
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.stringify(result.plan.scenes), beforeScene, 'graphics-only rebuild changed planned/media scenes');
        assert.strictEqual(JSON.stringify(result.plan.transitions), beforeTransitions, 'graphics-only rebuild changed transitions');
        assert.strictEqual(JSON.stringify(result.plan.sfxClips), beforeSfx, 'graphics-only rebuild changed SFX');
        assert.strictEqual(hashFile(mediaFile), beforeMediaHash, 'graphics-only rebuild rewrote downloaded media');
        assert.strictEqual(hashFile(audioFile), beforeAudioHash, 'graphics-only rebuild rewrote narration audio');
        assert.strictEqual(result.plan.mgScenes[0].motionQaSafeLayout, undefined, 'old automatic safe fallback was not cleared for the rebuild');
        assert.strictEqual(result.plan.mgScenes[0].authoredCompositionMode, undefined, 'old QA-only fixed-renderer lock was not cleared');
        assert.ok(
            result.plan.mgScenes[0]._authoredComposition.html.includes('rebuilt authored composition'),
            'rebuilt composition was not published'
        );
        assert.strictEqual(result.plan.motionGraphicsRebuild.preservedPlanning, true);
        assert.strictEqual(result.plan.motionGraphicsRebuild.preservedMedia, true);

        const loaded = projectStore.reconcileProjectState({
            projectDir: root,
            publicDir,
            tempDir,
        });
        assert.ok(loaded.videoPlan.mgScenes[0]._authoredComposition.html.includes('rebuilt authored composition'));
        assert.strictEqual(JSON.stringify(loaded.videoPlan.scenes), beforeScene);
        assert.ok(fs.existsSync(path.join(tempDir, 'video-plan.before-motion-graphics-rebuild.json')));

        console.log('✅ motion-graphics-only rebuild preserves planning/media and republishes verified graphics');
    } finally {
        const resolved = path.resolve(root);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-mg-rebuild-')) {
            throw new Error(`Refusing to clean unsafe test directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
