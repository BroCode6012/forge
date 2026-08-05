'use strict';

const timeline = require('./timeline-contract');

const EPSILON = 0.001;

function _finite(value, fallback = NaN) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function _window(item, fallbackDuration = 0) {
    const start = _finite(item?.startTime ?? item?.start, 0);
    const end = _finite(
        item?.endTime ?? item?.end,
        start + Math.max(0, _finite(item?.duration, fallbackDuration))
    );
    return { start, end: Math.max(start, end) };
}

function _overlaps(start, end, rangeStart, rangeEnd) {
    return end > rangeStart + EPSILON && start < rangeEnd - EPSILON;
}

function _clipAbsolutePair(start, end, rangeStart, rangeEnd) {
    const visibleStart = Math.max(start, rangeStart);
    const visibleEnd = Math.min(end, rangeEnd);
    if (!_overlaps(start, end, rangeStart, rangeEnd)) return null;
    return {
        start: visibleStart - rangeStart,
        end: visibleEnd - rangeStart,
        sourceOffset: visibleStart - start,
    };
}

function _clipWords(words, rangeStart, rangeEnd) {
    if (!Array.isArray(words)) return words;
    return words
        .map((word) => {
            const start = _finite(word?.start, NaN);
            const end = _finite(word?.end, start);
            const clipped = _clipAbsolutePair(start, end, rangeStart, rangeEnd);
            if (!clipped) return null;
            return {
                ...word,
                start: clipped.start,
                end: clipped.end,
            };
        })
        .filter(Boolean);
}

function _clipRelativeMoments(moments, sourceDelta, visibleDuration) {
    if (!Array.isArray(moments)) return moments;
    return moments
        .map((moment) => {
            const start = _finite(moment?.at, 0);
            const duration = Math.max(EPSILON, _finite(moment?.dur ?? moment?.duration, 1));
            const end = start + duration;
            const visibleStart = Math.max(start, sourceDelta);
            const visibleEnd = Math.min(end, sourceDelta + visibleDuration);
            if (visibleEnd <= visibleStart + EPSILON) return null;
            const out = {
                ...moment,
                at: visibleStart - sourceDelta,
            };
            if (moment?.dur != null) out.dur = visibleEnd - visibleStart;
            if (moment?.duration != null) out.duration = visibleEnd - visibleStart;
            return out;
        })
        .filter(Boolean);
}

function _shiftAbsoluteSpan(span, rangeStart, rangeEnd) {
    if (!span || typeof span !== 'object') return span;
    const start = _finite(span.start, NaN);
    const end = _finite(span.end, NaN);
    if (!(end > start)) return span;
    const clipped = _clipAbsolutePair(start, end, rangeStart, rangeEnd);
    return clipped ? { ...span, start: clipped.start, end: clipped.end } : null;
}

function _shiftTemplateContent(item, rangeStart, rangeEnd) {
    const start = _finite(item.templateContentStartTime, NaN);
    const end = _finite(item.templateContentEndTime, NaN);
    if (!(end > start)) return item;
    const clipped = _clipAbsolutePair(start, end, rangeStart, rangeEnd);
    if (!clipped) {
        delete item.templateContentStartTime;
        delete item.templateContentEndTime;
        delete item.templateContentDuration;
        delete item.templateContentOffset;
        return item;
    }
    item.templateContentStartTime = clipped.start;
    item.templateContentEndTime = clipped.end;
    item.templateContentDuration = clipped.end - clipped.start;
    item.templateContentOffset = Math.max(0, _finite(item.templateContentOffset, 0) + clipped.sourceOffset);
    return item;
}

function _renderRangeClip(item, sourceWindow, clipped, rangeStart, rangeEnd, visibleDuration) {
    const previous = item?._renderRangeClip && typeof item._renderRangeClip === 'object'
        ? item._renderRangeClip
        : null;
    const clippedAtStart = sourceWindow.start < rangeStart - EPSILON;
    const clippedAtEnd = sourceWindow.end > rangeEnd + EPSILON;
    if (!previous && !clippedAtStart && !clippedAtEnd) return null;

    const previousOffset = Math.max(0, _finite(previous?.sourceOffset, 0));
    const sourceDuration = Math.max(
        visibleDuration,
        _finite(previous?.sourceDuration, sourceWindow.end - sourceWindow.start)
    );
    return {
        sourceStartTime: _finite(previous?.sourceStartTime, sourceWindow.start),
        sourceEndTime: _finite(previous?.sourceEndTime, sourceWindow.end),
        sourceDuration,
        sourceOffset: Math.min(sourceDuration, previousOffset + clipped.sourceOffset),
        visibleDuration,
        clippedAtStart: Boolean(previous?.clippedAtStart || clippedAtStart),
        clippedAtEnd: Boolean(previous?.clippedAtEnd || clippedAtEnd),
    };
}

function _clipTimedItem(item, rangeStart, rangeEnd, fps, options = {}) {
    const sourceWindow = _window(item, options.fallbackDuration);
    const clipped = _clipAbsolutePair(sourceWindow.start, sourceWindow.end, rangeStart, rangeEnd);
    if (!clipped) return null;

    const duration = clipped.end - clipped.start;
    const out = {
        ...item,
        startTime: clipped.start,
        endTime: clipped.end,
        duration,
        durationFrames: Math.max(1, Math.round(duration * fps)),
        durationUnit: 'seconds',
    };
    delete out._hfTiming;

    if (options.trackRenderRange) {
        const rangeClip = _renderRangeClip(item, sourceWindow, clipped, rangeStart, rangeEnd, duration);
        if (rangeClip) out._renderRangeClip = rangeClip;
        else delete out._renderRangeClip;
    }
    if (options.adjustMediaOffset) {
        out.mediaOffset = Math.max(0, _finite(item.mediaOffset, 0) + clipped.sourceOffset);
    }
    if (Array.isArray(item.words)) out.words = _clipWords(item.words, rangeStart, rangeEnd);
    if (Array.isArray(item._iconMoments)) {
        out._iconMoments = _clipRelativeMoments(item._iconMoments, clipped.sourceOffset, duration);
    }
    if (Array.isArray(item._keywordGlow)) {
        out._keywordGlow = _clipRelativeMoments(item._keywordGlow, clipped.sourceOffset, duration);
    }
    if (item._presenterSpan) {
        const span = _shiftAbsoluteSpan(item._presenterSpan, rangeStart, rangeEnd);
        if (span) out._presenterSpan = span;
        else delete out._presenterSpan;
    }
    _shiftTemplateContent(out, rangeStart, rangeEnd);
    return out;
}

function _clipTransition(transition, rangeStart, rangeEnd, keptClipIds, sourceCounts) {
    const fromClipId = transition?.fromClipId != null ? String(transition.fromClipId) : null;
    const toClipId = transition?.toClipId != null ? String(transition.toClipId) : null;
    if (fromClipId || toClipId) {
        if (!fromClipId || !toClipId || !keptClipIds.has(fromClipId) || !keptClipIds.has(toClipId)) return null;
    } else {
        const fromSource = transition?.fromSceneIndex;
        const toSource = transition?.toSceneIndex;
        if (sourceCounts.get(String(fromSource)) !== 1 || sourceCounts.get(String(toSource)) !== 1) return null;
    }

    const out = { ...transition };
    if (Number.isFinite(_finite(transition.startTime))) {
        out.startTime = Math.max(0, _finite(transition.startTime) - rangeStart);
    }
    if (Number.isFinite(_finite(transition.at))) {
        out.at = Math.max(0, _finite(transition.at) - rangeStart);
    }
    if (Number.isFinite(_finite(transition.endTime))) {
        out.endTime = Math.min(rangeEnd - rangeStart, Math.max(0, _finite(transition.endTime) - rangeStart));
    }
    return out;
}

function clipPlanForRange(plan, startSec, endSec) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        throw new Error('Range clipping requires a video plan object');
    }
    const normalized = timeline.normalizePlan(plan);
    const fps = normalized.fps || 30;
    const fullDuration = Math.max(0, _finite(normalized.totalDuration, 0));
    const rangeStart = Math.max(0, _finite(startSec, 0));
    const rangeEnd = Math.min(
        fullDuration > 0 ? fullDuration : Number.MAX_SAFE_INTEGER,
        _finite(endSec, fullDuration)
    );
    if (!(rangeEnd > rangeStart + EPSILON)) {
        throw new Error(`Invalid render range: ${startSec} to ${endSec}`);
    }

    const clipped = {
        ...normalized,
        totalDuration: rangeEnd - rangeStart,
        renderRange: {
            sourceStartSec: rangeStart,
            sourceEndSec: rangeEnd,
            durationSec: rangeEnd - rangeStart,
            endExclusive: true,
        },
    };

    clipped.scenes = normalized.scenes
        .map((scene) => _clipTimedItem(scene, rangeStart, rangeEnd, fps, { adjustMediaOffset: true }))
        .filter(Boolean);
    clipped.mgScenes = normalized.mgScenes
        .map((scene) => _clipTimedItem(scene, rangeStart, rangeEnd, fps, {
            fallbackDuration: 3,
            trackRenderRange: true,
        }))
        .filter(Boolean);
    clipped.templateScenes = normalized.templateScenes
        .map((scene) => _clipTimedItem(scene, rangeStart, rangeEnd, fps, {
            fallbackDuration: 4,
            trackRenderRange: true,
        }))
        .filter(Boolean);

    for (const key of ['motionGraphics', 'overlayScenes']) {
        if (!Array.isArray(normalized[key])) continue;
        clipped[key] = normalized[key]
            .map((item) => _clipTimedItem(item, rangeStart, rangeEnd, fps, {
                fallbackDuration: 0.5,
                trackRenderRange: true,
            }))
            .filter(Boolean);
    }

    if (Array.isArray(normalized.sfxClips)) {
        clipped.sfxClips = normalized.sfxClips
            .map((item) => {
                const sourceWindow = _window(item, 0.5);
                const result = _clipTimedItem(item, rangeStart, rangeEnd, fps, { fallbackDuration: 0.5 });
                if (!result) return null;
                const audibleSourceStart = Math.max(sourceWindow.start, rangeStart);
                result.sourceOffset = Math.max(0, _finite(item.sourceOffset, 0) + audibleSourceStart - sourceWindow.start);
                return result;
            })
            .filter(Boolean);
    }

    const keptClipIds = new Set(clipped.scenes.map((scene) => String(scene.clipId)));
    const sourceCounts = new Map();
    for (const scene of clipped.scenes) {
        const key = String(scene.sourceSceneIndex ?? scene.index);
        sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
    }
    if (Array.isArray(normalized.transitions)) {
        clipped.transitions = normalized.transitions
            .map((transition) => _clipTransition(
                transition,
                rangeStart,
                rangeEnd,
                keptClipIds,
                sourceCounts
            ))
            .filter(Boolean);
    }

    if (clipped.scriptContext && typeof clipped.scriptContext === 'object') {
        clipped.scriptContext = { ...clipped.scriptContext };
        for (const key of ['hookEndTime', 'ctaStartTime', 'ctaEndTime']) {
            if (Number.isFinite(_finite(clipped.scriptContext[key]))) {
                clipped.scriptContext[key] = Math.min(
                    clipped.totalDuration,
                    Math.max(0, _finite(clipped.scriptContext[key]) - rangeStart)
                );
            }
        }
    }

    clipped.continuityHolds = timeline.buildContinuityHolds(clipped.scenes, {
        fps,
        totalDuration: clipped.totalDuration,
    });
    return clipped;
}

module.exports = {
    clipPlanForRange,
};
