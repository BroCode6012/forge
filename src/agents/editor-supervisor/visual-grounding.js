'use strict';

const { parseJsonObject } = require('../../brain/strict-json');
const { windowOf } = require('./scope-utils');
const capabilityRegistry = require('./capabilities/registry');

const VISUAL_REFERENCE = /\b(?:this|that|these|those|it|here|there|visible|shown|screen|preview)\b/i;
const VAGUE_VISUAL_NOUN = /\b(?:bar|line|rule|rail|strip|box|plate|shape|thing|object|element|part|mark|decoration|icon|graphic|text|background|overlay)\b/i;
const VISUAL_POINTING = /\b(?:look\s+at|you\s+see|i\s+see|shown\s+here|on\s+(?:the\s+)?screen|in\s+(?:the\s+)?preview)\b/i;
const EDIT_VERB = /\b(?:remove|delete|hide|clear|change|make|turn|move|place|position|recolou?r|resize|replace|edit|fix)\b/i;

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _compact(value, max = 500) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function shouldGroundVisualRequest(payload = {}) {
    if (payload.effort !== 'smart') return false;
    const text = String(payload.originalText || payload.text || '');
    if (!text.trim()) return false;
    return VISUAL_POINTING.test(text)
        || (
            EDIT_VERB.test(text)
            && VISUAL_REFERENCE.test(text)
            && VAGUE_VISUAL_NOUN.test(text)
        )
        || (
            EDIT_VERB.test(text)
            && /\b(?:this|that|it)\b/i.test(text)
            && !/\b(?:head(?:lines?|ings?|lings?|ines?)|lower[\s-]?third|caption|subtitle|transition|vignette|grain|footage|clip|image|video)\b/i.test(text)
        );
}

function _visualId(visual, collection, index) {
    return String(visual?.id || visual?.clipId || `${collection}-${index}`);
}

function _graphicType(visual) {
    return String(visual?.type || visual?.templateType || visual?.mgType || 'graphic');
}

function _activeAt(item, time, fallbackDuration = 3) {
    const timing = windowOf(item, fallbackDuration);
    return time >= timing.startTime - 0.04 && time <= timing.endTime + 0.04;
}

function activeLayerInventory(plan, request) {
    const time = Math.max(
        0,
        Number(request?.visualContext?.currentTime ?? request?.scope?.currentTime) || 0
    );
    const layers = [];
    for (const [index, scene] of (plan?.scenes || []).entries()) {
        if (!scene || scene.isMGScene || scene.disabled === true || !_activeAt(scene, time, 0.2)) continue;
        layers.push({
            kind: 'footage',
            id: String(scene.clipId || `scene-${index}`),
            type: String(scene.mediaType || scene.sourceHint || 'media'),
            label: _compact(scene.text || scene.keyword || `Scene ${index + 1}`, 180),
            trackId: String(scene.trackId || 'video-track-1'),
            editableParts: ['media', 'framing', 'look'],
        });
        const iconMoments = Array.isArray(scene._iconMoments) ? scene._iconMoments : [];
        iconMoments.forEach((moment, momentIndex) => {
            const start = (Number(scene.startTime) || 0) + (Number(moment?.at) || 0);
            const end = start + Math.max(0.1, Number(moment?.dur) || 1.4);
            if (time < start - 0.04 || time > end + 0.04) return;
            layers.push({
                kind: 'icon',
                id: `${String(scene.clipId || `scene-${index}`)}:icon:${momentIndex}`,
                type: String(moment?.kind || 'icon'),
                label: _compact(moment?.concept || moment?.label || 'Scene icon', 180),
                position: String(moment?.position || ''),
                color: String(moment?.color || ''),
                editableParts: ['icon'],
            });
        });
    }

    for (const collection of ['motionGraphics', 'mgScenes', 'templateScenes']) {
        (plan?.[collection] || []).forEach((visual, index) => {
            if (!visual || visual.disabled === true || !_activeAt(visual, time, collection === 'templateScenes' ? 4 : 3)) return;
            const type = _graphicType(visual);
            const accentRuleVisible = visual.accentRuleVisible !== false
                && visual?.mgData?.accentRuleVisible !== false
                && visual?.agenticComposition?.style?.accentRule !== false
                && visual?.mgData?.agenticComposition?.style?.accentRule !== false;
            layers.push({
                kind: 'graphic',
                id: _visualId(visual, collection, index),
                type,
                label: _compact(
                    visual.text
                    || visual.title
                    || visual.headline
                    || visual.label
                    || visual?.mgData?.text
                    || type,
                    220
                ),
                collection,
                position: String(visual.position || ''),
                variant: String(visual.subType || visual.variant || ''),
                animation: String(visual.animation || ''),
                cardStyle: String(visual.cardStyle || ''),
                colors: _clone(visual.colors || visual?.mgData?.colors || {}),
                accentRuleVisible,
                editableParts: [
                    'text',
                    'card-background',
                    'position',
                    'shadow',
                    'accent-rule',
                    'duration',
                ],
            });
        });
    }
    return {
        time,
        layers: layers.slice(0, 32),
    };
}

function _groundedToolCatalog() {
    return capabilityRegistry.listManifests()
        .map((manifest) => ({
            capabilityId: manifest.id,
            specialist: manifest.specialist,
            tools: (manifest.tools || []).filter((toolSpec) => (
                toolSpec.action === toolSpec.canonicalAction
                && toolSpec.visualTargets?.length
            )).map((toolSpec) => ({
                action: toolSpec.action,
                description: toolSpec.description,
                args: toolSpec.args,
                visualTargets: toolSpec.visualTargets,
            })),
        }))
        .filter((entry) => entry.tools.length);
}

function _safeGroundedInvocation(invocation, target, request) {
    if (!invocation || !target) return null;
    const capabilityId = String(invocation.capabilityId || '');
    const action = String(invocation.action || '');
    const manifest = capabilityRegistry.getCapability(capabilityId)?.manifest;
    const toolSpec = manifest?.tools?.find((candidate) => (
        candidate.action === action
        && candidate.action === candidate.canonicalAction
        && candidate.visualTargets?.includes(target.kind)
    ));
    if (!toolSpec) return null;

    const args = _clone(
        invocation.args && typeof invocation.args === 'object'
            ? invocation.args
            : {}
    );
    if (target.kind === 'graphic') {
        args.targetType = target.type;
        args.targetIds = [target.id];
        args.all = false;
    } else if (target.kind === 'icon') {
        args.targetIds = [target.id];
        args.all = false;
    }
    const normalized = capabilityRegistry.tryNormalizeInvocation({
        capabilityId,
        action,
        args,
        description: _compact(
            invocation.description
            || `edit the visible ${target.type} ${target.semanticPart || 'element'}`,
            300
        ),
    }, {
        request,
        plan: null,
        existingOperations: [],
        log: () => { },
    });
    if (!normalized.operation) return null;
    const normalizedIds = normalized.operation.args?.targetIds || [];
    if (normalizedIds.length && (
        normalizedIds.length !== 1
        || String(normalizedIds[0]) !== String(target.id)
    )) return null;
    return {
        capabilityId: normalized.operation.capabilityId,
        action: normalized.operation.action,
        args: normalized.operation.args,
        description: normalized.operation.description,
    };
}

function coerceVisualGrounding(raw, inventory, request) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const confidence = Math.max(0, Math.min(1, Number(source.confidence) || 0));
    const targetSource = source.target && typeof source.target === 'object' ? source.target : {};
    const requestedId = String(targetSource.id || targetSource.targetId || '');
    const candidate = inventory.layers.find((layer) => layer.id === requestedId) || null;
    const semanticPart = _compact(targetSource.semanticPart || targetSource.part || '', 80);
    const target = candidate
        ? {
            ...candidate,
            semanticPart,
            visibleDescription: _compact(
                targetSource.visibleDescription || source.visibleDescription || '',
                300
            ),
        }
        : null;
    const grounded = Boolean(target && confidence >= 0.62);
    const invocation = grounded
        ? _safeGroundedInvocation(source.invocation, target, request)
        : null;
    return {
        required: true,
        status: grounded ? 'grounded' : 'ambiguous',
        screenshotUsed: true,
        frameTime: inventory.time,
        confidence,
        summary: _compact(
            source.summary
            || (
                grounded
                    ? `Identified ${target.visibleDescription || target.semanticPart || target.label}.`
                    : 'The visible reference could not be mapped confidently to one editable layer.'
            ),
            500
        ),
        target,
        invocation,
        message: grounded
            ? ''
            : 'I inspected the exact playhead frame but could not confidently map the visible object to one editable layer. Select the graphic or describe its position more precisely.',
        requestText: _compact(request?.originalText || request?.text || '', 600),
    };
}

function _prompt(request, inventory) {
    const groundedTools = _groundedToolCatalog();
    return `You are the visual-grounding observer inside a professional video editor.
The supplied image is an exact screenshot of the preview at ${inventory.time.toFixed(3)} seconds.
Your job is to resolve what visible object the user is pointing at, then map it to ONE candidate layer and, only when safe, ONE declared edit invocation.

USER REQUEST:
${String(request?.originalText || request?.text || '')}

ACTIVE EDITABLE LAYERS AT THIS EXACT FRAME:
${JSON.stringify(inventory.layers)}

RENDERED SUB-PART VOCABULARY:
- "accent-rule": a thin decorative colored bar, rail, or line next to graphic text. It is separate from the card/background.
- "card-background": the box, plate, panel, or fill behind graphic text.
- "text": visible graphic wording.
- "icon": a separate pictogram, symbol, or cutout.
- "media": the underlying photograph or video.

SAFE VISUAL TOOL CONTRACTS:
${JSON.stringify(groundedTools)}

Choose at most one tool whose visualTargets includes the identified target kind.
Use only arguments declared by that tool. The application will inject the exact target id and type.
Include only properties explicitly requested. Preserve all unrelated design, copy, timing, media, and effects.
Never interpret a thin accent-rule as the whole graphic background.
If the visible object cannot be mapped confidently to exactly one listed layer, return invocation:null.

Return strict JSON:
{
  "summary": "what the user is visibly referring to",
  "confidence": 0.0,
  "target": {
    "id": "exact candidate id or empty",
    "kind": "graphic|icon|footage|",
    "type": "candidate type",
    "semanticPart": "accent-rule|card-background|text|icon|media|unknown",
    "visibleDescription": "appearance and location in the screenshot"
  },
  "invocation": null
}`;
}

async function groundVisualRequest(request, plan, options = {}) {
    if (!shouldGroundVisualRequest(request)) {
        return {
            required: false,
            status: 'skipped',
            screenshotUsed: false,
        };
    }
    const visualContext = request?.visualContext;
    if (!visualContext?.captured || !visualContext.imageBase64) {
        return {
            required: true,
            status: 'unavailable',
            screenshotUsed: false,
            frameTime: Math.max(0, Number(request?.scope?.currentTime) || 0),
            confidence: 0,
            summary: 'The exact playhead frame could not be captured.',
            target: null,
            invocation: null,
            message: 'I could not capture the exact preview frame. Keep the playhead on the object and try again.',
        };
    }
    const inventory = activeLayerInventory(plan, request);
    if (!inventory.layers.length) {
        return {
            required: true,
            status: 'ambiguous',
            screenshotUsed: true,
            frameTime: inventory.time,
            confidence: 0,
            summary: 'No editable layer was active at the captured playhead frame.',
            target: null,
            invocation: null,
            message: 'No editable layer was active at that playhead position.',
        };
    }
    try {
        let callVisionAI = options.callVisionAI;
        if (!callVisionAI) {
            const provider = require('../../brain/ai-provider');
            if (!provider.isVisionAIAvailable()) {
                throw new Error('vision provider unavailable');
            }
            callVisionAI = provider.callVisionAI;
        }
        const rawText = await callVisionAI(
            _prompt(request, inventory),
            visualContext.imageBase64,
            visualContext.mimeType || 'image/jpeg',
            {
                maxTokens: 900,
                taskType: 'editor-visual-grounding',
            }
        );
        const parsed = parseJsonObject(rawText);
        return coerceVisualGrounding(parsed, inventory, request);
    } catch (error) {
        options.log?.(`Visual grounding unavailable: ${error.message}`);
        return {
            required: true,
            status: 'unavailable',
            screenshotUsed: true,
            frameTime: inventory.time,
            confidence: 0,
            summary: `The playhead screenshot was captured, but visual identification was unavailable: ${_compact(error.message, 180)}`,
            target: null,
            invocation: null,
            message: 'I captured the frame but could not visually identify the object. Select the exact graphic or describe its location more precisely.',
        };
    }
}

function publicVisualGrounding(grounding) {
    if (!grounding || grounding.required !== true) return null;
    return {
        status: grounding.status,
        screenshotUsed: grounding.screenshotUsed === true,
        frameTime: Math.max(0, Number(grounding.frameTime) || 0),
        confidence: Math.max(0, Math.min(1, Number(grounding.confidence) || 0)),
        summary: _compact(grounding.summary, 500),
        message: _compact(grounding.message, 500),
        target: grounding.target
            ? {
                id: String(grounding.target.id || ''),
                kind: String(grounding.target.kind || ''),
                type: String(grounding.target.type || ''),
                semanticPart: String(grounding.target.semanticPart || ''),
                visibleDescription: _compact(grounding.target.visibleDescription, 300),
            }
            : null,
    };
}

module.exports = {
    activeLayerInventory,
    coerceVisualGrounding,
    groundVisualRequest,
    publicVisualGrounding,
    shouldGroundVisualRequest,
};
