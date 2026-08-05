'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const supervisor = require('../../src/agents/editor-supervisor');
const history = require('../../src/agents/editor-supervisor/history-store');
const transactionAssets = require('../../src/agents/editor-supervisor/transaction-assets');
const { normalizeAgentRequest } = require('../../src/agents/editor-supervisor/schemas');
const capabilityRegistry = require('../../src/agents/editor-supervisor/capabilities/registry');
const {
    object: contractObject,
    string: contractString,
    tool: contractTool,
} = require('../../src/agents/editor-supervisor/capabilities/capability-contract');
const { coerceSmartPlan } = require('../../src/agents/editor-supervisor/capabilities/smart-router');
const { planStagedOperations } = require('../../src/agents/editor-supervisor/operation-planner');
const { summarizePlanDiff } = require('../../src/agents/editor-supervisor/plan-diff');
const {
    activeLayerInventory,
    groundVisualRequest,
    shouldGroundVisualRequest,
} = require('../../src/agents/editor-supervisor/visual-grounding');
const { EFFECT_CATEGORIES } = require('../../src/agents/editor-supervisor/workers/effects-editor');
const {
    EFFECT_IDS,
    GRADE_IDS,
    recipeFromScene,
    mergeBaseLook,
} = require('../../src/render/hf-effects');
const { MG_REGISTRY } = require('../../src/render/mg-registry');
const { STYLE_NAMES } = require('../../src/agents/ai-motion-graphics');
const { TEMPLATE_TYPES } = require('../../src/agents/ai-templates');
const {
    regenerateScopedGraphics,
} = require('../../src/agents/editor-supervisor/workers/graphics-editor');
const { DEFAULT_DURATIONS } = require('../../src/agents/editor-supervisor/workers/transition-editor');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function hash(plan) {
    return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function timedWords(text, startTime, endTime) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const step = (endTime - startTime) / Math.max(1, words.length);
    return words.map((word, index) => ({
        word,
        start: startTime + step * index,
        end: Math.min(endTime, startTime + step * (index + 0.72)),
    }));
}

function fixturePlan() {
    const texts = [
        'The opening establishes the underground tunnel and its hidden engineering problem.',
        'This three hundred dollar cooling system changed how the entire home stayed comfortable.',
        'The final chapter compares the old method with the modern efficient alternative.',
    ];
    return {
        totalDuration: 15,
        fps: 30,
        scriptContext: {
            themeId: 'modern',
            nicheId: 'explainer.history',
        },
        _hfBaseLook: {
            grade: 'warm-film',
            texture: [
                { id: 'grain', intensity: 0.12 },
                { id: 'dust', intensity: 0.06 },
            ],
        },
        scenes: [
            {
                index: 0,
                clipId: 'clip-a',
                startTime: 0,
                endTime: 5,
                text: texts[0],
                keyword: 'underground tunnel engineering',
                words: timedWords(texts[0], 0, 5),
                mediaFile: 'scene-0.mp4',
                framing: 'fullscreen',
                framingMode: 'fullscreen',
                fitMode: 'cover',
                scale: 1,
                transition: { type: 'crossfade', duration: 0.4 },
                transitionType: 'crossfade',
                effects: ['grain', 'vignette'],
                effectOverrides: { grain: { enabled: true, intensity: 0.2 } },
                _effectRecipe: [{ id: 'grain', intensity: 0.2 }, { id: 'vignette', intensity: 0.2 }],
                _iconMoments: [{
                    at: 1,
                    dur: 1,
                    kind: 'svg',
                    concept: 'Tunnel engineering',
                    position: 'top-right',
                }],
            },
            {
                index: 1,
                clipId: 'clip-b',
                startTime: 5,
                endTime: 10,
                text: texts[1],
                keyword: 'home cooling system',
                words: timedWords(texts[1], 5, 10),
                mediaFile: 'scene-1.mp4',
                framing: 'cinematic',
                framingMode: 'cinematic',
                fitMode: 'contain',
                scale: 0.75,
                posX: 8,
                posY: -4,
                background: 'blur',
                backgroundId: 'blur',
                borderRadius: 4,
                shadow: 0.5,
                transition: { type: 'wipe-left', duration: 0.4 },
                transitionType: 'wipe-left',
                effects: ['grain', 'dust', 'vignette'],
                effectOverrides: {
                    grain: { enabled: true, intensity: 0.2 },
                    dust: { enabled: true, intensity: 0.1 },
                },
                _effectRecipe: [
                    { id: 'grain', intensity: 0.2 },
                    { id: 'dust', intensity: 0.1 },
                    { id: 'vignette', intensity: 0.2 },
                ],
                _iconMoments: [{
                    at: 1,
                    dur: 1,
                    kind: 'svg',
                    concept: 'Cooling system',
                    position: 'top-right',
                }],
                fullscreenMG: 'mapChart: Test map',
                templateHint: 'statCard: Test stat',
            },
            {
                index: 2,
                clipId: 'clip-c',
                startTime: 10,
                endTime: 15,
                text: texts[2],
                keyword: 'old method modern alternative',
                words: timedWords(texts[2], 10, 15),
                mediaFile: 'scene-2.mp4',
                framing: 'floating',
                framingMode: 'floating',
                fitMode: 'cover',
                scale: 0.5,
                background: 'blur',
                borderRadius: 4,
                shadow: 0.5,
                transition: { type: 'whip-left', duration: 0.5 },
                transitionType: 'whip-left',
                effects: ['grain'],
                _effectRecipe: [{ id: 'grain', intensity: 0.1 }],
            },
        ],
        transitions: [
            {
                fromClipId: 'clip-a',
                toClipId: 'clip-b',
                fromSceneIndex: 0,
                toSceneIndex: 1,
                startTime: 5,
                type: 'wipe-left',
                duration: 0.5,
            },
            {
                fromClipId: 'clip-b',
                toClipId: 'clip-c',
                fromSceneIndex: 1,
                toSceneIndex: 2,
                startTime: 10,
                type: 'whip-left',
                duration: 0.5,
            },
        ],
        mgScenes: [
            { id: 'map-1', type: 'mapChart', sceneIndex: 1, startTime: 5, duration: 3 },
            { id: 'stat-1', type: 'statCard', sceneIndex: 1, startTime: 7, duration: 2 },
            { id: 'fact-1', type: 'factCard', sceneIndex: 0, startTime: 2, duration: 2 },
            { id: 'chapter-1', type: 'chapterCard', sceneIndex: 2, startTime: 12, duration: 2 },
        ],
        templateScenes: [
            { id: 'stat-template-1', type: 'statCard', templateType: 'statCard', sceneIndex: 1, startTime: 7, duration: 2 },
            { id: 'quote-template-1', type: 'quoteCard', templateType: 'quoteCard', sceneIndex: 2, startTime: 10, duration: 2 },
        ],
        motionGraphics: [
            {
                id: 'lower-1',
                type: 'lowerThird',
                sceneIndex: 0,
                sourceSceneIndex: 0,
                startTime: 1,
                duration: 2,
                text: 'This $300 system cools any home to 55 degrees',
                subtext: 'System Cost',
                position: 'bottom-left',
                style: 'editorial-light',
                subType: 'box',
                animation: 'wipeRight',
                overlayShadowStrength: 0.55,
                colors: {
                    primary: '#bc641c',
                    accent: '#f5ead6',
                    background: 'rgba(245,234,214,0.82)',
                },
                agenticComposition: {
                    layout: 'lower-third',
                    safeZone: 'bottom-left',
                    title: 'This $300 system cools any home to 55 degrees',
                    subtitle: 'System Cost',
                    style: { mood: 'warm editorial', glass: false },
                    motion: { entrance: 'wipeRight', speed: 'normal' },
                },
                mgData: {
                    text: 'This $300 system cools any home to 55 degrees',
                    subtext: 'System Cost',
                    style: 'editorial-light',
                    subType: 'box',
                },
            },
            { id: 'callout-1', type: 'callout', sceneIndex: 2, startTime: 11, duration: 2 },
            {
                id: 'headline-1',
                type: 'headline',
                sceneIndex: 1,
                sourceSceneIndex: 1,
                startTime: 6,
                duration: 2,
                text: 'The hidden engineering breakthrough',
                subtext: 'Cooling system',
                position: 'center',
                style: 'editorial-light',
                subType: 'standard',
                animation: 'springScale',
                overlayShadowStrength: 0.55,
                colors: {
                    primary: '#bc641c',
                    accent: '#f5ead6',
                    text: '#1f2937',
                    background: 'rgba(245,234,214,0.82)',
                },
                agenticComposition: {
                    layout: 'center-stack',
                    safeZone: 'center',
                    title: 'The hidden engineering breakthrough',
                    subtitle: 'Cooling system',
                    style: { mood: 'warm editorial', glass: false },
                    motion: { entrance: 'springScale', speed: 1 },
                },
                mgData: {
                    text: 'The hidden engineering breakthrough',
                    subtext: 'Cooling system',
                    style: 'editorial-light',
                    subType: 'standard',
                    animation: 'springScale',
                },
            },
        ],
    };
}

function clipScope(index = 1) {
    const starts = [0, 5, 10];
    return {
        kind: 'clips',
        label: '1 selected clip',
        clipRefs: [{
            clipId: ['clip-a', 'clip-b', 'clip-c'][index],
            sourceSceneIndex: index,
            startTime: starts[index],
            endTime: starts[index] + 5,
        }],
    };
}

function wholeSceneScope(index = 1) {
    const scope = clipScope(index);
    const clipId = scope.clipRefs[0].clipId;
    const visuals = [
        { id: 'lower-1', type: 'lowerThird', startTime: 1, endTime: 3, label: 'This $300 system' },
        { id: 'headline-1', type: 'headline', startTime: 6, endTime: 8, label: 'Cooling system headline' },
        { id: 'callout-1', type: 'callout', startTime: 11, endTime: 13, label: 'Modern alternative' },
    ];
    return {
        ...scope,
        scopeMode: 'scene',
        label: 'Whole scene · 1 clip · 1 graphic · 1 icon',
        visualRefs: [visuals[index]],
        iconRefs: [{
            id: `${clipId}:icon:0`,
            clipId,
            sourceSceneIndex: index,
            sceneIndex: index,
            momentIndex: 0,
            kind: 'svg',
            label: 'Scene icon',
            position: 'top-right',
            startTime: scope.clipRefs[0].startTime + 1,
            endTime: scope.clipRefs[0].startTime + 2,
        }],
    };
}

function effectiveRecipe(plan, index = 1) {
    return mergeBaseLook(recipeFromScene(plan.scenes[index]), plan._hfBaseLook);
}

function graphicDesignSnapshot(graphic) {
    const copy = clone(graphic);
    const strip = (target) => {
        if (!target || typeof target !== 'object') return;
        for (const key of [
            'text', 'title', 'headline', 'label', 'templateText', 'templateTitle',
            'subtext', 'subText', 'subtitle', 'caption', 'description',
            'templateSubtext', 'templateSubtitle', 'visualIntent',
            'authoredCompositionMode', 'authoredCompositionReason',
            '_authoredComposition', '_authoredAssets', '_authoredNs', '_authoredRendered',
        ]) delete target[key];
        if (target.agenticComposition) {
            delete target.agenticComposition.title;
            delete target.agenticComposition.subtitle;
            delete target.agenticComposition.kicker;
            delete target.agenticComposition.items;
        }
    };
    strip(copy);
    strip(copy.mgData);
    return copy;
}

function graphicStyleInvariantSnapshot(graphic) {
    const copy = clone(graphic);
    delete copy.textStyleRanges;
    delete copy.authoredCompositionMode;
    delete copy.authoredCompositionReason;
    delete copy._authoredComposition;
    delete copy._authoredAssets;
    delete copy._authoredNs;
    delete copy._authoredRendered;
    if (copy.mgData) {
        delete copy.mgData.textStyleRanges;
        delete copy.mgData.authoredCompositionMode;
        delete copy.mgData.authoredCompositionReason;
        delete copy.mgData._authoredComposition;
        delete copy.mgData._authoredAssets;
        delete copy.mgData._authoredNs;
        delete copy.mgData._authoredRendered;
    }
    return copy;
}

async function propose(text, plan, scope = clipScope(), effort = 'fast') {
    const planHash = hash(plan);
    return supervisor.planRequest({
        text,
        effort,
        scope,
        projectRevision: 7,
        planHash,
    }, {
        plan,
        revision: 7,
        planHash,
    });
}

async function execute(text, plan, scope = clipScope(), effort = 'fast', options = {}) {
    const planHash = hash(plan);
    const proposal = await supervisor.planRequest({
        text,
        effort,
        scope,
        projectRevision: 7,
        planHash,
    }, {
        plan,
        revision: 7,
        planHash,
    });
    assert.strictEqual(proposal.kind, 'edit', `${text}: should route as an edit`);
    assert.strictEqual(proposal.executable, true, `${text}: should be executable (${proposal.unsupported || []})`);
    const result = await supervisor.executePlanned(proposal.planId, {
        plan,
        revision: 7,
        planHash,
    }, { log: () => { }, ...options });
    assert.strictEqual(result.success, true, `${text}: execution should succeed`);
    return { proposal, result };
}

async function run() {
    const normalized = normalizeAgentRequest({
        text: '  Use hard cuts  ',
        effort: 'invalid',
        scope: wholeSceneScope(),
    });
    assert.strictEqual(normalized.text, 'Use hard cuts');
    assert.strictEqual(normalized.effort, 'fast');
    assert.strictEqual(normalized.scope.kind, 'clips');
    assert.strictEqual(normalized.scope.scopeMode, 'scene');
    assert.strictEqual(normalized.scope.fromSec, 5);
    assert.strictEqual(normalized.scope.toSec, 10);
    assert.strictEqual(normalized.scope.iconRefs[0].id, 'clip-b:icon:0');

    console.log('[Agent Matrix] exact-playhead visual grounding');
    {
        const plan = fixturePlan();
        const request = normalizeAgentRequest({
            text: 'remove that brown bar',
            originalText: 'remove that brown bar',
            effort: 'smart',
            scope: {
                ...wholeSceneScope(1),
                currentTime: 7,
                totalDuration: 15,
            },
            visualContext: {
                captured: true,
                imageBase64: 'AA==',
                mimeType: 'image/jpeg',
                currentTime: 7,
                renderer: 'hyperframes',
                width: 960,
                height: 540,
            },
        });
        assert.strictEqual(shouldGroundVisualRequest(request), true);
        const inventory = activeLayerInventory(plan, request);
        assert.ok(inventory.layers.some((layer) => (
            layer.id === 'headline-1'
            && layer.editableParts.includes('accent-rule')
        )));
        const grounding = await groundVisualRequest(request, plan, {
            callVisionAI: async () => JSON.stringify({
                summary: 'The brown vertical bar is the decorative accent rule beside the headline.',
                confidence: 0.96,
                target: {
                    id: 'headline-1',
                    kind: 'graphic',
                    type: 'headline',
                    semanticPart: 'accent-rule',
                    visibleDescription: 'thin brown vertical rail to the left of the white headline',
                },
                invocation: {
                    capabilityId: 'graphics',
                    action: 'edit-properties',
                    args: {
                        targetType: 'headline',
                        targetIds: ['headline-1'],
                        accentRuleVisible: false,
                    },
                    description: 'remove only the headline decorative accent rule',
                },
            }),
        });
        assert.strictEqual(grounding.status, 'grounded');
        assert.strictEqual(grounding.target.id, 'headline-1');
        assert.strictEqual(grounding.target.semanticPart, 'accent-rule');
        assert.strictEqual(grounding.invocation.args.accentRuleVisible, false);
        const staged = await planStagedOperations({}, request, plan, {
            visualGrounding: grounding,
            routeSmartRequest: async () => ({
                summary: '',
                operations: [],
                supported: [],
                unsupported: [],
                claimedDirectiveKeys: [],
            }),
        });
        assert.strictEqual(staged.operations.length, 1, JSON.stringify(staged.operations));
        assert.strictEqual(staged.operations[0].capabilityId, 'graphics');
        assert.strictEqual(staged.operations[0].args.targetIds[0], 'headline-1');
        assert.strictEqual(staged.operations[0].args.accentRuleVisible, false);

        const iconRequest = normalizeAgentRequest({
            text: 'remove that icon in the top right',
            originalText: 'remove that icon in the top right',
            effort: 'smart',
            scope: {
                ...wholeSceneScope(1),
                currentTime: 6.5,
                totalDuration: 15,
            },
            visualContext: {
                captured: true,
                imageBase64: 'AA==',
                mimeType: 'image/jpeg',
                currentTime: 6.5,
                renderer: 'hyperframes',
                width: 960,
                height: 540,
            },
        });
        const iconGrounding = await groundVisualRequest(iconRequest, plan, {
            callVisionAI: async () => JSON.stringify({
                summary: 'The user means the explainer icon in the top-right corner.',
                confidence: 0.97,
                target: {
                    id: 'clip-b:icon:0',
                    kind: 'icon',
                    type: 'svg',
                    semanticPart: 'icon',
                    visibleDescription: 'orange circular icon in the top-right corner',
                },
                invocation: {
                    capabilityId: 'icons',
                    action: 'remove-icons',
                    args: {},
                    description: 'remove only the visible scene icon',
                },
            }),
        });
        assert.strictEqual(iconGrounding.status, 'grounded');
        assert.strictEqual(iconGrounding.invocation.capabilityId, 'icons');
        assert.strictEqual(iconGrounding.invocation.action, 'remove-icons');
        assert.deepStrictEqual(iconGrounding.invocation.args.targetIds, ['clip-b:icon:0']);
    }

    console.log('[Agent Matrix] dynamic capability registry');
    {
        const manifests = capabilityRegistry.listManifests();
        assert.deepStrictEqual(
            manifests.map((manifest) => manifest.id),
            ['audio', 'captions', 'effects', 'framing', 'graphics', 'icons', 'media', 'pacing', 'timeline', 'transitions']
        );
        assert.deepStrictEqual(
            Object.keys(capabilityRegistry.inspectCapabilities(fixturePlan(), clipScope())).sort(),
            ['audio', 'captions', 'effects', 'framing', 'graphics', 'icons', 'media', 'pacing', 'timeline', 'transitions'],
            'every live specialist must expose inspectable state to the supervisor'
        );
        assert.ok(
            manifests.every((manifest) => (
                manifest.contractVersion === 2
                && /^[a-f0-9]{64}$/.test(manifest.contractHash)
                && manifest.tools.length === manifest.actions.length
                && manifest.tools.every((toolSpec) => toolSpec.args?.type === 'object')
            )),
            'every live specialist must publish a versioned machine-readable tool contract'
        );
        const effects = manifests.find((manifest) => manifest.id === 'effects');
        assert.deepStrictEqual(effects.vocabulary.effects, EFFECT_IDS);
        assert.deepStrictEqual(effects.vocabulary.grades, GRADE_IDS);
        assert.ok(effects.actions.includes('edit-look'));
        assert.ok(effects.actions.includes('set-effect-properties'));
        assert.ok(effects.actions.includes('tune-effects'));
        assert.ok(effects.actions.includes('clear-effects'));
        assert.ok(effects.vocabulary.effectParameters.vignette.color);
        assert.ok(effects.vocabulary.effectParameters.fogDrift.color);
        const icons = manifests.find((manifest) => manifest.id === 'icons');
        assert.ok(icons.actions.includes('edit-icon-properties'));
        assert.ok(icons.actions.includes('remove-icons'));
        assert.ok(icons.vocabulary.positions.includes('top-left'));
        const graphics = manifests.find((manifest) => manifest.id === 'graphics');
        assert.ok(graphics.actions.includes('set-duration'));
        assert.ok(graphics.vocabulary.properties.includes('durationSeconds'));
        assert.ok(graphics.vocabulary.properties.includes('durationScale'));
        assert.ok(
            MG_REGISTRY.headline.animations.includes('wordCascade')
                && graphics.vocabulary.animations.includes('wordCascade'),
            'new renderer animations must appear in the Agent vocabulary without router edits'
        );
        assert.ok(
            Object.keys(MG_REGISTRY).every((type) => graphics.vocabulary.types.includes(type)),
            'graphics capability vocabulary must be derived from the live MG registry'
        );
        assert.ok(
            [...TEMPLATE_TYPES].every((type) => graphics.vocabulary.types.includes(type)),
            'graphics capability vocabulary must include every live template type'
        );
        const transitions = manifests.find((manifest) => manifest.id === 'transitions');
        assert.deepStrictEqual(
            [...transitions.vocabulary.types].sort(),
            Object.keys(DEFAULT_DURATIONS).sort(),
            'transition vocabulary must be derived from the worker implementation'
        );
        assert.strictEqual(
            capabilityRegistry.inspectCapabilities(fixturePlan(), wholeSceneScope()).icons.targetCount,
            1
        );
        const routed = coerceSmartPlan({
            summary: 'Add atmospheric fog',
            invocations: [{
                capabilityId: 'effects',
                action: 'add-effects',
                args: { effects: [{ id: 'fogDrift', intensity: 0.2 }] },
                description: 'add atmospheric fog',
            }],
        }, {
            request: { text: 'Add atmospheric fog', scope: clipScope(), effort: 'smart' },
            plan: fixturePlan(),
            existingOperations: [],
            log: () => { },
        });
        assert.strictEqual(routed.operations.length, 1);
        assert.strictEqual(routed.operations[0].capabilityId, 'effects');
        assert.strictEqual(routed.operations[0].args.add[0].id, 'fogDrift');

        const dynamicCapability = {
            tools: () => [
                contractTool(
                    'set-runtime-marker',
                    'Set a test marker through a runtime-discovered capability.',
                    contractObject({
                        value: contractString({ minLength: 1, maxLength: 40 }),
                    }, { required: ['value'] })
                ),
            ],
            manifest: () => ({
                contractVersion: 2,
                id: 'runtime-contract-test',
                specialist: 'Runtime Contract Test',
                domain: 'test',
                description: 'Proves capabilities are registered without router changes.',
                scopes: ['clips'],
                risk: 'low',
                directiveKeys: [],
            }),
            normalizeInvocation: (invocation, context) => ({
                capabilityId: 'runtime-contract-test',
                specialist: 'Runtime Contract Test',
                action: 'set-runtime-marker',
                args: { value: invocation.args.value },
                scope: context.request.scope,
                risk: 'low',
                description: 'set runtime marker',
            }),
            execute: ({ plan, operation }) => {
                plan._runtimeContractMarker = operation.args.value;
                return { changed: 1, stats: { runtimeContractChanged: 1 } };
            },
            inspect: (plan) => ({
                targetCount: plan?._runtimeContractMarker ? 1 : 0,
                value: plan?._runtimeContractMarker || '',
            }),
        };
        capabilityRegistry.registerCapability(dynamicCapability, { source: 'editor-agent contract test' });
        try {
            const dynamicManifest = capabilityRegistry.getCapability('runtime-contract-test').manifest;
            assert.deepStrictEqual(dynamicManifest.actions, ['set-runtime-marker']);
            const dynamicRoute = coerceSmartPlan({
                summary: 'Set the runtime marker',
                invocations: [{
                    capabilityId: 'runtime-contract-test',
                    action: 'set-runtime-marker',
                    args: { value: 'discovered' },
                }],
            }, {
                request: { text: 'Set the runtime marker', scope: clipScope(), effort: 'smart' },
                plan: fixturePlan(),
                existingOperations: [],
                log: () => { },
            });
            assert.strictEqual(dynamicRoute.operations.length, 1);
            const dynamicPlan = fixturePlan();
            const dynamicResult = await capabilityRegistry.executeCapabilityOperation(
                dynamicPlan,
                dynamicRoute.operations[0]
            );
            assert.strictEqual(dynamicResult.changed, 1);
            assert.strictEqual(dynamicPlan._runtimeContractMarker, 'discovered');
            const rejected = coerceSmartPlan({
                summary: 'Invent an unsupported field',
                invocations: [{
                    capabilityId: 'runtime-contract-test',
                    action: 'set-runtime-marker',
                    args: { value: 'safe', inventedField: true },
                }],
            }, {
                request: { text: 'Set the runtime marker', scope: clipScope(), effort: 'smart' },
                plan: fixturePlan(),
                existingOperations: [],
                log: () => { },
            });
            assert.strictEqual(
                rejected.operations.length,
                0,
                'the shared contract must reject arguments the worker does not advertise'
            );
        } finally {
            capabilityRegistry.unregisterCapability('runtime-contract-test');
        }

        const wordCascadePlan = fixturePlan();
        const wordCascadeResult = await execute(
            'Give the headline a word cascade animation',
            wordCascadePlan,
            wholeSceneScope(1)
        );
        assert.deepStrictEqual(
            wordCascadeResult.proposal.operations.map((operation) => [
                operation.capabilityId,
                operation.action,
            ]),
            [['graphics', 'edit-properties']],
            'a newly registered animation name must route through the generic graphics capability'
        );
        const wordCascadeHeadline = wordCascadeResult.result.plan.motionGraphics.find(
            (graphic) => graphic.id === 'headline-1'
        );
        assert.strictEqual(wordCascadeHeadline.animation, 'wordCascade');
        assert.strictEqual(
            wordCascadeHeadline.agenticComposition.motion.entrance,
            'wordCascade'
        );

        const graphicRoute = coerceSmartPlan({
            summary: 'Keep the lower third design and shorten its copy',
            invocations: [{
                capabilityId: 'graphics',
                action: 'edit-content',
                args: {
                    targetType: 'lowerThird',
                    text: '$300',
                    clearSubtext: true,
                },
                description: 'change only the lower-third copy',
            }],
        }, {
            request: { text: 'Keep only $300', scope: clipScope(0), effort: 'smart' },
            plan: fixturePlan(),
            existingOperations: [],
            log: () => { },
        });
        assert.strictEqual(graphicRoute.operations.length, 1);
        assert.strictEqual(graphicRoute.operations[0].action, 'edit-content');
        assert.strictEqual(graphicRoute.operations[0].exclusiveCapability, true);

        const graphicStyleRoute = coerceSmartPlan({
            summary: 'Recolor only the selected lower-third text',
            invocations: [{
                capabilityId: 'graphics',
                action: 'set-text-color',
                args: {
                    targetType: 'lowerThird',
                    matchText: '50 Years',
                    color: 'red',
                },
                description: 'make only 50 Years red',
            }],
        }, {
            request: {
                text: 'make only 50 Years red',
                scope: {
                    kind: 'visual',
                    label: 'Selected lowerThird',
                    visualRefs: [{
                        id: 'lower-1',
                        type: 'lowerThird',
                        startTime: 1,
                        endTime: 3,
                        label: '50 Years',
                    }],
                },
                effort: 'smart',
            },
            plan: fixturePlan(),
            existingOperations: [],
            log: () => { },
        });
        assert.strictEqual(graphicStyleRoute.operations.length, 1);
        assert.strictEqual(graphicStyleRoute.operations[0].action, 'edit-text-style');
        assert.strictEqual(graphicStyleRoute.operations[0].args.color, '#ef4444');
        assert.strictEqual(graphicStyleRoute.operations[0].exclusiveCapability, true);

        const blockedDuplicate = coerceSmartPlan({
            summary: 'Regenerate it too',
            invocations: [{
                capabilityId: 'graphics',
                action: 'regenerate',
                args: { requestedType: 'lowerThird' },
            }],
        }, {
            request: { text: 'Keep only $300', scope: clipScope(0), effort: 'smart' },
            plan: fixturePlan(),
            existingOperations: graphicRoute.operations,
            log: () => { },
        });
        assert.strictEqual(
            blockedDuplicate.operations.length,
            0,
            'content ownership must block a second graphic regeneration'
        );
        const blockedStyleRegeneration = coerceSmartPlan({
            summary: 'Regenerate it too',
            invocations: [{
                capabilityId: 'graphics',
                action: 'regenerate',
                args: { requestedType: 'lowerThird' },
            }],
        }, {
            request: {
                text: 'change te color of this lower third into red',
                scope: graphicStyleRoute.operations[0].scope,
                effort: 'smart',
            },
            plan: fixturePlan(),
            existingOperations: graphicStyleRoute.operations,
            log: () => { },
        });
        assert.strictEqual(
            blockedStyleRegeneration.operations.length,
            0,
            'style ownership must block destructive graphic regeneration'
        );
        const invalidStatVariant = coerceSmartPlan({
            summary: 'Use a punch stat-card layout',
            invocations: [{
                capabilityId: 'graphics',
                action: 'edit-properties',
                args: {
                    targetType: 'statCard',
                    targetIds: ['stat-template-1'],
                    variant: 'punch',
                },
            }],
        }, {
            request: {
                text: 'Use a punch layout for this stat card',
                scope: {
                    kind: 'visual',
                    label: 'Selected stat card',
                    visualRefs: [{
                        id: 'stat-template-1',
                        type: 'statCard',
                        startTime: 7,
                        endTime: 9,
                    }],
                },
                effort: 'smart',
            },
            plan: fixturePlan(),
            existingOperations: [],
            log: () => { },
        });
        assert.strictEqual(
            invalidStatVariant.operations.length,
            0,
            'a variant registered for another graphic type must not be applied to a stat card'
        );

        const pendingRequest = {
            text: 'edit the lower third to keep only the 300$',
            scope: {
                kind: 'visual',
                label: 'Selected lowerThird',
                visualRefs: [{ id: 'lower-1', type: 'lowerThird', startTime: 1, endTime: 3 }],
            },
            effort: 'smart',
        };
        const pendingPlan = await planStagedOperations({}, pendingRequest, fixturePlan(), {
            log: () => { },
            routeSmartRequest: async () => ({
                summary: "No new edits needed — the lower third text update to keep only '$300' is already queued.",
                operations: [],
                supported: [],
                unsupported: [],
                claimedDirectiveKeys: [],
            }),
        });
        assert.ok(pendingPlan.operations.some((operation) => operation.action === 'edit-content'));
        assert.strictEqual(
            pendingPlan.summary,
            pendingRequest.text,
            'a pending operation must reject AI wording that claims it is already queued or unnecessary'
        );

        const rejected = coerceSmartPlan({
            summary: 'unsafe invented operation',
            invocations: [{
                capabilityId: 'shell',
                action: 'run-command',
                args: { command: 'anything' },
            }],
        }, {
            request: { text: 'unsafe', scope: clipScope(), effort: 'smart' },
            plan: fixturePlan(),
            existingOperations: [],
            log: () => { },
        });
        assert.strictEqual(rejected.operations.length, 0);
        assert.strictEqual(rejected.unsupported.length, 1);

        const supervisorSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'agents', 'editor-supervisor', 'index.js'),
            'utf8'
        );
        assert.ok(!/operation\.worker|worker\s*===/.test(supervisorSource), 'Supervisor must not hard-code specialist dispatch');
        assert.ok(supervisorSource.includes('executeCapabilityOperation'));
    }

    console.log('[Agent Matrix] selected clip actions');
    {
        const plan = fixturePlan();
        const { result } = await execute('Use hard cuts for this selection', plan);
        assert.strictEqual(result.plan.scenes[1].transition.type, 'cut');
        assert.strictEqual(result.plan.scenes[1].transitionType, 'cut');
        assert.ok(result.plan.transitions.every((item) => item.type === 'cut'), 'both selected-clip boundaries must be hard cuts');
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Make this selection fullscreen', plan);
        const scene = result.plan.scenes[1];
        assert.deepStrictEqual({
            framing: scene.framing,
            framingMode: scene.framingMode,
            fitMode: scene.fitMode,
            scale: scene.scale,
            posX: scene.posX,
            posY: scene.posY,
            background: scene.background,
            backgroundId: scene.backgroundId,
            borderRadius: scene.borderRadius,
            shadow: scene.shadow,
        }, {
            framing: 'fullscreen',
            framingMode: 'fullscreen',
            fitMode: 'cover',
            scale: 1,
            posX: 0,
            posY: 0,
            background: 'none',
            backgroundId: 'none',
            borderRadius: 0,
            shadow: 0,
        });
    }
    {
        const plan = fixturePlan();
        plan.scenes[1].framing = 'fullscreen';
        plan.scenes[1].scale = 1;
        plan.scenes[1].background = 'none';
        const { result } = await execute('Make this selection cinematic', plan);
        const scene = result.plan.scenes[1];
        assert.strictEqual(scene.framing, 'cinematic');
        assert.ok(scene.scale >= 0.7 && scene.scale < 1);
        assert.strictEqual(scene.background, 'blur');
        assert.strictEqual(scene.fitMode, 'cover');
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Make this selection floating', plan);
        const scene = result.plan.scenes[1];
        assert.strictEqual(scene.framing, 'floating');
        assert.ok(scene.scale >= 0.4 && scene.scale <= 0.6);
        assert.strictEqual(scene.borderRadius, 4);
        assert.strictEqual(scene.shadow, 0.5);
        assert.ok(scene.floatingAnim);
    }
    {
        const plan = fixturePlan();
        const { proposal, result } = await execute('Remove film grain from this selection', plan);
        const scene = result.plan.scenes[1];
        assert.strictEqual(proposal.operations[0].specialist, 'Effects Agent');
        assert.ok(!scene.effects.includes('grain'));
        assert.ok(scene.effects.includes('dust'), 'removing grain must not remove other texture effects');
        assert.ok(!scene._effectRecipe.some((entry) => entry.id === 'grain'));
        assert.ok(scene._effectRecipe.some((entry) => entry.id === 'dust'));
        assert.strictEqual(scene.effectOverrides.grain.enabled, false);
        assert.notStrictEqual(scene.effectOverrides.dust.enabled, false);
        const merged = effectiveRecipe(result.plan);
        assert.ok(!merged.some((entry) => entry.id === 'grain'), 'selected grain removal must suppress inherited grain');
        assert.ok(merged.some((entry) => entry.id === 'dust'), 'selected grain removal must preserve inherited dust');
        assert.ok(result.plan._hfBaseLook.texture.length > 0, 'scoped no-grain must not alter other scenes');
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Remove all texture effects from this selection', plan);
        const merged = effectiveRecipe(result.plan);
        assert.ok(!merged.some((entry) => EFFECT_CATEGORIES.texture.includes(entry.id)));
        assert.ok(merged.some((entry) => entry.id === 'vignette'), 'texture cleanup must preserve non-texture edge effects');
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Remove the vignette but keep the grade', plan);
        const merged = effectiveRecipe(result.plan);
        assert.ok(!merged.some((entry) => entry.id === 'vignette'));
        assert.ok(merged.some((entry) => entry.id === 'grain'));
        assert.strictEqual(merged.find((entry) => GRADE_IDS.includes(entry.id)).id, 'warm-film');
    }
    {
        const plan = fixturePlan();
        const { proposal, result } = await execute('Add subtle fog', plan);
        assert.strictEqual(proposal.operations[0].capabilityId, 'effects');
        const fog = effectiveRecipe(result.plan).find((entry) => entry.id === 'fogDrift');
        assert.ok(fog);
        assert.ok(fog.intensity > 0 && fog.intensity < 0.3);
        assert.strictEqual(result.stats.effectScenesChanged, 1);
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Make this cold and threatening', plan);
        const merged = effectiveRecipe(result.plan);
        assert.ok(merged.some((entry) => entry.id === 'fogDrift'));
        assert.ok(merged.some((entry) => entry.id === 'vignette'));
        assert.strictEqual(merged.find((entry) => GRADE_IDS.includes(entry.id)).id, 'cold-steel');
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Give this a damaged 1990s television look', plan);
        const merged = effectiveRecipe(result.plan);
        assert.strictEqual(result.plan.scenes[1].effectPreset, 'vhsGlitch');
        assert.ok(merged.some((entry) => entry.id === 'vhs'));
        assert.ok(merged.some((entry) => entry.id === 'glitchPulse'));
        assert.strictEqual(merged.find((entry) => GRADE_IDS.includes(entry.id)).id, 'vhs-wash');
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Clear all effects but keep the grade', plan);
        const merged = effectiveRecipe(result.plan);
        assert.deepStrictEqual(
            merged.map((entry) => entry.id),
            ['warm-film']
        );
    }
    {
        const plan = fixturePlan();
        const before = plan.scenes[1]._effectRecipe.find((entry) => entry.id === 'vignette').intensity;
        const { result } = await execute('Make the vignette stronger', plan);
        const after = result.plan.scenes[1]._effectRecipe.find((entry) => entry.id === 'vignette').intensity;
        assert.ok(after > before);
        assert.strictEqual(result.stats.effectsTuned, 1);
    }
    {
        const plan = fixturePlan();
        const before = clone(plan.scenes[1]._effectRecipe);
        const { proposal, result } = await execute('I want a black vignette, not white', plan);
        assert.strictEqual(proposal.operations[0].capabilityId, 'effects');
        const after = result.plan.scenes[1]._effectRecipe;
        const vignette = after.find((entry) => entry.id === 'vignette');
        assert.strictEqual(vignette.color, '#000000');
        assert.strictEqual(vignette.userDirected, true);
        assert.strictEqual(vignette.intensity, before.find((entry) => entry.id === 'vignette').intensity);
        assert.deepStrictEqual(
            after.filter((entry) => entry.id !== 'vignette'),
            before.filter((entry) => entry.id !== 'vignette'),
            'changing one effect property must preserve unrelated effects'
        );
        assert.strictEqual(result.stats.effectPropertiesChanged, 1);
    }
    {
        const plan = fixturePlan();
        const vignette = plan.scenes[1]._effectRecipe
            .find((entry) => entry.id === 'vignette');
        vignette.userDirected = true;
        plan.scenes[1].effectOverrides.vignette = {
            enabled: true,
            intensity: vignette.intensity,
            userDirected: true,
        };
        const proposal = await propose('I want a black vignette, not white', plan);
        assert.strictEqual(proposal.kind, 'edit');
        assert.strictEqual(proposal.executable, false);
        assert.strictEqual(proposal.alreadySatisfied, true);
        assert.ok(
            proposal.supported.some((message) => /already match the rendered look/i.test(message)),
            'the Agent should explain that black is already the effective renderer default'
        );
    }
    {
        const plan = fixturePlan();
        plan.scenes[1]._effectRecipe = plan.scenes[1]._effectRecipe
            .filter((entry) => entry.id !== 'vignette');
        plan.scenes[1].effects = plan.scenes[1].effects
            .filter((id) => id !== 'vignette' && id !== 'blurVignette');
        delete plan.scenes[1].effectOverrides.vignette;
        delete plan.scenes[1].effectOverrides.blurVignette;

        const added = await execute('Add a white vignette to this clip', plan);
        const whiteVignette = added.result.plan.scenes[1]._effectRecipe
            .find((entry) => entry.id === 'vignette');
        assert.strictEqual(whiteVignette.color, '#ffffff');

        const recolored = await execute(
            'I want a black vignette, not white',
            added.result.plan
        );
        const blackVignette = recolored.result.plan.scenes[1]._effectRecipe
            .find((entry) => entry.id === 'vignette');
        assert.strictEqual(blackVignette.color, '#000000');
        assert.strictEqual(
            recolored.result.plan.scenes[1]._effectRecipe
                .filter((entry) => entry.id === 'vignette').length,
            1,
            'property edits must update the existing effect instead of duplicating it'
        );
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Make it black, not white', plan);
        const vignette = result.plan.scenes[1]._effectRecipe.find((entry) => entry.id === 'vignette');
        assert.strictEqual(vignette.color, '#000000', 'the Agent should infer the sole color-editable live effect');
    }
    {
        const plan = fixturePlan();
        plan.scenes[1]._effectRecipe.push({ id: 'fogDrift', intensity: 0.18 });
        const { result } = await execute('Change the fog color to blue', plan);
        const fog = result.plan.scenes[1]._effectRecipe.find((entry) => entry.id === 'fogDrift');
        assert.strictEqual(fog.color, '#3b82f6');
        assert.strictEqual(fog.intensity, 0.18);
        assert.strictEqual(fog.userDirected, true);
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Use vivid grade for this selection', plan);
        const scene = result.plan.scenes[1];
        assert.ok(scene._effectRecipe.some((entry) => entry.id === 'vivid'));
        assert.strictEqual(scene.effectOverrides.colorGrade.gradeId, 'vivid');
        const merged = mergeBaseLook(recipeFromScene(scene), result.plan._hfBaseLook);
        assert.strictEqual(merged[merged.length - 1].id, 'vivid');
    }

    console.log('[Agent Matrix] adversarial surgical actions');
    {
        const plan = fixturePlan();
        const statCard = plan.templateScenes.find((graphic) => graphic.id === 'stat-template-1');
        Object.assign(statCard, {
            clipId: 'stat-template-1',
            text: '$300 System',
            subtext: '',
            startTime: 7,
            endTime: 9,
            duration: 2,
            style: 'editorial-light',
            variant: 'sideBySide',
            animation: 'countUp',
            items: [{ kind: 'stat', icon: 'money', value: '$300', label: 'Complete System' }],
            _authoredComposition: {
                html: '<div>$300 System</div>',
                css: 'div{color:#2c2218}',
                timeline: 'tl.to("div",{opacity:1})',
            },
            _authoredNs: 'auth-stat-template-1',
            mgData: {
                type: 'statCard',
                text: '$300 System',
                subText: '',
                startTime: 7,
                endTime: 9,
                duration: 2,
                style: 'editorial-light',
                variant: 'sideBySide',
                animation: 'countUp',
                items: [{ kind: 'stat', icon: 'money', value: '$300', label: 'Complete System' }],
                _authoredComposition: {
                    html: '<div>$300 System</div>',
                    css: 'div{color:#2c2218}',
                    timeline: 'tl.to("div",{opacity:1})',
                },
            },
        });
        const scope = {
            kind: 'visual',
            scopeMode: 'selection',
            label: '1 selected graphic',
            currentTime: 8,
            fromSec: 7,
            toSec: 9,
            totalDuration: 15,
            contiguous: true,
            clipRefs: [],
            iconRefs: [],
            visualRefs: [{
                id: 'stat-template-1',
                type: 'statCard',
                collection: 'templateScenes',
                collectionIndex: 0,
                startTime: 7,
                endTime: 9,
                label: '$300 System',
            }],
        };
        const before = clone(statCard);
        const { proposal, result } = await execute(
            'give this graphic another style',
            plan,
            scope
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-properties']],
            'a generic restyle request must resolve to one in-place graphics edit'
        );
        assert.match(proposal.summary, /restyle.+in place.+preserving/i);
        assert.strictEqual(proposal.estimatedWork.operationCount, 1);
        const after = result.plan.templateScenes.find(
            (graphic) => graphic.id === 'stat-template-1'
        );
        assert.ok(after, 'the selected stat card must keep its original identity');
        assert.strictEqual(result.diff.graphicsAdded, 0);
        assert.strictEqual(result.diff.graphicsRemoved, 0);
        assert.strictEqual(result.diff.graphicsUpdated, 1);
        assert.strictEqual(result.diff.scopeLeakCount, 0);
        assert.strictEqual(after.id, before.id);
        assert.strictEqual(after.clipId, before.clipId);
        assert.strictEqual(after.text, before.text);
        assert.strictEqual(after.subtext, before.subtext);
        assert.deepStrictEqual(after.items, before.items);
        assert.strictEqual(after.startTime, before.startTime);
        assert.strictEqual(after.endTime, before.endTime);
        assert.strictEqual(after.duration, before.duration);
        assert.ok(STYLE_NAMES.includes(after.style));
        assert.notStrictEqual(after.style, before.style);
        assert.strictEqual(after.variant, 'single');
        assert.strictEqual(after.subType, 'single');
        assert.strictEqual(after.styleManual, true);
        assert.strictEqual(after.variantManual, true);
        assert.strictEqual(after.authoredCompositionMode, 'fixed-renderer');
        assert.strictEqual(after._authoredComposition, undefined);
        assert.strictEqual(after.mgData._authoredComposition, undefined);
    }
    {
        const plan = fixturePlan();
        const statCard = plan.templateScenes.find((graphic) => graphic.id === 'stat-template-1');
        Object.assign(statCard, {
            clipId: 'stat-template-1',
            text: '$300 System',
            startTime: 7,
            endTime: 9,
            duration: 2,
            style: 'editorial-light',
            variant: 'sideBySide',
            items: [{ value: '$300', label: 'Complete System' }],
        });
        const scope = {
            kind: 'visual',
            scopeMode: 'selection',
            label: '1 selected graphic',
            currentTime: 8,
            fromSec: 7,
            toSec: 9,
            totalDuration: 15,
            contiguous: true,
            clipRefs: [],
            iconRefs: [],
            visualRefs: [{
                id: 'stat-template-1',
                type: 'statCard',
                collection: 'templateScenes',
                collectionIndex: 0,
                startTime: 7,
                endTime: 9,
                label: '$300 System',
            }],
        };
        const request = normalizeAgentRequest({
            text: 'give this graphic another style',
            originalText: 'give this graphic another style',
            effort: 'smart',
            scope,
        });
        const staged = await planStagedOperations({
            graphics: {
                action: 'regenerate',
                requestedType: 'statCard',
            },
            summary: 'Regenerate the selected stat card.',
        }, request, plan, {
            visualGrounding: {
                status: 'grounded',
                summary: 'The selected stat card is visible.',
                invocation: {
                    capabilityId: 'graphics',
                    action: 'regenerate',
                    args: {
                        action: 'regenerate',
                        requestedType: 'statCard',
                        instruction: 'use another style',
                        fewer: false,
                        effort: 'smart',
                    },
                    description: 'regenerate the selected stat card',
                },
            },
            routeSmartRequest: async () => ({
                summary: 'Regenerate the selected stat card.',
                operations: [{
                    capabilityId: 'graphics',
                    specialist: 'Motion Graphics Editor',
                    action: 'regenerate',
                    args: {
                        action: 'regenerate',
                        requestedType: 'statCard',
                        instruction: 'use another style',
                        fewer: false,
                        effort: 'smart',
                    },
                    scope: request.scope,
                    risk: 'moderate',
                    description: 'author motion graphics for the selected scope',
                }],
                supported: ['Motion Graphics Editor: author motion graphics for the selected scope'],
                unsupported: [],
                claimedDirectiveKeys: ['graphics'],
            }),
            log: () => { },
        });
        assert.deepStrictEqual(
            staged.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-properties']],
            'visual grounding and smart routing must not duplicate an exclusively owned graphics edit'
        );
        assert.match(staged.summary, /restyle.+in place.+preserving/i);
    }
    {
        const plan = fixturePlan();
        const before = clone(plan);
        const scope = {
            kind: 'visual',
            scopeMode: 'selection',
            label: 'Selected headline',
            currentTime: 7,
            fromSec: 6,
            toSec: 8,
            totalDuration: 15,
            contiguous: true,
            clipRefs: [],
            iconRefs: [],
            visualRefs: [{
                id: 'headline-1',
                type: 'headline',
                collection: 'motionGraphics',
                startTime: 6,
                endTime: 8,
                label: 'Cooling system headline',
            }],
        };
        const operation = {
            action: 'regenerate',
            requestedType: 'headline',
            instruction: 'regenerate the selected headline',
            effort: 'fast',
        };
        regenerateScopedGraphics(plan, scope, operation);
        regenerateScopedGraphics(plan, scope, operation);
        const replacement = plan.motionGraphics.find((graphic) => (
            graphic._agentReplacesVisualId === 'headline-1'
        ));
        assert.ok(replacement, 'repeated regeneration must preserve the original selected identity');
        assert.ok(replacement._agentReplacesVisualIds.includes('headline-1'));
        assert.strictEqual(
            summarizePlanDiff(before, plan, scope).scopeLeakCount,
            0,
            'replacement lineage must keep repeated regeneration inside the exact selected scope'
        );
    }
    {
        const plan = fixturePlan();
        plan.scenes = [
            {
                index: 0,
                sourceSceneIndex: 0,
                clipId: 'clip-opening',
                trackId: 'video-track-1',
                startTime: 0,
                endTime: 4.88,
                text: 'Opening scene',
            },
            {
                index: 1,
                sourceSceneIndex: 1,
                clipId: 'clip-before-card',
                trackId: 'video-track-1',
                startTime: 4.88,
                endTime: 13.72,
                text: 'No wires, no compressor, no thermostat.',
            },
            {
                index: 2,
                sourceSceneIndex: 3,
                clipId: 'clip-after-card',
                trackId: 'video-track-1',
                startTime: 23.18,
                endTime: 26.3,
                text: 'The Amish have been building it for 200 years.',
            },
        ];
        plan.totalDuration = 26.3;
        plan.mgScenes = [];
        plan.motionGraphics = [];
        plan.templateScenes = [{
            isMGScene: true,
            disabled: false,
            trackId: 'video-track-3',
            mediaType: 'template',
            clipId: 'template-tpl-0-13720',
            startTime: 13.72,
            endTime: 23.18,
            duration: 9.46,
            durationFrames: 284,
            durationUnit: 'seconds',
            text: '$300 System',
            subtext: '',
            type: 'statCard',
            position: 'center',
            style: 'editorial-light',
            sceneIndex: 2,
            sourceSceneIndex: 2,
            originalSceneIndex: 2,
            templateType: true,
            variant: 'sideBySide',
            animation: 'countUp',
            themeId: 'warm-editorial',
            items: [{ kind: 'stat', icon: 'money', value: '$300', label: 'Complete System' }],
            templateMediaFile: 'template-bg-000-statcard.png',
            mgData: {
                id: 'tpl-0',
                type: 'statCard',
                templateType: true,
                mediaType: 'template',
                trackId: 'video-track-3',
                category: 'fullscreen',
                text: '$300 System',
                subText: '',
                startTime: 13.72,
                endTime: 23.18,
                duration: 9.46,
                style: 'editorial-light',
                variant: 'sideBySide',
                animation: 'countUp',
                themeId: 'warm-editorial',
                items: [{ kind: 'stat', icon: 'money', value: '$300', label: 'Complete System' }],
                _authoredComposition: {
                    html: '<div>$300 System</div>',
                    css: 'div{color:#2c2218}',
                    timeline: 'tl.to("div",{opacity:1})',
                },
            },
            _authoredComposition: {
                html: '<div>$300 System</div>',
                css: 'div{color:#2c2218}',
                timeline: 'tl.to("div",{opacity:1})',
            },
        }];
        const scope = {
            kind: 'visual',
            scopeMode: 'selection',
            label: '1 selected graphic',
            currentTime: 16.52,
            fromSec: 13.72,
            toSec: 23.18,
            totalDuration: 26.3,
            contiguous: true,
            clipRefs: [],
            iconRefs: [],
            visualRefs: [{
                id: 'template-tpl-0-13720',
                type: 'statCard',
                collection: 'templateScenes',
                collectionIndex: 0,
                trackId: 'video-track-3',
                startTime: 13.72,
                endTime: 23.18,
                sourceSceneIndex: 2,
                sceneIndex: 2,
                label: '$300 System',
            }],
        };
        const original = clone(plan.templateScenes[0]);
        const result = regenerateScopedGraphics(plan, scope, {
            action: 'regenerate',
            requestedType: 'statCard',
            instruction: 'regenerate the selected stat card',
            effort: 'fast',
        });
        assert.deepStrictEqual(
            { removed: result.removed, added: result.added },
            { removed: 1, added: 1 }
        );
        assert.strictEqual(plan.templateScenes.length, 1);
        assert.strictEqual(plan.mgScenes.length, 0);
        assert.strictEqual(plan.motionGraphics.length, 0);
        const replacement = plan.templateScenes[0];
        assert.notStrictEqual(replacement.clipId, original.clipId);
        assert.strictEqual(replacement._agentReplacesVisualId, original.clipId);
        assert.strictEqual(replacement.startTime, original.startTime);
        assert.strictEqual(replacement.endTime, original.endTime);
        assert.strictEqual(replacement.duration, original.duration);
        assert.strictEqual(replacement.trackId, original.trackId);
        assert.strictEqual(replacement.mediaType, original.mediaType);
        assert.strictEqual(replacement.isMGScene, true);
        assert.strictEqual(replacement.category, 'fullscreen');
        assert.strictEqual(replacement.text, original.text);
        assert.strictEqual(replacement.subtext, original.subtext);
        assert.deepStrictEqual(replacement.items, original.items);
        assert.strictEqual(replacement.themeId, original.themeId);
        assert.strictEqual(replacement.templateMediaFile, original.templateMediaFile);
        assert.strictEqual(replacement.mgData.text, original.mgData.text);
        assert.deepStrictEqual(replacement.mgData.items, original.mgData.items);
        assert.strictEqual(replacement.authoredCompositionMode, 'fixed-renderer');
        assert.strictEqual(replacement._authoredComposition, undefined);
        assert.strictEqual(replacement.mgData._authoredComposition, undefined);
        assert.ok(
            18.45 >= replacement.startTime && 18.45 < replacement.endTime,
            'the replacement must remain visible at the selected graphic midpoint'
        );
        assert.ok(
            !(24.44 >= replacement.startTime && 24.44 < replacement.endTime),
            'the replacement must not move onto the following Amish footage'
        );
    }
    {
        const plan = fixturePlan();
        const overlay = {
            index: 99,
            sourceSceneIndex: 99,
            clipId: 'overlap-v2',
            trackId: 'video-track-2',
            startTime: 5,
            endTime: 10,
            text: 'overlapping picture in picture',
            mediaFile: 'overlay.png',
            effects: ['grain'],
            _effectRecipe: [{ id: 'grain', intensity: 0.33 }],
        };
        plan.scenes.push(overlay);
        const scope = {
            ...clipScope(1),
            clipRefs: [{ ...clipScope(1).clipRefs[0], trackId: 'video-track-1' }],
        };
        const { result } = await execute('Remove film grain from this selection', plan, scope);
        assert.deepStrictEqual(
            result.plan.scenes.find((scene) => scene.clipId === 'overlap-v2')._effectRecipe,
            overlay._effectRecipe,
            'an exact V1 selection must not edit an overlapping V2 clip'
        );
        assert.strictEqual(result.diff.scopeLeakCount, 0);
    }
    {
        const plan = fixturePlan();
        const { proposal, result } = await execute(
            'Remove the decorative accent bar from the headline',
            plan,
            wholeSceneScope(1)
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-properties']]
        );
        const headline = result.plan.motionGraphics.find((graphic) => graphic.id === 'headline-1');
        assert.strictEqual(headline.accentRuleVisible, false);
        assert.strictEqual(headline.agenticComposition.style.accentRule, false);
    }
    {
        const plan = fixturePlan();
        const beforeHeadline = clone(
            plan.motionGraphics.find((graphic) => graphic.id === 'headline-1')
        );
        const beforeMedia = plan.scenes[1].mediaFile;
        const { proposal, result } = await execute(
            'edit the duration of the headling make it shorter',
            plan,
            wholeSceneScope(1)
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-properties']],
            'a headline-duration request must never revive a completed Media Editor task'
        );
        const headline = result.plan.motionGraphics.find((graphic) => graphic.id === 'headline-1');
        assert.strictEqual(headline.startTime, beforeHeadline.startTime);
        assert.strictEqual(headline.duration, 1.3);
        assert.strictEqual(headline.durationSeconds, 1.3);
        assert.strictEqual(headline.endTime, 7.3);
        assert.strictEqual(headline.durationFrames, 39);
        assert.strictEqual(headline.durationUnit, 'seconds');
        assert.strictEqual(headline.timingManual, true);
        assert.strictEqual(headline.text, beforeHeadline.text);
        assert.strictEqual(headline.style, beforeHeadline.style);
        assert.strictEqual(headline.animation, beforeHeadline.animation);
        assert.strictEqual(result.plan.scenes[1].mediaFile, beforeMedia);
        assert.strictEqual(result.diff.mediaChanged, 0);
        assert.strictEqual(result.diff.graphicsUpdated, 1);
    }
    {
        const plan = fixturePlan();
        const request = normalizeAgentRequest({
            text: 'edit the duration of the headling make it shorter',
            originalText: 'edit the duration of the headling make it shorter',
            effort: 'smart',
            scope: wholeSceneScope(1),
        });
        const staged = await planStagedOperations({}, request, plan, {
            routeSmartRequest: async () => ({
                summary: 'Shorten the headline.',
                operations: [{
                    capabilityId: 'media',
                    specialist: 'Media Editor',
                    action: 'replace',
                    args: { query: 'stale previous request' },
                    scope: request.scope,
                    risk: 'expensive',
                    description: 'incorrectly revive the previous media replacement',
                }],
                supported: ['Media Editor: incorrectly revive the previous media replacement'],
                unsupported: [],
                claimedDirectiveKeys: ['media'],
            }),
        });
        assert.deepStrictEqual(
            staged.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-properties']],
            'named-target isolation must discard unrelated smart specialists'
        );
        assert.strictEqual(staged.operations[0].args.durationScale, 0.65);
    }
    {
        const plan = fixturePlan();
        plan.scenes[1]._effectRecipe = [
            { id: 'grain', intensity: 0.1 },
            { id: 'dust', intensity: 0.1 },
            { id: 'vignette', intensity: 0.2 },
            { id: 'bloom', intensity: 0.1 },
            { id: 'lightLeak', intensity: 0.1 },
            { id: 'fogDrift', intensity: 0.1 },
            { id: 'warm-film' },
        ];
        const { result } = await execute('Increase only the vignette to 40 percent', plan);
        const recipe = result.plan.scenes[1]._effectRecipe;
        assert.deepStrictEqual(
            recipe.map((entry) => entry.id),
            ['grain', 'dust', 'vignette', 'bloom', 'lightLeak', 'fogDrift', 'warm-film'],
            'tuning one effect must preserve the complete unrelated effect stack'
        );
        assert.strictEqual(recipe.find((entry) => entry.id === 'vignette').intensity, 0.4);
    }
    {
        const plan = fixturePlan();
        const before = clone(plan.scenes[1]);
        const { proposal, result } = await execute(
            'Move this clip 10 percent left and zoom this clip to 110 percent',
            plan
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['framing', 'adjust-framing']]
        );
        const after = result.plan.scenes[1];
        assert.strictEqual(after.posX, before.posX - 10);
        assert.strictEqual(after.scale, 1.1);
        assert.strictEqual(after.framing, before.framing);
        assert.strictEqual(after.fitMode, before.fitMode);
        assert.strictEqual(after.background, before.background);
    }
    {
        const plan = fixturePlan();
        const scope = {
            kind: 'visual',
            label: 'Selected lowerThird',
            currentTime: 1.5,
            visualRefs: [{
                id: 'lower-1',
                type: 'lowerThird',
                startTime: 1,
                endTime: 3,
                label: 'This $300 system cools any home to 55 degrees',
            }],
        };
        const before = clone(plan.motionGraphics[0]);
        const { proposal, result } = await execute(
            'Move this lower third to top right, make its background transparent, and make the animation 50 percent faster',
            plan,
            scope
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-properties']]
        );
        assert.strictEqual(result.diff.graphicsAdded, 0);
        assert.strictEqual(result.diff.graphicsRemoved, 0);
        const after = result.plan.motionGraphics.find((graphic) => graphic.id === 'lower-1');
        assert.strictEqual(after.text, before.text);
        assert.strictEqual(after.subtext, before.subtext);
        assert.strictEqual(after.position, 'top-right');
        assert.strictEqual(after.transparentBackground, true);
        assert.strictEqual(after.cardStyle, 'transparent');
        assert.strictEqual(after.colors.background, 'rgba(0,0,0,0)');
        assert.strictEqual(after.animationSpeed, 1.5);
        assert.strictEqual(after.style, before.style);
        assert.strictEqual(after.animation, before.animation);
    }
    {
        const plan = fixturePlan();
        const seededHeadline = plan.motionGraphics.find((graphic) => graphic.id === 'headline-1');
        seededHeadline._authoredComposition = {
            html: '<div class="stale-headline">Old cream headline</div>',
            css: '.stale-headline{background:#ece0c8;color:#2c2218;}',
            timeline: 'tl.to(".stale-headline",{opacity:1});',
        };
        seededHeadline._authoredNs = 'stale-headline-cache';
        const beforeHeadline = clone(seededHeadline);
        const beforeIcon = clone(plan.scenes[1]._iconMoments);
        const request = 'give it a scratch effect, remove the decorative accent bar from the headline, make it without background in a white color, and give it a typewriter animation';
        const { proposal, result } = await execute(
            request,
            plan,
            wholeSceneScope(1)
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [
                ['effects', 'edit-look'],
                ['graphics', 'edit-properties'],
            ],
            'one natural-language scene request must coordinate the Effects and Motion Graphics specialists'
        );
        const afterHeadline = result.plan.motionGraphics.find((graphic) => graphic.id === 'headline-1');
        const scratchEffect = result.plan.scenes[1]._effectRecipe.find((entry) => entry.id === 'filmScratches');
        assert.ok(
            scratchEffect,
            'the clip must receive the requested film-scratches effect'
        );
        assert.strictEqual(
            scratchEffect.color,
            undefined,
            'the headline color clause must not leak into the film-scratches effect'
        );
        assert.strictEqual(afterHeadline.id, beforeHeadline.id);
        assert.strictEqual(afterHeadline.type, 'headline');
        assert.strictEqual(afterHeadline.text, beforeHeadline.text);
        assert.strictEqual(afterHeadline.subtext, beforeHeadline.subtext);
        assert.strictEqual(afterHeadline.startTime, beforeHeadline.startTime);
        assert.strictEqual(afterHeadline.duration, beforeHeadline.duration);
        assert.strictEqual(afterHeadline.transparentBackground, true);
        assert.strictEqual(afterHeadline.cardStyle, 'transparent');
        assert.strictEqual(afterHeadline.colors.background, 'rgba(0,0,0,0)');
        assert.strictEqual(afterHeadline.colors.text, '#ffffff');
        assert.strictEqual(afterHeadline.textColorManual, true);
        assert.strictEqual(afterHeadline.accentRuleVisible, false);
        assert.strictEqual(afterHeadline.animation, 'typewriter');
        assert.strictEqual(afterHeadline.subType, 'typewriter');
        assert.strictEqual(afterHeadline.agenticComposition.motion.entrance, 'typewriter');
        assert.strictEqual(afterHeadline.authoredCompositionMode, 'fixed-renderer');
        assert.strictEqual(afterHeadline._authoredComposition, undefined);
        assert.strictEqual(afterHeadline._authoredNs, undefined);
        assert.deepStrictEqual(
            result.plan.scenes[1]._iconMoments,
            beforeIcon,
            'whole-scene context must not edit an unrelated icon'
        );
        assert.strictEqual(result.diff.scopeLeakCount, 0);
    }
    {
        const plan = fixturePlan();
        const scope = { ...clipScope(1), currentTime: 5 };
        const { proposal, result } = await execute(
            'Change this transition to whip right and set it to 0.3 seconds',
            plan,
            scope
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['transitions', 'edit-transition']]
        );
        assert.strictEqual(result.plan.transitions[0].type, 'whip-right');
        assert.strictEqual(result.plan.transitions[0].duration, 0.3);
        assert.strictEqual(result.plan.transitions[1].type, 'whip-left');
        assert.strictEqual(result.plan.scenes[1].transitionType, 'whip-right');
    }
    {
        const plan = fixturePlan();
        const { proposal, result } = await execute(
            'Turn captions on, put captions at the top, use karaoke with 4 words per caption, and remove the caption background',
            plan
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['captions', 'edit-captions']]
        );
        assert.strictEqual(result.plan.subtitlesEnabled, true);
        assert.strictEqual(result.plan.captionStyle.position, 'top');
        assert.strictEqual(result.plan.captionStyle.background, 'none');
        assert.strictEqual(result.plan.captionKaraoke, true);
        assert.strictEqual(result.plan.captionWordsPerCue, 4);
        assert.strictEqual(result.diff.subtitlesChanged, 1);
        assert.strictEqual(result.diff.captionsChanged, 1);
    }
    {
        const plan = fixturePlan();
        plan.scenes[1].mediaFile = 'scene-1.jpg';
        const { proposal, result } = await execute('Turn off Ken Burns for this image', plan, clipScope(1));
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['timeline', 'set-ken-burns']]
        );
        assert.strictEqual(result.plan.scenes[1].kenBurns, false);
        assert.strictEqual(result.plan.scenes[1].kenBurnsEnabled, false);
        assert.strictEqual(result.diff.timelinePropertiesChanged, 1);
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Set the source offset to 2.5 seconds', plan, clipScope(1));
        assert.strictEqual(result.plan.scenes[1].mediaOffset, 2.5);
        assert.strictEqual(result.diff.timelinePropertiesChanged, 1);
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Move this clip to video track 2', plan, clipScope(1));
        assert.strictEqual(result.plan.scenes[1].trackId, 'video-track-2');
        assert.strictEqual(result.diff.timelinePropertiesChanged, 1);
    }
    {
        const plan = fixturePlan();
        plan.sfxClips = [
            { id: 'sfx-a', file: 'a.wav', startTime: 6, duration: 1, volume: 0.5 },
            { id: 'sfx-b', file: 'b.wav', startTime: 12, duration: 1, volume: 0.5 },
        ];
        const beforeLook = JSON.stringify(plan.scenes[1]._effectRecipe);
        const { proposal, result } = await execute('Set sound effects volume to 20 percent', plan, clipScope(1));
        assert.deepStrictEqual(
            proposal.operations.map((operation) => operation.capabilityId),
            ['audio'],
            'sound-effect mix commands must not invoke the visual Effects Agent'
        );
        assert.strictEqual(result.plan.sfxClips[0].volume, 0.2);
        assert.strictEqual(result.plan.sfxClips[1].volume, 0.5);
        assert.strictEqual(JSON.stringify(result.plan.scenes[1]._effectRecipe), beforeLook);
        assert.strictEqual(result.diff.scopeLeakCount, 0);
    }
    {
        const plan = fixturePlan();
        plan.audio = 'voice.mp3';
        plan.musicBed = 'music.mp3';
        const projectScope = { kind: 'project', label: 'Whole project' };
        const narration = await execute('Set narration volume to 80 percent', plan, projectScope);
        assert.strictEqual(narration.result.plan.narrationVolume, 0.8);
        const music = await execute(
            'Set background music volume to 10 percent',
            narration.result.plan,
            projectScope
        );
        assert.strictEqual(music.result.plan.musicBedGain, 0.1);
    }

    console.log('[Agent Matrix] whole-project actions');
    {
        const plan = fixturePlan();
        const { result } = await execute('Use hard cuts only', plan, { kind: 'project', label: 'Whole project' });
        assert.ok(result.plan.scenes.every((scene) => scene.transition.type === 'cut'));
        assert.ok(result.plan.transitions.every((transition) => transition.type === 'cut'));
    }
    for (const framing of ['fullscreen', 'cinematic', 'floating']) {
        const plan = fixturePlan();
        const { result } = await execute(`Make everything ${framing}`, plan, { kind: 'project', label: 'Whole project' });
        assert.ok(result.plan.scenes.every((scene) => scene.framing === framing), `${framing}: every scene must use the requested preset`);
        if (framing === 'fullscreen') {
            assert.ok(result.plan.scenes.every((scene) => (
                scene.scale === 1
                && scene.fitMode === 'cover'
                && scene.background === 'none'
            )));
        } else if (framing === 'cinematic') {
            assert.ok(result.plan.scenes.every((scene) => (
                scene.scale >= 0.7
                && scene.scale < 1
                && scene.background === 'blur'
            )));
        } else {
            assert.ok(result.plan.scenes.every((scene) => (
                scene.scale >= 0.4
                && scene.scale <= 0.6
                && scene.borderRadius === 4
                && scene.shadow === 0.5
                && scene.floatingAnim
            )));
        }
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Remove film grain from the whole video', plan, { kind: 'project', label: 'Whole project' });
        assert.deepStrictEqual(result.plan._hfBaseLook.texture.map((entry) => entry.id), ['dust']);
        assert.ok(result.plan.scenes.every((_scene, index) => (
            !effectiveRecipe(result.plan, index).some((entry) => entry.id === 'grain')
        )));
        assert.ok(result.plan.scenes.every((_scene, index) => (
            effectiveRecipe(result.plan, index).some((entry) => entry.id === 'dust')
        )));
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Remove all texture effects from the whole video', plan, { kind: 'project', label: 'Whole project' });
        assert.deepStrictEqual(result.plan._hfBaseLook.texture, []);
        assert.ok(result.plan.scenes.every((_scene, index) => (
            !effectiveRecipe(result.plan, index).some((entry) => EFFECT_CATEGORIES.texture.includes(entry.id))
        )));
    }
    for (const grade of GRADE_IDS) {
        const plan = fixturePlan();
        const spokenGrade = grade.replace(/-/g, ' ');
        const { result } = await execute(`Use ${spokenGrade} grade for the whole video`, plan, { kind: 'project', label: 'Whole project' });
        assert.strictEqual(result.plan._hfBaseLook.grade, grade);
        assert.ok(result.plan.scenes.every((scene) => scene._effectRecipe.some((entry) => entry.id === grade)), `${grade}: every scene must receive the grade`);
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Remove all icons', plan, { kind: 'project', label: 'Whole project' });
        assert.ok(result.plan.scenes.every((scene) => !scene._iconMoments?.length));
        assert.strictEqual(result.stats.iconsRemoved, 2);
        assert.strictEqual(result.diff.iconsChanged, 2);
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Remove all icons', plan, wholeSceneScope());
        assert.strictEqual(result.plan.scenes[0]._iconMoments.length, 1);
        assert.strictEqual(result.plan.scenes[1]._iconMoments.length, 0);
        assert.strictEqual(result.stats.iconsRemoved, 1);
        assert.strictEqual(result.diff.scopeLeakCount, 0);
    }
    {
        const plan = fixturePlan();
        const { proposal, result } = await execute(
            'Make the scene icon red and move it to the top left',
            plan,
            wholeSceneScope()
        );
        assert.deepStrictEqual(proposal.capabilityIds, ['icons']);
        assert.deepStrictEqual(proposal.operations.map((operation) => operation.capabilityId), ['icons']);
        assert.strictEqual(result.plan.scenes[0]._iconMoments[0].color, undefined);
        assert.strictEqual(result.plan.scenes[1]._iconMoments[0].color, '#ef4444');
        assert.strictEqual(result.plan.scenes[1]._iconMoments[0].position, 'top-left');
        assert.strictEqual(result.stats.iconsEdited, 1);
        assert.strictEqual(result.diff.iconsChanged, 1);
        assert.strictEqual(result.diff.scopeLeakCount, 0);
    }
    {
        const plan = fixturePlan();
        const { result } = await execute('Remove all maps', plan, { kind: 'project', label: 'Whole project' });
        assert.strictEqual(result.plan.scenes[1].fullscreenMG, null);
        assert.ok(!result.plan.mgScenes.some((graphic) => /map/i.test(graphic.type)));
    }
    for (const [type, request] of [
        ['lowerThird', 'Remove lower thirds'],
        ['statCard', 'Remove stat cards'],
        ['factCard', 'Remove fact cards'],
        ['quoteCard', 'Remove quote cards'],
        ['chapterCard', 'Remove chapter cards'],
        ['callout', 'Remove callouts'],
        ['headline', 'Remove headlines'],
    ]) {
        const plan = fixturePlan();
        const { result } = await execute(request, plan, { kind: 'project', label: 'Whole project' });
        const matching = [
            ...(result.plan.mgScenes || []),
            ...(result.plan.templateScenes || []),
            ...(result.plan.motionGraphics || []),
        ].filter((graphic) => String(graphic.type || graphic.templateType).toLowerCase() === type.toLowerCase());
        assert.ok(matching.length > 0, `${type}: fixture must contain a matching graphic`);
        assert.ok(matching.every((graphic) => graphic.disabled), `${type}: every matching visual must be disabled`);
        assert.ok(result.plan.scenes.every((scene) => (
            String(scene.fullscreenMG || '').split(':')[0].trim().toLowerCase() !== type.toLowerCase()
            && String(scene.templateHint || '').split(':')[0].trim().toLowerCase() !== type.toLowerCase()
        )), `${type}: scene-level stage hints must be cleared`);
    }

    console.log('[Agent Matrix] staged pacing, media, and graphics operations');
    {
        const plan = fixturePlan();
        const before = clone(plan.motionGraphics.find((graphic) => graphic.id === 'lower-1'));
        const beforeCount = plan.motionGraphics.length;
        const { proposal, result } = await execute(
            'edit the lower third to keep only the 300$',
            plan,
            clipScope(0)
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-content']]
        );
        assert.ok(/preserve its design/i.test(proposal.supported.join(' ')));
        assert.strictEqual(result.stats.graphicsContentEdited, 1);
        assert.strictEqual(result.stats.graphicsAdded, 0);
        assert.strictEqual(result.stats.graphicsRemoved, 0);
        assert.strictEqual(result.plan.motionGraphics.length, beforeCount);
        const after = result.plan.motionGraphics.find((graphic) => graphic.id === 'lower-1');
        assert.ok(after, 'the original graphic id must survive');
        assert.strictEqual(after.text, '$300', 'retain mode must preserve the existing canonical currency token');
        assert.strictEqual(after.subtext, '');
        assert.strictEqual(after.mgData.text, '$300');
        assert.strictEqual(after.mgData.subtext, '');
        assert.strictEqual(after.agenticComposition.title, '$300');
        assert.strictEqual(after.agenticComposition.subtitle, '');
        assert.deepStrictEqual(
            graphicDesignSnapshot(after),
            graphicDesignSnapshot(before),
            'content-only editing must preserve type, style, color, variant, animation, timing, position, and shadow'
        );
    }
    {
        const plan = fixturePlan();
        const target = plan.motionGraphics.find((graphic) => graphic.id === 'lower-1');
        target.text = '50 Years';
        target.subtext = 'Established';
        target.agenticComposition.title = '50 Years';
        target.agenticComposition.subtitle = 'Established';
        target.mgData.text = '50 Years';
        target.mgData.subtext = 'Established';
        const before = clone(target);
        const beforeCount = plan.motionGraphics.length;
        const scope = {
            kind: 'visual',
            label: 'Selected lowerThird',
            fromSec: 1,
            toSec: 3,
            currentTime: 1.2,
            totalDuration: plan.totalDuration,
            visualRefs: [{
                id: 'lower-1',
                type: 'lowerThird',
                startTime: 1,
                endTime: 3,
                label: '50 Years',
            }],
        };
        const { proposal, result } = await execute(
            'change te color of this lower third into red',
            plan,
            scope
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-text-style']]
        );
        assert.strictEqual(proposal.estimatedWork.graphicStyleEdits, 1);
        assert.strictEqual(proposal.estimatedWork.graphicEdits, 0);
        assert.ok(/recolor existing lowerThird text in place/i.test(proposal.supported.join(' ')));
        assert.strictEqual(result.stats.graphicsStyleEdited, 1);
        assert.strictEqual(result.stats.graphicsAdded, 0);
        assert.strictEqual(result.stats.graphicsRemoved, 0);
        assert.strictEqual(result.diff.graphicsAdded, 0);
        assert.strictEqual(result.diff.graphicsRemoved, 0);
        assert.strictEqual(result.diff.graphicsUpdated, 1);
        assert.strictEqual(result.plan.motionGraphics.length, beforeCount);
        const after = result.plan.motionGraphics.find((graphic) => graphic.id === 'lower-1');
        assert.ok(after, 'the recolored graphic must keep its original id');
        assert.strictEqual(after.text, '50 Years');
        assert.strictEqual(after.subtext, 'Established');
        assert.deepStrictEqual(after.textStyleRanges, [{
            match: '50 Years',
            color: '#ef4444',
            occurrence: 0,
            allOccurrences: false,
        }]);
        assert.deepStrictEqual(
            graphicStyleInvariantSnapshot(after),
            graphicStyleInvariantSnapshot(before),
            'text-color editing must preserve copy, type, layout, background, animation, timing, position, and every existing design property'
        );
    }
    {
        const plan = fixturePlan();
        const target = plan.motionGraphics.find((graphic) => graphic.id === 'lower-1');
        target.text = '50 Years';
        target.agenticComposition.title = '50 Years';
        target.mgData.text = '50 Years';
        const scope = {
            ...clipScope(0),
            visualRefs: [{
                id: 'lower-1',
                type: 'lowerThird',
                startTime: 1,
                endTime: 3,
                label: '50 Years',
            }],
        };
        const beforeRecipe = clone(plan.scenes[0]._effectRecipe);
        const { proposal, result } = await execute(
            'change te color of this lower third into red',
            plan,
            scope
        );
        assert.deepStrictEqual(
            proposal.operations.map((operation) => [operation.capabilityId, operation.action]),
            [['graphics', 'edit-text-style']],
            'an explicitly named graphic owns its color request; clip effects must not infer the color'
        );
        assert.deepStrictEqual(
            result.plan.scenes[0]._effectRecipe,
            beforeRecipe,
            'recoloring a graphic must not recolor a live vignette or another clip effect'
        );
    }
    {
        const plan = fixturePlan();
        const scope = { kind: 'range', label: 'In/Out 0:05-0:10', fromSec: 5, toSec: 10 };
        const { proposal, result } = await execute('Make this selected part faster paced', plan, scope);
        assert.ok(proposal.operations.some((operation) => operation.capabilityId === 'pacing'));
        assert.ok(result.stats.pacingSplits > 0);
        assert.ok(result.plan.scenes.length > plan.scenes.length);
        assert.strictEqual(result.plan.totalDuration, plan.totalDuration);
        assert.strictEqual(new Set(result.plan.scenes.map((scene) => scene.clipId)).size, result.plan.scenes.length);
        assert.ok(result.plan.scenes.every((scene) => (
            scene.durationFrames === Math.max(1, Math.round((scene.endTime - scene.startTime) * plan.fps))
        )));
        const assignedWords = result.plan.scenes.flatMap((scene) => scene.words || []).map((word) => `${word.word}@${word.start}`);
        assert.strictEqual(new Set(assignedWords).size, assignedWords.length, 'pacing split must not duplicate narration words');
        assert.ok(result.plan.transitions
            .filter((transition) => transition.startTime >= 5 && transition.startTime <= 10)
            .every((transition) => transition.type === 'cut'));
        assert.strictEqual(result.plan.scenes.find((scene) => scene.clipId === 'clip-a').mediaFile, 'scene-0.mp4');
        assert.strictEqual(result.plan.scenes.find((scene) => scene.clipId === 'clip-c').mediaFile, 'scene-2.mp4');
    }
    {
        const plan = fixturePlan();
        const overlay = {
            index: 20,
            sourceSceneIndex: 20,
            clipId: 'pacing-overlay-v2',
            trackId: 'video-track-2',
            startTime: 5,
            endTime: 10,
            duration: 5,
            mediaFile: 'overlay.png',
            framing: 'floating',
            framingMode: 'floating',
            fitMode: 'contain',
            scale: 0.5,
            posX: -12,
            posY: 6,
            background: 'blur',
            text: 'overlapping overlay must remain untouched',
        };
        plan.scenes.push(overlay);
        const overlayInvariant = (scene) => ({
            clipId: scene.clipId,
            trackId: scene.trackId,
            startTime: scene.startTime,
            endTime: scene.endTime,
            mediaFile: scene.mediaFile,
            framing: scene.framing,
            framingMode: scene.framingMode,
            fitMode: scene.fitMode,
            scale: scene.scale,
            posX: scene.posX,
            posY: scene.posY,
            background: scene.background,
            text: scene.text,
        });
        const beforeOverlay = overlayInvariant(overlay);
        const scope = {
            ...clipScope(1),
            clipRefs: [{ ...clipScope(1).clipRefs[0], trackId: 'video-track-1' }],
        };
        const { result } = await execute('Make this selected clip faster paced', plan, scope);
        assert.deepStrictEqual(
            overlayInvariant(result.plan.scenes.find((scene) => scene.clipId === 'pacing-overlay-v2')),
            beforeOverlay,
            'structural pacing must not split or reframe an overlapping unselected track'
        );
        assert.strictEqual(result.diff.scopeLeakCount, 0);
    }
    {
        const plan = fixturePlan();
        const scope = {
            kind: 'clips',
            label: '2 adjacent clips',
            clipRefs: [
                { clipId: 'clip-a', sourceSceneIndex: 0, startTime: 0, endTime: 5 },
                { clipId: 'clip-b', sourceSceneIndex: 1, startTime: 5, endTime: 10 },
            ],
        };
        const { result } = await execute('Make this section slower paced', plan, scope);
        assert.ok(result.stats.pacingMerges > 0);
        assert.ok(result.plan.scenes.length < plan.scenes.length);
        assert.strictEqual(result.plan.totalDuration, plan.totalDuration);
        assert.ok(result.plan.transitions
            .filter((transition) => transition.startTime >= 0 && transition.startTime <= 10)
            .every((transition) => transition.type === 'crossfade'));
    }
    {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-editor-agent-media-'));
        try {
            fs.mkdirSync(path.join(projectDir, 'temp'), { recursive: true });
            fs.mkdirSync(path.join(projectDir, 'public'), { recursive: true });
            const replacementPath = path.join(projectDir, 'temp', 'replacement.jpg');
            const originalPath = path.join(projectDir, 'public', 'scene-0.mp4');
            fs.writeFileSync(replacementPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
            fs.writeFileSync(originalPath, 'ORIGINAL-MEDIA');
            let downloaderInput = null;
            const plan = fixturePlan();
            Object.assign(plan.scenes[0], {
                videoFile: 'legacy-video.mp4',
                imageFile: 'legacy-image.jpg',
                cropTop: 8,
                cropRight: 4,
                focusX: 0.2,
                focusY: 0.8,
                mediaWidth: 640,
                mediaHeight: 360,
                aspectRatio: 640 / 360,
                _verticalContain: true,
                flagForReplacement: true,
                qaReason: 'old asset issue',
            });
            const { proposal, result } = await execute(
                'Find a better alternative for this media',
                plan,
                clipScope(0),
                'fast',
                {
                    projectDir,
                    mediaDownloader: async (input) => {
                        downloaderInput = input;
                        return {
                            path: replacementPath,
                            ext: '.jpg',
                            mediaType: 'image',
                            provider: 'test-provider',
                            visionScore: 9,
                            mediaWidth: 1600,
                            mediaHeight: 900,
                        };
                    },
                }
            );
            assert.ok(proposal.operations.some((operation) => operation.capabilityId === 'media'));
            assert.ok(downloaderInput.query.includes('underground tunnel engineering'));
            assert.strictEqual(result.stats.mediaReplaced, 1);
            assert.match(result.plan.scenes[0].mediaFile, /^agent-assets\//);
            assert.strictEqual(result.plan.scenes[0].videoFile, undefined);
            assert.strictEqual(result.plan.scenes[0].imageFile, undefined);
            assert.strictEqual(result.plan.scenes[0].cropTop, undefined);
            assert.strictEqual(result.plan.scenes[0].cropRight, undefined);
            assert.strictEqual(result.plan.scenes[0].focusX, undefined);
            assert.strictEqual(result.plan.scenes[0]._verticalContain, undefined);
            assert.strictEqual(result.plan.scenes[0].flagForReplacement, undefined);
            assert.strictEqual(result.plan.scenes[0].qaReason, undefined);
            assert.strictEqual(result.plan.scenes[0].mediaWidth, 1600);
            assert.strictEqual(result.plan.scenes[0].mediaHeight, 900);
            assert.strictEqual(result.plan.scenes[0].aspectRatio, 1600 / 900);
            assert.strictEqual(fs.readFileSync(originalPath, 'utf8'), 'ORIGINAL-MEDIA');
            assert.strictEqual(result.assetManifest.assets.length, 1);
            const asset = result.assetManifest.assets[0];
            assert.ok(fs.existsSync(asset.stagedPath));
            assert.ok(!fs.existsSync(asset.finalPath));
            const committed = transactionAssets.commitAssets(result.assetManifest, { projectDir });
            assert.ok(fs.existsSync(asset.finalPath));
            transactionAssets.cleanupStage(result.assetManifest, { projectDir });
            assert.ok(!fs.existsSync(result.assetManifest.stagingRoot));
            transactionAssets.rollbackCommittedAssets(committed, { projectDir });
            assert.ok(!fs.existsSync(asset.finalPath));
        } finally {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
    }
    {
        const plan = fixturePlan();
        const { proposal, result } = await execute('Add an animated text treatment', plan, clipScope(0));
        assert.ok(proposal.operations.some((operation) => operation.capabilityId === 'graphics'));
        assert.ok(result.stats.graphicsAdded > 0);
        assert.ok(result.plan.motionGraphics.some((graphic) => (
            graphic.type === 'kineticText' && graphic.selectionMode === 'editor-agent'
        )));
    }
    {
        const plan = fixturePlan();
        const { proposal, result } = await execute('Add more maps', plan, clipScope(0));
        assert.deepStrictEqual(proposal.unsupported, []);
        assert.ok(result.plan.mgScenes.some((graphic) => (
            graphic.type === 'mapChart'
            && graphic.category === 'fullscreen'
            && graphic.selectionMode === 'editor-agent'
        )));
    }
    {
        const plan = fixturePlan();
        const scope = {
            kind: 'visual',
            label: 'Selected stat card',
            visualRefs: [{ id: 'stat-1', type: 'statCard', startTime: 7, endTime: 9 }],
        };
        const { result } = await execute('Regenerate this stat card', plan, scope);
        assert.strictEqual(result.stats.graphicsRemoved, 1);
        assert.strictEqual(result.stats.graphicsAdded, 1);
        assert.ok(!result.plan.mgScenes.some((graphic) => graphic.id === 'stat-1'));
        assert.ok(result.plan.mgScenes.some((graphic) => (
            graphic.type === 'statCard'
            && graphic.selectionMode === 'editor-agent'
            && graphic.startTime === 7
        )));
    }
    {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-editor-agent-combined-'));
        try {
            fs.mkdirSync(path.join(projectDir, 'temp'), { recursive: true });
            const replacementPath = path.join(projectDir, 'temp', 'archive.jpg');
            fs.writeFileSync(replacementPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
            const plan = fixturePlan();
            const { proposal, result } = await execute(
                'Make this part faster paced, replace it with clean black and white archival footage, and add a text animation',
                plan,
                clipScope(1),
                'fast',
                {
                    projectDir,
                    mediaDownloader: async () => ({
                        path: replacementPath,
                        ext: '.jpg',
                        mediaType: 'image',
                        provider: 'test-provider',
                        visionScore: 9,
                    }),
                }
            );
            assert.deepStrictEqual(
                proposal.operations.map((operation) => operation.capabilityId),
                ['pacing', 'media', 'effects', 'graphics']
            );
            const pacingOperationId = proposal.operations[0].operationId;
            assert.ok(
                proposal.operations.slice(1).every((operation) => operation.dependsOn.includes(pacingOperationId)),
                'all downstream workers must depend on the structural pacing step'
            );
            assert.deepStrictEqual(proposal.unsupported, []);
            assert.ok(result.stats.pacingSplits > 0);
            assert.ok(result.stats.mediaReplaced > 0);
            assert.ok(result.stats.graphicsAdded > 0);
            assert.deepStrictEqual(
                result.operationResults.map((operation) => operation.capabilityId),
                ['pacing', 'media', 'effects', 'graphics']
            );
            assert.ok(result.operationResults.every((operation) => operation.changed > 0));
            assert.ok(
                result.operationResults
                    .filter((operation) => operation.capabilityId !== 'pacing')
                    .every((operation) => operation.scope.kind === 'clips'),
                'workers after a structural edit must receive exact descendant clip ids instead of a broad time range'
            );
            const editedScenes = result.plan.scenes.filter((scene) => scene.startTime >= 5 && scene.endTime <= 10);
            assert.ok(editedScenes.every((scene) => /^agent-assets\//.test(scene.mediaFile)));
            assert.ok(editedScenes.every((scene) => scene.effectOverrides?.colorGrade?.gradeId === 'noir'));
            assert.strictEqual(result.qualityReport.status, 'passed');
            assert.strictEqual(result.diff.scopeLeakCount, 0);
            assert.strictEqual(result.diff.narrationPreserved, true);
        } finally {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
    }

    console.log('[Agent Matrix] safe blocking and no-op behavior');
    for (const [text, scope, expected] of [
        ['Add an icon to this clip', clipScope(), /build-time visual-generation/i],
        ['Make these separate clips faster paced', {
            kind: 'clips',
            label: '2 non-adjacent clips',
            contiguous: false,
            clipRefs: [
                { clipId: 'clip-a', sourceSceneIndex: 0, startTime: 0, endTime: 5 },
                { clipId: 'clip-c', sourceSceneIndex: 2, startTime: 10, endTime: 15 },
            ],
        }, /one contiguous selection/i],
        ['Replace this footage', {
            kind: 'visual',
            label: 'Selected stat card',
            visualRefs: [{ id: 'stat-1', type: 'statCard', startTime: 7, endTime: 9 }],
        }, /footage clips/i],
    ]) {
        const proposal = await propose(text, fixturePlan(), scope);
        assert.strictEqual(proposal.kind, 'edit');
        assert.strictEqual(proposal.executable, false, `${text}: must be blocked before Apply`);
        assert.ok(proposal.unsupported.some((message) => expected.test(message)), `${text}: expected honest explanation`);
    }
    {
        const plan = fixturePlan();
        delete plan.scenes[1].mediaFile;
        const proposal = await propose('Remove all maps', plan, { kind: 'project', label: 'Whole project' });
        assert.strictEqual(proposal.executable, false);
        assert.ok(proposal.unsupported.some((message) => /map-only scene/i.test(message)));
    }
    {
        const plan = fixturePlan();
        Object.assign(plan.scenes[1], {
            framing: 'fullscreen',
            framingMode: 'fullscreen',
            fit: 'cover',
            fitMode: 'cover',
            scale: 1,
            posX: 0,
            posY: 0,
            background: 'none',
            backgroundId: 'none',
            floatingBackground: 'none',
            borderRadius: 0,
            shadow: 0,
            floatingShadow: 0,
            floatingAnim: null,
            floatingAnimDuration: null,
        });
        const proposal = await propose('Make this selection fullscreen', plan);
        assert.strictEqual(proposal.executable, false);
        assert.strictEqual(proposal.alreadySatisfied, true);
    }
    {
        const before = fixturePlan();
        const after = clone(before);
        after.scenes[0].mediaFile = 'unexpected-outside-scope.mp4';
        after.motionGraphics.push({
            id: 'outside-graphic',
            type: 'headline',
            startTime: 12,
            duration: 1,
            text: 'Unexpected',
        });
        const diff = summarizePlanDiff(before, after, clipScope(1));
        assert.ok(diff.outsideScopeSceneChanges > 0);
        assert.ok(diff.outsideScopeVisualChanges > 0);
        assert.ok(diff.scopeLeakCount >= 2, 'scope leakage must be measurable before commit');
    }
    {
        const plan = fixturePlan();
        const proposal = await propose('Use hard cuts and make this faster paced', plan);
        assert.strictEqual(proposal.executable, true);
        const result = await supervisor.executePlanned(proposal.planId, {
            plan,
            revision: 7,
            planHash: hash(plan),
        }, { log: () => { } });
        assert.strictEqual(result.success, true);
        assert.ok(result.stats.pacingSplits > 0);
        assert.ok(result.plan.transitions.every((transition) => transition.type === 'cut'));
    }

    console.log('[Agent Matrix] conflict, history, undo, and redo contracts');
    {
        const plan = fixturePlan();
        const proposal = await propose('Make this selection fullscreen', plan);
        await assert.rejects(
            () => supervisor.executePlanned(proposal.planId, {
                plan,
                revision: 8,
                planHash: hash(plan),
            }),
            (error) => error.code === 'AGENT_PLAN_CONFLICT'
        );
    }

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-editor-agent-'));
    try {
        const plan = fixturePlan();
        const { result } = await execute('Use hard cuts for this selection', plan);
        const transaction = history.recordCommit(projectDir, {
            request: 'Use hard cuts',
            summary: 'Use hard cuts',
            scope: clipScope(),
            beforePlan: plan,
            afterPlan: result.plan,
            beforeRevision: 7,
            afterRevision: 8,
            beforePlanHash: hash(plan),
            afterPlanHash: hash(result.plan),
            stats: result.stats,
            diff: result.diff,
            qualityReport: result.qualityReport,
            operationResults: result.operationResults,
        });
        assert.strictEqual(history.getUndoCandidate(projectDir).id, transaction.id);
        assert.deepStrictEqual(
            history.getUndoCandidate(projectDir).operationResults,
            result.operationResults
        );
        history.markUndone(projectDir, transaction.id);
        assert.strictEqual(history.getRedoCandidate(projectDir).id, transaction.id);
        history.markRedone(projectDir, transaction.id);
        assert.strictEqual(history.getUndoCandidate(projectDir).id, transaction.id);
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }

    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'index.html'), 'utf8');
    assert.ok(html.includes('id="btn-agent"'));
    assert.ok(html.includes('id="agent-pane"'));
    assert.ok(html.includes('js/editor-agent-panel.js'));
    assert.ok(!html.includes('id="btn-qa-studio"'));
    assert.ok(!html.includes('id="btn-qa-chat"'));

    console.log('Editor Agent action matrix passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
