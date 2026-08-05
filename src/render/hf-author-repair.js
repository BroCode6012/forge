/**
 * hf-author-repair.js — deterministic rescue for mechanically-broken authored
 * compositions.
 *
 * WHY THIS EXISTS
 *
 * The composition author gets exactly two attempts. Round one is authored,
 * round two is a repair prompt, and if the second output is still rejected the
 * whole bespoke design is discarded and a hardcoded built-in card is rendered
 * in its place — the generic look this entire effort exists to kill.
 *
 * The 2026-08-04 build lost 12 of 18 graphics that way, and the causes were
 * almost all trivial: a timeline ending 0.16s after its scene, a 3px accent
 * border down the left edge of a card, a line-height of 0.7. Each of those is a
 * single unambiguous edit, and each of them cost an entire design.
 *
 * So: fix them in code. This module owns the edits that have exactly one
 * correct answer. Everything with a judgement call in it — two text blocks
 * overlapping, nothing animating in, a number that isn't in the brief — is
 * deliberately NOT here. Those are the author's to solve, and quietly papering
 * over them would ship a worse composition while reporting success.
 *
 * THE SAFETY CONTRACT
 *
 * Every repair is verified against the live rule that rejected it, and reverted
 * if it did not clear it. The caller re-validates the whole composition
 * afterwards and drops the result on any failure. A repair can therefore only
 * ever move a composition from rejected to accepted — never the reverse, and
 * never to a state the linters have not seen. That is what makes it safe to run
 * this before spending an AI round rather than after.
 *
 * Every threshold is imported from the checker that enforces it. Nothing here
 * restates a number.
 */
'use strict';

const { slopLint, VIDEO, FX_EXEMPT_PREFIXES, OVERUSED_FONTS, lenPx } = require('./hf-slop-lint');

let getThemeTokens = () => ({});
try { ({ getThemeTokens } = require('../data/themes')); } catch (_) { /* tokens optional */ }

let authorSafeStack = (s, fallback) => s || fallback;
let SAFE_HEADING_STACK = '"Work Sans", sans-serif';
let SAFE_BODY_STACK = '"Source Sans Pro", sans-serif';
try {
    ({ authorSafeStack, SAFE_HEADING_STACK, SAFE_BODY_STACK } = require('./hf-design-doc'));
} catch (_) { /* optional */ }

/**
 * How far a timeline may be sped up to fit its scene.
 *
 * A few percent over is the author's arithmetic being slightly out, and
 * compressing that away is honest — the choreography is unchanged, it just
 * lands on time. A quarter over is a different thing: it means the composition
 * was designed for a longer beat than it was given, and silently playing the
 * whole thing 25% faster would hide a misunderstanding rather than fix one.
 * Past this floor the AI repair round gets it, which is the right owner.
 */
const MIN_TIMELINE_SCALE = 0.78;

// ───────────────────────────────────────────────────────────────────────────
// CSS surgery primitives
//
// Comment blanking is length-preserving (comments become spaces, newlines are
// kept), so every offset computed on the blanked copy is valid in the original
// text. That is what lets a declaration be cut out without disturbing anything
// around it, comments included.
// ───────────────────────────────────────────────────────────────────────────

function _blank(css) {
    return String(css || '').replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

function _isFx(selector) {
    const s = String(selector || '');
    return FX_EXEMPT_PREFIXES.some(p => s.includes(p));
}

/** Flat list of style blocks with offsets into the ORIGINAL css. */
function _walkBlocks(css) {
    const src = _blank(css);
    const out = [];
    let selStart = 0;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === '}') { selStart = i + 1; continue; }
        if (ch !== '{') continue;
        const selector = src.slice(selStart, i).trim();
        let depth = 1;
        let j = i + 1;
        while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
        }
        const bodyEnd = depth === 0 ? j - 1 : src.length;
        // @media/@supports bodies hold blocks, not declarations. Leave the
        // cursor inside so the scan finds the real blocks within.
        if (/^@(media|supports|layer|container|scope)\b/i.test(selector)) { selStart = i + 1; continue; }
        // @keyframes bodies hold percentage blocks — same treatment.
        if (/^@keyframes\b/i.test(selector)) { i = j - 1; selStart = j; continue; }
        out.push({ selector, bodyStart: i + 1, bodyEnd });
        i = j - 1;
        selStart = j;
    }
    return out;
}

/** Declarations of one block, with offsets into the ORIGINAL css. */
function _declsOf(css, block) {
    const body = _blank(css).slice(block.bodyStart, block.bodyEnd);
    const out = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i <= body.length; i++) {
        const ch = body[i];
        if (quote) { if (ch === quote && body[i - 1] !== '\\') quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (i === body.length || (ch === ';' && depth === 0)) {
            const raw = body.slice(start, i);
            const colon = raw.indexOf(':');
            if (colon > 0 && raw.trim()) {
                out.push({
                    prop: raw.slice(0, colon).trim().toLowerCase(),
                    value: raw.slice(colon + 1).trim(),
                    // cut span includes the terminating semicolon so removing a
                    // declaration never leaves a stray one behind
                    start: block.bodyStart + start,
                    end: block.bodyStart + i + (ch === ';' ? 1 : 0),
                    valueStart: block.bodyStart + start + colon + 1,
                    valueEnd: block.bodyStart + i,
                });
            }
            start = i + 1;
        }
    }
    return out;
}

/** Apply {start,end,text} edits to a string. Refuses on any overlap. */
function _applyEdits(src, edits) {
    if (!edits.length) return src;
    const sorted = edits.slice().sort((a, b) => b.start - a.start);
    let out = src;
    let prevStart = Infinity;
    for (const e of sorted) {
        if (e.end > prevStart) return null; // overlapping edits — refuse rather than corrupt
        out = out.slice(0, e.start) + (e.text || '') + out.slice(e.end);
        prevStart = e.start;
    }
    return out;
}

/** Leading length of a value like "3px solid var(--x)" or "clamp(2px,...)". */
function _leadingLen(value) {
    const m = String(value || '').match(/(-?[\d.]+)\s*(px|rem|em|pt|vw|vh)?/);
    if (!m) return NaN;
    return lenPx(`${m[1]}${m[2] || 'px'}`, 100);
}

/** Largest stop of a font-size value — what a 1920-wide canvas actually renders. */
function _fontSizePx(value) {
    const stops = (String(value || '').match(/[\d.]+\s*(?:px|rem|em|vw|vh|pt)/g) || [])
        .map(t => lenPx(t, 100))
        .filter(Number.isFinite);
    return stops.length ? Math.max(...stops) : NaN;
}

// ───────────────────────────────────────────────────────────────────────────
// The repairs
// ───────────────────────────────────────────────────────────────────────────

/**
 * side-tab — delete the accent bar.
 *
 * "delete the bar" is literally what the rule's own hint tells the author to
 * do, which is the tell that it has one correct answer. Only a DOMINANT edge is
 * cut: a uniform border is a box, not a tab, and the rule does not flag it.
 */
function _repairSideTab(css) {
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        const decls = _declsOf(css, block);
        const widths = { top: 0, right: 0, bottom: 0, left: 0 };
        const owners = { top: [], right: [], bottom: [], left: [] };
        for (const d of decls) {
            let m = d.prop.match(/^border-(top|right|bottom|left)(?:-width)?$/);
            if (m) {
                const w = _leadingLen(d.value);
                if (Number.isFinite(w)) widths[m[1]] = Math.max(widths[m[1]], w);
                owners[m[1]].push(d);
                continue;
            }
            m = d.prop.match(/^border-(top|right|bottom|left)-color$/);
            if (m) { owners[m[1]].push(d); continue; }
            m = d.prop.match(/^border-inline-(start|end)(?:-width|-color)?$/);
            if (m) {
                const side = m[1] === 'start' ? 'left' : 'right';
                const w = _leadingLen(d.value);
                if (Number.isFinite(w)) widths[side] = Math.max(widths[side], w);
                owners[side].push(d);
            }
        }
        for (const side of ['top', 'right', 'bottom', 'left']) {
            const w = widths[side];
            if (!(w >= 2) || !owners[side].length) continue;
            const maxOther = Math.max(...['top', 'right', 'bottom', 'left']
                .filter(s => s !== side).map(s => widths[s]));
            // Same dominance test the rule applies: an even border on all four
            // edges is a frame and must survive untouched.
            if (!(maxOther <= 1 || w >= maxOther * 2)) continue;
            for (const d of owners[side]) edits.push({ start: d.start, end: d.end, text: '' });
        }
    }
    return _applyEdits(css, edits);
}

/**
 * pseudo-side-bar — take the colour out of the stripe.
 *
 * The rule fires on shape AND fill together, so removing the fill clears it.
 * Deliberately not resizing the element or deleting its markup: both change
 * layout, and the point of a deterministic repair is that its consequences are
 * fully known. An unfilled 5px box is a gap, which is what the space was
 * already being used for.
 */
function _repairPseudoSideBar(css) {
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        const decls = _declsOf(css, block);
        let w = NaN;
        let h = NaN;
        const fills = [];
        for (const d of decls) {
            if (d.prop === 'display' && /^\s*none/i.test(d.value)) { fills.length = 0; break; }
            if (d.prop === 'width' || d.prop === 'min-width') {
                const v = _leadingLen(d.value);
                if (Number.isFinite(v) && (!Number.isFinite(w) || v < w)) w = v;
            }
            if (d.prop === 'height' || d.prop === 'min-height') {
                const v = _leadingLen(d.value);
                if (Number.isFinite(v) && (!Number.isFinite(h) || v > h)) h = v;
            }
            if (d.prop === 'background' || d.prop === 'background-color' || d.prop === 'background-image') fills.push(d);
        }
        if (!fills.length || !Number.isFinite(w) || !Number.isFinite(h)) continue;
        if (!(w > 0 && w <= 18 && h >= 48)) continue;
        for (const d of fills) edits.push({ start: d.start, end: d.end, text: '' });
    }
    return _applyEdits(css, edits);
}

/**
 * tight-leading — raise the line-height to the floor it is measured against.
 *
 * Text gets taller, so this can push a block into an overflow or a safe-zone
 * breach. That is fine and intended: the rendered-pixel lint runs after this
 * and will catch it, and the caller drops the whole repair if it does.
 */
function _repairTightLeading(css) {
    const edits = [];
    for (const block of _walkBlocks(css)) {
        const decls = _declsOf(css, block);
        const lh = decls.find(d => d.prop === 'line-height');
        if (!lh) continue;
        const fs = decls.find(d => d.prop === 'font-size');
        const fsPx = fs ? _fontSizePx(fs.value) : NaN;
        const raw = String(lh.value).trim();
        let ratio = NaN;
        if (/^[\d.]+$/.test(raw)) ratio = parseFloat(raw);
        else {
            const lhPx = lenPx(raw, 100);
            if (Number.isFinite(fsPx) && Number.isFinite(lhPx) && fsPx > 0) ratio = lhPx / fsPx;
        }
        if (!Number.isFinite(ratio)) continue;
        const floor = (Number.isFinite(fsPx) && fsPx >= VIDEO.DISPLAY_SIZE_PX)
            ? VIDEO.MIN_LEADING_DISPLAY
            : VIDEO.MIN_LEADING_BODY;
        if (ratio >= floor) continue;
        edits.push({ start: lh.valueStart, end: lh.valueEnd, text: ` ${floor}` });
    }
    return _applyEdits(css, edits);
}

/**
 * overused-font — swap the banned face for the one the brief recommended.
 *
 * The brief now names the ban list outright, so this should rarely fire. It is
 * kept because this single rule cost 11 of 26 rejections in the last build, and
 * because a substitution the author already had in front of it is not a
 * judgement call.
 */
function _repairBannedFont(css, themeId) {
    const tokens = getThemeTokens(themeId) || {};
    const t = tokens.typography || {};
    const heading = authorSafeStack(t.headingFont, SAFE_HEADING_STACK);
    const body = authorSafeStack(t.bodyFont, SAFE_BODY_STACK);
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        const decls = _declsOf(css, block);
        const ff = decls.find(d => d.prop === 'font-family');
        if (!ff) continue;
        const primary = String(ff.value).split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (!OVERUSED_FONTS.has(primary)) continue;
        const fs = decls.find(d => d.prop === 'font-size');
        const fsPx = fs ? _fontSizePx(fs.value) : NaN;
        const replacement = (Number.isFinite(fsPx) && fsPx >= VIDEO.DISPLAY_SIZE_PX) ? heading : body;
        edits.push({ start: ff.valueStart, end: ff.valueEnd, text: ` ${replacement}` });
    }
    return _applyEdits(css, edits);
}

const STYLE_REPAIRS = [
    { id: 'overused-font', label: 'swapped a banned typeface for the theme face', run: _repairBannedFont },
    { id: 'side-tab', label: 'deleted an accent bar down the side of a card', run: _repairSideTab },
    { id: 'pseudo-side-bar', label: 'removed the fill from a stripe element', run: _repairPseudoSideBar },
    { id: 'tight-leading', label: 'opened up line-height to the readable floor', run: _repairTightLeading },
];

/**
 * repairStyle — run every style repair whose rule is currently firing, keeping
 * only the ones that actually clear it.
 *
 * The per-repair verification is the whole point. It means a repair does not
 * need to model its rule perfectly: if the predicate here is narrower than the
 * checker's, the finding survives and the edit is thrown away; if it is wider,
 * the extra edit still has to leave the composition clean. Either way the
 * checker, not this file, has the last word.
 */
function repairStyle(comp, opts = {}) {
    const base = { html: String(comp.html || ''), css: String(comp.css || ''), timeline: String(comp.timeline || '') };
    const lintOpts = { theme: opts.theme || null, kind: opts.kind, source: 'composition' };
    const fixes = [];
    let css = base.css;
    for (const repair of STYLE_REPAIRS) {
        let before;
        try { before = slopLint({ ...base, css }, { ...lintOpts, only: [repair.id] }); } catch (_) { continue; }
        if (before.ok) continue;
        let candidate;
        try { candidate = repair.run(css, opts.themeId); } catch (_) { continue; }
        if (candidate == null || candidate === css) continue;
        let after;
        try { after = slopLint({ ...base, css: candidate }, { ...lintOpts, only: [repair.id] }); } catch (_) { continue; }
        if (!after.ok) continue; // did not clear it — leave the round to the author
        css = candidate;
        fixes.push(repair.label);
    }
    return { css, fixes };
}

/**
 * scaleTimelineToFit — compress an overrunning timeline onto its scene.
 *
 * Proportional, not truncating: every start, every duration and every explicit
 * offset moves by the same factor, so the choreography the author designed is
 * preserved exactly and simply lands on time. Truncating would clip whichever
 * exit happened to be last, turning a considered fade into a pop.
 *
 * Returns null rather than guessing whenever the source cannot be rewritten
 * with certainty — an unbalanced call, an overlapping edit, an overrun too
 * large to be arithmetic. The caller then behaves exactly as it does today.
 */
function scaleTimelineToFit(timeline, targetDuration, measuredEnd) {
    const src = String(timeline || '');
    const target = Number(targetDuration);
    const end = Number(measuredEnd);
    if (!src.trim() || !(target > 0) || !(end > target)) return null;
    const k = target / end;
    if (!(k >= MIN_TIMELINE_SCALE) || k >= 1) return null;

    const fmt = (n) => {
        const v = Math.round(n * 1000) / 1000;
        return Number.isFinite(v) ? String(v) : null;
    };
    const edits = [];

    // Timing properties inside the vars objects. `repeat` is deliberately
    // absent: it is a count, not a time, and scaling it would change the
    // animation rather than its tempo.
    for (const m of src.matchAll(/\b(duration|delay|repeatDelay|stagger|each)\s*:\s*(-?\d*\.?\d+)/g)) {
        const numStart = m.index + m[0].length - m[2].length;
        const text = fmt(Number(m[2]) * k);
        if (text == null) return null;
        edits.push({ start: numStart, end: numStart + m[2].length, text });
    }

    // The position argument of every timeline call. Every number inside it is
    // a time — a bare position, or the offset in "+=0.2" / "<0.15".
    for (const m of src.matchAll(/\btl\s*\.\s*(to|fromTo|set)\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const split = _splitCallArgs(src, open);
        if (!split) return null;
        const arg = split.args[m[1] === 'fromTo' ? 3 : 2];
        if (!arg) continue;
        const text = src.slice(arg.start, arg.end);
        for (const n of text.matchAll(/-?\d*\.\d+|-?\d+/g)) {
            const scaled = fmt(Number(n[0]) * k);
            if (scaled == null) return null;
            edits.push({ start: arg.start + n.index, end: arg.start + n.index + n[0].length, text: scaled });
        }
    }

    if (!edits.length) return null;
    const out = _applyEdits(src, edits);
    return out == null ? null : { timeline: out, scale: k };
}

/** Top-level argument spans of a call whose '(' is at `open`. Null if unbalanced. */
function _splitCallArgs(src, open) {
    const args = [];
    let depth = 0;
    let quote = null;
    let start = open + 1;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (quote) { if (ch === quote && src[i - 1] !== '\\') quote = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) { args.push({ start, end: i }); return { args, close: i }; }
            continue;
        }
        if (ch === ',' && depth === 1) { args.push({ start, end: i }); start = i + 1; }
    }
    return null;
}

module.exports = {
    repairStyle,
    scaleTimelineToFit,
    MIN_TIMELINE_SCALE,
    STYLE_REPAIRS,
};
