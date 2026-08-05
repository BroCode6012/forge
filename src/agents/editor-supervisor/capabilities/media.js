'use strict';

const { replaceScopedMedia } = require('../workers/media-editor');
const { resolveSceneTargets } = require('../scope-utils');
const { CANONICAL_SOURCE_HINTS } = require('../../../media/source-policy');
const {
    array,
    boolean: booleanField,
    object,
    string,
    tool,
} = require('./capability-contract');

const MEDIA_REPLACEMENT_ARGS = object({
    query: string({ maxLength: 500 }),
    replacementQuery: string({ maxLength: 500 }),
    style: string({ maxLength: 240 }),
    mediaType: string({ enum: ['', 'video', 'image'] }),
    sourceHint: string({ enum: ['', ...CANONICAL_SOURCE_HINTS] }),
    preferredSources: array(string({ enum: CANONICAL_SOURCE_HINTS }), { maxItems: 8, uniqueItems: true }),
    bannedSources: array(string({ enum: CANONICAL_SOURCE_HINTS }), { maxItems: 8, uniqueItems: true }),
    preferImages: booleanField(),
    preferVideos: booleanField(),
    preferReal: booleanField(),
    avoidStock: booleanField(),
    replace: booleanField(),
    effort: string({ enum: ['', 'fast', 'smart'] }),
});

function tools() {
    return [
        tool('replace', 'Find, score, download, and transactionally stage replacement media.', MEDIA_REPLACEMENT_ARGS, {
            risk: 'expensive',
            visualImpact: true,
        }),
        tool('replace-media', 'Replace selected footage or images.', MEDIA_REPLACEMENT_ARGS, {
            canonicalAction: 'replace',
            risk: 'expensive',
        }),
        tool('find-alternative', 'Find a stronger alternative for selected media.', MEDIA_REPLACEMENT_ARGS, {
            canonicalAction: 'replace',
            risk: 'expensive',
        }),
    ];
}

function _safeMediaRef(scene) {
    const value = String(
        scene?.mediaFile
        || scene?.mediaPath
        || scene?.videoFile
        || scene?.imageFile
        || ''
    );
    return value.split(/[\\/]/).filter(Boolean).pop() || '';
}

function _operation(footage, request) {
    const preferredSource = Array.isArray(footage.preferredSources)
        ? footage.preferredSources.find(Boolean)
        : '';
    return {
        capabilityId: 'media',
        specialist: 'Media Editor',
        action: 'replace',
        args: {
            query: footage.replacementQuery || footage.query || '',
            style: footage.style || '',
            mediaType: footage.mediaType
                || (footage.preferImages ? 'image' : (footage.preferVideos ? 'video' : '')),
            sourceHint: footage.sourceHint
                || preferredSource
                || (footage.avoidStock || footage.preferReal ? 'youtube' : ''),
            effort: request.effort,
        },
        scope: request.scope,
        risk: 'expensive',
        description: 'find, score, and stage replacement media',
        progress: {
            phase: 'media',
            message: 'Media Editor is searching, scoring, and staging replacement footage...',
        },
    };
}

function _isReplacement(footage) {
    return footage && (
        footage.replace
        || footage.preferReal
        || footage.avoidStock
        || footage.preferImages
        || footage.preferVideos
        || footage.preferredSources?.length
        || footage.bannedSources?.length
    );
}

function planFast({ directives, request }) {
    const footage = directives?.footage;
    if (!_isReplacement(footage)) return { operations: [], claimedDirectiveKeys: [] };
    if (request.scope.kind === 'visual') {
        return {
            operations: [],
            claimedDirectiveKeys: ['footage'],
            unsupported: ['Footage replacement needs footage clips, not only a selected graphic.'],
        };
    }
    return {
        operations: [_operation(footage, request)],
        claimedDirectiveKeys: ['footage'],
        supported: ['Media Editor: replacement footage'],
    };
}

function normalizeInvocation(invocation, context) {
    if (!['replace', 'replace-media', 'find-alternative'].includes(String(invocation?.action || ''))) return null;
    if (context.request.scope.kind === 'visual') return null;
    return _operation(invocation?.args || { replace: true }, context.request);
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'media',
        specialist: 'Media Editor',
        domain: 'media',
        description: 'Finds, scores, downloads, and transactionally stages replacement footage or images.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'expensive',
        actions: ['replace', 'replace-media', 'find-alternative'],
        directiveKeys: ['footage'],
        vocabulary: {
            mediaTypes: ['video', 'image'],
            sources: CANONICAL_SOURCE_HINTS,
        },
    };
}

async function execute({ plan, operation, options }) {
    const result = await replaceScopedMedia(plan, operation.scope, {
        ...operation.args,
        effort: operation.args.effort || options.effort,
    }, {
        projectDir: options.projectDir,
        transactionId: options.transactionId,
        mediaDownloader: options.mediaDownloader,
        log: options.log,
    });
    return {
        changed: result.changed,
        assetManifest: result.assetManifest,
        stats: { mediaReplaced: result.changed },
        diagnostics: result.replacements,
    };
}

function inspect(plan, scope) {
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    return {
        targetCount: targets.length,
        scenes: targets.slice(0, 32).map((scene) => ({
            clipId: scene.clipId || '',
            startTime: Number(scene.startTime) || 0,
            endTime: Number(scene.endTime) || 0,
            mediaType: scene.mediaType || '',
            mediaRef: _safeMediaRef(scene),
            provider: scene.sourceProvider || '',
            sourceHint: scene.sourceHint || '',
            query: scene.searchKeyword || scene.keyword || '',
            visionScore: Number.isFinite(Number(scene.visionScore)) ? Number(scene.visionScore) : null,
        })),
    };
}

module.exports = { execute, inspect, manifest, normalizeInvocation, planFast, tools };
