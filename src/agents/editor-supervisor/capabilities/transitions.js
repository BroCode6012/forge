'use strict';

const { applyHardCuts } = require('../../../directives/transition-preset');
const { DEFAULT_DURATIONS, editScopedTransitions } = require('../workers/transition-editor');
const { resolveSceneTargets, scopeRange } = require('../scope-utils');
const {
    array,
    number,
    object,
    string,
    tool,
} = require('./capability-contract');

const TYPE_ALIASES = [
    ['blur-dissolve', /\bblur(?:red)?[\s-]+dissolve\b/i],
    ['crossfade', /\bcross[\s-]?fade\b/i],
    ['dip-black', /\bdip\s+(?:to\s+)?black\b/i],
    ['whip-left', /\bwhip(?:\s+pan)?\s+left\b/i],
    ['whip-right', /\bwhip(?:\s+pan)?\s+right\b/i],
    ['wipe-left', /\bwipe\s+left\b/i],
    ['wipe-right', /\bwipe\s+right\b/i],
    ['wipe-up', /\bwipe\s+up\b/i],
    ['push-left', /\bpush\s+left\b/i],
    ['push-right', /\bpush\s+right\b/i],
    ['push-up', /\bpush\s+up\b/i],
    ['zoom-punch', /\bzoom[\s-]+punch\b/i],
    ['zoom-pull', /\bzoom[\s-]+pull\b/i],
    ['spin-settle', /\bspin[\s-]+settle\b/i],
    ['flash-white', /\b(?:white\s+flash|flash\s+white)\b/i],
    ['light-sweep', /\blight\s+sweep\b/i],
    ['glitch', /\bglitch\b/i],
    ['crossfade', /\bdissolve\b/i],
];
const TRANSITION_TYPES = new Set(Object.keys(DEFAULT_DURATIONS));
const TRANSITION_BOUNDARIES = ['incoming', 'outgoing', 'nearest', 'all'];

const TRANSITION_EDIT_ARGS = object({
    type: string({ enum: [...TRANSITION_TYPES] }),
    duration: number({ min: 0, max: 2 }),
    durationScale: number({ min: 0.1, max: 4 }),
    boundary: string({ enum: TRANSITION_BOUNDARIES }),
}, {
    anyOfRequired: [['type'], ['duration'], ['durationScale']],
});

const HARD_CUT_ARGS = object({
    banned: array(string({ enum: [...TRANSITION_TYPES] }), { maxItems: 32, uniqueItems: true }),
    boundary: string({ enum: TRANSITION_BOUNDARIES }),
});

function tools() {
    return [
        tool('edit-transition', 'Edit transition type or timing on exact selected boundaries.', TRANSITION_EDIT_ARGS, {
            visualRepair: true,
        }),
        tool('set-transition', 'Set transition type or timing.', TRANSITION_EDIT_ARGS, { canonicalAction: 'edit-transition' }),
        tool('set-transition-duration', 'Set transition duration.', TRANSITION_EDIT_ARGS, { canonicalAction: 'edit-transition' }),
        tool('hard-cuts', 'Replace selected transition boundaries with cuts.', HARD_CUT_ARGS, {
            visualRepair: true,
        }),
        tool('remove-transitions', 'Remove selected transitions by replacing them with cuts.', HARD_CUT_ARGS, { canonicalAction: 'hard-cuts' }),
    ];
}

function _boundaryMode(text) {
    const raw = String(text || '');
    if (/\b(?:incoming|before|at\s+the\s+start)\b/i.test(raw)) return 'incoming';
    if (/\b(?:outgoing|after|at\s+the\s+end)\b/i.test(raw)) return 'outgoing';
    if (/\b(?:all|every|both)\b|\btransitions\b|\bhard\s+cuts?\b/i.test(raw)) return 'all';
    return 'nearest';
}

function _operation(request, banned = [], boundary = 'all') {
    return {
        capabilityId: 'transitions',
        specialist: 'Transition Editor',
        action: 'hard-cuts',
        args: { banned, boundary },
        scope: request.scope,
        risk: 'low',
        description: banned.length ? `replace ${banned.join(', ')} transitions with cuts` : 'use hard cuts',
        progress: {
            phase: 'transitions',
            message: 'Transition Editor is reconciling the selected boundaries...',
        },
    };
}

function _editOperation(args, request, description = '') {
    return {
        capabilityId: 'transitions',
        specialist: 'Transition Editor',
        action: 'edit-transition',
        args,
        scope: request.scope,
        risk: 'low',
        description: description || 'edit the selected transition boundary',
        progress: {
            phase: 'transitions',
            message: 'Transition Editor is updating the selected boundary...',
        },
    };
}

function _parseTransitionEdit(text) {
    const raw = String(text || '');
    const boundary = _boundaryMode(raw);
    const transitionContext = /\b(?:transition|cross[\s-]?fade|dissolve|whip|wipe|push|dip|zoom[\s-](?:punch|pull)|light\s+sweep|glitch)\b/i.test(raw);
    if (!transitionContext) return null;
    const duration = raw.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i);
    const typeCommand = /\b(?:change|set|make|switch|turn|use)\b.{0,40}\b(?:to|into|as)\b/i.test(raw)
        || /\b(?:use|apply|add)\b.{0,28}\btransition\b/i.test(raw);
    const matchedType = TYPE_ALIASES.find(([, pattern]) => pattern.test(raw))?.[0] || '';
    const remove = /\b(?:remove|delete|disable|clear|no)\b.{0,24}\btransition\b/i.test(raw);
    const args = { boundary };
    if (remove) args.type = 'cut';
    else if (typeCommand && matchedType) args.type = matchedType;
    if (duration) args.duration = Number(duration[1]);
    else if (/\b(?:shorten|quicker|faster)\b/i.test(raw)) args.durationScale = 0.7;
    else if (/\b(?:lengthen|longer|slower)\b/i.test(raw)) args.durationScale = 1.3;
    return Object.keys(args).length > 1 ? args : null;
}

function planFast({ text, directives, request }) {
    const transition = directives?.transitions;
    if (request.scope.kind === 'visual') return { operations: [], claimedDirectiveKeys: [] };
    const precise = _parseTransitionEdit(text);
    if (precise) {
        return {
            operations: [_editOperation(precise, request)],
            claimedDirectiveKeys: ['transitions'],
            supported: ['Transition Editor: precise boundary edit'],
        };
    }
    if (!transition || (transition.style !== 'hard-cuts' && !transition.banned?.length)) {
        return { operations: [], claimedDirectiveKeys: [] };
    }
    return {
        operations: [_operation(request, transition.banned || [], _boundaryMode(text))],
        claimedDirectiveKeys: ['transitions'],
        supported: ['Transition Editor: hard cuts'],
    };
}

function normalizeInvocation(invocation, context) {
    const action = String(invocation?.action || '');
    if (context.request.scope.kind === 'visual') return null;
    if (['edit-transition', 'set-transition', 'set-transition-duration'].includes(action)) {
        const source = invocation?.args || {};
        const args = {
            boundary: ['incoming', 'outgoing', 'nearest', 'all'].includes(source.boundary)
                ? source.boundary
                : 'nearest',
        };
        if (source.type && TRANSITION_TYPES.has(String(source.type))) args.type = String(source.type);
        if (Number.isFinite(Number(source.duration))) args.duration = Number(source.duration);
        if (Number.isFinite(Number(source.durationScale))) args.durationScale = Number(source.durationScale);
        if (Object.keys(args).length === 1) return null;
        return _editOperation(args, context.request, String(invocation.description || ''));
    }
    if (!['hard-cuts', 'remove-transitions'].includes(action)) return null;
    return _operation(
        context.request,
        invocation?.args?.banned || [],
        invocation?.args?.boundary || 'all'
    );
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'transitions',
        specialist: 'Transition Editor',
        domain: 'transitions',
        description: 'Edits exact transition boundaries, including type, direction, duration, and hard cuts.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'low',
        actions: [
            'edit-transition',
            'set-transition',
            'set-transition-duration',
            'hard-cuts',
            'remove-transitions',
        ],
        directiveKeys: ['transitions'],
        vocabulary: { types: [...TRANSITION_TYPES] },
    };
}

function execute({ plan, operation }) {
    if (operation.action === 'edit-transition') {
        const result = editScopedTransitions(plan, operation.scope, operation.args);
        return {
            changed: result.changed,
            stats: { transitionsChanged: result.changed },
            diagnostics: result.edits,
        };
    }
    if (operation.args.boundary && operation.args.boundary !== 'all' && !(operation.args.banned || []).length) {
        const result = editScopedTransitions(plan, operation.scope, {
            type: 'cut',
            boundary: operation.args.boundary,
        });
        return {
            changed: result.changed,
            stats: { transitionsChanged: result.changed },
            diagnostics: result.edits,
        };
    }
    const targets = operation.scope.kind === 'project'
        ? null
        : resolveSceneTargets(plan, operation.scope, { includeDescendants: true });
    const result = applyHardCuts(plan, targets, operation.args.banned || []);
    if (!result.changed) throw new Error('The selected boundaries already use hard cuts');
    return {
        changed: result.scenesChanged + result.transitionsChanged,
        stats: {
            transitionScenesChanged: result.scenesChanged,
            transitionsChanged: result.transitionsChanged,
        },
    };
}

function inspect(plan, scope) {
    const range = scopeRange(scope, plan);
    const transitions = (plan?.transitions || []).filter((transition) => {
        if (scope?.kind === 'project') return true;
        const at = Number(transition?.startTime ?? transition?.at);
        return Number.isFinite(at) && at >= range.fromSec - 0.05 && at <= range.toSec + 0.05;
    });
    const types = transitions.reduce((counts, transition) => {
        const type = String(transition?.type || 'cut');
        counts[type] = (counts[type] || 0) + 1;
        return counts;
    }, {});
    return {
        targetCount: transitions.length,
        fromSec: range.fromSec,
        toSec: range.toSec,
        types,
        transitions: transitions.slice(0, 48).map((transition) => ({
            fromClipId: transition.fromClipId || '',
            toClipId: transition.toClipId || '',
            startTime: Number(transition.startTime ?? transition.at) || 0,
            type: transition.type || 'cut',
            duration: Number(transition.duration) || 0,
        })),
    };
}

module.exports = { execute, inspect, manifest, normalizeInvocation, planFast, tools };
