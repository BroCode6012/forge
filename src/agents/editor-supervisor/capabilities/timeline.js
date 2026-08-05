'use strict';

const path = require('path');
const { overlaps, resolveSceneTargets, windowOf } = require('../scope-utils');
const {
    boolean: booleanField,
    number,
    object,
    string,
    tool,
} = require('./capability-contract');

const TRACKS = new Set(['video-track-1', 'video-track-2', 'video-track-3']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

function tools() {
    return [
        tool('set-ken-burns', 'Enable, disable, or retime still-image Ken Burns motion.', object({
            enabled: booleanField(),
            speed: number({ min: 0.25, max: 2 }),
        }, {
            anyOfRequired: [['enabled'], ['speed']],
        }), { visualRepair: true }),
        tool('set-source-offset', 'Choose the source-media start offset for selected video clips.', object({
            offset: number({ min: 0 }),
        }, { required: ['offset'] }), { risk: 'moderate', visualImpact: true }),
        tool('move-track', 'Move selected clips to a renderer-backed video track.', object({
            trackId: string({ enum: [...TRACKS] }),
        }, { required: ['trackId'] }), { risk: 'moderate', visualImpact: true }),
        tool('set-visibility', 'Show or safely hide selected clips.', object({
            visible: booleanField(),
        }, { required: ['visible'] }), { risk: 'moderate', visualImpact: true }),
    ];
}

function _operation(action, args, request, description, risk = 'low') {
    return {
        capabilityId: 'timeline',
        specialist: 'Timeline Editor',
        action,
        args,
        scope: request.scope,
        risk,
        description,
        progress: {
            phase: 'timeline',
            message: 'Timeline Editor is applying the selected clip operation...',
        },
    };
}

function _mediaKind(scene) {
    const explicit = String(scene?.mediaType || '').toLowerCase();
    if (explicit === 'image' || explicit === 'video') return explicit;
    const source = String(
        scene?.mediaFile
        || scene?.mediaPath
        || scene?.videoFile
        || scene?.imageFile
        || ''
    );
    const ext = path.extname(source).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    return '';
}

function planFast({ text, request }) {
    if (request.scope.kind === 'visual') return { operations: [], claimedDirectiveKeys: [] };
    const raw = String(text || '');
    const operations = [];

    if (/\bken\s+burns\b|\bslow\s+(?:zoom|pan)\b|\bphoto\s+motion\b/i.test(raw)) {
        const enabled = !/\b(?:disable|turn\s+off|remove|no|stop)\b/i.test(raw);
        const speedMatch = raw.match(/\b([0-3](?:\.\d+)?)\s*x\b/i);
        const speed = speedMatch
            ? Number(speedMatch[1])
            : /\b(?:faster|quicker)\b/i.test(raw)
                ? 1.35
                : /\b(?:slower|gentler|subtle)\b/i.test(raw)
                    ? 0.72
                    : null;
        operations.push(_operation(
            'set-ken-burns',
            { enabled, ...(speed != null ? { speed } : {}) },
            request,
            `${enabled ? 'enable' : 'disable'} Ken Burns motion${speed != null ? ` at ${speed}x` : ''}`
        ));
    }

    const offset = raw.match(
        /\b(?:use|start|begin|shift)\b.{0,24}\b(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\s+(?:later|into|after)\b/i
    ) || raw.match(
        /\b(?:source|media|clip)\s+offset\b.{0,16}\b(?:to|at)\b\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\b/i
    );
    if (offset) {
        operations.push(_operation(
            'set-source-offset',
            { offset: Number(offset[1]) },
            request,
            `start the selected source media at ${Number(offset[1])} seconds`,
            'moderate'
        ));
    }

    const track = raw.match(/\b(?:move|send|put)\b.{0,24}\b(?:video\s+)?track\s*([123])\b/i);
    if (track) {
        const trackId = `video-track-${track[1]}`;
        operations.push(_operation(
            'move-track',
            { trackId },
            request,
            `move the selected clip${request.scope.clipRefs?.length === 1 ? '' : 's'} to ${trackId}`,
            'moderate'
        ));
    }

    if (/\b(?:show|enable|unhide|restore)\b.{0,18}\b(?:clip|clips|selection)\b/i.test(raw)) {
        operations.push(_operation('set-visibility', { visible: true }, request, 'show the selected clips'));
    } else if (/\b(?:hide|disable)\b.{0,18}\b(?:clip|clips|selection)\b/i.test(raw)) {
        operations.push(_operation('set-visibility', { visible: false }, request, 'hide the selected clips', 'moderate'));
    }

    return operations.length
        ? {
            operations,
            claimedDirectiveKeys: [],
            supported: operations.map((operation) => `Timeline Editor: ${operation.description}`),
        }
        : { operations: [], claimedDirectiveKeys: [] };
}

function normalizeInvocation(invocation, context) {
    if (context.request.scope.kind === 'visual') return null;
    const action = String(invocation?.action || '');
    const source = invocation?.args || {};
    if (action === 'set-ken-burns') {
        if (typeof source.enabled !== 'boolean' && !Number.isFinite(Number(source.speed))) return null;
        return _operation(
            action,
            {
                ...(typeof source.enabled === 'boolean' ? { enabled: source.enabled } : {}),
                ...(Number.isFinite(Number(source.speed)) ? { speed: Number(source.speed) } : {}),
            },
            context.request,
            String(invocation.description || 'edit Ken Burns motion')
        );
    }
    if (action === 'set-source-offset') {
        if (!Number.isFinite(Number(source.offset))) return null;
        return _operation(
            action,
            { offset: Number(source.offset) },
            context.request,
            String(invocation.description || 'change the source-media offset'),
            'moderate'
        );
    }
    if (action === 'move-track') {
        const trackId = String(source.trackId || '');
        if (!TRACKS.has(trackId)) return null;
        return _operation(
            action,
            { trackId },
            context.request,
            String(invocation.description || `move clips to ${trackId}`),
            'moderate'
        );
    }
    if (action === 'set-visibility') {
        if (typeof source.visible !== 'boolean') return null;
        return _operation(
            action,
            { visible: source.visible },
            context.request,
            String(invocation.description || `${source.visible ? 'show' : 'hide'} selected clips`),
            source.visible ? 'low' : 'moderate'
        );
    }
    return null;
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'timeline',
        specialist: 'Timeline Editor',
        domain: 'timeline',
        description: 'Controls exact clip tracks, source offsets, still-image motion, and safe clip visibility.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'moderate',
        actions: [
            'set-ken-burns',
            'set-source-offset',
            'move-track',
            'set-visibility',
        ],
        directiveKeys: [],
        vocabulary: { tracks: [...TRACKS] },
        examples: [
            'Turn off Ken Burns for this image',
            'Use the moment two seconds later in this clip',
            'Move this overlay clip to video track 2',
        ],
    };
}

function _hasCoverage(plan, target) {
    const timing = windowOf(target);
    return (plan?.scenes || []).some((scene) => {
        if (!scene || scene === target || scene.isMGScene || scene.disabled) return false;
        return overlaps(scene, timing.startTime, timing.endTime)
            && windowOf(scene).startTime <= timing.startTime + 0.05
            && windowOf(scene).endTime >= timing.endTime - 0.05;
    });
}

function execute({ plan, operation }) {
    const targets = resolveSceneTargets(plan, operation.scope, { includeDescendants: true });
    if (!targets.length) throw new Error('No exact clips match the active timeline scope');
    let changed = 0;
    if (operation.action === 'set-ken-burns') {
        const images = targets.filter((scene) => _mediaKind(scene) === 'image');
        if (!images.length) throw new Error('Ken Burns motion applies only to still-image clips in the active scope');
        for (const scene of images) {
            const before = JSON.stringify({
                kenBurns: scene.kenBurns,
                kenBurnsEnabled: scene.kenBurnsEnabled,
                kenBurnsSpeed: scene.kenBurnsSpeed,
            });
            if (typeof operation.args.enabled === 'boolean') {
                scene.kenBurns = operation.args.enabled;
                scene.kenBurnsEnabled = operation.args.enabled;
            }
            if (Number.isFinite(Number(operation.args.speed))) {
                scene.kenBurnsSpeed = Math.max(0.25, Math.min(2, Number(operation.args.speed)));
            }
            const after = JSON.stringify({
                kenBurns: scene.kenBurns,
                kenBurnsEnabled: scene.kenBurnsEnabled,
                kenBurnsSpeed: scene.kenBurnsSpeed,
            });
            if (before !== after) changed++;
        }
        if (!changed) throw new Error('The selected still images already use those Ken Burns settings');
        return { changed, stats: { clipMotionChanged: changed } };
    }
    if (operation.action === 'set-source-offset') {
        const videos = targets.filter((scene) => _mediaKind(scene) === 'video');
        if (!videos.length) throw new Error('Source offsets apply only to video clips in the active scope');
        const offset = Math.max(0, Number(operation.args.offset) || 0);
        for (const scene of videos) {
            const before = Number(scene.mediaOffset) || 0;
            scene.mediaOffset = offset;
            if (Math.abs(before - offset) > 0.001) changed++;
        }
        if (!changed) throw new Error('The selected video clips already use that source offset');
        return { changed, stats: { sourceOffsetsChanged: changed } };
    }
    if (operation.action === 'move-track') {
        const trackId = String(operation.args.trackId || '');
        if (!TRACKS.has(trackId)) throw new Error('Timeline Editor received an invalid video track');
        for (const scene of targets) {
            if (String(scene.trackId || 'video-track-1') === trackId) continue;
            scene.trackId = trackId;
            changed++;
        }
        if (!changed) throw new Error(`The selected clips are already on ${trackId}`);
        return { changed, stats: { clipTracksChanged: changed } };
    }
    if (operation.action === 'set-visibility') {
        const visible = operation.args.visible === true;
        for (const scene of targets) {
            if (!visible && String(scene.trackId || 'video-track-1') === 'video-track-1' && !_hasCoverage(plan, scene)) {
                throw new Error(`Hiding clip ${scene.clipId || ''} would leave an uncovered base-video gap`);
            }
            const nextDisabled = !visible;
            if (scene.disabled === nextDisabled) continue;
            scene.disabled = nextDisabled;
            changed++;
        }
        if (!changed) throw new Error(`The selected clips are already ${visible ? 'visible' : 'hidden'}`);
        return { changed, stats: { clipVisibilityChanged: changed } };
    }
    throw new Error(`Unsupported timeline action: ${operation.action}`);
}

function inspect(plan, scope) {
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    return {
        targetCount: targets.length,
        scenes: targets.slice(0, 48).map((scene) => ({
            clipId: scene.clipId || '',
            trackId: scene.trackId || 'video-track-1',
            startTime: Number(scene.startTime) || 0,
            endTime: Number(scene.endTime) || 0,
            mediaKind: _mediaKind(scene),
            visible: scene.disabled !== true,
            mediaOffset: Number(scene.mediaOffset) || 0,
            kenBurns: scene.kenBurns !== false && scene.kenBurnsEnabled !== false,
            kenBurnsSpeed: Number(scene.kenBurnsSpeed) || 1,
        })),
    };
}

module.exports = { execute, inspect, manifest, normalizeInvocation, planFast, tools };
