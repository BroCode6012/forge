#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const { runAutonomousOperations } = require('../../src/agents/editor-supervisor/autonomous-runner');
const {
    _renderContractFailures,
    analyzePngFrame,
    representativeProofTimes,
    runVisualObserver,
    shouldRunVisualQa,
} = require('../../src/agents/editor-supervisor/visual-observer');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function writeFrame(filePath, rgba = [40, 100, 180, 255]) {
    const image = new PNG({ width: 64, height: 36 });
    for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = rgba[0];
        image.data[offset + 1] = rgba[1];
        image.data[offset + 2] = rgba[2];
        image.data[offset + 3] = rgba[3];
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, PNG.sync.write(image));
}

function fixturePlan() {
    return {
        fps: 30,
        totalDuration: 8,
        scenes: [
            {
                index: 0,
                clipId: 'clip-a',
                trackId: 'video-track-1',
                startTime: 0,
                endTime: 4,
                mediaFile: 'scene-a.jpg',
                mediaType: 'image',
                framing: 'cinematic',
                scale: 0.75,
                text: 'Opening proof frame',
            },
            {
                index: 1,
                clipId: 'clip-b',
                trackId: 'video-track-1',
                startTime: 4,
                endTime: 8,
                mediaFile: 'scene-b.mp4',
                mediaType: 'video',
                framing: 'fullscreen',
                scale: 1,
                text: 'Closing proof frame',
            },
        ],
        motionGraphics: [],
        mgScenes: [],
        templateScenes: [],
        overlayScenes: [],
        transitions: [],
        sfxClips: [],
    };
}

function clipScope() {
    return {
        kind: 'clips',
        label: '1 selected clip',
        fromSec: 0,
        toSec: 4,
        currentTime: 2,
        totalDuration: 8,
        contiguous: true,
        clipRefs: [{
            clipId: 'clip-a',
            sourceSceneIndex: 0,
            trackId: 'video-track-1',
            startTime: 0,
            endTime: 4,
        }],
        visualRefs: [],
    };
}

async function run() {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-visual-observer-'));
    try {
        const beforePlan = fixturePlan();
        const editedPlan = clone(beforePlan);
        editedPlan.scenes[0].framing = 'fullscreen';
        editedPlan.scenes[0].scale = 1;
        const scope = clipScope();
        const proof = representativeProofTimes(beforePlan, editedPlan, scope, [], 4);
        assert.ok(proof.length >= 1);
        assert.ok(proof.every((entry) => entry.time >= 0 && entry.time <= 4));
        const previousVisualQaEnv = process.env.AGENT_VISUAL_QA;
        delete process.env.AGENT_VISUAL_QA;
        try {
            assert.strictEqual(
                shouldRunVisualQa({
                    effort: 'fast',
                    operations: [{
                        capabilityId: 'framing',
                        action: 'set-framing',
                        scope,
                    }],
                }),
                false,
                'ordinary fast edits should keep the fast-mode visual-QA behavior'
            );
            assert.strictEqual(
                shouldRunVisualQa({
                    effort: 'fast',
                    operations: [{
                        capabilityId: 'graphics',
                        action: 'regenerate',
                        scope: {
                            kind: 'visual',
                            visualRefs: [{ id: 'selected-stat-card' }],
                        },
                    }],
                }),
                true,
                'destructive exact-visual regeneration must render proof frames even in fast mode'
            );
        } finally {
            if (previousVisualQaEnv === undefined) delete process.env.AGENT_VISUAL_QA;
            else process.env.AGENT_VISUAL_QA = previousVisualQaEnv;
        }

        const opaquePath = path.join(projectDir, 'opaque.png');
        const transparentPath = path.join(projectDir, 'transparent.png');
        writeFrame(opaquePath);
        writeFrame(transparentPath, [0, 0, 0, 0]);
        assert.ok(analyzePngFrame(opaquePath).visibleRatio > 0.99);
        assert.ok(analyzePngFrame(transparentPath).visibleRatio < 0.01);

        const graphicBefore = fixturePlan();
        graphicBefore.motionGraphics = [{
            id: 'headline-proof',
            clipId: 'headline-proof',
            type: 'headline',
            text: 'Proof headline',
            startTime: 1,
            duration: 2,
            animation: 'springScale',
            colors: { text: '#1f2937' },
        }];
        const graphicAfter = clone(graphicBefore);
        Object.assign(graphicAfter.motionGraphics[0], {
            animation: 'typewriter',
            animationManual: true,
            cardStyle: 'transparent',
            transparentBackground: true,
            authoredCompositionMode: 'fixed-renderer',
            colors: {
                text: '#ffffff',
                background: 'rgba(0,0,0,0)',
            },
        });
        const graphicOperations = [{
            capabilityId: 'graphics',
            action: 'edit-properties',
            args: {
                targetIds: ['headline-proof'],
                animation: 'typewriter',
                transparentBackground: true,
                textColor: '#ffffff',
            },
        }];
        const staleFailures = _renderContractFailures(
            graphicBefore,
            graphicAfter,
            graphicOperations,
            {
                graphics: [{
                    sourceClipId: 'headline-proof',
                    authored: true,
                    fixedRendererOverride: false,
                    animation: 'springScale',
                    transparentBackground: false,
                    textColor: '#1f2937',
                }],
            }
        );
        assert.ok(staleFailures.some((message) => /authored composition/i.test(message)));
        assert.ok(staleFailures.some((message) => /transparent-background/i.test(message)));
        assert.ok(staleFailures.some((message) => /typewriter/i.test(message)));
        assert.ok(staleFailures.some((message) => /#ffffff/i.test(message)));
        assert.deepStrictEqual(
            _renderContractFailures(
                graphicBefore,
                graphicAfter,
                graphicOperations,
                {
                    graphics: [{
                        sourceClipId: 'headline-proof',
                        authored: false,
                        fixedRendererOverride: true,
                        animation: 'typewriter',
                        transparentBackground: true,
                        textColor: '#ffffff',
                    }],
                }
            ),
            []
        );
        const scopedProofBefore = clone(graphicBefore);
        scopedProofBefore.motionGraphics.push({
            id: 'unrelated-proof',
            clipId: 'unrelated-proof',
            type: 'callout',
            text: 'Unrelated visual',
            startTime: 5,
            duration: 2,
        });
        const scopedProofAfter = clone(graphicAfter);
        scopedProofAfter.motionGraphics.push({
            id: 'unrelated-proof',
            clipId: 'unrelated-proof',
            type: 'callout',
            text: 'Unrelated normalized visual',
            startTime: 5,
            duration: 2,
        });
        const exactVisualScope = {
            kind: 'visual',
            label: 'Selected headline',
            fromSec: 1,
            toSec: 3,
            currentTime: 2,
            totalDuration: 8,
            visualRefs: [{
                id: 'headline-proof',
                type: 'headline',
                collection: 'motionGraphics',
                startTime: 1,
                endTime: 3,
            }],
            clipRefs: [],
            iconRefs: [],
        };
        const scopedProof = representativeProofTimes(
            scopedProofBefore,
            scopedProofAfter,
            exactVisualScope,
            graphicOperations,
            4
        );
        assert.ok(scopedProof.length >= 1);
        assert.ok(
            scopedProof.every((entry) => entry.time >= 1 && entry.time <= 3),
            'exact-visual proof sampling leaked into an unrelated normalized graphic'
        );

        let reviewCalls = 0;
        const dependencies = {
            generateProject: async ({ outputRoot }) => {
                const generatedDir = path.join(outputRoot, 'yta-hf-test');
                fs.mkdirSync(generatedDir, { recursive: true });
                const manifestPath = path.join(generatedDir, 'hyperframes-motion-manifest.json');
                fs.writeFileSync(manifestPath, JSON.stringify({ duration: 8, scenes: [], graphics: [] }));
                return {
                    success: true,
                    projectDir: generatedDir,
                    motionManifestPath: manifestPath,
                };
            },
            captureSnapshots: async ({ projectDir: generatedDir, proof: requested }) => {
                const files = requested.map((entry, index) => {
                    const file = path.join(generatedDir, `frame-${index + 1}.png`);
                    writeFrame(file, [36 + index * 8, 92, 168, 255]);
                    return { ...entry, file };
                });
                return { proof: requested, files, result: { ok: true } };
            },
            reviewFrames: async () => {
                reviewCalls++;
                if (reviewCalls > 1) {
                    return {
                        available: true,
                        verdict: 'pass',
                        summary: 'The repaired proof frames are clean.',
                        findings: [],
                        invocations: [],
                    };
                }
                return {
                    available: true,
                    verdict: 'repair',
                    summary: 'The subject needs a small same-scope reframe.',
                    findings: [{
                        severity: 'warning',
                        frameIndex: 0,
                        code: 'subject-edge',
                        message: 'The subject sits too close to the frame edge.',
                    }],
                    invocations: [
                        {
                            capabilityId: 'framing',
                            action: 'adjust-framing',
                            args: { posXDelta: 3 },
                            description: 'nudge the selected subject away from the edge',
                        },
                        {
                            capabilityId: 'media',
                            action: 'replace',
                            args: { query: 'different footage' },
                            description: 'unsafe broad replacement that must be rejected',
                        },
                    ],
                };
            },
        };
        const request = {
            text: 'Make this clip fullscreen',
            originalText: 'Make this clip fullscreen',
            effort: 'smart',
            scope,
        };
        const approvedOperations = [{
            capabilityId: 'framing',
            specialist: 'Framing Editor',
            action: 'set-framing',
            args: { framing: 'fullscreen' },
            scope,
            risk: 'low',
            description: 'set fullscreen framing',
        }];
        const first = await runVisualObserver({
            beforePlan,
            plan: editedPlan,
            request,
            operations: approvedOperations,
            transactionId: 'visual-observer-test',
            pass: 1,
            options: {
                projectDir,
                appRoot: ROOT,
                visualQaDeps: dependencies,
                log: () => { },
            },
        });
        assert.strictEqual(first.status, 'repair');
        assert.strictEqual(first.frameCount, proof.length);
        assert.strictEqual(first.repairOperations.length, 1);
        assert.strictEqual(first.repairOperations[0].capabilityId, 'framing');
        assert.strictEqual(first.repairOperations[0].scope.clipRefs[0].clipId, 'clip-a');
        assert.ok(first.rejectedRepairs.some((message) => /not an allowed visual repair/i.test(message)));
        assert.ok(first.frames.every((frame) => fs.existsSync(path.join(projectDir, frame.relativePath))));

        const repaired = await runAutonomousOperations(editedPlan, first.repairOperations, {
            request: request.text,
            originalRequest: request.originalText,
            effort: 'smart',
            transactionId: 'visual-observer-test',
            options: { projectDir, log: () => { } },
        });
        assert.strictEqual(repaired.plan.scenes[0].posX, 3);
        assert.strictEqual(repaired.plan.scenes[1].posX, undefined);

        const second = await runVisualObserver({
            beforePlan,
            plan: repaired.plan,
            request,
            operations: [...approvedOperations, ...first.repairOperations],
            transactionId: 'visual-observer-test',
            pass: 2,
            options: {
                projectDir,
                appRoot: ROOT,
                visualQaDeps: dependencies,
                log: () => { },
            },
        });
        assert.strictEqual(second.status, 'pass');
        assert.strictEqual(reviewCalls, 2);
        const emptyRepairVerdict = await runVisualObserver({
            beforePlan,
            plan: editedPlan,
            request,
            operations: approvedOperations,
            transactionId: 'visual-observer-empty-repair',
            pass: 1,
            options: {
                projectDir,
                appRoot: ROOT,
                visualQaDeps: {
                    ...dependencies,
                    reviewFrames: async () => ({
                        available: true,
                        verdict: 'repair',
                        summary: 'The approved visible edit is present.',
                        findings: [],
                        invocations: [],
                    }),
                },
                log: () => { },
            },
        });
        assert.strictEqual(
            emptyRepairVerdict.status,
            'pass',
            'an empty repair verdict with no findings must not surface as a warning'
        );

        const blocked = await runVisualObserver({
            beforePlan: graphicBefore,
            plan: graphicAfter,
            request: {
                text: 'Make the headline white with no background and typewriter animation',
                originalText: 'Make the headline white with no background and typewriter animation',
                effort: 'smart',
                scope: {
                    kind: 'visual',
                    label: 'Selected headline',
                    fromSec: 1,
                    toSec: 3,
                    currentTime: 2,
                    totalDuration: 8,
                    visualRefs: [{
                        id: 'headline-proof',
                        type: 'headline',
                        startTime: 1,
                        endTime: 3,
                    }],
                    clipRefs: [],
                    iconRefs: [],
                },
            },
            operations: graphicOperations,
            transactionId: 'visual-observer-render-contract',
            pass: 1,
            options: {
                projectDir,
                appRoot: ROOT,
                visualQaDeps: {
                    generateProject: async ({ outputRoot }) => {
                        const generatedDir = path.join(outputRoot, 'yta-hf-stale');
                        fs.mkdirSync(generatedDir, { recursive: true });
                        const manifestPath = path.join(generatedDir, 'hyperframes-motion-manifest.json');
                        fs.writeFileSync(manifestPath, JSON.stringify({
                            duration: 8,
                            scenes: [],
                            graphics: [{
                                sourceClipId: 'headline-proof',
                                authored: true,
                                fixedRendererOverride: false,
                                animation: 'springScale',
                                transparentBackground: false,
                                textColor: '#1f2937',
                            }],
                        }));
                        return {
                            success: true,
                            projectDir: generatedDir,
                            motionManifestPath: manifestPath,
                        };
                    },
                    captureSnapshots: async () => {
                        throw new Error('snapshot capture must not run after a render-contract failure');
                    },
                },
                log: () => { },
            },
        });
        assert.strictEqual(blocked.status, 'block');
        assert.ok(blocked.findings.some((finding) => finding.code === 'render-contract-mismatch'));

        const boundedGraphicRepair = await runVisualObserver({
            beforePlan: graphicBefore,
            plan: graphicAfter,
            request: {
                text: 'Restyle this headline',
                originalText: 'Restyle this headline',
                effort: 'smart',
                scope: exactVisualScope,
            },
            operations: graphicOperations,
            transactionId: 'visual-observer-bounded-graphics-repair',
            pass: 1,
            options: {
                projectDir,
                appRoot: ROOT,
                visualQaDeps: {
                    generateProject: async ({ outputRoot }) => {
                        const generatedDir = path.join(outputRoot, 'yta-hf-bounded-repair');
                        fs.mkdirSync(generatedDir, { recursive: true });
                        const manifestPath = path.join(generatedDir, 'hyperframes-motion-manifest.json');
                        fs.writeFileSync(manifestPath, JSON.stringify({
                            duration: 8,
                            scenes: [],
                            graphics: [{
                                sourceClipId: 'headline-proof',
                                authored: false,
                                fixedRendererOverride: true,
                                animation: 'typewriter',
                                transparentBackground: true,
                                textColor: '#ffffff',
                            }],
                        }));
                        return {
                            success: true,
                            projectDir: generatedDir,
                            motionManifestPath: manifestPath,
                        };
                    },
                    captureSnapshots: async ({ projectDir: generatedDir, proof: requested }) => {
                        const file = path.join(generatedDir, 'frame-01.png');
                        writeFrame(file, [42, 78, 128, 255]);
                        return {
                            proof: requested,
                            files: [{ ...requested[0], file }],
                            result: { ok: true },
                        };
                    },
                    reviewFrames: async () => ({
                        available: true,
                        verdict: 'repair',
                        summary: 'Increase only text separation from the background.',
                        findings: [],
                        invocations: [{
                            capabilityId: 'graphics',
                            action: 'edit-properties',
                            args: {
                                targetType: 'headline',
                                targetIds: ['headline-proof'],
                                style: 'bold',
                                variant: 'punch',
                                shadowStrength: 0.8,
                            },
                            description: 'strengthen text separation without redesigning the graphic',
                        }],
                    }),
                },
                log: () => { },
            },
        });
        assert.strictEqual(boundedGraphicRepair.status, 'repair');
        assert.strictEqual(boundedGraphicRepair.repairOperations.length, 1);
        assert.strictEqual(
            boundedGraphicRepair.repairOperations[0].args.shadowStrength,
            0.8
        );
        assert.strictEqual(
            boundedGraphicRepair.repairOperations[0].args.style,
            undefined,
            'Visual Observer repairs must not silently redesign the approved graphic style'
        );
        assert.strictEqual(
            boundedGraphicRepair.repairOperations[0].args.variant,
            undefined,
            'Visual Observer repairs must not switch to an unrelated graphic variant'
        );
        const rejectedRedesignOnly = await runVisualObserver({
            beforePlan: graphicBefore,
            plan: graphicAfter,
            request: {
                text: 'Restyle this headline',
                originalText: 'Restyle this headline',
                effort: 'smart',
                scope: exactVisualScope,
            },
            operations: graphicOperations,
            transactionId: 'visual-observer-rejected-redesign-only',
            pass: 1,
            options: {
                projectDir,
                appRoot: ROOT,
                visualQaDeps: {
                    generateProject: async ({ outputRoot }) => {
                        const generatedDir = path.join(outputRoot, 'yta-hf-rejected-redesign');
                        fs.mkdirSync(generatedDir, { recursive: true });
                        const manifestPath = path.join(generatedDir, 'hyperframes-motion-manifest.json');
                        fs.writeFileSync(manifestPath, JSON.stringify({
                            duration: 8,
                            scenes: [],
                            graphics: [{
                                sourceClipId: 'headline-proof',
                                authored: false,
                                fixedRendererOverride: true,
                                animation: 'typewriter',
                                transparentBackground: true,
                                textColor: '#ffffff',
                            }],
                        }));
                        return {
                            success: true,
                            projectDir: generatedDir,
                            motionManifestPath: manifestPath,
                        };
                    },
                    captureSnapshots: async ({ projectDir: generatedDir, proof: requested }) => {
                        const file = path.join(generatedDir, 'frame-01.png');
                        writeFrame(file, [42, 78, 128, 255]);
                        return {
                            proof: requested,
                            files: [{ ...requested[0], file }],
                            result: { ok: true },
                        };
                    },
                    reviewFrames: async () => ({
                        available: true,
                        verdict: 'repair',
                        summary: 'The approved visible edit is already present.',
                        findings: [],
                        invocations: [{
                            capabilityId: 'graphics',
                            action: 'edit-properties',
                            args: {
                                targetType: 'headline',
                                targetIds: ['headline-proof'],
                                style: 'bold',
                                variant: 'punch',
                            },
                            description: 'unnecessary redesign',
                        }],
                    }),
                },
                log: () => { },
            },
        });
        assert.strictEqual(rejectedRedesignOnly.status, 'pass');
        assert.strictEqual(rejectedRedesignOnly.repairOperations.length, 0);

        if (/^(1|true|on)$/i.test(String(process.env.VISUAL_OBSERVER_REAL || '').trim())) {
            const realProjectDir = path.join(projectDir, 'real-project');
            for (const folder of ['input', 'public', 'temp']) {
                fs.mkdirSync(path.join(realProjectDir, folder), { recursive: true });
            }
            writeFrame(path.join(realProjectDir, 'input', 'scene.png'), [52, 104, 176, 255]);
            const realBefore = fixturePlan();
            realBefore.scenes = [{
                ...realBefore.scenes[0],
                endTime: 3,
                mediaFile: 'scene.png',
            }];
            realBefore.totalDuration = 3;
            const realAfter = clone(realBefore);
            realAfter.scenes[0].framing = 'fullscreen';
            realAfter.scenes[0].scale = 1;
            const realScope = {
                ...clipScope(),
                toSec: 3,
                totalDuration: 3,
                clipRefs: [{
                    ...clipScope().clipRefs[0],
                    endTime: 3,
                }],
            };
            const real = await runVisualObserver({
                beforePlan: realBefore,
                plan: realAfter,
                request: {
                    text: 'Make this clip fullscreen',
                    originalText: 'Make this clip fullscreen',
                    effort: 'smart',
                    scope: realScope,
                },
                operations: [{
                    ...approvedOperations[0],
                    scope: realScope,
                }],
                transactionId: 'visual-observer-real',
                pass: 1,
                options: {
                    projectDir: realProjectDir,
                    appRoot: ROOT,
                    tempDir: path.join(realProjectDir, 'temp'),
                    publicDir: path.join(realProjectDir, 'public'),
                    inputDir: path.join(realProjectDir, 'input'),
                    visualQaDeps: {
                        reviewFrames: async () => ({
                            available: true,
                            verdict: 'pass',
                            summary: 'Real HyperFrames proof frame rendered cleanly.',
                            findings: [],
                            invocations: [],
                        }),
                    },
                    log: () => { },
                },
            });
            assert.notStrictEqual(real.status, 'skipped', `real snapshot skipped: ${real.reason || ''}`);
            assert.ok(real.frameCount >= 1, 'real HyperFrames snapshot did not produce a proof frame');
            assert.strictEqual(real.status, 'pass');
            console.log(`Real HyperFrames Visual Observer smoke passed (${real.frameCount} proof frame${real.frameCount === 1 ? '' : 's'})`);
        }

        console.log('Rendered-frame Visual Observer checks passed');
    } finally {
        const resolved = path.resolve(projectDir);
        const tempRoot = path.resolve(os.tmpdir());
        if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith('yta-visual-observer-')) {
            throw new Error(`Refusing to clean unsafe visual-observer directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
