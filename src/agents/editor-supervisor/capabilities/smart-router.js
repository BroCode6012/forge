'use strict';

const registry = require('./registry');

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _compactScene(scene, fallbackIndex) {
    return {
        index: Number.isFinite(Number(scene?.index)) ? Number(scene.index) : fallbackIndex,
        clipId: String(scene?.clipId || ''),
        startTime: Number(scene?.startTime) || 0,
        endTime: Number(scene?.endTime) || 0,
        text: String(scene?.text || '').slice(0, 220),
        keyword: String(scene?.keyword || scene?.searchKeyword || '').slice(0, 120),
        mediaType: String(scene?.mediaType || ''),
        framing: String(scene?.framing || scene?.framingMode || ''),
    };
}

function _projectSnapshot(plan, request) {
    const scenes = (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    const scope = request?.scope || {};
    let selected = scenes;
    if (scope.kind !== 'project') {
        const from = Number(scope.fromSec);
        const to = Number(scope.toSec);
        if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
            selected = scenes.filter((scene) => (
                Number(scene.endTime) > from && Number(scene.startTime) < to
            ));
        }
    }
    return {
        title: String(plan?.scriptContext?.videoTitle || plan?.title || ''),
        themeId: String(plan?.scriptContext?.themeId || ''),
        nicheId: String(plan?.scriptContext?.nicheId || ''),
        productionMode: String(plan?.scriptContext?.productionMode || ''),
        scope: _clone(scope),
        selectedScenes: selected.slice(0, 24).map(_compactScene),
        totalScenes: scenes.length,
    };
}

function _signature(operation) {
    return JSON.stringify({
        capabilityId: operation.capabilityId,
        action: operation.action,
        args: operation.args,
        scope: operation.scope,
    });
}

function _routerManifests() {
    return registry.listManifests().map((manifest) => ({
        id: manifest.id,
        specialist: manifest.specialist,
        description: manifest.description,
        scopes: manifest.scopes,
        contractVersion: manifest.contractVersion,
        contractHash: manifest.contractHash,
        tools: (manifest.tools || []).filter((toolSpec) => (
            toolSpec.action === toolSpec.canonicalAction
        )),
        vocabulary: manifest.vocabulary || {},
        examples: manifest.examples || [],
        limitations: manifest.limitations || [],
        risk: manifest.risk,
    }));
}

function coerceSmartPlan(raw, context = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const operations = [];
    const unsupported = [];
    const claimedDirectiveKeys = [];
    const seen = new Set((context.existingOperations || []).map(_signature));
    const exclusiveCapabilities = new Set(
        (context.existingOperations || [])
            .filter((operation) => operation.exclusiveCapability === true)
            .map((operation) => operation.capabilityId)
    );
    const invocations = Array.isArray(source.invocations) ? source.invocations.slice(0, 12) : [];
    for (const invocation of invocations) {
        const requestedCapability = String(
            invocation?.capabilityId
            || invocation?.capability
            || invocation?.specialistId
            || ''
        ).trim();
        if (exclusiveCapabilities.has(requestedCapability)) continue;
        const normalized = registry.tryNormalizeInvocation(invocation, context);
        if (!normalized.operation) {
            context.log?.(`Smart capability invocation rejected: ${normalized.error?.message || 'invalid invocation'}`);
            unsupported.push('One requested edit could not be matched to a safe live specialist capability.');
            continue;
        }
        const signature = _signature(normalized.operation);
        if (seen.has(signature)) continue;
        seen.add(signature);
        operations.push(normalized.operation);
        const manifest = registry.getCapability(normalized.operation.capabilityId)?.manifest;
        claimedDirectiveKeys.push(...(manifest?.directiveKeys || []));
    }
    return {
        summary: String(source.summary || '').trim(),
        operations,
        supported: operations.map((operation) => `${operation.specialist}: ${operation.description}`),
        unsupported: [...new Set(unsupported)],
        claimedDirectiveKeys: [...new Set(claimedDirectiveKeys)],
    };
}

function _buildPrompt(context) {
    const manifests = _routerManifests().map(({ risk: _risk, ...manifest }) => manifest);
    return `You are the Editor Supervisor inside a professional video editor.
Your job is to understand the user's editing intent and delegate it to the LIVE specialist capabilities below.
You never invent actions, effect names, presets, fields, argument names, or capability ids.
You never directly edit project JSON.
Use zero or more invocations. Each invocation must use one declared capability id, one declared tool action, and only arguments allowed by that tool schema.
Do not repeat an edit already listed under existingOperations.
If an existing operation has exclusiveCapability=true, it fully owns that capability for this request.
When one or more existing or new operations are present, the summary must describe a FUTURE proposed edit.
Never say the edit is already queued, already applied, already updated, complete, or that no edit is needed.
Preserve the active scope. If the request is a question rather than an edit, return no invocations.
Prefer semantic combinations when the user describes a mood instead of naming controls.
Whole-scene visualRefs and iconRefs are composition context, not permission to edit every layer.
When the user names a target such as an icon, lower third, caption, transition, effect, audio cue, or footage clip, only capabilities that own that named target may act unless the user explicitly requests multiple targets.
For copy-only or text-style-only requests, use the matching in-place graphics action. Never regenerate a graphic just to change its wording or text color.
For "another style", "different look", or "redesign this graphic", use an in-place graphics property edit with a concrete different style and/or supported variant. Preserve the graphic id, content, timing, and collection; do not regenerate it.
Keep arguments minimal and concrete.
When exact-playhead visual grounding is present, treat its target id, target type,
visible description, and semantic part as stronger evidence than a vague noun in
the user's wording. Do not reinterpret an identified accent-rule as a background.

LIVE CAPABILITIES:
${JSON.stringify(manifests)}

PROJECT AND ACTIVE SCOPE:
${JSON.stringify(_projectSnapshot(context.plan, context.request))}

CURRENT SPECIALIST INSPECTIONS:
${JSON.stringify(registry.inspectCapabilities(context.plan, context.request.scope))}

EXACT-PLAYHEAD VISUAL GROUNDING:
${JSON.stringify(context.request.visualGrounding || null)}

EXISTING DETERMINISTIC OPERATIONS:
${JSON.stringify((context.existingOperations || []).map((operation) => ({
        capabilityId: operation.capabilityId,
        action: operation.action,
        args: operation.args,
        description: operation.description,
    })))}

USER REQUEST:
${String(context.request.text || '')}

Return:
{
  "summary": "short plain-English edit summary",
  "invocations": [
    {
      "capabilityId": "one live id",
      "action": "one action declared by that capability",
      "args": {},
      "description": "what this specialist will do"
    }
  ]
}`;
}

function _buildRecoveryPrompt(context) {
    const manifests = _routerManifests();
    return `You are the recovery planner for an autonomous video-editing supervisor.
The user already approved the editing intent and exact scope. One specialist attempt failed verification.
Choose at most ONE live capability invocation that can still satisfy the same intent.
Never broaden or change the scope. Never increase risk. Never invent capability ids, actions, fields, arguments, effects, presets, or assets.
Prefer a more precise action or safer arguments. If no declared capability can recover safely, return null.
Do not claim the edit succeeded.

LIVE CAPABILITIES:
${JSON.stringify(manifests)}

USER REQUEST:
${String(context.request?.text || '')}

FAILED OPERATION:
${JSON.stringify({
        capabilityId: context.failedOperation?.capabilityId,
        specialist: context.failedOperation?.specialist,
        action: context.failedOperation?.action,
        args: context.failedOperation?.args,
        scope: context.failedOperation?.scope,
        risk: context.failedOperation?.risk,
        description: context.failedOperation?.description,
    })}

FAILURE:
${JSON.stringify(context.failure || {})}

LIVE INSPECTION:
${JSON.stringify(context.inspection || {})}

ALREADY COMPLETED OPERATIONS:
${JSON.stringify((context.completedOperations || []).map((operation) => ({
        capabilityId: operation.capabilityId,
        action: operation.action,
        description: operation.description,
    })))}

Return:
{
  "summary": "short recovery description or why none is safe",
  "invocation": null OR {
    "capabilityId": "one live id",
    "action": "one declared action",
    "args": {},
    "description": "what the recovery will do"
  }
}`;
}

async function routeSmartRequest(context = {}) {
    try {
        const { callAIJson } = require('../../../brain/strict-json');
        const raw = await callAIJson(_buildPrompt(context), {
            label: 'Editor Agent capability router',
            maxRetries: 1,
            maxTokens: 1800,
            temperature: 0.1,
            taskType: 'brain',
            schemaDescription: `{
  "summary": string,
  "invocations": array (maximum 12) of {
    "capabilityId": string,
    "action": string,
    "args": object,
    "description": string
  }
}`,
            validate: (value) => {
                if (!value || typeof value !== 'object') return 'response must be an object';
                if (!Array.isArray(value.invocations)) return 'invocations must be an array';
                if (value.invocations.length > 12) return 'too many invocations';
                return true;
            },
        });
        return coerceSmartPlan(raw, context);
    } catch (error) {
        context.log?.(`Smart capability router unavailable; deterministic specialists remain active: ${error.message}`);
        return {
            summary: '',
            operations: [],
            supported: [],
            unsupported: [],
            claimedDirectiveKeys: [],
        };
    }
}

async function routeRecoveryRequest(context = {}) {
    try {
        const { callAIJson } = require('../../../brain/strict-json');
        const raw = await callAIJson(_buildRecoveryPrompt(context), {
            label: 'Editor Agent recovery router',
            maxRetries: 1,
            maxTokens: 1_200,
            temperature: 0.05,
            taskType: 'brain',
            schemaDescription: `{
  "summary": string,
  "invocation": null or {
    "capabilityId": string,
    "action": string,
    "args": object,
    "description": string
  }
}`,
            validate: (value) => {
                if (!value || typeof value !== 'object') return 'response must be an object';
                if (value.invocation != null && typeof value.invocation !== 'object') {
                    return 'invocation must be an object or null';
                }
                return true;
            },
        });
        if (!raw.invocation) {
            return {
                summary: String(raw.summary || '').trim(),
                operation: null,
            };
        }
        const normalized = registry.tryNormalizeInvocation(raw.invocation, {
            request: context.request,
            plan: context.plan,
            existingOperations: context.completedOperations || [],
            log: context.log,
        });
        if (!normalized.operation) {
            context.log?.(`Recovery invocation rejected: ${normalized.error?.message || 'invalid invocation'}`);
            return {
                summary: String(raw.summary || '').trim(),
                operation: null,
            };
        }
        return {
            summary: String(raw.summary || '').trim(),
            operation: normalized.operation,
        };
    } catch (error) {
        context.log?.(`Smart recovery router unavailable: ${error.message}`);
        return {
            summary: '',
            operation: null,
        };
    }
}

module.exports = {
    coerceSmartPlan,
    routeRecoveryRequest,
    routeSmartRequest,
};
