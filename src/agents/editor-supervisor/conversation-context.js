'use strict';

const { normalizeScope } = require('./schemas');

const CAPABILITY_NOUNS = Object.freeze({
    audio: 'audio mix',
    captions: 'caption design',
    effects: 'visual look and effects',
    framing: 'framing',
    graphics: 'motion graphic',
    icons: 'scene icon',
    media: 'media replacement',
    pacing: 'pacing and cut structure',
    timeline: 'timeline clip setup',
    transitions: 'transition',
});

const EXPLICIT_CAPABILITY_PATTERNS = Object.freeze({
    audio: /\b(?:audio|narration|voiceover|voice-over|music|sound\s+effects?|sfx|volume|mix)\b/i,
    captions: /\b(?:subtitles?|captions?|karaoke|words?\s+per\s+(?:line|caption))\b/i,
    effects: /\b(?:visual\s+effects?|effects?|look|grade|grading|grain|vignette|fog|haze|bloom|glitch|vhs|dust|film\s+scratch(?:es)?|scratch(?:es)?|light\s+leak|noir|sepia)\b/i,
    framing: /\b(?:framing|fullscreen|full\s+screen|cinematic|floating|scale|crop|fit\s+mode|position\s+[xy])\b/i,
    graphics: /\b(?:motion\s+graphics?|lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout|stat\s+card|text\s+animation|animated\s+text|graphic\s+text)\b/i,
    icons: /\b(?:(?:scene|explainer)\s+)?icons?\b/i,
    media: /\b(?:footage|b[\s-]?roll|media|stock|archive|archival\s+footage|replace\s+(?:this\s+)?(?:clip|image|video))\b/i,
    pacing: /\b(?:pace|paced|pacing|re[\s-]?cut|split\s+(?:this\s+)?clip|merge\s+(?:these\s+)?clips)\b/i,
    timeline: /\b(?:ken\s+burns|source\s+offset|media\s+offset|move\b.{0,20}\btrack|hide\s+(?:this\s+)?clip|show\s+(?:this\s+)?clip)\b/i,
    transitions: /\b(?:transition|hard\s+cuts?|cross[\s-]?fade|dissolve|whip|wipe|dip\s+to\s+black|zoom\s+(?:punch|pull)|light\s+sweep)\b/i,
});

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _explicitCapabilities(text) {
    return Object.entries(EXPLICIT_CAPABILITY_PATTERNS)
        .filter(([, pattern]) => pattern.test(String(text || '')))
        .map(([id]) => id);
}

function _looksLikeFollowUp(text, explicitCapabilities = []) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > 600) return false;
    const strongReference = /\b(?:it|that|same|again|previous|last|there|also|too)\b/i.test(raw);
    if (explicitCapabilities.length && !strongReference) return false;
    if (strongReference || (!explicitCapabilities.length && /\b(?:this|those|these)\b/i.test(raw))) {
        return true;
    }
    return /^(?:make|change|turn|set|keep|remove|add|increase|decrease|reduce|boost|shorten|lengthen|soften|strengthen|more|less|faster|slower|shorter|longer)\b/i.test(raw)
        && raw.split(/\s+/).length <= 14;
}

function _visualIds(plan) {
    const ids = new Set();
    for (const key of ['mgScenes', 'templateScenes', 'motionGraphics', 'overlayScenes']) {
        for (const visual of (plan?.[key] || [])) {
            if (visual?.id != null) ids.add(String(visual.id));
        }
    }
    return ids;
}

function _iconIds(plan) {
    const ids = new Set();
    for (const [sceneIndex, scene] of (plan?.scenes || []).entries()) {
        if (!scene || scene.isMGScene) continue;
        const clipId = String(scene.clipId || `scene-${scene.sourceSceneIndex ?? scene.index ?? sceneIndex}`);
        (Array.isArray(scene._iconMoments) ? scene._iconMoments : []).forEach((_moment, momentIndex) => {
            ids.add(`${clipId}:icon:${momentIndex}`);
        });
    }
    return ids;
}

function _scopeForCurrentPlan(scopeValue, plan) {
    const scope = normalizeScope(scopeValue);
    if (scope.kind === 'project' || scope.kind === 'range') return scope;
    if (scope.kind === 'visual') {
        const ids = _visualIds(plan);
        const existing = scope.visualRefs.filter((ref) => ids.has(String(ref.id)));
        if (existing.length) return normalizeScope({ ...scope, visualRefs: existing });
        if (scope.toSec > scope.fromSec) {
            return normalizeScope({
                kind: 'range',
                label: `Previous graphic range ${scope.fromSec.toFixed(2)}-${scope.toSec.toFixed(2)}s`,
                fromSec: scope.fromSec,
                toSec: scope.toSec,
                currentTime: scope.currentTime,
                totalDuration: scope.totalDuration,
            });
        }
        return null;
    }

    const sceneIds = new Set(
        (plan?.scenes || [])
            .filter((scene) => scene && !scene.isMGScene)
            .map((scene) => String(scene.clipId || ''))
            .filter(Boolean)
    );
    const existing = scope.clipRefs.filter((ref) => sceneIds.has(String(ref.clipId || '')));
    if (existing.length) {
        const visualIds = _visualIds(plan);
        const iconIds = _iconIds(plan);
        return normalizeScope({
            ...scope,
            clipRefs: existing,
            visualRefs: scope.visualRefs.filter((ref) => visualIds.has(String(ref.id || ''))),
            iconRefs: scope.iconRefs.filter((ref) => iconIds.has(String(ref.id || ''))),
        });
    }
    if (scope.toSec > scope.fromSec) {
        return normalizeScope({
            kind: 'range',
            label: `Previous edit range ${scope.fromSec.toFixed(2)}-${scope.toSec.toFixed(2)}s`,
            fromSec: scope.fromSec,
            toSec: scope.toSec,
            currentTime: scope.currentTime,
            totalDuration: scope.totalDuration,
        });
    }
    return null;
}

function _contextTimestamp(value) {
    const timestamp = Date.parse(String(value?.createdAt || ''));
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function _latestEditContext(session) {
    const lastPlan = session?.context?.lastPlan || null;
    const lastExecution = session?.context?.lastExecution || null;
    if (!lastPlan) {
        return lastExecution ? { value: lastExecution, kind: 'result' } : null;
    }
    if (!lastExecution) return { value: lastPlan, kind: 'plan' };

    const planTimestamp = _contextTimestamp(lastPlan);
    const executionTimestamp = _contextTimestamp(lastExecution);
    if (planTimestamp > executionTimestamp) {
        return { value: lastPlan, kind: 'plan' };
    }
    return { value: lastExecution, kind: 'result' };
}

function resolveContextualPayload(payloadValue, session, plan) {
    const payload = payloadValue && typeof payloadValue === 'object'
        ? _clone(payloadValue)
        : {};
    const originalText = String(payload.text || '').trim();
    const previousContext = _latestEditContext(session);
    const previous = previousContext?.value || null;
    const currentScope = normalizeScope(payload.scope);
    const explicitCapabilities = _explicitCapabilities(originalText);
    const previousCapabilities = [...new Set(
        (previous?.capabilityIds || previous?.operations?.map((operation) => operation.capabilityId) || [])
            .map(String)
            .filter(Boolean)
    )];
    const introducesNewExplicitDomain = explicitCapabilities.length > 0
        && previousCapabilities.length > 0
        && explicitCapabilities.some((id) => !previousCapabilities.includes(id));
    if (
        !previous
        || introducesNewExplicitDomain
        || !_looksLikeFollowUp(originalText, explicitCapabilities)
    ) {
        return {
            ...payload,
            text: originalText,
            originalText,
            scope: currentScope,
            contextResolution: {
                applied: false,
                inheritedScope: false,
                capabilityIds: [],
                note: '',
            },
        };
    }

    const capabilityIds = previousCapabilities;
    const noun = CAPABILITY_NOUNS[capabilityIds[capabilityIds.length - 1]]
        || 'previous edit';
    const previousScope = _scopeForCurrentPlan(previous.scope, plan);
    const inheritScope = currentScope.kind === 'project'
        && previousScope
        && previousScope.kind !== 'project';
    const resolvedScope = inheritScope ? previousScope : currentScope;
    const contextLine = [
        `Continue the previously discussed ${noun}.`,
        previous.summary
            ? `Previous ${previousContext.kind}: ${String(previous.summary).slice(0, 800)}.`
            : '',
        'Change only what this follow-up requests and preserve every unrelated property.',
    ].filter(Boolean).join(' ');

    return {
        ...payload,
        text: `${originalText}\n\nEditing context: ${contextLine}`,
        originalText,
        scope: resolvedScope,
        contextResolution: {
            applied: true,
            inheritedScope: Boolean(inheritScope),
            capabilityIds,
            source: previousContext.kind,
            note: inheritScope
                ? `Continued the previous ${noun} target.`
                : `Used the previous ${noun} edit as conversational context.`,
        },
    };
}

module.exports = {
    resolveContextualPayload,
};
