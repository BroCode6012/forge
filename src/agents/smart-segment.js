/**
 * Smart Segment Selection — Universal Video Segment Scoring
 *
 * Shared module used by ALL video providers (YouTube, News, future providers)
 * and by footage-manager as a post-download safety net.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  RULES — When & How Smart Segment Scoring Applies
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  1. MINIMUM DURATION
 *     - Pre-download (URL scoring):  video must be >= minDuration (default 20s)
 *     - Post-download (file scoring): video must be >= 15s
 *     - Videos shorter than this are already concise — no scoring needed.
 *
 *  2. FRAME SAMPLING
 *     - Default: 4 frames spread evenly across the safe zone
 *     - YouTube: 6 frames (longer videos, more variety)
 *     - Safe zone: skip first/last margins (default 8% start, 10% end)
 *     - Frames extracted in parallel batches (default batch size: 3)
 *
 *  3. WHAT TO PENALIZE (handled by Vision AI prompt in ai-vision.js)
 *     - News anchors / talking heads in studio
 *     - Text-heavy screens (headlines, tickers, lower thirds)
 *     - Studio/desk shots with minimal visual content
 *     - Watermarks, logos, AI-generated artifacts
 *     - Generic stock footage that doesn't match the topic
 *
 *  4. SCORING THRESHOLD
 *     - Frames scoring <= 2 are rejected as unusable
 *     - If ALL frames score <= 2, return null (use heuristic fallback)
 *     - Fast-fail: if first frame scores 0, Vision AI is broken — skip rest
 *
 *  5. FALLBACK CHAIN
 *     - Vision AI scoring → chapter-based selection (YouTube only) → percentage heuristic
 *     - If Vision AI unavailable: return null immediately (caller uses heuristic)
 *     - If ffmpeg unavailable: return null immediately
 *
 *  6. PROVIDER INTEGRATION
 *     - YouTube: calls selectBestSegment() with streamUrl before download
 *     - News: calls selectBestSegment() with direct/HLS URL before download
 *     - Footage Manager: calls scoreDownloadedVideo() AFTER download as safety net
 *     - Future providers: import and call selectBestSegment() with any video URL
 *
 *  7. CONTEXT PASSING
 *     - Always pass keyword, sceneText, niche, videoTopic, theme, entities
 *     - More context = better scoring accuracy
 *     - Vision AI uses literal visual matching (not symbolic/metaphorical)
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../settings/config');
const { classifyStrictRawVisual } = require('../media/relevant-person-rules');
const { packagingPenalty, noteGateObservation } = require('../media/packaging-intent');
const { applyVisionScoreSanity, clampSelfReportedDefects } = require('../vision/vision-score-sanity');

function applyMediaHunterFrameGate(result, context, keyword = '', options = {}) {
    // Defect clamp first: if the scorer's own description admits burned-in
    // broadcast packaging, the score cannot exceed the rubric cap.
    let gated = clampSelfReportedDefects(result, context);
    gated = applyVisionScoreSanity(gated, keyword, context, options);
    if (!context?.mediaHunter?.strictRaw || context.mediaHunter.allowGraphics) return gated;
    const description = String(gated?.description || result?.description || '');
    const strictRawVisual = classifyStrictRawVisual(description, keyword, context?.sceneText || '', context);
    // Every strict-raw candidate we look at is one data point on the question
    // "is clean raw footage even findable for this topic?" — that is what the
    // relief below is learned from, in-run, per build.
    noteGateObservation(strictRawVisual.reject);
    if (!strictRawVisual.reject) return gated;
    // Graceful degradation (global, all niches): "packaged" footage (overlays,
    // maps, lower-thirds, presenters) is a soft NEGATIVE, not a death sentence.
    // Hard-capping to 2 used to nuke topically-perfect clips (e.g. a satellite of
    // the very strait the video is about) → the scene then reused a neighbour
    // clip, which is strictly worse.
    //
    // The replacement for the old `min(6, base - 2)` is straight subtraction,
    // scaled by how bad the packaging actually is. The ceiling was the real
    // defect: it FLATTENED the top of the range (8, 9 and 10 all became exactly
    // 6, so the best packaged clip in the race was indistinguishable from the
    // worst one that still passed) while a plain 7 — the most common good score
    // there is — became 5 and died under an accept floor of 6. One point of raw
    // difference decided accept-vs-reject; three points decided nothing.
    //
    // Straight subtraction keeps the order intact, and a packaged clip still
    // cannot outrank a clean clip that scored the same, because the clean one is
    // not demoted at all. Relevance (the base vision score) still decides, not a
    // per-niche word list.
    const base = Number(gated.score || 0);
    const { penalty, relief, buckets } = packagingPenalty(strictRawVisual.buckets);
    const penalized = Math.max(0, base - penalty);
    const reliefNote = relief ? `, −${relief} relief: clean raw footage not retrievable this run` : '';
    return {
        ...gated,
        score: penalized,
        _strictRawPenalized: true,
        _strictRawPenalty: penalty,
        _strictRawBuckets: buckets,
        description: `${description} [strict raw penalty −${penalty} → ${penalized}/10: ${strictRawVisual.reason}${reliefNote}]`,
    };
}

// ─── Constants ───────────────────────────────────────────────────────

function _cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function _escapeRe(value) {
    return _cleanText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _meaningfulTokens(value) {
    const stop = new Set([
        'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'inside',
        'shot', 'footage', 'video', 'scene', 'real', 'visible', 'clearly',
        'show', 'shows', 'showing', 'multiple', 'several', 'various',
    ]);
    return _cleanText(value)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length >= 4 && !stop.has(token));
}

function _containsPhrase(text, phrase) {
    const clean = _cleanText(phrase).toLowerCase();
    if (!clean || clean.length < 3) return false;
    if (text.includes(clean)) return true;
    const escaped = _escapeRe(clean).replace(/\\ /g, '\\s+');
    try {
        return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    } catch (_) {
        return false;
    }
}

function _frameEditorFit(result, context = {}, keyword = '') {
    const text = _cleanText(result?.description).toLowerCase();
    if (!text) return 0;
    const mediaAgent = context.mediaAgent || {};
    const hunter = context.mediaHunter || {};
    const positivePhrases = [
        keyword,
        context.sceneText,
        hunter.targetDescription,
        ...(Array.isArray(hunter.prefer) ? hunter.prefer : []),
        ...(Array.isArray(mediaAgent.mustShow) ? mediaAgent.mustShow : []),
        ...(Array.isArray(mediaAgent.literalRequiredObjects) ? mediaAgent.literalRequiredObjects : []),
        ...(Array.isArray(mediaAgent.mandatoryVisible) ? mediaAgent.mandatoryVisible : []),
        ...(Array.isArray(mediaAgent.mandatoryIdentity) ? mediaAgent.mandatoryIdentity : []),
    ].filter(Boolean);
    const avoidPhrases = [
        ...(Array.isArray(hunter.avoid) ? hunter.avoid : []),
        ...(Array.isArray(mediaAgent.mustAvoid) ? mediaAgent.mustAvoid : []),
        ...(Array.isArray(mediaAgent.rejectIf) ? mediaAgent.rejectIf : []),
    ].filter(Boolean);

    let fit = 0;
    for (const phrase of positivePhrases) {
        if (_containsPhrase(text, phrase)) fit += 4;
        for (const token of _meaningfulTokens(phrase)) {
            if (new RegExp(`\\b${_escapeRe(token)}\\b`, 'i').test(text)) fit += 1;
        }
    }
    for (const phrase of avoidPhrases) {
        if (_containsPhrase(text, phrase)) fit -= 5;
        for (const token of _meaningfulTokens(phrase)) {
            if (new RegExp(`\\b${_escapeRe(token)}\\b`, 'i').test(text)) fit -= 1;
        }
    }

    const targetText = positivePhrases.join(' ').toLowerCase();
    const targetFamilies = [
        { want: /\b(wide|establishing|interior|room|facility|floor|aisle)\b/, see: /\b(wide|interior|room|facility|floor|aisle|environment|establishing)\b/, points: 4 },
        { want: /\b(row|rows|lined|multiple|many|several)\b/, see: /\b(row|rows|lined|multiple|many|several)\b/, points: 5 },
        { want: /\b(machine|machines|washer|washers|dryer|dryers|equipment)\b/, see: /\b(machine|machines|washer|washers|dryer|dryers|equipment)\b/, points: 3 },
        { want: /\b(coin|coin-operated|card reader|payment)\b/, see: /\b(coin|coin-operated|card reader|payment)\b/, points: 2 },
        { want: /\b(brand|branding|logo|label|visible|identifiable)\b/, see: /\b(brand|branding|logo|label|visible|identifiable|reading|called|named)\b/, points: 3 },
    ];
    for (const item of targetFamilies) {
        if (item.want.test(targetText) && item.see.test(text)) fit += item.points;
    }
    if (/\b(close[- ]?up|single|one machine)\b/i.test(text) && /\b(wide|row|rows|multiple|many|several)\b/i.test(targetText)) fit -= 5;
    if (/\b(man|woman|person|people)\b/i.test(text) && !/\b(person|people|man|woman|worker|customer|shopper|operator)\b/i.test(targetText)) fit -= 4;
    if (/\b(blurry|blurred|out of focus|unreadable|not readable|no branding|lacking|cannot see|could be)\b/i.test(text)) fit -= 8;
    return fit;
}

function _segmentRankScore(frame) {
    const score = Math.max(0, Math.min(10, Number(frame?.score || 0)));
    const fit = Math.max(-24, Math.min(36, Number(frame?.editorFit || 0)));
    if (frame?.windowStats) {
        return Number(frame.windowStats.rankScore || 0) + (score * 4) + fit;
    }
    return score * 12 + fit;
}

function _median(values) {
    const nums = (values || [])
        .map(v => Number(v))
        .filter(v => Number.isFinite(v))
        .sort((a, b) => a - b);
    if (nums.length === 0) return 0;
    return nums[Math.floor(nums.length / 2)];
}

function _attachWindowStats(scoredFrames, totalDuration, neededDuration) {
    const duration = Math.max(1, Number(neededDuration || 1));
    const maxStart = Math.max(0, Number(totalDuration || 0) - duration - 2);
    const frames = (scoredFrames || []).map(frame => ({ ...frame }));
    for (const frame of frames) {
        const startTime = Math.max(0, Math.min(Number(frame.timestamp || 0), maxStart));
        const endTime = startTime + duration;
        let inWindow = frames.filter(other =>
            Number(other.timestamp || 0) >= startTime - 0.25
            && Number(other.timestamp || 0) <= endTime + 0.25
        );
        if (inWindow.length < 2 && frames.length > 1) {
            const nearest = frames
                .filter(other => other !== frame)
                .map(other => ({
                    ...other,
                    _distance: Math.abs(Number(other.timestamp || 0) - Number(frame.timestamp || 0)),
                }))
                .sort((a, b) => a._distance - b._distance)[0];
            if (nearest) inWindow = [frame, nearest];
        }
        const scores = inWindow.map(item => Math.max(0, Math.min(10, Number(item.score || 0))));
        const fits = inWindow.map(item => Math.max(-24, Math.min(36, Number(item.editorFit || 0))));
        const median = _median(scores);
        const min = scores.length ? Math.min(...scores) : 0;
        const avg = scores.length ? scores.reduce((sum, n) => sum + n, 0) / scores.length : 0;
        const fitAvg = fits.length ? fits.reduce((sum, n) => sum + n, 0) / fits.length : 0;
        const highCount = scores.filter(n => n >= 7).length;
        const lowCount = scores.filter(n => n <= 3).length;
        const singleFramePenalty = inWindow.length < 2 && Number(totalDuration || 0) > duration * 1.8 ? 18 : 0;
        const rankScore = (median * 15)
            + (avg * 4)
            + (min * 3)
            + (highCount * 10)
            + fitAvg
            - (lowCount * 26)
            - singleFramePenalty;
        frame.windowStats = {
            startTime,
            endTime,
            frameCount: inWindow.length,
            median,
            min,
            avg,
            highCount,
            lowCount,
            rankScore,
        };
    }
    return frames;
}

function _buildSegmentChoices(rankedFrames, totalDuration, neededDuration, scoreThreshold) {
    const maxStart = Math.max(0, Number(totalDuration || 0) - Number(neededDuration || 0) - 2);
    const choices = [];
    const seenStarts = new Set();
    const minGap = Math.max(2, Math.min(8, Math.floor(Number(neededDuration || 5))));

    for (const frame of rankedFrames || []) {
        const score = Number(frame?.score || 0);
        if (score <= scoreThreshold) continue;
        const timestamp = Number(frame?.timestamp || 0);
        const startTime = Math.max(0, Math.min(timestamp, maxStart));
        const rounded = Math.round(startTime);
        let tooClose = false;
        for (const prior of seenStarts) {
            if (Math.abs(prior - rounded) < minGap) {
                tooClose = true;
                break;
            }
        }
        if (tooClose) continue;
        seenStarts.add(rounded);
        const windowConfidence = frame?.windowStats
            ? Math.max(
                0.45,
                Math.min(
                    0.95,
                    (Number(frame.windowStats.median || 0) / 10)
                    + Math.max(0, Number(frame?.editorFit || 0)) / 160
                    + Math.min(0.12, Number(frame.windowStats.highCount || 0) * 0.04)
                    - Math.min(0.3, Number(frame.windowStats.lowCount || 0) * 0.15)
                )
            )
            : Math.max(0.55, Math.min(0.95, (score / 10) + Math.max(0, Number(frame?.editorFit || 0)) / 120));
        choices.push({
            startTime,
            timestamp,
            frame: Number(frame?.idx || 0) + 1,
            score,
            editorFit: Number(frame?.editorFit || 0),
            rankScore: Number(frame?.rankScore || _segmentRankScore(frame)),
            window: frame?.windowStats ? {
                median: frame.windowStats.median,
                min: frame.windowStats.min,
                frames: frame.windowStats.frameCount,
                lowCount: frame.windowStats.lowCount,
            } : null,
            description: frame?.description || '',
            confidence: windowConfidence,
        });
        if (choices.length >= 5) break;
    }
    return choices;
}

const DEFAULTS = {
    numSamples: 4,          // frames to extract
    batchSize: 3,           // parallel frame extractions
    minDuration: 20,        // minimum video seconds to bother scoring
    startMargin: 0.08,      // skip first 8% of video
    endMargin: 0.10,        // skip last 10% of video
    startMarginSec: 3,      // absolute minimum seconds to skip at start
    endMarginSec: 3,        // absolute minimum seconds to skip at end
    frameTimeout: 15000,    // ms timeout per frame extraction
    probeTimeout: 15000,    // ms timeout for duration probe
    scoreThreshold: 2,      // minimum acceptable score
    frameScale: 512,        // downscale frames to this width (saves bandwidth)
    frameQuality: 3,        // JPEG quality (1=best, 31=worst)
};

// ─── Core: Select Best Segment ───────────────────────────────────────

/**
 * Score frames from a video URL and pick the best segment to download.
 * Works with any video URL: direct mp4, HLS, YouTube stream, etc.
 *
 * @param {string} videoUrl - URL to the video (mp4, m3u8, or stream URL)
 * @param {object} opts
 * @param {number} opts.neededDuration - how many seconds of video we need
 * @param {string} opts.keyword - search keyword for relevance scoring
 * @param {object} [opts.context] - { sceneText, niche, videoTopic, theme, entities, tone, mood }
 * @param {number} [opts.totalDuration] - if known, skip probing
 * @param {number} [opts.numSamples] - override frame count (default 4)
 * @param {number} [opts.batchSize] - override parallel batch size (default 3)
 * @param {number} [opts.minDuration] - override minimum duration (default 20)
 * @param {number} [opts.startMargin] - override start margin % (default 0.08)
 * @param {number} [opts.endMargin] - override end margin % (default 0.10)
 * @param {string} [opts.providerTag] - log prefix e.g. "YouTube", "News" (default "SmartSeg")
 * @returns {Promise<number|null>} best start time in seconds, or null
 */
async function selectBestSegment(videoUrl, opts = {}) {
    const tag = opts.providerTag || 'SmartSeg';

    try {
        // 1. Check vision + ffmpeg availability
        let scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable;
        try {
            ({ scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable } = require('../vision/ai-vision'));
        } catch (e) {
            return null;
        }

        if (!isVisionAvailable()) {
            console.log(`  🎯 [${tag}] Vision AI not available — skipping segment scoring`);
            return null;
        }

        const ffmpegPath = checkFfmpegAvailable();
        if (!ffmpegPath) {
            console.log(`  🎯 [${tag}] ffmpeg not available — skipping segment scoring`);
            return null;
        }

        // 2. Determine total duration
        const minDuration = opts.minDuration ?? DEFAULTS.minDuration;
        let totalDuration = opts.totalDuration || null;

        if (!totalDuration) {
            totalDuration = await probeDuration(ffmpegPath, videoUrl);
        }

        if (!totalDuration || totalDuration < minDuration) {
            if (totalDuration) {
                console.log(`  🎯 [${tag}] Video too short (${Math.round(totalDuration)}s < ${minDuration}s) — skipping scoring`);
            } else {
                console.log(`  🎯 [${tag}] Could not determine video duration — skipping scoring`);
            }
            return null;
        }

        // 3. Calculate sample timestamps
        const numSamples = opts.numSamples ?? DEFAULTS.numSamples;
        const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
        const neededDuration = opts.neededDuration || 10;
        const scoreThreshold = opts.scoreThreshold ?? DEFAULTS.scoreThreshold;

        const startMargin = opts.startMargin ?? DEFAULTS.startMargin;
        const endMargin = opts.endMargin ?? DEFAULTS.endMargin;

        const safeStart = Math.max(DEFAULTS.startMarginSec, Math.floor(totalDuration * startMargin));
        const safeEnd = Math.max(safeStart + neededDuration, totalDuration - Math.max(DEFAULTS.endMarginSec, Math.floor(totalDuration * endMargin)));
        const range = safeEnd - safeStart;

        if (range <= 0) return null;

        const timestamps = [];
        for (let i = 0; i < numSamples; i++) {
            timestamps.push(Math.floor(safeStart + (range * i) / Math.max(1, numSamples - 1)));
        }

        console.log(`  🎯 [${tag}] Smart segment: scoring ${numSamples} frames at ${timestamps.map(t => t + 's').join(', ')} (total: ${Math.round(totalDuration)}s)`);

        // 4. Extract frames in batches
        const tempDir = config.paths?.temp || path.join(__dirname, '..', '..', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const uid = Date.now().toString(36);
        const framePaths = [];

        for (let batch = 0; batch < numSamples; batch += batchSize) {
            const batchPromises = [];
            for (let j = batch; j < Math.min(batch + batchSize, numSamples); j++) {
                const framePath = path.join(tempDir, `_seg_frame_${uid}_${j}.jpg`);
                framePaths.push(framePath);
                batchPromises.push(extractFrame(ffmpegPath, videoUrl, timestamps[j], framePath));
            }
            await Promise.all(batchPromises);
        }

        // 5. Read valid frames
        const validFrames = [];
        for (let i = 0; i < framePaths.length; i++) {
            if (!framePaths[i] || !fs.existsSync(framePaths[i])) continue;
            try {
                const stat = fs.statSync(framePaths[i]);
                if (stat.size < 500) continue; // corrupt/empty
                validFrames.push({
                    idx: i,
                    base64: fs.readFileSync(framePaths[i]).toString('base64'),
                });
            } catch (e) {}
        }

        if (validFrames.length < 2) {
            console.log(`  🎯 [${tag}] Too few frames extracted (${validFrames.length}) — skipping scoring`);
            _cleanupFrames(framePaths);
            return null;
        }

        // 6. Score frames sequentially. Keep scanning after bad intro frames.
        const keyword = opts.keyword || '';
        const context = opts.context || {};
        const scores = [];
        const validIndices = [];
        const scoredFrames = [];

        for (const frame of validFrames) {
            const rawResult = await scoreVideoFrame(frame.base64, 'image/jpeg', keyword, context);
            const result = applyMediaHunterFrameGate(rawResult, context, keyword, {
                floor: opts.scoreSanityFloor ?? Math.max(5, (opts.scoreThreshold ?? DEFAULTS.scoreThreshold) + 1),
            });
            if (result?.scoreSanity?.adjusted) {
                console.log(`    [Score Sanity] frame ${frame.idx + 1}: ${result.scoreSanity.from}/10 -> ${result.scoreSanity.to}/10 (${result.scoreSanity.reason})`);
            }
            scores.push(result.score);
            validIndices.push(frame.idx);
            scoredFrames.push({
                idx: frame.idx,
                timestamp: timestamps[frame.idx],
                score: Number(result.score || 0),
                editorFit: _frameEditorFit(result, context, keyword),
                description: result.description || '',
            });

            const desc = result.description ? ` -> ${result.description}` : '';
            console.log(`    Frame ${frame.idx + 1} (${timestamps[frame.idx]}s): ${result.score}/10${desc}`);

            if (scores.length === 1 && result.score === 0) {
                console.log(`  [${tag}] First frame scored 0 - continuing scan for later usable footage`);
            }
        }

        _cleanupFrames(framePaths);

        // 7. Pick best scoring frame (on tie, prefer later frame: past intros, more content)
        const windowScoredFrames = _attachWindowStats(scoredFrames, totalDuration, neededDuration);
        const ranked = windowScoredFrames
            .map(frame => ({ ...frame, rankScore: _segmentRankScore(frame) }))
            .slice()
            .sort((a, b) =>
                (b.rankScore - a.rankScore)
                || (b.score - a.score)
                || (b.editorFit - a.editorFit)
                || (a.timestamp - b.timestamp)
            );
        const best = ranked[0] || { idx: 0, score: 0, timestamp: 0, editorFit: 0 };
        const bestIdx = best.idx;
        const bestScore = best.score;

        if (bestScore <= scoreThreshold) {
            console.log(`  [${tag}] All frames scored poorly (best: ${bestScore}/10) - using fallback`);
            return null;
        }

        const bestTime = timestamps[bestIdx];
        const maxStart = totalDuration - neededDuration - 2;
        const startTime = Math.min(bestTime, Math.max(0, maxStart));
        const windowNote = best.windowStats
            ? `, window median=${best.windowStats.median}/10 min=${best.windowStats.min}/10 frames=${best.windowStats.frameCount}`
            : '';
        console.log(`  [${tag}] Best: frame ${bestIdx + 1} at ${bestTime}s (score: ${bestScore}/10, fit: ${best.editorFit}${windowNote}, rank: ${Math.round(best.rankScore || 0)}) -> start at ${startTime}s`);
        const choices = _buildSegmentChoices(ranked, totalDuration, neededDuration, scoreThreshold);
        if (choices.length > 1) {
            const altSummary = choices
                .slice(1, 4)
                .map(choice => `${Math.round(choice.startTime)}s(${choice.score}/10 fit:${choice.editorFit})`)
                .join(', ');
            console.log(`  [${tag}] Backup windows: ${altSummary || 'none'}`);
        }
        if (opts.returnAlternates) {
            return {
                startTime,
                confidence: choices[0]?.confidence || Math.max(0.55, Math.min(0.95, bestScore / 10)),
                score: bestScore,
                editorFit: best.editorFit,
                rankScore: best.rankScore,
                reason: best.description || 'best smart segment frame',
                alternatives: choices,
            };
        }
        return startTime;

    } catch (err) {
        console.log(`  [${opts.providerTag || 'SmartSeg'}] Segment scoring failed: ${err.message}`);
        return null;
    }
}


// ─── Post-Download Segment Scoring ───────────────────────────────────

/**
 * Score a video FILE that's already been downloaded.
 * If the video is long enough and the current segment is poor,
 * returns the best start time for re-extraction.
 *
 * Used by footage-manager as a safety net for ANY provider.
 *
 * @param {string} filePath - path to downloaded video file
 * @param {object} opts - same as selectBestSegment opts
 * @returns {Promise<{shouldRetrim: boolean, startTime: number|null, bestScore: number}>}
 */
async function scoreDownloadedVideo(filePath, opts = {}) {
    const tag = opts.providerTag || 'PostScore';

    try {
        let scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable;
        try {
            ({ scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable } = require('../vision/ai-vision'));
        } catch (e) {
            return { shouldRetrim: false, startTime: null, bestScore: 0 };
        }

        if (!isVisionAvailable()) return { shouldRetrim: false, startTime: null, bestScore: 0 };

        const ffmpegPath = checkFfmpegAvailable();
        if (!ffmpegPath) return { shouldRetrim: false, startTime: null, bestScore: 0 };

        // Probe downloaded file duration
        const totalDuration = await probeDuration(ffmpegPath, filePath);
        const minScoreDuration = Math.max(1, Number(opts.minScoreDuration || opts.minDuration || 2));
        if (!totalDuration || totalDuration < minScoreDuration) {
            return {
                shouldRetrim: false,
                startTime: null,
                bestScore: 0,
                description: `clip too short to score (${Number(totalDuration || 0).toFixed(1)}s)`,
            };
        }

        // Score one representative frame. For already-trimmed short clips,
        // sample the middle instead of the 25% mark so a 4-6s race clip is
        // judged on its actual usable moment instead of a fade/seek edge.
        const sampleRatio = totalDuration < 15 ? 0.5 : 0.25;
        const edgeMargin = Math.min(0.5, Math.max(0.05, totalDuration * 0.08));
        const sampleTime = Math.max(0, Math.min(totalDuration - edgeMargin, totalDuration * sampleRatio));
        const tempDir = config.paths?.temp || path.join(__dirname, '..', '..', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const framePath = path.join(tempDir, `_postscore_${Date.now().toString(36)}.jpg`);

        const extracted = await extractFrame(ffmpegPath, filePath, sampleTime, framePath);
        if (!extracted || !fs.existsSync(framePath)) {
            return { shouldRetrim: false, startTime: null, bestScore: 0 };
        }

        try {
            const stat = fs.statSync(framePath);
            if (stat.size < 500) {
                _cleanupFrames([framePath]);
                return { shouldRetrim: false, startTime: null, bestScore: 0 };
            }

            const base64 = fs.readFileSync(framePath).toString('base64');
            const keyword = opts.keyword || '';
            const context = opts.context || {};
            const rawResult = await scoreVideoFrame(base64, 'image/jpeg', keyword, context);
            const result = applyMediaHunterFrameGate(rawResult, context, keyword, {
                floor: opts.scoreSanityFloor ?? opts.minAcceptScore ?? 5,
            });
            if (result?.scoreSanity?.adjusted) {
                console.log(`  [Score Sanity] [${tag}] post-download: ${result.scoreSanity.from}/10 -> ${result.scoreSanity.to}/10 (${result.scoreSanity.reason})`);
            }

            console.log(`  🎯 [${tag}] Post-download score: ${result.score}/10 → ${result.description || 'no description'}`);

            _cleanupFrames([framePath]);

            // Propagate API-failure signal so race / serial paths can refuse
            // to blacklist a candidate when the vision provider itself was down.
            const base = {
                description: result.description || '',
                apiError: !!result.apiError,
                errorMessage: result.errorMessage || '',
                parseError: !!result.parseError,
                scoreSanity: result.scoreSanity || null,
            };
            // If score is acceptable, no need to retrim
            if (result.score > 3) {
                return { shouldRetrim: false, startTime: null, bestScore: result.score, ...base };
            }

            // Score is poor — but we can only suggest retrimming, not do it
            // (the original source URL may no longer be available)
            console.log(`  🎯 [${tag}] Low score (${result.score}/10) — flagging for potential retry`);
            return { shouldRetrim: true, startTime: null, bestScore: result.score, ...base };

        } catch (e) {
            _cleanupFrames([framePath]);
            return { shouldRetrim: false, startTime: null, bestScore: 0, apiError: true, errorMessage: e?.message?.slice(0, 200) || 'unknown' };
        }

    } catch (err) {
        return { shouldRetrim: false, startTime: null, bestScore: 0, apiError: true, errorMessage: err?.message?.slice(0, 200) || 'unknown' };
    }
}


// ─── Shared Utilities ────────────────────────────────────────────────

/**
 * Extract a single frame from a video URL or file at a given timestamp.
 * @param {string} ffmpegPath
 * @param {string} source - URL or local file path
 * @param {number} timestamp - seconds
 * @param {string} outputPath - where to write the JPEG
 * @returns {Promise<boolean>} true if frame extracted successfully
 */
function extractFrame(ffmpegPath, source, timestamp, outputPath) {
    return new Promise((resolve) => {
        execFile(ffmpegPath, [
            '-ss', String(timestamp),
            '-i', source,
            '-vf', `scale=${DEFAULTS.frameScale}:-1`,
            '-frames:v', '1',
            '-q:v', String(DEFAULTS.frameQuality),
            '-y', outputPath,
        ], {
            timeout: DEFAULTS.frameTimeout,
            windowsHide: true,
        }, (error) => {
            resolve(!error && fs.existsSync(outputPath));
        });
    });
}

/**
 * Probe the duration of a video URL or local file using ffprobe (or ffmpeg fallback).
 * Handles HLS manifests, direct mp4s, and local files.
 * @param {string} ffmpegPath
 * @param {string} source - URL or local file path
 * @returns {Promise<number|null>} duration in seconds, or null
 */
function probeDuration(ffmpegPath, source) {
    const isRemote = source.startsWith('http');
    // HLS/remote URLs need more time to fetch and parse the manifest
    const timeout = isRemote ? 25000 : DEFAULTS.probeTimeout;

    return new Promise((resolve) => {
        const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

        // Method 1: ffprobe (most reliable)
        execFile(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            source,
        ], {
            timeout,
            windowsHide: true,
        }, (error, stdout) => {
            if (!error && stdout) {
                const dur = parseFloat(stdout.trim());
                if (dur > 0) return resolve(dur);
            }

            // Method 2: ffmpeg -i (parse "Duration: HH:MM:SS.ms" from stderr)
            execFile(ffmpegPath, [
                '-i', source,
                '-f', 'null', '-',
            ], {
                timeout,
                windowsHide: true,
            }, (error2, stdout2, stderr2) => {
                // ffmpeg always "errors" with -f null, but stderr has duration info
                const combined = (stderr2 || '') + (stdout2 || '');
                const durMatch = combined.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
                if (durMatch) {
                    const dur = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
                    if (dur > 0) return resolve(dur);
                }

                // Method 3: Binary probe — try extracting a frame at 60s.
                // If it succeeds, we know the video is at least 60s long.
                // This is a last resort for HLS streams where duration is unknown.
                if (isRemote) {
                    const probePath = path.join(config.paths?.temp || path.join(__dirname, '..', '..', 'temp'), `_probe_${Date.now().toString(36)}.jpg`);
                    execFile(ffmpegPath, [
                        '-ss', '60',
                        '-i', source,
                        '-frames:v', '1',
                        '-q:v', '10',
                        '-y', probePath,
                    ], {
                        timeout,
                        windowsHide: true,
                    }, (error3) => {
                        try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch (e) {}
                        if (!error3) {
                            // Frame at 60s extracted → video is at least 60s+ (estimate 120s)
                            return resolve(120);
                        }
                        // Try at 20s
                        const probePath2 = probePath + '2.jpg';
                        execFile(ffmpegPath, [
                            '-ss', '20',
                            '-i', source,
                            '-frames:v', '1',
                            '-q:v', '10',
                            '-y', probePath2,
                        ], {
                            timeout,
                            windowsHide: true,
                        }, (error4) => {
                            try { if (fs.existsSync(probePath2)) fs.unlinkSync(probePath2); } catch (e) {}
                            if (!error4) {
                                // Frame at 20s → video is at least 20s+ (estimate 60s)
                                return resolve(60);
                            }
                            resolve(null);
                        });
                    });
                } else {
                    resolve(null);
                }
            });
        });
    });
}

/**
 * Clean up temporary frame files.
 */
function _cleanupFrames(framePaths) {
    for (const f of framePaths) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
}


/**
 * Probe video stream dimensions + codec via ffprobe.
 * Returns { width, height, codec } or null on failure.
 * Used by footage-manager to reject vertical/HEVC clips post-download
 * regardless of what the provider's search metadata claimed.
 */
function probeDimensions(ffmpegPath, source) {
    return new Promise((resolve) => {
        const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
        execFile(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,codec_name',
            '-of', 'default=noprint_wrappers=1',
            source,
        ], {
            timeout: 15000,
            windowsHide: true,
        }, (error, stdout) => {
            if (error || !stdout) return resolve(null);
            const w = stdout.match(/width=(\d+)/);
            const h = stdout.match(/height=(\d+)/);
            const c = stdout.match(/codec_name=([\w]+)/);
            if (!w || !h) return resolve(null);
            resolve({
                width: parseInt(w[1], 10),
                height: parseInt(h[1], 10),
                codec: c ? c[1].toLowerCase() : '',
            });
        });
    });
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
    selectBestSegment,
    scoreDownloadedVideo,
    extractFrame,
    probeDuration,
    probeDimensions,
    DEFAULTS,
};
