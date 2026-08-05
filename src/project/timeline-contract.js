'use strict';

(function exposeTimelineContract(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.YtaTimelineContract = api;
}(typeof window !== 'undefined' ? window : null, function createTimelineContract() {
    const VERSION = 3;
    const DEFAULT_FPS = 30;
    const MIN_DURATION_SEC = 0.05;
    const DEFAULT_CONTINUITY_TRACK = 'video-track-1';

    function finiteNumber(value, fallback = NaN) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function safeToken(value, fallback = 'item') {
        const token = String(value == null ? '' : value)
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 96);
        return token || fallback;
    }

    function resolveSourceSceneIndex(scene, fallbackIndex = 0) {
        const candidates = [
            scene?.sourceSceneIndex,
            scene?.index,
            scene?.originalIndex,
            scene?._fileIndex,
            fallbackIndex,
        ];
        for (const candidate of candidates) {
            if (candidate === '' || candidate == null) continue;
            const numeric = Number(candidate);
            if (Number.isFinite(numeric)) return numeric;
            return String(candidate);
        }
        return fallbackIndex;
    }

    function _rawDurationSeconds(item, fps, referenceSpan = NaN) {
        const explicitSeconds = [
            item?.durationSeconds,
            item?.durationSec,
            item?.displayDuration,
        ].map((value) => finiteNumber(value)).find((value) => Number.isFinite(value) && value > 0);
        if (Number.isFinite(explicitSeconds)) return explicitSeconds;

        const durationFrames = finiteNumber(item?.durationFrames);
        if (durationFrames > 0) return durationFrames / fps;

        const rawDuration = finiteNumber(item?.duration);
        if (!(rawDuration > 0)) return NaN;
        if (String(item?.durationUnit || item?.timingUnit || '').toLowerCase() === 'frames') {
            return rawDuration / fps;
        }

        // Older director plans stored duration in frames while start/end used
        // seconds. Infer that format only when a neighbouring/total span proves it.
        if (Number.isFinite(referenceSpan) && referenceSpan > 0) {
            const asFrames = rawDuration / fps;
            if (Math.abs(asFrames - referenceSpan) <= Math.max(0.05, 1 / fps)
                && Math.abs(rawDuration - referenceSpan) > 0.05) {
                return asFrames;
            }
        }
        return rawDuration;
    }

    function normalizeTiming(item = {}, options = {}) {
        const fps = Math.max(1, finiteNumber(options.fps, DEFAULT_FPS));
        const fallbackDuration = Math.max(
            MIN_DURATION_SEC,
            finiteNumber(options.fallbackDuration, 3)
        );
        const startTime = Math.max(0, finiteNumber(item.startTime ?? item.start, 0));
        const explicitEnd = finiteNumber(item.endTime ?? item.end);
        const nextStart = finiteNumber(options.nextStart);
        const totalDuration = finiteNumber(options.totalDuration);
        const referenceEnd = nextStart > startTime
            ? nextStart
            : (totalDuration > startTime ? totalDuration : NaN);
        const referenceSpan = Number.isFinite(referenceEnd) ? referenceEnd - startTime : NaN;
        const durationCandidate = _rawDurationSeconds(item, fps, referenceSpan);

        let endTime;
        if (explicitEnd > startTime) {
            endTime = explicitEnd;
        } else if (durationCandidate > 0) {
            endTime = startTime + durationCandidate;
        } else if (referenceEnd > startTime) {
            endTime = referenceEnd;
        } else {
            endTime = startTime + fallbackDuration;
        }

        if (!(endTime > startTime)) endTime = startTime + fallbackDuration;
        const duration = Math.max(MIN_DURATION_SEC, endTime - startTime);
        return {
            startTime,
            endTime: startTime + duration,
            duration,
            durationFrames: Math.max(1, Math.round(duration * fps)),
            durationUnit: 'seconds',
        };
    }

    function buildClipId(scene, fallbackIndex, timing, prefix = 'clip') {
        if (scene?.clipId != null && String(scene.clipId).trim()) {
            return safeToken(scene.clipId, `${prefix}-${fallbackIndex}`);
        }
        const source = safeToken(resolveSourceSceneIndex(scene, fallbackIndex), String(fallbackIndex));
        const track = safeToken(scene?.trackId || 'video-track-1', 'track');
        const startMs = Math.round(timing.startTime * 1000);
        const endMs = Math.round(timing.endTime * 1000);
        return `${safeToken(prefix, 'clip')}-${source}-${track}-${startMs}-${endMs}`;
    }

    function _dedupeId(baseId, usedIds) {
        let id = safeToken(baseId, 'clip');
        let suffix = 2;
        while (usedIds.has(id)) id = `${safeToken(baseId, 'clip')}-${suffix++}`;
        usedIds.add(id);
        return id;
    }

    function normalizeScenes(scenes, options = {}) {
        if (!Array.isArray(scenes)) return [];
        const fps = Math.max(1, finiteNumber(options.fps, DEFAULT_FPS));
        const totalDuration = finiteNumber(options.totalDuration);
        const prefix = options.prefix || 'clip';
        const usedIds = new Set();

        return scenes.map((rawScene, index) => {
            const scene = rawScene && typeof rawScene === 'object' ? rawScene : {};
            const nextStart = index + 1 < scenes.length
                ? finiteNumber(scenes[index + 1]?.startTime ?? scenes[index + 1]?.start)
                : NaN;
            const timing = normalizeTiming(scene, {
                fps,
                totalDuration,
                nextStart,
                fallbackDuration: options.fallbackDuration,
            });
            const sourceSceneIndex = resolveSourceSceneIndex(scene, index);
            const planIndex = scene.index != null && scene.index !== ''
                ? scene.index
                : index;
            const clipId = _dedupeId(
                buildClipId(scene, index, timing, prefix),
                usedIds
            );
            return {
                ...scene,
                index: planIndex,
                sourceSceneIndex,
                clipId,
                ...timing,
            };
        });
    }

    function normalizeVisualScenes(scenes, options = {}) {
        if (!Array.isArray(scenes)) return [];
        const fps = Math.max(1, finiteNumber(options.fps, DEFAULT_FPS));
        const totalDuration = finiteNumber(options.totalDuration);
        const prefix = options.prefix || 'visual';
        const usedIds = new Set();

        return scenes.map((rawScene, index) => {
            const scene = rawScene && typeof rawScene === 'object' ? rawScene : {};
            const timing = normalizeTiming(scene, {
                fps,
                totalDuration,
                fallbackDuration: options.fallbackDuration,
            });
            const semanticId = scene.id || `${scene.type || prefix}-${index}`;
            const baseClipId = scene.clipId
                ? safeToken(scene.clipId, `${prefix}-${index}`)
                : `${safeToken(prefix, 'visual')}-${safeToken(semanticId, String(index))}-${Math.round(timing.startTime * 1000)}`;
            const clipId = _dedupeId(baseClipId, usedIds);
            return {
                ...scene,
                clipId,
                ...timing,
            };
        });
    }

    function _mediaOffsetSeconds(scene) {
        const candidates = [
            scene?.mediaOffset,
            scene?.templateMediaOffset,
            scene?.clipOffset,
            scene?.sourceOffset,
            scene?.sourceStart,
            scene?.trimStart,
            scene?.mediaStart,
            scene?.videoStart,
            scene?.startOffset,
        ];
        for (const candidate of candidates) {
            const numeric = finiteNumber(candidate);
            if (numeric >= 0) return numeric;
        }
        return 0;
    }

    function buildContinuityHolds(scenes, options = {}) {
        if (!Array.isArray(scenes) || !scenes.length) return [];
        const fps = Math.max(1, finiteNumber(options.fps, DEFAULT_FPS));
        const totalDuration = Math.max(0, finiteNumber(options.totalDuration, 0));
        const trackId = String(options.trackId || DEFAULT_CONTINUITY_TRACK);
        const gapThreshold = Math.max(
            MIN_DURATION_SEC,
            finiteNumber(options.gapThreshold, Math.max(MIN_DURATION_SEC, 2 / fps))
        );
        const sourceScenes = scenes
            .filter((scene) => (
                scene
                && scene.disabled !== true
                && scene.isMGScene !== true
                && String(scene.trackId || DEFAULT_CONTINUITY_TRACK) === trackId
                && finiteNumber(scene.endTime) > finiteNumber(scene.startTime, 0)
            ))
            .map((scene, index) => ({
                scene,
                index,
                start: Math.max(0, finiteNumber(scene.startTime, 0)),
                end: Math.max(0, finiteNumber(scene.endTime, 0)),
            }))
            .sort((left, right) => left.start - right.start || left.end - right.end);
        if (!sourceScenes.length) return [];

        const resolvedDuration = totalDuration > 0
            ? totalDuration
            : Math.max(...sourceScenes.map((entry) => entry.end));
        const coverage = [];
        for (const entry of sourceScenes) {
            const last = coverage[coverage.length - 1];
            if (!last || entry.start > last.end + gapThreshold) {
                coverage.push({
                    start: entry.start,
                    end: entry.end,
                    first: entry,
                    last: entry,
                });
            } else {
                last.end = Math.max(last.end, entry.end);
                if (entry.end >= last.last.end) last.last = entry;
            }
        }

        const gaps = [];
        if (coverage[0].start > gapThreshold) {
            gaps.push({
                start: 0,
                end: coverage[0].start,
                source: coverage[0].first,
                holdMode: 'head',
            });
        }
        for (let index = 0; index < coverage.length - 1; index++) {
            const current = coverage[index];
            const next = coverage[index + 1];
            if (next.start - current.end <= gapThreshold) continue;
            gaps.push({
                start: current.end,
                end: next.start,
                source: current.last,
                holdMode: 'tail',
            });
        }
        const finalCoverage = coverage[coverage.length - 1];
        if (resolvedDuration - finalCoverage.end > gapThreshold) {
            gaps.push({
                start: finalCoverage.end,
                end: resolvedDuration,
                source: finalCoverage.last,
                holdMode: 'tail',
            });
        }

        return gaps.map((gap) => {
            const source = gap.source.scene;
            const duration = Math.max(MIN_DURATION_SEC, gap.end - gap.start);
            const sourceDuration = Math.max(
                MIN_DURATION_SEC,
                finiteNumber(source.endTime, 0) - finiteNumber(source.startTime, 0)
            );
            const mediaOffset = _mediaOffsetSeconds(source);
            const freezeTime = gap.holdMode === 'head'
                ? mediaOffset
                : mediaOffset + Math.max(0, sourceDuration - 1 / fps);
            const sourceClipId = String(
                source.clipId
                || buildClipId(source, gap.source.index, {
                    startTime: gap.source.start,
                    endTime: gap.source.end,
                })
            );
            const startMs = Math.round(gap.start * 1000);
            const endMs = Math.round(gap.end * 1000);
            return {
                clipId: `continuity-${safeToken(sourceClipId, 'source')}-${startMs}-${endMs}`,
                isContinuityHold: true,
                reason: 'timeline-continuity',
                trackId,
                sourceClipId,
                sourceSceneIndex: resolveSourceSceneIndex(source, gap.source.index),
                holdMode: gap.holdMode,
                freezeTime,
                startTime: gap.start,
                endTime: gap.end,
                duration,
                durationFrames: Math.max(1, Math.round(duration * fps)),
                durationUnit: 'seconds',
            };
        });
    }

    function withContinuityHolds(plan, options = {}) {
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return plan;
        const fps = Math.max(1, finiteNumber(plan.fps, DEFAULT_FPS));
        const explicitDuration = finiteNumber(plan.totalDuration);
        const normalizedScenes = normalizeScenes(plan.scenes || [], {
            fps,
            totalDuration: explicitDuration,
            fallbackDuration: options.fallbackDuration,
        });
        const sceneDuration = normalizedScenes.length
            ? Math.max(...normalizedScenes.map((scene) => finiteNumber(scene.endTime, 0)))
            : 0;
        const totalDuration = explicitDuration > 0 ? explicitDuration : sceneDuration;
        const continuityHolds = buildContinuityHolds(normalizedScenes, {
            fps,
            totalDuration,
            trackId: options.continuityTrackId || DEFAULT_CONTINUITY_TRACK,
            gapThreshold: options.continuityGapThreshold,
        });
        const alreadyContracted = Object.prototype.hasOwnProperty.call(plan, 'continuityHolds')
            || Object.prototype.hasOwnProperty.call(plan, 'timelineContractVersion');
        if (!continuityHolds.length && !alreadyContracted) return { ...plan };
        return {
            ...plan,
            timelineContractVersion: VERSION,
            continuityHolds,
        };
    }

    function normalizePlan(plan, options = {}) {
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return plan;
        const fps = Math.max(1, finiteNumber(plan.fps, DEFAULT_FPS));
        const totalDuration = finiteNumber(plan.totalDuration);
        const normalized = {
            ...plan,
            fps,
            timelineContractVersion: VERSION,
            scenes: normalizeScenes(plan.scenes || [], {
                fps,
                totalDuration,
                fallbackDuration: options.fallbackDuration,
            }),
            mgScenes: normalizeVisualScenes(plan.mgScenes || [], {
                fps,
                totalDuration,
                prefix: 'mg',
            }),
            templateScenes: normalizeVisualScenes(plan.templateScenes || [], {
                fps,
                totalDuration,
                prefix: 'template',
                fallbackDuration: 4,
            }),
        };

        const ends = [
            ...normalized.scenes,
            ...normalized.mgScenes,
            ...normalized.templateScenes,
        ].map((scene) => finiteNumber(scene.endTime, 0));
        const computedDuration = ends.length ? Math.max(0, ...ends) : 0;
        normalized.totalDuration = totalDuration > 0 ? totalDuration : computedDuration;
        normalized.continuityHolds = buildContinuityHolds(normalized.scenes, {
            fps,
            totalDuration: normalized.totalDuration,
            trackId: options.continuityTrackId || DEFAULT_CONTINUITY_TRACK,
            gapThreshold: options.continuityGapThreshold,
        });
        return normalized;
    }

    function serializeScenes(scenes, options = {}) {
        const fps = Math.max(1, finiteNumber(options.fps, DEFAULT_FPS));
        return normalizeScenes(scenes, {
            fps,
            totalDuration: options.totalDuration,
            fallbackDuration: options.fallbackDuration,
            prefix: options.prefix || 'clip',
        }).map((scene, index) => {
            const {
                _startFrame,
                _endFrame,
                _totalFrames,
                _trackNum,
                ...persisted
            } = scene;
            return {
                ...persisted,
                index,
                sourceSceneIndex: resolveSourceSceneIndex(scene, index),
                duration: scene.endTime - scene.startTime,
                durationFrames: Math.max(1, Math.round((scene.endTime - scene.startTime) * fps)),
                durationUnit: 'seconds',
            };
        });
    }

    function serializeVisualScenes(scenes, options = {}) {
        const fps = Math.max(1, finiteNumber(options.fps, DEFAULT_FPS));
        return normalizeVisualScenes(scenes, {
            fps,
            totalDuration: options.totalDuration,
            fallbackDuration: options.fallbackDuration,
            prefix: options.prefix || 'visual',
        }).map((scene) => {
            const {
                _startFrame,
                _endFrame,
                _totalFrames,
                _trackNum,
                ...persisted
            } = scene;
            return {
                ...persisted,
                duration: scene.endTime - scene.startTime,
                durationFrames: Math.max(1, Math.round((scene.endTime - scene.startTime) * fps)),
                durationUnit: 'seconds',
            };
        });
    }

    return {
        VERSION,
        buildClipId,
        buildContinuityHolds,
        finiteNumber,
        normalizePlan,
        normalizeScenes,
        normalizeTiming,
        normalizeVisualScenes,
        resolveSourceSceneIndex,
        safeToken,
        serializeScenes,
        serializeVisualScenes,
        withContinuityHolds,
    };
}));
