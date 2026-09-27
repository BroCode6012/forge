/**
 * Clip Analyzer — Video Understanding via Multi-Frame Vision
 *
 * Uses callVideoAI() to analyze entire video clips, not just single frame
 * thumbnails. Bedrock Qwen VL is the default primary model; direct Qwen Omni
 * remains an optional fallback.
 *
 * Two modes:
 *  1. analyzeClip()        — Post-download: score + describe a downloaded clip
 *  2. findBestSegment()    — Pre-download: find the best segment in a long video
 *
 * Both use callVideoAI() which sends multiple frames to the active vision route.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { callVideoAI, isVisionAIAvailable, getVisionProviderChain } = require('../brain/ai-provider');
const config = require('../settings/config');
const { renderPersonSubjectRule } = require('./person-subject');
const { footageAcceptFloor } = require('./niche-strictness');
// nvidia-client require REMOVED in 2026-05-25 cleanup.
// pickLightweightTrimStart below is now a no-op (returns null) so callers
// gracefully skip the trim-probe step.

// ============ CONFIG ============

const DEFAULTS = {
    // Frame extraction
    framesPerClip: 3,          // frames to extract from a clip (3 is enough for a 3-6s clip)
    frameScale: 384,           // scale frames to this width (lower = fewer tokens; was 512, ~30% token drop)
    frameQuality: 4,           // JPEG quality (2=best, 5=decent, higher=worse)
    frameTimeout: 10000,       // ms per frame extraction

    // Analysis
    maxTokens: 250,            // max response tokens (was 400; 6-line response fits in 250)
    timeout: 90000,            // ms for the AI call

    // Smart segment
    segmentFrames: 3,          // frames for segment analysis (3 is fast; 6 was too slow for 150+ scene builds)
    segmentMaxFrames: 16,      // hard cap for length-aware segment scans
    segmentWindowFrames: 3,    // frames to validate inside the exact clip window before download (8 → 4 → 3: scene cap was starving candidates)
    segmentMinDuration: 60,    // minimum video duration to bother with segment analysis (skip short clips)

    // Cost control
    enabled: true,             // master switch
    maxFramesPerBuild: 200,    // max total frames sent across all clips in one build
    reserveFrames: 36,         // protected frames for late/template backup segment hunts
};

// Track frame budgets across a build session
// DeepVision budget = for findBestSegment (smart trim) — the expensive multi-frame calls.
// Keep the existing "omni" variable/API names for compatibility with callers.
let _omniBudget = DEFAULTS.maxFramesPerBuild;
let _omniFramesSent = 0;
let _omniFramesReserved = 0;
let _clipAnalysisFrames = 0; // tracked for stats only, no budget limit

/**
 * Reset frame budget (call at start of each build).
 */
function resetBudget(maxFrames) {
    _omniBudget = maxFrames || DEFAULTS.maxFramesPerBuild;
    _omniFramesSent = 0;
    _omniFramesReserved = 0;
    _clipAnalysisFrames = 0;
}

/**
 * Check if a multi-frame vision provider is configured.
 */
function isClipAnalysisAvailable() {
    if (config.clipAnalyzer?.enabled === false) return false;
    if (!DEFAULTS.enabled) return false;
    return isVisionAIAvailable();
}

function _visionRouteLabel() {
    try {
        const chain = getVisionProviderChain();
        return chain.length ? chain.join(' -> ') : 'vision route unavailable';
    } catch (_) {
        return 'vision route unavailable';
    }
}

function _reserveFrames() {
    const configured = Number(config.clipAnalyzer?.reserveFrames);
    const reserve = Number.isFinite(configured) ? configured : DEFAULTS.reserveFrames;
    return Math.max(0, Math.min(Math.max(0, _omniBudget - 3), reserve));
}

function _usableOmniFrames(opts = {}) {
    const reserve = opts.allowReserve ? 0 : _reserveFrames();
    return Math.max(0, _omniBudget - reserve - _omniFramesSent - _omniFramesReserved);
}

function _claimOmniFrames(framesNeeded = 1, opts = {}) {
    const needed = Math.max(1, Math.ceil(Number(framesNeeded) || 1));
    const granted = Math.min(needed, _usableOmniFrames(opts));
    if (granted > 0) _omniFramesReserved += granted;
    return granted;
}

function _commitOmniFrames(reservedFrames = 0, sentFrames = 0) {
    const reserved = Math.max(0, Math.ceil(Number(reservedFrames) || 0));
    const sent = Math.max(0, Math.ceil(Number(sentFrames) || 0));
    if (reserved > 0) {
        _omniFramesReserved = Math.max(0, _omniFramesReserved - reserved);
    }
    if (sent > 0) {
        _omniFramesSent += sent;
    }
}

function hasOmniBudget(framesNeeded = 1, opts = {}) {
    if (!isClipAnalysisAvailable()) return false;
    const needed = Math.max(1, Math.ceil(Number(framesNeeded) || 1));
    return _usableOmniFrames(opts) >= needed;
}

/**
 * Check if segment-hunt Omni analysis is available and within the active budget.
 */
function isAvailable(opts = {}) {
    return hasOmniBudget(opts.framesNeeded || 1, opts);
}

function getFramesBudgetInfo(opts = {}) {
    const usable = _usableOmniFrames(opts);
    const reserve = opts.allowReserve ? 0 : _reserveFrames();
    return `${_omniFramesSent}/${_omniBudget} used, ${usable} usable${reserve ? `, ${reserve} protected` : ''}${_omniFramesReserved ? `, ${_omniFramesReserved} in-flight` : ''}`;
}

function getOmniFramesSent() {
    return _omniFramesSent;
}

function getOmniFramesReserved() {
    return _omniFramesReserved;
}

function getOmniBudget() {
    return _omniBudget;
}

function _toFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function _clampInt(value, min, max) {
    const n = Math.ceil(_toFiniteNumber(value, min));
    return Math.max(min, Math.min(max, n));
}

const _PREMIUM_STOCK_RE = /\b(storyblocks)\b/i;
/**
 * The full request, before it was shortened to fit a provider's search box.
 *
 * A provider query has to be short, so "thermometer inside dark earthen root
 * cellar" ships as "thermometer inside dark root cellar". Grading the clip
 * against the shortened form is how a perfect root-cellar shot gets binned for
 * "not matching". Emitted only when it actually differs from the keyword.
 */
function _requestedVisualLine(context = {}, keyword = '') {
    const wanted = String(context?.visualIntent || '').trim();
    if (!wanted) return '';
    if (wanted.toLowerCase() === String(keyword || '').trim().toLowerCase()) return '';
    return `WHAT WAS ACTUALLY REQUESTED (full request; the search keyword is a shortened form of this): "${wanted}"`;
}

function _isPremiumStockProvider(name) {
    return typeof name === 'string' && _PREMIUM_STOCK_RE.test(name);
}

/**
 * Did this scene's own brief ask for a drawn explanation? Resolved once per
 * scene by media-hunter (see media/packaging-intent.js) and carried on the
 * profile, so nothing is re-derived or re-guessed here.
 *
 * `strictRaw` stays ON either way — the scene still wants no anchors, no lower
 * thirds, no thumbnails. The only thing that changes is that we stop telling the
 * judge to bin the exact artefact we sent it looking for.
 */
function _wantsGraphic(mediaHunter) {
    return !!mediaHunter?.requestedPackaging?.graphic;
}

/**
 * The instruction that REPLACES the blanket graphic rejection on a scene whose
 * request is itself a graphic. Same slot in the prompt, opposite polarity: the
 * broadcast packaging we never want is still named, the drawn explanation we
 * asked for is not.
 */
const REQUESTED_GRAPHIC_RULE = '- This scene REQUESTED a drawn explanation (diagram / cross-section / schematic / chart). Score a clear, on-topic diagram or cutaway as good B-roll — its labels, dimensions and callouts are part of what was asked for, not defects. Still score 2 or lower for anchors, presenters, commentators, picture-in-picture faces, channel logos, news tickers, thumbnails, or a graphic about a DIFFERENT subject.';

/**
 * Same slot, same polarity flip, for a scene about the video's main character:
 * the exact-moment requirement stops being a defect, the broadcast packaging we
 * never want is still named. Resolved once per scene by media-hunter (see
 * media/person-subject.js) and carried on the profile.
 */
function _personSubjectRule(mediaHunter) {
    return renderPersonSubjectRule(mediaHunter?.personSubject);
}

function _isPromisingSegmentCandidate(context = {}) {
    const hunter = context.mediaHunter || {};
    if (hunter.strictRaw && !hunter.allowGraphics) return true;
    if (context.promisingCandidate === true || context.fromPreviewScout === true || context.fromTopicScout === true) return true;

    const score = _toFiniteNumber(
        context.candidateScore ?? context.scoutScore ?? context.topicScoutScore ?? context.titleScore,
        0
    );
    return score > 0;
}

function _durationAwareSegmentFrames(totalDuration, context = {}) {
    const duration = _toFiniteNumber(totalDuration, 0);
    const promising = _isPromisingSegmentCandidate(context);

    if (duration < 180) return 5;
    if (duration < 600) return promising ? 8 : 6;
    if (duration < 1800) return promising ? 12 : 8;
    if (duration < 3600) return promising ? 14 : 8;
    return promising ? 16 : 8;
}

function getSegmentFrameNeed(totalDuration, context = {}) {
    const maxFrames = _clampInt(context.maxSegmentFrames ?? config.clipAnalyzer?.segmentMaxFrames ?? DEFAULTS.segmentMaxFrames, 3, 24);
    const fixedFrames = context.segmentFrames
        ?? context.omniFrames
        ?? context.mediaHunter?.segment?.omniFrames
        ?? config.clipAnalyzer?.segmentFrames
        ?? DEFAULTS.segmentFrames;

    if (context.dynamicSegmentFrames === false || config.clipAnalyzer?.dynamicSegmentFrames === false) {
        return _clampInt(fixedFrames, 3, maxFrames);
    }

    return _clampInt(_durationAwareSegmentFrames(totalDuration, context), 3, maxFrames);
}

function _segmentFramePolicyLabel(totalDuration, context = {}) {
    const duration = _toFiniteNumber(totalDuration, 0);
    const promising = _isPromisingSegmentCandidate(context);
    const bucket = duration >= 3600
        ? 'very long'
        : duration >= 1800
            ? 'long'
            : duration >= 600
                ? 'medium-long'
                : duration >= 180
                    ? 'medium'
                    : 'short';
    return `${bucket}${promising ? ', promising' : ', light'}`;
}

// ============ FRAME EXTRACTION ============

let _ffmpegPath = null;

function _getFfmpeg() {
    if (_ffmpegPath !== null) return _ffmpegPath;
    try {
        const p = require('ffmpeg-static');
        if (fs.existsSync(p)) { _ffmpegPath = p; return p; }
    } catch {}
    _ffmpegPath = false;
    return false;
}

/**
 * Extract multiple frames from a video file at evenly-spaced timestamps.
 * @param {string} videoPath - Path to video file
 * @param {number} duration - Video duration in seconds
 * @param {number} numFrames - Number of frames to extract
 * @param {Object} [opts] - { startTime, endTime, scale }
 * @returns {Promise<Array<{base64: string, mimeType: string, timestamp: number}>>}
 */
async function extractFrames(videoPath, duration, numFrames, opts = {}) {
    const ffmpeg = _getFfmpeg();
    if (!ffmpeg) return [];

    const startTime = opts.startTime || 0;
    const endTime = opts.endTime || duration;
    const effectiveDur = endTime - startTime;
    const scale = opts.scale || DEFAULTS.frameScale;

    // Calculate timestamps spread evenly across the clip
    let timestamps = Array.isArray(opts.timestamps)
        ? opts.timestamps
            .map(t => _toFiniteNumber(t, NaN))
            .filter(t => Number.isFinite(t) && t >= startTime && t <= endTime)
        : [];
    if (timestamps.length === 0) {
        for (let i = 0; i < numFrames; i++) {
            const t = startTime + (effectiveDur * (i + 0.5)) / numFrames;
            timestamps.push(Math.min(t, endTime - 0.1));
        }
    }

    const tempDir = config.paths?.temp || require('os').tmpdir();
    const frames = [];

    // Extract in parallel batches of 4
    const batchSize = 4;
    for (let b = 0; b < timestamps.length; b += batchSize) {
        const batch = timestamps.slice(b, b + batchSize);
        const results = await Promise.all(batch.map(async (ts, bi) => {
            const framePath = path.join(tempDir, `clip-analyzer-${Date.now()}-${b + bi}.jpg`);
            try {
                await new Promise((resolve, reject) => {
                    execFile(ffmpeg, [
                        '-ss', ts.toFixed(2),
                        '-i', videoPath,
                        '-vf', `scale=${scale}:-1`,
                        '-frames:v', '1',
                        '-q:v', String(DEFAULTS.frameQuality),
                        '-y', framePath,
                    ], { timeout: DEFAULTS.frameTimeout, windowsHide: true }, (err) => {
                        if (err) reject(err); else resolve();
                    });
                });

                if (fs.existsSync(framePath)) {
                    const buffer = fs.readFileSync(framePath);
                    const base64 = buffer.toString('base64');
                    fs.unlinkSync(framePath); // cleanup
                    return { base64, mimeType: 'image/jpeg', timestamp: ts };
                }
            } catch {
                try { fs.unlinkSync(framePath); } catch {}
            }
            return null;
        }));

        frames.push(...results.filter(Boolean));
    }

    return frames;
}

/**
 * Extract frames from a remote URL (for pre-download segment analysis).
 */
async function extractFramesFromUrl(url, duration, numFrames, opts = {}) {
    const ffmpeg = _getFfmpeg();
    if (!ffmpeg) return [];

    const startTime = opts.startTime || 0;
    const endTime = opts.endTime || duration;
    const effectiveDur = endTime - startTime;
    const scale = opts.scale || DEFAULTS.frameScale;

    let timestamps = Array.isArray(opts.timestamps)
        ? opts.timestamps
            .map(t => _toFiniteNumber(t, NaN))
            .filter(t => Number.isFinite(t) && t >= startTime && t <= endTime)
        : [];
    if (timestamps.length === 0) {
        for (let i = 0; i < numFrames; i++) {
            const t = startTime + (effectiveDur * (i + 0.5)) / numFrames;
            timestamps.push(Math.min(t, endTime - 0.1));
        }
    }

    const tempDir = config.paths?.temp || require('os').tmpdir();
    const frames = [];

    // Extract sequentially for remote URLs (parallel can overwhelm)
    for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const framePath = path.join(tempDir, `clip-analyzer-url-${Date.now()}-${i}.jpg`);
        try {
            await new Promise((resolve, reject) => {
                execFile(ffmpeg, [
                    '-ss', ts.toFixed(2),
                    '-i', url,
                    '-vf', `scale=${scale}:-1`,
                    '-frames:v', '1',
                    '-q:v', String(DEFAULTS.frameQuality),
                    '-y', framePath,
                ], { timeout: 20000, windowsHide: true }, (err) => {
                    if (err) reject(err); else resolve();
                });
            });

            if (fs.existsSync(framePath)) {
                const buffer = fs.readFileSync(framePath);
                frames.push({ base64: buffer.toString('base64'), mimeType: 'image/jpeg', timestamp: ts });
                fs.unlinkSync(framePath);
            }
        } catch {
            try { fs.unlinkSync(framePath); } catch {}
        }
    }

    return frames;
}

function _parseTrimProbeResponse(raw, frameCount) {
    const text = String(raw || '').trim();
    const out = [];
    if (!text) return out;

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    const index = Math.max(1, Math.min(frameCount, Number(item.index || item.frame || item.id || 0)));
                    const scoreMatch = String(item.score ?? item.rating ?? item.value ?? 0).match(/\d+(?:\.\d+)?/);
                    const score = Math.max(0, Math.min(10, Number(scoreMatch ? scoreMatch[0] : 0)));
                    if (index && Number.isFinite(score)) {
                        out.push({
                            index,
                            score,
                            reason: String(item.reason || item.description || '').replace(/\s+/g, ' ').slice(0, 140),
                        });
                    }
                }
            }
        } catch (_) {}
    }

    if (out.length > 0) return out;

    for (const line of text.split('\n')) {
        const m = line.match(/(?:frame|offset|image)?\s*(\d+)[^0-9]+(\d+(?:\.\d+)?)(?:\s*\/\s*10)?(?:\s*[-:]\s*(.*))?/i);
        if (!m) continue;
        const index = Math.max(1, Math.min(frameCount, Number(m[1])));
        const score = Math.max(0, Math.min(10, Number(m[2])));
        if (index && Number.isFinite(score)) {
            out.push({
                index,
                score,
                reason: String(m[3] || '').replace(/\s+/g, ' ').slice(0, 140),
            });
        }
    }
    return out;
}

/**
 * pickLightweightTrimStart — DISABLED in 2026-05-25 cleanup.
 * Was an NVIDIA-vision-only pre-download trim scoring step. NVIDIA is no
 * longer in the vision chain, so this returns null and callers (footage-
 * manager.js Smart-Trim path) gracefully skip the trim probe step. The
 * function signature is preserved so callers don't need updates.
 */
async function pickLightweightTrimStart(_streamUrl, _totalDuration, _neededDuration, _keyword, _context = {}) {
    return null;
}

function _buildWindowValidationTimestamps(startTime, endTime, numFrames) {
    const start = _toFiniteNumber(startTime, 0);
    const end = _toFiniteNumber(endTime, start);
    const count = _clampInt(numFrames, 3, 8);
    const duration = Math.max(0.1, end - start);
    const minT = start + Math.min(0.25, duration * 0.04);
    const maxT = Math.max(minT, end - Math.min(0.18, duration * 0.04));
    const presets = {
        3: [0.06, 0.50, 0.94],
        4: [0.05, 0.34, 0.66, 0.95],
        5: [0.05, 0.25, 0.50, 0.75, 0.95],
        6: [0.04, 0.20, 0.38, 0.56, 0.74, 0.96],
        7: [0.04, 0.18, 0.32, 0.46, 0.60, 0.76, 0.96],
        8: [0.04, 0.16, 0.29, 0.42, 0.55, 0.68, 0.82, 0.96],
    };
    const fractions = presets[count] || presets[8];
    return fractions.map(f => Math.max(minT, Math.min(maxT, start + duration * f)));
}

// ============ CLIP ANALYSIS (POST-DOWNLOAD) ============

/**
 * Analyze a downloaded video clip using multi-frame vision understanding.
 * Returns a comprehensive analysis: score, description, issues, quality metrics.
 *
 * @param {string} filePath - Path to downloaded video
 * @param {number} duration - Clip duration in seconds
 * @param {string} keyword - What the clip should show
 * @param {Object} [context] - { sceneText, niche, videoTopic, entities, entityContext }
 * @returns {Promise<{score: number, description: string, issues: string[], quality: Object}|null>}
 */
async function analyzeClip(filePath, duration, keyword, context = {}) {
    if (!isClipAnalysisAvailable()) return null;
    if (!fs.existsSync(filePath)) return null;

    const maxFrames = config.clipAnalyzer?.framesPerClip || DEFAULTS.framesPerClip;
    const numFrames = Math.min(maxFrames, Math.ceil(duration * 2)); // ~2fps, capped
    const frames = await extractFrames(filePath, duration, numFrames);
    if (frames.length < 2) return null;

    _clipAnalysisFrames += frames.length; // clip analysis uses VL, separate from segment-search budget

    const contextBlock = [
        context.videoTopic ? `Video topic: "${context.videoTopic}"` : '',
        _requestedVisualLine(context, keyword),
        context.sceneText ? `Scene narration: "${context.sceneText}"` : '',
        context.niche ? `Niche: ${context.niche}` : '',
        context.sourceTitle ? `Source title/page: "${context.sourceTitle}"` : '',
        context.entities?.length ? `Key entities: ${context.entities.slice(0, 5).join(', ')}` : '',
        context.entityContext?.length ? `Entity context for relevance (not search terms): ${context.entityContext.slice(0, 8).join(', ')}` : '',
        context.mediaAgent?.viewerNeed ? `Media agent viewer need: ${context.mediaAgent.viewerNeed}` : '',
        context.mediaAgent?.minimumAcceptable || context.mediaAgent?.searchStrategy?.minimumAcceptable ? `Media agent minimum acceptable: ${context.mediaAgent.minimumAcceptable || context.mediaAgent.searchStrategy.minimumAcceptable}` : '',
        context.mediaAgent?.acceptanceTest ? `Media agent acceptance test: ${context.mediaAgent.acceptanceTest}` : '',
        context.mediaAgent?.mandatoryIdentity?.length ? `MANDATORY IDENTITY: ${context.mediaAgent.mandatoryIdentity.slice(0, 8).join(', ')} (${context.mediaAgent.identityEvidenceMode || 'frame-visible'})` : '',
        context.mediaAgent?.mandatoryVisible?.length ? `MANDATORY FRAME-VISIBLE ENTITY: ${context.mediaAgent.mandatoryVisible.slice(0, 8).join(', ')}` : '',
        context.mediaAgent?.mustShow?.length ? `Media agent must show: ${context.mediaAgent.mustShow.slice(0, 8).join(', ')}` : '',
        context.mediaAgent?.mustAvoid?.length ? `Media agent must avoid: ${context.mediaAgent.mustAvoid.slice(0, 8).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const mediaHunter = context.mediaHunter || null;
    const premiumStock = _isPremiumStockProvider(context.sourceProvider);
    const wantsGraphic = _wantsGraphic(mediaHunter);
    const hunterBlock = mediaHunter ? `
MEDIA HUNTER TARGET:
- Target visual: ${mediaHunter.targetDescription || 'literal usable B-roll'}
- Mode: ${mediaHunter.mode || 'literal'} | strict raw footage: ${mediaHunter.strictRaw ? 'YES' : 'NO'}
${mediaHunter.prefer?.length ? `- Prefer visible: ${mediaHunter.prefer.slice(0, 8).join(', ')}` : ''}
${mediaHunter.avoid?.length ? `- Avoid/reject: ${mediaHunter.avoid.slice(0, 10).join(', ')}` : ''}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && !wantsGraphic ? '- If the clip is mainly anchors, presenters, commentators, picture-in-picture faces, subtitles, lower thirds, maps/satellite screenshots, route graphics, charts, infographics, thumbnails, or animated explainers, score it 2 or lower. Clean footage of a named/relevant public figure, official, celebrity, athlete, worker, soldier, or event participant is allowed when they are the subject, not the presenter.' : ''}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && wantsGraphic ? REQUESTED_GRAPHIC_RULE : ''}
${_personSubjectRule(mediaHunter)}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && premiumStock ? `- EXCEPTION: this clip is from ${context.sourceProvider} (premium stock library). If it is a clean reference MAP/satellite/route diagram, 3D map, or map animation that VISIBLY shows the topic's actual place/region/route (e.g. the scene names "Bab el-Mandeb shipping lane" and the map labels Bab el-Mandeb, Red Sea, Suez), score it 6-8 as accurate B-roll. Cartoons, illustrations, non-map animated explainers, and generic world maps that do not visibly depict the topic are NOT exempt.` : ''}
${mediaHunter.allowScreen ? '- Screen/device/interface footage is allowed if it directly fits the scene.' : ''}` : '';

    const prompt = `You are analyzing a ${duration.toFixed(1)}s video clip for use in a faceless YouTube video.
These ${frames.length} frames are sequential snapshots from the clip (every ~${(duration / frames.length).toFixed(1)}s).

SEARCH KEYWORD: "${keyword}"
${contextBlock ? `\nCONTEXT:\n${contextBlock}` : ''}
${hunterBlock ? `\n${hunterBlock}` : ''}

Analyze the ENTIRE clip sequence and report:

1. CONTENT: What does this clip actually show? Describe the visual content across all frames (1-2 sentences).

2. RELEVANCE: How well does this clip match the keyword and context? Consider it as B-roll over narration.

AGENTIC SCORING: If CONTEXT includes Media agent minimum acceptable or acceptance test, use that as the scene contract. A clip can score 7+ when it truthfully communicates the viewer need through visible evidence/context, even if it is a proxy rather than the perfect literal shot. Evidence means something visible in the clip/source: labels, signs, markings, screens, documents, packaging, facilities, tools, object details, same-category action, or the requested setting/process. Do not reward random symbolism with no visible evidence.

MANDATORY ENTITY RULE: If CONTEXT includes MANDATORY FRAME-VISIBLE ENTITY, the named brand/product/person/org must be visible or clearly identifiable for a high score. Do not demand perfect framing, but if the mandatory frame-visible entity is absent, SCORE must be 4 or lower.
If CONTEXT includes MANDATORY IDENTITY with source-proven mode, the source title/page can prove the identity. In that case, judge whether the clip visually shows the requested real-world subject/process/setting; do not cap solely because the brand/name is not readable in every sampled frame.

AGENT EVIDENCE CONTRACT FOR BACKGROUND/TEMPLATE FOOTAGE:
- If MEDIA HUNTER mode or Media Agent role is template-background/background/generic-broll, do not score by mood alone.
- The target, viewer need, minimum acceptable, acceptance test, and "must show" lines define the concrete evidence contract.
- Score 8+ only when the clip visibly contains the main setting/evidence path plus at least one concrete object/action/detail requested by that contract.
- If the clip is merely same-family atmosphere, score it 5-6. Example: broad factory/foundry footage is weaker than workshop/tools/workbench/product/retail context when those are the requested anchors.
- If a more literal clip would be easy to find from the query, do not call the broad substitute "perfect."

3. ISSUES: Check for ANY of these problems:
   - Watermarks, logos, or channel branding visible. Say "small corner watermark/logo" if it is tiny/non-blocking; flag large/centered/prominent marks clearly.
   - Text overlays, lower thirds, or news tickers
   - News anchor / presenter / studio talking head (do not flag clean footage of the named/relevant subject)
   - Shaky or blurry footage
   - Very dark or overexposed
   - Continuity / cuts:
     * OK: camera angle or zoom changes that keep the SAME real subject/location/event continuous.
     * ISSUE: stitched source changes where the clip switches to a different source, presenter, map, graphic, AI/collage, or unrelated scene.
   - AI-generated or illustrated content
   - Still photo with zoom (Ken Burns effect)

4. MOTION: Is there good motion/movement, or mostly static?

5. TRIM SUGGESTION: If the clip has a better segment, which frames (by number) are best?

Reply in this EXACT format (6 lines):
CONTENT: <1-2 sentence description>
RELEVANCE: <1 sentence about match quality>
ISSUES: <comma-separated list, or "none"; if there are cuts, say either "same-subject camera angle changes" or "hard scene/source change: <what changes>">
MOTION: <good/moderate/static>
TRIM: <"all good" or "frames N-M are best">
SCORE: <1-10 number>`;

    try {
        const response = await callVideoAI(prompt, frames, { maxTokens: DEFAULTS.maxTokens });
        return _parseClipAnalysis(response);
    } catch (err) {
        console.log(`  ⚠️ [clip-analyzer] Analysis failed: ${err.message}`);
        return null;
    }
}

/**
 * Read a score out of a single line that is *meant to be* the score line.
 *
 * Twin of `_scoreFromScoreLine` in vision/ai-vision.js — same bug shape, same
 * fix shape. Tolerates the decoration models actually emit around the number
 * ("**SCORE: 7**", "- Score: 7/10", "7."), while refusing any line that carries
 * extra words or extra digits, so "4K", "3 workers", "2019" and "100" can never
 * be misread as a score.
 *
 * Returns an integer 0-10, or null when the line is not a score line.
 */
function _scoreFromClipLine(line) {
    const cleaned = String(line || '')
        .replace(/[*_`~#>[\]]/g, '')
        .replace(/^[\s\-•–—]+/, '')
        .trim();
    if (!cleaned) return null;
    const m = cleaned.match(/^(?:(?:final|overall)\s+)?(?:score|rating)?\s*[:=-]?\s*(10|\d)\s*(?:\/\s*10)?\s*[.!]?$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse the structured analysis response.
 */
function _parseClipAnalysis(response) {
    if (!response) return null;

    const lines = response.trim().split('\n');
    const result = {
        // null = "not read yet" — NEVER 0. Every parse path below clamps with
        // Math.max(1, …), so a score that WAS read can never come out as 0; using
        // 0 as the sentinel made "I could not read the answer" indistinguishable
        // from a real verdict, and a good clip got binned for the model's
        // formatting. Coerced back to 0 (+ parseError) on the way out, so every
        // caller's contract is unchanged.
        score: null,
        description: '',
        relevance: '',
        issues: [],
        motion: 'unknown',
        trimSuggestion: null,
        raw: response,
    };

    for (const line of lines) {
        const lower = line.toLowerCase().trim();
        if (lower.startsWith('content:')) {
            result.description = line.substring(line.indexOf(':') + 1).trim();
        } else if (lower.startsWith('relevance:')) {
            result.relevance = line.substring(line.indexOf(':') + 1).trim();
        } else if (lower.startsWith('issues:')) {
            const issueStr = line.substring(line.indexOf(':') + 1).trim();
            if (issueStr.toLowerCase() !== 'none') {
                result.issues = issueStr.split(',').map(s => s.trim()).filter(Boolean);
            }
        } else if (lower.startsWith('motion:')) {
            result.motion = line.substring(line.indexOf(':') + 1).trim().toLowerCase();
        } else if (lower.startsWith('trim:')) {
            const trimStr = line.substring(line.indexOf(':') + 1).trim();
            if (!trimStr.toLowerCase().includes('all good')) {
                result.trimSuggestion = trimStr;
            }
        } else if (lower.startsWith('score:')) {
            // Strict original form FIRST, so every response that parsed before
            // still parses to exactly the same value.
            const numMatch = line.match(/(\d+)/);
            if (numMatch) result.score = Math.min(10, Math.max(1, parseInt(numMatch[1])));
        } else if (result.score === null) {
            // The same line wearing decoration the strict prefix above cannot
            // see ("**SCORE: 7**", "- Score: 7/10"), or a bare "7" on its own
            // line. A later real SCORE: line still overrides this.
            const tolerant = _scoreFromClipLine(line);
            if (tolerant !== null) result.score = Math.min(10, Math.max(1, tolerant));
        }
    }

    // Fallback: an explicitly score-shaped number. The old fallback here took the
    // FIRST number anywhere in the reply, so "4K aerial drone shot" scored 4 and
    // "3 workers laying pipe" scored 3 — a clip binned on a number that was never
    // a score. Anchored forms only: a score/rating label, a lone number on its
    // own line, or an explicit N/10.
    if (result.score === null) {
        const scoreLike = response.match(/(?:score|rating)\D{0,16}(10|[0-9])\s*(?:\/\s*10)?/i)
            || response.match(/(?:^|\n)\s*(10|[0-9])\s*(?:\/\s*10)?\s*$/m)
            || response.match(/\b(10|[0-9])\s*\/\s*10\b/);
        if (scoreLike) result.score = Math.min(10, Math.max(1, parseInt(scoreLike[1])));
    }

    // Last resort: the model merged the score onto the end of its last line
    // ("… soil layers. 7" / "… soil layers — 7/10"). A punctuation separator is
    // REQUIRED so this can never lift a number out of prose ("Route 66.").
    if (result.score === null && lines.length) {
        const tail = String(lines[lines.length - 1] || '').replace(/[*_`]/g, '').trim();
        const merged = tail.match(/[.!?:;—–-]\s*(10|\d)\s*(?:\/\s*10)?\s*[.!]?$/);
        if (merged) result.score = Math.min(10, Math.max(1, parseInt(merged[1])));
    }

    if (result.score === null) {
        // Truly unreadable. Externally the contract is unchanged (score 0), but
        // parseError now says WHY — footage-manager already forwards it into
        // applyVisionScoreSanity, which can rescue the clip from its description
        // instead of binning it. A parse failure is NOT an API failure.
        result.score = 0;
        result.parseError = true;
    }

    return result;
}

// ============ NICHE-AWARE SEGMENT RULES ============

/**
 * Returns niche-specific disqualifier + preference rules for the segment prompt.
 * News niches are strict about broadcasts; creative niches are more relaxed.
 */
function _getNicheSegmentRules(niche) {
    const n = (niche || '').toLowerCase();

    // ── News niches: strict anti-broadcast rules ──
    if (n.startsWith('news') || n === 'general') {
        return `NICHE RULES (${n} — strict):
DISQUALIFIERS for this niche:
- News anchor / presenter at a studio desk (talking head in studio setting)
- News broadcast graphics: breaking news banners, tickers, lower thirds, bullet-point lists
- Text-heavy screens where text fills >30% of the frame (headlines, infographics, list graphics)
- Still photo with zoom effect (Ken Burns) — not real footage
- Generic press conference/podium shots with no named/relevant subject signal

GOOD FOOTAGE for this niche:
- Real-world event footage: protests, military, ships, aircraft, vehicles in motion
- Aerial/drone shots of relevant locations, cities, conflict zones
- Industrial footage: oil facilities, pipelines, factories, ports, infrastructure
- Raw footage from the ground: streets, crowds, real situations
- Clean footage of relevant public figures, officials, soldiers, workers, protesters, or event participants
- Maps and satellite imagery (real, not broadcast graphics)`;
    }

    // ── Crime niche ──
    if (n === 'crime') {
        return `NICHE RULES (crime — strict):
DISQUALIFIERS for this niche:
- News anchor / presenter at a studio desk
- News broadcast graphics: banners, tickers, lower thirds
- Text-heavy screens (>30% text)
- Bright, cheerful footage unrelated to the topic

GOOD FOOTAGE for this niche:
- Surveillance/CCTV footage, dashcam footage
- Police activity, crime scenes, courtrooms, prison exteriors
- Dark/moody urban footage: alleys, streets at night, city skylines
- Evidence photos, forensic scenes, investigation footage
- Aerial footage of locations mentioned in narration`;
    }

    // ── History niche ──
    if (n === 'history') {
        return `NICHE RULES (history — moderate):
DISQUALIFIERS for this niche:
- Modern news broadcasts or studio settings
- Visible modern watermarks or channel logos
- AI-generated or illustrated content

GOOD FOOTAGE for this niche:
- Archival/historical footage (even if grainy or black-and-white — that's GOOD)
- Documentary footage of historical locations, monuments, battlefields
- Maps, old photographs, museum artifacts (text overlays OK if period-appropriate)
- Re-enactment footage of historical events
- Aerial shots of historical sites`;
    }

    // ── Nature niche ──
    if (n === 'nature') {
        return `NICHE RULES (nature — relaxed):
DISQUALIFIERS for this niche:
- Studio/indoor footage unrelated to nature
- News broadcasts or talking heads
- Urban/industrial footage (unless topic is environmental)

GOOD FOOTAGE for this niche:
- Wildlife in natural habitats, animal behavior
- Landscapes: mountains, oceans, forests, deserts, rivers
- Aerial/drone shots of natural environments
- Macro nature details: insects, leaves, water, flowers
- Golden hour, blue hour, slow-motion nature footage
- Underwater footage, storm footage, natural phenomena`;
    }

    // ── Explainer / Education / Science niche ──
    if (n === 'education' || n === 'explainer') {
        return `NICHE RULES (explainer — clean B-roll, NO presenters):
DISQUALIFIERS for this niche (REJECT these):
- YouTuber/presenter talking to camera (this is for FACELESS video — no faces)
- Person standing in front of subject explaining (talking head)
- News anchor / studio talking head
- Visible watermarks or channel logos
- Comedy/meme/entertainment clips
- Exception: clean footage of a named/relevant subject person is allowed when they are the topic, not the narrator/presenter

GOOD FOOTAGE for this niche:
- Clean B-roll: close-ups of materials, cross-sections, aerial views of structures
- Diagrams, infographics, educational charts (text is OK if educational)
- Process footage: construction, assembly, manufacturing (hands OK, faces NOT OK)
- Laboratory footage, experiments, scientific equipment
- Documentary-style footage without visible presenter
- Architectural/engineering footage, interiors, exteriors
- Macro close-ups of textures, mechanisms, materials`;
    }

    // ── Business / Economy niche ──
    if (n === 'business') {
        return `NICHE RULES (business — moderate):
DISQUALIFIERS for this niche:
- News anchor at studio desk reading teleprompter
- News broadcast banners and tickers
- Still photos with heavy zoom effect

GOOD FOOTAGE for this niche:
- Corporate offices, board rooms, business meetings
- Stock exchange floors, trading screens, financial districts
- Factory floors, warehouses, logistics, shipping
- City skylines, business districts, modern architecture
- Product shots, technology demonstrations, press events`;
    }

    // ── Motivation niche ──
    if (n === 'motivation') {
        return `NICHE RULES (motivation — relaxed):
DISQUALIFIERS for this niche:
- News broadcasts or studio settings
- Visible watermarks or channel logos
- Dark/violent/disturbing content

GOOD FOOTAGE for this niche:
- People exercising, training, achieving goals
- Sunrise/sunset, mountain peaks, open roads, epic landscapes
- Crowd celebrations, sports victories, graduation ceremonies
- Cinematic slow-motion of determination, effort, success
- Urban energy: busy streets, city lights, people walking with purpose`;
    }

    // ── Sport niche ──
    if (n === 'sport') {
        return `NICHE RULES (sport — relaxed):
DISQUALIFIERS for this niche:
- News anchor at studio desk
- Completely unrelated non-sports content

GOOD FOOTAGE for this niche:
- Game/match footage, highlights, replays
- Athletes training, warming up, competing
- Stadium/arena shots, crowds cheering
- Sports equipment, fields, courts in action
- Victory celebrations, medal ceremonies
- Minor broadcast overlays (score tickers) are ACCEPTABLE in sports`;
    }

    // ── Food / Health niche ──
    if (n === 'food') {
        return `NICHE RULES (food — relaxed):
DISQUALIFIERS for this niche:
- News broadcasts or political content
- Visible watermarks or channel logos

GOOD FOOTAGE for this niche:
- Cooking processes, food preparation, kitchen footage
- Beautiful plated dishes, restaurant interiors
- Markets, grocery stores, farms, food production
- Close-up food shots, ingredients, spices
- People eating, dining experiences, food culture`;
    }

    // ── DIY niche ──
    if (n === 'diy') {
        return `NICHE RULES (diy — relaxed):
DISQUALIFIERS for this niche:
- News broadcasts or talking heads
- Visible watermarks or channel logos

GOOD FOOTAGE for this niche:
- Hands working on projects, tools in use, crafting
- Workshop/garage footage, materials being assembled
- Before/after transformation shots
- Close-up detail work, measuring, cutting, building
- Finished project reveals`;
    }

    // ── Luxury niche ──
    if (n === 'luxury') {
        return `NICHE RULES (luxury — moderate):
DISQUALIFIERS for this niche:
- News broadcasts or studio settings
- Low-quality or grainy footage
- Visible watermarks or channel logos

GOOD FOOTAGE for this niche:
- High-end cars, yachts, private jets, mansions
- Luxury fashion, watches, jewelry close-ups
- Five-star hotels, resorts, exclusive venues
- Cinematic city shots: Dubai, Monaco, Beverly Hills
- Elegant interiors, fine dining, champagne`;
    }

    // ── Default (unknown niche) — moderate rules ──
    return `NICHE RULES (general — moderate):
DISQUALIFIERS for this niche:
- News anchor / presenter at a studio desk
- News broadcast graphics: breaking news banners, tickers, lower thirds
- Text-heavy screens where text fills >30% of the frame
- Still photo with zoom effect (Ken Burns) — not real footage

GOOD FOOTAGE for this niche:
- Real-world footage relevant to the keyword
- Outdoor/location footage: cities, landscapes, buildings, facilities
- Aerial/drone shots, event footage, people in real settings
- Clean footage without heavy overlays or studio elements`;
}

// ============ SMART SEGMENT (PRE-DOWNLOAD) ============

/**
 * Find the best segment in a long video using multi-frame vision understanding.
 * Extracts frames across the entire video, sends them all to the model,
 * and asks it to identify the best segment.
 *
 * @param {string} streamUrl - Direct video stream URL
 * @param {number} totalDuration - Total video duration
 * @param {number} neededDuration - How many seconds we need
 * @param {string} keyword - What we're looking for
 * @param {Object} [context] - { sceneText, niche, videoTopic }
 * @returns {Promise<{startTime: number, confidence: number, reason: string}|null>}
 */
async function findBestSegment(streamUrl, totalDuration, neededDuration, keyword, context = {}) {
    if (!isClipAnalysisAvailable()) {
        console.log(`  🔍 [clip-analyzer] findBestSegment: not available (no vision provider)`);
        return null;
    }
    const durationFloor = context.allowShortSource
        ? Math.max(12, Math.ceil(Number(neededDuration) || 0) + 4)
        : DEFAULTS.segmentMinDuration;
    if (totalDuration < durationFloor) {
        console.log(`  🔍 [clip-analyzer] findBestSegment: video too short (${Math.round(totalDuration)}s < ${durationFloor}s min${context.allowShortSource ? ' short-source' : ''})`);
        return null;
    }

    console.log(`  🔍 [clip-analyzer] findBestSegment: ${Math.round(totalDuration)}s video, need ${Math.round(neededDuration)}s, keyword="${keyword}"`);
    console.log(`  🔍 [clip-analyzer] DeepVision budget: ${_omniFramesSent}/${_omniBudget} frames used`);

    const mediaHunter = context.mediaHunter || null;
    const allowReserve = context.allowOmniReserve === true;
    const requestedSegmentFrames = getSegmentFrameNeed(totalDuration, context);
    const usableFrames = _usableOmniFrames({ allowReserve });
    if (usableFrames < 3) {
        const reserveNote = allowReserve ? '' : ` (${_reserveFrames()} reserved for late scenes)`;
        console.log(`  [clip-analyzer] Segment hunt skipped: only ${usableFrames} usable DeepVision frame(s) left${reserveNote}`);
        return null;
    }
    let segmentFrames = Math.min(requestedSegmentFrames, usableFrames);
    segmentFrames = _claimOmniFrames(segmentFrames, { allowReserve });
    if (segmentFrames < 3) {
        const reserveNote = allowReserve ? '' : ` (${_reserveFrames()} protected for late scenes)`;
        console.log(`  [clip-analyzer] Segment hunt skipped: no reservable DeepVision frames left${reserveNote}`);
        if (segmentFrames > 0) _commitOmniFrames(segmentFrames, 0);
        return null;
    }
    if (segmentFrames < requestedSegmentFrames) {
        console.log(`  [clip-analyzer] Segment hunt capped by DeepVision budget: ${segmentFrames}/${requestedSegmentFrames} frames${allowReserve ? ' (using reserve)' : ''}`);
    }

    // Skip first 8% and last 10% (intro/outro)
    const safeStart = Math.max(3, Math.floor(totalDuration * 0.08));
    const safeEnd = Math.max(safeStart + neededDuration, totalDuration - Math.max(3, Math.floor(totalDuration * 0.10)));
    console.log(`  [clip-analyzer] Length-aware segment scan: ${segmentFrames} frame(s) (${_segmentFramePolicyLabel(totalDuration, context)})`);

    console.log(`  🔍 [clip-analyzer] Extracting ${segmentFrames} frames from ${safeStart}s-${safeEnd}s (safe zone)...`);
    let frames = [];
    try {
        frames = await extractFramesFromUrl(streamUrl, totalDuration, segmentFrames, {
            startTime: safeStart,
            endTime: safeEnd,
        });
    } catch (err) {
        _commitOmniFrames(segmentFrames, 0);
        throw err;
    }

    if (frames.length < 3) {
        console.log(`  ⚠️ [clip-analyzer] Only extracted ${frames.length} frames (need 3+) — skipping segment analysis`);
        _commitOmniFrames(segmentFrames, 0);
        return null;
    }

    _commitOmniFrames(segmentFrames, frames.length);
    console.log(`  🔍 [clip-analyzer] Extracted ${frames.length} frames -> sending to DeepVision (${_visionRouteLabel()}) | budget now ${_omniFramesSent}/${_omniBudget}`);

    const timestamps = frames.map(f => f.timestamp);
    const frameList = frames.map((f, i) => `Frame ${i + 1} (at ${f.timestamp.toFixed(0)}s)`).join(', ');

    const contextBlock = [
        context.videoTopic ? `Video topic: "${context.videoTopic}"` : '',
        _requestedVisualLine(context, keyword),
        context.sceneText ? `Scene narration: "${context.sceneText}"` : '',
        context.niche ? `Niche: ${context.niche}` : '',
        context.sourceTitle ? `Source title/page: "${context.sourceTitle}"` : '',
        context.mediaAgent?.viewerNeed ? `Media agent viewer need: ${context.mediaAgent.viewerNeed}` : '',
        context.mediaAgent?.minimumAcceptable || context.mediaAgent?.searchStrategy?.minimumAcceptable ? `Media agent minimum acceptable: ${context.mediaAgent.minimumAcceptable || context.mediaAgent.searchStrategy.minimumAcceptable}` : '',
        context.mediaAgent?.acceptanceTest ? `Media agent acceptance test: ${context.mediaAgent.acceptanceTest}` : '',
        context.mediaAgent?.mandatoryIdentity?.length ? `MANDATORY IDENTITY: ${context.mediaAgent.mandatoryIdentity.slice(0, 8).join(', ')} (${context.mediaAgent.identityEvidenceMode || 'frame-visible'})` : '',
        context.mediaAgent?.mandatoryVisible?.length ? `MANDATORY FRAME-VISIBLE ENTITY: ${context.mediaAgent.mandatoryVisible.slice(0, 8).join(', ')}` : '',
        context.mediaAgent?.mustShow?.length ? `Media agent must show: ${context.mediaAgent.mustShow.slice(0, 8).join(', ')}` : '',
        context.mediaAgent?.mustAvoid?.length ? `Media agent must avoid: ${context.mediaAgent.mustAvoid.slice(0, 8).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const nicheRules = _getNicheSegmentRules(context.niche || '');
    const premiumStockSegment = _isPremiumStockProvider(context.sourceProvider);
    const priorityChannelSegment = !!context.priorityChannel;
    const wantsGraphicSegment = _wantsGraphic(mediaHunter);
    const hunterRules = mediaHunter ? `
MEDIA HUNTER TARGET:
- Target visual: ${mediaHunter.targetDescription || 'literal usable B-roll'}
- Mode: ${mediaHunter.mode || 'literal'} | strict raw footage: ${mediaHunter.strictRaw ? 'YES' : 'NO'}
${mediaHunter.prefer?.length ? `- Prefer visible: ${mediaHunter.prefer.slice(0, 8).join(', ')}` : ''}
${mediaHunter.avoid?.length ? `- Avoid/reject: ${mediaHunter.avoid.slice(0, 10).join(', ')}` : ''}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && !wantsGraphicSegment ? '- If a frame is mainly an anchor, presenter, commentator, picture-in-picture face, subtitle/lower-third, map/satellite screenshot, route graphic, chart, infographic, thumbnail, or animated explainer, reject it even when the topic text matches. Clean footage of a named/relevant public figure, official, celebrity, athlete, worker, soldier, or event participant is allowed when they are the subject, not the presenter.' : ''}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && wantsGraphicSegment ? REQUESTED_GRAPHIC_RULE : ''}
${_personSubjectRule(mediaHunter)}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics ? '- Segment hunt rule: prefer exact keyword matches, but accept clean raw domain B-roll that matches the target visual and video topic when the exact place/event label is not visibly provable from the frame.' : ''}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && premiumStockSegment ? `- EXCEPTION: this video is from ${context.sourceProvider} (premium stock library). A clean reference MAP/satellite/route diagram, 3D map, or map animation is ACCEPTABLE when it VISIBLY labels the topic's actual place/region/route. Cartoons, illustrations, non-map animated explainers, and generic world maps without topic labels are NOT exempt.` : ''}
${priorityChannelSegment ? '- PRIORITY CHANNEL EXCEPTION: this clip is from a trusted news channel for this niche. Treat baked-in channel logos, news-agency stamps, lower-third banners, and on-screen story captions as INTRINSIC broadcast graphics, NOT watermarks — DO NOT reject for them. Also treat subject-family equivalents within the scene domain as acceptable matches (e.g. for maritime keywords, cargo ship / container ship / oil tanker / bulk carrier / vessel / freighter are all valid; for military keywords, troops / soldiers / convoy / armored vehicle / military aircraft are interchangeable). Reject only when the frame shows a presenter face, animated/illustrated explainer, or a completely unrelated topic.' : ''}
${mediaHunter.allowScreen ? '- Screen/device/interface footage is allowed if it directly fits the scene.' : ''}` : '';

    const prompt = `You are selecting the best ${neededDuration}s segment from a ${totalDuration.toFixed(0)}s video for a FACELESS YouTube video.
These ${frames.length} frames are sampled across the video:
${frameList}

SEARCH KEYWORD: "${keyword}"
${contextBlock ? `\nCONTEXT:\n${contextBlock}` : ''}
${hunterRules ? `\n${hunterRules}` : ''}

This footage will play as B-roll while narration plays over it.

AGENTIC MATCHING (CRITICAL):
If CONTEXT includes Media agent minimum acceptable or acceptance test, judge frames against that contract first. The search keyword is a retrieval hint, not a hard visual law. Accept a different concrete angle when it truthfully communicates the same viewer need through visible evidence/context.

KEYWORD MATCHING WHEN THERE IS NO AGENT CONTRACT:
Read the keyword carefully. The footage should match the SPECIFIC thing described, not just the general category.
- "wooden frame house construction" → MUST show wooden framing/timber of a HOUSE. Road work, concrete pouring, street construction = REJECT (-1).
- "monolithic dome interior concrete" → MUST show the INSIDE of a dome. Exterior shots of domes = REJECT (-1).
- "solar panel rooftop installation" → MUST show panels on a ROOF. Ground-mounted solar farm = poor match.
- If the keyword says "interior" → exterior is WRONG. If keyword says "aerial" → ground-level is WRONG.
ASK: "Does this frame satisfy the agent contract, or if no contract exists, the specific keyword?" If it only matches the GENERAL CATEGORY without satisfying the contract/keyword, return START_AT: -1.

TOPIC RELEVANCE (CRITICAL):
The footage MUST make sense in a video about the stated topic. Judge every frame against the VIDEO TOPIC, not just the keyword.
${context.videoTopic ? `This video is about: "${context.videoTopic}". If a frame shows something unrelated to this topic, it is UNUSABLE even if it superficially matches the keyword.` : ''}
Example: keyword "wind tunnel test" in a video about dome construction → a dome in a wind tunnel = GOOD, a spaceship in a wind tunnel = UNUSABLE (wrong topic).
Example: keyword "hurricane aftermath" in a video about dome homes → destroyed buildings/houses = GOOD, forest fire or war zone = UNUSABLE (wrong event type).

UNIVERSAL DISQUALIFIERS — frames with ANY of these are ALWAYS unusable:
- Content that does NOT belong in a video about the stated topic (wrong subject matter)
- Content that matches the general CATEGORY but not the Media Agent contract or SPECIFIC keyword (e.g. road construction for "house construction"). Exception: clean evidence/proxy B-roll matching the agent target and video topic is acceptable when exact labels are not visible or not required.
- Large/centered/prominent watermarks, channel logos, or agency stamps (Reuters, AFP, CNN, BBC, Getty etc.). Small corner channel bugs are minor, not automatic rejection, if they do not cover the subject.
- Foreign-language subtitle or text overlay burned into the footage
- AI-generated or illustrated content when real footage exists
- Completely unrelated content (e.g. cat video for a politics keyword)
- Comedy/meme/entertainment clips when serious footage is needed
- Presenter/commentator/person-on-camera clips are unusable unless the person is the named/relevant subject and the footage is clean

${nicheRules}

Analyze ALL ${frames.length} frames. For each, note if it has any disqualifier.
Then pick the best frame that has NO disqualifiers AND satisfies the Media Agent contract, Media Hunter target, or keyword/context. For agentic evidence B-roll, do not reject a clean visible proxy/context shot just because the exact phrase is not labeled in-frame.
If NO frame satisfies the contract/target/context, you MUST reply START_AT: -1. Do NOT pick the "least bad" frame — reject the whole video instead.

OUTPUT FORMAT — STRICT:
Reply with EXACTLY these three lines and nothing else. No markdown. No tables. No bullets. No code fences. No preamble. No commentary after the third line.

BEST_FRAME: <frame number> at <timestamp>s — <what it shows and why it's best>
AVOID: <frame numbers with disqualifiers and why, or "none">
START_AT: <recommended start timestamp in seconds, or -1 if all frames are unusable>`;

    try {
        console.log(`  🔍 [clip-analyzer] Calling DeepVision (${_visionRouteLabel()}) with ${frames.length} frames...`);
        const response = await callVideoAI(prompt, frames, { maxTokens: 400 });
        console.log(`  🔍 [clip-analyzer] DeepVision response: ${(response || '').substring(0, 200)}`);
        let result = _parseSegmentResponse(response, timestamps, neededDuration, safeEnd);
        if (!result) {
            // Format drift is the #1 multi-frame vision failure here and used to
            // silently degrade to heuristic trims. ONE strict-format retry
            // recovers most — same fix that recovered the 30 unjudged
            // vision-score candidates in ai-vision.js.
            console.log(`  🔁 [clip-analyzer] Unparseable DeepVision response - one strict-format retry`);
            try {
                const retryResp = await callVideoAI(
                    `${prompt}\n\nIMPORTANT: your previous reply did not follow OUTPUT FORMAT. Reply with EXACTLY the three lines (BEST_FRAME / AVOID / START_AT) and NOTHING else.`,
                    frames, { maxTokens: 400 }
                );
                result = _parseSegmentResponse(retryResp, timestamps, neededDuration, safeEnd);
            } catch (_) { /* fall through to heuristic */ }
        }
        if (result && result.rejectedAll) {
            // Explicit model rejection — pass the marker up so callers KILL
            // the candidate instead of heuristic-trimming an unusable clip.
            return result;
        }
        if (result) {
            console.log(`  ✅ [clip-analyzer] Segment selected: startTime=${Math.round(result.startTime)}s | reason: ${result.reason || 'N/A'}`);
        } else {
            console.log(`  ⚠️ [clip-analyzer] Could not parse segment from DeepVision response`);
        }
        return result;
    } catch (err) {
        console.log(`  ⚠️ [clip-analyzer] Segment analysis failed: ${err.message}`);
        return null;
    }
}

/**
 * Validate the exact clip window that would be downloaded.
 *
 * findBestSegment() samples across the whole source video and may choose one
 * promising timestamp. This second pass checks the actual [start, start+duration]
 * window so text overlays, presenters, or animated explainer sections do not
 * slip through just because one sampled frame looked usable.
 *
 * @param {string} streamUrl - Direct video stream URL
 * @param {number} totalDuration - Total video duration
 * @param {number} startTime - Proposed clip start time
 * @param {number} neededDuration - Clip duration needed
 * @param {string} keyword - What we are looking for
 * @param {Object} [context] - same context shape as findBestSegment()
 * @returns {Promise<{ok: boolean, score: number, reason: string, issues: string[], raw?: string}|null>}
 */
async function validateSegmentWindow(streamUrl, totalDuration, startTime, neededDuration, keyword, context = {}) {
    if (!isClipAnalysisAvailable()) {
        console.log(`  [clip-analyzer] validateSegmentWindow: not available`);
        return null;
    }
    const duration = Number(totalDuration);
    const start = Number(startTime);
    const needed = Math.max(1, Number(neededDuration) || 1);
    if (!streamUrl || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start)) {
        return null;
    }

    const safeStart = Math.max(0, Math.min(start, Math.max(0, duration - 0.5)));
    const safeEnd = Math.min(duration, safeStart + needed);
    const windowDuration = safeEnd - safeStart;
    if (windowDuration < Math.min(2, needed)) {
        return {
            ok: false,
            score: 0,
            reason: `clip window too short (${windowDuration.toFixed(1)}s)`,
            issues: ['window too short'],
        };
    }

    const mediaHunter = context.mediaHunter || null;
    const requestedFrames = Math.max(
        3,
        Math.min(8, Number(context.windowFrames || config.clipAnalyzer?.segmentWindowFrames || DEFAULTS.segmentWindowFrames) || DEFAULTS.segmentWindowFrames)
    );
    const allowReserve = context.allowOmniReserve === true;
    const usableFrames = _usableOmniFrames({ allowReserve });
    if (usableFrames < 3) {
        const reserveNote = allowReserve ? '' : ` (${_reserveFrames()} reserved for late scenes)`;
        console.log(`  [clip-analyzer] Window validation skipped: only ${usableFrames} usable DeepVision frame(s) left${reserveNote}`);
        return {
            ok: false,
            score: 0,
            reason: 'not enough DeepVision frame budget for exact-window validation',
            issues: ['budget exhausted'],
        };
    }
    let validationFrames = Math.min(requestedFrames, usableFrames);
    validationFrames = _claimOmniFrames(validationFrames, { allowReserve });
    if (validationFrames < 3) {
        const reserveNote = allowReserve ? '' : ` (${_reserveFrames()} protected for late scenes)`;
        console.log(`  [clip-analyzer] Window validation skipped: no reservable DeepVision frames left${reserveNote}`);
        if (validationFrames > 0) _commitOmniFrames(validationFrames, 0);
        return {
            ok: false,
            score: 0,
            reason: 'not enough reservable DeepVision frame budget for exact-window validation',
            issues: ['budget exhausted'],
        };
    }
    if (validationFrames < requestedFrames) {
        console.log(`  [clip-analyzer] Window validation capped by DeepVision budget: ${validationFrames}/${requestedFrames} frames${allowReserve ? ' (using reserve)' : ''}`);
    }

    const validationTimestamps = _buildWindowValidationTimestamps(safeStart, safeEnd, validationFrames);
    console.log(`  [clip-analyzer] Validating exact window ${Math.round(safeStart)}s-${Math.round(safeEnd)}s with ${validationFrames} edge-aware frames...`);
    let frames = [];
    try {
        frames = await extractFramesFromUrl(streamUrl, duration, validationFrames, {
            startTime: safeStart,
            endTime: safeEnd,
            timestamps: validationTimestamps,
        });
    } catch (err) {
        _commitOmniFrames(validationFrames, 0);
        throw err;
    }

    if (frames.length < 3) {
        console.log(`  [clip-analyzer] Only extracted ${frames.length} window frames (need 3+)`);
        _commitOmniFrames(validationFrames, 0);
        return {
            ok: false,
            score: 0,
            reason: `only extracted ${frames.length} validation frames`,
            issues: ['frame extraction failed'],
        };
    }

    _commitOmniFrames(validationFrames, frames.length);
    console.log(`  [clip-analyzer] Window frames extracted -> sending to DeepVision (${_visionRouteLabel()}) | budget now ${_omniFramesSent}/${_omniBudget}`);

    const contextBlock = [
        context.videoTopic ? `Video topic: "${context.videoTopic}"` : '',
        _requestedVisualLine(context, keyword),
        context.sceneText ? `Scene narration: "${context.sceneText}"` : '',
        context.niche ? `Niche: ${context.niche}` : '',
        context.sourceTitle ? `Source title/page: "${context.sourceTitle}"` : '',
        context.mediaAgent?.viewerNeed ? `Media agent viewer need: ${context.mediaAgent.viewerNeed}` : '',
        context.mediaAgent?.minimumAcceptable || context.mediaAgent?.searchStrategy?.minimumAcceptable ? `Media agent minimum acceptable: ${context.mediaAgent.minimumAcceptable || context.mediaAgent.searchStrategy.minimumAcceptable}` : '',
        context.mediaAgent?.acceptanceTest ? `Media agent acceptance test: ${context.mediaAgent.acceptanceTest}` : '',
        context.mediaAgent?.mandatoryIdentity?.length ? `MANDATORY IDENTITY: ${context.mediaAgent.mandatoryIdentity.slice(0, 8).join(', ')} (${context.mediaAgent.identityEvidenceMode || 'frame-visible'})` : '',
        context.mediaAgent?.mandatoryVisible?.length ? `MANDATORY FRAME-VISIBLE ENTITY: ${context.mediaAgent.mandatoryVisible.slice(0, 8).join(', ')}` : '',
        context.mediaAgent?.mustShow?.length ? `Media agent must show: ${context.mediaAgent.mustShow.slice(0, 8).join(', ')}` : '',
        context.mediaAgent?.mustAvoid?.length ? `Media agent must avoid: ${context.mediaAgent.mustAvoid.slice(0, 8).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const premiumStockWindow = _isPremiumStockProvider(context.sourceProvider);
    const priorityChannelWindow = !!context.priorityChannel;
    const wantsGraphicWindow = _wantsGraphic(mediaHunter);
    const hunterRules = mediaHunter ? `
MEDIA HUNTER TARGET:
- Target visual: ${mediaHunter.targetDescription || 'literal usable B-roll'}
- Mode: ${mediaHunter.mode || 'literal'} | strict raw footage: ${mediaHunter.strictRaw ? 'YES' : 'NO'}
${mediaHunter.prefer?.length ? `- Prefer visible: ${mediaHunter.prefer.slice(0, 8).join(', ')}` : ''}
${mediaHunter.avoid?.length ? `- Avoid/reject: ${mediaHunter.avoid.slice(0, 10).join(', ')}` : ''}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && !wantsGraphicWindow ? '- This is strict raw footage. Reject if any frame is mainly an anchor, presenter, commentator, picture-in-picture face, subtitle/lower-third, big text overlay, map/satellite screenshot, route graphic, chart, infographic, thumbnail, or animated explainer. Clean footage of a named/relevant public figure, official, celebrity, athlete, worker, soldier, or event participant is allowed when they are the subject, not the presenter.' : ''}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && wantsGraphicWindow ? REQUESTED_GRAPHIC_RULE : ''}
${_personSubjectRule(mediaHunter)}
${mediaHunter.strictRaw && !mediaHunter.allowGraphics && premiumStockWindow ? `- EXCEPTION: this clip is from ${context.sourceProvider} (premium stock library). PASS the window when it is a clean reference MAP/satellite/route diagram, 3D map, or map animation that VISIBLY labels the topic's actual place/region/route. Cartoons, illustrations, non-map animated explainers, and generic world maps without topic labels are NOT exempt.` : ''}
${priorityChannelWindow ? '- PRIORITY CHANNEL EXCEPTION: this window is from a trusted news channel for the scene niche. DO NOT REJECT for: baked-in channel logos, news-agency watermarks, lower-third banners, story-captions, foreign-language burned subtitles — these are intrinsic broadcast graphics, not packaging defects. Also accept subject-family equivalents within the scene domain (maritime: cargo ship / container ship / oil tanker / bulk carrier / vessel / freighter all interchangeable; military: troops / soldiers / armored vehicles / military aircraft interchangeable). Only REJECT for: presenter face on camera, animated/illustrated explainer, picture-in-picture commentary, or a hard cut to a completely unrelated topic.' : ''}
${mediaHunter.allowScreen ? '- Screen/device/interface footage is allowed if it directly fits the scene.' : ''}` : '';

    const frameList = frames.map((f, i) => `Frame ${i + 1} at ${f.timestamp.toFixed(1)}s`).join(', ');
    const prompt = `You are validating the EXACT ${windowDuration.toFixed(1)}s video window that will be downloaded for a FACELESS YouTube video.
These frames come ONLY from that final clip window:
${frameList}
They are intentionally sampled near the start, middle, and end of the final window to catch late cuts.

SEARCH KEYWORD: "${keyword}"
${contextBlock ? `\nCONTEXT:\n${contextBlock}` : ''}
${hunterRules ? `\n${hunterRules}` : ''}

Judge the entire window, not just the best frame.

PASS only if ALL frames are usable B-roll for the Media Agent contract and scene context. If there is no Media Agent contract, use the keyword/context.
Camera angle/perspective/crop changes are allowed only when the SAME real subject/location/event stays continuous.
If CONTEXT says MANDATORY IDENTITY is source-proven, the source title/page may prove the named identity. In that mode, judge the frames by the requested real-world subject/process/setting; do not reject solely because the logo/name is not readable in the frame.
REJECT if ANY frame contains a hard problem:
- the MANDATORY FRAME-VISIBLE ENTITY from context is absent or not identifiable
- a hard source/content change: the window switches to a different clip, presenter, map, graphic, AI/collage, or unrelated scene
- a hard cut inside the window where later frames no longer show the same real-world subject/location/event
- big/centered text overlay, subtitles, news ticker, headline, list text, or infographic text
- lower thirds only when they are prominent/blocking/unrelated; a small source-identifying lower third is allowed for source-proven identity footage
- presenter/commentator/YouTuber/news anchor, unless the person is the named/relevant subject and the shot is clean
- picture-in-picture face, split-screen commentary, studio setup, podcast/interview layout
- animated explainer, AI-generated/illustrated scene, thumbnail-style graphic, chart, route graphic, or map/satellite screenshot when strict raw footage is required
- large/prominent watermark/channel logo/agency stamp; small corner logo/bug is allowed only if non-blocking
- wrong subject, wrong event, or only generally related while missing the target visual
- only keyword-adjacent but not satisfying the Media Agent minimum acceptable / acceptance test

Reply in this EXACT format:
WINDOW: PASS or REJECT
ISSUES: comma-separated issues, or none
REASON: one short sentence
SCORE: 1-10`;

    try {
        const response = await callVideoAI(prompt, frames, { maxTokens: 260 });
        const parsed = _parseWindowValidation(response, context);
        console.log(`  [clip-analyzer] Window validation: ${parsed.ok ? 'PASS' : 'REJECT'} ${parsed.score ? `(${parsed.score}/10)` : ''} - ${parsed.reason || 'no reason'}`);
        return parsed;
    } catch (err) {
        console.log(`  [clip-analyzer] Window validation failed: ${err.message}`);
        return {
            ok: false,
            score: 0,
            reason: `window validation failed: ${err.message}`,
            issues: ['validation failed'],
        };
    }
}

/**
 * Parse the segment selection response.
 */
function _parseSegmentResponse(response, timestamps, neededDuration, maxEnd) {
    if (!response) return null;

    const result = { startTime: null, confidence: 0.7, reason: '' };
    let bestFrameTimestamp = null;
    let bestFrameNumber = null;

    for (const line of response.split('\n')) {
        const lower = line.toLowerCase().trim();
        if (lower.startsWith('start_at:')) {
            // Check for -1 (all frames unusable). Return an explicit REJECT
            // marker, not null — null means "vision unavailable" upstream and
            // triggers a heuristic trim that USES the clip anyway. An explicit
            // model rejection (burned-in news banners, off-topic) must kill
            // the candidate, like a human editor would.
            if (lower.includes('-1')) {
                console.log(`  ⚠️ [clip-analyzer] Omni rejected ALL frames as off-topic/unusable`);
                return { rejectedAll: true };
            }
            const numMatch = line.match(/(\d+(?:\.\d+)?)/);
            if (numMatch) {
                result.startTime = parseFloat(numMatch[1]);
            }
        } else if (lower.startsWith('best_frame:')) {
            result.reason = line.substring(line.indexOf(':') + 1).trim();
            // Extract frame number for confidence
            const frameNum = line.match(/frame\s+(\d+)/i);
            if (frameNum) {
                result.confidence = 0.85;
                bestFrameNumber = parseInt(frameNum[1], 10);
            }
            // Recover timestamp embedded in BEST_FRAME line ("Frame N at Xs")
            const tsMatch = line.match(/\bat\s+(\d+(?:\.\d+)?)\s*s\b/i);
            if (tsMatch) bestFrameTimestamp = parseFloat(tsMatch[1]);
        }
    }

    // Truncation recovery: response cut off before START_AT line.
    // Fall back to BEST_FRAME timestamp (or the timestamp at that frame index).
    if (result.startTime === null) {
        if (Number.isFinite(bestFrameTimestamp)) {
            result.startTime = bestFrameTimestamp;
            console.log(`  ↺ [clip-analyzer] START_AT missing — recovered start=${bestFrameTimestamp.toFixed(1)}s from BEST_FRAME line`);
        } else if (bestFrameNumber && Array.isArray(timestamps) && timestamps[bestFrameNumber - 1] != null) {
            result.startTime = Number(timestamps[bestFrameNumber - 1]);
            console.log(`  ↺ [clip-analyzer] START_AT missing — recovered start=${result.startTime.toFixed(1)}s from frame ${bestFrameNumber} timestamp`);
        } else {
            return null;
        }
    }

    // Clamp to safe range
    const maxStart = maxEnd - neededDuration;
    result.startTime = Math.max(0, Math.min(result.startTime, maxStart));

    return result;
}

function _parseWindowValidation(response, context = {}) {
    const raw = String(response || '').trim();
    const result = {
        ok: false,
        // null = "not read yet", same sentinel rule as _parseClipAnalysis above.
        // Coerced to 0 (+ parseError) before returning; null and 0 compare
        // identically in every check below, so nothing downstream shifts.
        score: null,
        reason: '',
        issues: [],
        raw,
    };
    if (!raw) {
        result.reason = 'empty validation response';
        result.score = 0;
        result.parseError = true;
        return result;
    }

    let explicitDecision = null;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('window:')) {
            const value = lower.substring(lower.indexOf(':') + 1).trim();
            if (/\b(pass|accept|usable|clean|ok)\b/.test(value)) explicitDecision = true;
            if (/\b(reject|fail|unusable|bad|no)\b/.test(value)) explicitDecision = false;
        } else if (lower.startsWith('issues:')) {
            const issueStr = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            if (issueStr && !/^none\b/i.test(issueStr)) {
                result.issues = issueStr.split(',').map(s => s.trim()).filter(Boolean);
            }
        } else if (lower.startsWith('reason:')) {
            result.reason = trimmed.substring(trimmed.indexOf(':') + 1).trim();
        } else if (lower.startsWith('score:')) {
            const numMatch = trimmed.match(/(\d+(?:\.\d+)?)/);
            if (numMatch) result.score = Math.min(10, Math.max(1, Math.round(Number(numMatch[1]))));
        } else if (result.score === null) {
            const tolerant = _scoreFromClipLine(trimmed);
            if (tolerant !== null) result.score = Math.min(10, Math.max(1, tolerant));
        }
    }

    if (result.score === null) {
        const scoreMatch = raw.match(/score[^0-9]*(\d+(?:\.\d+)?)/i)
            || raw.match(/\b(\d+(?:\.\d+)?)\s*\/\s*10\b/)
            || raw.match(/(?:^|\n)\s*(10|[0-9])\s*$/m);
        if (scoreMatch) result.score = Math.min(10, Math.max(1, Math.round(Number(scoreMatch[1]))));
    }

    const rawIssueText = result.issues.join(' ').toLowerCase();
    const identityMode = String(context?.mediaAgent?.identityEvidenceMode || '').toLowerCase();
    const sourceProvenIdentity = /source-proven|either/.test(identityMode)
        && Array.isArray(context?.mediaAgent?.mandatoryIdentity)
        && context.mediaAgent.mandatoryIdentity.length > 0;
    // Normalize "non-blocking" / "non blocking" → "nonblocking" so the negative
    // regex below doesn't false-match the "blocking" half of "non-blocking" and
    // mark a clearly-acceptable corner watermark as a hard watermark problem.
    const hardIssueText = rawIssueText
        .replace(/\bnon[\s-]?blocking\b/gi, 'nonblocking')
        .replace(/\bnon[\s-]?obstructive\b/gi, 'nonobstructive');
    const isCornerOrSide = /\b(corner|top[- ]?(left|right)|bottom[- ]?(left|right)|side|edge|logo bug|channel bug)\b/i.test(hardIssueText);
    const smallWatermarkOnly = (/small\s+(corner\s+)?(watermark|logo|bug)/i.test(hardIssueText)
        || /\bnonblocking\b/.test(hardIssueText)
        || isCornerOrSide)
        && !/(large|prominent|center|centered|covers|dominates)/i.test(hardIssueText)
        && !/(?<!non)\bblocking\b/i.test(hardIssueText);
    const lowerThirdProblem = /lower thirds?/.test(hardIssueText)
        && (!sourceProvenIdentity || /(big|centered|prominent|large|covers|dominates|blocking|unrelated)/i.test(hardIssueText));
    const nonWatermarkHardProblem = [
        /\b(big|centered|prominent|large)\b/,
        /(?<!non)\bblocking\b/,
        /text overlay|subtitles?|ticker|headline|infographic|list text/,
        /presenter|commentator|youtuber|anchor|talking head|podcast|interview|picture-in-picture|split-screen/,
        /animated explainer|ai-generated|illustrated|thumbnail|chart|route graphic|map|satellite/,
        /hard source|content change|source change|scene change|hard cut|jump cut|abrupt transition|stitched|different clip|different source|unrelated scene|switches? to|cuts? to|discontinuity/,
        /wrong subject|wrong event|off[-\s]?topic|unrelated/,
    ].some(rx => rx.test(hardIssueText)) || lowerThirdProblem;
    const watermarkProblem = /watermark|channel logo|agency stamp/.test(hardIssueText) && !smallWatermarkOnly;
    const hardProblem = nonWatermarkHardProblem || watermarkProblem;

    // A person-subject scene accepts on-subject footage from a different day, so
    // the window bar drops with it. So does a relaxed niche, where rough real
    // footage of the actual people beats a polished clip of nobody — see
    // media/niche-strictness.js. `hardProblem` is deliberately NOT relaxed by
    // either: anchors, tickers, PiP faces and hard source changes still reject
    // the window at any score, in every niche.
    const strictWindowFloor = 6;
    const windowFloor = footageAcceptFloor({
        niche: context?.niche,
        strictFloor: strictWindowFloor,
        sourceProvider: context?.sourceProvider,
        personSubjectActive: context?.mediaHunter?.personSubject?.active,
    });

    if (explicitDecision === true) {
        result.ok = !hardProblem && (!result.score || result.score >= Math.min(5, windowFloor));
    } else if (explicitDecision === false) {
        result.ok = false;
    } else {
        result.ok = Boolean(result.score >= windowFloor && !hardProblem);
    }

    if (result.score === null) {
        result.score = 0;
        result.parseError = true;
    }

    if (!result.reason) {
        result.reason = result.issues.length ? result.issues.join(', ') : (result.ok ? 'clean exact window' : 'window did not pass validation');
    }
    return result;
}

// ============ STATS ============

/**
 * Get usage stats for the current build session.
 */
function getStats() {
    return {
        totalFramesSent: _omniFramesSent + _clipAnalysisFrames,
        omniFrames: _omniFramesSent,
        clipAnalysisFrames: _clipAnalysisFrames,
        omniBudget: _omniBudget,
        omniReserveFrames: _reserveFrames(),
        omniUsableFrames: _usableOmniFrames(),
        omniReservedFrames: _omniFramesReserved,
        omniRemaining: Math.max(0, _omniBudget - _omniFramesSent),
        available: isAvailable(),
    };
}

// ============ EXPORTS ============

module.exports = {
    analyzeClip,
    findBestSegment,
    validateSegmentWindow,
    pickLightweightTrimStart,
    extractFrames,
    extractFramesFromUrl,
    resetBudget,
    isAvailable,
    isClipAnalysisAvailable,
    hasOmniBudget,
    getFramesBudgetInfo,
    getSegmentFrameNeed,
    getOmniFramesSent,
    getOmniFramesReserved,
    getOmniBudget,
    getStats,
    DEFAULTS,
    // Exported for scripts/verify/vision-score-parse.js only — the score
    // sentinel/parser is a regression-gated invariant, not a public API.
    _parseClipAnalysis,
    _parseWindowValidation,
    _scoreFromClipLine,
};
