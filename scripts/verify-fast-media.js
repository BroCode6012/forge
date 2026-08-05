#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fastTestMedia, __test } = require('../src/media/fast-stock-media');

function hash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
    const pipelineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'build-video.js'), 'utf8');
    assert(
        pipelineSource.includes('Fast Test: skipped semantic explainer-image search'),
        'Fast Test must skip semantic explainer-image acquisition while keeping the graphic active'
    );
    assert(
        pipelineSource.includes('fastTest: _fastMedia'),
        'Fast Test must be propagated to the Composition Author'
    );
    const authorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'workers', 'composition-author.js'), 'utf8');
    assert(
        authorSource.includes('!overlaysDisabled() && !fastTest')
        && authorSource.includes('directIcons && !fastTest')
        // Anchor on the guard's meaning, not its exact punctuation. The check is
        // "the semantic subject search is gated behind BOTH fastTest and openMode";
        // extra conjuncts (e.g. && !graphicsOnly) only narrow it further, which
        // still satisfies the contract. Pinning the full `if (...)` made an
        // unrelated feature flag fail this gate.
        && authorSource.includes('!fastTest && !openMode'),
        'Fast Test must keep stage authoring while skipping repeated overlay authoring and semantic icon/subject searches'
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-fast-media-'));
    try {
        const sourceDir = path.join(root, 'source');
        const tempDir = path.join(root, 'temp');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.mkdirSync(tempDir, { recursive: true });

        const files = {};
        for (const [name, body] of Object.entries({
            'image-a.jpg': 'unique-image-a',
            'image-b.jpg': 'unique-image-b',
            'video-a.mp4': 'unique-video-a',
            'video-b.mp4': 'unique-video-b',
        })) {
            files[name] = path.join(sourceDir, name);
            fs.writeFileSync(files[name], body);
        }

        assert.deepStrictEqual(
            __test.countDemand([
                { mediaType: 'image' },
                { mediaType: 'video' },
                { sourceHint: 'web-image' },
            ]),
            { image: 2, video: 1 }
        );
        assert.strictEqual(__test.poolTarget(10) > 10, true);
        assert.strictEqual(__test.uniqueAssets([
            { url: 'https://example.com/a#one' },
            { url: 'https://example.com/a#two' },
        ]).length, 1);

        const scenes = [
            { index: 0, mediaType: 'image', sourceHint: 'web-image', keyword: 'one' },
            { index: 1, mediaType: 'video', sourceHint: 'youtube', keyword: 'two' },
            { index: 2, mediaType: 'image', sourceHint: 'stock', keyword: 'three' },
            { index: 3, mediaType: 'video', sourceHint: 'reddit', keyword: 'four' },
        ];
        const result = await fastTestMedia(scenes, {
            tempDir,
            log: () => {},
            prefetchedFiles: {
                images: [
                    { path: files['image-a.jpg'], provider: 'pexels' },
                    { path: files['image-b.jpg'], provider: 'pixabay' },
                ],
                videos: [
                    { path: files['video-a.mp4'], provider: 'pexels' },
                    { path: files['video-b.mp4'], provider: 'pixabay' },
                ],
            },
        });

        assert.strictEqual(result.stats.directAccepted, 4);
        assert.strictEqual(result.stats.failed, 0);
        assert.strictEqual(new Set(result.scenes.map((scene) => scene.mediaFile)).size, 4);
        assert.strictEqual(new Set(result.scenes.map((scene) => hash(scene.mediaFile))).size, 4);
        assert.deepStrictEqual(result.scenes.map((scene) => scene.plannedSourceHint), [
            'web-image',
            'youtube',
            'stock',
            'reddit',
        ]);
        assert(result.scenes.every((scene) => scene.sourceHint === 'stock'));
        assert(result.scenes.every((scene) => scene.mediaDiagnostics?.fastTest?.uniqueAsset === true));
        assert(result.scenes.every((scene) => path.basename(scene.mediaFile).startsWith(`scene-${scene.index}.`)));

        const shortageDir = path.join(root, 'shortage');
        fs.mkdirSync(shortageDir, { recursive: true });
        const onlyAsset = path.join(sourceDir, 'only.mp4');
        fs.writeFileSync(onlyAsset, 'one-real-asset');
        const shortage = await fastTestMedia([
            { index: 10, mediaType: 'video', keyword: 'first' },
            { index: 11, mediaType: 'video', keyword: 'second' },
        ], {
            tempDir: shortageDir,
            log: () => {},
            prefetchedFiles: { videos: [{ path: onlyAsset, provider: 'pexels' }] },
            placeholderFactory: (scene, dest) => {
                fs.writeFileSync(dest, `placeholder-${scene.index}`);
                return dest;
            },
        });
        assert.strictEqual(shortage.stats.directAccepted, 1);
        assert.strictEqual(shortage.stats.providerFallbackAccepted, 1);
        assert.strictEqual(shortage.stats.agenticGraphicFallback, 0);
        assert.strictEqual(new Set(shortage.scenes.map((scene) => hash(scene.mediaFile))).size, 2);
        assert.strictEqual(
            shortage.scenes.filter((scene) => scene.sourceProvider === 'fast-test-placeholder').length,
            1
        );

        console.log('✅ fast media is one-asset-per-scene, preserves planned source metadata, and never round-robins');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
