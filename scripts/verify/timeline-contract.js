#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const timeline = require('../../src/project/timeline-contract');
const { clipPlanForRange } = require('../../src/project/plan-range');
const SceneGraph = require('../../ui/js/compositor/SceneGraph');
const VideoFrameSource = require('../../ui/js/compositor/VideoFrameSource');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const migrated = timeline.normalizePlan({
    fps: 30,
    totalDuration: 124,
    scenes: [
        { index: 7, startTime: 0, endTime: 120, duration: 3600, trackId: 'video-track-1' },
        { index: 7, startTime: 120, durationFrames: 60, trackId: 'video-track-1' },
    ],
    mgScenes: [
        { id: 'hero-stat', type: 'statCard', startTime: 5, endTime: 8 },
    ],
});

assert.strictEqual(migrated.timelineContractVersion, timeline.VERSION);
assert.strictEqual(migrated.scenes[0].duration, 120, 'long seconds must not be divided by 30');
assert.strictEqual(migrated.scenes[0].durationFrames, 3600);
assert.strictEqual(migrated.scenes[1].duration, 2, 'durationFrames must convert through plan fps');
assert.strictEqual(migrated.scenes[0].sourceSceneIndex, 7);
assert.strictEqual(migrated.scenes[1].sourceSceneIndex, 7);
assert.notStrictEqual(migrated.scenes[0].clipId, migrated.scenes[1].clipId);
assert.strictEqual(migrated.mgScenes[0].duration, 3);
assert.strictEqual(migrated.mgScenes[0].durationFrames, 90);

const migratedAgain = timeline.normalizePlan(migrated);
assert.deepStrictEqual(
    migratedAgain.scenes.map((scene) => scene.clipId),
    migrated.scenes.map((scene) => scene.clipId),
    'normalization must preserve stable clip IDs'
);
assert.deepStrictEqual(
    migratedAgain.mgScenes.map((scene) => scene.clipId),
    migrated.mgScenes.map((scene) => scene.clipId),
    'visual clip IDs must be idempotent'
);
assert.deepStrictEqual(
    migratedAgain.continuityHolds,
    migrated.continuityHolds,
    'continuity holds must be deterministic and idempotent'
);

const continuityPlan = timeline.normalizePlan({
    fps: 30,
    totalDuration: 12,
    scenes: [
        {
            index: 0,
            clipId: 'continuity-a',
            startTime: 1,
            endTime: 4,
            mediaOffset: 2,
            trackId: 'video-track-1',
        },
        {
            index: 1,
            clipId: 'continuity-b',
            startTime: 6,
            endTime: 9,
            mediaOffset: 4,
            trackId: 'video-track-1',
        },
        {
            index: 2,
            clipId: 'upper-overlay',
            startTime: 4,
            endTime: 8,
            trackId: 'video-track-2',
        },
    ],
});
assert.deepStrictEqual(
    continuityPlan.continuityHolds.map((hold) => [hold.startTime, hold.endTime, hold.sourceClipId, hold.holdMode]),
    [
        [0, 1, 'continuity-a', 'head'],
        [4, 6, 'continuity-a', 'tail'],
        [9, 12, 'continuity-b', 'tail'],
    ],
    'base-track continuity must cover leading, interior, and trailing holes without treating upper tracks as footage'
);
assert.strictEqual(continuityPlan.continuityHolds[0].freezeTime, 2);
assert.ok(
    Math.abs(continuityPlan.continuityHolds[1].freezeTime - (2 + 3 - 1 / 30)) < 0.001,
    'tail continuity must freeze at the end of the source scene'
);
assert.strictEqual(
    continuityPlan.continuityHolds.reduce((sum, hold) => sum + hold.duration, 0),
    6,
    'continuity hold durations must exactly cover the real base-track gaps'
);
assert.deepStrictEqual(
    timeline.normalizePlan(continuityPlan).continuityHolds,
    continuityPlan.continuityHolds,
    'normalizing a plan with derived holds must not duplicate or drift them'
);

const inferredLegacyFrames = timeline.normalizeScenes([
    { index: 0, startTime: 0, duration: 60 },
    { index: 1, startTime: 2, duration: 1 },
], { fps: 30, totalDuration: 3 });
assert.strictEqual(inferredLegacyFrames[0].endTime, 2);
assert.strictEqual(inferredLegacyFrames[0].duration, 2);

const graph = new SceneGraph(30);
graph.loadFromPlan({
    fps: 30,
    totalDuration: 4,
    scenes: [
        { index: 4, sourceSceneIndex: 4, clipId: 'clip-a', startTime: 0, endTime: 2, trackId: 'video-track-1' },
        { index: 4, sourceSceneIndex: 4, clipId: 'clip-b', startTime: 2, endTime: 4, trackId: 'video-track-1' },
        { index: 4, sourceSceneIndex: 4, clipId: 'clip-c', startTime: 1, endTime: 3, trackId: 'video-track-2' },
    ],
    transitions: [
        {
            fromClipId: 'clip-a',
            toClipId: 'clip-b',
            fromSceneIndex: 4,
            toSceneIndex: 4,
            type: 'crossfade',
            duration: 0.6,
        },
    ],
});
const transition = graph.getTransitionAtFrame(60);
assert.ok(transition, 'clip-specific transition should resolve');
assert.strictEqual(transition.sceneA.clipId, 'clip-a');
assert.strictEqual(transition.sceneB.clipId, 'clip-b');
assert.ok(
    graph.getActiveScenesAtFrame(60).some(({ scene }) => scene.clipId === 'clip-c'),
    'same-source scene on another track must remain independently active'
);

const ambiguousLegacyGraph = new SceneGraph(30);
ambiguousLegacyGraph.loadFromPlan({
    fps: 30,
    scenes: [
        { index: 1, startTime: 0, endTime: 1 },
        { index: 1, startTime: 1, endTime: 2 },
    ],
    transitions: [
        { fromSceneIndex: 1, toSceneIndex: 1, type: 'crossfade', duration: 0.5 },
    ],
});
assert.strictEqual(
    ambiguousLegacyGraph._transitions.length,
    0,
    'ambiguous legacy source indices must not bind a transition to the wrong clip'
);

const videoFrames = new VideoFrameSource();
assert.strictEqual(
    videoFrames._findBestFrame([{ timestamp: 0 }, { timestamp: 33_333 }], 100_000),
    -1,
    'decoder must request more output instead of returning a stale pre-target frame'
);
assert.strictEqual(
    videoFrames._findBestFrame([{ timestamp: 66_666 }, { timestamp: 133_333 }], 100_000),
    0,
    'decoder should choose the closest frame at/before a bracketed target'
);
assert.strictEqual(
    videoFrames._findBestFrame([{ timestamp: 133_333 }], 100_000),
    0,
    'decoder may use the first frame only when it has already overshot the target'
);

const sourcePlan = {
    fps: 30,
    totalDuration: 20,
    scenes: [
        {
            index: 0,
            clipId: 'range-a',
            startTime: 0,
            endTime: 10,
            mediaOffset: 2,
            words: [
                { word: 'before', start: 3, end: 3.5 },
                { word: 'inside', start: 4.5, end: 5 },
            ],
            _iconMoments: [{ at: 4.5, dur: 1, kind: 'svg' }],
            _keywordGlow: [{ at: 5, dur: 1, phrase: 'inside' }],
            _presenterSpan: { id: 'presenter', start: 0, end: 10 },
        },
        {
            index: 1,
            clipId: 'range-b',
            startTime: 10,
            endTime: 20,
        },
    ],
    mgScenes: [{
        id: 'range-end-card',
        clipId: 'range-end-card',
        type: 'statCard',
        startTime: 11,
        endTime: 15,
    }],
    templateScenes: [{
        id: 'template-a',
        clipId: 'template-a',
        startTime: 3,
        endTime: 7,
        templateContentStartTime: 4,
        templateContentEndTime: 6,
    }],
    motionGraphics: [],
    sfxClips: [{ file: 'hit.mp3', startTime: 3, duration: 3 }],
    transitions: [{
        fromClipId: 'range-a',
        toClipId: 'range-b',
        fromSceneIndex: 0,
        toSceneIndex: 1,
        startTime: 10,
        type: 'crossfade',
        duration: 0.5,
    }],
};
const sourcePlanSnapshot = JSON.parse(JSON.stringify(sourcePlan));
const clippedPlan = clipPlanForRange(sourcePlan, 4, 12);
assert.deepStrictEqual(sourcePlan, sourcePlanSnapshot, 'range clipping must not mutate the source plan');
assert.strictEqual(clippedPlan.totalDuration, 8);
assert.strictEqual(clippedPlan.scenes[0].startTime, 0);
assert.strictEqual(clippedPlan.scenes[0].endTime, 6);
assert.strictEqual(clippedPlan.scenes[0].mediaOffset, 6);
assert.deepStrictEqual(clippedPlan.scenes[0].words.map((word) => word.word), ['inside']);
assert.strictEqual(clippedPlan.scenes[0].words[0].start, 0.5);
assert.strictEqual(clippedPlan.scenes[0]._iconMoments[0].at, 0.5);
assert.strictEqual(clippedPlan.scenes[0]._keywordGlow[0].at, 1);
assert.deepStrictEqual(clippedPlan.scenes[0]._presenterSpan, { id: 'presenter', start: 0, end: 6 });
assert.strictEqual(clippedPlan.scenes[1].startTime, 6);
assert.strictEqual(clippedPlan.scenes[1].endTime, 8);
assert.strictEqual(clippedPlan.templateScenes[0].startTime, 0);
assert.strictEqual(clippedPlan.templateScenes[0].endTime, 3);
assert.strictEqual(clippedPlan.templateScenes[0].templateContentStartTime, 0);
assert.strictEqual(clippedPlan.templateScenes[0].templateContentEndTime, 2);
assert.deepStrictEqual(
    clippedPlan.templateScenes[0]._renderRangeClip,
    {
        sourceStartTime: 3,
        sourceEndTime: 7,
        sourceDuration: 4,
        sourceOffset: 1,
        visibleDuration: 3,
        clippedAtStart: true,
        clippedAtEnd: false,
    },
    'a visual crossing the In marker must retain its original animation offset'
);
assert.strictEqual(clippedPlan.mgScenes[0].startTime, 7);
assert.strictEqual(clippedPlan.mgScenes[0].endTime, 8);
assert.deepStrictEqual(
    clippedPlan.mgScenes[0]._renderRangeClip,
    {
        sourceStartTime: 11,
        sourceEndTime: 15,
        sourceDuration: 4,
        sourceOffset: 0,
        visibleDuration: 1,
        clippedAtStart: false,
        clippedAtEnd: true,
    },
    'a visual crossing the Out marker must retain its original duration'
);
assert.strictEqual(clippedPlan.sfxClips[0].startTime, 0);
assert.strictEqual(clippedPlan.sfxClips[0].duration, 2);
assert.strictEqual(clippedPlan.sfxClips[0].sourceOffset, 1);
assert.strictEqual(clippedPlan.transitions[0].startTime, 6);

const appSource = read('ui/js/app.js');
const syncStart = appSource.indexOf('function syncVideoPlanFromEditor()');
const syncEnd = appSource.indexOf('async function saveProject', syncStart);
const syncBody = appSource.slice(syncStart, syncEnd);
assert.ok(syncBody.includes('timelineContract.normalizeScenes'));
assert.ok(!syncBody.includes('index: i,'), 'editor save must not renumber media source indices');
assert.ok(appSource.includes("clip.clipId = createUniqueClipId(clip, 'paste')"));
assert.ok(appSource.includes("rightClip.clipId = createUniqueClipId(scene, 'cut')"));
assert.ok(appSource.includes('trimmed.clipId = createSegmentClipId'));
assert.ok(appSource.includes('fromClipId: prev.clipId'));
assert.ok(appSource.includes('toClipId: curr.clipId'));
assert.ok(
    !appSource.includes('state.motionGraphics = allMGs.filter(mg => !mg?.disabled'),
    'disabled visuals must remain in editor state so save/reload cannot delete them'
);
assert.ok(
    appSource.includes('(state.motionGraphics || []).filter(mg => !mg.disabled)'),
    'disabled visuals must stay excluded from active compositor rendering'
);
assert.ok(appSource.includes('Math.floor(inSec * safeFps'));
assert.ok(appSource.includes('Math.ceil(outSec * safeFps'));
assert.ok(appSource.includes('timelineContract.buildContinuityHolds'));
assert.ok(appSource.includes('clip-continuity-hold'));

const compositorSource = read('ui/js/compositor/Compositor.js');
assert.ok(compositorSource.includes('scene.clipId'));
assert.ok(compositorSource.includes('scene?.sourceSceneIndex ?? scene?.index'));
assert.ok(compositorSource.includes('this._exportFrameSources.has(key)'));

const exportSource = read('ui/js/compositor/ExportPipeline.js');
assert.ok(exportSource.includes('vfs.init(key, url, fps)'));
assert.ok(exportSource.includes('exportFrameSources.set(key, videoFrame)'));
const videoFrameSource = read('ui/js/compositor/VideoFrameSource.js');
assert.ok(videoFrameSource.includes('await state.decoder.flush()'));
assert.ok(!videoFrameSource.includes('lastTs >= targetUs || bestIdx === frames.length - 1'));

const hyperframesSource = read('src/render/hyperframes-bridge.js');
assert.ok(hyperframesSource.includes('scene.clipId ??'));
assert.ok(hyperframesSource.includes('scene.sourceSceneIndex ?? scene.index'));
assert.ok(!hyperframesSource.includes('return explicit > 90 ? explicit / 30 : explicit'));
assert.ok(hyperframesSource.includes('plan.continuityHolds'));
assert.ok(hyperframesSource.includes('data-hf-continuity-hold="1"'));
assert.ok(hyperframesSource.includes('Applied ${holdGapAnims.length} planned timeline continuity hold(s)'));
const sceneGraphSource = read('ui/js/compositor/SceneGraph.js');
assert.ok(sceneGraphSource.includes('normalizedPlan.continuityHolds'));
const mainSource = read('main.js');
assert.ok(mainSource.includes("require('./src/project/plan-range')"));
assert.ok(mainSource.includes('Partial render preparation failed'));
assert.ok(!mainSource.includes('plan clip failed (${e.message}); rendering full timeline'));

console.log('✅ timeline identity/timing contract checks passed');
