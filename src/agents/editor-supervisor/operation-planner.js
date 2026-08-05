'use strict';

const {
    getCapability,
    planDeterministic,
    tryNormalizeInvocation,
} = require('./capabilities/registry');
const { routeSmartRequest } = require('./capabilities/smart-router');

const RISK_WEIGHT = {
    low: 0,
    moderate: 1,
    expensive: 2,
    structural: 3,
};
const EXPLICIT_CAPABILITY_PATTERNS = Object.freeze({
    audio: /\b(?:audio|narration|voiceover|voice-over|music|sound\s+effects?|sfx|volume|mix)\b/i,
    captions: /\b(?:subtitles?|captions?|karaoke)\b/i,
    effects: /\b(?:visual\s+effects?|effects?|look|grade|grading|grain|vignette|fog|haze|bloom|glitch|vhs|dust|film\s+scratch(?:es)?|scratch(?:es)?|light\s+leak|noir|sepia)\b/i,
    framing: /\b(?:framing|fullscreen|full\s+screen|cinematic|floating|scale|crop|fit\s+mode)\b/i,
    graphics: /\b(?:motion\s+graphics?|lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout|stat\s+card|graphic\s+text|accent\s+(?:bar|line|rule|rail))\b/i,
    icons: /\b(?:(?:scene|explainer)\s+)?icons?\b/i,
    media: /\b(?:footage|b[\s-]?roll|media|stock|archive|archival|replace\s+(?:this\s+)?(?:clip|image|video))\b/i,
    pacing: /\b(?:pace|paced|pacing|re[\s-]?cut|split\s+(?:this\s+)?clip|merge\s+(?:these\s+)?clips)\b/i,
    timeline: /\b(?:ken\s+burns|source\s+offset|media\s+offset|track)\b/i,
    transitions: /\b(?:transition|hard\s+cuts?|cross[\s-]?fade|dissolve|whip|wipe|dip\s+to\s+black|zoom\s+(?:punch|pull))\b/i,
});

function _clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function _deleteClaimed(directives, keys) {
    for (const key of (keys || [])) delete directives[key];
}

function _signature(operation) {
    return JSON.stringify({
        capabilityId: operation.capabilityId,
        action: operation.action,
        args: operation.args,
        scope: operation.scope,
    });
}

function _scopeTargetSignature(scope = {}) {
    return JSON.stringify({
        kind: String(scope.kind || ''),
        clipIds: (scope.clipRefs || [])
            .map((ref) => String(ref?.clipId || ''))
            .filter(Boolean)
            .sort(),
        visualIds: (scope.visualRefs || [])
            .map((ref) => String(ref?.id || ''))
            .filter(Boolean)
            .sort(),
        iconIds: (scope.iconRefs || [])
            .map((ref) => String(ref?.id || ''))
            .filter(Boolean)
            .sort(),
        fromSec: Number(scope.fromSec) || 0,
        toSec: Number(scope.toSec) || 0,
    });
}

function _semanticSignature(operation) {
    const capabilityId = String(operation?.capabilityId || '');
    const action = String(operation?.action || '');
    if (
        capabilityId !== 'graphics'
        || !['add', 'regenerate', 'reduce'].includes(action)
    ) return '';
    return JSON.stringify({
        capabilityId,
        action,
        requestedType: String(operation?.args?.requestedType || ''),
        scope: _scopeTargetSignature(operation?.scope),
    });
}

function _dedupeOperations(operations) {
    const seen = new Set();
    const semanticSeen = new Set();
    return (operations || []).filter((operation) => {
        const signature = _signature(operation);
        if (seen.has(signature)) return false;
        const semanticSignature = _semanticSignature(operation);
        if (semanticSignature && semanticSeen.has(semanticSignature)) return false;
        seen.add(signature);
        if (semanticSignature) semanticSeen.add(semanticSignature);
        return true;
    });
}

function _riskOf(operations) {
    return (operations || []).reduce((highest, operation) => (
        (RISK_WEIGHT[operation.risk] ?? 1) > (RISK_WEIGHT[highest] ?? 0)
            ? operation.risk
            : highest
    ), 'low');
}

function _targetCount(request, plan) {
    if (request.scope.kind === 'project') {
        return (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene).length;
    }
    return Math.max(
        1,
        request.scope.clipRefs?.length
        || request.scope.visualRefs?.length
        || request.scope.iconRefs?.length
        || 1
    );
}

function _contradictsPendingOperations(summary) {
    const text = String(summary || '').trim();
    if (!text) return false;
    return (
        /\bno\b.{0,32}\b(?:changes?|edits?|updates?|work|actions?)\b.{0,32}\b(?:needed|required|necessary)\b/i.test(text)
        || /\bnothing\b.{0,32}\b(?:change|edit|update|do|apply)\b/i.test(text)
        || /\balready\b.{0,40}\b(?:satisfied|updated|queued|applied|done|complete(?:d)?|handled|changed)\b/i.test(text)
        || /\b(?:changes?|edits?|updates?)\b.{0,32}\balready\b.{0,24}\b(?:queued|applied|done|complete(?:d)?|handled)\b/i.test(text)
    );
}

function _usablePendingSummary(summary, operations) {
    const text = String(summary || '').trim();
    if (!text) return '';
    if (operations.length && _contradictsPendingOperations(text)) return '';
    return text;
}

function _filterDeterministicForGrounding(deterministic, request, grounding) {
    if (
        grounding?.status !== 'grounded'
        || !grounding?.invocation?.capabilityId
        || !Array.isArray(deterministic?.operations)
    ) return deterministic;
    const groundedCapability = String(grounding.invocation.capabilityId);
    const text = String(request?.originalText || request?.text || '');
    const operations = deterministic.operations.filter((operation) => {
        const capabilityId = String(operation?.capabilityId || '');
        if (!capabilityId || capabilityId === groundedCapability) return true;
        return EXPLICIT_CAPABILITY_PATTERNS[capabilityId]?.test(text) === true;
    });
    if (operations.length === deterministic.operations.length) return deterministic;
    const specialists = new Set(operations.map((operation) => String(operation.specialist || '')));
    return {
        ...deterministic,
        operations,
        supported: (deterministic.supported || []).filter((message) => (
            [...specialists].some((specialist) => specialist && String(message).includes(specialist))
        )),
    };
}

function _filterSmartForNamedTargets(smart, request, existingOperations = [], options = {}) {
    if (!Array.isArray(smart?.operations) || !smart.operations.length) return smart;
    const originalText = String(request?.originalText || request?.text || '');
    const explicitCapabilities = new Set(
        Object.entries(EXPLICIT_CAPABILITY_PATTERNS)
            .filter(([, pattern]) => pattern.test(originalText))
            .map(([id]) => id)
    );
    if (!explicitCapabilities.size) return smart;

    // Once a deterministic specialist owns an explicitly named target, an AI
    // router cannot revive unrelated work from an earlier prompt. Additional
    // specialists are allowed only when the current request names their domain.
    const hasExplicitExclusiveOwner = existingOperations.some((operation) => (
        operation?.exclusiveCapability === true
        && explicitCapabilities.has(String(operation.capabilityId || ''))
    ));
    if (!hasExplicitExclusiveOwner) return smart;

    const operations = smart.operations.filter((operation) => (
        explicitCapabilities.has(String(operation?.capabilityId || ''))
    ));
    if (operations.length === smart.operations.length) return smart;
    const removed = smart.operations
        .filter((operation) => !operations.includes(operation))
        .map((operation) => String(operation?.capabilityId || ''))
        .filter(Boolean);
    if (removed.length) {
        options.log?.(
            `Ignored unrelated smart specialist(s) for named target: ${[...new Set(removed)].join(', ')}`
        );
    }
    const specialists = new Set(operations.map((operation) => String(operation.specialist || '')));
    return {
        ...smart,
        operations,
        supported: (smart.supported || []).filter((message) => (
            [...specialists].some((specialist) => specialist && String(message).includes(specialist))
        )),
        claimedDirectiveKeys: [...new Set(operations.flatMap((operation) => (
            getCapability(operation.capabilityId)?.manifest?.directiveKeys || []
        )))],
    };
}

function _filterSmartForExclusiveOwners(smart, existingOperations = [], options = {}) {
    if (!Array.isArray(smart?.operations) || !smart.operations.length) return smart;
    const exclusiveCapabilities = new Set(
        existingOperations
            .filter((operation) => operation?.exclusiveCapability === true)
            .map((operation) => String(operation.capabilityId || ''))
            .filter(Boolean)
    );
    if (!exclusiveCapabilities.size) return smart;

    const operations = smart.operations.filter((operation) => (
        !exclusiveCapabilities.has(String(operation?.capabilityId || ''))
    ));
    if (operations.length === smart.operations.length) return smart;

    const removed = smart.operations
        .filter((operation) => !operations.includes(operation))
        .map((operation) => String(operation?.capabilityId || ''))
        .filter(Boolean);
    options.log?.(
        `Ignored duplicate smart specialist work already owned by: ${[...new Set(removed)].join(', ')}`
    );
    return {
        ...smart,
        summary: operations.length ? smart.summary : '',
        operations,
        supported: operations.map((operation) => (
            `${operation.specialist}: ${operation.description}`
        )),
        claimedDirectiveKeys: [...new Set(operations.flatMap((operation) => (
            getCapability(operation.capabilityId)?.manifest?.directiveKeys || []
        )))],
    };
}

function _operationSummary(operations) {
    if (!Array.isArray(operations) || operations.length !== 1) return '';
    const operation = operations[0];
    if (operation?.authoritativeSummary !== true) return '';
    const description = String(operation.description || '').trim();
    if (!description) return '';
    return `${description.charAt(0).toUpperCase()}${description.slice(1)}.`;
}

async function planStagedOperations(directives, request, plan, options = {}) {
    const remaining = _clone(directives);
    const deterministic = _filterDeterministicForGrounding(planDeterministic({
        text: request.text,
        directives: remaining,
        request,
        plan,
        log: options.log,
    }), request, options.visualGrounding);
    _deleteClaimed(remaining, deterministic.claimedDirectiveKeys);

    let grounded = {
        operations: [],
        supported: [],
        unsupported: [],
        claimedDirectiveKeys: [],
    };
    if (options.visualGrounding?.invocation) {
        const normalized = tryNormalizeInvocation(options.visualGrounding.invocation, {
            request,
            plan,
            existingOperations: deterministic.operations,
            log: options.log,
        });
        if (normalized.operation) {
            const exclusiveOwner = deterministic.operations.find((operation) => (
                operation?.exclusiveCapability === true
                && String(operation.capabilityId || '') === String(normalized.operation.capabilityId || '')
            ));
            if (exclusiveOwner) {
                const groundedTargetIds = normalized.operation?.args?.targetIds;
                if (
                    Array.isArray(groundedTargetIds)
                    && groundedTargetIds.length
                    && !exclusiveOwner?.args?.targetIds?.length
                ) {
                    exclusiveOwner.args.targetIds = [...groundedTargetIds];
                }
                options.log?.(
                    `Visual grounding confirmed the target; ${exclusiveOwner.specialist} already owns the edit`
                );
            } else {
                grounded.operations.push({
                    ...normalized.operation,
                    exclusiveCapability: false,
                    visualGrounded: true,
                });
                grounded.supported.push(
                    `Visual Grounder: ${normalized.operation.description}`
                );
                const manifest = getCapability(normalized.operation.capabilityId)?.manifest;
                grounded.claimedDirectiveKeys.push(...(manifest?.directiveKeys || []));
            }
        } else {
            grounded.unsupported.push(
                'The visible object was identified, but its proposed edit did not match a safe live capability.'
            );
        }
    }
    _deleteClaimed(remaining, grounded.claimedDirectiveKeys);

    let smart = {
        summary: '',
        operations: [],
        supported: [],
        unsupported: [],
        claimedDirectiveKeys: [],
    };
    if (request.effort === 'smart') {
        const smartRouter = options.routeSmartRequest || routeSmartRequest;
        smart = await smartRouter({
            request,
            plan,
            directives: remaining,
            existingOperations: [
                ...deterministic.operations,
                ...grounded.operations,
            ],
            log: options.log,
        });
        smart = _filterSmartForExclusiveOwners(
            smart,
            [
                ...deterministic.operations,
                ...grounded.operations,
            ],
            options
        );
        smart = _filterSmartForNamedTargets(
            smart,
            request,
            [
                ...deterministic.operations,
                ...grounded.operations,
            ],
            options
        );
        _deleteClaimed(remaining, smart.claimedDirectiveKeys);
    }

    const operations = _dedupeOperations([
        ...deterministic.operations,
        ...grounded.operations,
        ...smart.operations,
    ]);
    const capabilityIds = [...new Set(operations.map((operation) => operation.capabilityId))];
    const specialists = [...new Set(operations.map((operation) => operation.specialist))];
    const targetCount = _targetCount(request, plan);
    const has = (id) => capabilityIds.includes(id);
    const hasGraphicContentEdit = operations.some((operation) => (
        operation.capabilityId === 'graphics' && operation.action === 'edit-content'
    ));
    const hasGraphicStyleEdit = operations.some((operation) => (
        operation.capabilityId === 'graphics' && operation.action === 'edit-text-style'
    ));
    const estimatedWork = {
        targetCount,
        operationCount: operations.length,
        specialists,
        pacing: has('pacing'),
        mediaReplacements: has('media') ? targetCount : 0,
        graphicEdits: has('graphics') && !hasGraphicContentEdit && !hasGraphicStyleEdit
            ? Math.min(targetCount, request.effort === 'smart' ? 8 : 4)
            : 0,
        graphicContentEdits: hasGraphicContentEdit ? targetCount : 0,
        graphicStyleEdits: hasGraphicStyleEdit ? targetCount : 0,
        iconEdits: has('icons') ? Math.max(1, request.scope.iconRefs?.length || targetCount) : 0,
        effectsEdits: has('effects') ? targetCount : 0,
        framingEdits: has('framing') ? targetCount : 0,
        transitionEdits: has('transitions') ? targetCount : 0,
        audioEdits: has('audio') ? targetCount : 0,
        captionEdits: has('captions') ? 1 : 0,
        timelineEdits: has('timeline') ? targetCount : 0,
    };

    return {
        directives: remaining,
        operations,
        supported: [...new Set([
            ...(deterministic.supported || []),
            ...(grounded.supported || []),
            ...(smart.supported || []),
        ])],
        unsupported: [...new Set([
            ...(deterministic.unsupported || []),
            ...(grounded.unsupported || []),
            ...(smart.unsupported || []),
        ])],
        risk: _riskOf(operations),
        estimatedWork,
        capabilityIds,
        specialists,
        summary: _operationSummary(operations)
            || _usablePendingSummary(smart.summary, operations)
            || _usablePendingSummary(options.visualGrounding?.summary, operations)
            || _usablePendingSummary(directives?.summary, operations)
            || request.text,
    };
}

module.exports = {
    planStagedOperations,
};
