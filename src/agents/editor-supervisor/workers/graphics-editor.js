'use strict';

const { getNiche } = require('../../../data/niches');
const {
    FULLSCREEN_MG_TYPES,
    buildRuleMG,
    generateCandidates,
} = require('../../ai-motion-graphics');
const {
    containingSceneIndex,
    resolveSceneTargets,
    resolveVisualTargets,
    scopeRange,
    windowOf,
} = require('../scope-utils');
const {
    normalizeTextColor,
    normalizeTextStyleRanges,
} = require('../../../render/text-style-ranges');
const {
    requireFixedRenderer,
} = require('../../../render/authored-composition-policy');
const {
    normalizeGraphicShell,
} = require('../../../render/graphic-shells');

const GRAPHIC_EDITABLE_PROPERTIES = Object.freeze([
    'position',
    'animation',
    'animationSpeed',
    'animationSpeedScale',
    'durationSeconds',
    'durationScale',
    'style',
    'variant',
    'graphicShell',
    'background',
    'transparentBackground',
    'backgroundColor',
    'cardStyle',
    'accentRuleVisible',
    'textColor',
    'shadowStrength',
]);
const OVERLAY_FALLBACK_TYPES = ['kineticText', 'headline', 'focusWord', 'callout', 'typewriter'];
const PRIMARY_CONTENT_FIELDS = ['title', 'headline', 'label', 'templateText', 'templateTitle'];
const SECONDARY_CONTENT_FIELDS = [
    'subtext',
    'subText',
    'subtitle',
    'caption',
    'description',
    'templateSubtext',
    'templateSubtitle',
    'visualIntent',
];

function _uniqueId(plan, base) {
    const used = new Set([
        ...(plan.mgScenes || []),
        ...(plan.templateScenes || []),
        ...(plan.motionGraphics || []),
    ].map((visual) => String(visual.id || visual.clipId || '')));
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    return id;
}

function _pickType(scene, sceneIndex, plan, operation, placedTypes) {
    if (operation.requestedType) return operation.requestedType;
    const niche = getNiche(plan.scriptContext?.nicheId || 'general');
    const allowed = Array.isArray(niche?.allowedMGs) && niche.allowedMGs.length
        ? niche.allowedMGs
        : OVERLAY_FALLBACK_TYPES;
    const candidate = generateCandidates(
        scene,
        sceneIndex,
        Math.max(1, plan.scenes.length),
        allowed,
        placedTypes,
        null,
        { editorOwnsEditing: true }
    );
    const overlay = candidate.candidates?.find((entry) => !FULLSCREEN_MG_TYPES.has(entry.type));
    return overlay?.type
        || OVERLAY_FALLBACK_TYPES.find((type) => allowed.includes(type))
        || 'kineticText';
}

function _removeVisualTargets(plan, scope, operation) {
    const selected = resolveVisualTargets(plan, scope);
    const selectedIds = new Set(selected.map(({ visual }) => String(visual.id || visual.clipId || '')));
    const { fromSec, toSec } = scopeRange(scope, plan);
    let removed = 0;
    for (const collection of ['mgScenes', 'templateScenes', 'motionGraphics']) {
        if (!Array.isArray(plan[collection])) continue;
        plan[collection] = plan[collection].filter((visual, index) => {
            const id = String(visual.id || visual.clipId || '');
            const explicitSelected = selectedIds.has(id);
            const timing = windowOf(visual, 3);
            const inRange = timing.endTime > fromSec && timing.startTime < toSec;
            const matchingType = !operation.requestedType
                || String(visual.type || visual.templateType) === operation.requestedType;
            const remove = scope.kind === 'visual'
                ? explicitSelected
                : (inRange && matchingType);
            if (remove) removed++;
            return !remove;
        });
    }
    return removed;
}

function _sceneForVisual(plan, visual) {
    const byIndex = Number(visual?.sceneIndex);
    if (Number.isInteger(byIndex) && plan.scenes?.[byIndex]) return { scene: plan.scenes[byIndex], index: byIndex };
    const index = containingSceneIndex(plan, Number(visual?.startTime) || 0);
    return index >= 0 ? { scene: plan.scenes[index], index } : null;
}

function _buildForScene(plan, scene, sceneIndex, type, operation, sourceVisual = null) {
    let graphic = buildRuleMG(scene, sceneIndex, type);
    if (!graphic) return null;
    const timing = windowOf(scene);
    graphic.id = _uniqueId(
        plan,
        `agent-mg-${String(scene.clipId || sceneIndex).replace(/[^a-zA-Z0-9._-]+/g, '-')}-${type}`
    );
    graphic.clipId = graphic.id;
    graphic.style = plan.mgStyle || graphic.style || 'clean';
    graphic.selectionMode = 'editor-agent';
    graphic.agentInstruction = String(operation.instruction || '').slice(0, 500);
    graphic.sourceClipId = scene.clipId;
    if (sourceVisual) {
        const sourceTiming = windowOf(sourceVisual, 3);
        const sourceId = String(sourceVisual.id || sourceVisual.clipId || '');
        const replacementIds = [...new Set([
            ...(Array.isArray(sourceVisual._agentReplacesVisualIds)
                ? sourceVisual._agentReplacesVisualIds
                : []),
            sourceVisual._agentReplacesVisualId,
            ...(Array.isArray(sourceVisual?.mgData?._agentReplacesVisualIds)
                ? sourceVisual.mgData._agentReplacesVisualIds
                : []),
            sourceVisual?.mgData?._agentReplacesVisualId,
            sourceId,
        ].map((value) => String(value || '')).filter(Boolean))];
        const originalId = String(
            sourceVisual._agentReplacesVisualId
            || sourceVisual?.mgData?._agentReplacesVisualId
            || replacementIds[0]
            || sourceId
        );
        graphic.startTime = sourceTiming.startTime;
        graphic.duration = sourceTiming.endTime - sourceTiming.startTime;
        graphic._agentReplacesVisualId = originalId;
        graphic._agentReplacesVisualIds = replacementIds;
        if (sourceVisual.position) graphic.position = sourceVisual.position;
    }
    graphic.startTime = Math.max(timing.startTime, Math.min(graphic.startTime, timing.endTime - 0.2));
    graphic.duration = Math.max(0.5, Math.min(
        Number(graphic.duration) || 3,
        timing.endTime - graphic.startTime
    ));
    graphic.endTime = graphic.startTime + graphic.duration;
    graphic.durationFrames = Math.max(1, Math.round(graphic.duration * (Number(plan.fps) || 30)));
    graphic.durationUnit = 'seconds';
    return graphic;
}

function _appendGraphic(plan, graphic, collection) {
    let targetCollection = collection;
    if (!['mgScenes', 'templateScenes', 'motionGraphics'].includes(targetCollection)) {
        targetCollection = FULLSCREEN_MG_TYPES.has(graphic.type) || graphic.category === 'fullscreen'
            ? 'mgScenes'
            : 'motionGraphics';
    }
    plan[targetCollection] = Array.isArray(plan[targetCollection]) ? plan[targetCollection] : [];
    if (targetCollection === 'templateScenes') {
        if (graphic.templateType == null) graphic.templateType = graphic.type;
        graphic.isMGScene = graphic.isMGScene !== false;
        graphic.mediaType = graphic.mediaType || 'template';
        graphic.trackId = graphic.trackId || graphic?.mgData?.trackId || 'video-track-3';
        graphic.category = 'fullscreen';
    } else if (targetCollection === 'mgScenes') {
        graphic.isMGScene = graphic.isMGScene !== false;
        graphic.trackId = graphic.trackId || graphic?.mgData?.trackId || 'video-track-3';
        graphic.category = 'fullscreen';
    }
    plan[targetCollection].push(graphic);
}

function _graphicType(visual) {
    return String(visual?.type || visual?.templateType || visual?.mgType || '').trim();
}

function _typeKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function _displayText(visual) {
    return String(
        visual?.text
        || visual?.title
        || visual?.headline
        || visual?.label
        || visual?.templateText
        || visual?.templateTitle
        || visual?.mgData?.text
        || visual?.mgData?.title
        || ''
    ).trim();
}

function _displaySubtext(visual) {
    return String(
        visual?.subtext
        || visual?.subText
        || visual?.subtitle
        || visual?.caption
        || visual?.description
        || visual?.templateSubtext
        || visual?.templateSubtitle
        || visual?.visualIntent
        || visual?.mgData?.subtext
        || visual?.mgData?.subText
        || visual?.mgData?.subtitle
        || ''
    ).trim();
}

function inspectScopedGraphics(plan, scope) {
    return resolveVisualTargets(plan, scope).slice(0, 120).map(({ collection, visual }) => ({
        id: String(visual?.id || visual?.clipId || ''),
        collection,
        type: _graphicType(visual),
        text: _displayText(visual),
        subtext: _displaySubtext(visual),
        itemCount: (
            Array.isArray(visual?.items)
                ? visual.items
                : (Array.isArray(visual?.mgData?.items) ? visual.mgData.items : [])
        ).length,
        startTime: Number(visual?.startTime) || 0,
        duration: Number(visual?.duration) || 0,
        style: String(visual?.style || ''),
        variant: String(visual?.subType || visual?.variant || ''),
        graphicShell: _cloneValue(
            visual?.graphicShell
            || visual?.mgData?.graphicShell
            || visual?.agenticComposition?.shell
            || null
        ),
        graphicShellManual: visual?.graphicShellManual === true
            || visual?.mgData?.graphicShellManual === true,
        position: String(visual?.position || ''),
        authored: Boolean(visual?._authoredComposition || visual?.mgData?._authoredComposition),
        accentRuleVisible: visual?.accentRuleVisible !== false
            && visual?.mgData?.accentRuleVisible !== false,
        textStyleRanges: normalizeTextStyleRanges(
            visual?.textStyleRanges || visual?.mgData?.textStyleRanges
        ),
    }));
}

function _currencyToken(value) {
    const text = String(value || '');
    const match = text.match(/(?:([$€£])\s*([\d][\d,.]*)|([\d][\d,.]*)\s*([$€£]))/);
    if (!match) return null;
    const symbol = match[1] || match[4];
    const number = String(match[2] || match[3]).replace(/,/g, '');
    return { symbol, number };
}

function _retainedText(currentText, requestedText) {
    const current = String(currentText || '');
    const requested = String(requestedText || '').trim();
    if (!current || !requested) return '';
    const directIndex = current.toLowerCase().indexOf(requested.toLowerCase());
    if (directIndex >= 0) return current.slice(directIndex, directIndex + requested.length);

    const requestedCurrency = _currencyToken(requested);
    if (requestedCurrency) {
        const tokens = current.match(/(?:[$€£]\s*[\d][\d,.]*|[\d][\d,.]*\s*[$€£])/g) || [];
        const match = tokens.find((token) => {
            const parsed = _currencyToken(token);
            return parsed
                && parsed.symbol === requestedCurrency.symbol
                && parsed.number === requestedCurrency.number;
        });
        if (match) return match.trim();
    }

    const requestedNumber = requested.match(/\d[\d,.]*/)?.[0]?.replace(/,/g, '');
    if (requestedNumber) {
        const tokens = current.match(/(?:[$€£]\s*)?\d[\d,.]*(?:\s*[$€£])?/g) || [];
        const match = tokens.find((token) => (
            String(token.match(/\d[\d,.]*/)?.[0] || '').replace(/,/g, '') === requestedNumber
        ));
        if (match) return match.trim();
    }
    return '';
}

function _hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function _setPrimaryContent(target, text) {
    if (!target || typeof target !== 'object') return;
    target.text = text;
    for (const field of PRIMARY_CONTENT_FIELDS) {
        if (_hasOwn(target, field)) target[field] = text;
    }
    if (target.agenticComposition && typeof target.agenticComposition === 'object') {
        target.agenticComposition.title = text;
    }
}

function _clearSecondaryContent(target) {
    if (!target || typeof target !== 'object') return;
    for (const field of SECONDARY_CONTENT_FIELDS) {
        if (_hasOwn(target, field) || field === 'subtext') target[field] = '';
    }
    if (target.agenticComposition && typeof target.agenticComposition === 'object') {
        target.agenticComposition.subtitle = '';
        target.agenticComposition.kicker = '';
        if (Array.isArray(target.agenticComposition.items)) target.agenticComposition.items = [];
    }
}

function _contentSnapshot(visual) {
    return JSON.stringify({
        text: _displayText(visual),
        subtext: _displaySubtext(visual),
        mgDataText: _displayText(visual?.mgData),
        mgDataSubtext: _displaySubtext(visual?.mgData),
        agenticTitle: visual?.agenticComposition?.title,
        agenticSubtitle: visual?.agenticComposition?.subtitle,
    });
}

function _resolveContentTargets(plan, scope, operation) {
    let entries = resolveVisualTargets(plan, scope);
    const targetIds = new Set((operation.targetIds || []).map((id) => String(id || '')).filter(Boolean));
    if (targetIds.size) {
        entries = entries.filter(({ visual }) => targetIds.has(String(visual?.id || visual?.clipId || '')));
    }
    if (operation.targetType) {
        const wanted = _typeKey(operation.targetType);
        entries = entries.filter(({ visual }) => _typeKey(_graphicType(visual)) === wanted);
    }
    if (!entries.length) {
        throw new Error(`No existing ${operation.targetType || 'motion graphic'} was found in the active scope`);
    }
    if (operation.all === true || entries.length === 1) return entries;

    const sourceIndexes = new Set((scope?.clipRefs || []).map((ref) => Number(ref.sourceSceneIndex)));
    if (sourceIndexes.size === 1) {
        const exactScene = entries.filter(({ visual }) => (
            sourceIndexes.has(Number(visual?.sourceSceneIndex ?? visual?.sceneIndex))
        ));
        if (exactScene.length === 1) return exactScene;
    }

    const currentTime = Number(scope?.currentTime);
    if (Number.isFinite(currentTime)) {
        const active = entries.filter(({ visual }) => {
            const timing = windowOf(visual, 3);
            return currentTime >= timing.startTime - 0.001 && currentTime <= timing.endTime + 0.001;
        });
        if (active.length === 1) return active;
    }
    throw new Error(
        `More than one ${operation.targetType || 'graphic'} matches this scope. `
        + 'Select the exact graphic, or say to edit all matching graphics.'
    );
}

function editScopedGraphicContent(plan, scope, operation = {}, options = {}) {
    const requestedText = String(operation.text || '').trim();
    if (!requestedText) throw new Error('Graphic content editing requires the replacement text');
    const targets = _resolveContentTargets(plan, scope, operation);

    let changed = 0;
    const edits = [];
    for (const { collection, visual } of targets) {
        const before = JSON.stringify(visual);
        requireFixedRenderer(visual, 'editor-agent-content');
        const previousText = _displayText(visual);
        const text = operation.mode === 'retain'
            ? _retainedText(previousText, requestedText)
            : requestedText;
        if (!text) {
            throw new Error(`"${requestedText}" was not found in the existing graphic text`);
        }
        _setPrimaryContent(visual, text);
        if (visual.mgData && typeof visual.mgData === 'object') {
            _setPrimaryContent(visual.mgData, text);
        }
        if (operation.clearSubtext === true) {
            _clearSecondaryContent(visual);
            if (visual.mgData && typeof visual.mgData === 'object') {
                _clearSecondaryContent(visual.mgData);
            }
        }
        if (before !== JSON.stringify(visual)) {
            changed++;
            edits.push({
                id: String(visual.id || visual.clipId || ''),
                collection,
                type: _graphicType(visual),
                beforeText: previousText,
                afterText: text,
            });
        }
    }
    if (!changed) throw new Error('The selected graphic already has that exact content');
    options.log?.(
        `Motion Graphics Editor updated content in ${changed} existing graphic(s) without changing design or timing`
    );
    return {
        changed,
        edited: changed,
        edits,
    };
}

function _scopeVisualLabel(scope, visual) {
    const id = String(visual?.id || visual?.clipId || '');
    const refs = Array.isArray(scope?.visualRefs) ? scope.visualRefs : [];
    const exact = refs.find((ref) => String(ref?.id || '') === id);
    return String(exact?.label || refs[0]?.label || '').trim();
}

function _canonicalMatch(currentText, requestedText, occurrence = 0) {
    const current = String(currentText || '');
    const requested = String(requestedText || '').trim();
    if (!current || !requested) return '';
    const lower = current.toLocaleLowerCase();
    const needle = requested.toLocaleLowerCase();
    let fromIndex = 0;
    let found = -1;
    for (let index = 0; index <= occurrence; index++) {
        found = lower.indexOf(needle, fromIndex);
        if (found < 0) return '';
        fromIndex = found + Math.max(1, needle.length);
    }
    return current.slice(found, found + requested.length);
}

function _sameStyleRange(left, right) {
    return (
        String(left?.match || '').toLocaleLowerCase() === String(right?.match || '').toLocaleLowerCase()
        && Number(left?.occurrence || 0) === Number(right?.occurrence || 0)
        && Boolean(left?.allOccurrences) === Boolean(right?.allOccurrences)
    );
}

function editScopedGraphicTextStyle(plan, scope, operation = {}, options = {}) {
    const color = normalizeTextColor(operation.color || operation.textColor || operation.fill);
    if (!color) throw new Error('Graphic text styling requires a valid color');
    const targets = _resolveContentTargets(plan, scope, operation);

    let changed = 0;
    const edits = [];
    for (const { collection, visual } of targets) {
        const before = JSON.stringify(visual);
        requireFixedRenderer(visual, 'editor-agent-text-style');
        const currentText = _displayText(visual);
        const requestedMatch = String(
            operation.matchText
            || operation.text
            || _scopeVisualLabel(scope, visual)
            || currentText
        ).trim();
        const occurrence = Number.isInteger(Number(operation.occurrence))
            ? Math.max(0, Number(operation.occurrence))
            : 0;
        const match = operation.wholeText === true
            ? currentText
            : _canonicalMatch(currentText, requestedMatch, occurrence);
        if (!match) {
            throw new Error(`"${requestedMatch}" was not found in the existing graphic text`);
        }

        const beforeRanges = normalizeTextStyleRanges(
            visual.textStyleRanges || visual?.mgData?.textStyleRanges
        );
        const nextRange = {
            match,
            color,
            occurrence,
            allOccurrences: operation.allOccurrences === true,
        };
        const nextRanges = beforeRanges.filter((range) => !_sameStyleRange(range, nextRange));
        nextRanges.push(nextRange);
        if (JSON.stringify(beforeRanges) !== JSON.stringify(nextRanges)) {
            visual.textStyleRanges = nextRanges;
        }
        if (before === JSON.stringify(visual)) continue;
        changed++;
        edits.push({
            id: String(visual.id || visual.clipId || ''),
            collection,
            type: _graphicType(visual),
            text: currentText,
            match,
            color,
            beforeRanges,
            afterRanges: nextRanges,
        });
    }
    if (!changed) throw new Error('The selected graphic text already has that exact color');
    options.log?.(
        `Motion Graphics Editor recolored text in ${changed} existing graphic(s) without changing design or timing`
    );
    return {
        changed,
        edited: changed,
        edits,
    };
}

function _setGraphicField(visual, field, value) {
    if (value === undefined) {
        delete visual[field];
        if (visual.mgData && typeof visual.mgData === 'object') delete visual.mgData[field];
        return;
    }
    visual[field] = _cloneValue(value);
    if (visual.mgData && typeof visual.mgData === 'object') {
        visual.mgData[field] = _cloneValue(value);
    }
}

function _cloneValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _mergeGraphicObject(visual, field, values) {
    const current = visual[field] && typeof visual[field] === 'object'
        ? visual[field]
        : {};
    _setGraphicField(visual, field, { ...current, ...values });
}

function _setAgenticGraphicProperty(visual, path, value) {
    const targets = [visual, visual?.mgData].filter((target) => (
        target && typeof target === 'object'
    ));
    for (const target of targets) {
        if (!target.agenticComposition || typeof target.agenticComposition !== 'object') continue;
        let cursor = target.agenticComposition;
        for (let index = 0; index < path.length - 1; index++) {
            const key = path[index];
            if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
            cursor = cursor[key];
        }
        cursor[path[path.length - 1]] = _cloneValue(value);
    }
}

function _replacementLineage(sourceVisual) {
    const sourceId = String(sourceVisual?.id || sourceVisual?.clipId || '');
    const replacementIds = [...new Set([
        ...(Array.isArray(sourceVisual?._agentReplacesVisualIds)
            ? sourceVisual._agentReplacesVisualIds
            : []),
        sourceVisual?._agentReplacesVisualId,
        ...(Array.isArray(sourceVisual?.mgData?._agentReplacesVisualIds)
            ? sourceVisual.mgData._agentReplacesVisualIds
            : []),
        sourceVisual?.mgData?._agentReplacesVisualId,
        sourceId,
    ].map((value) => String(value || '')).filter(Boolean))];
    return {
        sourceId,
        replacementIds,
        originalId: String(
            sourceVisual?._agentReplacesVisualId
            || sourceVisual?.mgData?._agentReplacesVisualId
            || replacementIds[0]
            || sourceId
        ),
    };
}

function _buildReplacementForVisual(plan, sourceVisual, collection, type, operation) {
    const graphic = _cloneValue(sourceVisual) || {};
    const sourceTiming = windowOf(sourceVisual, collection === 'templateScenes' ? 4 : 3);
    const windowDuration = Math.max(0.5, sourceTiming.endTime - sourceTiming.startTime);
    const savedDuration = Number(sourceVisual?.duration);
    const duration = Number.isFinite(savedDuration)
        && savedDuration >= 0.5
        && Math.abs(savedDuration - windowDuration) < 0.05
        ? savedDuration
        : windowDuration;
    const lineage = _replacementLineage(sourceVisual);
    const sourceToken = lineage.sourceId
        || `${collection}-${Math.round(sourceTiming.startTime * 1000)}`;
    const nextId = _uniqueId(
        plan,
        `agent-mg-${sourceToken.replace(/[^a-zA-Z0-9._-]+/g, '-')}-${type}`
    );
    const fps = Math.max(1, Number(plan?.fps) || 30);

    graphic.id = nextId;
    graphic.clipId = nextId;
    graphic.type = type;
    graphic.startTime = sourceTiming.startTime;
    graphic.endTime = sourceTiming.endTime;
    graphic.duration = duration;
    graphic.durationFrames = Math.max(1, Math.round(duration * fps));
    graphic.durationUnit = 'seconds';
    graphic.selectionMode = 'editor-agent';
    graphic.agentInstruction = String(operation.instruction || '').slice(0, 500);
    graphic._agentReplacesVisualId = lineage.originalId;
    graphic._agentReplacesVisualIds = lineage.replacementIds;
    graphic.style = graphic.style || graphic?.mgData?.style || plan.mgStyle || 'clean';

    if (graphic.mgData && typeof graphic.mgData === 'object') {
        graphic.mgData.id = nextId;
        graphic.mgData.clipId = nextId;
        graphic.mgData.type = type;
        graphic.mgData.startTime = sourceTiming.startTime;
        graphic.mgData.endTime = sourceTiming.endTime;
        graphic.mgData.duration = duration;
        graphic.mgData.durationFrames = graphic.durationFrames;
        graphic.mgData.durationUnit = 'seconds';
        graphic.mgData.selectionMode = 'editor-agent';
        graphic.mgData.agentInstruction = graphic.agentInstruction;
        graphic.mgData._agentReplacesVisualId = lineage.originalId;
        graphic.mgData._agentReplacesVisualIds = [...lineage.replacementIds];
    }

    if (collection === 'templateScenes') {
        graphic.isMGScene = sourceVisual?.isMGScene !== false;
        graphic.mediaType = sourceVisual?.mediaType || 'template';
        graphic.trackId = sourceVisual?.trackId || sourceVisual?.mgData?.trackId || 'video-track-3';
        graphic.category = 'fullscreen';
        graphic.templateType = sourceVisual?.templateType === true ? true : type;
        if (graphic.mgData && typeof graphic.mgData === 'object') {
            graphic.mgData.templateType = sourceVisual?.mgData?.templateType === true ? true : type;
            graphic.mgData.mediaType = graphic.mediaType;
            graphic.mgData.trackId = graphic.trackId;
            graphic.mgData.category = 'fullscreen';
        }
    } else if (collection === 'mgScenes') {
        graphic.isMGScene = sourceVisual?.isMGScene !== false;
        graphic.trackId = sourceVisual?.trackId || sourceVisual?.mgData?.trackId || 'video-track-3';
        graphic.category = 'fullscreen';
        if (graphic.mgData && typeof graphic.mgData === 'object') {
            graphic.mgData.trackId = graphic.trackId;
            graphic.mgData.category = 'fullscreen';
        }
    } else {
        graphic.category = sourceVisual?.category || sourceVisual?.mgData?.category || 'overlay';
    }

    requireFixedRenderer(graphic, 'editor-agent-regenerate');
    return graphic;
}

function editScopedGraphicProperties(plan, scope, operation = {}, options = {}) {
    const targets = _resolveContentTargets(plan, scope, operation);

    let changed = 0;
    const edits = [];
    for (const { collection, visual } of targets) {
        const before = JSON.stringify(visual);
        requireFixedRenderer(visual, 'editor-agent-properties');

        if (operation.position) {
            _setGraphicField(visual, 'position', operation.position);
            _setGraphicField(visual, 'safeZone', operation.position);
            _setAgenticGraphicProperty(visual, ['safeZone'], operation.position);
        }
        if (operation.animation) {
            _setGraphicField(visual, 'animation', operation.animation);
            _setGraphicField(visual, 'animationManual', true);
            _setAgenticGraphicProperty(visual, ['motion', 'entrance'], operation.animation);
        }
        if (Number.isFinite(Number(operation.animationSpeed))) {
            const speed = Math.max(0.25, Math.min(3, Number(operation.animationSpeed)));
            _setGraphicField(visual, 'animationSpeed', speed);
            _setAgenticGraphicProperty(visual, ['motion', 'speed'], speed);
        } else if (Number.isFinite(Number(operation.animationSpeedScale))) {
            const current = Number(
                visual.animationSpeed
                ?? visual?.mgData?.animationSpeed
                ?? visual?.agenticComposition?.motion?.speed
                ?? 1
            ) || 1;
            const speed = Math.max(0.25, Math.min(3, current * Number(operation.animationSpeedScale)));
            _setGraphicField(visual, 'animationSpeed', speed);
            _setAgenticGraphicProperty(visual, ['motion', 'speed'], speed);
        }
        if (
            Number.isFinite(Number(operation.durationSeconds))
            || Number.isFinite(Number(operation.durationScale))
        ) {
            const timing = windowOf(visual, 3);
            const currentDuration = Math.max(0.5, timing.endTime - timing.startTime);
            const requestedDuration = Number.isFinite(Number(operation.durationSeconds))
                ? Number(operation.durationSeconds)
                : currentDuration * Number(operation.durationScale);
            const owner = _sceneForVisual(plan, visual);
            const ownerEnd = owner
                ? windowOf(owner.scene).endTime
                : Math.max(timing.startTime + 0.5, Number(plan?.totalDuration) || 0);
            const maxDuration = Math.max(0.5, ownerEnd - timing.startTime);
            const duration = Number(
                Math.max(0.5, Math.min(maxDuration, requestedDuration)).toFixed(3)
            );
            const endTime = Number((timing.startTime + duration).toFixed(3));
            const fps = Math.max(1, Number(plan?.fps) || 30);
            _setGraphicField(visual, 'duration', duration);
            _setGraphicField(visual, 'durationSeconds', duration);
            _setGraphicField(visual, 'endTime', endTime);
            _setGraphicField(visual, 'durationFrames', Math.max(1, Math.round(duration * fps)));
            _setGraphicField(visual, 'durationUnit', 'seconds');
            _setGraphicField(visual, 'timingManual', true);
        }
        if (operation.style) {
            _setGraphicField(visual, 'style', operation.style);
            _setGraphicField(visual, 'styleManual', true);
        }
        if (operation.variant) {
            _setGraphicField(visual, 'subType', operation.variant);
            _setGraphicField(visual, 'variant', operation.variant);
            _setGraphicField(visual, 'variantManual', true);
        }
        if (operation.graphicShell && typeof operation.graphicShell === 'object') {
            const existingShell = (
                visual?.graphicShell
                || visual?.mgData?.graphicShell
                || visual?.agenticComposition?.shell
                || visual?.mgData?.agenticComposition?.shell
                || {}
            );
            const shellRequest = operation.graphicShell.preset
                ? operation.graphicShell
                : { ...existingShell, ...operation.graphicShell };
            const shell = normalizeGraphicShell(shellRequest, {
                id: visual?.id || visual?.clipId,
                role: collection === 'motionGraphics' ? 'overlay' : (collection === 'templateScenes' ? 'template' : 'fullscreen'),
                type: _graphicType(visual),
                text: _displayText(visual),
                subtext: _displaySubtext(visual),
                items: visual?.items || visual?.mgData?.items || visual?.agenticComposition?.items || [],
                density: visual?.agenticComposition?.density,
                textStrategy: visual?.agenticComposition?.textStrategy,
                safeZone: visual?.safeZone || visual?.position,
                layout: visual?.agenticComposition?.layout,
                mood: `${visual?.style || ''} ${visual?.agenticComposition?.style?.mood || ''}`,
                manual: true,
            });
            _setGraphicField(visual, 'graphicShell', shell);
            _setGraphicField(visual, 'graphicShellManual', true);
            _setAgenticGraphicProperty(visual, ['shell'], shell);
            _setAgenticGraphicProperty(visual, ['style', 'shell'], shell);
            // A direct structural request is newer intent than stale card/accent
            // flags. Keep automatic shells subordinate to those flags, but let
            // an explicit Agent edit intentionally restore a surface or accent.
            if (shell.surface !== 'none') {
                _setGraphicField(visual, 'transparentBackground', false);
                if (
                    visual?.cardStyle === 'transparent'
                    || visual?.mgData?.cardStyle === 'transparent'
                ) {
                    _setGraphicField(
                        visual,
                        'cardStyle',
                        shell.surface === 'outline'
                            ? 'outline'
                            : (shell.surface === 'soft' ? 'glass' : 'filled')
                    );
                }
            }
            _setGraphicField(visual, 'accentRuleVisible', shell.accent !== 'none');
            _setAgenticGraphicProperty(
                visual,
                ['style', 'accentRule'],
                shell.accent !== 'none'
            );
        }
        if (
            operation.animation === 'typewriter'
            && _typeKey(_graphicType(visual)) === _typeKey('headline')
        ) {
            _setGraphicField(visual, 'subType', 'typewriter');
            _setGraphicField(visual, 'variant', 'typewriter');
            _setGraphicField(visual, 'variantManual', true);
        }
        if (operation.background) {
            _setGraphicField(visual, 'mgBackground', operation.background);
        }
        if (operation.transparentBackground === true) {
            _setGraphicField(visual, 'transparentBackground', true);
            _setGraphicField(visual, 'backgroundMode', 'transparent');
            _setGraphicField(visual, 'mgBackground', 'none');
            _setGraphicField(visual, 'cardStyle', 'transparent');
            _mergeGraphicObject(visual, 'colors', {
                background: 'rgba(0,0,0,0)',
                surface: 'rgba(0,0,0,0)',
            });
            _setAgenticGraphicProperty(visual, ['style', 'glass'], false);
            _setAgenticGraphicProperty(visual, ['style', 'background'], 'transparent');
        } else if (operation.backgroundColor) {
            _setGraphicField(visual, 'transparentBackground', false);
            _setGraphicField(visual, 'cardStyle', operation.cardStyle || 'filled');
            _mergeGraphicObject(visual, 'colors', {
                background: operation.backgroundColor,
                surface: operation.backgroundColor,
            });
            _setAgenticGraphicProperty(visual, ['style', 'background'], operation.backgroundColor);
        }
        if (typeof operation.accentRuleVisible === 'boolean') {
            _setGraphicField(visual, 'accentRuleVisible', operation.accentRuleVisible);
            _setAgenticGraphicProperty(
                visual,
                ['style', 'accentRule'],
                operation.accentRuleVisible
            );
        }
        const textColor = normalizeTextColor(operation.textColor);
        if (textColor) {
            _mergeGraphicObject(visual, 'colors', { text: textColor });
            _setGraphicField(visual, 'textColorManual', true);
            _setGraphicField(visual, 'textStyleRanges', []);
        }
        if (Number.isFinite(Number(operation.shadowStrength))) {
            _setGraphicField(
                visual,
                'overlayShadowStrength',
                Math.max(0, Math.min(1, Number(operation.shadowStrength)))
            );
        }

        if (before !== JSON.stringify(visual)) {
            changed++;
            edits.push({
                id: String(visual.id || visual.clipId || ''),
                collection,
                type: _graphicType(visual),
                fields: Object.keys(operation).filter((key) => ![
                    'targetIds', 'targetType', 'all',
                ].includes(key)),
            });
        }
    }
    if (!changed) throw new Error('The selected graphic already has those exact properties');
    options.log?.(`Motion Graphics Editor updated ${changed} existing graphic(s) in place`);
    return { changed, edited: changed, edits };
}

function regenerateScopedGraphics(plan, scope, operation = {}, options = {}) {
    let removed = 0;
    const visualTargets = scope.kind === 'visual' ? resolveVisualTargets(plan, scope) : [];

    if (operation.fewer === true) {
        const candidates = resolveVisualTargets(plan, scope);
        const removeIds = new Set(candidates.filter((_entry, index) => index % 2 === 1)
            .map(({ visual }) => String(visual.id || visual.clipId || '')));
        for (const collection of ['mgScenes', 'templateScenes', 'motionGraphics']) {
            if (!Array.isArray(plan[collection])) continue;
            plan[collection] = plan[collection].filter((visual) => {
                const remove = removeIds.has(String(visual.id || visual.clipId || ''));
                if (remove) removed++;
                return !remove;
            });
        }
        return { changed: removed, removed, added: 0 };
    }

    const action = operation.action === 'add' ? 'add' : 'regenerate';
    if (action === 'regenerate') removed = _removeVisualTargets(plan, scope, operation);

    const sceneTargets = [];
    if (visualTargets.length) {
        for (const { collection, visual } of visualTargets) {
            sceneTargets.push({
                scene: null,
                index: Number.isInteger(Number(visual?.sceneIndex))
                    ? Number(visual.sceneIndex)
                    : Number(visual?.sourceSceneIndex) || 0,
                collection,
                sourceVisual: visual,
                type: operation.requestedType || visual.type || visual.templateType || '',
            });
        }
    } else {
        for (const scene of resolveSceneTargets(plan, scope, { includeDescendants: true })) {
            const index = plan.scenes.indexOf(scene);
            if (index >= 0) sceneTargets.push({
                scene,
                index,
                collection: '',
                sourceVisual: null,
                type: operation.requestedType || '',
            });
        }
    }
    if (!sceneTargets.length) throw new Error('No visual or narration scene is available for motion-graphic regeneration');

    const maxGraphics = operation.effort === 'smart' ? 8 : 4;
    const spacedTargets = sceneTargets.length <= maxGraphics
        ? sceneTargets
        : sceneTargets.filter((_entry, index) => index % Math.ceil(sceneTargets.length / maxGraphics) === 0).slice(0, maxGraphics);
    const placedTypes = [
        ...(plan.motionGraphics || []),
        ...(plan.mgScenes || []),
    ].filter((visual) => !visual.disabled).map((visual) => visual.type);
    let added = 0;
    for (const { scene, index, collection, sourceVisual, type: targetType } of spacedTargets) {
        const type = targetType || _pickType(scene, index, plan, operation, placedTypes);
        const graphic = sourceVisual
            ? _buildReplacementForVisual(plan, sourceVisual, collection, type, operation)
            : _buildForScene(plan, scene, index, type, operation, null);
        if (!graphic) continue;
        _appendGraphic(plan, graphic, collection);
        placedTypes.push(type);
        added++;
        options.log?.(
            sourceVisual
                ? `Graphics worker regenerated ${type} in ${collection} without changing its role or timing`
                : `Graphics worker added ${type} for clip ${scene.clipId || index}`
        );
    }
    if (!added && !removed) throw new Error('The graphics worker could not produce a valid visual for this scope');
    return { changed: added + removed, removed, added };
}

module.exports = {
    GRAPHIC_EDITABLE_PROPERTIES,
    editScopedGraphicContent,
    editScopedGraphicProperties,
    editScopedGraphicTextStyle,
    inspectScopedGraphics,
    regenerateScopedGraphics,
};
