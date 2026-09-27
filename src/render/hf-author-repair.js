/**
 * hf-author-repair.js — deterministic rescue for mechanically-broken authored
 * compositions.
 *
 * WHY THIS EXISTS
 *
 * The composition author gets a small, fixed number of attempts (see
 * MAX_AUTHOR_ROUNDS). Every round it spends being told about a mechanical
 * defect is a round it does not spend on the design, and when the rounds run
 * out the whole bespoke composition is discarded and a hardcoded built-in card
 * is rendered in its place — the generic look this entire effort exists to kill.
 *
 * The 2026-08-04 build lost 12 of 18 graphics that way, and the causes were
 * almost all trivial: a timeline ending 0.16s after its scene, a 3px accent
 * border down the left edge of a card, a line-height of 0.7, a hex colour that
 * belonged to no theme. Each of those is a single unambiguous edit, and each of
 * them cost an entire design.
 *
 * So: fix them in code. This module owns the edits that have exactly one
 * correct answer. Everything with a judgement call in it — two text blocks
 * overlapping, nothing animating in, a number that isn't in the brief, a card
 * nested inside a card — is deliberately NOT here. Those are the author's to
 * solve, and quietly papering over them would ship a worse composition while
 * reporting success.
 *
 * THE SAFETY CONTRACT
 *
 * Every repair is verified against the live rule that rejected it, and reverted
 * if it did not clear it. It is then re-scored against the whole rulebook and
 * reverted again if it made anything else worse. The caller re-validates the
 * composition afterwards and drops the result on any failure. A repair can
 * therefore only ever move a composition towards accepted — never away from it,
 * and never to a state the linters have not seen. That is what makes it safe to
 * run this before spending an AI round rather than after.
 *
 * Every threshold is imported from the checker that enforces it. Nothing here
 * restates a number.
 */
'use strict';

const {
    slopLint, buildThemeContract,
    VIDEO, CONTRACT, FX_EXEMPT_PREFIXES, OVERUSED_FONTS,
    CONTRACT_COLOR_PROPS, CONTRACT_COLOR_TOKEN_RE, GENERIC_FONT_FAMILIES,
    splitFontStack, hueDistance,
    lenPx, parseColor, resolveColor, colorTokenOf, chroma, hueOf, luminance,
} = require('./hf-slop-lint');

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
                const afterColon = raw.slice(colon + 1);
                // `value` is trimmed, so an offset computed inside it is
                // relative to the first non-space character — not to
                // valueStart, which deliberately sits right after the colon so
                // a whole-value rewrite keeps its leading space. Any repair
                // that edits a TOKEN inside the value must anchor on textStart
                // or it lands one space early and corrupts the declaration.
                const lead = afterColon.length - afterColon.replace(/^\s+/, '').length;
                out.push({
                    prop: raw.slice(0, colon).trim().toLowerCase(),
                    value: afterColon.trim(),
                    // cut span includes the terminating semicolon so removing a
                    // declaration never leaves a stray one behind
                    start: block.bodyStart + start,
                    end: block.bodyStart + i + (ch === ';' ? 1 : 0),
                    valueStart: block.bodyStart + start + colon + 1,
                    valueEnd: block.bodyStart + i,
                    textStart: block.bodyStart + start + colon + 1 + lead,
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
// Token surgery primitives
//
// Same discipline as comment blanking above: everything here is
// LENGTH-PRESERVING, so an offset found in a masked copy is valid in the real
// text. Masking rather than deleting is the whole trick — the rule bodies
// delete the parts they do not want to judge, which is fine when you only need
// a verdict and fatal when you need to know where to cut.
// ───────────────────────────────────────────────────────────────────────────

/** A url() is a reference, never a colour: `url(#a1b2c3)` is an SVG id. */
const URL_RE = /url\((?:[^()]|\([^()]*\))*\)/gi;
/** Local copy so a shared lastIndex can never leak between here and the rules. */
const COLOR_TOKEN_RE = new RegExp(CONTRACT_COLOR_TOKEN_RE.source, 'g');

/** Blank out every match, keeping length and line breaks. */
function _maskSpans(text, re) {
    return String(text || '').replace(re, m => m.replace(/[^\n]/g, ' '));
}

/**
 * Blank the parts of a value that already read the theme.
 *
 * This mirrors `stripThemeExpressions` inside the off-theme-surface rule
 * exactly, except that rule builds a shorter string and this one builds an
 * equally long one. Same verdict, usable offsets.
 */
function _maskThemeExpressions(value) {
    const s = String(value || '');
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const head = s.slice(i).match(/^(color-mix|var)\s*\(/i);
        if (head) {
            let depth = 0;
            let j = i + head[0].length - 1;
            for (; j < s.length; j++) {
                if (s[j] === '(') depth++;
                else if (s[j] === ')' && --depth === 0) break;
            }
            const group = s.slice(i, j + 1);
            if (/--hf-/i.test(group)) { out += group.replace(/[^\n]/g, ' '); i = j; continue; }
        }
        out += s[i];
    }
    return out;
}

/** Comma-separated layer spans, ignoring commas inside brackets. */
function _topLevelSpans(value, sep = ',') {
    const s = String(value || '');
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
        else if (s[i] === sep && depth === 0) { out.push({ start, end: i }); start = i + 1; }
    }
    out.push({ start, end: s.length });
    return out;
}

/** Spans between the matches of a splitting regex — split() with offsets. */
function _splitByRegexSpans(value, re) {
    const s = String(value || '');
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const out = [];
    let start = 0;
    let m;
    while ((m = rx.exec(s)) !== null) {
        out.push({ start, end: m.index });
        start = m.index + m[0].length;
        if (m[0].length === 0) rx.lastIndex++;
    }
    out.push({ start, end: s.length });
    return out;
}

/**
 * The palette a repair may substitute FROM — keyed by the CSS variable name, not
 * by the theme's own colour key.
 *
 * This distinction is not pedantry. The theme contract's hue anchors are built
 * from `colors.*`, but the render pipeline wires `--hf-primary` to
 * `mgPrimary || primary`. On the crime theme `colors.primary` is red (hue 348)
 * while `--hf-primary` resolves to cyan (hue 194) — 154° apart. A repair that
 * picked its variable by matching anchor NAMES would have written the wrong
 * colour into every crime composition while passing its own verification,
 * because the contract rule only checks that a `var(--hf-` is present.
 */
function _themeVarPalette(theme) {
    const c = (theme && theme.colors) || {};
    const chrome = (theme && theme.chrome) || {};
    const wired = [
        ['--hf-primary', c.mgPrimary || c.primary],
        ['--hf-accent', c.mgAccent || c.accent],
        ['--hf-text', c.textPrimary],
        ['--hf-muted', c.textSecondary],
        ['--hf-surface', c.surface],
        ['--hf-bg', chrome.bg || c.background],
    ];
    const out = [];
    for (const [varName, raw] of wired) {
        const color = parseColor(String(raw || '').trim());
        if (!color) continue;
        out.push({ varName, color, hue: hueOf(color), chroma: chroma(color), lum: luminance(color) });
    }
    return out;
}

/** Closest theme variable by hue, among the ones carrying real colour. */
function _nearestChromaticVar(palette, hue) {
    let best = null;
    let bestD = Infinity;
    for (const e of palette || []) {
        if (e.chroma < CONTRACT.MIN_ANCHOR_CHROMA || e.hue < 0) continue;
        const d = hueDistance(hue, e.hue);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}

/**
 * Keep the transparency the author chose while changing what is underneath it.
 *
 * A scrim at 55% is a considered decision about how much footage shows through;
 * swapping it for an opaque theme colour would clear the rule and wreck the
 * shot. color-mix with transparent is the one way to re-tint a value without
 * touching its alpha.
 */
function _alphaWrap(base, a) {
    if (!(Number.isFinite(a) && a < 0.98)) return base;
    const pct = Math.max(1, Math.min(99, Math.round((1 - a) * 100)));
    return `color-mix(in srgb, ${base}, transparent ${pct}%)`;
}

/**
 * The settle the rule's own hint asks for, in both dialects.
 *
 * Quoted from bounce-easing's hint ("use power2.out / power3.out / expo.out —
 * settle, do not overshoot") rather than invented, and the bezier's control
 * points all sit inside the legal box the same rule defines, so the replacement
 * cannot be the thing that fails next.
 */
const SETTLE_EASE = 'power3.out';
const SETTLE_BEZIER = 'cubic-bezier(0.22, 1, 0.36, 1)';

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
function _repairBannedFont(css, ctx) {
    const tokens = getThemeTokens(ctx && ctx.themeId) || {};
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

// ── Theme contract ─────────────────────────────────────────────────────────

/**
 * off-theme-color — repoint a stray hue at the nearest variable the theme wires.
 *
 * Nearest by hue, not by role: the point of the rule is that the video uses one
 * palette, and the closest member of that palette is the substitution that
 * changes the design least. Alpha is carried across untouched, so a 20% tint
 * stays a 20% tint.
 */
function _repairOffThemeColor(css, ctx) {
    const palette = ctx.palette || [];
    const hues = (ctx.contract && ctx.contract.hues) || [];
    if (!palette.length || !hues.length) return null;
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        for (const d of _declsOf(css, block)) {
            if (!CONTRACT_COLOR_PROPS.test(d.prop)) continue;
            // Already spending the contract — the rule skips the whole
            // declaration, so one substitution anywhere in it is enough.
            if (/var\(\s*--hf-/i.test(d.value)) continue;
            const scan = _maskSpans(d.value, URL_RE);
            for (const m of scan.matchAll(COLOR_TOKEN_RE)) {
                const c = parseColor(m[0]);
                if (!c || c.a < 0.12) continue;
                if (chroma(c) < CONTRACT.MIN_TEST_CHROMA) continue;
                const h = hueOf(c);
                if (h < 0) continue;
                let nearest = 999;
                for (const t of hues) nearest = Math.min(nearest, hueDistance(h, t.hue));
                if (nearest <= CONTRACT.HUE_TOLERANCE) continue;
                const swap = _nearestChromaticVar(palette, h);
                if (!swap) continue;
                edits.push({
                    start: d.textStart + m.index,
                    end: d.textStart + m.index + m[0].length,
                    text: _alphaWrap(`var(${swap.varName})`, c.a),
                });
            }
        }
    }
    return _applyEdits(css, edits);
}

/**
 * off-theme-surface — repaint hardcoded paper in the theme's own stock.
 *
 * The exemptions are mirrored from the rule line for line, and they matter:
 * a full-bleed see-through wash over the creator's footage is legitimate and
 * must not be touched, while the same colour bounded into a card is the thing
 * that made every comparison card identical under all eight themes.
 *
 * Neutrals keep their relative darkness. A card built from #1e1e1e over
 * #2a2a2a is a two-tone design, and flattening both to var(--hf-surface) would
 * clear the rule by destroying the composition. Each neutral is re-mixed
 * against the lightest one in the same declaration, so the steps survive.
 */
function _repairOffThemeSurface(css, ctx) {
    const palette = ctx.palette || [];
    if (!palette.some(p => p.varName === '--hf-surface')) return null;
    const SURFACE_PROPS = /^(background|background-color|background-image)$/;
    const STRUCTURE_PROPS = /^(gap|row-gap|column-gap|box-shadow)$/;

    const blocks = _walkBlocks(css).map(b => ({ ...b, decls: _declsOf(css, b) }));
    const declaresFullBleed = b => b.decls.some(d => (
        (d.prop === 'inset' && /^\s*0(\s+0)*\s*$/.test(d.value))
        || (/^(top|right|bottom|left)$/.test(d.prop) && /^\s*0\s*$/.test(d.value))
    ));
    const fullBleedClasses = new Set();
    for (const b of blocks) {
        if (!declaresFullBleed(b)) continue;
        for (const part of b.selector.split(',')) {
            const m = part.trim().match(/^(\.[A-Za-z0-9_-]+)$/);
            if (m) fullBleedClasses.add(m[1]);
        }
    }

    const edits = [];
    for (const b of blocks) {
        if (_isFx(b.selector)) continue;
        if (/#yta-hyperframes\s*$|^(html|body)\b/i.test(b.selector.trim())) continue;
        if (b.decls.some(d => d.prop === 'object-fit')) continue;
        const isStructure = b.decls.some(d => (
            STRUCTURE_PROPS.test(d.prop)
            || (d.prop === 'display' && /\b(grid|flex)\b/i.test(d.value))
            || (/^border(-(top|right|bottom|left))?$/.test(d.prop) && !/^\s*(0|none)\b/i.test(d.value))
        ));
        const selectorClasses = b.selector.match(/\.[A-Za-z0-9_-]+/g) || [];
        const fullBleed = declaresFullBleed(b) || selectorClasses.some(c => fullBleedClasses.has(c));

        for (const d of b.decls) {
            if (!SURFACE_PROPS.test(d.prop)) continue;
            if (/^\s*(none|transparent|inherit|initial|unset|currentColor)\s*$/i.test(d.value)) continue;

            const judged = _maskThemeExpressions(_maskSpans(d.value, URL_RE));
            const tokens = [...judged.matchAll(COLOR_TOKEN_RE)]
                .map(m => ({ m, c: parseColor(m[0]) }))
                .filter(x => x.c);
            if (!tokens.some(x => x.c.a >= 0.15)) continue;

            const opaqueLayer = _topLevelSpans(judged).some(sp => {
                const layer = judged.slice(sp.start, sp.end);
                const stops = (layer.match(COLOR_TOKEN_RE) || []).map(parseColor).filter(Boolean);
                if (!stops.length) return false;
                if (/\btransparent\b/i.test(layer)) return false;
                return stops.every(c => c.a >= 0.5);
            });
            // A wash: covers the frame, builds nothing, lets the footage
            // through. Legitimate, and the rule leaves it alone.
            if (fullBleed && !isStructure && !opaqueLayer) continue;

            const neutrals = tokens.filter(x => chroma(x.c) < CONTRACT.MIN_TEST_CHROMA);
            const maxLum = neutrals.length ? Math.max(...neutrals.map(x => luminance(x.c))) : 0;
            for (const { m, c } of tokens) {
                let base = null;
                if (chroma(c) >= CONTRACT.MIN_TEST_CHROMA) {
                    const swap = _nearestChromaticVar(palette, hueOf(c));
                    if (swap) base = `var(${swap.varName})`;
                } else {
                    const drop = maxLum > 0
                        ? Math.round(Math.max(0, Math.min(0.6, 1 - luminance(c) / maxLum)) * 100)
                        : 0;
                    base = drop >= 3
                        ? `color-mix(in srgb, var(--hf-surface), #000 ${drop}%)`
                        : 'var(--hf-surface)';
                }
                if (!base) continue;
                edits.push({
                    start: d.textStart + m.index,
                    end: d.textStart + m.index + m[0].length,
                    text: _alphaWrap(base, c.a),
                });
            }
        }
    }
    return _applyEdits(css, edits);
}

/**
 * off-theme-radius — pull an inflated corner back onto the theme's own radius.
 *
 * Only the offending corner token is rewritten, so an intentionally asymmetric
 * shape (rounded top, square bottom) keeps its shape.
 */
function _repairOffThemeRadius(css, ctx) {
    const radii = (ctx.contract && ctx.contract.radii) || [];
    if (!radii.length) return null;
    const ceiling = Math.max(...radii) + CONTRACT.RADIUS_TOLERANCE;
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        for (const d of _declsOf(css, block)) {
            if (!/^border(-[a-z]+)?-radius$/.test(d.prop)) continue;
            if (/var\(\s*--hf-/i.test(d.value)) continue;
            if (d.value.includes('%')) continue;
            for (const m of d.value.matchAll(/[^\s/]+/g)) {
                const px = lenPx(m[0]);
                if (!Number.isFinite(px) || px <= ceiling) continue;
                if (px >= CONTRACT.RADIUS_PILL_PX) continue;   // a pill is a shape choice
                edits.push({
                    start: d.textStart + m.index,
                    end: d.textStart + m.index + m[0].length,
                    text: 'var(--hf-radius)',
                });
            }
        }
    }
    return _applyEdits(css, edits);
}

/**
 * off-theme-font — point the stack at the theme variable, not at a named face.
 *
 * Deliberately NOT the same substitution as `overused-font`, which writes the
 * theme's literal stack. That is right for a banned face and wrong here: the
 * safe-stack helper can return a face this theme's contract does not declare,
 * which would clear the ban and immediately trip this rule instead. The
 * variable is by construction always on contract.
 */
function _repairOffThemeFont(css, ctx) {
    const fonts = ctx.contract && ctx.contract.fonts;
    if (!fonts || !fonts.size) return null;
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (/^@font-face/i.test(block.selector)) continue;
        const decls = _declsOf(css, block);
        const sizeDecl = decls.find(d => d.prop === 'font-size');
        for (const d of decls) {
            if (d.prop !== 'font-family' && d.prop !== 'font') continue;
            if (/var\(\s*--hf-/i.test(d.value)) continue;

            let stack = d.value;
            let offset = 0;
            if (d.prop === 'font') {
                // Shorthand: the family list is whatever follows the size.
                const m = d.value.match(/\d[\d.]*\s*(?:px|pt|em|rem|%)?(?:\s*\/\s*[\d.]+[a-z%]*)?\s+(.+)$/i);
                if (!m) continue;
                offset = m.index + m[0].length - m[1].length;
                stack = m[1];
            }
            const offends = splitFontStack(stack).some(face => (
                face
                && !GENERIC_FONT_FAMILIES.has(face)
                && !/^\d/.test(face)
                && !face.startsWith('var(')
                && !fonts.has(face)
            ));
            if (!offends) continue;
            const px = d.prop === 'font'
                ? _fontSizePx(d.value)
                : (sizeDecl ? _fontSizePx(sizeDecl.value) : NaN);
            const slot = (Number.isFinite(px) && px >= VIDEO.DISPLAY_SIZE_PX) ? 'heading' : 'body';
            edits.push({
                start: d.textStart + offset,
                end: d.textStart + offset + stack.length,
                text: `var(--hf-${slot}-font)`,
            });
        }
    }
    return _applyEdits(css, edits);
}

// ── Type ───────────────────────────────────────────────────────────────────

/**
 * tiny-text — raise the stops that fall under the floor, not the whole value.
 *
 * A clamp() is three decisions, and only the ones below the floor are wrong.
 * Replacing the value outright would throw away a responsive size the author
 * thought about; raising the floor stop keeps the curve and lands it legal.
 */
function _repairTinyText(css) {
    const floor = VIDEO.MIN_TEXT_PX;
    const edits = [];
    for (const m of css.matchAll(/font-size\s*:\s*([^;{}]+)/gi)) {
        const px = lenPx(m[1], 100);
        if (!Number.isFinite(px) || px <= 0 || px >= floor) continue;
        const valueStart = m.index + m[0].length - m[1].length;
        for (const t of m[1].matchAll(/-?[\d.]+\s*(?:px|rem|em|pt|vw|vh)/g)) {
            const v = lenPx(t[0], 100);
            if (!Number.isFinite(v) || v <= 0 || v >= floor) continue;
            edits.push({ start: valueStart + t.index, end: valueStart + t.index + t[0].length, text: `${floor}px` });
        }
    }
    return _applyEdits(css, edits);
}

/**
 * hairline-weight — take the weight up to regular.
 *
 * The alternative — taking the size up — is a layout change with unknown
 * consequences. Weight is the safe axis: nothing reflows, and the stroke stops
 * being reconstructed by the encoder.
 */
function _repairHairlineWeight(css) {
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        const decls = _declsOf(css, block);
        const wDecl = decls.find(d => d.prop === 'font-weight');
        if (!wDecl) continue;
        const weight = parseFloat(wDecl.value);
        if (!Number.isFinite(weight) || weight >= VIDEO.REGULAR_WEIGHT) continue;
        const sizeDecl = decls.find(d => d.prop === 'font-size')
            || decls.find(d => d.prop === 'font' && /\d/.test(d.value));
        const sizePx = sizeDecl ? _fontSizePx(sizeDecl.value) : NaN;
        if (!Number.isFinite(sizePx) || sizePx <= 0) continue;
        if (sizePx * weight / VIDEO.REGULAR_WEIGHT >= VIDEO.MIN_TEXT_PX) continue;
        edits.push({ start: wDecl.valueStart, end: wDecl.valueEnd, text: ` ${VIDEO.REGULAR_WEIGHT}` });
    }
    return _applyEdits(css, edits);
}

/**
 * extreme-negative-tracking — back off to half the floor.
 *
 * Half, not the floor itself: the rule fires on `<=`, so writing the constant
 * verbatim would leave it firing. The number is still derived from the rule's
 * own threshold rather than restated, which is the property that matters.
 */
function _repairNegativeTracking(css) {
    const relaxed = VIDEO.MIN_TRACKING_EM / 2;
    const edits = [];
    for (const m of css.matchAll(/letter-spacing\s*:\s*(-[\d.]+)\s*(em|px|rem)?/gi)) {
        const n = parseFloat(m[1]);
        const unit = (m[2] || 'px').toLowerCase();
        const em = unit === 'em' || unit === 'rem' ? n : n / 60;
        if (em > VIDEO.MIN_TRACKING_EM) continue;
        const numIdx = m[0].indexOf(m[1]);
        edits.push({ start: m.index + numIdx, end: m.index + m[0].length, text: `${relaxed}em` });
    }
    return _applyEdits(css, edits);
}

/** wide-tracking — clamp to the cap. The rule fires on `>`, so equality clears. */
function _repairWideTracking(css) {
    const cap = VIDEO.MAX_BODY_TRACKING_EM;
    const edits = [];
    for (const block of _walkBlocks(css)) {
        const decls = _declsOf(css, block);
        const ls = decls.find(d => d.prop === 'letter-spacing');
        if (!ls) continue;
        // A negative value belongs to the tracking repair above, which runs
        // first. Clamping it here would flip the sign of a deliberate choice.
        if (/^-/.test(ls.value)) continue;
        const m = String(ls.value).match(/([\d.]+)\s*(em|rem|px)?/);
        if (!m) continue;
        const unit = (m[2] || 'px').toLowerCase();
        const em = unit === 'em' || unit === 'rem' ? parseFloat(m[1]) : parseFloat(m[1]) / 40;
        if (!(em > cap)) continue;
        // Wide tracking on a short caps label is correct typography, and the
        // rule already exempts it.
        if (decls.some(d => d.prop === 'text-transform' && /uppercase/i.test(d.value))) continue;
        edits.push({ start: ls.valueStart, end: ls.valueEnd, text: ` ${cap}em` });
    }
    return _applyEdits(css, edits);
}

/** justified-text — the rule's hint says left, so left it is. */
function _repairJustifiedText(css) {
    if (!/text-align\s*:\s*justify/i.test(css)) return null;
    return css.replace(/(text-align\s*:\s*)justify/gi, '$1left');
}

// ── Colour & motion ────────────────────────────────────────────────────────

/**
 * gradient-text — fill the type with one solid colour, exactly as the hint says.
 *
 * The clip, the transparent fill and the gradient have to go together: leaving
 * `-webkit-text-fill-color: transparent` behind after removing the clip would
 * render invisible text, which is a far worse outcome than the rule being
 * cleared. When the block names no colour of its own, the first removed
 * declaration is REPLACED by one rather than a new declaration being inserted —
 * an insert at the block's opening brace ties with the first declaration's
 * start offset and trips the overlap guard.
 */
function _repairGradientText(css) {
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        const decls = _declsOf(css, block);
        const clip = decls.filter(d => /^(-webkit-)?background-clip$/.test(d.prop) && /text/i.test(d.value));
        if (!clip.length) continue;
        const grad = decls.filter(d => /gradient\(/i.test(d.value));
        if (!grad.length) continue;
        const fill = decls.filter(d => d.prop === '-webkit-text-fill-color');
        const hasColor = decls.some(d => d.prop === 'color');
        const doomed = [];
        for (const d of [...clip, ...grad, ...fill]) {
            if (!doomed.some(x => x.start === d.start)) doomed.push(d);
        }
        doomed.sort((a, b) => a.start - b.start);
        doomed.forEach((d, i) => {
            edits.push({
                start: d.start,
                end: d.end,
                text: (!hasColor && i === 0) ? ' color: var(--hf-text);' : '',
            });
        });
    }
    return _applyEdits(css, edits);
}

/**
 * dark-glow — give the shadow the downward offset the hint asks for.
 *
 * Keeping the colour on purpose. The rule's complaint is the physics, not the
 * hue: light comes from somewhere, so a shadow lands somewhere. Offsetting it
 * by a third of its blur is the smallest edit that turns a halo into elevation,
 * and it leaves whatever colour decision the author made intact.
 */
function _repairDarkGlow(css) {
    const edits = [];
    for (const block of _walkBlocks(css)) {
        if (_isFx(block.selector)) continue;
        for (const d of _declsOf(css, block)) {
            if (d.prop !== 'box-shadow' && d.prop !== 'text-shadow') continue;
            for (const sp of _splitByRegexSpans(d.value, /,(?![^(]*\))/g)) {
                const layer = d.value.slice(sp.start, sp.end);
                const tok = colorTokenOf(layer);
                if (!tok) continue;
                let info;
                try { info = resolveColor(tok, { vars: new Map() }); } catch (_) { continue; }
                if (!info || !info.chromatic) continue;
                const nums = [...
                    _maskSpans(layer, /(?:rgba?|hsla?|var)\([^)]*\)/gi)
                        .matchAll(/-?[\d.]+(?:px|rem|em)?/g)
                ].map(m => ({ m, px: lenPx(m[0]) })).filter(x => Number.isFinite(x.px));
                if (nums.length < 3 || nums[2].px <= 4) continue;
                if (!(nums[0].px === 0 && nums[1].px === 0)) continue;
                const y = Math.max(2, Math.round(nums[2].px / 3));
                const t = nums[1].m;
                edits.push({
                    start: d.textStart + sp.start + t.index,
                    end: d.textStart + sp.start + t.index + t[0].length,
                    text: `${y}px`,
                });
            }
        }
    }
    return _applyEdits(css, edits);
}

/**
 * bounce-easing — replace the overshoot with a settle, in CSS and in GSAP.
 *
 * The `animation: bounceIn` branch is deliberately left alone. Renaming it
 * breaks the @keyframes reference and deleting it strands the element on
 * whatever frame 0 declared — usually opacity 0, i.e. an invisible graphic.
 * That is a redesign, and redesigns belong to the author.
 */
function _repairBounceEasing(comp) {
    const out = {};

    const css = String(comp.css || '');
    const cssEdits = [];
    for (const m of css.matchAll(/cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g)) {
        const y1 = parseFloat(m[2]);
        const y2 = parseFloat(m[4]);
        if (!(y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1)) continue;
        cssEdits.push({ start: m.index, end: m.index + m[0].length, text: SETTLE_BEZIER });
    }
    if (cssEdits.length) {
        const next = _applyEdits(css, cssEdits);
        if (next == null) return null;
        out.css = next;
    }

    const tl = String(comp.timeline || '');
    const tlEdits = [];
    for (const m of tl.matchAll(/ease\s*:\s*(["'])((?:back|elastic|bounce)[^"']*)\1/gi)) {
        const at = m.index + m[0].indexOf(m[2]);
        tlEdits.push({ start: at, end: at + m[2].length, text: SETTLE_EASE });
    }
    if (tlEdits.length) {
        const next = _applyEdits(tl, tlEdits);
        if (next == null) return null;
        out.timeline = next;
    }

    return Object.keys(out).length ? out : null;
}

/**
 * Adapt a css-only repair to the composition-wide signature.
 *
 * The four original repairs predate the timeline being repairable and their
 * bodies are proven against the verify gate; wrapping them leaves those bodies
 * byte-identical instead of rewriting four working functions to change one
 * argument.
 */
const _cssOnly = fn => (comp, ctx) => {
    const css = fn(comp.css, ctx);
    return css == null ? null : { css };
};

/**
 * Order matters in exactly two places, and both are recorded next to the entry:
 * a banned face has to be swapped before the contract check judges the
 * replacement, and a negative tracking value has to be relaxed before the
 * wide-tracking clamp reads its digits.
 */
const STYLE_REPAIRS = [
    { id: 'overused-font', label: 'swapped a banned typeface for the theme face', run: _cssOnly(_repairBannedFont) },
    // after overused-font: judges whatever that swap left behind
    { id: 'off-theme-font', label: 'pointed a stray typeface at the theme font', run: _cssOnly(_repairOffThemeFont) },
    { id: 'off-theme-color', label: 'repointed an off-palette colour at the theme', run: _cssOnly(_repairOffThemeColor) },
    { id: 'off-theme-surface', label: 'repainted a hardcoded surface in the theme', run: _cssOnly(_repairOffThemeSurface) },
    { id: 'off-theme-radius', label: 'pulled an inflated corner back to the theme radius', run: _cssOnly(_repairOffThemeRadius) },
    { id: 'side-tab', label: 'deleted an accent bar down the side of a card', run: _cssOnly(_repairSideTab) },
    { id: 'pseudo-side-bar', label: 'removed the fill from a stripe element', run: _cssOnly(_repairPseudoSideBar) },
    { id: 'gradient-text', label: 'filled gradient type with one solid colour', run: _cssOnly(_repairGradientText) },
    { id: 'dark-glow', label: 'turned a coloured halo into an offset shadow', run: _cssOnly(_repairDarkGlow) },
    { id: 'tight-leading', label: 'opened up line-height to the readable floor', run: _cssOnly(_repairTightLeading) },
    { id: 'tiny-text', label: 'raised text that was under the legibility floor', run: _cssOnly(_repairTinyText) },
    { id: 'hairline-weight', label: 'thickened a stroke too thin to survive encoding', run: _cssOnly(_repairHairlineWeight) },
    { id: 'extreme-negative-tracking', label: 'un-crushed the letter-spacing', run: _cssOnly(_repairNegativeTracking) },
    // after extreme-negative-tracking: its regex reads digits, not signs
    { id: 'wide-tracking', label: 'clamped very wide letter-spacing', run: _cssOnly(_repairWideTracking) },
    { id: 'justified-text', label: 'un-justified a text block', run: _cssOnly(_repairJustifiedText) },
    { id: 'bounce-easing', label: 'replaced bounce easing with a settle', run: _repairBounceEasing },
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
    const theme = opts.theme || null;
    const lintOpts = { theme, kind: opts.kind, source: 'composition' };
    let contract = null;
    try { contract = buildThemeContract(theme); } catch (_) { contract = null; }
    const ctx = {
        themeId: opts.themeId,
        theme,
        contract,
        palette: _themeVarPalette(theme),
        kind: opts.kind,
    };

    const fixes = [];
    let css = base.css;
    let timeline = base.timeline;

    // The whole-composition score, so a repair that clears its own rule by
    // tripping a different one is rejected. Without this a colour substitution
    // could satisfy the palette check and break contrast, and the loop would
    // happily call that a fix.
    const scoreOf = (c, t) => {
        try {
            const r = slopLint({ html: base.html, css: c, timeline: t }, lintOpts);
            return { errors: r.errors.length, findings: r.findings.length };
        } catch (_) { return null; }
    };
    let budget = scoreOf(css, timeline);

    for (const repair of STYLE_REPAIRS) {
        let before;
        try { before = slopLint({ html: base.html, css, timeline }, { ...lintOpts, only: [repair.id] }); } catch (_) { continue; }
        // findings, not ok: `ok` only reflects errors, so gating on it would
        // make every warn-severity rule permanently unrepairable.
        if (!before.findings.length) continue;

        let out;
        try { out = repair.run({ html: base.html, css, timeline }, ctx); } catch (_) { continue; }
        if (!out) continue;
        const nextCss = out.css == null ? css : String(out.css);
        const nextTl = out.timeline == null ? timeline : String(out.timeline);
        if (nextCss === css && nextTl === timeline) continue;

        let after;
        try { after = slopLint({ html: base.html, css: nextCss, timeline: nextTl }, { ...lintOpts, only: [repair.id] }); } catch (_) { continue; }
        if (after.findings.length) continue; // did not clear it — leave the round to the author

        if (budget) {
            const now = scoreOf(nextCss, nextTl);
            if (!now || now.errors > budget.errors || now.findings > budget.findings) continue;
            budget = now;
        }
        css = nextCss;
        timeline = nextTl;
        fixes.push(repair.label);
    }
    return { css, timeline, fixes };
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
    // Exported for the verify gate only. The rendered-pixel checker paints its
    // harness from the same wiring; if the two ever drift, a repair would
    // substitute one colour while the contrast check measured another.
    themeVarPalette: _themeVarPalette,
};
