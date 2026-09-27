#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the coverage-sweep merge (src/pipeline/build-video.js).
 *
 * THE DEFECT IT LOCKS OUT (found 2026-08-16)
 *
 * The merge that re-attaches a swept scene to the base track asked "is this
 * scene already on the track?" with `scenesWithMedia.includes(s)` — object
 * identity. But the fullscreen-MG carve and the template carve both REBUILD the
 * track out of `{ ...scene }` copies, so past that point nothing on the track is
 * reference-equal to its entry in `scenesWithKeywords`. The test therefore
 * answered "off track" for every scene alive, and the merge appended the whole
 * track back onto itself.
 *
 * Measured on the "Mboko Osaka Wildcard TEST" build: 147 Director scenes and a
 * 124-scene carved track went in, 270 scenes came out — 122 timeline slots
 * carrying the same beat twice, 122 clipIds renamed with a `-2` suffix by the
 * timeline contract, and 1037s of scene runtime for a 563s video. The copy that
 * landed on top was the one that had missed every late per-index enrichment, so
 * 27 scenes lost their effect recipe to a duplicate drawn over them.
 *
 * It is silent by construction: the timeline contract renames the colliding
 * clipId, so every downstream stage sees a well-formed plan. The properties
 * pinned here are what make it loud instead:
 *
 *   1. Membership is by scene NUMBER, so a `{ ...scene }` copy still counts as
 *      on-track. Same key `scene-coverage.js:_uniqueScenes` uses.
 *   2. Object identity still counts, for scenes that were never copied.
 *   3. Presenter holds stay out of the sweep's universe — their visual is owned
 *      by the presenter system, not the footage system.
 *   4. The tripwire at the plan-emission site still exists, so if a future carve
 *      reindexes the track the build shouts instead of shipping doubles.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
let checks = 0;

function check(label, fn) {
    checks++;
    try {
        fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

console.log('\n[coverage-merge-identity] the sweep merge may not re-append the track onto itself\n');

process.env.BUILD_VIDEO_NO_RUN = '1';
const { partitionTrackMembership } = require(path.join(ROOT, 'src', 'pipeline', 'build-video.js')).__test;
const BV = fs.readFileSync(path.join(ROOT, 'src', 'pipeline', 'build-video.js'), 'utf8');

// The exact shape the bug needed: a Director track, a carve that rebuilds it out
// of shallow copies, and a couple of beats genuinely dropped off V1 because a
// fullscreen graphic took their span.
function directorScenes(n) {
    return Array.from({ length: n }, (_, i) => ({
        index: i,
        startTime: i * 4,
        endTime: i * 4 + 4,
        mediaFile: `scene-${i}-asset.mp4`,
    }));
}
const CARVED_AWAY = new Set([3, 7]);
function carve(scenes) {
    // What the MG/template carve does: `{ ...scene }` copies, spans possibly
    // trimmed, fully-covered beats dropped. Identity is gone; `index` survives.
    return scenes.filter(s => !CARVED_AWAY.has(s.index)).map(s => ({ ...s }));
}

check('a { ...scene } copy of an on-track scene is recognised as on-track', () => {
    const keywords = directorScenes(10);
    const track = carve(keywords);
    const { isOnTrack } = partitionTrackMembership(track, keywords);
    for (const s of keywords) {
        if (CARVED_AWAY.has(s.index)) continue;
        assert.ok(isOnTrack(s),
            `scene ${s.index} is on the track as a shallow copy but was reported off-track — `
            + 'this is the identity test that appended the whole track back onto itself');
    }
});

check('only the genuinely carved-away scenes come back as off-track', () => {
    const keywords = directorScenes(10);
    const { offTrack } = partitionTrackMembership(carve(keywords), keywords);
    assert.deepStrictEqual(offTrack.map(s => s.index).sort((a, b) => a - b), [...CARVED_AWAY].sort((a, b) => a - b),
        `expected exactly the carved-away beats off-track, got ${offTrack.length} of ${keywords.length}`);
});

check('merging every off-track scene that has media leaves ZERO duplicate slots', () => {
    const keywords = directorScenes(10);
    const track = carve(keywords);
    const { isOnTrack, offTrack } = partitionTrackMembership(track, keywords);
    const joined = offTrack.filter(s => s.mediaFile && !isOnTrack(s));
    const merged = [...track, ...joined].sort((a, b) => a.startTime - b.startTime);

    const seen = new Map();
    for (const s of merged) {
        const key = `${s.startTime}|${s.endTime}|${s.mediaFile}`;
        seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dupes = [...seen.values()].filter(n => n > 1).length;
    assert.strictEqual(dupes, 0, `${dupes} timeline slot(s) carry the same beat twice after the merge`);
    assert.strictEqual(merged.length, keywords.length,
        `merged track holds ${merged.length} scenes, expected ${keywords.length}`);
});

check('object identity still counts (an uncopied track)', () => {
    const keywords = directorScenes(6);
    const track = keywords.slice(0, 4);          // same objects, no carve
    const { offTrack } = partitionTrackMembership(track, keywords);
    assert.deepStrictEqual(offTrack.map(s => s.index), [4, 5],
        'a track that was never copied must still match by reference');
});

check('a scene with no usable index falls back to identity rather than matching everything', () => {
    const keywords = directorScenes(4).concat([{ startTime: 99, endTime: 103, mediaFile: 'x.mp4' }]);
    const { isOnTrack } = partitionTrackMembership(carve(keywords), keywords);
    assert.ok(!isOnTrack(keywords[4]),
        'an index-less scene must not be treated as on-track — NaN would otherwise match the Set probe');
});

check('presenter holds are kept out of the sweep universe', () => {
    const keywords = directorScenes(6);
    keywords[5]._presenterAnchor = true;
    keywords[4].presenterInsert = true;
    const { offTrack } = partitionTrackMembership([], keywords);
    assert.ok(!offTrack.some(s => s._presenterAnchor || s.presenterInsert),
        'a presenter hold reached the footage sweep — its visual is owned by the presenter system');
});

check('the merge site uses the shared predicate, not a fresh identity test', () => {
    const site = BV.slice(BV.indexOf('const { isOnTrack, offTrack } = partitionTrackMembership('));
    const merge = site.slice(0, site.indexOf('assignFinalSceneIndices('));
    assert.ok(merge.includes('partitionTrackMembership('),
        'the coverage sweep no longer resolves track membership through partitionTrackMembership()');
    assert.ok(!/scenesWithMedia\.includes\(/.test(merge),
        'an object-identity membership test came back into the coverage-sweep merge — '
        + 'the carve makes it always false, which re-appends the whole track');
    assert.ok(merge.includes('_coveredBeforeSweep'),
        'the merge no longer restricts itself to scenes the sweep actually fixed — '
        + 'it would put footage back underneath the graphic that replaced it');
});

check('the plan-emission tripwire that shouts about duplicate slots is still armed', () => {
    assert.ok(BV.includes('DUPLICATE MAIN-TRACK SCENES'),
        'the duplicate-slot tripwire was removed — this defect is silent without it, because the '
        + 'timeline contract renames the colliding clipId and everything downstream looks healthy');
});

console.log(`\n[coverage-merge-identity] ${checks - failures}/${checks} checks passed`);
if (failures) {
    console.log(`[coverage-merge-identity] FAILED — ${failures} check(s)\n`);
    process.exit(1);
}
console.log('[coverage-merge-identity] OK\n');
