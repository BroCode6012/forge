'use strict';

const { normalizeTextColor } = require('../../../render/text-style-ranges');
const { resolveSceneTargets, windowOf } = require('../scope-utils');

const ICON_POSITIONS = new Set([
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
    'center-left',
    'center-right',
]);
const ICON_EDITABLE_PROPERTIES = Object.freeze([
    'color',
    'position',
    'scale',
    'scaleMultiplier',
]);

function _sceneIndex(plan, scene) {
    return Math.max(0, (plan?.scenes || []).indexOf(scene));
}

function _sourceSceneIndex(scene, fallbackIndex) {
    const value = Number(scene?.sourceSceneIndex ?? scene?.index ?? fallbackIndex);
    return Number.isFinite(value) ? Math.trunc(value) : fallbackIndex;
}

function iconMomentId(scene, sceneIndex, momentIndex) {
    const clipId = String(
        scene?.clipId
        || `scene-${_sourceSceneIndex(scene, sceneIndex)}`
    );
    return `${clipId}:icon:${momentIndex}`;
}

function _allEntries(plan, scope) {
    const scenes = resolveSceneTargets(plan, scope, { includeDescendants: true });
    const refs = Array.isArray(scope?.iconRefs) ? scope.iconRefs : [];
    const refIds = new Set(refs.map((ref) => String(ref?.id || '')).filter(Boolean));
    const hasExactRefs = refIds.size > 0;
    const entries = [];
    for (const scene of scenes) {
        const sceneIndex = _sceneIndex(plan, scene);
        const sceneWindow = windowOf(scene);
        const moments = Array.isArray(scene?._iconMoments) ? scene._iconMoments : [];
        moments.forEach((moment, momentIndex) => {
            if (!moment) return;
            const id = iconMomentId(scene, sceneIndex, momentIndex);
            if (hasExactRefs && !refIds.has(id)) return;
            const at = Math.max(0, Number(moment.at) || 0);
            const duration = Math.max(0.05, Number(moment.dur ?? moment.duration) || 2);
            entries.push({
                id,
                scene,
                sceneIndex,
                moment,
                momentIndex,
                clipId: String(scene.clipId || ''),
                sourceSceneIndex: _sourceSceneIndex(scene, sceneIndex),
                startTime: sceneWindow.startTime + at,
                endTime: Math.min(sceneWindow.endTime, sceneWindow.startTime + at + duration),
            });
        });
    }
    return entries;
}

function inspectSceneIcons(plan, scope) {
    const entries = _allEntries(plan, scope);
    return {
        targetCount: entries.length,
        sceneCount: new Set(entries.map((entry) => entry.clipId || entry.sceneIndex)).size,
        icons: entries.slice(0, 120).map((entry) => ({
            id: entry.id,
            clipId: entry.clipId,
            sourceSceneIndex: entry.sourceSceneIndex,
            momentIndex: entry.momentIndex,
            kind: String(entry.moment.kind || 'icon'),
            label: String(
                entry.moment.concept
                || entry.moment.label
                || entry.moment.keyword
                || entry.moment.query
                || entry.moment.kind
                || 'Scene icon'
            ).slice(0, 500),
            position: String(entry.moment.position || 'top-right'),
            color: normalizeTextColor(entry.moment.color) || '',
            scale: Number.isFinite(Number(entry.moment.scale))
                ? Number(entry.moment.scale)
                : 1,
            startTime: entry.startTime,
            endTime: entry.endTime,
        })),
    };
}

function _resolveTargets(plan, scope, operation = {}) {
    let entries = _allEntries(plan, scope);
    const targetIds = new Set(
        (Array.isArray(operation.targetIds) ? operation.targetIds : [])
            .map((id) => String(id || ''))
            .filter(Boolean)
    );
    if (targetIds.size) entries = entries.filter((entry) => targetIds.has(entry.id));
    if (!entries.length) throw new Error('No scene icons were found in the active scope');
    if (operation.all === true || entries.length === 1) return entries;

    const currentTime = Number(scope?.currentTime);
    if (Number.isFinite(currentTime)) {
        const active = entries.filter((entry) => (
            currentTime >= entry.startTime - 0.001
            && currentTime <= entry.endTime + 0.001
        ));
        if (active.length === 1) return active;
    }

    throw new Error(
        'More than one scene icon matches this scope. '
        + 'Move the playhead onto the exact icon moment, or ask to edit all icons in the scene.'
    );
}

function _propertyCount(operation) {
    return ICON_EDITABLE_PROPERTIES
        .map((property) => operation[property])
        .filter((value) => value !== undefined && value !== '').length;
}

function applySceneIconEdit(plan, scope, operation = {}, options = {}) {
    if (scope?.kind === 'visual') {
        throw new Error('Scene icons belong to footage scenes, not a standalone motion-graphic selection');
    }
    const targets = _resolveTargets(plan, scope, operation);
    if (operation.remove === true) {
        const grouped = new Map();
        for (const target of targets) {
            if (!grouped.has(target.scene)) grouped.set(target.scene, []);
            grouped.get(target.scene).push(target.momentIndex);
        }
        let removed = 0;
        for (const [scene, indexes] of grouped) {
            const removeIndexes = new Set(indexes);
            const moments = Array.isArray(scene._iconMoments) ? scene._iconMoments : [];
            scene._iconMoments = moments.filter((_moment, index) => !removeIndexes.has(index));
            removed += moments.length - scene._iconMoments.length;
        }
        if (!removed) throw new Error('The selected scene icons are already removed');
        options.log?.(`Scene Icon Editor removed ${removed} icon moment(s) from the exact scope`);
        return {
            changed: removed,
            removed,
            edited: 0,
            stats: {
                iconsRemoved: removed,
                iconsEdited: 0,
            },
        };
    }

    if (!_propertyCount(operation)) {
        throw new Error('Scene icon editing needs a color, position, or size change');
    }

    const color = operation.color ? normalizeTextColor(operation.color) : '';
    if (operation.color && !color) throw new Error('Scene icon color is invalid');
    const position = operation.position ? String(operation.position) : '';
    if (position && !ICON_POSITIONS.has(position)) throw new Error(`Unsupported scene icon position: ${position}`);

    let changed = 0;
    const edits = [];
    for (const target of targets) {
        const before = JSON.stringify(target.moment);
        if (color) target.moment.color = color;
        if (position) target.moment.position = position;
        if (Number.isFinite(Number(operation.scale))) {
            target.moment.scale = Math.max(0.25, Math.min(3, Number(operation.scale)));
        } else if (Number.isFinite(Number(operation.scaleMultiplier))) {
            const current = Number.isFinite(Number(target.moment.scale))
                ? Number(target.moment.scale)
                : 1;
            target.moment.scale = Math.max(
                0.25,
                Math.min(3, current * Number(operation.scaleMultiplier))
            );
        }
        if (before !== JSON.stringify(target.moment)) {
            changed++;
            edits.push({
                id: target.id,
                clipId: target.clipId,
                momentIndex: target.momentIndex,
                color: normalizeTextColor(target.moment.color) || '',
                position: String(target.moment.position || 'top-right'),
                scale: Number.isFinite(Number(target.moment.scale))
                    ? Number(target.moment.scale)
                    : 1,
            });
        }
    }
    if (!changed) throw new Error('The selected scene icons already have those exact properties');
    options.log?.(`Scene Icon Editor updated ${changed} icon moment(s) inside the exact scope`);
    return {
        changed,
        removed: 0,
        edited: changed,
        edits,
        stats: {
            iconsRemoved: 0,
            iconsEdited: changed,
        },
    };
}

module.exports = {
    ICON_EDITABLE_PROPERTIES,
    ICON_POSITIONS: [...ICON_POSITIONS],
    applySceneIconEdit,
    iconMomentId,
    inspectSceneIcons,
};
