#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const supervisor = require('../../src/agents/editor-supervisor');
const {
    planWithConflictRetry,
} = require('../../ui/js/editor-agent-request-retry');

function hash(plan) {
    return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function fixturePlan() {
    return {
        fps: 30,
        totalDuration: 8,
        scenes: [{
            index: 0,
            sourceSceneIndex: 0,
            clipId: 'selected-amish-scene',
            trackId: 'video-track-1',
            startTime: 0,
            endTime: 8,
            framing: 'cinematic',
            framingMode: 'cinematic',
            fitMode: 'contain',
            scale: 0.55,
            posX: 0,
            posY: 0,
            background: 'blur',
        }],
        transitions: [],
        motionGraphics: [],
        mgScenes: [],
        templateScenes: [],
        overlayScenes: [],
        sfxClips: [],
    };
}

async function main() {
    const plan = fixturePlan();
    const canonicalVersion = {
        revision: 71,
        planHash: hash(plan),
    };
    const selectedScope = {
        kind: 'clips',
        scopeMode: 'selection',
        label: '1 selected clip',
        fromSec: 0,
        toSec: 8,
        currentTime: 2.33,
        totalDuration: 8,
        contiguous: true,
        clipRefs: [{
            clipId: 'selected-amish-scene',
            sourceSceneIndex: 0,
            trackId: 'video-track-1',
            startTime: 0,
            endTime: 8,
        }],
        visualRefs: [],
        iconRefs: [],
    };
    const calls = [];
    const conflicts = [];

    const proposal = await planWithConflictRetry({
        payload: {
            text: 'make that scene fullscreen',
            effort: 'fast',
            scope: selectedScope,
            history: [{ role: 'user', text: 'make that scene fullscreen' }],
            visualContext: null,
        },
        getVersion: () => ({ revision: 70, planHash: 'stale-plan-hash' }),
        onConflict: (info) => conflicts.push(info),
        invoke: async (payload) => {
            calls.push(payload);
            if (payload.projectRevision !== canonicalVersion.revision
                || payload.planHash !== canonicalVersion.planHash) {
                return {
                    success: false,
                    conflict: true,
                    retryable: true,
                    code: 'AGENT_PLAN_VERSION_CONFLICT',
                    revision: canonicalVersion.revision,
                    planHash: canonicalVersion.planHash,
                    error: 'The project changed.',
                };
            }
            const result = await supervisor.planRequest(payload, {
                plan,
                revision: canonicalVersion.revision,
                planHash: canonicalVersion.planHash,
            });
            return {
                success: true,
                ...result,
                revision: canonicalVersion.revision,
                planHash: canonicalVersion.planHash,
            };
        },
    });

    assert.strictEqual(calls.length, 2, 'one version conflict should trigger exactly one automatic retry');
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(calls[0].projectRevision, 70);
    assert.strictEqual(calls[1].projectRevision, 71);
    assert.strictEqual(calls[1].planHash, canonicalVersion.planHash);
    assert.deepStrictEqual(calls[1].scope, selectedScope, 'retry must preserve the exact selected clip');
    assert.strictEqual(proposal.success, true);
    assert.strictEqual(proposal.conflictRetries, 1);
    assert.strictEqual(proposal.kind, 'edit');
    assert.strictEqual(proposal.executable, true);

    const execution = await supervisor.executePlanned(proposal.planId, {
        plan,
        revision: canonicalVersion.revision,
        planHash: canonicalVersion.planHash,
    }, { log: () => {} });
    assert.strictEqual(execution.success, true);
    const scene = execution.plan.scenes[0];
    assert.strictEqual(scene.framing, 'fullscreen');
    assert.strictEqual(scene.framingMode, 'fullscreen');
    assert.strictEqual(scene.fitMode, 'cover');
    assert.strictEqual(scene.scale, 1);
    assert.strictEqual(scene.background, 'none');

    const rebasePlan = fixturePlan();
    const rebaseBaseVersion = {
        revision: 80,
        planHash: hash(rebasePlan),
    };
    const rebaseProposal = await supervisor.planRequest({
        text: 'make that scene fullscreen',
        effort: 'fast',
        scope: selectedScope,
        projectRevision: rebaseBaseVersion.revision,
        planHash: rebaseBaseVersion.planHash,
    }, {
        plan: rebasePlan,
        revision: rebaseBaseVersion.revision,
        planHash: rebaseBaseVersion.planHash,
    });
    const refreshedPlan = JSON.parse(JSON.stringify(rebasePlan));
    refreshedPlan.motionQa = {
        status: 'pass',
        stage: 'preview-preflight',
        repairCount: 0,
    };
    const refreshedVersion = {
        revision: 81,
        planHash: hash(refreshedPlan),
    };
    const rebasedExecution = await supervisor.executePlanned(rebaseProposal.planId, {
        plan: refreshedPlan,
        revision: refreshedVersion.revision,
        planHash: refreshedVersion.planHash,
    }, {
        allowStableScopeRebase: true,
        log: () => {},
    });
    assert.strictEqual(rebasedExecution.success, true);
    assert.deepStrictEqual(rebasedExecution.plan.motionQa, refreshedPlan.motionQa);
    assert.deepStrictEqual(rebasedExecution.versionRebase, {
        fromRevision: rebaseBaseVersion.revision,
        toRevision: refreshedVersion.revision,
        fromPlanHash: rebaseBaseVersion.planHash,
        toPlanHash: refreshedVersion.planHash,
        targetCount: 1,
    });
    assert.strictEqual(rebasedExecution.plan.scenes[0].framing, 'fullscreen');
    assert.strictEqual(rebasedExecution.diff.scopeLeakCount, 0);

    const strictConflictProposal = await supervisor.planRequest({
        text: 'make that scene fullscreen',
        effort: 'fast',
        scope: selectedScope,
        projectRevision: rebaseBaseVersion.revision,
        planHash: rebaseBaseVersion.planHash,
    }, {
        plan: rebasePlan,
        revision: rebaseBaseVersion.revision,
        planHash: rebaseBaseVersion.planHash,
    });
    await assert.rejects(
        () => supervisor.executePlanned(strictConflictProposal.planId, {
            plan: refreshedPlan,
            revision: refreshedVersion.revision,
            planHash: refreshedVersion.planHash,
        }, { log: () => {} }),
        (error) => error?.code === 'AGENT_PLAN_CONFLICT',
        'stable-scope rebase must remain opt-in'
    );

    const missingTargetProposal = await supervisor.planRequest({
        text: 'make that scene fullscreen',
        effort: 'fast',
        scope: selectedScope,
        projectRevision: rebaseBaseVersion.revision,
        planHash: rebaseBaseVersion.planHash,
    }, {
        plan: rebasePlan,
        revision: rebaseBaseVersion.revision,
        planHash: rebaseBaseVersion.planHash,
    });
    const missingTargetPlan = {
        ...JSON.parse(JSON.stringify(refreshedPlan)),
        scenes: [],
    };
    await assert.rejects(
        () => supervisor.executePlanned(missingTargetProposal.planId, {
            plan: missingTargetPlan,
            revision: 82,
            planHash: hash(missingTargetPlan),
        }, {
            allowStableScopeRebase: true,
            log: () => {},
        }),
        (error) => (
            error?.code === 'AGENT_PLAN_CONFLICT'
            && error?.rebaseCheck?.missing?.length === 1
        ),
        'rebase must stop if the selected target disappeared'
    );

    const smartVisualContext = {
        captureRequested: true,
        currentTime: 2.33,
        renderer: 'hyperframes',
        rect: { x: 10, y: 20, width: 960, height: 540 },
    };
    const smartCalls = [];
    const smartResult = await planWithConflictRetry({
        payload: {
            text: 'make that scene fullscreen',
            effort: 'smart',
            scope: selectedScope,
            history: [{ role: 'user', text: 'make that scene fullscreen' }],
            visualContext: smartVisualContext,
        },
        getVersion: () => ({ revision: 70, planHash: 'stale-plan-hash' }),
        invoke: async (payload) => {
            smartCalls.push(payload);
            if (smartCalls.length === 1) {
                return {
                    success: false,
                    conflict: true,
                    retryable: true,
                    revision: canonicalVersion.revision,
                    planHash: canonicalVersion.planHash,
                };
            }
            return { success: true, kind: 'edit', executable: true, planId: 'smart-plan-ok' };
        },
    });
    assert.strictEqual(smartResult.success, true);
    assert.strictEqual(smartCalls.length, 2);
    assert.deepStrictEqual(
        smartCalls[1].visualContext,
        smartVisualContext,
        'Smart retry must preserve the captured playhead frame'
    );
    assert.deepStrictEqual(smartCalls[1].scope, selectedScope);

    const indexSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ui', 'index.html'), 'utf8');
    const panelSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ui', 'js', 'editor-agent-panel.js'), 'utf8');
    const mainSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'main.js'), 'utf8');
    assert.ok(
        indexSource.indexOf('editor-agent-request-retry.js') < indexSource.indexOf('editor-agent-panel.js'),
        'retry helper must load before the Agent panel'
    );
    assert.ok(panelSource.includes('scopeAtSubmit'), 'Agent retry must freeze the selected scope');
    assert.ok(
        panelSource.indexOf('getVisualContext') < panelSource.indexOf('getVersion:'),
        'project version must be sampled after the visual frame is captured'
    );
    assert.ok(mainSource.includes("code: 'AGENT_PLAN_VERSION_CONFLICT'"));
    assert.ok(mainSource.includes('retryable: true'));
    assert.ok(mainSource.includes('allowStableScopeRebase: true'));

    console.log('✅ Editor Agent project-refresh retry, safe apply rebase, and fullscreen execution passed');
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
