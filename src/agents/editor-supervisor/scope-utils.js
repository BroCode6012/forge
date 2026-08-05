'use strict';

const EPSILON = 0.001;

function windowOf(item, fallbackDuration = 0) {
    const startTime = Math.max(0, Number(item?.startTime) || 0);
    const explicitEnd = Number(item?.endTime);
    const endTime = Number.isFinite(explicitEnd) && explicitEnd > startTime
        ? explicitEnd
        : startTime + Math.max(0, Number(item?.duration) || fallbackDuration);
    return { startTime, endTime: Math.max(startTime, endTime) };
}

function overlaps(item, fromSec, toSec) {
    const timing = windowOf(item);
    return timing.endTime > fromSec + EPSILON && timing.startTime < toSec - EPSILON;
}

function scopeRange(scope, plan) {
    const scenes = (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    const totalDuration = Math.max(
        Number(plan?.totalDuration) || 0,
        ...scenes.map((scene) => windowOf(scene).endTime)
    );
    if (scope?.kind === 'project') {
        return { fromSec: 0, toSec: totalDuration };
    }
    const fromSec = Math.max(0, Number(scope?.fromSec) || 0);
    const rawTo = Number(scope?.toSec);
    const toSec = Number.isFinite(rawTo) && rawTo > fromSec
        ? Math.min(totalDuration || rawTo, rawTo)
        : Math.min(totalDuration, fromSec + 0.001);
    return { fromSec, toSec };
}

function _clipRefMatches(scene, ref, fallbackIndex) {
    if (!scene || !ref) return false;
    const refTrack = String(ref.trackId || '');
    const sceneTrack = String(scene.trackId || 'video-track-1');
    if (refTrack && refTrack !== sceneTrack) return false;
    if (ref.clipId && scene.clipId === ref.clipId) return true;
    const sourceIndex = scene.sourceSceneIndex ?? scene.index ?? fallbackIndex;
    if (Number(sourceIndex) !== Number(ref.sourceSceneIndex)) return false;
    const sceneWindow = windowOf(scene);
    return Math.abs(sceneWindow.startTime - Number(ref.startTime || 0)) < 0.05
        && Math.abs(sceneWindow.endTime - Number(ref.endTime || sceneWindow.endTime)) < 0.05;
}

function sceneMatchesClipRefs(scene, refs, fallbackIndex = 0, options = {}) {
    const clipRefs = Array.isArray(refs) ? refs : [];
    if (!scene || !clipRefs.length) return false;
    if (clipRefs.some((ref) => _clipRefMatches(scene, ref, fallbackIndex))) return true;
    if (options.includeDescendants !== true) return false;

    const selectedIds = new Set(
        clipRefs.map((ref) => String(ref?.clipId || '')).filter(Boolean)
    );
    const pacing = scene._agentPacing && typeof scene._agentPacing === 'object'
        ? scene._agentPacing
        : {};
    if (selectedIds.has(String(pacing.sourceClipId || ''))) return true;
    return (Array.isArray(pacing.mergedClipIds) ? pacing.mergedClipIds : [])
        .some((clipId) => selectedIds.has(String(clipId || '')));
}

function resolveSceneTargets(plan, scope, options = {}) {
    const scenes = (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    if (scope?.kind === 'project') return scenes;

    const clipRefs = Array.isArray(scope?.clipRefs) ? scope.clipRefs : [];
    const exact = clipRefs.length
        ? scenes.filter((scene, index) => sceneMatchesClipRefs(
            scene,
            clipRefs,
            index,
            { includeDescendants: options.includeDescendants === true }
        ))
        : [];
    const identityScoped = scope?.kind === 'clips' || scope?.kind === 'playhead';
    if (identityScoped && clipRefs.length) {
        if (exact.length) return exact;
        return options.allowRangeFallback === true ? _resolveRange(scenes, scope, plan) : [];
    }
    if (exact.length && options.preferExact !== false) return exact;

    const ranged = _resolveRange(scenes, scope, plan);
    if (!clipRefs.length || ranged.length) return ranged;
    return exact;
}

function _resolveRange(scenes, scope, plan) {
    const { fromSec, toSec } = scopeRange(scope, plan);
    return scenes.filter((scene) => overlaps(scene, fromSec, toSec));
}

function visualMatchesRefs(visual, refs, collection = '', fallbackIndex = -1) {
    const visualRefs = Array.isArray(refs) ? refs : [];
    if (!visual || !visualRefs.length) return false;
    const identityIds = new Set([
        visual.id,
        visual.clipId,
        visual?.mgData?.id,
        visual?.mgData?.clipId,
        visual._agentReplacesVisualId,
        visual?.mgData?._agentReplacesVisualId,
        ...(Array.isArray(visual._agentReplacesVisualIds)
            ? visual._agentReplacesVisualIds
            : []),
        ...(Array.isArray(visual?.mgData?._agentReplacesVisualIds)
            ? visual.mgData._agentReplacesVisualIds
            : []),
    ].map((value) => String(value || '')).filter(Boolean));
    const timing = windowOf(visual, collection === 'templateScenes' ? 4 : 3);
    const type = String(visual.type || visual.templateType || '');
    return visualRefs.some((ref) => {
        const refId = String(ref?.id || '');
        if (refId && identityIds.has(refId)) return true;
        if (refId && identityIds.size) return false;
        if (
            ref?.collection
            && String(ref.collection) === String(collection)
            && Number.isInteger(Number(ref.collectionIndex))
            && Number(ref.collectionIndex) === Number(fallbackIndex)
        ) return true;
        const sameType = !ref?.type || String(ref.type) === type;
        return sameType
            && Math.abs((Number(ref?.startTime) || 0) - timing.startTime) < 0.05
            && Math.abs((Number(ref?.endTime) || timing.endTime) - timing.endTime) < 0.05;
    });
}

function resolveVisualTargets(plan, scope) {
    const arrays = ['mgScenes', 'templateScenes', 'motionGraphics'];
    const all = arrays.flatMap((collection) => (
        Array.isArray(plan?.[collection])
            ? plan[collection].map((visual, index) => ({ collection, index, visual }))
            : []
    ));
    const refs = Array.isArray(scope?.visualRefs) ? scope.visualRefs : [];
    if (refs.length) {
        return all.filter(({ collection, index, visual }) => (
            visualMatchesRefs(visual, refs, collection, index)
        ));
    }
    const { fromSec, toSec } = scopeRange(scope, plan);
    return all.filter(({ visual }) => overlaps(visual, fromSec, toSec));
}

function _iconMomentId(scene, sceneIndex, momentIndex) {
    const sourceSceneIndex = Number(scene?.sourceSceneIndex ?? scene?.index ?? sceneIndex);
    const clipId = String(
        scene?.clipId
        || `scene-${Number.isFinite(sourceSceneIndex) ? Math.trunc(sourceSceneIndex) : sceneIndex}`
    );
    return `${clipId}:icon:${momentIndex}`;
}

function _iconRefMatches(scene, sceneIndex, moment, momentIndex, ref) {
    if (!scene || !moment || !ref) return false;
    const id = _iconMomentId(scene, sceneIndex, momentIndex);
    if (ref.id && String(ref.id) === id) return true;

    const clipId = String(scene.clipId || '');
    if (ref.clipId && String(ref.clipId) !== clipId) return false;
    const sourceSceneIndex = Number(scene.sourceSceneIndex ?? scene.index ?? sceneIndex);
    if (
        ref.sourceSceneIndex != null
        && Number(ref.sourceSceneIndex) !== sourceSceneIndex
    ) return false;
    if (
        ref.sceneIndex != null
        && Number(ref.sceneIndex) !== Number(sceneIndex)
    ) return false;
    if (
        ref.momentIndex != null
        && Number(ref.momentIndex) !== Number(momentIndex)
    ) return false;

    return Boolean(
        ref.clipId
        || ref.sourceSceneIndex != null
        || ref.sceneIndex != null
        || ref.momentIndex != null
    );
}

function verifyStableScopeTargets(plan, scope, options = {}) {
    const kind = String(scope?.kind || 'project');
    if (kind === 'project' || kind === 'range') {
        return {
            safe: false,
            reason: `${kind} scope has no stable target identity`,
            targetCount: 0,
            missing: [],
            ambiguous: [],
        };
    }

    const operations = Array.isArray(options.operations) ? options.operations : [];
    const capabilityIds = new Set(
        operations.map((operation) => String(operation?.capabilityId || '')).filter(Boolean)
    );
    const clipRefs = Array.isArray(scope?.clipRefs) ? scope.clipRefs : [];
    const visualRefs = Array.isArray(scope?.visualRefs) ? scope.visualRefs : [];
    const iconRefs = Array.isArray(scope?.iconRefs) ? scope.iconRefs : [];
    const checkClips = kind !== 'visual' && clipRefs.length > 0;
    const checkVisuals = (
        kind === 'visual'
        || capabilityIds.has('graphics')
    ) && visualRefs.length > 0;
    const checkIcons = capabilityIds.has('icons') && iconRefs.length > 0;

    const missing = [];
    const ambiguous = [];
    let targetCount = 0;
    const record = (type, ref, count) => {
        targetCount++;
        if (count === 0) missing.push({ type, id: String(ref?.id || ref?.clipId || '') });
        else if (count > 1) ambiguous.push({ type, id: String(ref?.id || ref?.clipId || ''), count });
    };

    if (checkClips) {
        const scenes = (plan?.scenes || [])
            .map((scene, index) => ({ scene, index }))
            .filter(({ scene }) => scene && !scene.isMGScene);
        clipRefs.forEach((ref) => {
            const count = scenes.filter(({ scene, index }) => (
                sceneMatchesClipRefs(scene, [ref], index)
            )).length;
            record('clip', ref, count);
        });
    }

    if (checkVisuals) {
        const entries = ['mgScenes', 'templateScenes', 'motionGraphics'].flatMap((collection) => (
            Array.isArray(plan?.[collection])
                ? plan[collection].map((visual, index) => ({ collection, index, visual }))
                : []
        ));
        visualRefs.forEach((ref) => {
            const count = entries.filter(({ collection, index, visual }) => (
                visualMatchesRefs(visual, [ref], collection, index)
            )).length;
            record('visual', ref, count);
        });
    }

    if (checkIcons) {
        const entries = [];
        (plan?.scenes || []).forEach((scene, sceneIndex) => {
            if (!scene || scene.isMGScene) return;
            (Array.isArray(scene._iconMoments) ? scene._iconMoments : [])
                .forEach((moment, momentIndex) => {
                    if (moment) entries.push({ scene, sceneIndex, moment, momentIndex });
                });
        });
        iconRefs.forEach((ref) => {
            const count = entries.filter(({ scene, sceneIndex, moment, momentIndex }) => (
                _iconRefMatches(scene, sceneIndex, moment, momentIndex, ref)
            )).length;
            record('icon', ref, count);
        });
    }

    if (targetCount === 0) {
        return {
            safe: false,
            reason: 'scope has no stable referenced targets',
            targetCount,
            missing,
            ambiguous,
        };
    }
    if (missing.length || ambiguous.length) {
        return {
            safe: false,
            reason: missing.length
                ? 'one or more scoped targets no longer exist'
                : 'one or more scoped targets are ambiguous',
            targetCount,
            missing,
            ambiguous,
        };
    }
    return {
        safe: true,
        reason: 'all scoped targets still resolve exactly once',
        targetCount,
        missing,
        ambiguous,
    };
}

function containingSceneIndex(plan, time) {
    const scenes = plan?.scenes || [];
    let closest = -1;
    let closestDistance = Infinity;
    for (let index = 0; index < scenes.length; index++) {
        const scene = scenes[index];
        if (!scene || scene.isMGScene) continue;
        const timing = windowOf(scene);
        if (time >= timing.startTime - EPSILON && time < timing.endTime + EPSILON) return index;
        const distance = Math.min(Math.abs(time - timing.startTime), Math.abs(time - timing.endTime));
        if (distance < closestDistance) {
            closest = index;
            closestDistance = distance;
        }
    }
    return closest;
}

module.exports = {
    EPSILON,
    containingSceneIndex,
    overlaps,
    resolveSceneTargets,
    resolveVisualTargets,
    sceneMatchesClipRefs,
    scopeRange,
    verifyStableScopeTargets,
    visualMatchesRefs,
    windowOf,
};
