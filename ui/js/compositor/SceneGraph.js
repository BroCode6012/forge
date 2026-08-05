/**
 * SceneGraph.js — Frame-based timeline evaluation
 * Converts video-plan.json (seconds) to frame-based internal representation.
 * Answers "what layers are active at frame N?" for the compositor.
 */

let _timelineContract = typeof window !== 'undefined' ? window.YtaTimelineContract : null;
if (!_timelineContract && typeof module !== 'undefined' && module.exports) {
    try { _timelineContract = require('../../../src/project/timeline-contract'); } catch (_) { }
}

class SceneGraph {
    constructor(fps) {
        this.fps = fps || 30;
        this._scenes = [];        // { ...scene, _startFrame, _endFrame, _trackNum }
        this._mgs = [];           // { ...mg, _startFrame, _endFrame, _totalFrames }
        this._transitions = [];   // { fromClipId, toClipId, type, _startFrame, _endFrame, durationFrames }
        this._totalFrames = 0;
    }

    /**
     * Load from a video-plan.json object (as stored in state.videoPlan).
     * Uses the same scene structure as app.js state.scenes.
     */
    loadFromPlan(plan) {
        const fps = plan.fps || this.fps;
        this.fps = fps;
        this._scenes = [];
        this._mgs = [];
        this._transitions = [];

        // --- Parse scenes ---
        const allScenes = [];

        // Regular scenes
        const normalizedPlan = _timelineContract?.normalizePlan
            ? _timelineContract.normalizePlan(plan)
            : plan;
        const regularScenes = normalizedPlan.scenes || [];
        if (regularScenes.length) {
            for (const scene of regularScenes) {
                allScenes.push(this._parseScene(scene, fps));
            }
        }
        const regularByClipId = new Map(
            regularScenes
                .filter((scene) => scene?.clipId)
                .map((scene) => [String(scene.clipId), scene])
        );
        for (const hold of normalizedPlan.continuityHolds || []) {
            const source = regularByClipId.get(String(hold.sourceClipId || ''));
            if (!source) continue;
            allScenes.push(this._parseScene({
                ...source,
                clipId: hold.clipId,
                index: hold.clipId,
                sourceSceneIndex: hold.clipId,
                startTime: hold.startTime,
                endTime: hold.endTime,
                duration: hold.duration,
                durationFrames: hold.durationFrames,
                mediaOffset: hold.freezeTime,
                isContinuityHold: true,
                continuitySourceClipId: hold.sourceClipId,
                continuitySourceSceneIndex: hold.sourceSceneIndex,
                transition: null,
                transitionType: 'cut',
            }, fps));
        }

        // Full-screen MG scenes (from mgScenes array)
        const fullscreenMGs = _timelineContract?.normalizeVisualScenes
            ? _timelineContract.normalizeVisualScenes(normalizedPlan.mgScenes || [], {
                fps,
                totalDuration: normalizedPlan.totalDuration,
                prefix: 'mg',
            })
            : (normalizedPlan.mgScenes || []);
        if (fullscreenMGs.length) {
            for (const mg of fullscreenMGs) {
                const s = this._parseScene({
                    ...mg,
                    isMGScene: true,
                    trackId: mg.trackId || 'video-track-3',
                    mediaType: 'motion-graphic',
                }, fps);
                allScenes.push(s);
            }
        }

        this._scenes = allScenes;

        // --- Parse overlay motion graphics ---
        if (normalizedPlan.motionGraphics && normalizedPlan.motionGraphics.length) {
            for (const mg of normalizedPlan.motionGraphics) {
                const startFrame = Math.round((mg.startTime || 0) * fps);
                const dur = mg.duration || 3;
                const endFrame = Math.round((mg.startTime + dur) * fps);
                this._mgs.push({
                    ...mg,
                    _startFrame: startFrame,
                    _endFrame: endFrame,
                    _totalFrames: endFrame - startFrame,
                    _animationSpeed: mg.animationSpeed || normalizedPlan.scriptContext?.mgAnimationSpeed || 1.0,
                });
            }
        }

        // --- Parse transitions ---
        if (normalizedPlan.transitions && normalizedPlan.transitions.length) {
            for (const t of normalizedPlan.transitions) {
                if (!t.type || t.type === 'cut' || t.type === 'none') continue; // Skip hard cuts
                const dur = t.duration || 0.5; // seconds
                const durationFrames = Math.round(dur * fps);
                const halfDur = Math.round(durationFrames / 2);
                // Transition straddles the cut point: half in sceneA, half in sceneB
                const fromScene = this._resolveTransitionScene(allScenes, t.fromClipId, t.fromSceneIndex);
                const toScene = this._resolveTransitionScene(allScenes, t.toClipId, t.toSceneIndex);
                if (!fromScene || !toScene) continue;
                const cutFrame = toScene._startFrame; // = fromScene._endFrame for adjacent scenes
                const transStart = Math.max(fromScene._startFrame, cutFrame - halfDur);
                const transEnd = Math.min(toScene._endFrame, cutFrame + halfDur);
                if (transEnd <= transStart) continue;
                this._transitions.push({
                    fromClipId: fromScene.clipId,
                    toClipId: toScene.clipId,
                    fromIndex: t.fromSceneIndex,
                    toIndex: t.toSceneIndex,
                    type: t.type,
                    _startFrame: transStart,
                    _endFrame: transEnd,
                    _durationFrames: transEnd - transStart,
                });
            }
            console.log(`[SceneGraph] Parsed ${this._transitions.length} transitions`);
        }

        // Compute total frames
        let maxEnd = 0;
        for (const s of this._scenes) {
            if (s._endFrame > maxEnd) maxEnd = s._endFrame;
        }
        for (const m of this._mgs) {
            if (m._endFrame > maxEnd) maxEnd = m._endFrame;
        }
        // Also consider audio duration from plan
        if (normalizedPlan.totalDuration) {
            const audiEnd = Math.ceil(normalizedPlan.totalDuration * fps);
            if (audiEnd > maxEnd) maxEnd = audiEnd;
        }
        this._totalFrames = maxEnd;
    }

    /**
     * Parse a single scene object into frame-based internal format.
     */
    _parseScene(scene, fps) {
        const timing = _timelineContract?.normalizeTiming
            ? _timelineContract.normalizeTiming(scene, { fps })
            : {
                startTime: Number(scene.startTime) || 0,
                endTime: Number(scene.endTime) || ((Number(scene.startTime) || 0) + (Number(scene.duration) || 0)),
            };
        const start = timing.startTime;
        const end = timing.endTime;
        const trackId = scene.trackId || 'video-track-1';
        const trackNum = parseInt(trackId.match(/\d+/)?.[0] || '1', 10);

        const startFrame = Math.round(start * fps);
        const endFrame = Math.round(end * fps);
        return {
            ...scene,
            ...timing,
            _startFrame: startFrame,
            _endFrame: endFrame,
            _totalFrames: endFrame - startFrame,
            _trackNum: trackNum,
            _animationSpeed: scene.animationSpeed || 1.0,
        };
    }

    _resolveTransitionScene(scenes, clipId, legacyIndex) {
        if (clipId != null && String(clipId)) {
            return scenes.find((scene) => scene.clipId === clipId) || null;
        }
        const matches = scenes.filter((scene) => scene.index === legacyIndex);
        return matches.length === 1 ? matches[0] : null;
    }

    /**
     * Get all scenes active at the given frame, sorted by track number (low to high).
     * Returns [{ scene, trackNum, localFrame }]
     */
    getActiveScenesAtFrame(frame) {
        const result = [];
        for (const scene of this._scenes) {
            if (frame >= scene._startFrame && frame < scene._endFrame) {
                result.push({
                    scene,
                    trackNum: scene._trackNum,
                    localFrame: frame - scene._startFrame,
                });
            }
        }
        // Sort by track (lowest first = rendered first = underneath)
        result.sort((a, b) => a.trackNum - b.trackNum);
        return result;
    }

    /**
     * Get all overlay MGs active at the given frame.
     * Returns [{ mg, localFrame, totalFrames }]
     */
    getActiveMGsAtFrame(frame) {
        const result = [];
        for (const mg of this._mgs) {
            if (frame >= mg._startFrame && frame < mg._endFrame) {
                result.push({
                    mg,
                    localFrame: frame - mg._startFrame,
                    totalFrames: mg._totalFrames,
                });
            }
        }
        return result;
    }

    /**
     * Get the active transition at the given frame, if any.
     * Returns { sceneA, sceneB, progress, type } or null.
     * sceneA = outgoing, sceneB = incoming.
     */
    getTransitionAtFrame(frame) {
        for (const t of this._transitions) {
            if (frame >= t._startFrame && frame < t._endFrame) {
                const linear = (frame - t._startFrame) / t._durationFrames;
                const clamped = Math.max(0, Math.min(1, linear));
                // Smooth ease-in-out (cubic bezier approximation)
                // Accelerates gently, decelerates gently — no abrupt start/end
                const progress = clamped * clamped * (3 - 2 * clamped); // smoothstep
                const sceneA = this._resolveTransitionScene(this._scenes, t.fromClipId, t.fromIndex);
                const sceneB = this._resolveTransitionScene(this._scenes, t.toClipId, t.toIndex);
                if (sceneA && sceneB) {
                    return {
                        sceneA,
                        sceneB,
                        progress,
                        type: t.type,
                    };
                }
            }
        }
        return null;
    }

    get totalFrames() { return this._totalFrames; }
    get scenes() { return this._scenes; }
    get motionGraphics() { return this._mgs; }
}

if (typeof window !== 'undefined') window.SceneGraph = SceneGraph;
if (typeof module !== 'undefined' && module.exports) module.exports = SceneGraph;
