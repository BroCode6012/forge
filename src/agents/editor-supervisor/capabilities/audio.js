'use strict';

const { overlaps, scopeRange, windowOf } = require('../scope-utils');
const {
    number,
    object,
    tool,
} = require('./capability-contract');

const VOLUME_ARGS = object({
    volume: number({ min: 0, max: 1, description: 'Absolute gain from silent to full level.' }),
    scale: number({ min: 0.1, max: 3, description: 'Multiplier applied to the current gain.' }),
}, {
    anyOfRequired: [['volume'], ['scale']],
});

function tools() {
    return [
        tool('set-sfx-volume', 'Set or scale sound-effect volume inside the active scope.', VOLUME_ARGS),
        tool('remove-sfx', 'Remove sound-effect cues inside the active scope.', object()),
        tool('set-narration-volume', 'Set or scale the project narration level.', VOLUME_ARGS),
        tool('set-music-volume', 'Set or scale the project background-music level.', VOLUME_ARGS),
        tool('remove-music', 'Remove the project background-music bed.', object()),
    ];
}

function _projectScope() {
    return {
        kind: 'project',
        label: 'Whole project',
        fromSec: 0,
        toSec: 0,
        currentTime: 0,
        totalDuration: 0,
        contiguous: true,
        clipRefs: [],
        visualRefs: [],
    };
}

function _operation(action, args, request, options = {}) {
    return {
        capabilityId: 'audio',
        specialist: 'Audio Editor',
        action,
        args,
        scope: options.global === true ? _projectScope() : request.scope,
        risk: 'low',
        description: options.description || 'edit the project audio mix',
        progress: {
            phase: 'audio',
            message: 'Audio Editor is applying the requested mix adjustment...',
        },
    };
}

function _percent(text) {
    const match = String(text || '').match(/\b(\d{1,3})(?:\s*%|\s+percent)\b/i);
    return match ? Math.max(0, Math.min(1, Number(match[1]) / 100)) : null;
}

function planFast({ text, request }) {
    const raw = String(text || '');
    const operations = [];

    const sfxContext = /\b(?:sfx|sound\s+effects?)\b/i.test(raw);
    if (sfxContext) {
        const amount = _percent(raw);
        if (/\b(?:remove|delete|clear)\b/i.test(raw)) {
            operations.push(_operation('remove-sfx', {}, request, {
                description: 'remove sound effects in the active scope',
            }));
        } else if (/\b(?:mute|silent|silence|turn\s+off)\b/i.test(raw)) {
            operations.push(_operation('set-sfx-volume', { volume: 0 }, request, {
                description: 'mute sound effects in the active scope',
            }));
        } else if (amount != null) {
            operations.push(_operation('set-sfx-volume', { volume: amount }, request, {
                description: `set sound-effect volume to ${Math.round(amount * 100)} percent`,
            }));
        } else if (/\b(?:louder|increase|boost|stronger)\b/i.test(raw)) {
            operations.push(_operation('set-sfx-volume', { scale: 1.25 }, request, {
                description: 'raise sound-effect volume in the active scope',
            }));
        } else if (/\b(?:quieter|decrease|reduce|softer|lower)\b/i.test(raw)) {
            operations.push(_operation('set-sfx-volume', { scale: 0.75 }, request, {
                description: 'lower sound-effect volume in the active scope',
            }));
        }
    }

    const narrationContext = /\b(?:narration|voice[\s-]?over|voiceover)\b/i.test(raw);
    if (narrationContext) {
        const amount = _percent(raw);
        if (/\b(?:mute|silent|silence|turn\s+off)\b/i.test(raw)) {
            operations.push(_operation('set-narration-volume', { volume: 0 }, request, {
                global: true,
                description: 'mute narration',
            }));
        } else if (amount != null) {
            operations.push(_operation('set-narration-volume', { volume: amount }, request, {
                global: true,
                description: `set narration volume to ${Math.round(amount * 100)} percent`,
            }));
        } else if (/\b(?:louder|increase|boost)\b/i.test(raw)) {
            operations.push(_operation('set-narration-volume', { scale: 1.15 }, request, {
                global: true,
                description: 'raise narration volume',
            }));
        } else if (/\b(?:quieter|decrease|reduce|lower)\b/i.test(raw)) {
            operations.push(_operation('set-narration-volume', { scale: 0.85 }, request, {
                global: true,
                description: 'lower narration volume',
            }));
        }
    }

    const musicContext = /\b(?:background\s+music|music\s+bed|music)\b/i.test(raw);
    if (musicContext) {
        const amount = _percent(raw);
        if (/\b(?:remove|delete|clear|mute|silent|turn\s+off|no)\b/i.test(raw)) {
            operations.push(_operation('remove-music', {}, request, {
                global: true,
                description: 'remove the background music bed',
            }));
        } else if (amount != null) {
            operations.push(_operation('set-music-volume', { volume: amount }, request, {
                global: true,
                description: `set background-music volume to ${Math.round(amount * 100)} percent`,
            }));
        } else if (/\b(?:louder|increase|boost)\b/i.test(raw)) {
            operations.push(_operation('set-music-volume', { scale: 1.25 }, request, {
                global: true,
                description: 'raise background-music volume',
            }));
        } else if (/\b(?:quieter|decrease|reduce|lower)\b/i.test(raw)) {
            operations.push(_operation('set-music-volume', { scale: 0.75 }, request, {
                global: true,
                description: 'lower background-music volume',
            }));
        }
    }

    return operations.length
        ? {
            operations,
            claimedDirectiveKeys: [],
            supported: operations.map((operation) => `Audio Editor: ${operation.description}`),
        }
        : { operations: [], claimedDirectiveKeys: [] };
}

function normalizeInvocation(invocation, context) {
    const action = String(invocation?.action || '');
    const source = invocation?.args || {};
    if (action === 'remove-sfx') return _operation(action, {}, context.request);
    if (action === 'remove-music') return _operation(action, {}, context.request, { global: true });
    if (['set-sfx-volume', 'set-narration-volume', 'set-music-volume'].includes(action)) {
        const args = {};
        if (Number.isFinite(Number(source.volume))) args.volume = Number(source.volume);
        if (Number.isFinite(Number(source.scale))) args.scale = Number(source.scale);
        if (!Object.keys(args).length) return null;
        return _operation(action, args, context.request, {
            global: action !== 'set-sfx-volume',
            description: String(invocation.description || ''),
        });
    }
    return null;
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'audio',
        specialist: 'Audio Editor',
        domain: 'audio',
        description: 'Controls narration level, music-bed level, and scoped sound effects.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'low',
        actions: [
            'set-sfx-volume',
            'remove-sfx',
            'set-narration-volume',
            'set-music-volume',
            'remove-music',
        ],
        directiveKeys: [],
    };
}

function _sfxTargets(plan, scope) {
    const clips = Array.isArray(plan.sfxClips) ? plan.sfxClips : [];
    if (scope?.kind === 'project') return clips;
    const range = scopeRange(scope, plan);
    return clips.filter((clip) => overlaps(clip, range.fromSec, range.toSec));
}

function _setVolume(current, args, fallback) {
    if (Number.isFinite(Number(args.volume))) {
        return Math.max(0, Math.min(1, Number(args.volume)));
    }
    return Math.max(0, Math.min(1, (Number(current) || fallback) * Number(args.scale || 1)));
}

function execute({ plan, operation }) {
    const action = operation.action;
    if (action === 'set-narration-volume') {
        const before = Number.isFinite(Number(plan.narrationVolume)) ? Number(plan.narrationVolume) : 1;
        plan.narrationVolume = _setVolume(before, operation.args, 1);
        if (Math.abs(before - plan.narrationVolume) < 0.0001) throw new Error('Narration already uses that volume');
        return { changed: 1, stats: { narrationVolumeChanged: 1 } };
    }
    if (action === 'set-music-volume') {
        if (!plan.musicBed) throw new Error('This project has no background music bed');
        const before = Number.isFinite(Number(plan.musicBedGain)) ? Number(plan.musicBedGain) : 0.18;
        plan.musicBedGain = _setVolume(before, operation.args, 0.18);
        if (Math.abs(before - plan.musicBedGain) < 0.0001) throw new Error('Background music already uses that volume');
        return { changed: 1, stats: { musicVolumeChanged: 1 } };
    }
    if (action === 'remove-music') {
        if (!plan.musicBed) throw new Error('This project already has no background music');
        delete plan.musicBed;
        delete plan.musicBedGain;
        return { changed: 1, stats: { musicRemoved: 1 } };
    }
    const targets = _sfxTargets(plan, operation.scope);
    if (!targets.length) throw new Error('No sound effects exist in the active scope');
    if (action === 'remove-sfx') {
        const remove = new Set(targets);
        plan.sfxClips = plan.sfxClips.filter((clip) => !remove.has(clip));
        return { changed: targets.length, stats: { sfxRemoved: targets.length } };
    }
    if (action === 'set-sfx-volume') {
        let changed = 0;
        for (const clip of targets) {
            const before = Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 0.35;
            clip.volume = _setVolume(before, operation.args, 0.35);
            if (Math.abs(before - clip.volume) > 0.0001) changed++;
        }
        if (!changed) throw new Error('Sound effects already use that volume');
        return { changed, stats: { sfxVolumeChanged: changed } };
    }
    throw new Error(`Unsupported audio action: ${action}`);
}

function inspect(plan, scope) {
    const targets = _sfxTargets(plan, scope);
    return {
        targetCount: targets.length,
        subtitlesEnabled: plan?.subtitlesEnabled === true,
        narrationVolume: Number.isFinite(Number(plan?.narrationVolume)) ? Number(plan.narrationVolume) : 1,
        musicBed: String(plan?.musicBed || ''),
        musicBedGain: Number.isFinite(Number(plan?.musicBedGain)) ? Number(plan.musicBedGain) : 0.18,
        sfx: targets.slice(0, 64).map((clip) => ({
            file: clip.file || '',
            startTime: windowOf(clip).startTime,
            duration: windowOf(clip).endTime - windowOf(clip).startTime,
            volume: Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 0.35,
        })),
    };
}

module.exports = { execute, inspect, manifest, normalizeInvocation, planFast, tools };
