/**
 * footage-borrow.js — the last rung before the give-up card.
 *
 * WHY THIS EXISTS
 *
 * The ladder used to end one rung too early. A scene that found nothing went to
 * `coverage-rescue.js`, which re-searched it with every source open; if THAT
 * came back empty too, the build painted a generated slide — a dark gradient, a
 * few decorative bars, and the words "DOCUMENTARY CONTEXT" — and shipped it as
 * the scene's visual. It is not a visual. It is an apology, and on screen it
 * reads as a broken video.
 *
 * Meanwhile the same build is usually sitting on twenty perfectly good clips it
 * already found, downloaded, and passed through vision scoring, for OTHER
 * scenes of the SAME video. Re-using the most closely related one is strictly
 * better than drawing a card: it is real footage, it is on-topic, it already
 * survived every quality gate, it costs nothing, and it takes no time.
 *
 * So this module runs after the rescue and before the audit. For every scene
 * still uncovered it borrows the best-matching clip already won by this build.
 *
 * HOW THE MATCH IS CHOSEN (no niche rules, no fixed word lists)
 *
 *   1. Each scene contributes two texts: what it NEEDS (its planner subject,
 *      search terms, narration) and, if it owns media, what that media SHOWS
 *      (the query that actually won it).
 *   2. Word importance is learned from THIS video. A word appearing in every
 *      scene tells us nothing and is weighted down to almost zero; a word
 *      appearing in two scenes is a strong link. That is ordinary IDF computed
 *      over the run's own scenes — which is why it needs no stop-word list and
 *      works the same in every language the app supports.
 *   3. Donors are ranked by that similarity and then pushed down for being
 *      CLOSE on the timeline: a clip repeating two scenes later is the most
 *      visible kind of repeat, one repeating ten minutes later is barely
 *      noticeable. Distance is measured as a share of this video's own length,
 *      never in seconds, so it means the same thing in a 3-minute video and a
 *      30-minute one.
 *   4. Every extra time an asset is borrowed pushes it further down, so the
 *      video spreads its reuse instead of hammering one clip.
 *
 * The "is this related enough?" bar is also learned from the run: it is the
 * median similarity across every needy/donor pair in this video. A match above
 * it is reported as topical; a match below it still gets used — the alternative
 * is the card, and the card is not an option — but it is logged as weak so the
 * audit line stays honest.
 *
 * HOW A BORROWED CLIP AVOIDS READING AS A REPEAT
 *
 *   - Video: the borrower gets a different in-point (`scene.mediaOffset`),
 *     chosen to avoid every second of the source any other scene is already
 *     showing. Different seconds of the same clip is different footage.
 *   - Image: there is no second in-point to take, so the borrower is given a
 *     different Ken Burns speed, alternating slow/fast by borrow order, so the
 *     move across the frame does not replay identically.
 *
 * WHAT IT WILL NOT DO
 *
 *   - Borrow from a placeholder, or from another borrower (no chains) — the
 *     donor bank is exactly the scenes `scene-coverage.js` calls real footage.
 *   - Touch presenter scenes: they are filtered out of the sweep universe
 *     upstream, because their visual belongs to the presenter system.
 *   - Invent a file. If this build genuinely found zero footage anywhere, there
 *     is nothing to borrow and the card remains the honest last resort.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { classifyScene, findUncovered } = require('./scene-coverage');

/** Media status written onto a scene whose visual came from another scene. */
const BORROW_STATUS = 'borrowedFromScene';

/**
 * Seconds of padding when carving a fresh in-point out of a source clip, so two
 * scenes sharing one file never land on the same frame at the boundary.
 */
const OFFSET_GAP_S = 0.15;

/** Ken Burns speeds a borrowed still alternates between, by borrow order. */
const IMAGE_MOTION_SPEEDS = [1.35, 0.7];

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

function _num(v, dflt = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
}

function _duration(scene) {
    const span = _num(scene?.endTime, 0) - _num(scene?.startTime, 0);
    if (span > 0) return span;
    return Math.max(0, _num(scene?.duration, 0));
}

function _sceneNo(scene, fallback) {
    const n = Number(scene?.index);
    return Number.isFinite(n) ? n : fallback;
}

function _usable(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s) return '';
    return /^(none|null|undefined|n\/a)$/i.test(s) ? '' : s;
}

/**
 * Words, with no language assumptions. Splitting on "not a letter and not a
 * digit" works for every script the app ships; importance is sorted out by IDF
 * below, which is why there is deliberately no stop-word list here — a fixed
 * list of English filler words would be exactly the kind of hardcoding this
 * codebase bans, and would do nothing for the other five languages.
 */
function _tokens(text) {
    const out = new Set();
    for (const raw of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (raw.length >= 2) out.add(raw);
    }
    return out;
}

/** What this scene is ABOUT — used for the needy side of the match. */
function _subjectText(scene) {
    const narration = typeof scene?.text === 'string' ? scene.text.split(/[.!?]/)[0] : '';
    const entities = Array.isArray(scene?.entities)
        ? scene.entities.map(e => (typeof e === 'string' ? e : e?.name || '')).join(' ')
        : '';
    return [
        _usable(scene?.keyword),
        _usable(scene?.searchKeyword),
        _usable(scene?.visualIntent),
        _usable(scene?.stockQuery),
        _usable(scene?.webQuery),
        _usable(scene?.bgQuery),
        _usable(scene?.templateBgQuery),
        _usable(entities),
        _usable(narration),
    ].filter(Boolean).join(' ');
}

/**
 * What a donor's media actually SHOWS. The query that won it is the truest
 * description available — it is the phrase a provider matched and vision then
 * approved — so it leads, with the scene's own subject behind it.
 */
function _mediaText(scene) {
    const tried = Array.isArray(scene?.mediaDiagnostics?.providers) ? scene.mediaDiagnostics.providers : [];
    let winningQuery = '';
    for (let i = tried.length - 1; i >= 0; i--) {
        const q = _usable(tried[i]?.query);
        if (!q) continue;
        winningQuery = q;
        if (String(tried[i]?.status || '').toLowerCase() === 'accepted') break;
    }
    return [winningQuery, _subjectText(scene)].filter(Boolean).join(' ');
}

/**
 * Word importance learned from this video alone: a word in every scene carries
 * almost no signal, a word in two scenes carries a lot.
 */
function _buildIdf(docs) {
    const df = new Map();
    for (const tokens of docs) {
        for (const t of tokens) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = Math.max(1, docs.length);
    const idf = new Map();
    for (const [t, n] of df.entries()) idf.set(t, Math.log(1 + N / (1 + n)));
    return idf;
}

/** Cosine similarity over IDF-weighted presence. 0 = nothing in common. */
function _similarity(a, b, idf) {
    if (!a.size || !b.size) return 0;
    let dot = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const t of small) {
        if (!large.has(t)) continue;
        const w = idf.get(t) || 0;
        dot += w * w;
    }
    if (dot <= 0) return 0;
    let na = 0;
    for (const t of a) { const w = idf.get(t) || 0; na += w * w; }
    let nb = 0;
    for (const t of b) { const w = idf.get(t) || 0; nb += w * w; }
    if (!(na > 0) || !(nb > 0)) return 0;
    return dot / Math.sqrt(na * nb);
}

function _median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function _fileExists(file) {
    try {
        return !!file && fs.existsSync(file) && fs.statSync(file).size > 0;
    } catch {
        return false;
    }
}

function _isImageFile(file, declaredType) {
    if (declaredType === 'image') return true;
    if (declaredType === 'video') return false;
    return IMAGE_EXTS.has(path.extname(String(file || '')).toLowerCase());
}

/**
 * How long the source file runs. Local file, so this is a cheap ffprobe. A
 * failure is not fatal: without a duration the borrower simply keeps the
 * donor's in-point, which is still real footage.
 */
async function _probeSourceDuration(file) {
    try {
        const config = require('../settings/config');
        const { probeDuration } = require('../agents/smart-segment');
        const ffmpegPath = config.paths?.ffmpeg
            || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
        const d = await probeDuration(ffmpegPath, file);
        return Number.isFinite(d) && d > 0 ? d : 0;
    } catch {
        return 0;
    }
}

/**
 * A second of the source nobody else is showing.
 *
 * `claimed` holds every window of this file already spoken for, in source time.
 * We look for the first clean gap after one of them; if the clip is too short
 * to give anyone a private window we take the point furthest from every claimed
 * start, which at least moves the framing.
 */
function _pickOffset(claimed, srcDuration, needDuration) {
    if (!(srcDuration > 0)) return 0;
    const maxStart = Math.max(0, srcDuration - Math.max(0, needDuration));
    if (!(maxStart > OFFSET_GAP_S * 2)) return 0;

    const windows = [...claimed].sort((a, b) => a.start - b.start);
    for (const w of windows) {
        const cand = w.end + OFFSET_GAP_S;
        if (cand > maxStart) continue;
        const clashes = windows.some(o => cand < o.end - OFFSET_GAP_S && (cand + needDuration) > o.start + OFFSET_GAP_S);
        if (!clashes) return Math.round(cand * 100) / 100;
    }

    const STEPS = 12;
    let best = 0;
    let bestGap = -1;
    for (let i = 0; i <= STEPS; i++) {
        const cand = (maxStart * i) / STEPS;
        let gap = Infinity;
        for (const w of windows) gap = Math.min(gap, Math.abs(cand - w.start));
        if (!Number.isFinite(gap)) gap = maxStart;
        if (gap > bestGap) { bestGap = gap; best = cand; }
    }
    return Math.round(best * 100) / 100;
}

/**
 * Fill every still-uncovered scene with the best-matching footage this build
 * already owns.
 *
 * @param {object}   args
 * @param {Array}    args.scenes    the sweep universe (same list the audit uses)
 * @param {Array}    args.graphics  the FINAL fullscreen graphics + template scenes
 * @param {object}   [args.log]     {info,warn,ok,dim}
 * @param {Function} [args.probeDuration]  injected clip-length probe, so the
 *        verify harness can exercise the in-point picker without shipping real
 *        video files. Defaults to the real ffprobe.
 * @returns {Promise<{uncovered:number, donors:number, borrowed:number,
 *                    topical:number, weak:number, stillBroken:Array,
 *                    assignments:Array}>}
 */
async function borrowForUncovered({ scenes, graphics, log, probeDuration } = {}) {
    const probe = typeof probeDuration === 'function' ? probeDuration : _probeSourceDuration;
    const out = {
        uncovered: 0, donors: 0, borrowed: 0, topical: 0, weak: 0,
        stillBroken: [], assignments: [],
    };
    const say = typeof log === 'function' ? log : null;
    const L = {
        info: say || log?.info || console.log,
        warn: say || log?.warn || console.log,
        ok: say || log?.ok || console.log,
        dim: say || log?.dim || console.log,
    };

    const ctx = { graphics };
    const universe = Array.isArray(scenes) ? scenes.filter(Boolean) : [];
    const needy = findUncovered(universe, ctx);
    out.uncovered = needy.length;
    if (needy.length === 0) return out;

    // Donor bank: exactly what the classifier calls real footage, with the file
    // still on disk. A borrowed scene classifies as 'borrowed', not 'footage',
    // so borrowing can never chain off another borrow.
    const donors = [];
    for (const scene of universe) {
        if (classifyScene(scene, ctx).kind !== 'footage') continue;
        if (!_fileExists(scene.mediaFile)) continue;
        donors.push(scene);
    }
    out.donors = donors.length;
    if (donors.length === 0) {
        L.warn(`   nothing to borrow from — this build won no footage at all, so ${needy.length} scene(s) keep their card`);
        out.stillBroken = needy.map(n => n.scene);
        return out;
    }

    // Learn word importance from this video's own scenes.
    const needyTokens = new Map();
    const donorTokens = new Map();
    for (const n of needy) needyTokens.set(n.scene, _tokens(_subjectText(n.scene)));
    for (const d of donors) donorTokens.set(d, _tokens(_mediaText(d)));
    const idf = _buildIdf([...needyTokens.values(), ...donorTokens.values()]);

    // Every pair's similarity, so the "related enough" bar comes from this run
    // rather than from a number someone picked once.
    const pairScores = [];
    const simOf = new Map(); // needy scene -> Map(donor -> sim)
    for (const n of needy) {
        const row = new Map();
        for (const d of donors) {
            const s = _similarity(needyTokens.get(n.scene), donorTokens.get(d), idf);
            row.set(d, s);
            pairScores.push(s);
        }
        simOf.set(n.scene, row);
    }
    const bar = _median(pairScores);

    // Timeline nearness is measured against this video's own length, so the
    // penalty means the same thing in a 3-minute video and a 30-minute one.
    const videoEnd = universe.reduce((mx, s) => Math.max(mx, _num(s?.endTime, 0)), 0) || 1;

    // Longest on screen first: the same "stop on the least damage" order the
    // rescue uses, and it also lets the biggest scenes claim the best clips.
    const ordered = [...needy].sort((a, b) => _duration(b.scene) - _duration(a.scene));

    // Per-file bookkeeping: which seconds are spoken for, and how many scenes
    // are already showing this asset.
    const claimed = new Map();  // file -> [{start,end}]
    const useCount = new Map(); // file -> number
    const srcDurations = new Map();
    for (const d of donors) {
        const file = d.mediaFile;
        const off = Math.max(0, _num(d.mediaOffset, 0));
        if (!claimed.has(file)) claimed.set(file, []);
        claimed.get(file).push({ start: off, end: off + Math.max(0, _duration(d)) });
        useCount.set(file, (useCount.get(file) || 0) + 1);
    }

    for (const target of ordered) {
        const scene = target.scene;
        const row = simOf.get(scene);
        const sceneNo = _sceneNo(scene, target.index);
        const sceneStart = _num(scene.startTime, 0);

        let best = null;
        for (const donor of donors) {
            if (donor === scene) continue;
            const sim = row.get(donor) || 0;

            // Nearness penalty: a clip repeating two scenes later is the most
            // visible kind of repeat, one repeating ten minutes later is barely
            // noticeable. Expressed as a share of the video, never in seconds.
            const gap = Math.abs(_num(donor.startTime, 0) - sceneStart) / videoEnd;
            const nearness = 1 / (1 + 6 * Math.max(0, 1 - Math.min(1, gap * 4)));

            // Spread the load: each extra scene already showing this asset
            // halves its standing again.
            const spread = 1 / (1 + (useCount.get(donor.mediaFile) || 0));

            // A zero-similarity donor must still be rankable, otherwise the
            // last-resort tier would pick arbitrarily; the tiny floor keeps the
            // nearness and spread terms meaningful without inventing relevance.
            const rank = (sim + 1e-6) * nearness * spread;
            if (!best || rank > best.rank) best = { donor, sim, rank };
        }

        if (!best) {
            out.stillBroken.push(scene);
            continue;
        }

        const donor = best.donor;
        const isTopical = best.sim > 0 && best.sim >= bar;
        const file = donor.mediaFile;
        const isImage = _isImageFile(file, donor.mediaType);
        const needDur = _duration(scene) || 1;

        // Take a different slice of the source so this reads as new footage.
        let offset = Math.max(0, _num(donor.mediaOffset, 0));
        if (!isImage) {
            if (!srcDurations.has(file)) srcDurations.set(file, Number(await probe(file)) || 0);
            offset = _pickOffset(claimed.get(file) || [], srcDurations.get(file) || 0, needDur);
        }

        // The graphic that was supposed to cover this scene is gone; leaving the
        // marker set makes the carve and the framing stages skip it, so the
        // footage we just handed it would never be drawn.
        if (target.kind === 'orphaned-graphic') scene.fullscreenMG = null;

        scene.mediaFile = file;
        scene.mediaExtension = donor.mediaExtension || path.extname(file) || (isImage ? '.jpg' : '.mp4');
        scene.mediaType = isImage ? 'image' : 'video';
        scene.mediaWidth = _num(donor.mediaWidth, 0);
        scene.mediaHeight = _num(donor.mediaHeight, 0);
        scene.sourceProvider = donor.sourceProvider || 'scene media';
        scene.mediaDownloadStatus = BORROW_STATUS;
        scene.agenticFallback = false;
        scene.borrowedFromScene = _sceneNo(donor, null);
        scene.borrowMatch = {
            donorScene: scene.borrowedFromScene,
            donorProvider: scene.sourceProvider,
            similarity: Math.round(best.sim * 1000) / 1000,
            bar: Math.round(bar * 1000) / 1000,
            topical: isTopical,
            reusedCount: (useCount.get(file) || 0) + 1,
        };

        if (isImage) {
            // No second in-point exists for a still, so vary the move instead.
            scene.kenBurnsSpeed = IMAGE_MOTION_SPEEDS[out.borrowed % IMAGE_MOTION_SPEEDS.length];
        } else {
            scene.mediaOffset = offset;
        }

        if (!claimed.has(file)) claimed.set(file, []);
        claimed.get(file).push({ start: offset, end: offset + needDur });
        useCount.set(file, (useCount.get(file) || 0) + 1);

        out.borrowed++;
        if (isTopical) out.topical++; else out.weak++;
        out.assignments.push({
            scene: sceneNo,
            from: scene.borrowedFromScene,
            similarity: scene.borrowMatch.similarity,
            topical: isTopical,
            offset: isImage ? null : offset,
        });
        L.ok(`   ↺ scene ${sceneNo} borrows scene ${scene.borrowedFromScene}'s ${isImage ? 'image' : 'clip'}`
            + `${isImage ? '' : ` from ${offset.toFixed(1)}s`}`
            + ` — ${isTopical ? 'topical' : 'weak'} match (${scene.borrowMatch.similarity})`);
    }

    if (out.borrowed > 0) {
        L.info(`Borrowed real footage for ${out.borrowed} scene(s) that found none `
            + `(${out.topical} topical, ${out.weak} weak) — no give-up cards for these`);
    }
    return out;
}

module.exports = {
    borrowForUncovered,
    BORROW_STATUS,
    // exported for the verify harness
    _tokens,
    _buildIdf,
    _similarity,
    _pickOffset,
    _subjectText,
    _mediaText,
};
