/**
 * hf-slop-lint.js — Deterministic "does this look AI-made?" checker.
 *
 * Ported from the Impeccable detector's rule set (Apache-2.0, Paul Bakaus)
 * and RETUNED for a 1920x1080 video frame instead of a scrolling web page.
 * Zero AI calls, zero network, zero browser: it reads the CSS/HTML/timeline
 * text of a composition (or the render engine's own stylesheet) and reports
 * the visual clichés that make generated design read as generated.
 *
 * Three things make this OURS rather than a copy:
 *   1. FX EXEMPTION — this project deliberately paints lens flares, ember
 *      particles, film grain, VHS bands and light leaks. Upstream flags those
 *      as `radial-halo` / `codex-grid-background` / `dark-glow`. Selectors in
 *      FX_EXEMPT_PREFIXES are skipped by the decorative-glow rules.
 *   2. THEME CONTRACT — with `opts.theme` (the object from
 *      `data/themes.js:getThemeTokens`) the font/colour rules check against
 *      what THIS video's theme actually declares, instead of a global
 *      blocklist. A cream canvas is slop on a dark theme and correct on
 *      `warm-editorial`.
 *   3. VIDEO THRESHOLDS — minimum type size, line length and leading are
 *      sized for a 1080p frame watched on a phone, not for a 16px web body.
 *
 * Usage:
 *   const { slopLint } = require('./hf-slop-lint');
 *   const res = slopLint({ html, css, timeline }, { theme, vars, kind });
 *   // res.ok, res.errors (hard, feed the author repair round), res.findings
 *
 * Severity contract:
 *   'error'    — unambiguous cliché, mechanically fixable → blocks / repairs
 *   'warn'     — real signal, needs judgement → reported, never blocks
 *   'advisory' — informational only
 */
'use strict';

// ── Shared vocabulary ──────────────────────────────────────────────────────

/**
 * The real overused-font set, read from the upstream detector's
 * shared/constants.mjs. Broader than the public docs list.
 */
const OVERUSED_FONTS = new Set([
    // Older monoculture (still ubiquitous)
    'inter', 'roboto', 'open sans', 'lato', 'montserrat', 'arial', 'helvetica',
    // Newer monoculture (the design-skill / Vercel / GitHub default wave)
    'fraunces', 'instrument sans', 'instrument serif',
    'geist', 'geist sans', 'geist mono', 'mona sans',
    'plus jakarta sans', 'space grotesk', 'recoleta',
]);

const GENERIC_FONTS = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui',
    'inherit', 'initial', 'unset', 'revert',
]);

const KNOWN_SERIF_FONTS = new Set([
    'fraunces', 'recoleta', 'newsreader', 'playfair display', 'playfair',
    'cormorant', 'cormorant garamond', 'garamond', 'eb garamond',
    'lora', 'vollkorn', 'spectral', 'merriweather',
    'libre caslon', 'libre baskerville', 'baskerville',
    'georgia', 'times new roman', 'times',
    'dm serif display', 'dm serif text', 'instrument serif',
]);

/**
 * Selectors owned by the deliberate film-FX / transition libraries. These
 * PAINT halos, grain grids and coloured glows on purpose — that is the look,
 * not a tell. Verified against hf-effects.js and hyperframes-bridge.js.
 */
const FX_EXEMPT_PREFIXES = [
    'hf-fx-',              // the 17-effect film stock library
    'hf-scene-grain',      // baked LCG grain plate
    'hf-scene-vignette',   // scene vignette
    'hf-map-vignette',     // map vignette
    'hf-transition-',      // flares / light leaks / sweeps between scenes
    'hf-kw-glow',          // word-synced keyword glow (a designed feature)
    'hf-bgp-',             // hf-background-packs.js — one designed pack per video
    'hf-scene-floatbg',    // the blurred-fill backdrop behind letterboxed media
];

/** Marketing filler that reads as machine-written on screen. */
const BUZZWORDS = [
    'seamless', 'seamlessly', 'leverage', 'leveraging', 'unlock the power',
    'game-changing', 'game changer', 'cutting-edge', 'state-of-the-art',
    'revolutionize', 'revolutionary', 'transformative', 'best-in-class',
    'next-generation', 'next-gen', 'robust solution', 'holistic',
    'synergy', 'empower', 'elevate your', 'take it to the next level',
    'in today’s fast-paced', 'in today\'s fast-paced',
];

// ── Video-frame thresholds (retuned from web defaults) ─────────────────────
//
// The canvas is 1920x1080 and gets watched at phone size and at bitrates that
// smear thin strokes. Anything the web would call "small print" is unreadable
// here, and anything the web would call a comfortable measure is too long to
// read inside a 4-second cut.
const VIDEO = {
    MIN_TEXT_PX: 22,          // below this, nothing survives compression
    MIN_BODY_PX: 28,          // body copy floor
    MAX_LINE_CHARS: 52,       // characters per line before it stops scanning
    // Leading floors scale with size. Big display type is SUPPOSED to be set
    // tight (0.9 on a 110px headline is correct editorial typography); body
    // copy set that tight is unreadable in motion.
    MIN_LEADING_DISPLAY: 0.88,   // font-size >= DISPLAY_SIZE_PX
    MIN_LEADING_BODY: 1.15,      // font-size <  DISPLAY_SIZE_PX
    DISPLAY_SIZE_PX: 48,         // 48px = 4.4% of a 1080 frame — display type
    // A gradient stop this faint cannot read as a halo; it is a tint or a scrim.
    MIN_VISIBLE_ALPHA: 0.15,
    MAX_BODY_TRACKING_EM: 0.2,
    MIN_TRACKING_EM: -0.04,
    ALL_CAPS_MAX_CHARS: 40,   // caps runs longer than this stop being a label

    // ── Surviving the codec ────────────────────────────────────────────────
    //
    // Everything above is about a still frame. These three are about what
    // YouTube's encoder does to that frame afterwards, which no web checker has
    // any reason to model.
    //
    // Contrast floors are WCAG's own two numbers (4.5 normal, 3.0 large). They
    // are used unchanged rather than inflated with a made-up "video margin",
    // because a graphic that fails the still-image floor cannot possibly pass
    // after compression — the encoder only ever removes contrast. The
    // large-text carve-out is real here too: a 110px headline keeps its edges
    // where 24px body copy loses them.
    CONTRAST_MIN_BODY: 4.5,
    CONTRAST_MIN_DISPLAY: 3.0,

    // Stroke survival. Thickness scales with size × weight, so the honest
    // measure is not "weight <= 200" (fine on a headline, fatal on a caption)
    // but the size a regular-weight face would need to draw the same stroke:
    // size × weight / 400. When that lands under MIN_TEXT_PX the strokes are as
    // thin as text we already refuse to put on screen.
    REGULAR_WEIGHT: 400,

    // 4:2:0 chroma subsampling stores colour at half resolution in both axes,
    // so a saturated hue carried by FINE detail — text, hairlines — is the part
    // that smears, while the same colour in a large fill is untouched. Red and
    // magenta suffer most: they live almost entirely in the Cr channel, so
    // subsampling throws away most of what defines their edge.
    CHROMA_RISK_MIN: 140,        // 0-255 spread; below this the hue is muted enough to survive
    CHROMA_RISK_HUE_LOW: 300,    // pure magenta, wrapping through red at 0
    CHROMA_RISK_HUE_HIGH: 20,    // out to red-orange, where the hue leaves the Cr channel
    CHROMA_RISK_MAX_STROKE_PX: 2,
};

// ── Tiny CSS reader ────────────────────────────────────────────────────────

/**
 * Blank out comments while PRESERVING newlines, so every reported line number
 * still points at the same line in the file the user will open.
 */
function stripComments(css) {
    return String(css || '').replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

/**
 * Walk a stylesheet into flat { selector, body, index } blocks, descending
 * into at-rule bodies (@media, @supports) and keeping @keyframes bodies whole
 * so motion rules can read them.
 */
function parseBlocks(css) {
    const src = stripComments(css);
    const out = [];
    let i = 0;
    const walk = (start, end, prefix) => {
        let cursor = start;
        let selStart = start;
        while (cursor < end) {
            const ch = src[cursor];
            if (ch === '{') {
                const rawSel = src.slice(selStart, cursor);
                const selector = rawSel.trim();
                // point at the first real character of the selector, not at the
                // whitespace left over from the previous block's closing brace
                const selIndex = selStart + (rawSel.length - rawSel.replace(/^\s+/, '').length);
                // find matching close brace
                let depth = 1, j = cursor + 1;
                while (j < end && depth > 0) {
                    if (src[j] === '{') depth++;
                    else if (src[j] === '}') depth--;
                    j++;
                }
                const bodyEnd = depth === 0 ? j - 1 : end;
                const body = src.slice(cursor + 1, bodyEnd);
                const isNestingAt = /^@(media|supports|layer|container|scope)\b/i.test(selector);
                if (isNestingAt) {
                    walk(cursor + 1, bodyEnd, selector);
                } else {
                    out.push({ selector, body, index: selIndex, atRule: prefix || null });
                }
                cursor = j;
                selStart = j;
                continue;
            }
            if (ch === '}') { cursor++; selStart = cursor; continue; }
            cursor++;
        }
    };
    walk(0, src.length, null);
    return out;
}

/** Split a declaration body into [{ prop, value }]. */
function parseDecls(body) {
    const out = [];
    for (const raw of String(body || '').split(';')) {
        const idx = raw.indexOf(':');
        if (idx < 0) continue;
        const prop = raw.slice(0, idx).trim().toLowerCase();
        const value = raw.slice(idx + 1).trim();
        if (!prop || !value) continue;
        out.push({ prop, value });
    }
    return out;
}

function collectVars(css) {
    const map = new Map();
    const re = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
    let m;
    const src = stripComments(css);
    while ((m = re.exec(src)) !== null) {
        if (!map.has(m[1])) map.set(m[1], m[2].trim());
    }
    return map;
}

function lineOf(css, index) {
    if (!(index >= 0)) return 0;
    let line = 1;
    for (let i = 0; i < index && i < css.length; i++) if (css[i] === '\n') line++;
    return line;
}

// ── Colour ─────────────────────────────────────────────────────────────────

const NAMED_COLORS = {
    black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
    lime: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
    cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255],
    fuchsia: [255, 0, 255], silver: [192, 192, 192], gray: [128, 128, 128],
    grey: [128, 128, 128], maroon: [128, 0, 0], olive: [128, 128, 0],
    green: [0, 128, 0], purple: [128, 0, 128], teal: [0, 128, 128],
    navy: [0, 0, 128], gold: [255, 215, 0], orange: [255, 165, 0],
    crimson: [220, 20, 60], indigo: [75, 0, 130], violet: [238, 130, 238],
};

/** Parse a CSS colour token to { r,g,b,a } or null. */
function parseColor(token) {
    if (!token) return null;
    const t = String(token).trim().toLowerCase();
    if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMED_COLORS[t]) {
        const [r, g, b] = NAMED_COLORS[t];
        return { r, g, b, a: 1 };
    }
    let m = t.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
        const h = m[1];
        if (h.length === 3 || h.length === 4) {
            return {
                r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16),
                b: parseInt(h[2] + h[2], 16),
                a: h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1,
            };
        }
        if (h.length === 6 || h.length === 8) {
            return {
                r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
                b: parseInt(h.slice(4, 6), 16),
                a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
            };
        }
        return null;
    }
    m = t.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
        if (p.length < 3 || p.some(n => !Number.isFinite(n))) return null;
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = t.match(/^hsla?\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(/[,\s/]+/).filter(Boolean);
        const h = parseFloat(parts[0]);
        const s = parseFloat(parts[1]) / 100;
        const l = parseFloat(parts[2]) / 100;
        if (![h, s, l].every(Number.isFinite)) return null;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const hp = ((h % 360) + 360) % 360 / 60;
        const x = c * (1 - Math.abs(hp % 2 - 1));
        let rgb = [0, 0, 0];
        if (hp < 1) rgb = [c, x, 0]; else if (hp < 2) rgb = [x, c, 0];
        else if (hp < 3) rgb = [0, c, x]; else if (hp < 4) rgb = [0, x, c];
        else if (hp < 5) rgb = [x, 0, c]; else rgb = [c, 0, x];
        const mm = l - c / 2;
        return {
            r: Math.round((rgb[0] + mm) * 255), g: Math.round((rgb[1] + mm) * 255),
            b: Math.round((rgb[2] + mm) * 255),
            a: parts.length > 3 ? parseFloat(parts[3]) : 1,
        };
    }
    return null;
}

/** Split on separators that sit outside every bracket. */
function splitTopLevel(value, sep = ',') {
    const out = [];
    let depth = 0;
    let start = 0;
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
        else if (s[i] === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out.map(x => x.trim()).filter(Boolean);
}

/** The text inside a function call's outermost parens, brackets balanced. */
function balancedArgs(raw) {
    const s = String(raw || '');
    const open = s.indexOf('(');
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i);
    }
    return null;
}

/**
 * Mix two colours the way `color-mix(in srgb, …)` does — premultiplied by
 * alpha, per spec. `weightB` is B's share, 0..1.
 */
function mixColors(a, b, weightB) {
    const wB = Math.min(1, Math.max(0, weightB));
    const wA = 1 - wB;
    const pa = a.a * wA;
    const pb = b.a * wB;
    const alpha = pa + pb;
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
        r: Math.round((a.r * pa + b.r * pb) / alpha),
        g: Math.round((a.g * pa + b.g * pb) / alpha),
        b: Math.round((a.b * pa + b.b * pb) / alpha),
        a: alpha,
    };
}

/** Peel a trailing/leading top-level percentage off one color-mix argument. */
function splitMixPercent(part) {
    const s = String(part || '').trim();
    let depth = 0;
    let pct = null;
    let body = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth === 0 && pct === null) {
            const m = s.slice(i).match(/^(-?[\d.]+)%/);
            if (m) { pct = parseFloat(m[1]) / 100; i += m[0].length - 1; continue; }
        }
        body += ch;
    }
    return { pct, body: body.trim() };
}

function chroma(c) {
    if (!c) return 0;
    return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
}

function luminance(c) {
    if (!c) return 0;
    const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function hueOf(c) {
    if (!c) return -1;
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return -1;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return (h + 360) % 360;
}

function toHex(c) {
    if (!c) return '?';
    const h = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
function contrastRatio(fg, bg) {
    if (!fg || !bg) return NaN;
    const a = luminance(fg);
    const b = luminance(bg);
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * Flatten a translucent colour onto what is behind it.
 *
 * This matters more here than on a web page. A panel at 70% opacity on a site
 * sits on a background the stylesheet knows about; in a video it sits on
 * FOOTAGE, which changes every scene and every frame. `under` is therefore the
 * caller's stand-in for "whatever the clip happens to be" — mid-grey is the
 * honest choice, because it is the average a real shot lands on and because
 * assuming a helpful backdrop is how low-contrast text ships.
 */
function compositeOver(color, under) {
    if (!color) return null;
    const a = Number.isFinite(color.a) ? color.a : 1;
    if (a >= 0.999) return color;
    const base = under || { r: 128, g: 128, b: 128, a: 1 };
    return {
        r: color.r * a + base.r * (1 - a),
        g: color.g * a + base.g * (1 - a),
        b: color.b * a + base.b * (1 - a),
        a: 1,
    };
}

/** Variable names that name an accent (chromatic) vs a surface (neutral). */
const CHROMATIC_VAR_RE = /(primary|accent|secondary|brand|gold|amber|crimson|scarlet|emerald|teal|cyan|violet|purple|magenta|coral|mint|highlight|glow)/i;
const NEUTRAL_VAR_RE = /(^--hf-(bg|surface|panel|ink|text|muted|line|border|neutral|shadow|scrim))/i;

/**
 * Resolve a value's colour, following one level of var() against the sheet's
 * own custom properties plus any caller-supplied theme vars. Returns
 * { color, chromatic, resolved } — `chromatic` may be true from the variable
 * NAME when the value itself can't be resolved.
 *
 * NAME BEATS FALLBACK for accent slots. --hf-primary and --hf-accent are theme
 * slots: at render time they carry the theme's real accent (crime crimson,
 * modern cyan, luxury gold). The value sitting on the :root block is only a
 * placeholder for a graphic that failed to receive inline theme vars, and a
 * good placeholder is deliberately low-chroma. If we trusted that placeholder
 * we would read every accent in the sheet as a neutral grey and the whole
 * checker would go blind — which is exactly what happened once. So a slot NAMED
 * as an accent counts as chromatic regardless of what the fallback resolves to.
 */
function resolveColor(value, ctx) {
    const raw = String(value || '').trim();

    // color-mix() FIRST, and actually evaluated.
    //
    // Without this the var() scan below grabs whichever theme slot the mix
    // happens to name and reports that as the colour, discarding the mix
    // entirely. `color-mix(in srgb, #000, var(--hf-primary) 10%)` — a near-black
    // matte — was being read as the full-strength primary, so the contrast rule
    // reported white-on-#b9c2cc at 1.8:1 for a plate that actually measures
    // about 18:1. A checker that mis-reads a syntax the stylesheet uses on
    // roughly every themed surface is not checking those surfaces at all.
    if (/^color-mix\s*\(/i.test(raw)) {
        const args = splitTopLevel(balancedArgs(raw) || '');
        if (args.length >= 3 && /^in\s+/i.test(args[0])) {
            const A = splitMixPercent(args[1]);
            const B = splitMixPercent(args[2]);
            const ra = resolveColor(A.body, ctx);
            const rb = resolveColor(B.body, ctx);
            if (ra.color && rb.color) {
                let weightB;
                if (A.pct == null && B.pct == null) weightB = 0.5;
                else if (A.pct == null) weightB = B.pct;
                else if (B.pct == null) weightB = 1 - A.pct;
                else weightB = (A.pct + B.pct) > 0 ? B.pct / (A.pct + B.pct) : 0.5;
                const color = mixColors(ra.color, rb.color, weightB);
                return {
                    color,
                    // NAME STILL BEATS VALUE for accent slots, same doctrine as
                    // below: at render time the slot carries the theme's real
                    // accent, not the low-chroma placeholder on :root.
                    chromatic: CHROMATIC_VAR_RE.test(raw) || chroma(color) >= 30,
                    resolved: true,
                    varName: ra.varName || rb.varName || null,
                };
            }
        }
        // Unreadable mix: fall through to the var scan rather than going silent.
    }

    const varMatch = raw.match(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/);
    if (varMatch) {
        const name = varMatch[1];
        const looked = ctx.vars.get(name) || (varMatch[2] || '').trim();
        const color = looked ? parseColor(looked.split(/\s+/)[0]) : null;
        if (CHROMATIC_VAR_RE.test(name)) return { color, chromatic: true, resolved: !!color, varName: name };
        if (color) return { color, chromatic: chroma(color) >= 30, resolved: true, varName: name };
        if (NEUTRAL_VAR_RE.test(name)) return { color: null, chromatic: false, resolved: false, varName: name };
        return { color: null, chromatic: false, resolved: false, varName: name };
    }
    const color = parseColor(raw);
    return { color, chromatic: !!color && chroma(color) >= 30, resolved: !!color, varName: null };
}

/**
 * Pull the colour token out of a shorthand like "8px solid var(--hf-primary)".
 *
 * The naive version of this took the first var() in the string, and that was
 * wrong the moment a border width was itself written through a variable:
 *   border-left: calc(var(--hf-shell-line) * 1.5) solid var(--hf-accent)
 * returned `var(--hf-shell-line)`, which resolves to "5px" — not a colour, so
 * the rule concluded the edge was uncoloured and let a full-height accent rail
 * through. A width variable is not a colour, and the parser has to know that.
 *
 * So: drop the arithmetic and length tokens first, and when a line-style
 * keyword is present (solid / dashed / …) only look at what comes after it,
 * because that is where the colour lives in every border shorthand anyone
 * actually writes. Values with no keyword (border-color, background-color) are
 * scanned whole, minus the lengths.
 */
function colorTokenOf(shorthand) {
    let s = String(shorthand || '').trim().replace(/!important\s*$/i, '');

    // Everything after the line-style keyword, if there is one.
    const style = s.match(/\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/i);
    if (style) s = s.slice(style.index + style[0].length);

    // Arithmetic and bare lengths are widths, never colours.
    s = s
        .replace(/\b(?:calc|clamp|min|max)\((?:[^()]|\([^()]*\))*\)/gi, ' ')
        .replace(/(?:^|\s)-?[\d.]+(?:px|rem|em|pt|vh|vw|%)?(?=\s|$)/g, ' ')
        .trim();

    // Nesting matters twice over here.
    //
    // First, `var(--a, var(--b))` is the engine's standard adaptive-colour
    // shape, and a non-nesting pattern chops it at the inner close-paren and
    // hands the caller an unbalanced token.
    //
    // Second — and this is the one that made the checker misreport a caption
    // plate — a `color-mix()` CONTAINS a var(). Testing for var() first returned
    // the inner theme slot and threw the mix away, so a near-black plate mixed
    // 10% toward the primary was read as the primary at full strength. So take
    // whichever colour construct starts EARLIEST, and always close it on
    // balanced brackets rather than the first `)` that happens along.
    const heads = [];
    const push = re => { const m = s.match(re); if (m) heads.push(m.index); };
    push(/var\s*\(\s*--[\w-]+/);
    push(/\b(?:rgba?|hsla?|color-mix)\s*\(/i);
    if (heads.length) {
        const from = Math.min(...heads);
        let depth = 0;
        for (let i = from; i < s.length; i++) {
            if (s[i] === '(') depth++;
            else if (s[i] === ')' && --depth === 0) return s.slice(from, i + 1);
        }
    }
    const hex = s.match(/#[0-9a-fA-F]{3,8}\b/);
    if (hex) return hex[0];
    const words = s.split(/\s+/).filter(w => !/^\d/.test(w) && !/^(none|hidden)$/i.test(w));
    for (const w of words) if (NAMED_COLORS[w.toLowerCase()]) return w;
    return null;
}

function lenPx(token, base = 16) {
    const m = String(token || '').match(/(-?[\d.]+)\s*(px|rem|em|pt|vh|vw|%)?/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return NaN;
    const unit = (m[2] || 'px').toLowerCase();
    if (unit === 'rem' || unit === 'em') return n * base;
    if (unit === 'pt') return n * (96 / 72);
    if (unit === 'vh') return n * 10.8;    // 1080-tall canvas
    if (unit === 'vw') return n * 19.2;    // 1920-wide canvas
    if (unit === '%') return NaN;
    return n;
}

/**
 * A length that may be written through custom properties or arithmetic.
 *
 * This exists because the checker was measuring a 7.5px accent rail as 1.5px.
 * The engine wrote `border-left: calc(var(--hf-shell-line) * 1.5) solid ...`,
 * and the plain number-grabbing parser above found the first digits in that
 * string — the multiplier — and reported a 1.5px hairline. It sailed under the
 * 2px floor and the rail shipped in every video wearing that shell.
 *
 * The lesson generalises past this one bug: a checker that silently skips what
 * it cannot parse reports a clean sheet for the parts it never read. So this
 * resolves var() against the sheet's own custom properties (they are collected
 * from every block, not just :root) and evaluates the simple calc() shapes CSS
 * authors actually use for chrome — a length scaled by a number, or two lengths
 * added. Anything more exotic still returns NaN, and callers that care treat an
 * UNRESOLVED length as suspicious rather than as absent.
 */
function resolveLen(token, ctx) {
    let raw = String(token || '').trim();
    if (!raw) return NaN;

    // 1. Substitute var() against the sheet's own custom properties, innermost
    //    first so a nested fallback like var(--a, var(--b)) collapses. Bounded,
    //    because a self-referential property would otherwise spin.
    for (let pass = 0; pass < 4 && raw.includes('var('); pass++) {
        const before = raw;
        raw = raw.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (whole, name, fallback) => {
            const looked = (ctx && ctx.vars && ctx.vars.get(name)) || (fallback || '').trim();
            return looked || whole;
        });
        if (raw === before) break;
    }

    // 2. An unresolved variable inside arithmetic is the dangerous case — the
    //    plain parser would grab the multiplier and report a hairline. Refuse to
    //    answer rather than answer wrongly. Elsewhere in the value an unresolved
    //    variable is harmless and extremely common: the colour half of a border
    //    shorthand is almost always a var the sheet never declares (it arrives
    //    inline per element), and bailing on that would blind the checker to
    //    every border in the file. So the test must be "inside the calc", not
    //    "anywhere in the string" — the first draft of this got that wrong and
    //    silently returned NaN for the very rail it was written to catch.
    if (raw.includes('var(')) {
        if (/calc\((?:[^()]|\([^()]*\))*var\(/i.test(raw)) return NaN;
        raw = raw.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ');
    }

    const calc = raw.match(/calc\(([^()]*)\)/i);
    if (calc) {
        const expr = calc[1].trim();
        let m = expr.match(/^(.+?)\s*([*/])\s*(-?[\d.]+)$/);
        if (m) {
            const a = lenPx(m[1]);
            const n = parseFloat(m[3]);
            if (Number.isFinite(a) && Number.isFinite(n) && n !== 0) return m[2] === '*' ? a * n : a / n;
            return NaN;
        }
        m = expr.match(/^(-?[\d.]+)\s*\*\s*(.+)$/);
        if (m) {
            const n = parseFloat(m[1]);
            const a = lenPx(m[2]);
            if (Number.isFinite(a) && Number.isFinite(n)) return a * n;
            return NaN;
        }
        m = expr.match(/^(.+?)\s*([+-])\s*(.+)$/);
        if (m) {
            const a = lenPx(m[1]);
            const b = lenPx(m[3]);
            if (Number.isFinite(a) && Number.isFinite(b)) return m[2] === '+' ? a + b : a - b;
            return NaN;
        }
        return NaN;
    }

    // 3. max()/min() of resolved lengths — what ships is the function's result,
    //    so compute it rather than grabbing whichever argument came first.
    const fn = raw.match(/^(max|min)\(([^()]*)\)\s*$/i);
    if (fn) {
        const parts = fn[2].split(',').map(p => lenPx(p.trim())).filter(Number.isFinite);
        if (!parts.length) return NaN;
        return fn[1].toLowerCase() === 'max' ? Math.max(...parts) : Math.min(...parts);
    }

    return lenPx(raw);
}

// ── Context ────────────────────────────────────────────────────────────────

/** True when `index` sits inside an @font-face block. */
function isInFontFace(css, index) {
    const open = css.lastIndexOf('{', index);
    if (open < 0) return false;
    const prevBoundary = Math.max(css.lastIndexOf('}', open), css.lastIndexOf(';', open));
    const selector = css.slice(prevBoundary + 1, open).trim();
    return /^@font-face$/i.test(selector);
}

function isFxSelector(selector) {
    const s = String(selector || '');
    return FX_EXEMPT_PREFIXES.some(p => s.includes(p));
}

function visibleTextOf(html) {
    return String(html || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Theme contract ─────────────────────────────────────────────────────────
//
// Everything above this line asks "is this a cliché?" — a question with the
// same answer on every project. The contract asks a different one: "did this
// graphic use the palette and the faces THIS video already committed to?"
//
// That distinction matters because the two failures look identical on a still
// and completely different in motion. A single graphic in a face the video
// never uses elsewhere is not ugly; it is simply from a different video, and a
// viewer reads that as carelessness long before they can name it.
//
// The contract is derived, never authored. It is whatever `data/themes.js`
// already declares — so adding a theme extends the contract for free, and no
// second table can drift out of step with the first.
//
// What it deliberately does NOT cover:
//   • spacing — themes declare none, and inventing a per-theme spacing scale
//     here would be me making up design decisions the project never made. The
//     global `monotonous-spacing` rule already covers the real failure.
//   • shadow / stroke width — themes do declare these, but box-shadow and
//     border carry a dozen unrelated jobs in real CSS, so a contract check
//     would be mostly noise. `gpt-thin-border-wide-shadow` covers the cliché.

const CONTRACT = {
    // Below this, a THEME colour is a neutral (an ink, a plate, a scrim) and
    // anchors no hue. warm-editorial's #2c2218 text is brown on paper, not a
    // brand colour, and letting it anchor a hue would licence any brown.
    MIN_ANCHOR_CHROMA: 40,
    // Below this, a colour in the COMPOSITION is a scrim or a rule rather than
    // a chosen hue. Matches the chroma floor the existing palette rules use.
    MIN_TEST_CHROMA: 60,
    // Degrees off a declared hue before it reads as a new colour rather than a
    // tint of an existing one.
    HUE_TOLERANCE: 25,
    // Corner radius wander, in px, before a card stops belonging to the theme.
    // Applied in ONE direction only — see the note on RADIUS_PILL_PX.
    RADIUS_TOLERANCE: 6,
    // At or above this, a radius means "fully round the ends" on any realistic
    // badge — a shape decision, not a corner-softness one, so the theme radius
    // has no opinion on it.
    RADIUS_PILL_PX: 100,
};

/**
 * Generic CSS font keywords, permitted under every theme on purpose: they name
 * no face, so they carry no design decision — they are the escape hatch the
 * cascade already provides. The NAMED face is what makes a look, and that is
 * what the contract governs.
 */
const GENERIC_FONT_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
    'inherit', 'initial', 'unset', 'revert', 'math', 'emoji',
]);

const CONTRACT_COLOR_PROPS = /^(color|background|background-color|background-image|border|border-color|border-[a-z]+-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|text-decoration-color|caret-color|column-rule-color)$/;

/** Colour literals: hex, rgb()/rgba()/hsl()/hsla(). Named colours are matched separately. */
const CONTRACT_COLOR_TOKEN_RE = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/g;

function splitFontStack(stack) {
    return String(stack || '')
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
        .filter(Boolean);
}

/** Shortest way round the colour wheel, in degrees. */
function hueDistance(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/**
 * Turn a theme's declared tokens into something a rule can test against.
 * Returns null for a missing/!unusable theme, which makes every contract rule
 * silently inert — the gate lints the engine's theme-agnostic stylesheet with
 * no theme at all, and that must keep passing.
 */
function buildThemeContract(theme) {
    if (!theme || typeof theme !== 'object') return null;
    const ty = theme.typography || {};
    const co = theme.colors || {};
    const ch = theme.chrome || {};

    // Every face in every declared stack is permitted, fallbacks included: a
    // theme that lists Georgia as Playfair's fallback has already said Georgia
    // is acceptable here.
    const fonts = new Set();
    const slots = {};
    for (const [slot, key] of [['heading', 'headingFont'], ['body', 'bodyFont'], ['caption', 'captionFont'], ['stat', 'statFont']]) {
        const faces = splitFontStack(ty[key]);
        if (faces.length) slots[slot] = faces[0];
        for (const f of faces) if (!GENERIC_FONT_FAMILIES.has(f)) fonts.add(f);
    }

    const hues = [];
    for (const [name, value] of Object.entries(co)) {
        const c = parseColor(value);
        if (!c || c.a === 0) continue;
        if (chroma(c) < CONTRACT.MIN_ANCHOR_CHROMA) continue;
        const h = hueOf(c);
        if (h < 0) continue;
        hues.push({ name, hue: h, hex: toHex(c) });
    }

    const radii = [];
    for (const v of [ch.borderRadius, ch.chartBarRadius]) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) radii.push(n);
    }

    return {
        themeId: theme.themeId || '',
        fonts,
        slots,
        hues,
        radii,
        paletteNote: hues.length
            ? hues.slice(0, 4).map(h => `${h.name} ${h.hex}`).join(', ')
            : '',
    };
}

function buildContext(comp, opts) {
    const css = stripComments(String(comp.css || ''));
    const html = String(comp.html || '');
    const timeline = String(comp.timeline || '');
    const vars = collectVars(css);
    if (opts.vars) {
        for (const [k, v] of Object.entries(opts.vars)) {
            const key = k.startsWith('--') ? k : `--${k}`;
            if (!vars.has(key)) vars.set(key, String(v));
        }
    }
    const blocks = parseBlocks(css).map(b => ({ ...b, decls: parseDecls(b.body), line: lineOf(css, b.index) }));
    const theme = opts.theme || null;
    let themeBg = null;
    if (theme && theme.colors) themeBg = parseColor(theme.colors.background);
    return {
        css, html, timeline, vars, blocks,
        theme, themeBg,
        contract: buildThemeContract(theme),
        themeIsLight: themeBg ? luminance(themeBg) > 0.35 : false,
        kind: opts.kind || 'fullscreen',
        visibleText: visibleTextOf(html),
        source: opts.source || 'composition',
    };
}

// ── Rules ──────────────────────────────────────────────────────────────────
//
// Each rule: { id, severity, why, scan(ctx) -> [{ snippet, line, hint }] }
// `why` is the plain-language reason shown to the author's repair round.

const SLOP_RULES = [

    // ── Visual details ─────────────────────────────────────────────────────
    {
        id: 'side-tab',
        severity: 'error',
        why: 'a thick coloured bar down one side of a card is the single most recognisable generated-design tell',
        brief: 'Never put an accent bar down the side of a card — `border-left: 3px solid <accent>` '
            + 'and every variant of it (border-inline-start, a thick top/bottom band). It is the most '
            + 'recognisable generated-design tell there is. If a block needs marking, use a short rule '
            + 'under its first line, an offset corner mark, or nothing at all and let the type carry it.',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector)) continue;
                if (/^@keyframes/i.test(b.selector)) continue;
                const widths = { top: 0, right: 0, bottom: 0, left: 0 };
                const colors = { top: null, right: null, bottom: null, left: null };
                let radius = 0;
                for (const d of b.decls) {
                    let m = d.prop.match(/^border-(top|right|bottom|left)$/);
                    if (m) {
                        const w = resolveLen(d.value, ctx);
                        if (Number.isFinite(w)) widths[m[1]] = w;
                        colors[m[1]] = colorTokenOf(d.value);
                        continue;
                    }
                    m = d.prop.match(/^border-(top|right|bottom|left)-width$/);
                    if (m) { const w = resolveLen(d.value, ctx); if (Number.isFinite(w)) widths[m[1]] = w; continue; }
                    m = d.prop.match(/^border-(top|right|bottom|left)-color$/);
                    if (m) { colors[m[1]] = d.value; continue; }
                    m = d.prop.match(/^border-inline-(start|end)$/);
                    if (m) {
                        const side = m[1] === 'start' ? 'left' : 'right';
                        const w = resolveLen(d.value, ctx);
                        if (Number.isFinite(w)) widths[side] = w;
                        colors[side] = colorTokenOf(d.value);
                        continue;
                    }
                    if (d.prop === 'border-radius') { const r = resolveLen(d.value, ctx); if (Number.isFinite(r)) radius = r; }
                    if (d.prop === 'border' && /^\s*[\d.]|^\s*(?:calc|min|max|var)\(/i.test(d.value)) {
                        const w = resolveLen(d.value, ctx);
                        if (Number.isFinite(w)) for (const k of Object.keys(widths)) widths[k] = w;
                        const c = colorTokenOf(d.value);
                        for (const k of Object.keys(colors)) colors[k] = c;
                    }
                }
                for (const side of ['top', 'right', 'bottom', 'left']) {
                    const w = widths[side];
                    if (!(w >= 2)) continue;
                    const others = ['top', 'right', 'bottom', 'left'].filter(s => s !== side).map(s => widths[s]);
                    const maxOther = Math.max(...others);
                    // must be the DOMINANT edge — a uniform border is not a tab
                    if (!(maxOther <= 1 || w >= maxOther * 2)) continue;
                    const info = resolveColor(colors[side] || '', ctx);
                    if (!info.chromatic) continue;
                    const isSide = side === 'left' || side === 'right';
                    if (isSide) {
                        if (radius > 0 || w >= 3) {
                            hits.push({
                                snippet: `${b.selector.slice(0, 60)} — border-${side}: ${w}px accent`,
                                line: b.line,
                                hint: 'delete the bar; if the block needs marking, use a short rule under the first line, an offset corner mark, or nothing at all and let the type carry it',
                            });
                        }
                    } else if (radius === 0 && w >= 3 && w <= 12) {
                        hits.push({
                            snippet: `${b.selector.slice(0, 60)} — border-${side}: ${w}px accent stripe`,
                            line: b.line,
                            hint: 'a thick coloured band across the top/bottom edge is the same tell rotated 90 degrees',
                        });
                    }
                }
            }
            return hits;
        },
    },

    {
        id: 'pseudo-side-bar',
        severity: 'error',
        why: 'a tall thin coloured bar parked beside a text block is the side-tab tell drawn as an element instead of a border — same stripe, same giveaway',
        brief: 'The same ban covers a stripe drawn as an ELEMENT rather than a border: an element under '
            + '18px wide and over 48px tall with a coloured background is the side-tab tell moved into '
            + 'markup — same stripe, same giveaway. Lay any mark on its side and keep it short.',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;

                let w = NaN, h = NaN, hidden = false, bg = null;
                for (const d of b.decls) {
                    if (d.prop === 'display' && /^\s*none/i.test(d.value)) hidden = true;
                    if (d.prop === 'width' || d.prop === 'min-width') {
                        const v = resolveLen(d.value, ctx);
                        if (Number.isFinite(v) && (!Number.isFinite(w) || v < w)) w = v;
                    }
                    if (d.prop === 'height' || d.prop === 'min-height') {
                        const v = resolveLen(d.value, ctx);
                        if (Number.isFinite(v) && (!Number.isFinite(h) || v > h)) h = v;
                    }
                    if (d.prop === 'background' || d.prop === 'background-color' || d.prop === 'background-image') {
                        bg = d.value;
                    }
                }
                if (hidden || !bg) continue;
                if (!Number.isFinite(w) || !Number.isFinite(h)) continue;

                // The shape that reads as a stripe: narrow enough to be a rule,
                // tall enough to run the height of a paragraph. A short mark
                // (a tick, a cap, a kicker rule) is legitimate editorial design
                // and must not be flagged, which is why the floor is 48px —
                // roughly one line of display type.
                if (!(w > 0 && w <= 18 && h >= 48)) continue;

                // A gradient counts as chromatic if any stop is; scan the whole
                // value, not just the first colour token.
                const tokens = String(bg).match(/var\(\s*--[\w-]+\s*(?:,[^)]*)?\)|(?:rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g) || [];
                const accent = tokens.map(t => resolveColor(t, ctx)).find(i => i.chromatic);
                if (!accent) continue;

                hits.push({
                    snippet: `${b.selector.slice(0, 60)} — ${w}x${h}px accent bar (${accent.varName || (accent.color ? toHex(accent.color) : 'chromatic')})`,
                    line: b.line,
                    hint: 'turn it on its side and shorten it — a rule above the kicker or under the first line reads as design; a full-height bar down the edge reads as a template',
                });
            }
            return hits;
        },
    },

    {
        id: 'border-accent-on-rounded',
        severity: 'error',
        why: 'a coloured edge on a rounded card is the auto-generated "callout" shape',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                let radius = 0;
                const widths = { top: 0, right: 0, bottom: 0, left: 0 };
                const colors = { top: null, right: null, bottom: null, left: null };
                for (const d of b.decls) {
                    if (d.prop === 'border-radius') { const r = resolveLen(d.value, ctx); if (Number.isFinite(r)) radius = r; }
                    let m = d.prop.match(/^border-(top|bottom)$/);
                    if (m) { const w = resolveLen(d.value, ctx); if (Number.isFinite(w)) widths[m[1]] = w; colors[m[1]] = colorTokenOf(d.value); }
                    m = d.prop.match(/^border-(top|bottom)-width$/);
                    if (m) { const w = resolveLen(d.value, ctx); if (Number.isFinite(w)) widths[m[1]] = w; }
                    m = d.prop.match(/^border-(top|bottom)-color$/);
                    if (m) colors[m[1]] = d.value;
                }
                if (radius <= 0) continue;
                for (const side of ['top', 'bottom']) {
                    const w = widths[side];
                    if (!(w >= 2)) continue;
                    const others = ['top', 'right', 'bottom', 'left'].filter(s => s !== side).map(s => widths[s]);
                    if (!(Math.max(...others) <= 1 || w >= Math.max(...others) * 2)) continue;
                    if (!resolveColor(colors[side] || '', ctx).chromatic) continue;
                    hits.push({
                        snippet: `${b.selector.slice(0, 60)} — border-${side}: ${w}px on radius ${radius}px`,
                        line: b.line,
                        hint: 'either drop the radius and keep a full-bleed rule, or drop the coloured edge — not both',
                    });
                }
            }
            return hits;
        },
    },

    // ── Typography ─────────────────────────────────────────────────────────
    {
        id: 'overused-font',
        severity: 'error',
        why: 'this face is in every generated design; it reads as a default, not a choice',
        scan(ctx) {
            const hits = [];
            const seen = new Set();
            const re = /font-family\s*:\s*([^;{}]+)/gi;
            let m;
            while ((m = re.exec(ctx.css)) !== null) {
                // Skip @font-face: that only DEFINES a face. Whether an overused
                // face is actually chosen is the theme contract's business
                // (Step 3), not the composition's.
                if (isInFontFace(ctx.css, m.index)) continue;
                const stack = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean);
                const primary = stack.find(f => !GENERIC_FONTS.has(f) && !f.startsWith('var('));
                if (!primary) continue;
                if (!OVERUSED_FONTS.has(primary)) continue;
                if (seen.has(primary)) continue;
                seen.add(primary);
                hits.push({
                    snippet: `font-family: ${primary}`,
                    line: lineOf(ctx.css, m.index),
                    hint: ctx.theme
                        ? `use the theme faces instead (heading "${ctx.theme.typography.headingFont}", body "${ctx.theme.typography.bodyFont}")`
                        : 'use the theme heading/body faces instead of a generic default',
                });
            }
            return hits;
        },
    },

    {
        id: 'flat-type-hierarchy',
        severity: 'warn',
        why: 'when every size is close together nothing leads the eye — real editorial design has a big jump between the headline and everything else',
        scan(ctx) {
            const sizes = [];
            const re = /font-size\s*:\s*([^;{}]+)/gi;
            let m;
            while ((m = re.exec(ctx.css)) !== null) {
                const px = lenPx(m[1], 100);
                if (Number.isFinite(px) && px > 4) sizes.push(Math.round(px));
            }
            const unique = [...new Set(sizes)].sort((a, b) => a - b);
            if (unique.length < 3) return [];
            const ratio = unique[unique.length - 1] / unique[0];
            if (ratio >= 2.0) return [];
            return [{
                snippet: `sizes ${unique.join('px, ')}px — only ${ratio.toFixed(1)}x from smallest to largest`,
                hint: 'push the headline much bigger, or the supporting text much smaller, so there is a clear first read',
            }];
        },
    },

    {
        id: 'tiny-text',
        severity: 'error',
        why: 'at video bitrates anything this small turns to mush on a phone',
        scan(ctx) {
            const hits = [];
            const re = /font-size\s*:\s*([^;{}]+)/gi;
            let m;
            while ((m = re.exec(ctx.css)) !== null) {
                const px = lenPx(m[1], 100);
                if (!Number.isFinite(px) || px <= 0) continue;
                if (px >= VIDEO.MIN_TEXT_PX) continue;
                hits.push({
                    snippet: `font-size: ${Math.round(px)}px`,
                    line: lineOf(ctx.css, m.index),
                    hint: `nothing on a 1920x1080 frame may be under ${VIDEO.MIN_TEXT_PX}px (body copy wants ${VIDEO.MIN_BODY_PX}px+)`,
                });
                if (hits.length >= 3) break;
            }
            return hits;
        },
    },

    {
        id: 'extreme-negative-tracking',
        severity: 'error',
        why: 'crushing the letters together is the generated-hero look, and it destroys legibility once the frame is compressed',
        scan(ctx) {
            const hits = [];
            const re = /letter-spacing\s*:\s*(-[\d.]+)\s*(em|px|rem)?/gi;
            let m;
            while ((m = re.exec(ctx.css)) !== null) {
                const n = parseFloat(m[1]);
                const unit = (m[2] || 'px').toLowerCase();
                const em = unit === 'em' ? n : (unit === 'rem' ? n : n / 60); // px vs a typical display size
                if (em > VIDEO.MIN_TRACKING_EM) continue;
                hits.push({
                    snippet: `letter-spacing: ${m[1]}${m[2] || 'px'}`,
                    line: lineOf(ctx.css, m.index),
                    hint: `keep tracking at or above ${VIDEO.MIN_TRACKING_EM}em`,
                });
                if (hits.length >= 2) break;
            }
            return hits;
        },
    },

    {
        id: 'wide-tracking',
        severity: 'warn',
        why: 'very wide letter-spacing on running text is hard to read and reads as filler styling',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                const ls = b.decls.find(d => d.prop === 'letter-spacing');
                if (!ls) continue;
                const m = String(ls.value).match(/([\d.]+)\s*(em|rem|px)?/);
                if (!m) continue;
                const unit = (m[2] || 'px').toLowerCase();
                const em = unit === 'em' || unit === 'rem' ? parseFloat(m[1]) : parseFloat(m[1]) / 40;
                if (!(em > VIDEO.MAX_BODY_TRACKING_EM)) continue;
                const isCapsLabel = b.decls.some(d => d.prop === 'text-transform' && /uppercase/i.test(d.value));
                if (isCapsLabel) continue;   // wide tracking on a short caps label is correct typography
                hits.push({ snippet: `${b.selector.slice(0, 50)} — letter-spacing: ${ls.value}`, line: b.line });
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'tight-leading',
        severity: 'error',
        why: 'lines that touch each other are unreadable in motion',
        // Quoted from the constants the rule itself measures against, so the
        // number the author is told can never disagree with the number it is
        // judged by.
        brief: `line-height floors: ${VIDEO.MIN_LEADING_DISPLAY} for display type (font-size ≥ `
            + `${VIDEO.DISPLAY_SIZE_PX}px), ${VIDEO.MIN_LEADING_BODY} for anything smaller. Lines that `
            + 'touch are readable on a still page and unreadable once the frame is moving.',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                const lh = b.decls.find(d => d.prop === 'line-height');
                if (!lh) continue;
                const raw = String(lh.value).trim();
                const fs = b.decls.find(d => d.prop === 'font-size');
                // `clamp(58px, 5.8vw, 110px)` — take the largest stop, that is
                // what the 1920-wide canvas actually renders at.
                const sizes = fs ? (String(fs.value).match(/[\d.]+\s*(?:px|rem|em|vw|vh|pt)/g) || []).map(t => lenPx(t, 100)).filter(Number.isFinite) : [];
                const fsPx = sizes.length ? Math.max(...sizes) : NaN;
                let ratio = NaN;
                if (/^[\d.]+$/.test(raw)) ratio = parseFloat(raw);
                else {
                    const lhPx = lenPx(raw, 100);
                    if (Number.isFinite(fsPx) && Number.isFinite(lhPx) && fsPx > 0) ratio = lhPx / fsPx;
                }
                if (!Number.isFinite(ratio)) continue;
                // A heavy, large numeral (a stat value) is a single line by
                // definition — line-height:1 is correct there, not cramped.
                const weight = parseInt((b.decls.find(d => d.prop === 'font-weight') || {}).value, 10) || 400;
                if (weight >= 800 && Number.isFinite(fsPx) && fsPx >= 28 && ratio >= 1) continue;
                // With no font-size in the same block the real size is
                // inherited and unknowable from the text alone. Judge those
                // against the display floor only — below 0.88 is too tight at
                // any size, so the finding still holds.
                const known = Number.isFinite(fsPx);
                const isDisplay = known && fsPx >= VIDEO.DISPLAY_SIZE_PX;
                const floor = (!known || isDisplay) ? VIDEO.MIN_LEADING_DISPLAY : VIDEO.MIN_LEADING_BODY;
                if (ratio >= floor) continue;
                hits.push({
                    snippet: `${b.selector.slice(0, 50)} — line-height: ${raw} (${ratio.toFixed(2)}x)${known ? ` on ${isDisplay ? 'display' : 'body'} type` : ''}`,
                    line: b.line,
                    hint: `needs line-height ${floor} or more`,
                });
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'justified-text',
        severity: 'error',
        why: 'justified text opens rivers of white space; it is never right at this measure',
        scan(ctx) {
            const hits = [];
            const re = /text-align\s*:\s*justify/gi;
            let m;
            while ((m = re.exec(ctx.css)) !== null) {
                hits.push({ snippet: 'text-align: justify', line: lineOf(ctx.css, m.index), hint: 'use left (or centre for titles)' });
                break;
            }
            return hits;
        },
    },

    {
        id: 'all-caps-body',
        severity: 'error',
        why: 'long runs of capitals cannot be read at a glance — capitals are for short labels only',
        scan(ctx) {
            const hits = [];
            // CSS-applied caps on a rule that also sets a body-ish size
            for (const b of ctx.blocks) {
                const tt = b.decls.find(d => d.prop === 'text-transform' && /uppercase/i.test(d.value));
                if (!tt) continue;
                const fs = b.decls.find(d => d.prop === 'font-size');
                const px = fs ? lenPx(fs.value, 100) : NaN;
                // a big display size in caps is a title; a small size in caps is body copy
                if (Number.isFinite(px) && px >= 56) continue;
                const cls = (b.selector.match(/\.([\w-]+)/g) || []).map(s => s.slice(1));
                const longRun = cls.some(c => {
                    const re = new RegExp(`class="[^"]*\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^"]*"[^>]*>([^<]{${VIDEO.ALL_CAPS_MAX_CHARS},})`, 'i');
                    return re.test(ctx.html);
                });
                if (!longRun) continue;
                hits.push({ snippet: `${b.selector.slice(0, 50)} — uppercase on a ${VIDEO.ALL_CAPS_MAX_CHARS}+ character run`, line: b.line });
            }
            // literal caps typed into the markup
            for (const m of ctx.html.matchAll(/>([^<]{45,})</g)) {
                const t = m[1].trim();
                const letters = t.replace(/[^A-Za-z]/g, '');
                if (letters.length < 30) continue;
                if (letters !== letters.toUpperCase()) continue;
                hits.push({ snippet: `"${t.slice(0, 40)}..." typed in capitals`, hint: 'write it in sentence case' });
                break;
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'italic-serif-display',
        severity: 'warn',
        why: 'the big italic serif headline is the current generated-editorial cliché',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                const it = b.decls.find(d => d.prop === 'font-style' && /italic|oblique/i.test(d.value));
                if (!it) continue;
                const fs = b.decls.find(d => d.prop === 'font-size');
                const px = fs ? lenPx(fs.value, 100) : NaN;
                if (!(Number.isFinite(px) && px >= 64)) continue;
                const ff = b.decls.find(d => d.prop === 'font-family');
                const stack = ff ? String(ff.value).toLowerCase() : '';
                const serif = /serif/.test(stack) || [...KNOWN_SERIF_FONTS].some(f => stack.includes(f));
                if (!serif) continue;
                hits.push({ snippet: `${b.selector.slice(0, 50)} — italic serif at ${Math.round(px)}px`, line: b.line });
            }
            return hits.slice(0, 1);
        },
    },

    {
        id: 'kicker-above-heading',
        severity: 'warn',
        why: 'a tiny all-caps line sitting above the headline is the generated "eyebrow" pattern',
        scan(ctx) {
            const text = ctx.html.replace(/\s+/g, ' ');
            const m = text.match(/>\s*([A-Z][A-Z0-9 .&'’-]{2,26})\s*<[^>]*>\s*<[^>]*>\s*[^<]{12,}/);
            if (!m) return [];
            return [{ snippet: `"${m[1].trim()}" sitting above the headline`, hint: 'delete it — say the thing, do not label the thing' }];
        },
    },

    {
        id: 'numbered-section-labels',
        severity: 'warn',
        why: '"01 —" style numbering is a generated-deck habit, not something a human editor adds',
        scan(ctx) {
            const hits = [];
            for (const m of ctx.html.matchAll(/>\s*(0\d)\s*[—–\-.\/]\s*(?=[A-Za-z<])/g)) {
                hits.push({ snippet: `"${m[1]} —" section label`, hint: 'drop the number, or make it a real design element instead of a prefix' });
                break;
            }
            return hits;
        },
    },

    // ── Colour & contrast ──────────────────────────────────────────────────
    {
        id: 'gradient-text',
        severity: 'error',
        why: 'gradient-filled type is a generated-hero signature and it smears badly under video compression',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector)) continue;
                const clip = b.decls.find(d => /^(-webkit-)?background-clip$/.test(d.prop) && /text/i.test(d.value));
                if (!clip) continue;
                const grad = b.decls.some(d => /gradient\(/i.test(d.value));
                if (!grad) continue;
                hits.push({ snippet: `${b.selector.slice(0, 50)} — gradient-filled text`, line: b.line, hint: 'fill the type with one solid colour' });
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'ai-color-palette',
        severity: 'warn',
        why: 'violet-plus-cyan on near-black (and the default slate greys) is the palette every generator reaches for',
        scan(ctx) {
            const hits = [];
            const colors = [];
            for (const m of ctx.css.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
                const c = parseColor(m[0]);
                if (c) colors.push({ c, hex: m[0].toLowerCase(), index: m.index });
            }
            // Tailwind slate defaults, the giveaway "I did not pick these" set
            const SLATE = new Set(['#0f172a', '#1e293b', '#334155', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0', '#f1f5f9', '#f8fafc']);
            const slateHits = colors.filter(x => SLATE.has(x.hex));
            if (slateHits.length >= 2) {
                hits.push({
                    snippet: `default slate greys: ${[...new Set(slateHits.map(x => x.hex))].slice(0, 4).join(', ')}`,
                    line: lineOf(ctx.css, slateHits[0].index),
                    hint: 'take the greys from the theme background/text instead of the framework defaults',
                });
            }
            // violet/indigo + cyan/sky pairing
            const violet = colors.filter(x => { const h = hueOf(x.c); return h >= 250 && h <= 290 && chroma(x.c) >= 60; });
            const cyan = colors.filter(x => { const h = hueOf(x.c); return h >= 175 && h <= 215 && chroma(x.c) >= 60; });
            if (violet.length && cyan.length) {
                hits.push({
                    snippet: `violet ${violet[0].hex} paired with cyan ${cyan[0].hex}`,
                    line: lineOf(ctx.css, violet[0].index),
                    hint: 'use the theme primary/accent — this pairing belongs to no theme in the project',
                });
            }
            // neon accent on a dark canvas
            if (!ctx.themeIsLight) {
                const neon = colors.find(x => chroma(x.c) >= 150 && luminance(x.c) > 0.35 && hueOf(x.c) >= 150 && hueOf(x.c) <= 220);
                if (neon && !violet.length && !cyan.length) {
                    hits.push({ snippet: `neon ${neon.hex} on a dark canvas`, line: lineOf(ctx.css, neon.index) });
                }
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'cream-palette',
        severity: 'warn',
        why: 'the beige/cream "premium editorial" canvas is a generated default — unless the theme actually asked for it',
        scan(ctx) {
            // Theme-aware: on a light warm theme (warm-editorial) a cream
            // surface is the DESIGN, not a tell. Only fire when the theme's own
            // background is dark or the theme is unknown.
            if (ctx.themeIsLight) return [];
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector)) continue;
                const bg = b.decls.find(d => d.prop === 'background' || d.prop === 'background-color');
                if (!bg) continue;
                const info = resolveColor(colorTokenOf(bg.value) || bg.value, ctx);
                const c = info.color;
                if (!c) continue;
                const isCream = luminance(c) > 0.6 && chroma(c) >= 10 && chroma(c) <= 45 && hueOf(c) >= 20 && hueOf(c) <= 60;
                if (!isCream) continue;
                hits.push({ snippet: `${b.selector.slice(0, 50)} — cream surface ${toHex(c)} on a dark theme`, line: b.line });
            }
            return hits.slice(0, 1);
        },
    },

    {
        id: 'dark-glow',
        severity: 'error',
        why: 'a coloured halo radiating evenly out of an element is not how light works; real depth comes from an offset shadow',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                for (const d of b.decls) {
                    if (d.prop !== 'box-shadow' && d.prop !== 'text-shadow') continue;
                    for (const layer of String(d.value).split(/,(?![^(]*\))/)) {
                        const tok = colorTokenOf(layer);
                        const info = resolveColor(tok || '', ctx);
                        if (!info.chromatic) continue;
                        const nums = (layer.replace(/(?:rgba?|hsla?|var)\([^)]*\)/gi, ' ').match(/-?[\d.]+(?:px|rem|em)?/g) || [])
                            .map(t => lenPx(t)).filter(Number.isFinite);
                        if (nums.length < 3 || nums[2] <= 4) continue;
                        if (nums[0] === 0 && nums[1] === 0) {
                            hits.push({
                                snippet: `${b.selector.slice(0, 46)} — zero-offset ${d.prop} glow ${info.color ? toHex(info.color) : info.varName}`,
                                line: b.line,
                                hint: 'give the shadow a downward offset and desaturate it, or remove it',
                            });
                        }
                    }
                }
            }
            return hits.slice(0, 3);
        },
    },

    {
        id: 'radial-halo',
        severity: 'warn',
        why: 'a soft radial glow parked behind the content is decoration with no meaning',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                for (const d of b.decls) {
                    if (!/^background(-image)?$/.test(d.prop)) continue;
                    if (!/radial-gradient\(/i.test(d.value)) continue;
                    const stops = d.value.match(/(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|var\(\s*--[\w-]+[^)]*\))/g) || [];
                    // A stop you can barely see is a tint or a scrim, not a halo.
                    const chromatic = stops.some(s => {
                        const info = resolveColor(s, ctx);
                        if (!info.chromatic) return false;
                        if (info.color && info.color.a < VIDEO.MIN_VISIBLE_ALPHA) return false;
                        return true;
                    });
                    if (!chromatic) continue;
                    if (!/transparent|rgba\([^)]*,\s*0(?:\.\d+)?\s*\)|0%\s*,|\b0\)/.test(d.value)) continue;
                    hits.push({ snippet: `${b.selector.slice(0, 50)} — radial glow behind content`, line: b.line });
                }
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'gpt-thin-border-wide-shadow',
        severity: 'warn',
        why: 'a 1px hairline plus a huge soft shadow is the default card recipe of every generator',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector)) continue;
                const border = b.decls.find(d => d.prop === 'border' || d.prop === 'border-width');
                if (!border) continue;
                const bw = lenPx(border.value);
                if (!(Number.isFinite(bw) && bw > 0 && bw <= 1.5)) continue;
                const shadow = b.decls.find(d => d.prop === 'box-shadow');
                if (!shadow) continue;
                const nums = (String(shadow.value).replace(/(?:rgba?|hsla?|var)\([^)]*\)/gi, ' ').match(/-?[\d.]+(?:px|rem|em)?/g) || []).map(t => lenPx(t));
                const offsetY = Math.abs(nums[1] || 0);
                const blur = nums[2];
                if (!(Number.isFinite(blur) && blur >= 24)) continue;
                // A big blur WITH a real downward offset is elevation — light
                // coming from above. The tell is the flat, offset-less haze.
                if (offsetY >= blur * 0.25) continue;
                hits.push({ snippet: `${b.selector.slice(0, 50)} — ${bw}px border + ${Math.round(blur)}px flat shadow (offset ${Math.round(offsetY)}px)`, line: b.line });
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'repeating-stripes-gradient',
        severity: 'warn',
        why: 'diagonal stripe wallpaper is filler texture, not design',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                if (!b.decls.some(d => /repeating-(linear|radial|conic)-gradient\s*\(/i.test(d.value))) continue;
                hits.push({ snippet: `${b.selector.slice(0, 50)} — repeating-gradient stripes`, line: b.line });
            }
            return hits.slice(0, 1);
        },
    },

    {
        id: 'codex-grid-background',
        severity: 'warn',
        why: 'the faint graph-paper grid behind the content is a generated-page signature',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                const bg = b.decls.find(d => /^background(-image)?$/.test(d.prop) && /linear-gradient\(/i.test(d.value));
                if (!bg) continue;
                // two perpendicular gradients (the classic grid recipe)
                const grads = String(bg.value).match(/linear-gradient\([^)]*\)/gi) || [];
                if (grads.length < 2) continue;
                const hasH = grads.some(g => /\b(90deg|to\s+right|to\s+left)\b/i.test(g));
                const hasV = grads.some(g => /\b(0deg|180deg|to\s+bottom|to\s+top)\b/i.test(g));
                if (!(hasH && hasV)) continue;
                const size = b.decls.find(d => d.prop === 'background-size');
                const cell = size ? lenPx(size.value) : NaN;
                if (Number.isFinite(cell) && cell > 160) continue;   // big panels are not a grid
                hits.push({ snippet: `${b.selector.slice(0, 50)} — graph-paper grid background`, line: b.line });
            }
            return hits.slice(0, 1);
        },
    },

    // ── Layout & space ─────────────────────────────────────────────────────
    {
        id: 'monotonous-spacing',
        severity: 'warn',
        why: 'when every gap is the same number nothing groups; spacing is how a design says what belongs together',
        scan(ctx) {
            const values = [];
            for (const m of ctx.css.matchAll(/(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*([^;{}]+)/gi)) {
                for (const t of String(m[1]).split(/\s+/)) {
                    const v = lenPx(t);
                    if (Number.isFinite(v) && v > 0 && v < 260) values.push(v);
                }
            }
            for (const m of ctx.css.matchAll(/\bgap\s*:\s*([^;{}]+)/gi)) {
                for (const t of String(m[1]).split(/\s+/)) {
                    const v = lenPx(t);
                    if (Number.isFinite(v) && v > 0 && v < 260) values.push(v);
                }
            }
            const rounded = values.map(v => Math.round(v / 4) * 4);
            if (rounded.length < 10) return [];
            const counts = {};
            for (const v of rounded) counts[v] = (counts[v] || 0) + 1;
            const max = Math.max(...Object.values(counts));
            const pct = max / rounded.length;
            const unique = [...new Set(rounded)];
            if (!(pct > 0.6 && unique.length <= 3)) return [];
            const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
            return [{ snippet: `${dominant}px used ${max}/${rounded.length} times (${Math.round(pct * 100)}%)`, hint: 'vary the spacing so related things sit closer than unrelated things' }];
        },
    },

    {
        id: 'nested-cards',
        severity: 'error',
        why: 'a box inside a box inside a box is how a machine organises information, not how a designer does',
        scan(ctx) {
            // A "card" here = an element whose class carries a rule with both a
            // painted background and a radius. Three levels deep in the markup
            // is the tell.
            const cardClasses = new Set();
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector)) continue;
                const hasBg = b.decls.some(d => /^background(-color|-image)?$/.test(d.prop) && !/none|transparent/i.test(d.value));
                const hasRadius = b.decls.some(d => d.prop === 'border-radius' && lenPx(d.value) >= 4);
                if (!hasBg || !hasRadius) continue;
                for (const m of b.selector.matchAll(/\.([\w-]+)/g)) cardClasses.add(m[1]);
            }
            if (cardClasses.size === 0) return [];
            // Walk the markup, tracking open-tag depth of card elements.
            let depth = 0, maxDepth = 0, deepest = '';
            const stack = [];
            const tagRe = /<(\/)?([a-zA-Z][\w-]*)([^>]*)>/g;
            let m;
            while ((m = tagRe.exec(ctx.html)) !== null) {
                const closing = !!m[1];
                const tag = m[2].toLowerCase();
                const attrs = m[3] || '';
                if (/\/\s*$/.test(attrs) || ['br', 'img', 'hr', 'input', 'source'].includes(tag)) continue;
                if (closing) {
                    const was = stack.pop();
                    if (was) depth--;
                    continue;
                }
                const cls = (attrs.match(/class\s*=\s*"([^"]*)"/i) || [])[1] || '';
                const isCard = cls.split(/\s+/).some(c => cardClasses.has(c));
                stack.push(isCard || false);
                if (isCard) {
                    depth++;
                    if (depth > maxDepth) { maxDepth = depth; deepest = cls.trim().slice(0, 44); }
                } else {
                    stack[stack.length - 1] = false;
                }
            }
            if (maxDepth < 3) return [];
            return [{ snippet: `card nested ${maxDepth} deep ("${deepest}")`, hint: 'flatten it — one surface, then content' }];
        },
    },

    {
        id: 'icon-tile-stack',
        severity: 'warn',
        why: 'a row of identical rounded icon squares is the generated feature-grid, not editorial design',
        scan(ctx) {
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector)) continue;
                const w = b.decls.find(d => d.prop === 'width');
                const h = b.decls.find(d => d.prop === 'height');
                const r = b.decls.find(d => d.prop === 'border-radius');
                const bg = b.decls.find(d => /^background(-color)?$/.test(d.prop) && !/none|transparent/i.test(d.value));
                if (!w || !h || !r || !bg) continue;
                const wp = lenPx(w.value), hp = lenPx(h.value), rp = lenPx(r.value);
                if (!(Number.isFinite(wp) && Number.isFinite(hp))) continue;
                if (Math.abs(wp - hp) > 2 || wp < 40 || wp > 180) continue;
                if (!(Number.isFinite(rp) && rp >= 6)) continue;
                const cls = (b.selector.match(/\.([\w-]+)/) || [])[1];
                if (!cls) continue;
                const uses = (ctx.html.match(new RegExp(`\\b${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || []).length;
                if (uses < 3) continue;
                return [{ snippet: `${uses} identical ${Math.round(wp)}px rounded tiles (.${cls})`, line: b.line, hint: 'vary them, or drop the tiles and let the labels stand alone' }];
            }
            return [];
        },
    },

    // ── Motion ─────────────────────────────────────────────────────────────
    {
        id: 'bounce-easing',
        severity: 'error',
        why: 'bounce/elastic overshoot is the default "make it feel alive" move and it reads as amateur on documentary footage',
        scan(ctx) {
            const hits = [];
            // CSS animations
            for (const m of ctx.css.matchAll(/animation(?:-name|-timing-function)?\s*:\s*([^;{}]+)/gi)) {
                const val = m[1];
                const tok = String(val).split(/[,\s]+/).find(p => /bounce|elastic|wobble|jiggle|spring/i.test(p));
                if (!tok) continue;
                hits.push({ snippet: `animation: ${tok}`, line: lineOf(ctx.css, m.index) });
                break;
            }
            // overshoot bezier in CSS
            for (const m of ctx.css.matchAll(/cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g)) {
                const y1 = parseFloat(m[2]), y2 = parseFloat(m[4]);
                if (y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1) {
                    hits.push({ snippet: `cubic-bezier(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]})`, line: lineOf(ctx.css, m.index) });
                    break;
                }
            }
            // GSAP eases in the timeline
            const tl = String(ctx.timeline || '');
            const gm = tl.match(/ease\s*:\s*["']((?:back|elastic|bounce)[^"']*)["']/i);
            if (gm) {
                hits.push({ snippet: `ease: "${gm[1]}"`, hint: 'use power2.out / power3.out / expo.out — settle, do not overshoot' });
            }
            return hits.slice(0, 2);
        },
    },

    {
        id: 'pulsing-dot',
        severity: 'error',
        why: 'the little pulsing "live" dot is pure generated-UI garnish',
        scan(ctx) {
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                const w = b.decls.find(d => d.prop === 'width');
                const r = b.decls.find(d => d.prop === 'border-radius');
                const anim = b.decls.find(d => /^animation/.test(d.prop) && /infinite/i.test(d.value));
                if (!w || !r || !anim) continue;
                const wp = lenPx(w.value);
                if (!(Number.isFinite(wp) && wp > 0 && wp <= 40)) continue;
                if (!/50%|9999px|999px/.test(r.value) && !(lenPx(r.value) >= wp / 2 - 1)) continue;
                return [{ snippet: `${b.selector.slice(0, 50)} — ${Math.round(wp)}px dot on an infinite pulse`, line: b.line }];
            }
            return [];
        },
    },

    {
        id: 'marquee',
        severity: 'error',
        why: 'an endlessly scrolling strip is filler motion that competes with the footage',
        scan(ctx) {
            if (/<\s*marquee\b/i.test(ctx.html)) return [{ snippet: '<marquee> element' }];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                const anim = b.decls.find(d => /^animation/.test(d.prop) && /infinite/i.test(d.value));
                if (!anim) continue;
                const name = String(anim.value).split(/[\s,]+/).find(t => /marquee|scroll|ticker|slide/i.test(t));
                if (!name) continue;
                return [{ snippet: `${b.selector.slice(0, 50)} — infinite ${name}`, line: b.line }];
            }
            return [];
        },
    },

    {
        id: 'blinking-cursor',
        severity: 'warn',
        why: 'the typewriter caret is a generated-terminal affectation',
        scan(ctx) {
            if (!/@keyframes\s+[\w-]*(blink|caret|cursor)/i.test(ctx.css)) return [];
            return [{ snippet: 'blinking caret keyframes' }];
        },
    },

    // ── Copy ───────────────────────────────────────────────────────────────
    {
        id: 'em-dash-overuse',
        severity: 'error',
        why: 'on-screen copy is short; more than one em dash in a single graphic is a machine writing habit',
        scan(ctx) {
            const dashes = (ctx.visibleText.match(/—/g) || []).length;
            if (dashes < 2) return [];
            return [{ snippet: `${dashes} em dashes in ${ctx.visibleText.length} characters of on-screen text`, hint: 'rewrite with a full stop or a comma' }];
        },
    },

    {
        id: 'marketing-buzzword',
        severity: 'warn',
        why: 'stock marketing language on screen reads as filler',
        scan(ctx) {
            const t = ctx.visibleText.toLowerCase();
            const hit = BUZZWORDS.find(w => t.includes(w));
            if (!hit) return [];
            return [{ snippet: `"${hit}" in on-screen text`, hint: 'say the specific thing the narration says' }];
        },
    },

    {
        id: 'aphoristic-cadence',
        severity: 'advisory',
        why: 'the "Not X. Y." construction is a machine cadence',
        scan(ctx) {
            const t = ctx.visibleText;
            if (!/\bNot\s+[a-z][^.?!]{2,30}\.\s+[A-Z]/.test(t)) return [];
            return [{ snippet: '"Not X. Y." construction' }];
        },
    },

    // ── Theme contract ─────────────────────────────────────────────────────
    //
    // These three are the only rules in the file that are not universal. They
    // are inert without opts.theme, which is why the gate can lint the
    // engine's theme-agnostic base stylesheet with the same function.

    // ── Surviving the codec ────────────────────────────────────────────────
    //
    // A web page is delivered to the eye exactly as it was drawn. A video is
    // re-encoded by YouTube first, and the encoder is not neutral: it discards
    // local contrast, halves colour resolution, and eats thin strokes. These
    // three rules are the ones a page-level detector has no reason to have.
    //
    // All three judge only what a block actually DECLARES. If a block sets a
    // text colour but no background, its contrast depends on an ancestor this
    // parser cannot see, and guessing would manufacture findings — so it is
    // skipped rather than assumed.

    {
        id: 'low-contrast-on-video',
        severity: 'error',
        why: 'text that is already below the still-image contrast floor cannot survive compression, because the encoder only ever removes contrast',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                const fgDecl = b.decls.find(d => d.prop === 'color');
                if (!fgDecl) continue;
                const bgDecl = b.decls.find(d => d.prop === 'background-color')
                    || b.decls.find(d => d.prop === 'background' && !/gradient|url\(/i.test(d.value));
                if (!bgDecl) continue;

                const fg = resolveColor(fgDecl.value, ctx).color;
                const bgRaw = resolveColor(colorTokenOf(bgDecl.value) || bgDecl.value, ctx).color;
                if (!fg || !bgRaw) continue;
                // A fully transparent background is not a background; the text
                // is sitting on footage and this rule has nothing to measure.
                if (Number.isFinite(bgRaw.a) && bgRaw.a <= 0.05) continue;

                // Translucent panels get flattened onto mid-grey — see
                // compositeOver. The text colour itself is flattened onto the
                // panel, because faded text over a panel is a real and common
                // way to land under the floor.
                const bg = compositeOver(bgRaw, ctx.themeBg);
                const ratio = contrastRatio(compositeOver(fg, bg), bg);
                if (!Number.isFinite(ratio)) continue;

                const sizeDecl = b.decls.find(d => d.prop === 'font-size');
                const sizePx = sizeDecl ? resolveLen(sizeDecl.value, ctx) : NaN;
                // Unknown size is treated as body copy. That is the strict
                // reading, and it is the right one: the floor it has to clear
                // is the floor for the smaller of the two possibilities.
                const isDisplay = Number.isFinite(sizePx) && sizePx >= VIDEO.DISPLAY_SIZE_PX;
                const floor = isDisplay ? VIDEO.CONTRAST_MIN_DISPLAY : VIDEO.CONTRAST_MIN_BODY;
                if (ratio >= floor) continue;

                hits.push({
                    snippet: `${b.selector.slice(0, 44)} — ${toHex(fg)} on ${toHex(bg)} is ${ratio.toFixed(1)}:1`,
                    line: b.line,
                    hint: `${isDisplay ? 'Display' : 'Body'} text needs at least ${floor}:1 before compression — darken the panel or brighten the text.`,
                });
            }
            return hits.slice(0, 4);
        },
    },

    {
        id: 'hairline-weight',
        severity: 'warn',
        why: 'strokes this thin are reconstructed by the encoder rather than reproduced, so the text arrives broken up or grey',
        scan(ctx) {
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                const wDecl = b.decls.find(d => d.prop === 'font-weight');
                if (!wDecl) continue;
                const weight = parseFloat(wDecl.value);
                if (!Number.isFinite(weight) || weight >= VIDEO.REGULAR_WEIGHT) continue;
                const sizeDecl = b.decls.find(d => d.prop === 'font-size')
                    || b.decls.find(d => d.prop === 'font' && /\d/.test(d.value));
                const sizePx = sizeDecl ? resolveLen(sizeDecl.value, ctx) : NaN;
                // No size in this block means the size is inherited from a
                // parent this parser cannot resolve. Skipping is the honest
                // answer — a thin weight on a big headline is good typography.
                if (!Number.isFinite(sizePx) || sizePx <= 0) continue;

                const effective = sizePx * weight / VIDEO.REGULAR_WEIGHT;
                if (effective >= VIDEO.MIN_TEXT_PX) continue;
                hits.push({
                    snippet: `${b.selector.slice(0, 44)} — ${Math.round(sizePx)}px at weight ${weight} draws like ${Math.round(effective)}px regular`,
                    line: b.line,
                    hint: `Take the weight up to ${VIDEO.REGULAR_WEIGHT} or the size up — anything drawing below ${VIDEO.MIN_TEXT_PX}px of stroke is lost after upload.`,
                });
            }
            return hits.slice(0, 3);
        },
    },

    {
        id: 'video-unsafe-saturation',
        severity: 'warn',
        why: 'a saturated red or magenta carried by fine detail smears under 4:2:0 chroma subsampling, because those hues live almost entirely in the channel the encoder halves',
        // The theme's OWN palette is exempt, and that is a measured decision
        // rather than a softening. Two of the eight shipped themes anchor a hue
        // inside this band on purpose — crime on crimson (#dc143c) and modern
        // on orangered (#ff4500) — so a rule without this exemption would flag
        // those themes every time a graphic used the colour the theme exists to
        // be. That is the same failure `off-theme-radius` documents: a rule
        // that argues with a deliberate decision teaches the author to abandon
        // it. What is left is the real target — a composition inventing a
        // saturated hue nobody chose, which is where the generated look lives.
        // The exemption reads `ctx.contract`, so adding a theme extends it for
        // free and no second list can drift.
        scan(ctx) {
            const themeHues = ctx.contract ? ctx.contract.hues : [];
            const risky = (color) => {
                if (!color) return false;
                if (chroma(color) < VIDEO.CHROMA_RISK_MIN) return false;
                const h = hueOf(color);
                if (h < 0) return false;
                if (!(h >= VIDEO.CHROMA_RISK_HUE_LOW || h <= VIDEO.CHROMA_RISK_HUE_HIGH)) return false;
                return !themeHues.some(t => hueDistance(h, t.hue) <= CONTRACT.HUE_TOLERANCE);
            };
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                for (const d of b.decls) {
                    // Fine detail only. The same colour as a full-bleed panel
                    // fill is perfectly safe — it is edges that smear, so the
                    // rule is scoped to text and to strokes narrow enough to be
                    // treated as edges.
                    let feature = null;
                    if (d.prop === 'color') feature = 'text';
                    else if (/^border(-[a-z]+)?(-color)?$/.test(d.prop) || d.prop === 'stroke') {
                        const w = lenPx(d.value);
                        const wDecl = b.decls.find(x => x.prop === 'border-width' || x.prop === 'stroke-width');
                        const width = Number.isFinite(w) && w > 0 ? w : (wDecl ? lenPx(wDecl.value) : NaN);
                        if (Number.isFinite(width) && width > VIDEO.CHROMA_RISK_MAX_STROKE_PX) continue;
                        feature = 'hairline';
                    }
                    if (!feature) continue;
                    const color = resolveColor(colorTokenOf(d.value) || d.value, ctx).color;
                    if (!risky(color)) continue;
                    hits.push({
                        snippet: `${b.selector.slice(0, 40)} — ${feature} in ${toHex(color)} (hue ${Math.round(hueOf(color))}°)`,
                        line: b.line,
                        hint: 'Pull the saturation back or move the hue off pure red/magenta — the same colour is safe as a large fill, not as fine detail.',
                    });
                    break;
                }
            }
            return hits.slice(0, 3);
        },
    },

    {
        id: 'off-theme-font',
        severity: 'error',
        why: 'this face is not one the theme declares, so the video changes typeface partway through for no reason a viewer can see',
        scan(ctx) {
            const k = ctx.contract;
            if (!k || !k.fonts.size) return [];
            const hits = [];
            const seen = new Set();
            for (const b of ctx.blocks) {
                if (/^@font-face/i.test(b.selector)) continue;
                for (const d of b.decls) {
                    if (d.prop !== 'font-family' && d.prop !== 'font') continue;
                    // Already spending the contract — nothing to check.
                    if (/var\(\s*--hf-/i.test(d.value)) continue;

                    let value = d.value;
                    if (d.prop === 'font') {
                        // Shorthand: the family list is whatever follows the
                        // size (and optional /line-height). Checking only
                        // font-family would leave `font:` as a way round the
                        // rule, which is exactly the kind of hole that makes a
                        // gate decorative.
                        const m = value.match(/\d[\d.]*\s*(?:px|pt|em|rem|%)?(?:\s*\/\s*[\d.]+[a-z%]*)?\s+(.+)$/i);
                        if (!m) continue;
                        value = m[1];
                    }

                    for (const face of splitFontStack(value)) {
                        if (!face || GENERIC_FONT_FAMILIES.has(face)) continue;
                        if (/^\d/.test(face) || face.startsWith('var(')) continue;
                        if (k.fonts.has(face)) continue;
                        if (seen.has(face)) break;
                        seen.add(face);
                        hits.push({
                            snippet: `${b.selector} uses "${face}"`,
                            line: b.line,
                            hint: `use var(--hf-heading-font) or var(--hf-body-font) — on this theme those are ${k.slots.heading || 'the heading face'} and ${k.slots.body || 'the body face'}`,
                        });
                        break;
                    }
                }
            }
            return hits.slice(0, 4);
        },
    },

    {
        id: 'off-theme-color',
        severity: 'error',
        why: 'this hue is in no part of the theme palette, so the graphic introduces a colour the rest of the video never uses',
        scan(ctx) {
            const k = ctx.contract;
            if (!k || !k.hues.length) return [];
            const hits = [];
            const seen = new Set();
            for (const b of ctx.blocks) {
                // Film grades and effect layers are allowed their own colour —
                // a sepia wash is the point of a sepia wash.
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                for (const d of b.decls) {
                    if (!CONTRACT_COLOR_PROPS.test(d.prop)) continue;
                    if (/var\(\s*--hf-/i.test(d.value)) continue;
                    for (const token of d.value.match(CONTRACT_COLOR_TOKEN_RE) || []) {
                        const c = parseColor(token);
                        if (!c) continue;
                        // Nearly transparent, or a neutral: a scrim, a plate or
                        // a hairline. Those carry no palette decision.
                        if (c.a < 0.12) continue;
                        if (chroma(c) < CONTRACT.MIN_TEST_CHROMA) continue;
                        const h = hueOf(c);
                        if (h < 0) continue;
                        let nearest = 999;
                        for (const t of k.hues) nearest = Math.min(nearest, hueDistance(h, t.hue));
                        if (nearest <= CONTRACT.HUE_TOLERANCE) continue;
                        const hex = toHex(c);
                        if (seen.has(hex)) continue;
                        seen.add(hex);
                        hits.push({
                            snippet: `${b.selector} { ${d.prop}: … ${hex} … }`,
                            line: b.line,
                            hint: `use var(--hf-primary) / var(--hf-accent) / var(--hf-text) — this theme's palette is ${k.paletteNote}`,
                        });
                    }
                }
            }
            return hits.slice(0, 4);
        },
    },

    {
        // off-theme-color catches a surface painted the WRONG hue. It cannot
        // catch a surface painted NO hue, because it skips anything under
        // MIN_TEST_CHROMA as "a scrim, a plate or a hairline". Flat neutral
        // grey — the single most machine-made-looking surface there is — went
        // through untouched. That is how the built-in comparison card shipped
        // the same slate slabs under all 8 themes: it belonged to no video.
        //
        // The hard part is that a scrim is ALSO flat neutral, and a scrim is
        // legitimate — a dark wash over the creator's footage is how text stays
        // readable. So this rule does not ask "is it grey", it asks "is this a
        // wash, or is it paper". A wash covers the frame, carries no content of
        // its own, and lets the footage through. Paper is bounded, or holds
        // content, or is opaque enough that nothing shows through it — and
        // paper has to come from the theme.
        id: 'off-theme-surface',
        severity: 'error',
        why: 'this surface is painted a fixed colour instead of the theme\'s, so the graphic looks identical in every theme and belongs to no video',
        scan(ctx) {
            const SURFACE_PROPS = /^(background|background-color|background-image)$/;
            // Laying out CHILDREN, not just insetting text. Deliberately does not
            // include bare `padding`: a full-bleed scrim commonly pads its caption
            // away from the frame edge, and counting that as structure made the
            // bottom-up gradient on `.hf-variant-overlay .hf-template-stage` read
            // as a card. A gap, a rule, a shadow or a grid/flex container is a
            // thing built to hold content — that is what paper does.
            const STRUCTURE_PROPS = /^(gap|row-gap|column-gap|box-shadow)$/;
            const hits = [];
            const seen = new Set();

            const declaresFullBleed = b => b.decls.some(d => (
                (d.prop === 'inset' && /^\s*0(\s+0)*\s*$/.test(d.value))
                || (/^(top|right|bottom|left)$/.test(d.prop) && /^\s*0\s*$/.test(d.value))
            ));

            // Covering the frame is a property of the ELEMENT, but CSS spreads
            // one element's declarations across many rules — the base class
            // carries `inset: 0` and a modifier class carries the paint. Judging
            // each rule alone made every modifier look like a bounded box, so
            // `.hf-agentic-shade.hf-agentic-media-blur-background` — a 30%
            // wash over footage — read as a card. Resolve it per class instead.
            const fullBleedClasses = new Set();
            for (const b of ctx.blocks) {
                if (!declaresFullBleed(b)) continue;
                // Seed only from selector parts that are a lone class. A compound
                // selector like `.hf-has-bg .hf-x` would hand the exemption to
                // classes that never asked for it — but a comma list of plain
                // classes is still each of those classes declaring it, which is
                // how `.hf-template-stage` (declared in a four-way list) was
                // missed and its scrim modifier flagged as a card.
                for (const part of b.selector.split(',')) {
                    const m = part.trim().match(/^(\.[A-Za-z0-9_-]+)$/);
                    if (m) fullBleedClasses.add(m[1]);
                }
            }

            // A background value's comma-separated LAYERS, ignoring the commas
            // inside gradient() and rgba(). One element can carry a transparent
            // radial highlight over an opaque base; judging the value as one
            // blob let the highlight's `transparent` stop vouch for the solid
            // slab underneath it.
            const splitLayers = splitTopLevel;

            // Remove the parts of a value that already read the theme, so what
            // is left is only the hardcoded paint. A value is not off-theme just
            // because it contains a literal — `color-mix(in srgb, var(--hf-bg),
            // #000 14%)` uses one as a darkening AMOUNT, which is fine. But a
            // literal standing on its own as a gradient stop beside theme
            // tokens is a real off-theme surface, and treating "mentions
            // var(--hf-" as a blanket pass let one through: the split-variant
            // comparison divider was themed at both ends and slate in the
            // middle. Drop balanced color-mix()/var() groups that name a theme
            // token; judge whatever survives.
            const stripThemeExpressions = value => {
                let out = '';
                for (let i = 0; i < value.length; i++) {
                    const head = value.slice(i).match(/^(color-mix|var)\s*\(/i);
                    if (head) {
                        let depth = 0;
                        let j = i + head[0].length - 1;
                        for (; j < value.length; j++) {
                            if (value[j] === '(') depth++;
                            else if (value[j] === ')' && --depth === 0) break;
                        }
                        const group = value.slice(i, j + 1);
                        if (/--hf-/i.test(group)) { i = j; continue; }
                    }
                    out += value[i];
                }
                return out;
            };

            for (const b of ctx.blocks) {
                // Film grades, grain, vignettes and transition flares are
                // allowed their own colour — that colour IS the effect.
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                // The composition root is the video frame itself, not a surface
                // inside a graphic. Nothing is layered behind it to theme against.
                if (/#yta-hyperframes\s*$|^(html|body)\b/i.test(b.selector.trim())) continue;
                // A replaced media element. `object-fit` only exists on img/video,
                // and the background there is the void a contained clip does not
                // reach — frame furniture, not a surface a graphic is drawn on.
                if (b.decls.some(d => d.prop === 'object-fit')) continue;

                const isStructure = b.decls.some(d => (
                    STRUCTURE_PROPS.test(d.prop)
                    || (d.prop === 'display' && /\b(grid|flex)\b/i.test(d.value))
                    || (/^border(-(top|right|bottom|left))?$/.test(d.prop)
                        && !/^\s*(0|none)\b/i.test(d.value))
                ));
                const selectorClasses = b.selector.match(/\.[A-Za-z0-9_-]+/g) || [];
                const fullBleed = declaresFullBleed(b)
                    || selectorClasses.some(c => fullBleedClasses.has(c));

                for (const d of b.decls) {
                    if (!SURFACE_PROPS.test(d.prop)) continue;
                    if (/^\s*(none|transparent|inherit|initial|unset|currentColor)\s*$/i.test(d.value)) continue;

                    const judged = stripThemeExpressions(d.value);
                    const tokens = judged.match(CONTRACT_COLOR_TOKEN_RE) || [];
                    const painted = tokens.map(parseColor).filter(c => c && c.a >= 0.15);
                    // Nothing hardcoded survived: the surface reads the theme.
                    if (!painted.length) continue;

                    // Does any single layer hide what is behind it everywhere?
                    // A scrim always has somewhere you can see through — a stop
                    // at zero alpha, or a fill thin enough to read footage under.
                    // A layer with no such escape is opaque paint, and paint
                    // that covers the creator's footage has to be the theme's.
                    const opaqueLayer = splitLayers(judged).some(layer => {
                        const stops = (layer.match(CONTRACT_COLOR_TOKEN_RE) || [])
                            .map(parseColor).filter(Boolean);
                        if (!stops.length) return false;
                        if (/\btransparent\b/i.test(layer)) return false;
                        return stops.every(c => c.a >= 0.5);
                    });

                    // A wash: covers the frame, builds nothing, and lets the
                    // footage through. That is legitimate and stays neutral.
                    if (fullBleed && !isStructure && !opaqueLayer) continue;

                    const hex = toHex(painted[0]);
                    const key = `${b.selector}|${d.prop}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    hits.push({
                        snippet: `${b.selector} { ${d.prop}: … ${hex} … }`,
                        line: b.line,
                        hint: 'paint surfaces from the theme — color-mix(in srgb, var(--hf-surface), transparent 12%) '
                            + 'for a card, var(--hf-bg) for a backdrop. A fixed literal here looks the same under all 8 themes.',
                    });
                }
            }
            return hits.slice(0, 6);
        },
    },

    {
        id: 'off-theme-radius',
        severity: 'error',
        why: 'the corners are rounder than the theme allows, and an inflated radius is what turns any card into the same friendly product card',
        // DIRECTIONAL, on purpose. Measured against 92 real authored
        // compositions on warm-editorial (radius 10): the author writes 1px,
        // 2px, 3px — consistently HARDER than the theme, never softer. That is
        // an editorial choice and a good one; a near-square corner is nobody's
        // idea of generated design. The failure this rule exists to catch runs
        // the other way: radius inflating until every card is a 28px squircle.
        // So only rounder-than-declared is drift. A symmetric tolerance would
        // have flagged all 92 of those comps and taught the author to soften
        // its corners — the precise opposite of the point.
        scan(ctx) {
            const k = ctx.contract;
            if (!k || !k.radii.length) return [];
            const ceiling = Math.max(...k.radii) + CONTRACT.RADIUS_TOLERANCE;
            const hits = [];
            for (const b of ctx.blocks) {
                if (isFxSelector(b.selector) || /^@keyframes/i.test(b.selector)) continue;
                for (const d of b.decls) {
                    if (!/^border(-[a-z]+)?-radius$/.test(d.prop)) continue;
                    if (/var\(\s*--hf-/i.test(d.value)) continue;
                    // A percentage is a circle or an ellipse — a shape choice,
                    // not a corner-softness choice, so the theme radius has no
                    // opinion on it.
                    if (d.value.includes('%')) continue;
                    for (const token of d.value.split(/[\s/]+/)) {
                        const px = lenPx(token);
                        if (!Number.isFinite(px) || px <= ceiling) continue;
                        if (px >= CONTRACT.RADIUS_PILL_PX) continue;
                        hits.push({
                            snippet: `${b.selector} { ${d.prop}: ${token} }`,
                            line: b.line,
                            hint: `use var(--hf-radius) — this theme's radius is ${k.radii[0]}px, so ${Math.round(px)}px is not its shape`,
                        });
                        break;
                    }
                }
            }
            return hits.slice(0, 4);
        },
    },
];

const RULE_IDS = SLOP_RULES.map(r => r.id);
const RULE_BY_ID = new Map(SLOP_RULES.map(r => [r.id, r]));

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * slopLint({ html, css, timeline }, opts) -> { ok, errors, findings, counts }
 *
 * opts:
 *   theme   — token object from data/themes.js:getThemeTokens (optional but
 *             strongly preferred: it makes the colour/font rules contract-aware)
 *   vars    — extra CSS custom properties to resolve var() against
 *   kind    — 'overlay' | 'fullscreen' | 'template'
 *   only    — array of rule ids to run (default: all)
 *   disable — array of rule ids to skip
 *   source  — label used in messages ('composition' | 'engine stylesheet' | ...)
 *
 * `errors` holds only severity:'error' findings, phrased as instructions, so
 * they can be appended straight onto the author's repair round.
 */
function slopLint(comp, opts = {}) {
    const ctx = buildContext(comp || {}, opts || {});
    const only = opts.only && opts.only.length ? new Set(opts.only) : null;
    const disable = new Set(opts.disable || []);
    const findings = [];
    for (const rule of SLOP_RULES) {
        if (only && !only.has(rule.id)) continue;
        if (disable.has(rule.id)) continue;
        let hits;
        try { hits = rule.scan(ctx) || []; } catch (_) { continue; }
        for (const h of hits) {
            findings.push({
                id: rule.id,
                severity: rule.severity,
                why: rule.why,
                snippet: h.snippet || '',
                line: h.line || 0,
                hint: h.hint || '',
            });
        }
    }
    const counts = {};
    for (const f of findings) counts[f.id] = (counts[f.id] || 0) + 1;
    const errors = findings
        .filter(f => f.severity === 'error')
        .map(f => `${f.id}: ${f.snippet} — ${f.why}${f.hint ? `. ${f.hint}` : ''}`);
    return { ok: errors.length === 0, errors, findings, counts };
}

/**
 * scanStyleText(css, opts) — same rules against a bare stylesheet (the render
 * engine's own base CSS, or a generated build page). No markup, so the
 * markup-dependent rules simply find nothing.
 */
function scanStyleText(css, opts = {}) {
    return slopLint({ css, html: '', timeline: '' }, { ...opts, source: opts.source || 'stylesheet' });
}

module.exports = {
    slopLint,
    scanStyleText,
    buildThemeContract,
    CONTRACT,
    SLOP_RULES,
    RULE_IDS,
    RULE_BY_ID,
    // exported for the video-native rules in hf-motion-sameness and for tests
    OVERUSED_FONTS,
    FX_EXEMPT_PREFIXES,
    VIDEO,
    // exported so hf-author-repair can test exactly what the contract rules
    // test. A repair that restated any of these would drift out of step with
    // the rule it is trying to clear, and would then be silently discarded.
    CONTRACT_COLOR_PROPS,
    CONTRACT_COLOR_TOKEN_RE,
    GENERIC_FONT_FAMILIES,
    splitFontStack,
    hueDistance,
    parseBlocks,
    parseDecls,
    parseColor,
    resolveColor,
    colorTokenOf,
    lenPx,
    luminance,
    chroma,
    hueOf,
    toHex,
};
