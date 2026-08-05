'use strict';

const { applyFramingPreset, VALID_FRAMINGS } = require('../../../directives/framing-preset');
const { resolveSceneTargets } = require('../scope-utils');
const {
    boolean: booleanField,
    number,
    object,
    string,
    tool,
} = require('./capability-contract');

const FRAMING_PRESET_ARGS = object({
    framing: string({ enum: [...VALID_FRAMINGS] }),
}, { required: ['framing'] });

const FRAMING_ADJUST_ARGS = object({
    scale: number({ min: 0.1, max: 4 }),
    scaleDelta: number({ min: -3.9, max: 3.9 }),
    posX: number({ min: -100, max: 100 }),
    posY: number({ min: -100, max: 100 }),
    posXDelta: number({ min: -100, max: 100 }),
    posYDelta: number({ min: -100, max: 100 }),
    cropTop: number({ min: 0, max: 45 }),
    cropRight: number({ min: 0, max: 45 }),
    cropBottom: number({ min: 0, max: 45 }),
    cropLeft: number({ min: 0, max: 45 }),
    fitMode: string({ enum: ['cover', 'contain'] }),
    background: string({ enum: ['none', 'blur'] }),
    resetCrop: booleanField(),
}, { minProperties: 1 });

function tools() {
    return [
        tool('set-framing', 'Apply a complete renderer-backed framing preset.', FRAMING_PRESET_ARGS, {
            visualRepair: true,
        }),
        tool('reframe', 'Apply a complete renderer-backed framing preset.', FRAMING_PRESET_ARGS, { canonicalAction: 'set-framing' }),
        tool('adjust-framing', 'Adjust only explicitly requested crop, fit, scale, position, or background controls.', FRAMING_ADJUST_ARGS, {
            visualRepair: true,
        }),
        tool('set-transform', 'Set precise scale or position controls.', FRAMING_ADJUST_ARGS, { canonicalAction: 'adjust-framing' }),
        tool('set-fit', 'Set cover or contain fitting.', FRAMING_ADJUST_ARGS, { canonicalAction: 'adjust-framing' }),
        tool('set-crop', 'Set or clear edge crop controls.', FRAMING_ADJUST_ARGS, { canonicalAction: 'adjust-framing' }),
    ];
}

function _operation(framing, request) {
    return {
        capabilityId: 'framing',
        specialist: 'Framing Editor',
        action: 'set-framing',
        args: { framing },
        scope: request.scope,
        risk: 'low',
        description: `set ${framing} framing`,
        progress: {
            phase: 'framing',
            message: 'Framing Editor is applying the requested composition...',
        },
    };
}

function _adjustOperation(args, request, description = '') {
    return {
        capabilityId: 'framing',
        specialist: 'Framing Editor',
        action: 'adjust-framing',
        args,
        scope: request.scope,
        risk: 'low',
        description: description || 'adjust only the requested framing controls',
        progress: {
            phase: 'framing',
            message: 'Framing Editor is applying the requested precise composition adjustment...',
        },
    };
}

function _targetsAnotherVisibleLayer(text) {
    const raw = String(text || '');
    const namedOtherLayer = /\b(?:(?:scene|explainer)\s+)?icons?\b|\blower[\s-]?third\b|\bmotion\s+graphic\b|\b(?:caption|subtitle|headline|callout|stat\s+card)\b/i.test(raw);
    const namesFootage = /\b(?:clip|footage|image|video|shot|frame|framing|crop|camera)\b/i.test(raw);
    return namedOtherLayer && !namesFootage;
}

function _parseAdjustment(text) {
    const raw = String(text || '');
    if (_targetsAnotherVisibleLayer(raw)) return null;
    const args = {};

    const zoom = raw.match(/\b(?:zoom|scale)\b.{0,24}?(?:\b(?:to|at)\b\s*)?([0-9]+(?:\.[0-9]+)?)\s*(%|percent|x)\b/i);
    if (zoom) {
        args.scale = zoom[2].toLowerCase() === 'x'
            ? Number(zoom[1])
            : Number(zoom[1]) / 100;
    } else if (/\bzoom\s+in\b/i.test(raw)) {
        args.scaleDelta = 0.1;
    } else if (/\bzoom\s+out\b/i.test(raw)) {
        args.scaleDelta = -0.1;
    }

    const move = raw.match(
        /\b(?:move|shift|nudge|position)\b.{0,24}?\b(?:(\d+(?:\.\d+)?)\s*(?:%|percent)?\s*)?(left|right|up|down)\b/i
    ) || raw.match(
        /\b(?:move|shift|nudge|position)\b.{0,12}?\b(left|right|up|down)\b.{0,12}?(\d+(?:\.\d+)?)\s*(?:%|percent)?\b/i
    );
    if (move) {
        const reversed = /^(left|right|up|down)$/i.test(String(move[1] || ''));
        const direction = String(reversed ? move[1] : move[2]).toLowerCase();
        const amount = Math.max(0.1, Math.min(100, Number(reversed ? move[2] : move[1]) || 10));
        if (direction === 'left') args.posXDelta = -amount;
        if (direction === 'right') args.posXDelta = amount;
        if (direction === 'up') args.posYDelta = -amount;
        if (direction === 'down') args.posYDelta = amount;
    }

    if (/\b(?:fit|set)\b.{0,16}\bcontain\b|\bshow\s+(?:the\s+)?whole\s+(?:image|clip|frame)\b/i.test(raw)) {
        args.fitMode = 'contain';
    } else if (/\b(?:fit|set)\b.{0,16}\bcover\b|\bfill\s+(?:the\s+)?(?:whole\s+)?frame\b/i.test(raw)) {
        args.fitMode = 'cover';
    }
    if (/\b(?:remove|disable|no)\b.{0,16}\bbackground\s+blur\b/i.test(raw)) {
        args.background = 'none';
    } else if (/\b(?:add|use|enable|make)\b.{0,18}\bblur(?:red)?\s+background\b/i.test(raw)) {
        args.background = 'blur';
    }
    if (/\b(?:reset|clear|remove)\b.{0,18}\bcrop\b/i.test(raw)) {
        args.resetCrop = true;
    } else {
        for (const edge of ['top', 'right', 'bottom', 'left']) {
            const match = raw.match(new RegExp(`\\bcrop\\b.{0,16}\\b${edge}\\b.{0,12}?(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)?\\b`, 'i'));
            if (match) args[`crop${edge[0].toUpperCase()}${edge.slice(1)}`] = Number(match[1]);
        }
    }
    return Object.keys(args).length ? args : null;
}

function planFast({ text, directives, request }) {
    const framing = directives?.framing?.force;
    if (request.scope.kind === 'visual') return { operations: [], claimedDirectiveKeys: [] };
    const adjustment = _parseAdjustment(text);
    const operations = [];
    if (VALID_FRAMINGS.has(framing)) operations.push(_operation(framing, request));
    if (adjustment) operations.push(_adjustOperation(adjustment, request));
    if (!operations.length) return { operations: [], claimedDirectiveKeys: [] };
    return {
        operations,
        claimedDirectiveKeys: [
            'framing',
            ...(adjustment && directives?.footage && !directives.footage.replace ? ['footage'] : []),
        ],
        supported: [
            ...(VALID_FRAMINGS.has(framing) ? [`Framing Editor: ${framing}`] : []),
            ...(adjustment ? ['Framing Editor: precise framing adjustment'] : []),
        ],
    };
}

function normalizeInvocation(invocation, context) {
    const action = String(invocation?.action || '');
    if (_targetsAnotherVisibleLayer(context.request?.originalText || context.request?.text)) return null;
    if (['adjust-framing', 'set-transform', 'set-fit', 'set-crop'].includes(action)) {
        if (context.request.scope.kind === 'visual') return null;
        const source = invocation?.args || {};
        const args = {};
        for (const field of [
            'scale', 'scaleDelta', 'posX', 'posY', 'posXDelta', 'posYDelta',
            'cropTop', 'cropRight', 'cropBottom', 'cropLeft',
        ]) {
            if (Number.isFinite(Number(source[field]))) args[field] = Number(source[field]);
        }
        if (['cover', 'contain'].includes(source.fitMode)) args.fitMode = source.fitMode;
        if (['none', 'blur'].includes(source.background)) args.background = source.background;
        if (source.resetCrop === true) args.resetCrop = true;
        if (!Object.keys(args).length) return null;
        return _adjustOperation(args, context.request, String(invocation.description || ''));
    }
    if (!['set-framing', 'reframe'].includes(action)) return null;
    const framing = String(invocation?.args?.framing || '');
    if (!VALID_FRAMINGS.has(framing) || context.request.scope.kind === 'visual') return null;
    return _operation(framing, context.request);
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'framing',
        specialist: 'Framing Editor',
        domain: 'composition',
        description: 'Applies complete fullscreen, cinematic, or floating framing contracts.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'low',
        actions: [
            'set-framing',
            'reframe',
            'adjust-framing',
            'set-transform',
            'set-fit',
            'set-crop',
        ],
        directiveKeys: ['framing'],
        vocabulary: { framings: [...VALID_FRAMINGS] },
    };
}

function execute({ plan, operation }) {
    const targets = resolveSceneTargets(plan, operation.scope, { includeDescendants: true });
    if (!targets.length) throw new Error('No exact footage clips match the active selection');
    let changed = 0;
    if (operation.action === 'adjust-framing') {
        for (const scene of targets) {
            const before = JSON.stringify(scene);
            const args = operation.args || {};
            if (Number.isFinite(Number(args.scale))) {
                scene.scale = Math.max(0.1, Math.min(4, Number(args.scale)));
            } else if (Number.isFinite(Number(args.scaleDelta))) {
                scene.scale = Math.max(0.1, Math.min(4, (Number(scene.scale) || 1) + Number(args.scaleDelta)));
            }
            if (Number.isFinite(Number(args.posX))) scene.posX = Math.max(-100, Math.min(100, Number(args.posX)));
            if (Number.isFinite(Number(args.posY))) scene.posY = Math.max(-100, Math.min(100, Number(args.posY)));
            if (Number.isFinite(Number(args.posXDelta))) {
                scene.posX = Math.max(-100, Math.min(100, (Number(scene.posX) || 0) + Number(args.posXDelta)));
            }
            if (Number.isFinite(Number(args.posYDelta))) {
                scene.posY = Math.max(-100, Math.min(100, (Number(scene.posY) || 0) + Number(args.posYDelta)));
            }
            if (args.fitMode) {
                scene.fit = args.fitMode;
                scene.fitMode = args.fitMode;
            }
            if (args.background) {
                scene.background = args.background;
                scene.backgroundId = args.background;
                scene.floatingBackground = args.background;
            }
            if (args.resetCrop === true) {
                for (const field of ['cropTop', 'cropRight', 'cropBottom', 'cropLeft']) scene[field] = 0;
            }
            for (const field of ['cropTop', 'cropRight', 'cropBottom', 'cropLeft']) {
                if (Number.isFinite(Number(args[field]))) {
                    scene[field] = Math.max(0, Math.min(45, Number(args[field])));
                }
            }
            if (before !== JSON.stringify(scene)) changed++;
        }
        if (!changed) throw new Error('The selected clips already use those exact framing values');
        return { changed, stats: { framingAdjusted: changed } };
    }
    for (const scene of targets) {
        if (applyFramingPreset(scene, operation.args.framing).changed) changed++;
    }
    if (!changed) throw new Error('The selected clips already use that framing');
    return { changed, stats: { framingChanged: changed } };
}

function inspect(plan, scope) {
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    return {
        targetCount: targets.length,
        scenes: targets.slice(0, 32).map((scene) => ({
            clipId: scene.clipId || '',
            startTime: Number(scene.startTime) || 0,
            endTime: Number(scene.endTime) || 0,
            framing: scene.framing || scene.framingMode || 'fullscreen',
            fitMode: scene.fitMode || scene.fit || 'cover',
            scale: Number(scene.scale) || 1,
            posX: Number(scene.posX) || 0,
            posY: Number(scene.posY) || 0,
            background: scene.background || scene.backgroundId || 'none',
            cropTop: Number(scene.cropTop) || 0,
            cropRight: Number(scene.cropRight) || 0,
            cropBottom: Number(scene.cropBottom) || 0,
            cropLeft: Number(scene.cropLeft) || 0,
        })),
    };
}

module.exports = { execute, inspect, manifest, normalizeInvocation, planFast, tools };
