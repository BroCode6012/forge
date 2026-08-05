'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../../src/agents/editor-supervisor/capabilities/registry');
const graphicsCapability = require('../../src/agents/editor-supervisor/capabilities/graphics');
const { runAutonomousOperations } = require('../../src/agents/editor-supervisor/autonomous-runner');
const { resolveContextualPayload } = require('../../src/agents/editor-supervisor/conversation-context');
const sessionStore = require('../../src/agents/editor-supervisor/session-store');
const transactionAssets = require('../../src/agents/editor-supervisor/transaction-assets');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function fixturePlan() {
    return {
        fps: 30,
        totalDuration: 10,
        scenes: [
            {
                index: 0,
                clipId: 'clip-a',
                trackId: 'video-track-1',
                startTime: 0,
                endTime: 5,
                text: 'Opening scene',
                mediaFile: 'scene-a.mp4',
                framing: 'cinematic',
                scale: 0.75,
            },
            {
                index: 1,
                clipId: 'clip-b',
                trackId: 'video-track-1',
                startTime: 5,
                endTime: 10,
                text: 'Closing scene',
                mediaFile: 'scene-b.mp4',
                framing: 'fullscreen',
                scale: 1,
            },
        ],
        transitions: [{
            fromClipId: 'clip-a',
            toClipId: 'clip-b',
            startTime: 5,
            type: 'crossfade',
            duration: 0.5,
        }],
        motionGraphics: [],
        mgScenes: [],
        templateScenes: [],
        overlayScenes: [],
        sfxClips: [],
    };
}

function clipScope() {
    return {
        kind: 'clips',
        label: '1 selected clip',
        fromSec: 0,
        toSec: 5,
        currentTime: 2,
        totalDuration: 10,
        contiguous: true,
        clipRefs: [{
            clipId: 'clip-a',
            sourceSceneIndex: 0,
            trackId: 'video-track-1',
            startTime: 0,
            endTime: 5,
        }],
        visualRefs: [],
    };
}

async function verifyPersistentSessionAndFollowUps() {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-agent-session-'));
    try {
        const first = sessionStore.loadSession(projectDir);
        assert.ok(first.id);
        assert.deepStrictEqual(first.turns, []);

        sessionStore.recordExchange(projectDir, {
            originalRequest: 'Make this transition smoother',
            resolvedRequest: 'Make this transition smoother',
            effort: 'smart',
            scope: clipScope(),
            result: {
                kind: 'edit',
                executable: true,
                summary: 'Smooth the selected transition',
                effort: 'smart',
                scope: clipScope(),
                capabilityIds: ['transitions'],
                operations: [{
                    capabilityId: 'transitions',
                    specialist: 'Transition Editor',
                    action: 'edit-transition',
                    description: 'smooth the selected transition',
                }],
            },
        });
        sessionStore.recordExecution(projectDir, {
            request: 'Make this transition smoother',
            resolvedRequest: 'Make this transition smoother',
            effort: 'smart',
            summary: 'Smoothed the selected transition',
            scope: clipScope(),
            capabilityIds: ['transitions'],
            operations: [{
                capabilityId: 'transitions',
                specialist: 'Transition Editor',
                action: 'edit-transition',
                description: 'smooth the selected transition',
            }],
            transactionId: 'transaction-1',
        });

        const loaded = sessionStore.loadSession(projectDir);
        assert.strictEqual(loaded.id, first.id);
        assert.strictEqual(loaded.turns.length, 3);
        assert.strictEqual(loaded.context.lastExecution.capabilityIds[0], 'transitions');

        const resolved = resolveContextualPayload({
            text: 'make it shorter',
            effort: 'fast',
            scope: { kind: 'project', label: 'Whole project' },
        }, loaded, fixturePlan());
        assert.strictEqual(resolved.contextResolution.applied, true);
        assert.strictEqual(resolved.contextResolution.inheritedScope, true);
        assert.strictEqual(resolved.scope.kind, 'clips');
        assert.strictEqual(resolved.scope.clipRefs[0].clipId, 'clip-a');
        assert.match(resolved.text, /previously discussed transition/i);

        const explicitNewDomain = resolveContextualPayload({
            text: 'Remove the grain from this selection',
            effort: 'fast',
            scope: clipScope(),
        }, loaded, fixturePlan());
        assert.strictEqual(explicitNewDomain.contextResolution.applied, false);
        assert.strictEqual(explicitNewDomain.text, 'Remove the grain from this selection');

        const explicitSameDomain = resolveContextualPayload({
            text: 'Use hard cuts for this selection',
            effort: 'fast',
            scope: clipScope(),
        }, loaded, fixturePlan());
        assert.strictEqual(explicitSameDomain.contextResolution.applied, false);
        assert.strictEqual(explicitSameDomain.text, 'Use hard cuts for this selection');

        const explicitMultiDomain = resolveContextualPayload({
            text: 'give it a scratch effect and make the headline without background in a white color and give it a typewriter animation',
            effort: 'smart',
            scope: {
                ...clipScope(),
                scopeMode: 'scene',
                visualRefs: [{
                    id: 'headline-1',
                    type: 'headline',
                    startTime: 0.5,
                    endTime: 3,
                    label: 'Opening headline',
                }],
            },
        }, {
            context: {
                lastExecution: {
                    summary: 'Changed the vignette color to black',
                    capabilityIds: ['effects'],
                    scope: clipScope(),
                },
            },
        }, fixturePlan());
        assert.strictEqual(explicitMultiDomain.contextResolution.applied, false);
        assert.strictEqual(
            explicitMultiDomain.text,
            'give it a scratch effect and make the headline without background in a white color and give it a typewriter animation',
            'an explicit new graphic domain must not inherit stale effect-only context'
        );

        const typoHeadlineDuration = resolveContextualPayload({
            text: 'edit the duration of the headling make it shorter',
            effort: 'smart',
            scope: {
                ...clipScope(),
                scopeMode: 'scene',
                visualRefs: [{
                    id: 'headline-1',
                    type: 'headline',
                    startTime: 0.5,
                    endTime: 3,
                    label: 'Opening headline',
                }],
            },
        }, {
            context: {
                lastExecution: {
                    summary: 'Replace the selected clip with an Amish house video',
                    capabilityIds: ['media'],
                    scope: clipScope(),
                },
            },
        }, fixturePlan());
        assert.strictEqual(typoHeadlineDuration.contextResolution.applied, false);
        assert.strictEqual(
            typoHeadlineDuration.text,
            'edit the duration of the headling make it shorter',
            'a misspelled headline-duration request must not inherit completed media work'
        );

        const pendingPlan = fixturePlan();
        pendingPlan.templateScenes.push({
            id: 'pending-stat-card',
            clipId: 'pending-stat-card',
            type: 'statCard',
            templateType: true,
            trackId: 'video-track-3',
            startTime: 1,
            endTime: 4,
            duration: 3,
            text: '$300 System',
            style: 'editorial-light',
            variant: 'sideBySide',
            items: [{ value: '$300', label: 'Complete System' }],
        });
        const pendingScope = {
            kind: 'visual',
            scopeMode: 'selection',
            label: '1 selected graphic',
            fromSec: 1,
            toSec: 4,
            currentTime: 2,
            totalDuration: 10,
            contiguous: true,
            clipRefs: [],
            iconRefs: [],
            visualRefs: [{
                id: 'pending-stat-card',
                type: 'statCard',
                collection: 'templateScenes',
                startTime: 1,
                endTime: 4,
                label: '$300 System',
            }],
        };
        const pendingFollowUp = resolveContextualPayload({
            text: 'ok do that',
            effort: 'fast',
            scope: pendingScope,
        }, {
            context: {
                lastExecution: {
                    summary: 'Regenerate the $300 System stat card',
                    capabilityIds: ['graphics'],
                    operations: [{ capabilityId: 'graphics', action: 'regenerate' }],
                    scope: pendingScope,
                    createdAt: '2026-07-25T22:44:38.496Z',
                },
                lastPlan: {
                    summary: 'Restyle the selected statCard in place while preserving its content, timing, and identity',
                    capabilityIds: ['graphics'],
                    operations: [{ capabilityId: 'graphics', action: 'edit-properties' }],
                    scope: pendingScope,
                    createdAt: '2026-07-26T10:21:42.318Z',
                },
            },
        }, pendingPlan);
        assert.strictEqual(pendingFollowUp.contextResolution.source, 'plan');
        assert.match(pendingFollowUp.text, /Previous plan: Restyle the selected statCard in place/i);
        assert.doesNotMatch(pendingFollowUp.text, /Previous result: Regenerate/i);
        const pendingRoute = graphicsCapability.planFast({
            text: pendingFollowUp.text,
            directives: {
                graphics: {
                    action: 'regenerate',
                    requestedType: 'statCard',
                },
            },
            request: {
                ...pendingFollowUp,
                effort: 'fast',
            },
            plan: pendingPlan,
        });
        assert.deepStrictEqual(
            pendingRoute.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-properties']],
            '"ok do that" must execute the newest pending restyle plan, not an older regeneration'
        );

        const history = sessionStore.historyForModel(loaded, 'make it shorter');
        assert.strictEqual(history.at(-1).role, 'user');
        assert.strictEqual(history.at(-1).text, 'make it shorter');

        const second = sessionStore.startSession(projectDir);
        assert.notStrictEqual(second.id, first.id);
        assert.deepStrictEqual(second.turns, []);
        assert.strictEqual(sessionStore.loadSession(projectDir).id, second.id);
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
}

async function verifyAutonomousRecoveryAndIsolation() {
    let recoverCalls = 0;
    const capability = {
        manifest: () => ({
            id: 'test-autonomy',
            specialist: 'Test Recovery Editor',
            description: 'Exercises isolated attempts and specialist recovery.',
            scopes: ['clips'],
            risk: 'low',
            actions: ['fail-first', 'asset-fail', 'fixed', 'leak'],
        }),
        execute: ({ plan, operation, options }) => {
            if (operation.action === 'fail-first') {
                const error = new Error('Temporary specialist failure');
                error.code = 'AGENT_CAPABILITY_TRANSIENT';
                throw error;
            }
            if (operation.action === 'asset-fail') {
                const stage = transactionAssets.createAssetStage({
                    projectDir: options.projectDir,
                    transactionId: options.transactionId,
                });
                const source = path.join(options.projectDir, 'temp', 'orphan-source.jpg');
                fs.mkdirSync(path.dirname(source), { recursive: true });
                fs.writeFileSync(source, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
                transactionAssets.stageDownloadedFile(stage, source, {
                    ext: '.jpg',
                    baseName: 'discarded-attempt',
                });
                return {
                    changed: 0,
                    stats: {},
                    assetManifest: transactionAssets.publicManifest(stage),
                };
            }
            if (operation.action === 'leak') {
                plan.scenes[1].scale = 0.5;
                return { changed: 1, stats: { leakAttempted: 1 } };
            }
            plan.scenes[0].scale = 0.9;
            return { changed: 1, stats: { recoveredEdits: 1 } };
        },
        recover: ({ operation }) => {
            recoverCalls += 1;
            if (!['fail-first', 'asset-fail'].includes(operation.action)) return null;
            return {
                capabilityId: 'test-autonomy',
                specialist: 'Test Recovery Editor',
                action: 'fixed',
                args: {},
                scope: operation.scope,
                risk: 'low',
                description: 'apply the verified fallback edit',
            };
        },
    };

    registry.registerCapability(capability, { source: 'editor-agent-autonomy-test' });
    try {
        const approved = registry.validateOperation({
            capabilityId: 'test-autonomy',
            action: 'fail-first',
            args: {},
            scope: clipScope(),
            risk: 'low',
            description: 'run a recoverable edit',
            operationId: 'op-recovery',
        }, {
            request: { scope: clipScope() },
        });
        const original = fixturePlan();
        const recovered = await runAutonomousOperations(original, [approved], {
            request: 'Run the recoverable edit',
            originalRequest: 'Run the recoverable edit',
            effort: 'fast',
            transactionId: 'test-transaction',
            options: { log: () => { } },
        });
        assert.strictEqual(original.scenes[0].scale, 0.75, 'the input plan must remain untouched');
        assert.strictEqual(recovered.plan.scenes[0].scale, 0.9);
        assert.strictEqual(recovered.plan.scenes[1].scale, 1);
        assert.strictEqual(recovered.recoveries.length, 1);
        assert.strictEqual(recovered.operationResults[0].status, 'completed-after-recovery');
        assert.strictEqual(recovered.operationResults[0].attempts.length, 2);
        assert.strictEqual(recovered.stats.recoveredEdits, 1);

        const cleanupProject = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-agent-recovery-assets-'));
        try {
            const assetFailure = registry.validateOperation({
                capabilityId: 'test-autonomy',
                action: 'asset-fail',
                args: {},
                scope: clipScope(),
                risk: 'low',
                description: 'discard an unverified staged asset',
                operationId: 'op-asset-cleanup',
            }, {
                request: { scope: clipScope() },
            });
            const cleaned = await runAutonomousOperations(fixturePlan(), [assetFailure], {
                request: 'Recover without keeping the failed asset',
                originalRequest: 'Recover without keeping the failed asset',
                effort: 'fast',
                transactionId: 'asset-cleanup-test',
                options: {
                    projectDir: cleanupProject,
                    log: () => { },
                },
            });
            assert.strictEqual(cleaned.plan.scenes[0].scale, 0.9);
            assert.strictEqual(cleaned.assetManifest, null);
            assert.strictEqual(
                fs.existsSync(path.join(cleanupProject, 'temp', 'agent-staging', 'asset-cleanup-test')),
                false,
                'discarded recovery assets must not leave a staging directory'
            );
        } finally {
            fs.rmSync(cleanupProject, { recursive: true, force: true });
        }

        const leaking = registry.validateOperation({
            capabilityId: 'test-autonomy',
            action: 'leak',
            args: {},
            scope: clipScope(),
            risk: 'low',
            description: 'attempt an out-of-scope mutation',
            operationId: 'op-leak',
        }, {
            request: { scope: clipScope() },
        });
        const beforeLeak = fixturePlan();
        const recoverCallsBeforeLeak = recoverCalls;
        await assert.rejects(
            () => runAutonomousOperations(beforeLeak, [leaking], {
                request: 'Leak outside the scope',
                originalRequest: 'Leak outside the scope',
                effort: 'smart',
                transactionId: 'test-leak',
                options: {
                    log: () => { },
                    routeRecoveryRequest: async () => {
                        throw new Error('Scope leaks must never reach recovery routing');
                    },
                },
            }),
            (error) => error.code === 'AGENT_OPERATION_SCOPE_LEAK'
        );
        assert.deepStrictEqual(beforeLeak, fixturePlan(), 'a rejected attempt must not mutate the input plan');
        assert.strictEqual(recoverCalls, recoverCallsBeforeLeak, 'scope leaks must not invoke recovery');
    } finally {
        registry.unregisterCapability('test-autonomy');
    }
}

async function run() {
    await verifyPersistentSessionAndFollowUps();
    await verifyAutonomousRecoveryAndIsolation();

    const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
    const preloadSource = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
    const panelSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'ui', 'js', 'editor-agent-panel.js'),
        'utf8'
    );
    assert.ok(mainSource.includes("ipcMain.handle('agent-session'"));
    assert.ok(mainSource.includes("ipcMain.handle('agent-new-session'"));
    assert.ok(preloadSource.includes('agentSession'));
    assert.ok(preloadSource.includes('agentNewSession'));
    assert.ok(panelSource.includes('Recovered automatically'));
    assert.ok(panelSource.includes('syncSession'));

    console.log('Editor Agent autonomy and persistent-memory checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
