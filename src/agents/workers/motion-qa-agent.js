'use strict';

/**
 * Agentic Motion QA
 *
 * The Motion Director chooses creative intent. This worker verifies the final
 * HyperFrames composition, applies bounded repairs to the plan, regenerates it,
 * and verifies the repaired result before render.
 *
 * It intentionally does not expose another editor/settings surface. The normal
 * workflow remains:
 *   plan -> author/direct -> Motion QA -> render
 *
 * HyperFrames provides the renderer-aware proof:
 *   - lint/check for contract, runtime and layout findings
 *   - keyframes JSON for statically-authored GSAP/CSS/Anime motion
 *   - snapshots for optional multi-frame vision review
 *
 * The bridge also emits hyperframes-motion-manifest.json. It covers dynamic
 * helper/loop motion that HyperFrames' static keyframe parser cannot resolve.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const timelineContract = require('../../project/timeline-contract');
const { requireFixedRenderer, prefersFixedRenderer } = require('../../render/authored-composition-policy');
// The one reading model in the system. Imported rather than restated, because
// this stage and the render-time sameness linter used to carry rival estimates
// and quietly disagree about the same graphic — see minimumReadableDuration.
//
// The sameness measurements come from the same module for the same reason. That
// linter runs at RENDER time, where all it can do is report: by then the plan is
// frozen and nothing can act on "6 of your 9 graphics enter identically". Motion
// QA is the last stage that can still change the plan, so the measurements are
// repeated here, where they can be repaired — using the linter's own thresholds,
// its own run measure and its own entrance classifier, so the stage that fixes
// monotony and the stage that reports it can never disagree about what it is.
const {
    minimumReadableDuration,
    entranceFamily,
    snapMotionSpeed,
    distribution,
    longestRun,
    videoLint,
    DOMINANCE_RATIO,
    RUN_LIMIT,
    MIN_FOR_DOMINANCE,
} = require('../../render/hf-video-lint');

const VERSION = 3;
const VISUAL_GROUPS = ['motionGraphics', 'mgScenes', 'templateScenes'];
const SAFE_ZONES = new Set([
    'auto',
    'center',
    'center-left',
    'center-right',
    'bottom-left',
    'bottom-right',
    'top-left',
    'top-right',
]);
const MOVE_FALLBACK = {
    'bottom-left': 'top-right',
    'bottom-right': 'top-left',
    'top-left': 'bottom-right',
    'top-right': 'bottom-left',
    'center-left': 'center-right',
    'center-right': 'center-left',
    center: 'bottom-left',
    auto: 'bottom-left',
};
const INFORMATIONAL_HYPERFRAMES_CODES = new Set([
    // The bridge deliberately emits one self-contained composition because it
    // is generated, disposable output. Source maintainability lives in the
    // bridge modules, not in hand-editing this HTML file.
    'composition_file_too_large',
]);
const MICRO_VISUAL_TYPES = new Set([
    'focus-word',
    'listicle-counter',
    'progress-tracker',
    'progress-bar',
    'stat-counter',
    'subscribe-cta',
]);

function flagOff(name) {
    return /^(0|false|off|no)$/i.test(String(process.env[name] || '').trim());
}

function enabled() {
    return !flagOff('HF_MOTION_QA');
}

function numeric(value, fallback = NaN) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function compactText(value, max = 140) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function token(value, fallback = '') {
    const out = String(value || '')
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    return out || fallback;
}

function itemWindow(item, fallbackDuration = 3) {
    const start = Math.max(0, numeric(item?.startTime ?? item?.start ?? item?.at, 0));
    const explicitEnd = numeric(item?.endTime ?? item?.end);
    const duration = Math.max(
        0.05,
        numeric(
            item?.durationSeconds
            ?? item?.durationSec
            ?? item?.displayDuration
            ?? item?.duration,
            fallbackDuration
        )
    );
    const end = explicitEnd > start ? explicitEnd : start + duration;
    return { start, end, duration: Math.max(0.05, end - start) };
}

function renderRangeClip(item) {
    const clip = item?._renderRangeClip;
    if (!clip || typeof clip !== 'object') return null;
    const sourceDuration = numeric(clip.sourceDuration, 0);
    const sourceOffset = Math.max(0, numeric(clip.sourceOffset, 0));
    const clippedAtStart = clip.clippedAtStart === true;
    const clippedAtEnd = clip.clippedAtEnd === true;
    if (!(sourceDuration > 0) || (!clippedAtStart && !clippedAtEnd)) return null;
    return {
        sourceDuration,
        sourceOffset: Math.min(sourceDuration, sourceOffset),
        visibleDuration: Math.max(0.001, numeric(clip.visibleDuration, 0.001)),
        clippedAtStart,
        clippedAtEnd,
    };
}

function itemText(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    return [
        item?.text,
        item?.title,
        item?.headline,
        item?.templateText,
        item?.subtext,
        item?.subtitle,
        item?.templateSubtext,
        nested?.text,
        nested?.title,
        nested?.headline,
        nested?.subtext,
        nested?.subtitle,
        ...(Array.isArray(item?.items)
            ? item.items.map((entry) => (
                typeof entry === 'string'
                    ? entry
                    : `${entry?.label || entry?.text || ''} ${entry?.value || ''}`
            ))
            : []),
        ...(Array.isArray(nested?.items)
            ? nested.items.map((entry) => (
                typeof entry === 'string'
                    ? entry
                    : `${entry?.label || entry?.text || ''} ${entry?.value || ''}`
            ))
            : []),
    ].filter(Boolean).join(' ');
}

const SEMANTIC_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'is',
    'it', 'of', 'on', 'or', 'the', 'to', 'was', 'were', 'with',
]);

function plainSemanticText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
            try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return ' '; }
        })
        .replace(/&#(\d+);/g, (_match, decimal) => {
            try { return String.fromCodePoint(parseInt(decimal, 10)); } catch (_) { return ' '; }
        })
        .replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;|&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizedSemanticText(value) {
    return plainSemanticText(value)
        .toLowerCase()
        .replace(/([$€£¥])\s+/g, '$1')
        .replace(/[^a-z0-9$€£¥%]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function numericFacts(value) {
    const matches = plainSemanticText(value).match(/[-+]?\d[\d,]*(?:\.\d+)?(?:\s*%)?/g) || [];
    const facts = [];
    for (const raw of matches) {
        const percent = /%/.test(raw);
        const parsed = Number(raw.replace(/[%\s,]/g, ''));
        if (!Number.isFinite(parsed)) continue;
        const normalized = Number.isInteger(parsed)
            ? String(parsed)
            : String(Number(parsed.toFixed(6)));
        facts.push(`${normalized}${percent ? '%' : ''}`);
    }
    return facts;
}

function semanticProfile(item) {
    const text = itemText(item);
    const normalized = normalizedSemanticText(text);
    const facts = new Set(numericFacts(text));
    const tokens = new Set(
        normalized
            .split(' ')
            .filter(word => word.length > 1 && !SEMANTIC_STOPWORDS.has(word) && !/^\d/.test(word))
    );
    return { normalized, facts, tokens };
}

function semanticProfilesMatch(a, b) {
    if (!a.normalized || !b.normalized) return false;
    if (a.normalized === b.normalized && a.normalized.length >= 3) return true;

    const sharedFacts = [...a.facts].filter(fact => b.facts.has(fact));
    if (sharedFacts.length > 0) {
        const sharedLabels = [...a.tokens].filter(label => b.tokens.has(label));
        if (sharedLabels.length > 0) return true;
        if (a.tokens.size === 0 || b.tokens.size === 0) return true;
    }

    const shorter = a.normalized.length <= b.normalized.length ? a.normalized : b.normalized;
    const longer = shorter === a.normalized ? b.normalized : a.normalized;
    return shorter.length >= 8 && longer.includes(shorter);
}

function windowsAreRelated(a, b, maxGap = 0.8) {
    const gap = Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));
    return gap <= maxGap;
}

function authoredDuplicateNumericFact(item) {
    const authored = item?._authoredComposition || item?.mgData?._authoredComposition;
    if (!authored?.html) return null;
    const itemType = token(item.type || item.mgType || item.templateType, '');
    if (!new Set(['stat-card', 'stat-counter']).has(itemType)) return null;
    if (listItemCount(item) > 1) return null;

    const intendedFacts = new Set(numericFacts(itemText(item)));
    if (intendedFacts.size === 0) return null;
    const counts = new Map();
    for (const fact of numericFacts(authored.html)) {
        counts.set(fact, (counts.get(fact) || 0) + 1);
    }
    return [...intendedFacts].find(fact => (counts.get(fact) || 0) >= 2) || null;
}

function wordCount(item) {
    const matches = itemText(item).match(/\S+/g);
    return matches ? matches.length : 0;
}

/**
 * The single longest run of text the viewer has to read on this graphic.
 *
 * Deliberately the longest candidate rather than all of them joined: a card's
 * headline and its bullet list are read at the same time, not one after the
 * other, so summing them would demand a hold nobody needs and stretch every
 * list card across its whole scene. The list's own weight is already priced in
 * by the per-item term in the budget below.
 *
 * It scans every field the graphic might carry its headline in, because the
 * render-time linter sees a flattened report where any one of them may have
 * landed in `text`. Reading a superset is the safe direction: this stage can
 * then only ever demand at least as much time as that linter will.
 */
function displayText(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    const candidates = [
        item?.text,
        item?.title,
        item?.headline,
        item?.templateText,
        nested?.text,
        nested?.title,
        nested?.headline,
    ];
    let longest = '';
    for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? candidate.trim() : '';
        if (value.length > longest.length) longest = value;
    }
    return longest;
}

function listItemCount(item) {
    const candidates = [
        item?.items,
        item?.mgData?.items,
        item?.templateData?.items,
        item?.agenticComposition?.items,
    ];
    const list = candidates.find(Array.isArray);
    return list ? list.length : 0;
}

function normalizeSpeed(value, fallback = 1) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return clamp(parsed, 0.25, 3);
    const raw = token(value, 'normal');
    if (raw.includes('very-slow')) return 0.55;
    if (raw.includes('slow') || raw.includes('calm') || raw.includes('gentle')) return 0.75;
    if (raw.includes('rapid') || raw.includes('snappy')) return 1.6;
    if (raw.includes('fast') || raw.includes('quick') || raw.includes('energetic')) return 1.35;
    return fallback;
}

function currentSpeed(item) {
    return normalizeSpeed(
        item?.agenticComposition?.motion?.speed
        ?? item?.animationSpeed
        ?? item?._animationSpeed
        ?? item?.mgData?.animationSpeed,
        1
    );
}

function safeZoneOf(item, kind) {
    const candidate = token(
        item?.agenticComposition?.safeZone
        || item?.safeZone
        || item?.position
        || item?.layout,
        kind === 'overlay' ? 'auto' : 'center'
    );
    return SAFE_ZONES.has(candidate) ? candidate : (kind === 'overlay' ? 'auto' : 'center');
}

function isManual(item, field) {
    if (!item) return false;
    if (item.manual === true || item._manual === true) return true;
    const names = field === 'timing'
        ? ['timingManual', 'durationManual', 'startTimeManual', '_timingManual']
        : field === 'position'
            ? ['positionManual', 'safeZoneManual', 'layoutManual', '_positionManual']
            : ['animationManual', 'motionManual', 'animationSpeedManual', '_motionManual'];
    return names.some((name) => item[name] === true || item?.mgData?.[name] === true);
}

function setTiming(item, start, end, fps) {
    const duration = Math.max(0.05, end - start);
    item.startTime = start;
    item.endTime = start + duration;
    item.duration = duration;
    item.durationSeconds = duration;
    item.durationFrames = Math.max(1, Math.round(duration * fps));
    item.durationUnit = 'seconds';
    delete item._hfTiming;
}

function ensureAgenticMotion(item) {
    if (!item.agenticComposition || typeof item.agenticComposition !== 'object' || Array.isArray(item.agenticComposition)) {
        item.agenticComposition = {};
    }
    if (!item.agenticComposition.motion || typeof item.agenticComposition.motion !== 'object' || Array.isArray(item.agenticComposition.motion)) {
        item.agenticComposition.motion = {};
    }
    return item.agenticComposition.motion;
}

function setSpeed(item, speed) {
    const normalized = Number(clamp(speed, 0.55, 1.6).toFixed(3));
    ensureAgenticMotion(item).speed = normalized;
    item.animationSpeed = normalized;
    if (item.mgData && typeof item.mgData === 'object') item.mgData.animationSpeed = normalized;
    return normalized;
}

function setStagger(item, stagger) {
    const normalized = Number(clamp(stagger, 0.01, 0.18).toFixed(3));
    ensureAgenticMotion(item).stagger = normalized;
    return normalized;
}

function setDensity(item, density = 'compact') {
    if (!item.agenticComposition || typeof item.agenticComposition !== 'object' || Array.isArray(item.agenticComposition)) {
        item.agenticComposition = {};
    }
    item.agenticComposition.density = density;
    item.agenticComposition.style = {
        ...(item.agenticComposition.style || {}),
        density,
    };
    item.agenticComposition.constraints = {
        ...(item.agenticComposition.constraints || {}),
        readable: true,
        noOverlap: true,
        maxTextLines: Math.min(3, numeric(item.agenticComposition?.constraints?.maxTextLines, 3)),
    };
    item.layoutDensity = density;
    if (item.mgData && typeof item.mgData === 'object') {
        item.mgData.layoutDensity = density;
        item.mgData.agenticComposition = {
            ...(item.mgData.agenticComposition || {}),
            density,
            style: {
                ...(item.mgData.agenticComposition?.style || {}),
                density,
            },
            constraints: {
                ...(item.mgData.agenticComposition?.constraints || {}),
                readable: true,
                noOverlap: true,
                maxTextLines: Math.min(3, numeric(item.mgData.agenticComposition?.constraints?.maxTextLines, 3)),
            },
        };
    }
}

function setSafeZone(item, safeZone) {
    const normalized = SAFE_ZONES.has(token(safeZone)) ? token(safeZone) : 'bottom-left';
    if (!item.agenticComposition || typeof item.agenticComposition !== 'object' || Array.isArray(item.agenticComposition)) {
        item.agenticComposition = {};
    }
    item.agenticComposition.safeZone = normalized;
    item.safeZone = normalized;
    item.position = normalized;
    return normalized;
}

function simplifyMotion(item) {
    const motion = ensureAgenticMotion(item);
    motion.entrance = 'fade-slide';
    motion.emphasis = 'none';
    motion.exit = 'soft-out';
    motion.stagger = 0.04;
    motion.speed = 1;
    item.animation = 'fadeSlide';
    item.animationSpeed = 1;
    if (item.mgData && typeof item.mgData === 'object') {
        item.mgData.animation = 'fadeSlide';
        item.mgData.animationSpeed = 1;
    }
}

function forceContrastProtection(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    const before = {
        adaptiveContrast: item?.adaptiveContrast,
        contrastProtection: item?.contrastProtection,
        nestedAdaptiveContrast: nested?.adaptiveContrast,
        nestedContrastProtection: nested?.contrastProtection,
    };
    item.adaptiveContrast = true;
    item.contrastProtection = 'strong';
    item.readability = {
        ...(item.readability || {}),
        adaptiveContrast: true,
        contrastProtection: 'strong',
    };
    if (nested) {
        nested.adaptiveContrast = true;
        nested.contrastProtection = 'strong';
        nested.readability = {
            ...(nested.readability || {}),
            adaptiveContrast: true,
            contrastProtection: 'strong',
        };
    }
    return before;
}

function fallbackAuthoredComposition(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    const hadAuthored = Boolean(item?._authoredComposition || nested?._authoredComposition);
    for (const target of [item, nested]) {
        if (!target) continue;
        delete target._authoredComposition;
        delete target._authoredAssets;
        delete target._authoredNs;
        delete target._authoredRendered;
    }
    return hadAuthored;
}

function applySafeLayoutFallback(item, reason = 'Motion QA layout fallback') {
    if (!item || typeof item !== 'object') return false;
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    const normalizedReason = compactText(reason, 180);
    const alreadySafe = item.motionQaSafeLayout === true
        || item._motionQaSafeLayout === true
        || nested?.motionQaSafeLayout === true
        || nested?._motionQaSafeLayout === true;
    requireFixedRenderer(item, 'motion-qa-safe-layout');
    for (const target of [item, nested]) {
        if (!target) continue;
        target.motionQaSafeLayout = true;
        target.motionQaSafeLayoutReason = normalizedReason;
        target.adaptiveContrast = true;
        target.contrastProtection = 'strong';
    }
    setDensity(item, 'compact');
    simplifyMotion(item);
    return !alreadySafe;
}

function stableSceneIdentity(scene) {
    for (const value of [
        scene?.originalIndex,
        scene?.sourceSceneIndex,
        scene?.sceneIndex,
        scene?.index,
    ]) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
    }
    return null;
}

function visualSceneIdentity(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    for (const value of [
        item?.originalSceneIndex,
        item?.sourceSceneIndex,
        item?.targetSceneIndex,
        item?.sceneIndex,
        nested?.originalSceneIndex,
        nested?.sourceSceneIndex,
        nested?.targetSceneIndex,
        nested?.sceneIndex,
    ]) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
    }
    return null;
}

function findOwnerScene(plan, start, end, item = null) {
    const candidates = (plan?.scenes || [])
        .map((scene) => {
            const window = itemWindow(scene, 3);
            const overlap = Math.max(0, Math.min(end, window.end) - Math.max(start, window.start));
            return { scene, window, overlap };
        })
        .filter(candidate => candidate.overlap > 0.02);
    if (candidates.length === 0) return null;

    const identity = visualSceneIdentity(item);
    if (identity != null) {
        const exact = candidates.find(candidate => stableSceneIdentity(candidate.scene) === identity);
        if (exact) return exact.scene;
    }

    candidates.sort((a, b) => b.overlap - a.overlap || a.window.start - b.window.start);
    return candidates[0].scene;
}

function nextSceneBoundary(plan, start) {
    const starts = (plan?.scenes || [])
        .map(scene => itemWindow(scene, 3).start)
        .filter(sceneStart => sceneStart > start + 0.05)
        .sort((a, b) => a - b);
    return starts[0] ?? null;
}

function collectVisualRefs(plan) {
    const refs = [];
    for (const group of VISUAL_GROUPS) {
        const kind = group === 'motionGraphics' ? 'overlay' : (group === 'mgScenes' ? 'fullscreen' : 'template');
        const list = Array.isArray(plan?.[group]) ? plan[group] : [];
        list.forEach((item, index) => {
            if (!item || item.disabled) return;
            const window = itemWindow(item, kind === 'template' ? 4 : 3);
            const owner = findOwnerScene(plan, window.start, window.end, item);
            refs.push({
                group,
                index,
                kind,
                item,
                owner,
                rangeClip: renderRangeClip(item),
                ...window,
                safeZone: safeZoneOf(item, kind),
                type: token(item.type || item.mgType || item.templateType, 'graphic'),
            });
        });
    }
    return refs;
}

/**
 * motionBudget(ref) — how much time this visual needs.
 *
 * `speedOverride` asks the same question about a speed the item does NOT have
 * yet, so the pace-variety pass can check "would this still be readable if it
 * moved slower?" without writing the speed first and hoping it can undo it.
 * It is a parameter rather than a second copy of the arithmetic on purpose:
 * one formula, asked twice.
 */
function motionBudget(ref, speedOverride = null) {
    const speed = Number.isFinite(speedOverride)
        ? clamp(speedOverride, 0.25, 3)
        : currentSpeed(ref.item);
    const words = wordCount(ref.item);
    const items = listItemCount(ref.item);
    const stage = ref.kind !== 'overlay';
    const micro = !stage && MICRO_VISUAL_TYPES.has(ref.type);
    const entrance = (stage ? 0.56 : (micro ? 0.18 : 0.44)) / speed;
    const exit = (stage ? 0.34 : (micro ? 0.12 : 0.27)) / speed;
    const requestedStagger = numeric(ref.item?.agenticComposition?.motion?.stagger, 0.055);
    const staggerTail = items > 1 ? Math.min(0.9, requestedStagger * (items - 1) / speed) : 0;
    const readableHold = micro
        ? clamp(0.28 + words * 0.045 + items * 0.06, 0.32, 1.15)
        : clamp(
            (stage ? 1.45 : 0.95) + words * (stage ? 0.105 : 0.09) + items * (stage ? 0.22 : 0.13),
            stage ? 1.8 : 1.2,
            stage ? 6.2 : 4.2
        );
    const structural = entrance + Math.max(readableHold, staggerTail + (micro ? 0.2 : 0.7)) + exit;

    // The terms above price the MOTION — how long the thing takes to arrive,
    // settle, stagger and leave — and they approximate the reading part from a
    // word count. That approximation was the defect: per character its slope is
    // roughly a quarter of the real reading rate, so past a short headline it
    // stops tracking the text at all and behaves like a flat number. A 63-
    // character line came out needing 2.6s here while genuinely taking 4.3s to
    // read, so this stage extended nothing and the graphic shipped unreadable.
    //
    // So the motion estimate now sets a floor, not the answer: whichever of the
    // two is larger wins. Reading time can only ever push a hold longer, never
    // shorter, which is why nothing that fits today can regress.
    const reading = minimumReadableDuration(displayText(ref.item));

    return {
        speed,
        words,
        items,
        entrance,
        exit,
        staggerTail,
        readableHold,
        reading,
        required: Math.max(structural, reading),
    };
}

function laneFor(ref) {
    if (ref.kind !== 'overlay') return 'stage';
    return `overlay:${ref.safeZone}`;
}

function repairRecord(code, ref, before, after, reason) {
    return {
        code,
        target: `${ref.group}:${ref.index}`,
        group: ref.group,
        index: ref.index,
        type: ref.type,
        before,
        after,
        reason,
    };
}

function repairSemanticRedundancy(plan, findings = []) {
    const repairs = [];
    let refs = collectVisualRefs(plan);

    for (const ref of refs) {
        if (ref.rangeClip) continue;
        if (ref.kind === 'overlay') continue;
        const duplicateFact = authoredDuplicateNumericFact(ref.item);
        if (!duplicateFact || !fallbackAuthoredComposition(ref.item)) continue;
        repairs.push(repairRecord(
            'authored_semantic_duplicate_fallback',
            ref,
            { authored: true, repeatedFact: duplicateFact },
            { authored: false },
            'The authored composition repeated the same numeric fact in multiple visual roles, so Motion QA restored the clean deterministic renderer.'
        ));
    }

    refs = collectVisualRefs(plan);
    const stageRefs = refs.filter(ref => ref.kind !== 'overlay');
    const overlayRefs = refs.filter(ref => ref.kind === 'overlay');
    for (const stageRef of stageRefs) {
        const stageProfile = semanticProfile(stageRef.item);
        for (const overlayRef of overlayRefs) {
            if (overlayRef.item.disabled || !windowsAreRelated(stageRef, overlayRef)) continue;
            const overlayProfile = semanticProfile(overlayRef.item);
            if (!semanticProfilesMatch(stageProfile, overlayProfile)) continue;

            if (isManual(overlayRef.item, 'timing')) {
                findings.push({
                    severity: 'warn',
                    code: 'manual_semantic_duplicate',
                    target: `${overlayRef.group}:${overlayRef.index}`,
                    message: `${overlayRef.type} repeats the adjacent ${stageRef.type}, but Motion QA preserved the manually controlled overlay.`,
                });
                continue;
            }

            overlayRef.item.disabled = true;
            repairs.push(repairRecord(
                'semantic_duplicate_suppressed',
                overlayRef,
                { disabled: false },
                { disabled: true, preserved: `${stageRef.group}:${stageRef.index}` },
                'A stage visual and adjacent overlay communicated the same fact; the overlay was suppressed so the viewer sees one treatment.'
            ));
        }
    }

    return repairs;
}

/**
 * Fast plan-level QA. This runs during build and again before render. It does
 * not call AI or launch a browser.
 */
/* ---------------------------------------------------------------------------
 * Motion variety
 *
 * The render-time sameness linter says things like "6 of your 9 graphics enter
 * the same way" and "all 13 move at exactly one speed". By the time it can say
 * that, the plan is frozen — so for a long time those warnings were printed and
 * nothing acted on them.
 *
 * The reason the graphics matched was never that anything decided they should.
 * Almost nothing states an entrance, so almost everything falls through to the
 * same fallback, and a fallback repeated 9 times looks exactly like a house
 * style nobody chose. Same for speed: no one sets it, so it is 1, always.
 *
 * Two rules keep this honest:
 *
 *  1. Only rewrite what nobody chose. The bridge now reports WHERE each
 *     entrance and speed came from — the item itself, the theme's per-type
 *     table, or a fallback. A theme stating "quote cards pop" is an editorial
 *     voice; overruling it would be vandalism. Only 'default' is repaired.
 *
 *  2. Vary what the VIEWER sees, not the label. The renderer picks an entrance
 *     by substring, so `fadeSlide`, `staggerSlide`, `cascade`, `typewriter` and
 *     `wordCascade` all produce the identical rise. Rotating among those names
 *     would silence the linter and change nothing on screen — which is worse
 *     than the warning, because now the video looks the same AND nobody is
 *     told. Every candidate is classified through the linter's own
 *     entranceFamily() and a swap only counts when the family changes.
 *
 * The vocabulary is never a list maintained here. For templates it is whatever
 * the real resolver returns for that card type across the themes the app ships;
 * for motion graphics it is that type's own registry entry. So every substitute
 * is a name the renderer already ships for exactly that graphic — there is no
 * allow-list to drift.
 * ------------------------------------------------------------------------- */

let _varietyDeps;

/**
 * The bridge, the themes and the MG registry, loaded once and lazily.
 *
 * Lazy because Motion QA is imported by tooling that has no business paying for
 * the 5k-line bridge, and non-fatal because variety is an improvement, not a
 * gate: if any of this cannot load, the pass declines and the rest of Motion QA
 * is unaffected.
 */
function varietyDeps() {
    if (_varietyDeps !== undefined) return _varietyDeps;
    _varietyDeps = null;
    try {
        const bridge = require('../../render/hyperframes-bridge');
        if (typeof bridge?.resolveHyperframeVisual !== 'function') return _varietyDeps;
        const themes = require('../../data/themes');
        const mgRegistry = require('../../render/mg-registry');
        _varietyDeps = {
            resolveVisual: bridge.resolveHyperframeVisual,
            camelRegistryKey: typeof bridge.camelRegistryKey === 'function' ? bridge.camelRegistryKey : null,
            // Types with a dedicated renderer ignore the agentic entrance, so
            // this decides which of the two names the viewer actually gets.
            usesDedicatedRenderer: typeof bridge.typeUsesDedicatedRenderer === 'function'
                ? bridge.typeUsesDedicatedRenderer
                : () => true,
            themeIds: typeof themes?.getThemeIds === 'function' ? themes.getThemeIds() : [],
            registry: mgRegistry?.MG_REGISTRY || mgRegistry?.registry || {},
        };
    } catch (_) {
        _varietyDeps = null;
    }
    return _varietyDeps;
}

/** Test seam: forget the cached modules so a gate can simulate them missing. */
function _resetVarietyDeps() {
    _varietyDeps = undefined;
}

/**
 * What entrance will this graphic actually show, and did anyone choose it?
 *
 * Mirrors the renderer's own precedence: an agentic entrance outranks the
 * resolved one, but only for types that are not drawn by a dedicated renderer
 * and are not pinned to the fixed renderer. Authored compositions are excluded
 * upstream, so their branch never reaches here.
 */
function resolvedEntrance(ref, deps, plan) {
    let visual = null;
    try {
        visual = deps.resolveVisual(
            ref.item,
            ref.kind === 'template' ? 'template' : 'graphic',
            ref.type,
            plan || {}
        );
    } catch (_) {
        return null;
    }
    if (!visual) return null;

    const agentic = ref.item?.agenticComposition?.motion?.entrance
        || ref.item?.mgData?.agenticComposition?.motion?.entrance
        || '';
    const agenticOwns = Boolean(agentic)
        && !prefersFixedRenderer(ref.item)
        && !deps.usesDedicatedRenderer(ref.type);
    const animation = agenticOwns ? agentic : visual.animation;

    return {
        animation: String(animation || ''),
        family: entranceFamily(animation, { type: ref.type, kind: ref.kind }),
        // An agentic entrance is something the Motion Director stated, so it
        // counts as a choice exactly like an explicit one.
        source: agenticOwns ? 'explicit' : (visual.animationSource || 'default'),
        speedSource: visual.speedSource || 'default',
    };
}

/**
 * Every entrance name the renderer already ships for this exact graphic.
 *
 * Templates are probed through the real resolver once per theme, with no
 * animation stated, so the answers are precisely the names some theme already
 * uses for that card type. Motion graphics read their own registry category.
 * Neither is a list written down here, so neither can drift.
 */
function entranceVocabulary(ref, deps) {
    const names = new Set();
    if (ref.kind === 'template') {
        for (const themeId of deps.themeIds) {
            try {
                const probe = deps.resolveVisual({ themeId }, 'template', ref.type, {});
                if (probe?.animation) names.add(String(probe.animation));
            } catch (_) { /* a theme that cannot resolve simply contributes nothing */ }
        }
    } else if (deps.camelRegistryKey) {
        const entry = deps.registry?.[deps.camelRegistryKey(ref.type)];
        for (const name of (Array.isArray(entry?.animations) ? entry.animations : [])) {
            if (name) names.add(String(name));
        }
        for (const variant of Object.values(entry?.types || {})) {
            if (variant?.animation) names.add(String(variant.animation));
        }
    }
    return [...names];
}

/**
 * The linter's own sameness verdict, over any list of values.
 *
 * Every threshold and every measure is imported. If the linter's idea of "too
 * much of the same thing" changes, this changes with it, and the stage that
 * repairs monotony cannot start disagreeing with the stage that reports it.
 */
function samenessState(values) {
    const dist = distribution(values);
    const run = longestRun(values);
    const evenShare = dist.distinct ? dist.n / dist.distinct : dist.n;
    const singleValue = dist.n >= MIN_FOR_DOMINANCE && dist.distinct === 1;
    const dominance = evenShare > 0 ? dist.topCount / evenShare : 0;
    const dominant = dist.n >= MIN_FOR_DOMINANCE && !singleValue && dominance >= DOMINANCE_RATIO;
    const runIsNotable = run.length >= RUN_LIMIT
        && run.length > evenShare
        && !(singleValue && run.length === values.length);
    return {
        dist,
        run,
        evenShare,
        singleValue,
        dominant,
        runIsNotable,
        offending: singleValue || dominant || runIsNotable,
    };
}

/** Write a chosen entrance everywhere the renderer might read one. */
function setEntrance(item, animation) {
    item.animation = animation;
    item._motionQaEntrance = true;
    if (item.mgData && typeof item.mgData === 'object') {
        item.mgData.animation = animation;
        item.mgData._motionQaEntrance = true;
    }
    // `agenticComposition === false` is an explicit "do not compose this" and
    // creating the object here would quietly switch that renderer back on.
    if (item.agenticComposition !== false) {
        ensureAgenticMotion(item).entrance = token(animation, 'fade-slide');
    }
}

/**
 * Positions worth changing to break the offence, best first.
 *
 * For a run, the best cut is one past the limit: [A,A,A,A] repaired at index 2
 * becomes [A,A,B,A] and leaves no run of 3, while repairing index 0 only shifts
 * the run along. For a dominant value, any of its positions will do.
 */
function varietyTargets(state, families) {
    if (state.singleValue || state.dominant) {
        const targets = [];
        families.forEach((family, index) => {
            if (family === state.dist.top) targets.push(index);
        });
        return targets;
    }
    const { startIndex, length } = state.run;
    const preferred = [];
    for (let offset = RUN_LIMIT - 1; offset < length; offset++) preferred.push(startIndex + offset);
    for (let offset = RUN_LIMIT - 2; offset >= 0; offset--) preferred.push(startIndex + offset);
    return preferred;
}

/**
 * Give the video more than one way to bring a graphic on screen.
 *
 * Repairs the fewest graphics that clear the linter's own thresholds — it is
 * not trying to make every entrance different, only to stop one of them being
 * the whole video. A type with no second visible family (a card every theme
 * animates the same way) is reported, never faked.
 */
function applyMotionVariety(plan, refs, findings) {
    const repairs = [];
    const deps = varietyDeps();
    if (!deps) return repairs;

    const slots = [];
    const seenTypes = new Set();
    for (const ref of refs) {
        const motion = resolvedEntrance(ref, deps, plan);
        if (!motion) continue;
        const authored = Boolean(ref.item?._authoredComposition || ref.item?.mgData?._authoredComposition);

        // A theme says "quote cards pop" — a statement about the TYPE, made
        // once, with no knowledge of how many quote cards this particular video
        // contains. Nine of them arriving identically is not that statement
        // being honoured; it is an emergent property of the edit that the theme
        // was never asked about.
        //
        // So the theme's voice is protected exactly where it was spoken: the
        // FIRST time each type appears keeps the theme's answer, always. Only
        // the repeats may vary, and only within the vocabulary the app already
        // ships for that same card type. An entrance the item itself states is
        // never touched at any position.
        const firstOfType = !seenTypes.has(ref.type);
        seenTypes.add(ref.type);

        slots.push({
            ref,
            family: motion.family,
            // `_motionQaEntrance` marks this pass's own previous answer. That is
            // not a decision anyone made, so a rebuild is free to revisit it —
            // otherwise the first run would permanently freeze its own guess.
            eligible: !ref.rangeClip
                && !authored
                && !isManual(ref.item, 'motion')
                && (
                    motion.source === 'default'
                    || ref.item?._motionQaEntrance === true
                    || (motion.source === 'theme' && !firstOfType)
                ),
            vocabulary: null,
        });
    }
    if (slots.length < RUN_LIMIT) return repairs;

    const stuckTypes = new Set();
    let guard = slots.length * 2;
    while (guard-- > 0) {
        const families = slots.map(slot => slot.family);
        const state = samenessState(families);
        if (!state.offending) break;

        let repaired = false;
        for (const index of varietyTargets(state, families)) {
            const slot = slots[index];
            if (!slot || !slot.eligible) continue;
            if (slot.vocabulary === null) slot.vocabulary = entranceVocabulary(slot.ref, deps);

            // Only a name that lands in a DIFFERENT visible family counts. This
            // is the whole point: a swap the viewer cannot see is not a fix.
            const alternatives = slot.vocabulary
                .map(name => ({ name, family: entranceFamily(name, { type: slot.ref.type, kind: slot.ref.kind }) }))
                .filter(candidate => candidate.family !== slot.family);
            if (!alternatives.length) {
                stuckTypes.add(slot.ref.type);
                continue;
            }

            // Prefer the family the video uses least, so repeated repairs
            // spread out instead of all piling onto one alternative. Ties break
            // alphabetically so the same plan always produces the same video.
            const used = new Map();
            for (const family of families) used.set(family, (used.get(family) || 0) + 1);
            alternatives.sort((a, b) => (
                (used.get(a.family) || 0) - (used.get(b.family) || 0)
                || a.family.localeCompare(b.family)
                || a.name.localeCompare(b.name)
            ));
            const chosen = alternatives[0];

            setEntrance(slot.ref.item, chosen.name);
            repairs.push(repairRecord(
                'motion_entrance_varied',
                slot.ref,
                slot.family,
                chosen.family,
                `Nothing had chosen how this ${slot.ref.type} arrives, so it fell through to the same entrance as the rest of the video.`
            ));
            slot.family = chosen.family;
            slot.eligible = true;
            repaired = true;
            break;
        }
        if (!repaired) break;
    }

    if (stuckTypes.size) {
        findings.push({
            severity: 'warn',
            code: 'motion_variety_unavailable',
            message: `Every entrance available to ${[...stuckTypes].sort().join(', ')} looks the same on screen, so Motion QA could not vary it without changing nothing.`,
        });
    }
    return repairs;
}

/**
 * Give the video more than one tempo.
 *
 * Speed is only rewritten where nothing set it. The tempo is not invented: a
 * graphic carrying more reading than its window comfortably allows moves
 * briskly so its words land sooner, and a sparse one is allowed to take its
 * time. The scale is the video's OWN median and mean-absolute-deviation, so a
 * uniformly dense video is not forced into fake variety and a varied one is
 * spread across the speeds a viewer can actually tell apart.
 *
 * Nothing here may undo the readable-hold guarantee: a slower candidate is
 * measured against the item's real window and dropped if it no longer fits.
 */
function applyPaceVariety(plan, refs, findings) {
    const repairs = [];
    const deps = varietyDeps();
    if (!deps) return repairs;

    const slots = [];
    const speeds = [];
    for (const ref of refs) {
        const motion = resolvedEntrance(ref, deps, plan);
        if (!motion) continue;
        speeds.push(String(currentSpeed(ref.item)));
        const authored = Boolean(ref.item?._authoredComposition || ref.item?.mgData?._authoredComposition);
        if (ref.rangeClip || authored || isManual(ref.item, 'motion')) continue;
        if (motion.speedSource !== 'default' && ref.item?._motionQaSpeed !== true) continue;
        const window = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        if (!(window.duration > 0.05)) continue;
        slots.push({ ref, window, pressure: motionBudget(ref).reading / window.duration });
    }

    // Only act on what the linter would report. A video that already varies its
    // tempo does not need this stage inventing more.
    if (!samenessState(speeds).offending) return repairs;
    if (slots.length < MIN_FOR_DOMINANCE) return repairs;

    const sorted = slots.map(slot => slot.pressure).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const mad = sorted.reduce((sum, value) => sum + Math.abs(value - median), 0) / sorted.length;
    if (!(mad > 1e-3)) {
        findings.push({
            severity: 'warn',
            code: 'pace_variety_unavailable',
            message: 'Every graphic carries about the same reading load, so Motion QA had no basis to vary the tempo — the pace has to come from the plan.',
        });
        return repairs;
    }

    // One mean-absolute-deviation of reading pressure moves the speed by about
    // one perceptible step; snapMotionSpeed then lands it on a rung the viewer
    // can actually see rather than a number like 1.07.
    const scale = 0.3 / mad;
    for (const slot of slots) {
        const before = currentSpeed(slot.ref.item);
        const target = snapMotionSpeed(clamp(1 + (slot.pressure - median) * scale, 0.55, 1.6));
        if (Math.abs(target - before) < 0.01) continue;

        // Slower motion spends longer arriving and leaving, which eats the
        // readable hold. Ask the one budget model whether it still fits.
        if (target < before && motionBudget(slot.ref, target).required > slot.window.duration + 0.03) continue;

        const after = setSpeed(slot.ref.item, target);
        slot.ref.item._motionQaSpeed = true;
        if (slot.ref.item.mgData && typeof slot.ref.item.mgData === 'object') {
            slot.ref.item.mgData._motionQaSpeed = true;
        }
        repairs.push(repairRecord(
            'motion_pace_varied',
            slot.ref,
            before,
            after,
            target > before
                ? 'Nothing had set a tempo, and this graphic carries more reading than most, so its motion gets out of the way sooner.'
                : 'Nothing had set a tempo, and this graphic is lighter than most, so its motion is allowed to settle.'
        ));
    }
    return repairs;
}

// The sameness axes worth reporting before the render. `unreadable-in-time` is
// left out because Motion QA has already repaired it above and would otherwise
// report its own fixed problem; `opening-metronome` is left out because it
// measures spans that only exist once the composition has been generated.
const PREFLIGHT_SAMENESS_RULES = [
    'motion-vocabulary-split',
    'motion-monotony',
    'pace-monotony',
    'layout-monotony',
    'type-monotony',
    'metronome-timing',
    'metronome-spacing',
];

/**
 * What the video will look like to the sameness linter, described in its own
 * vocabulary — resolved entrance and speed, not the raw fields, because a
 * graphic that states nothing still arrives somehow.
 */
function varietySnapshot(plan, refs, deps) {
    return refs.map((ref) => {
        // An authored composition carries its motion inside its own timeline,
        // so its plan-side labels describe a renderer that never runs. Blanked
        // here for the same reason the linter blanks them: absence and
        // repetition are opposite failures and must not share a counter.
        const authored = Boolean(ref.item?._authoredComposition || ref.item?.mgData?._authoredComposition);
        const motion = authored ? null : resolvedEntrance(ref, deps, plan);
        const window = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        return {
            type: ref.type,
            kind: ref.kind,
            layout: String(
                ref.item?.agenticComposition?.layout
                || ref.item?.layout
                || ref.item?.mgData?.layout
                || ''
            ),
            animation: motion ? motion.animation : '',
            speed: authored ? '' : String(currentSpeed(ref.item)),
            startTime: window.start,
            duration: window.duration,
            text: displayText(ref.item),
        };
    });
}

/**
 * Report the sameness Motion QA chose not to repair.
 *
 * Everything above is deliberately conservative — it will not overrule a stated
 * entrance, will not invent a tempo the content does not justify, and will not
 * swap an animation the viewer cannot tell apart. Every one of those refusals
 * leaves real monotony in the video, and a refusal nobody is told about is
 * indistinguishable from a pass. So whatever survives the repairs is measured
 * with the linter's own rules and surfaced here, while the plan can still be
 * changed by hand or by the Motion Director.
 */
function reportRemainingSameness(plan, refs, findings, deps) {
    if (!deps || !refs.length) return null;
    let lint;
    try {
        lint = videoLint(varietySnapshot(plan, refs, deps), { only: PREFLIGHT_SAMENESS_RULES });
    } catch (_) {
        return null;
    }
    for (const finding of lint.findings || []) {
        findings.push({
            severity: 'warn',
            code: 'motion_sameness_remaining',
            rule: finding.id,
            message: `${finding.snippet} — ${finding.why}${finding.hint ? `. ${finding.hint}` : ''}`,
        });
    }
    return { counts: lint.counts, stats: lint.stats };
}

function prepareMotionPlan(plan, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const repairs = [];
    const findings = [];
    if (!plan || typeof plan !== 'object') {
        return { status: 'fail', findings: [{ severity: 'error', code: 'missing_plan', message: 'Motion QA requires a video plan.' }], repairs };
    }
    if (!enabled()) return { status: 'skipped', findings: [], repairs, skipped: true };

    const fps = Math.max(1, numeric(plan.fps, 30));
    const totalDuration = Math.max(0.1, numeric(plan.totalDuration, 0.1));
    repairs.push(...repairSemanticRedundancy(plan, findings));
    const refs = collectVisualRefs(plan);
    const lanes = new Map();
    for (const ref of refs) {
        const lane = laneFor(ref);
        if (!lanes.has(lane)) lanes.set(lane, []);
        lanes.get(lane).push(ref);
    }
    for (const laneRefs of lanes.values()) laneRefs.sort((a, b) => a.start - b.start || a.end - b.end);

    for (const ref of refs) {
        // An In/Out render may intentionally begin or end in the middle of a
        // valid visual. Its tiny visible slice is not a newly-authored graphic,
        // so never stretch it, accelerate it, or reject it for lacking a full
        // entrance/readable hold/exit cycle. The renderer resumes the original
        // visual timeline from rangeClip.sourceOffset.
        if (ref.rangeClip) continue;
        const budget = motionBudget(ref);
        const ownerWindow = ref.owner ? itemWindow(ref.owner, totalDuration) : null;
        const laneRefs = lanes.get(laneFor(ref)) || [];
        const laneIndex = laneRefs.indexOf(ref);
        const next = laneRefs[laneIndex + 1] || null;
        const laneLimit = next ? next.start - 0.08 : totalDuration;
        const boundary = nextSceneBoundary(plan, ref.start);
        const ownerLimit = ownerWindow
            ? ownerWindow.end
            : Math.min(ref.end, boundary ?? ref.end);
        const maxEnd = Math.max(ref.start + 0.05, Math.min(totalDuration, laneLimit, ownerLimit));

        if (!isManual(ref.item, 'motion') && (budget.speed < 0.55 || budget.speed > 1.6)) {
            const nextSpeed = setSpeed(ref.item, clamp(budget.speed, 0.65, 1.35));
            repairs.push(repairRecord(
                'motion_speed_clamped',
                ref,
                budget.speed,
                nextSpeed,
                'Animation speed was outside the reliable/readable range.'
            ));
        }

        let current = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        if (!isManual(ref.item, 'timing') && current.duration + 0.03 < budget.required) {
            // Round the target up to a whole frame before asking for it.
            // Downstream normalisation snaps timings onto the frame grid by
            // flooring, so a target that lands mid-frame comes back up to a
            // frame SHORT of what was asked — and at 30fps a graphic extended
            // to exactly its reading time was still arriving 0.03s under it and
            // being reported unreadable at render. A frame is not a duration
            // anyone perceives; missing the requirement is.
            const desiredEnd = Math.min(maxEnd, Math.ceil((current.start + budget.required) * fps) / fps);
            if (desiredEnd > current.end + 0.04) {
                const before = { startTime: current.start, endTime: current.end, duration: current.duration };
                setTiming(ref.item, current.start, desiredEnd, fps);
                current = itemWindow(ref.item, current.duration);
                repairs.push(repairRecord(
                    'readable_hold_extended',
                    ref,
                    before,
                    { startTime: current.start, endTime: current.end, duration: current.duration },
                    budget.reading >= budget.required
                        ? `Extended the visual: its text needs about ${budget.reading.toFixed(1)}s to read.`
                        : `Extended the visual so its ${budget.words} words/${budget.items} items have a readable hold.`
                ));
            }
        }

        current = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        const remainingDeficit = budget.required - current.duration;
        if (remainingDeficit > 0.12 && !isManual(ref.item, 'motion')) {
            const beforeSpeed = currentSpeed(ref.item);
            const ratio = clamp(budget.required / Math.max(current.duration, 0.4), 1, 1.35);
            const nextSpeed = setSpeed(ref.item, Math.max(beforeSpeed, ratio));
            if (Math.abs(nextSpeed - beforeSpeed) > 0.01) {
                repairs.push(repairRecord(
                    'motion_fitted_to_window',
                    ref,
                    beforeSpeed,
                    nextSpeed,
                    'The available scene window was too short, so entrance/exit motion was accelerated within a safe limit.'
                ));
            }
            if (budget.items > 2) {
                const availableForStagger = Math.max(0.08, current.duration - 1.15);
                const maxStagger = clamp(availableForStagger / Math.max(1, budget.items - 1), 0.02, 0.11);
                const beforeStagger = numeric(ref.item?.agenticComposition?.motion?.stagger, 0.055);
                if (beforeStagger > maxStagger + 0.005) {
                    const afterStagger = setStagger(ref.item, maxStagger);
                    repairs.push(repairRecord(
                        'stagger_fitted_to_window',
                        ref,
                        beforeStagger,
                        afterStagger,
                        'Stagger was consuming the readable hold.'
                    ));
                }
            }
            if (wordCount(ref.item) > (ref.kind === 'overlay' ? 24 : 42)) {
                setDensity(ref.item, 'compact');
                repairs.push(repairRecord(
                    'dense_motion_compacted',
                    ref,
                    'standard',
                    'compact',
                    'Dense text could not fit the available window safely.'
                ));
            }
        }

        current = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        const minimum = ref.kind === 'overlay'
            ? (MICRO_VISUAL_TYPES.has(ref.type) ? 0.5 : 0.9)
            : 1.25;
        if (current.duration < minimum - 0.01) {
            findings.push({
                severity: 'error',
                code: 'visual_window_too_short',
                target: `${ref.group}:${ref.index}`,
                message: `${ref.type} has only ${current.duration.toFixed(2)}s; it cannot show a reliable entrance, readable state and exit.`,
            });
        }
    }

    // Same-lane collisions are repaired after individual duration expansion.
    for (const [lane, laneRefs] of lanes.entries()) {
        for (let i = 0; i < laneRefs.length - 1; i++) {
            const currentRef = laneRefs[i];
            const nextRef = laneRefs[i + 1];
            if (currentRef.rangeClip || nextRef.rangeClip) continue;
            const current = itemWindow(currentRef.item, 3);
            const overlap = current.end - nextRef.start;
            if (overlap <= 0.08) continue;

            const collisionMinimum = currentRef.kind === 'overlay'
                ? (MICRO_VISUAL_TYPES.has(currentRef.type) ? 0.5 : 0.9)
                : 1.25;
            if (!isManual(currentRef.item, 'timing') && nextRef.start - current.start >= collisionMinimum) {
                const before = { startTime: current.start, endTime: current.end, duration: current.duration };
                const end = Math.max(current.start + 0.05, nextRef.start - 0.08);
                setTiming(currentRef.item, current.start, end, fps);
                const after = itemWindow(currentRef.item, 3);
                repairs.push(repairRecord(
                    'motion_collision_trimmed',
                    currentRef,
                    before,
                    { startTime: after.start, endTime: after.end, duration: after.duration },
                    `${lane} contained overlapping visuals.`
                ));
            } else if (
                currentRef.kind === 'overlay'
                && !isManual(nextRef.item, 'position')
                && safeZoneOf(currentRef.item, currentRef.kind) === safeZoneOf(nextRef.item, nextRef.kind)
            ) {
                const beforeZone = safeZoneOf(nextRef.item, nextRef.kind);
                const afterZone = setSafeZone(nextRef.item, MOVE_FALLBACK[beforeZone] || 'top-right');
                repairs.push(repairRecord(
                    'motion_collision_repositioned',
                    nextRef,
                    beforeZone,
                    afterZone,
                    'Two simultaneous overlays occupied the same safe zone.'
                ));
            } else {
                findings.push({
                    severity: 'warn',
                    code: 'manual_motion_overlap',
                    target: `${currentRef.group}:${currentRef.index}`,
                    message: `${lane} visuals overlap by ${overlap.toFixed(2)}s, but Motion QA preserved manual timing/position.`,
                });
            }
        }
    }

    // Variety runs last, on re-collected refs, because the timing and collision
    // repairs above have just changed the windows the pace decision reads from.
    // It also runs after them by design: fitting a graphic into its window is a
    // correctness repair and always wins; varying how it arrives is taste, and
    // taste must never take time away from readability.
    // Timeline order, exactly like the linter sorts its items — "three in a row"
    // is a statement about what the viewer sees one after another, and
    // collectVisualRefs returns graphics grouped by track instead.
    const varietyRefs = collectVisualRefs(plan)
        .filter(ref => !ref.rangeClip)
        .sort((a, b) => a.start - b.start || a.group.localeCompare(b.group) || a.index - b.index);
    repairs.push(...applyMotionVariety(plan, varietyRefs, findings));
    repairs.push(...applyPaceVariety(plan, varietyRefs, findings));
    const sameness = reportRemainingSameness(plan, varietyRefs, findings, varietyDeps());

    const hard = findings.filter((finding) => finding.severity === 'error').length;
    const status = hard ? 'fail' : (findings.length ? 'warn' : 'pass');
    if (repairs.length) log(`[Motion QA] Preflight repaired ${repairs.length} motion issue(s).`);
    const stillSame = findings.filter(finding => finding.code === 'motion_sameness_remaining').length;
    if (stillSame) log(`[Motion QA] ${stillSame} sameness warning(s) remain — see the plan, not the preflight.`);
    return {
        version: VERSION,
        status,
        checked: refs.length,
        findings,
        repairs,
        sameness,
    };
}

function resolveHyperframesCli(appRoot) {
    const local = path.join(appRoot || process.cwd(), 'node_modules', 'hyperframes', 'dist', 'cli.js');
    if (fs.existsSync(local)) return local;
    try { return require.resolve('hyperframes/dist/cli.js'); } catch (_) { return null; }
}

function resolveMotionQaNodeRuntime(explicitNodePath = '') {
    const configured = String(
        explicitNodePath
        || process.env.HF_MOTION_QA_NODE_PATH
        || process.env.HYPERFRAMES_NODE_PATH
        || ''
    ).trim();
    if (configured && fs.existsSync(configured)) {
        return { command: configured, env: {} };
    }

    // The desktop render entrypoint validates Node 22+ and passes its resolved
    // executable here. Keep Electron itself out of the diagnostic process tree:
    // it is a GUI runtime with Chromium/GPU services, not the CLI runtime.
    if (process.versions?.electron) {
        return { command: process.platform === 'win32' ? 'node.exe' : 'node', env: {} };
    }

    return { command: process.execPath, env: {} };
}

function parseJsonOutput(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { /* try bounded extraction */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
    }
    return null;
}

function runCli({
    cli,
    command,
    args = [],
    cwd,
    env = {},
    timeoutMs = 180_000,
    nodePath,
    onProcess,
    isCancelled,
}) {
    return new Promise((resolve) => {
        if (!cli) {
            resolve({ ok: false, unavailable: true, code: null, stdout: '', stderr: 'HyperFrames CLI missing', json: null });
            return;
        }
        const runtime = resolveMotionQaNodeRuntime(nodePath);
        const child = spawn(runtime.command, [cli, command, ...args], {
            cwd,
            shell: false,
            windowsHide: true,
            env: { ...process.env, ...runtime.env, FORCE_COLOR: '0', ...env },
        });
        if (typeof onProcess === 'function') onProcess(child, `motion-qa:${command}`);

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const append = (current, chunk) => (current + String(chunk || '')).slice(-16 * 1024 * 1024);
        child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch (_) { /* noop */ }
        }, timeoutMs);

        child.on('error', (error) => {
            clearTimeout(timer);
            if (typeof onProcess === 'function') onProcess(null, `motion-qa:${command}`, child);
            resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`, json: parseJsonOutput(stdout), timedOut });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (typeof onProcess === 'function') onProcess(null, `motion-qa:${command}`, child);
            resolve({
                ok: code === 0,
                cancelled: typeof isCancelled === 'function' && isCancelled(),
                code,
                stdout,
                stderr,
                json: parseJsonOutput(stdout),
                timedOut,
            });
        });
    });
}

function readJson(filePath, fallback = null) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

const PREVIEW_RUNTIME_PATTERN = /\/\*HF_PREVIEW_START\*\/[\s\S]*?\/\*HF_PREVIEW_END\*\//g;

function ensureRenderSafeProject(project) {
    const indexPath = project?.indexPath
        || (project?.projectDir ? path.join(project.projectDir, 'index.html') : '');
    if (!indexPath || !fs.existsSync(indexPath)) {
        return { changed: false, reason: 'generated-index-missing' };
    }
    const source = fs.readFileSync(indexPath, 'utf8');
    const cleaned = source.replace(PREVIEW_RUNTIME_PATTERN, '');
    if (cleaned === source) {
        return {
            changed: false,
            previewRuntimeRemoved: false,
            nondeterministicClockRemaining: /\bperformance\.now\s*\(/.test(cleaned),
        };
    }
    fs.writeFileSync(indexPath, cleaned, 'utf8');
    return {
        changed: true,
        previewRuntimeRemoved: true,
        nondeterministicClockRemaining: /\bperformance\.now\s*\(/.test(cleaned),
    };
}

function summarizeHyperframesFinding(finding, section) {
    const code = finding?.code || `${section}_finding`;
    return {
        severity: finding?.severity === 'error'
            ? 'error'
            : (finding?.severity === 'warning' && !INFORMATIONAL_HYPERFRAMES_CODES.has(code) ? 'warn' : 'info'),
        code,
        section,
        selector: finding?.selector || '',
        elementId: finding?.elementId || '',
        message: compactText(finding?.message || finding?.fixHint || 'HyperFrames diagnostic finding', 260),
    };
}

function collectCliFindings(diagnostics) {
    const findings = [];
    const lint = diagnostics?.lint?.json;
    for (const finding of lint?.findings || []) {
        if (finding?.severity === 'error' || finding?.severity === 'warning') {
            findings.push(summarizeHyperframesFinding(finding, 'lint'));
        }
    }

    const check = diagnostics?.check?.json;
    for (const section of ['runtime', 'layout', 'motion', 'contrast']) {
        for (const finding of check?.[section]?.findings || []) {
            if (finding?.severity === 'error' || finding?.severity === 'warning') {
                findings.push(summarizeHyperframesFinding(finding, section));
            }
        }
    }
    if (diagnostics?.lint?.unavailable || diagnostics?.check?.unavailable || diagnostics?.keyframes?.unavailable) {
        findings.push({
            severity: 'warn',
            code: 'hyperframes_diagnostics_unavailable',
            section: 'tooling',
            message: 'One or more bundled HyperFrames diagnostics were unavailable; render contract checks were reduced.',
        });
    }
    if (diagnostics?.lint && !diagnostics.lint.ok && !diagnostics.lint.json && !diagnostics.lint.unavailable) {
        findings.push({
            severity: 'error',
            code: 'hyperframes_lint_failed',
            section: 'lint',
            message: compactText(diagnostics.lint.stderr || diagnostics.lint.stdout || 'HyperFrames lint failed without a report.', 260),
        });
    }
    if (diagnostics?.check && !diagnostics.check.ok && !diagnostics.check.json && !diagnostics.check.unavailable) {
        findings.push({
            severity: 'warn',
            code: 'hyperframes_check_failed',
            section: 'check',
            message: compactText(diagnostics.check.stderr || diagnostics.check.stdout || 'HyperFrames runtime check failed without a report.', 260),
        });
    }
    if (diagnostics?.keyframes && !diagnostics.keyframes.ok && !diagnostics.keyframes.json && !diagnostics.keyframes.unavailable) {
        findings.push({
            severity: 'info',
            code: 'hyperframes_keyframes_unavailable',
            section: 'keyframes',
            message: compactText(diagnostics.keyframes.stderr || diagnostics.keyframes.stdout || 'HyperFrames keyframe extraction failed without a report.', 260),
        });
    }
    return findings;
}

function keyframeSummary(keyframesJson, manifest) {
    const compositions = Array.isArray(keyframesJson?.compositions) ? keyframesJson.compositions : [];
    const staticTweens = compositions.reduce((sum, comp) => sum + (Array.isArray(comp?.tweens) ? comp.tweens.length : 0), 0);
    const cssKeyframes = compositions.reduce((sum, comp) => sum + (Array.isArray(comp?.cssKeyframes) ? comp.cssKeyframes.length : 0), 0);
    const traces = compositions.reduce((sum, comp) => sum + (Array.isArray(comp?.traces) ? comp.traces.length : 0), 0);
    const manifestSubjects = (manifest?.graphics?.length || 0)
        + (manifest?.scenes?.length || 0)
        + (manifest?.transitions?.length || 0);
    return {
        staticTweens,
        cssKeyframes,
        traces,
        manifestSubjects,
        dynamicSubjectsCoveredByManifest: Math.max(0, manifestSubjects - staticTweens),
    };
}

function proofTimesFromManifest(manifest, limit = 4) {
    const candidates = [];
    for (const graphic of manifest?.graphics || []) {
        const start = numeric(graphic.start, 0);
        const duration = Math.max(0.1, numeric(graphic.duration, 0.1));
        const risk = (numeric(graphic.wordCount, 0) * 0.15)
            + (numeric(graphic.itemCount, 0) * 0.8)
            + (graphic.authored ? 2 : 0)
            + (duration < 2 ? 2 : 0);
        candidates.push({
            id: graphic.id,
            risk,
            times: [
                { time: start + Math.min(0.16, duration * 0.08), phase: 'entrance' },
                { time: start + duration * (graphic.authored ? 0.58 : 0.52), phase: 'hero' },
            ],
        });
    }
    candidates.sort((a, b) => b.risk - a.risk);
    const selected = [];
    for (const candidate of candidates.slice(0, 2)) {
        for (const point of candidate.times) selected.push({ ...point, id: candidate.id });
    }
    if (!selected.length) {
        for (const transition of (manifest?.transitions || []).slice(0, limit)) {
            const boundary = numeric(transition.boundary, numeric(transition.start, 0) + numeric(transition.duration, 0) / 2);
            selected.push({ id: transition.id, phase: 'transition', time: boundary });
        }
    }
    if (!selected.length && numeric(manifest?.duration, 0) > 0) {
        const duration = numeric(manifest.duration, 0);
        selected.push(
            { id: 'timeline', phase: 'opening', time: Math.min(0.25, duration * 0.05) },
            { id: 'timeline', phase: 'middle', time: duration * 0.5 },
            { id: 'timeline', phase: 'ending', time: Math.max(0, duration - 0.15) }
        );
    }
    const seen = new Set();
    return selected
        .map((entry) => ({ ...entry, time: Number(Math.max(0, entry.time).toFixed(3)) }))
        .filter((entry) => {
            const key = entry.time.toFixed(3);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, limit);
}

function listSnapshotFrameNames(outDir) {
    if (!fs.existsSync(outDir)) return [];
    const names = fs.readdirSync(outDir);
    const numberedFrames = names
        .filter((name) => /^frame-.*\.(png|jpe?g)$/i.test(name))
        .sort();
    if (numberedFrames.length) return numberedFrames;
    return names
        .filter((name) => /\.(png|jpe?g)$/i.test(name) && !/contact[-_ ]?sheet/i.test(name))
        .sort();
}

async function captureProofSnapshots({
    cli,
    projectDir,
    appRoot,
    manifest,
    proof: proofValue,
    browserPath,
    nodePath,
    cliEnv = {},
    onProcess,
    isCancelled,
}) {
    const proof = Array.isArray(proofValue) && proofValue.length
        ? proofValue.slice(0, 8).map((entry, index) => ({
            id: compactText(entry?.id || `proof-${index + 1}`, 120),
            phase: compactText(entry?.phase || 'proof', 80),
            time: Number(Math.max(0, numeric(entry?.time, 0)).toFixed(3)),
        }))
        : proofTimesFromManifest(manifest, 4);
    if (!proof.length) return { proof, files: [], result: null };
    const outDir = path.join(projectDir, 'motion-qa-snapshots');
    const resolvedProject = path.resolve(projectDir);
    const resolvedOut = path.resolve(outDir);
    if (resolvedOut !== resolvedProject && !resolvedOut.startsWith(`${resolvedProject}${path.sep}`)) {
        throw new Error(`Motion QA snapshot path escaped the generated project: ${resolvedOut}`);
    }
    try { fs.rmSync(resolvedOut, { recursive: true, force: true }); } catch (_) { /* noop */ }
    const result = await runCli({
        cli,
        command: 'snapshot',
        args: [
            projectDir,
            '--output', outDir,
            '--at', proof.map((entry) => entry.time).join(','),
            '--no-end',
            '--describe=false',
        ],
        cwd: appRoot,
        env: {
            ...cliEnv,
            ...(browserPath ? {
                HYPERFRAMES_BROWSER_PATH: browserPath,
                PRODUCER_HEADLESS_SHELL_PATH: browserPath,
            } : {}),
        },
        timeoutMs: 180_000,
        nodePath,
        onProcess,
        isCancelled,
    });
    const frameNames = listSnapshotFrameNames(outDir);
    const files = frameNames.map((name, index) => ({
        file: path.join(outDir, name),
        ...(proof[index] || { id: 'timeline', phase: 'proof', time: 0 }),
    }));
    return { proof, files, result };
}

function resolveBrowserExecutable(browserPath) {
    const candidates = [
        browserPath,
        process.env.HYPERFRAMES_BROWSER_PATH,
        process.env.PRODUCER_HEADLESS_SHELL_PATH,
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
    return candidates.find((candidate) => {
        try { return fs.existsSync(candidate); } catch (_) { return false; }
    }) || '';
}

function auditPhaseTimes(subject) {
    const start = numeric(subject?.start, 0);
    const duration = Math.max(0.1, numeric(subject?.duration, 0.1));
    const fractions = duration < 0.8 ? [0.5] : [0.2, 0.52, 0.82];
    return fractions.map((fraction) => ({
        phase: fraction < 0.3 ? 'entrance' : (fraction > 0.7 ? 'late' : 'hero'),
        fraction,
        time: Number((start + duration * fraction).toFixed(3)),
    }));
}

async function auditAdaptiveContrast({
    project,
    manifest,
    browserPath,
    isCancelled,
} = {}) {
    const subjects = (manifest?.graphics || []).filter((graphic) => graphic?.adaptiveContrast !== false);
    if (!subjects.length) {
        return {
            status: 'skipped',
            reason: 'no-adaptive-contrast-subjects',
            checked: 0,
            adjusted: 0,
            protected: 0,
            findings: [],
            graphics: [],
        };
    }
    const executablePath = resolveBrowserExecutable(browserPath);
    if (!executablePath || !project?.indexPath || !fs.existsSync(project.indexPath)) {
        return {
            status: 'skipped',
            reason: executablePath ? 'generated-index-missing' : 'browser-unavailable',
            checked: 0,
            adjusted: 0,
            protected: 0,
            findings: [],
            graphics: [],
        };
    }

    let puppeteer;
    try { puppeteer = require('puppeteer-core'); } catch (_) {
        return {
            status: 'skipped',
            reason: 'puppeteer-unavailable',
            checked: 0,
            adjusted: 0,
            protected: 0,
            findings: [],
            graphics: [],
        };
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath,
            headless: 'new',
            defaultViewport: { width: 1920, height: 1080 },
            args: [
                '--allow-file-access-from-files',
                '--disable-gpu-sandbox',
                '--no-sandbox',
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader',
                '--disable-gpu-compositing',
            ],
        });
        const page = await browser.newPage();
        await page.goto(`${pathToFileURL(project.indexPath).href}?motion-qa-contrast=1`, {
            waitUntil: 'load',
            timeout: 30_000,
        });
        await page.waitForFunction(() => (
            Boolean(
                window.__HF_ADAPTIVE_CONTRAST__
                && window.__timelines
                && window.__timelines['yta-hyperframes']
            )
        ), { timeout: 15_000 });

        const graphics = [];
        for (const subject of subjects) {
            if (typeof isCancelled === 'function' && isCancelled()) {
                const cancelled = new Error('Cancelled');
                cancelled.code = 'MOTION_QA_CANCELLED';
                throw cancelled;
            }
            const phases = [];
            for (const phase of auditPhaseTimes(subject)) {
                const result = await page.evaluate(async ({ id, time: requestedTime }) => {
                    const timeline = window.__timelines?.['yta-hyperframes'];
                    if (timeline && typeof timeline.time === 'function') {
                        timeline.time(requestedTime, false);
                    }
                    const seeks = [];
                    document.querySelectorAll('.hf-scene-wrap').forEach((scene) => {
                        const start = Number(
                            scene.dataset.start
                            || scene.dataset.hfSceneStart
                            || scene.dataset.hfStart
                            || 0
                        );
                        const duration = Math.max(0.033, Number(
                            scene.dataset.duration
                            || scene.dataset.hfSceneDuration
                            || scene.dataset.hfDuration
                            || 0
                        ));
                        if (requestedTime < start - 0.01 || requestedTime > start + duration + 0.01) return;
                        const mediaStart = Number(scene.dataset.mediaStart || 0);
                        scene.querySelectorAll('video').forEach((video) => {
                            const maximum = Number.isFinite(video.duration) && video.duration > 0
                                ? Math.max(0, video.duration - 0.04)
                                : Infinity;
                            const target = Math.max(0, Math.min(maximum, requestedTime - start + mediaStart));
                            if (Math.abs(Number(video.currentTime || 0) - target) < 0.04) return;
                            seeks.push(new Promise((resolve) => {
                                let settled = false;
                                const done = () => {
                                    if (settled) return;
                                    settled = true;
                                    video.removeEventListener('seeked', done);
                                    resolve();
                                };
                                video.addEventListener('seeked', done, { once: true });
                                try { video.currentTime = target; } catch (_) { done(); }
                                setTimeout(done, 350);
                            }));
                        });
                    });
                    if (seeks.length) await Promise.all(seeks);
                    if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();
                    const report = window.__HF_ADAPTIVE_CONTRAST__.update(requestedTime, true);
                    return report.graphics.find((graphic) => graphic.id === id) || null;
                }, { id: subject.id, time: phase.time });
                if (result) phases.push({ ...result, phase: phase.phase, fraction: phase.fraction });
            }
            if (!phases.length) continue;
            const worst = [...phases].sort((left, right) => (
                numeric(left.minRatio, Infinity) - numeric(right.minRatio, Infinity)
            ))[0];
            const finiteRatios = phases
                .map((phase) => numeric(phase.minRatio, Infinity))
                .filter(Number.isFinite);
            graphics.push({
                ...worst,
                id: subject.id,
                minRatio: finiteRatios.length ? Math.min(...finiteRatios) : null,
                adjustedNodes: Math.max(...phases.map((phase) => numeric(phase.adjustedNodes, 0))),
                protection: {
                    darkAlpha: Math.max(...phases.map((phase) => numeric(phase?.protection?.darkAlpha, 0))),
                    lightAlpha: Math.max(...phases.map((phase) => numeric(phase?.protection?.lightAlpha, 0))),
                },
                phases,
            });
        }

        const findings = graphics
            .filter((graphic) => (
                graphic.minRatio != null
                && graphic.minRatio < 4.5
            ))
            .map((graphic) => ({
                severity: 'error',
                code: 'adaptive_contrast_failed',
                section: 'contrast',
                selector: `#${graphic.id}`,
                elementId: graphic.id,
                message: `${graphic.id} remained at ${graphic.minRatio}:1 contrast during its ${graphic.phase || 'worst'} phase after adaptive protection.`,
                details: {
                    phase: graphic.phase || '',
                    time: graphic.time,
                    phases: graphic.phases || [],
                },
            }));
        const adjusted = graphics.reduce((sum, graphic) => sum + numeric(graphic.adjustedNodes, 0), 0);
        const protectedCount = graphics.filter((graphic) => (
            numeric(graphic?.protection?.darkAlpha, 0) > 0.02
            || numeric(graphic?.protection?.lightAlpha, 0) > 0.02
        )).length;
        return {
            status: findings.length ? 'fail' : 'pass',
            reason: '',
            checked: graphics.length,
            adjusted,
            protected: protectedCount,
            findings,
            graphics,
        };
    } catch (error) {
        if (error?.code === 'MOTION_QA_CANCELLED') throw error;
        return {
            status: 'skipped',
            reason: compactText(error.message, 220),
            checked: 0,
            adjusted: 0,
            protected: 0,
            findings: [],
            graphics: [],
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) { /* already closed */ }
        }
    }
}

async function auditGraphicLayout({
    project,
    manifest,
    browserPath,
    isCancelled,
} = {}) {
    const subjects = (manifest?.graphics || []).filter((graphic) => graphic?.id);
    if (!subjects.length) {
        return {
            status: 'skipped',
            reason: 'no-graphics',
            checked: 0,
            findings: [],
            graphics: [],
        };
    }
    const executablePath = resolveBrowserExecutable(browserPath);
    if (!executablePath || !project?.indexPath || !fs.existsSync(project.indexPath)) {
        return {
            status: 'skipped',
            reason: executablePath ? 'generated-index-missing' : 'browser-unavailable',
            checked: 0,
            findings: [],
            graphics: [],
        };
    }

    let puppeteer;
    try { puppeteer = require('puppeteer-core'); } catch (_) {
        return {
            status: 'skipped',
            reason: 'puppeteer-unavailable',
            checked: 0,
            findings: [],
            graphics: [],
        };
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath,
            headless: 'new',
            defaultViewport: { width: 1920, height: 1080 },
            args: [
                '--allow-file-access-from-files',
                '--disable-gpu-sandbox',
                '--no-sandbox',
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader',
                '--disable-gpu-compositing',
            ],
        });
        const page = await browser.newPage();
        await page.goto(`${pathToFileURL(project.indexPath).href}?motion-qa-layout=1`, {
            waitUntil: 'load',
            timeout: 30_000,
        });
        await page.waitForFunction(() => Boolean(
            window.__timelines
            && window.__timelines['yta-hyperframes']
        ), { timeout: 15_000 });

        const graphics = [];
        for (const subject of subjects) {
            if (typeof isCancelled === 'function' && isCancelled()) {
                const cancelled = new Error('Cancelled');
                cancelled.code = 'MOTION_QA_CANCELLED';
                throw cancelled;
            }
            const phases = [];
            for (const phase of auditPhaseTimes(subject)) {
                const result = await page.evaluate(({ id, time: requestedTime, phase: phaseName }) => {
                const timeline = window.__timelines?.['yta-hyperframes'];
                if (timeline && typeof timeline.time === 'function') {
                    timeline.time(requestedTime, false);
                }
                if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();

                const root = document.getElementById(id);
                const frame = document.getElementById('yta-hyperframes');
                if (!root || !frame) {
                    return {
                        id,
                        time: requestedTime,
                        phase: phaseName,
                        safeLayout: false,
                        issues: [{
                            code: 'layout_root_missing',
                            message: `${id} is missing from the generated composition.`,
                        }],
                    };
                }

                const rectValue = (rect) => ({
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height,
                });
                const visible = (node) => {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || 1) > 0.04
                        && rect.width > 1
                        && rect.height > 1;
                };
                const frameRect = frame.getBoundingClientRect();
                const issues = [];
                const seen = new Set();
                const addIssue = (code, node, message, details = {}) => {
                    const key = `${code}:${node?.className || node?.id || 'root'}:${message}`;
                    if (seen.has(key)) return;
                    seen.add(key);
                    issues.push({
                        code,
                        selector: node?.id ? `#${node.id}` : '',
                        className: typeof node?.className === 'string' ? node.className : '',
                        message,
                        ...details,
                    });
                };

                const probes = [...root.querySelectorAll('[data-hf-layout-probe]')]
                    .filter((node, index, list) => list.indexOf(node) === index && visible(node));
                for (const node of probes) {
                    const overflowX = Math.max(0, node.scrollWidth - node.clientWidth);
                    const overflowY = Math.max(0, node.scrollHeight - node.clientHeight);
                    const style = getComputedStyle(node);
                    const clipsOverflow = [style.overflowX, style.overflowY]
                        .some(value => ['hidden', 'clip', 'auto', 'scroll'].includes(value));
                    const strictProbe = node.dataset.hfLayoutStrict === '1';
                    if ((strictProbe || clipsOverflow) && (overflowX > 4 || overflowY > 4)) {
                        addIssue(
                            'layout_container_overflow',
                            node,
                            `${id} has ${Math.ceil(overflowX)}px horizontal and ${Math.ceil(overflowY)}px vertical content overflow.`,
                            { overflowX, overflowY, rect: rectValue(node.getBoundingClientRect()) }
                        );
                    }
                }

                const critical = [...root.querySelectorAll([
                    '[data-hf-layout-critical]',
                    '.hf-title',
                    '.hf-subtitle',
                    '.hf-agentic-title',
                    '.hf-agentic-subtitle',
                    '.hf-item',
                    '.hf-safe-layout-item',
                ].join(','))].filter(visible);
                for (const node of critical) {
                    const rect = node.getBoundingClientRect();
                    const tolerance = 4;
                    if (
                        rect.left < frameRect.left - tolerance
                        || rect.top < frameRect.top - tolerance
                        || rect.right > frameRect.right + tolerance
                        || rect.bottom > frameRect.bottom + tolerance
                    ) {
                        addIssue(
                            'layout_content_outside_frame',
                            node,
                            `${id} contains visible content outside the 1920x1080 composition frame.`,
                            { rect: rectValue(rect), frame: rectValue(frameRect) }
                        );
                    }
                    const style = getComputedStyle(node);
                    const clipsOverflow = [style.overflowX, style.overflowY]
                        .some(value => ['hidden', 'clip', 'auto', 'scroll'].includes(value));
                    if (
                        clipsOverflow
                        && (
                            node.scrollWidth > node.clientWidth + 3
                            || node.scrollHeight > node.clientHeight + 3
                        )
                    ) {
                        addIssue(
                            'layout_text_clipped',
                            node,
                            `${id} contains clipped or overflowing readable content.`,
                            {
                                scrollWidth: node.scrollWidth,
                                clientWidth: node.clientWidth,
                                scrollHeight: node.scrollHeight,
                                clientHeight: node.clientHeight,
                            }
                        );
                    }
                }

                const readable = [...root.querySelectorAll('*')].filter((node) => {
                    if (!visible(node) || node.closest('.hf-adaptive-protection')) return false;
                    return [...node.childNodes].some((child) => (
                        child.nodeType === Node.TEXT_NODE
                        && String(child.textContent || '').trim().length > 0
                    ));
                });
                for (const node of readable) {
                    const rect = node.getBoundingClientRect();
                    const tolerance = 4;
                    if (
                        rect.left < frameRect.left - tolerance
                        || rect.top < frameRect.top - tolerance
                        || rect.right > frameRect.right + tolerance
                        || rect.bottom > frameRect.bottom + tolerance
                    ) {
                        addIssue(
                            'layout_readable_text_outside_frame',
                            node,
                            `${id} places readable text outside the composition frame.`,
                            { rect: rectValue(rect), frame: rectValue(frameRect) }
                        );
                    }
                    const style = getComputedStyle(node);
                    const clipsOverflow = [style.overflowX, style.overflowY]
                        .some(value => ['hidden', 'clip', 'auto', 'scroll'].includes(value));
                    if (
                        clipsOverflow
                        && (
                            node.scrollWidth > node.clientWidth + 3
                            || node.scrollHeight > node.clientHeight + 3
                        )
                    ) {
                        addIssue(
                            'layout_readable_text_clipped',
                            node,
                            `${id} clips readable text inside its own layout box.`,
                            {
                                scrollWidth: node.scrollWidth,
                                clientWidth: node.clientWidth,
                                scrollHeight: node.scrollHeight,
                                clientHeight: node.clientHeight,
                            }
                        );
                    }
                }

                const rootRect = root.getBoundingClientRect();
                const stageNodes = [...root.querySelectorAll('.hf-agentic-stage, .hf-template-stage')]
                    .filter(visible);
                if (
                    rootRect.width >= frameRect.width * 0.8
                    && rootRect.height >= frameRect.height * 0.8
                ) {
                    for (const stage of stageNodes) {
                        const rect = stage.getBoundingClientRect();
                        const style = getComputedStyle(stage);
                        if (
                            rect.width < rootRect.width * 0.7
                            || rect.height < rootRect.height * 0.7
                            || style.position === 'static'
                            || style.position === 'relative'
                        ) {
                            addIssue(
                                'layout_stage_collapsed',
                                stage,
                                `${id} has a collapsed full-frame layout stage (${Math.round(rect.width)}×${Math.round(rect.height)}).`,
                                {
                                    position: style.position,
                                    rect: rectValue(rect),
                                    root: rectValue(rootRect),
                                }
                            );
                        }
                    }
                }

                if (readable.length) {
                    const readableRects = readable.map((node) => node.getBoundingClientRect());
                    const union = readableRects.reduce((acc, rect) => ({
                        left: Math.min(acc.left, rect.left),
                        top: Math.min(acc.top, rect.top),
                        right: Math.max(acc.right, rect.right),
                        bottom: Math.max(acc.bottom, rect.bottom),
                    }), {
                        left: Infinity,
                        top: Infinity,
                        right: -Infinity,
                        bottom: -Infinity,
                    });
                    union.width = union.right - union.left;
                    union.height = union.bottom - union.top;
                    const centerX = (union.left + union.right) / 2;
                    const centerY = (union.top + union.bottom) / 2;
                    const normalizedCenterX = (centerX - frameRect.left) / frameRect.width;
                    const normalizedCenterY = (centerY - frameRect.top) / frameRect.height;
                    const safeZone = String(root.dataset.hfSafeZone || '').toLowerCase();
                    if (
                        safeZone === 'center'
                        && (
                            normalizedCenterX < 0.2
                            || normalizedCenterX > 0.8
                            || normalizedCenterY < 0.22
                            || normalizedCenterY > 0.78
                        )
                    ) {
                        addIssue(
                            'layout_safe_zone_mismatch',
                            root,
                            `${id} declares a centered safe zone but its readable content is visibly off-center.`,
                            {
                                safeZone,
                                centerX: normalizedCenterX,
                                centerY: normalizedCenterY,
                                rect: rectValue(union),
                            }
                        );
                    }
                }

                const collisionNodes = [...root.querySelectorAll('[data-hf-layout-collision]')].filter(visible);
                for (let leftIndex = 0; leftIndex < collisionNodes.length; leftIndex++) {
                    const leftNode = collisionNodes[leftIndex];
                    const leftRect = leftNode.getBoundingClientRect();
                    for (let rightIndex = leftIndex + 1; rightIndex < collisionNodes.length; rightIndex++) {
                        const rightNode = collisionNodes[rightIndex];
                        if (leftNode.contains(rightNode) || rightNode.contains(leftNode)) continue;
                        const rightRect = rightNode.getBoundingClientRect();
                        const overlapWidth = Math.max(0, Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left));
                        const overlapHeight = Math.max(0, Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top));
                        const overlapArea = overlapWidth * overlapHeight;
                        const smallerArea = Math.max(1, Math.min(leftRect.width * leftRect.height, rightRect.width * rightRect.height));
                        if (overlapArea / smallerArea > 0.12 && overlapWidth > 8 && overlapHeight > 8) {
                            addIssue(
                                'layout_content_collision',
                                leftNode,
                                `${id} has overlapping readable layout regions.`,
                                { overlapRatio: overlapArea / smallerArea }
                            );
                        }
                    }
                }

                return {
                    id,
                    time: requestedTime,
                    phase: phaseName,
                    safeLayout: root.dataset.hfSafeLayout === '1',
                    rootRect: rectValue(root.getBoundingClientRect()),
                    issues,
                };
                }, { id: subject.id, time: phase.time, phase: phase.phase });
                phases.push({ ...result, fraction: phase.fraction });
            }
            const issues = [];
            const seenIssues = new Set();
            for (const phase of phases) {
                for (const issue of phase?.issues || []) {
                    const key = `${issue.code}:${issue.selector || issue.className || ''}:${issue.message}`;
                    if (seenIssues.has(key)) continue;
                    seenIssues.add(key);
                    issues.push({
                        ...issue,
                        phase: phase.phase,
                        time: phase.time,
                    });
                }
            }
            graphics.push({
                id: subject.id,
                safeLayout: phases.some((phase) => phase.safeLayout),
                rootRect: phases.find((phase) => phase.rootRect)?.rootRect || null,
                phases,
                issues,
            });
        }

        const findings = graphics.flatMap((graphic) => (
            (graphic?.issues || []).map((issue) => ({
                severity: 'error',
                code: issue.code,
                section: 'layout',
                selector: issue.selector || `#${graphic.id}`,
                elementId: graphic.id,
                message: issue.message,
                details: {
                    ...issue,
                    phase: issue.phase || '',
                    time: issue.time,
                },
            }))
        ));
        return {
            status: findings.length ? 'fail' : 'pass',
            reason: '',
            checked: graphics.length,
            findings,
            graphics,
        };
    } catch (error) {
        if (error?.code === 'MOTION_QA_CANCELLED') throw error;
        return {
            status: 'skipped',
            reason: compactText(error.message, 220),
            checked: 0,
            findings: [],
            graphics: [],
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) { /* already closed */ }
        }
    }
}

async function visionReviewSnapshots(snapshotFiles, manifest) {
    if (flagOff('HF_MOTION_QA_VISION') || !snapshotFiles.length) {
        return { status: 'skipped', repairs: [], reason: 'disabled-or-no-snapshots' };
    }
    let provider;
    try { provider = require('../../brain/ai-provider'); } catch (_) {
        return { status: 'skipped', repairs: [], reason: 'vision-provider-unavailable' };
    }
    if (!provider.isVisionAIAvailable()) {
        return { status: 'skipped', repairs: [], reason: 'vision-provider-unavailable' };
    }

    const frames = snapshotFiles.slice(0, 4).map((entry) => ({
        base64: fs.readFileSync(entry.file).toString('base64'),
        mimeType: path.extname(entry.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
        timestamp: entry.time,
    }));
    const labels = snapshotFiles.slice(0, 4).map((entry, index) => (
        `Frame ${index + 1}: ${entry.id} ${entry.phase} at ${Number(entry.time).toFixed(2)}s`
    )).join('\n');
    const subjects = (manifest?.graphics || []).map((graphic) => ({
        id: graphic.id,
        target: `${graphic.sourceGroup}:${graphic.sourceIndex}`,
        type: graphic.type,
        kind: graphic.kind,
        start: graphic.start,
        duration: graphic.duration,
        authored: graphic.authored,
        safeZone: graphic.safeZone,
        animation: graphic.animation,
        text: graphic.textPreview,
    }));
    const prompt = `You are the automatic Motion QA critic for a professional YouTube video editor.

The frames are deterministic proof frames from one HyperFrames composition:
${labels}

Animated subjects:
${JSON.stringify(subjects.slice(0, 20), null, 2)}

Judge ONLY clear production defects:
- important text or graphics outside the frame
- text collisions, unreadable density, or insufficient text-to-footage contrast
- an entrance that still hides the message at the hero frame
- motion that is distractingly fast/slow
- overlapping overlays occupying the same area
- any broken composition that should use the universal safe layout

Do not redesign good work. Do not change copy, facts, media, story, colors or theme.
Return strict JSON only:
{
  "verdict": "pass|repair",
  "repairs": [
    {
      "id": "exact subject id",
      "action": "speed-up|slow-down|simplify|compact|move|fallback-safe-layout|extend-hold|protect-contrast",
      "value": "optional safe zone or seconds",
      "reason": "short concrete defect"
    }
  ]
}
Maximum 3 repairs. If the evidence is ambiguous, return pass.`;

    try {
        const raw = await provider.callVideoAI(prompt, frames, { maxTokens: 450 });
        const { parseJsonObject } = require('../../brain/strict-json');
        const parsed = parseJsonObject(raw);
        const validIds = new Set((manifest?.graphics || []).map((graphic) => graphic.id));
        const validActions = new Set([
            'speed-up',
            'slow-down',
            'simplify',
            'compact',
            'move',
            'fallback-safe-layout',
            'fallback-authored',
            'extend-hold',
            'protect-contrast',
        ]);
        const repairs = (Array.isArray(parsed?.repairs) ? parsed.repairs : [])
            .filter((repair) => validIds.has(repair?.id) && validActions.has(repair?.action))
            .slice(0, 3)
            .map((repair) => ({
                id: repair.id,
                action: repair.action,
                value: repair.value,
                reason: compactText(repair.reason, 180),
            }));
        return {
            status: repairs.length ? 'repair' : 'pass',
            verdict: parsed?.verdict || (repairs.length ? 'repair' : 'pass'),
            repairs,
        };
    } catch (error) {
        return { status: 'skipped', repairs: [], reason: compactText(error.message, 180) };
    }
}

function sourceRefFromManifest(plan, manifestEntry) {
    const group = manifestEntry?.sourceGroup;
    const index = Number(manifestEntry?.sourceIndex);
    if (!VISUAL_GROUPS.includes(group) || !Number.isInteger(index)) return null;
    const item = plan?.[group]?.[index];
    if (!item) return null;
    const kind = group === 'motionGraphics' ? 'overlay' : (group === 'mgScenes' ? 'fullscreen' : 'template');
    const window = itemWindow(item, kind === 'template' ? 4 : 3);
    return {
        group,
        index,
        item,
        kind,
        type: token(item.type || item.mgType || item.templateType, 'graphic'),
        owner: findOwnerScene(plan, window.start, window.end, item),
        ...window,
    };
}

function applyManifestTimingRepairs(plan, manifest) {
    const repairs = [];
    const fps = Math.max(1, numeric(plan?.fps, 30));
    for (const entry of manifest?.graphics || []) {
        if (!entry?.timingClamped) continue;
        const ref = sourceRefFromManifest(plan, entry);
        if (!ref || isManual(ref.item, 'timing')) continue;
        if (entry?.rangeFragment || renderRangeClip(ref.item)) continue;
        const start = Math.max(0, numeric(entry.start, ref.start));
        const duration = Math.max(0.05, numeric(entry.duration, ref.duration));
        if (Math.abs(ref.start - start) < 0.01 && Math.abs(ref.duration - duration) < 0.01) continue;
        const before = { startTime: ref.start, endTime: ref.end, duration: ref.duration };
        setTiming(ref.item, start, start + duration, fps);
        repairs.push(repairRecord(
            'bridge_timing_persisted',
            ref,
            before,
            { startTime: start, endTime: start + duration, duration },
            'Persisted the bridge timing guard result so future builds start from the verified timing.'
        ));
    }
    return repairs;
}

function diagnosticEntryForFinding(manifest, finding) {
    const needle = `${finding?.selector || ''} ${finding?.elementId || ''} ${finding?.message || ''}`;
    return (manifest?.graphics || []).find((entry) => (
        [entry?.id, entry?.authoredNs, entry?.sourceClipId]
            .filter(Boolean)
            .some((identity) => needle.includes(identity))
    )) || null;
}

function applyDiagnosticRepairs(plan, manifest, findings) {
    const repairs = [];
    for (const finding of findings || []) {
        const message = `${finding.code || ''} ${finding.message || ''}`.toLowerCase();
        if (!/(overflow|outside|collision|overlap|invisible|opacity|unreadable|clipped|contrast|legib)/.test(message)) continue;
        const entry = diagnosticEntryForFinding(manifest, finding);
        const ref = sourceRefFromManifest(plan, entry);
        if (!entry || !ref) continue;

        const contrastIssue = finding?.section === 'contrast'
            || /(contrast|unreadable|legib)/.test(message);
        if (contrastIssue) {
            if (
                ref.item?.adaptiveContrast !== true
                || ref.item?.contrastProtection !== 'strong'
            ) {
                const before = forceContrastProtection(ref.item);
                repairs.push(repairRecord(
                    'contrast_protection_forced',
                    ref,
                    before,
                    {
                        adaptiveContrast: true,
                        contrastProtection: 'strong',
                    },
                    finding.message
                ));
                continue;
            }
            if (entry.authored && fallbackAuthoredComposition(ref.item)) {
                repairs.push(repairRecord(
                    'authored_contrast_fallback',
                    ref,
                    'authored-composition',
                    'adaptive-fixed-renderer',
                    'The authored composition still failed contrast after maximum adaptive protection.'
                ));
                continue;
            }
            const before = {
                authored: false,
                safeLayout: Boolean(ref.item?.motionQaSafeLayout || ref.item?.mgData?.motionQaSafeLayout),
                contrastProtection: 'strong',
            };
            if (applySafeLayoutFallback(ref.item, finding.message)) {
                repairs.push(repairRecord(
                    'contrast_safe_layout_fallback',
                    ref,
                    before,
                    { authored: false, safeLayout: true, contrastProtection: 'strong' },
                    finding.message
                ));
            }
            continue;
        }
        const layoutIssue = finding?.section === 'layout'
            || /(overflow|outside|collision|overlap|invisible|opacity|clipped)/.test(message);
        if (layoutIssue) {
            const before = {
                authored: Boolean(ref.item?._authoredComposition || ref.item?.mgData?._authoredComposition),
                safeLayout: Boolean(ref.item?.motionQaSafeLayout || ref.item?.mgData?.motionQaSafeLayout),
            };
            if (applySafeLayoutFallback(ref.item, finding.message)) {
                repairs.push(repairRecord(
                    'safe_layout_fallback',
                    ref,
                    before,
                    { authored: false, safeLayout: true, density: 'compact', motion: 'fade-slide' },
                    finding.message
                ));
            }
            continue;
        }
        if (entry.authored && fallbackAuthoredComposition(ref.item)) {
            repairs.push(repairRecord(
                'authored_motion_fallback',
                ref,
                'authored-composition',
                'agentic-fixed-renderer',
                finding.message
            ));
            continue;
        }
        if (!isManual(ref.item, 'motion')) {
            setDensity(ref.item, 'compact');
            simplifyMotion(ref.item);
            repairs.push(repairRecord(
                'motion_simplified_after_diagnostic',
                ref,
                'complex',
                'compact/fade-slide',
                finding.message
            ));
        }
    }
    return repairs;
}

function applyVisionRepairs(plan, manifest, vision) {
    const repairs = [];
    const fps = Math.max(1, numeric(plan?.fps, 30));
    const byId = new Map((manifest?.graphics || []).map((entry) => [entry.id, entry]));
    for (const proposed of vision?.repairs || []) {
        const entry = byId.get(proposed.id);
        const ref = sourceRefFromManifest(plan, entry);
        if (!entry || !ref) continue;
        const reason = proposed.reason || 'Vision Motion QA repair';
        const attempts = (
            ref.item._motionQaVisionAttempts
            && typeof ref.item._motionQaVisionAttempts === 'object'
            && !Array.isArray(ref.item._motionQaVisionAttempts)
        ) ? ref.item._motionQaVisionAttempts : {};
        ref.item._motionQaVisionAttempts = attempts;
        const attemptKey = token(proposed.action, 'repair');
        const priorAttempts = numeric(attempts[attemptKey], 0);
        const alreadySafe = ref.item.motionQaSafeLayout === true
            || ref.item._motionQaSafeLayout === true
            || ref.item?.mgData?.motionQaSafeLayout === true
            || ref.item?.mgData?._motionQaSafeLayout === true;
        if (alreadySafe && proposed.action !== 'move') continue;
        if (
            priorAttempts >= 1
            && proposed.action !== 'fallback-safe-layout'
            && proposed.action !== 'fallback-authored'
        ) {
            const before = {
                authored: Boolean(ref.item?._authoredComposition || ref.item?.mgData?._authoredComposition),
                safeLayout: false,
                repeatedAction: proposed.action,
            };
            if (applySafeLayoutFallback(ref.item, `Repeated vision defect after repair: ${reason}`)) {
                repairs.push(repairRecord(
                    'vision_repeated_defect_safe_fallback',
                    ref,
                    before,
                    { authored: false, safeLayout: true, density: 'compact', motion: 'fade-slide' },
                    reason
                ));
            }
            attempts[attemptKey] = priorAttempts + 1;
            continue;
        }
        attempts[attemptKey] = priorAttempts + 1;
        if (proposed.action === 'fallback-safe-layout' || proposed.action === 'fallback-authored') {
            const before = {
                authored: Boolean(ref.item?._authoredComposition || ref.item?.mgData?._authoredComposition),
                safeLayout: Boolean(ref.item?.motionQaSafeLayout || ref.item?.mgData?.motionQaSafeLayout),
            };
            if (applySafeLayoutFallback(ref.item, reason)) {
                repairs.push(repairRecord(
                    'vision_safe_layout_fallback',
                    ref,
                    before,
                    { authored: false, safeLayout: true, density: 'compact', motion: 'fade-slide' },
                    reason
                ));
            }
        } else if (proposed.action === 'simplify' && !isManual(ref.item, 'motion')) {
            simplifyMotion(ref.item);
            repairs.push(repairRecord('vision_motion_simplified', ref, 'complex', 'fade-slide', reason));
        } else if (proposed.action === 'compact' && !isManual(ref.item, 'motion')) {
            setDensity(ref.item, 'compact');
            repairs.push(repairRecord('vision_layout_compacted', ref, 'standard', 'compact', reason));
        } else if (proposed.action === 'speed-up' && !isManual(ref.item, 'motion')) {
            const before = currentSpeed(ref.item);
            const after = setSpeed(ref.item, before * 1.15);
            repairs.push(repairRecord('vision_motion_sped_up', ref, before, after, reason));
        } else if (proposed.action === 'slow-down' && !isManual(ref.item, 'motion')) {
            const before = currentSpeed(ref.item);
            const after = setSpeed(ref.item, before * 0.85);
            repairs.push(repairRecord('vision_motion_slowed_down', ref, before, after, reason));
        } else if (proposed.action === 'move' && !isManual(ref.item, 'position')) {
            const before = safeZoneOf(ref.item, ref.kind);
            const requested = SAFE_ZONES.has(token(proposed.value)) ? token(proposed.value) : (MOVE_FALLBACK[before] || 'bottom-left');
            const after = setSafeZone(ref.item, requested);
            repairs.push(repairRecord('vision_overlay_moved', ref, before, after, reason));
        } else if (proposed.action === 'extend-hold' && !isManual(ref.item, 'timing')) {
            const ownerWindow = ref.owner ? itemWindow(ref.owner, plan.totalDuration || ref.end) : null;
            const total = Math.max(ref.end, numeric(plan.totalDuration, ref.end));
            const requested = clamp(numeric(proposed.value, 0.8), 0.25, 2);
            const maxEnd = Math.min(total, ownerWindow ? ownerWindow.end : total);
            const nextEnd = Math.min(maxEnd, ref.end + requested);
            if (nextEnd > ref.end + 0.04) {
                setTiming(ref.item, ref.start, nextEnd, fps);
                repairs.push(repairRecord('vision_hold_extended', ref, ref.duration, nextEnd - ref.start, reason));
            }
        } else if (proposed.action === 'protect-contrast') {
            const before = forceContrastProtection(ref.item);
            repairs.push(repairRecord(
                'vision_contrast_protected',
                ref,
                before,
                {
                    adaptiveContrast: true,
                    contrastProtection: 'strong',
                },
                reason
            ));
        }
    }
    return repairs;
}

function commandSummary(result) {
    return {
        ok: Boolean(result?.ok),
        code: result?.code ?? null,
        unavailable: Boolean(result?.unavailable),
        timedOut: Boolean(result?.timedOut),
        error: result?.ok ? '' : compactText(result?.stderr || result?.stdout, 400),
    };
}

async function runDiagnostics({
    project,
    appRoot,
    quick,
    browserPath,
    nodePath,
    onProcess,
    isCancelled,
    runVision,
}) {
    const cli = resolveHyperframesCli(appRoot);
    // Hardware by default, with an explicit emergency opt-out (HF_MOTION_QA_BROWSER_GPU=0).
    // These diagnostics used to force software rasterization, which cost ~30s per render for
    // no benefit: the real render already drives the same CLI and the same browser build with
    // PRODUCER_BROWSER_GPU_MODE:'hardware' (main.js), so a machine that can render can run the
    // diagnostics on the GPU too. Measured across 7 runs: ~35% faster with byte-identical
    // diagnostic JSON — these checks read geometry and timing, which the rasterizer does not
    // change. Flip the flag off if a driver ever makes the audit browsers unstable.
    const diagnosticBrowserGpuMode = flagOff('HF_MOTION_QA_BROWSER_GPU') ? 'software' : 'hardware';
    const cliEnv = {
        PRODUCER_BROWSER_GPU_MODE: diagnosticBrowserGpuMode,
        ...(browserPath ? {
            HYPERFRAMES_BROWSER_PATH: browserPath,
            PRODUCER_HEADLESS_SHELL_PATH: browserPath,
        } : {}),
    };
    const lint = await runCli({
        cli,
        command: 'lint',
        args: [project.projectDir, '--json'],
        cwd: appRoot,
        env: cliEnv,
        timeoutMs: 90_000,
        nodePath,
        onProcess,
        isCancelled,
    });
    if (lint.cancelled) throw new Error('Cancelled');

    const keyframes = await runCli({
        cli,
        command: 'keyframes',
        args: [project.projectDir, '--json', '--runtime', 'all'],
        cwd: appRoot,
        env: cliEnv,
        timeoutMs: 120_000,
        nodePath,
        onProcess,
        isCancelled,
    });
    if (keyframes.cancelled) throw new Error('Cancelled');

    const contrastArgs = flagOff('HF_MOTION_QA_CONTRAST') ? ['--no-contrast'] : [];
    const check = await runCli({
        cli,
        command: 'check',
        args: [
            project.projectDir,
            '--json',
            '--samples', quick ? '3' : String(clamp(numeric(process.env.HF_MOTION_QA_SAMPLES, 5), 3, 9)),
            '--at-transitions',
            '--max-transition-samples', quick ? '8' : '24',
            ...contrastArgs,
        ],
        cwd: appRoot,
        env: cliEnv,
        timeoutMs: quick ? 120_000 : 240_000,
        nodePath,
        onProcess,
        isCancelled,
    });
    if (check.cancelled) throw new Error('Cancelled');

    const manifest = readJson(path.join(project.projectDir, 'hyperframes-motion-manifest.json'), {});
    const timingReport = readJson(path.join(project.projectDir, 'hyperframes-timing-report.json'), {});
    const visualReport = readJson(path.join(project.projectDir, 'hyperframes-visual-report.json'), {});
    const graphicLayout = await auditGraphicLayout({
        project,
        manifest,
        browserPath,
        isCancelled,
    });
    const adaptiveContrast = await auditAdaptiveContrast({
        project,
        manifest,
        browserPath,
        isCancelled,
    });
    let snapshots = { proof: [], files: [], result: null };
    let vision = { status: 'skipped', repairs: [], reason: quick ? 'quick-render' : 'disabled' };
    if (!quick && runVision) {
        snapshots = await captureProofSnapshots({
            cli,
            projectDir: project.projectDir,
            appRoot,
            manifest,
            browserPath,
            nodePath,
            cliEnv,
            onProcess,
            isCancelled,
        });
        if (snapshots.result?.cancelled) throw new Error('Cancelled');
        vision = await visionReviewSnapshots(snapshots.files, manifest);
    }
    const findings = collectCliFindings({ lint, keyframes, check });
    findings.push(...(graphicLayout.findings || []));
    findings.push(...(adaptiveContrast.findings || []));
    if (snapshots.result && !snapshots.result.ok && !snapshots.files.length) {
        findings.push({
            severity: 'warn',
            code: 'motion_proof_snapshot_failed',
            section: 'snapshot',
            message: compactText(
                snapshots.result.stderr || snapshots.result.stdout || 'HyperFrames proof-frame capture failed.',
                260
            ),
        });
    }
    for (const issue of visualReport?.unsupported || []) {
        findings.push({
            severity: 'error',
            code: 'unsupported_visual_type',
            section: 'bridge',
            message: `Unsupported HyperFrames visual type: ${issue.type || 'unknown'}.`,
        });
    }
    for (const issue of visualReport?.missingMapAssets || []) {
        findings.push({
            severity: 'warn',
            code: 'missing_map_asset',
            section: 'bridge',
            message: `Map scene ${issue.sceneIndex ?? '?'} is missing its preferred map asset; fallback rendering is active.`,
        });
    }
    for (const issue of visualReport?.missingTemplateMedia || []) {
        findings.push({
            severity: 'warn',
            code: 'missing_template_media',
            section: 'bridge',
            message: `${issue.type || 'Template'} is missing preferred media; designed fallback rendering is active.`,
        });
    }
    return {
        raw: { lint, keyframes, check, graphicLayout, adaptiveContrast },
        manifest,
        timingReport,
        visualReport,
        snapshots,
        vision,
        findings,
        summary: {
            lint: commandSummary(lint),
            keyframes: commandSummary(keyframes),
            check: commandSummary(check),
            keyframeCoverage: keyframeSummary(keyframes.json, manifest),
            bridge: {
                timingClamped: Array.isArray(timingReport?.clamped) ? timingReport.clamped.length : 0,
                unsupported: Array.isArray(visualReport?.unsupported) ? visualReport.unsupported.length : 0,
                missingMapAssets: Array.isArray(visualReport?.missingMapAssets) ? visualReport.missingMapAssets.length : 0,
                missingTemplateMedia: Array.isArray(visualReport?.missingTemplateMedia) ? visualReport.missingTemplateMedia.length : 0,
                fallbacks: Array.isArray(visualReport?.fallbacks) ? visualReport.fallbacks.length : 0,
            },
            graphicLayout: {
                status: graphicLayout.status,
                reason: graphicLayout.reason || '',
                checked: graphicLayout.checked || 0,
                failed: (graphicLayout.findings || []).length,
                safeFallbacks: (graphicLayout.graphics || []).filter((graphic) => graphic?.safeLayout).length,
            },
            adaptiveContrast: {
                status: adaptiveContrast.status,
                reason: adaptiveContrast.reason || '',
                checked: adaptiveContrast.checked || 0,
                adjusted: adaptiveContrast.adjusted || 0,
                protected: adaptiveContrast.protected || 0,
            },
            proofFrames: snapshots.files.map((entry) => ({
                file: path.relative(project.projectDir, entry.file),
                id: entry.id,
                phase: entry.phase,
                time: entry.time,
            })),
            vision: {
                status: vision.status,
                reason: vision.reason || '',
                proposedRepairs: vision.repairs || [],
            },
        },
    };
}

function rollupStatus(findings) {
    if ((findings || []).some((finding) => finding.severity === 'error')) return 'fail';
    if ((findings || []).some((finding) => finding.severity === 'warn')) return 'warn';
    return 'pass';
}

function writeMotionQaReport(report, directories) {
    for (const directory of directories.filter(Boolean)) {
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'motion-qa-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        } catch (_) { /* reporting must never destroy an otherwise valid render */ }
    }
}

function motionQaPassPolicy(quick) {
    const initialPasses = quick
        ? 2
        : clamp(numeric(process.env.HF_MOTION_QA_PASSES, 3), 2, 3);
    const configuredHardCap = quick
        ? numeric(process.env.HF_MOTION_QA_QUICK_MAX_PASSES, 4)
        : numeric(process.env.HF_MOTION_QA_MAX_PASSES, Math.max(4, initialPasses + 1));
    return {
        initialPasses,
        hardPassCap: clamp(configuredHardCap, initialPasses, 5),
    };
}

/**
 * Full bounded repair loop. generateProject(plan, pass) must return the normal
 * HyperFrames project descriptor.
 */
async function runMotionQa({
    plan,
    generateProject,
    appRoot,
    reportDir,
    browserPath,
    nodePath,
    quick = false,
    log = console.log,
    onProgress,
    onProcess,
    isCancelled,
    diagnosticsRunner = runDiagnostics,
} = {}) {
    if (typeof generateProject !== 'function') throw new Error('Motion QA requires a HyperFrames project generator callback');
    const logFn = typeof log === 'function' ? log : () => {};
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const startedAt = new Date().toISOString();

    if (!enabled()) {
        const project = await generateProject(plan, 1);
        ensureRenderSafeProject(project);
        const report = {
            version: VERSION,
            status: 'skipped',
            agentic: true,
            reason: 'HF_MOTION_QA=0',
            generatedAt: startedAt,
            repairCount: 0,
            passes: [],
        };
        plan.motionQa = { version: VERSION, status: 'skipped', repairCount: 0 };
        writeMotionQaReport(report, [reportDir, project?.projectDir]);
        return { project, report, changed: false, hardFail: false };
    }

    progress(10, '[Motion QA] Inspecting animation timing and readability...');
    let preflight = prepareMotionPlan(plan, { log: logFn });
    const allRepairs = [...preflight.repairs];
    const passes = [];
    const passPolicy = motionQaPassPolicy(quick);
    let passLimit = passPolicy.initialPasses;
    let project = null;
    let finalFindings = [...preflight.findings];

    for (let pass = 1; pass <= passLimit; pass++) {
        if (typeof isCancelled === 'function' && isCancelled()) throw new Error('Cancelled');
        progress(pass === 1 ? 12 : 15, pass === 1
            ? '[Motion QA] Generating proof composition...'
            : '[Motion QA] Regenerating after automatic repairs...');
        project = await generateProject(plan, pass);
        const renderSafety = ensureRenderSafeProject(project);
        if (renderSafety.previewRuntimeRemoved) {
            logFn('[Motion QA] Removed the live-preview clock before deterministic render validation.');
        }
        progress(pass === 1 ? 14 : 16, `[Motion QA] HyperFrames verification pass ${pass}/${passLimit}...`);

        const diagnostics = await diagnosticsRunner({
            project,
            appRoot,
            quick,
            browserPath,
            nodePath,
            onProcess,
            isCancelled,
            runVision: !quick && pass < passLimit,
        });
        const passFindings = [...diagnostics.findings];
        if (pass >= passPolicy.hardPassCap && (diagnostics.vision?.repairs || []).length > 0) {
            for (const proposed of diagnostics.vision.repairs) {
                passFindings.push({
                    severity: 'error',
                    code: 'motion_qa_unresolved_visual_defect',
                    section: 'vision',
                    elementId: proposed.id,
                    selector: `#${proposed.id}`,
                    message: proposed.reason || `${proposed.id} still requires ${proposed.action} after the final verification pass.`,
                });
            }
        }
        finalFindings = [...preflight.findings, ...passFindings];
        const passReport = {
            pass,
            projectDir: project.projectDir,
            findings: passFindings,
            diagnostics: diagnostics.summary,
            repairs: [],
        };

        if (pass < passPolicy.hardPassCap) {
            const repairs = [
                ...applyManifestTimingRepairs(plan, diagnostics.manifest),
                ...applyDiagnosticRepairs(plan, diagnostics.manifest, diagnostics.findings),
                ...applyVisionRepairs(plan, diagnostics.manifest, diagnostics.vision),
            ];
            if (repairs.length) {
                // Re-run the semantic guard after pixel/vision changes so a
                // fallback or speed/layout repair cannot introduce a fresh
                // short hold or same-zone collision.
                const followupPreflight = prepareMotionPlan(plan, { log: logFn });
                repairs.push(...(followupPreflight.repairs || []));
                preflight = followupPreflight;
            }
            const unique = [];
            const seen = new Set();
            for (const repair of repairs) {
                const key = `${repair.code}:${repair.target}:${JSON.stringify(repair.after)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(repair);
            }
            passReport.repairs = unique;
            allRepairs.push(...unique);
            passes.push(passReport);
            if (!unique.length) break;
            if (pass >= passLimit) {
                passLimit = Math.min(passPolicy.hardPassCap, pass + 1);
                logFn(
                    `[Motion QA] Pass ${pass} uncovered a new repairable issue; `
                    + `extending verification to pass ${passLimit}/${passPolicy.hardPassCap}.`
                );
            }
            logFn(`[Motion QA] Pass ${pass} repaired ${unique.length} issue(s); verifying again.`);
            progress(15, `[Motion QA] Repaired ${unique.length} issue(s); verifying the corrected motion...`);
            continue;
        }
        passes.push(passReport);
    }

    const status = rollupStatus(finalFindings);
    const strict = !flagOff('HF_MOTION_QA_STRICT');
    const hardFail = status === 'fail' && strict;
    const report = {
        version: VERSION,
        status,
        agentic: true,
        strict,
        quick,
        generatedAt: startedAt,
        completedAt: new Date().toISOString(),
        checkedVisuals: preflight.checked || 0,
        repairCount: allRepairs.length,
        repairs: allRepairs,
        findings: finalFindings,
        passes,
    };
    plan.motionQa = {
        version: VERSION,
        status,
        agentic: true,
        strict,
        repairCount: allRepairs.length,
        findingCount: finalFindings.length,
        generatedAt: report.completedAt,
    };
    writeMotionQaReport(report, [reportDir, project?.projectDir]);
    const icon = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
    logFn(`[Motion QA] ${icon}: ${preflight.checked || 0} visual(s), ${allRepairs.length} repair(s), ${finalFindings.length} finding(s).`);
    return {
        project,
        report,
        changed: allRepairs.length > 0,
        hardFail,
    };
}

module.exports = {
    VERSION,
    auditAdaptiveContrast,
    auditGraphicLayout,
    applyDiagnosticRepairs,
    applyManifestTimingRepairs,
    applyMotionVariety,
    applyPaceVariety,
    applySafeLayoutFallback,
    applyVisionRepairs,
    captureProofSnapshots,
    collectVisualRefs,
    entranceVocabulary,
    motionBudget,
    resolvedEntrance,
    samenessState,
    varietyDeps,
    _resetVarietyDeps,
    ensureRenderSafeProject,
    listSnapshotFrameNames,
    prepareMotionPlan,
    proofTimesFromManifest,
    resolveHyperframesCli,
    resolveMotionQaNodeRuntime,
    runMotionQa,
    motionQaPassPolicy,
};
