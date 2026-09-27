'use strict';

/**
 * Non-bundled → bundled font substitution for the render build.
 *
 * The capture browser has no network and no system fonts: the only faces it can
 * resolve are the ones `buildFontFaces()` emits an @font-face for from
 * assets/fonts/. Any other named face silently renders as a generic fallback, so
 * HyperFrames' lint refuses the render for it (`font_family_without_font_face`).
 * That refusal is correct — a shipped video with the wrong typeface is worse than
 * a failed render — so the cure is to hand the check a face it can actually
 * resolve, never to silence it.
 *
 * The faces that trip it are usually *tail fallbacks* on an otherwise-bundled
 * stack (a theme's `"Bebas Neue", Oswald, "Fjalla One", Impact, sans-serif`
 * blocked a finished build). The lint flags every name in the stack, not just the
 * one that wins, and it is right to: a name the renderer cannot resolve has no
 * business in a render stack. Dropping such a tail is visually inert by
 * construction — it could never have rendered — while substituting a *leading*
 * face genuinely repairs the typography.
 *
 * The "available" side is read back out of the @font-face rules in the finished
 * HTML rather than from a hand-kept list, so it is by definition the same set the
 * lint calls declared, and it automatically tracks assets/fonts/ plus the
 * language scoping that drops the CJK faces from a non-CJK render.
 */

/**
 * Non-bundled family → bundled stand-ins, best match first. Candidates are tried
 * in order and the first one actually bundled wins, so a row stays correct if a
 * font is added to or removed from assets/fonts/. Generic CSS keywords are always
 * usable as a target (nothing to bundle). Adding a substitution is one line.
 */
const FONT_SUBSTITUTIONS = {
    // ── Condensed display / poster faces ─────────────────────────────────────
    'impact': ['Bebas Neue', 'Oswald', 'Fjalla One'],
    'haettenschweiler': ['Bebas Neue', 'Oswald', 'Fjalla One'],
    'anton': ['Bebas Neue', 'Oswald', 'Fjalla One'],
    'league gothic': ['Bebas Neue', 'Oswald', 'Fjalla One'],
    'oswald': ['Oswald', 'Bebas Neue', 'Fjalla One'],
    'bebas neue': ['Bebas Neue', 'Oswald', 'Fjalla One'],
    'fjalla one': ['Fjalla One', 'Oswald', 'Bebas Neue'],
    'arial narrow': ['Barlow Condensed', 'Roboto Condensed', 'Oswald'],
    'din condensed': ['Barlow Condensed', 'Roboto Condensed', 'Oswald'],
    'din alternate': ['Barlow Condensed', 'Roboto Condensed', 'Montserrat'],

    // ── Heavy grotesques ─────────────────────────────────────────────────────
    'arial black': ['Montserrat', 'Work Sans', 'Oswald'],
    'franklin gothic heavy': ['Montserrat', 'Work Sans', 'Oswald'],
    'franklin gothic': ['Work Sans', 'Montserrat', 'Source Sans Pro'],
    'futura': ['Montserrat', 'Work Sans', 'Karla'],
    'gill sans': ['Karla', 'Work Sans', 'Source Sans Pro'],

    // ── Neutral sans ─────────────────────────────────────────────────────────
    'helvetica': ['Karla', 'Lato', 'Source Sans Pro'],
    'helvetica neue': ['Karla', 'Lato', 'Source Sans Pro'],
    'arial': ['Karla', 'Lato', 'Source Sans Pro'],
    'inter': ['Karla', 'Source Sans Pro', 'Lato'],
    'roboto': ['Source Sans Pro', 'Lato', 'Karla'],
    'segoe ui': ['Karla', 'Lato', 'Source Sans Pro'],
    'verdana': ['Source Sans Pro', 'Lato', 'Karla'],
    'tahoma': ['Source Sans Pro', 'Lato', 'Karla'],
    'trebuchet ms': ['Lato', 'Karla', 'Source Sans Pro'],
    'calibri': ['Lato', 'Karla', 'Source Sans Pro'],
    'noto sans': ['Source Sans Pro', 'Lato', 'Karla'],
    'poppins': ['Montserrat', 'Work Sans', 'Karla'],
    'montserrat': ['Montserrat', 'Work Sans'],

    // ── Serif ────────────────────────────────────────────────────────────────
    'times': ['Lora', 'Libre Baskerville', 'Spectral'],
    'times new roman': ['Lora', 'Libre Baskerville', 'Spectral'],
    'georgia': ['Lora', 'Spectral', 'Libre Baskerville'],
    'garamond': ['Spectral', 'Lora', 'Libre Baskerville'],
    'eb garamond': ['Spectral', 'Lora', 'Libre Baskerville'],
    'baskerville': ['Libre Baskerville', 'Lora', 'Spectral'],
    'palatino': ['Lora', 'Spectral', 'Libre Baskerville'],
    'book antiqua': ['Lora', 'Spectral', 'Libre Baskerville'],
    'cambria': ['Lora', 'Spectral', 'Libre Baskerville'],
    'didot': ['Playfair Display', 'Libre Baskerville', 'Lora'],
    'bodoni': ['Playfair Display', 'Libre Baskerville', 'Lora'],
    'playfair display': ['Playfair Display', 'Libre Baskerville', 'Lora'],

    // ── Monospace ────────────────────────────────────────────────────────────
    // Nothing monospaced is bundled, and a proportional stand-in would break the
    // one thing a mono face is chosen for, so fall through to the generic.
    'courier': ['monospace'],
    'courier new': ['monospace'],
    'consolas': ['monospace'],
    'menlo': ['monospace'],
    'monaco': ['monospace'],
    'sf mono': ['monospace'],
    'jetbrains mono': ['monospace'],
    'ibm plex mono': ['monospace'],
    'source code pro': ['monospace'],
};

/**
 * Generic CSS font keywords, mirrored from the HyperFrames lint's own
 * GENERIC_FAMILIES. These name no installable file, so the lint never demands an
 * @font-face for them and neither do we. Kept in step deliberately: a keyword we
 * dropped but the lint accepts would be a silent, pointless typography change.
 */
const GENERIC_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
    'math', 'emoji', 'fangsong',
    '-apple-system', 'blinkmacsystemfont',
    'inherit', 'initial', 'unset', 'revert',
]);

/** Preference order for the last-resort default, filtered to what is bundled. */
const DEFAULT_HEADING_ORDER = ['Oswald', 'Bebas Neue', 'Montserrat', 'Work Sans', 'Fjalla One'];
const DEFAULT_BODY_ORDER = ['Lato', 'Karla', 'Source Sans Pro', 'Open Sans', 'Roboto Condensed'];

/** `font-family`, plus the custom properties the themes pipe stacks through. */
const FONT_DECL_RE = /(font-family|--[A-Za-z0-9-]*font[A-Za-z0-9-]*)\s*:\s*([^;{}]+)/gi;
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/gi;

function decodeAttr(value) {
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, '&');
}

function encodeAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Split a stack on top-level commas, leaving quotes and `var(...)` intact. */
function splitStack(value) {
    const parts = [];
    let buf = '';
    let depth = 0;
    let quote = null;
    for (const ch of String(value)) {
        if (quote) {
            buf += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
        buf += ch;
    }
    parts.push(buf);
    return parts.map(p => p.trim()).filter(Boolean);
}

function quoteFamily(name) {
    return /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : `"${name}"`;
}

/** The faces the render can actually resolve: whatever @font-face declares. */
function collectDeclaredFamilies(html) {
    const available = new Map();
    for (const rule of String(html).match(FONT_FACE_RE) || []) {
        const m = rule.match(/font-family\s*:\s*(["']?)([^;'"]+)\1/i);
        const family = m && m[2] ? m[2].trim() : '';
        if (family) available.set(family.toLowerCase(), family);
    }
    return available;
}

function firstAvailable(order, available) {
    for (const name of order) {
        const hit = available.get(name.toLowerCase());
        if (hit) return hit;
    }
    return available.size ? available.values().next().value : null;
}

/**
 * The theme's own default faces, read from the stacks this render already uses
 * rather than restated here, so the fallback lands on the theme instead of on a
 * fixed favourite that would look imported into every other theme.
 */
function deriveDefaults(html, available) {
    const flat = decodeAttr(html);
    const fromVar = (prop) => {
        const m = flat.match(new RegExp(`--hf-${prop}-font\\s*:\\s*([^;{}]+)`, 'i'));
        if (!m) return null;
        for (const part of splitStack(m[1])) {
            const bare = part.replace(/^["']|["']$/g, '').trim();
            const hit = available.get(bare.toLowerCase());
            if (hit) return hit;
        }
        return null;
    };
    return {
        heading: fromVar('heading') || firstAvailable(DEFAULT_HEADING_ORDER, available),
        body: fromVar('body') || firstAvailable(DEFAULT_BODY_ORDER, available),
    };
}

function pickSubstitute(key, available) {
    for (const candidate of FONT_SUBSTITUTIONS[key] || []) {
        const ck = candidate.toLowerCase();
        if (GENERIC_FAMILIES.has(ck)) return candidate;
        const hit = available.get(ck);
        if (hit) return hit;
    }
    return null;
}

/**
 * Rewrite one stack so every named face in it is bundled (or a generic keyword).
 * Returns null when nothing changed, so untouched declarations stay byte-identical.
 */
function rewriteStack(value, ctx, kind, record) {
    const out = [];
    const seen = new Set();
    let changed = false;
    let hasResolvable = false;

    const push = (text, key) => {
        if (key && seen.has(key)) { changed = true; return; }
        if (key) seen.add(key);
        out.push(text);
    };

    for (const part of splitStack(value)) {
        // A var() may resolve to a bundled face; it is rewritten at its own
        // definition, so pass it through and count it as resolvable.
        if (/^var\(/i.test(part)) { push(part, null); hasResolvable = true; continue; }

        const bare = part.replace(/^["']|["']$/g, '').trim();
        if (!bare) { changed = true; continue; }
        const key = bare.toLowerCase();

        if (GENERIC_FAMILIES.has(key)) { push(bare, key); continue; }

        const bundled = ctx.available.get(key);
        if (bundled) {
            if (bundled !== bare) changed = true;
            push(quoteFamily(bundled), key);
            hasResolvable = true;
            continue;
        }

        const substitute = pickSubstitute(key, ctx.available);
        if (substitute) {
            changed = true;
            record(bare, substitute);
            push(quoteFamily(substitute), substitute.toLowerCase());
            hasResolvable = true;
            continue;
        }

        // Unmapped and unbundled: it can never render. Drop it, and if that
        // leaves nothing resolvable, the theme default is added below.
        changed = true;
        record(bare, null);
    }

    if (!hasResolvable) {
        const fallback = ctx.defaults[kind] || ctx.defaults.body || ctx.defaults.heading;
        if (!fallback) return null;
        const key = fallback.toLowerCase();
        if (!seen.has(key)) {
            out.unshift(quoteFamily(fallback));
            seen.add(key);
            changed = true;
        }
    }

    if (!changed || !out.length) return null;
    return out.join(', ');
}

function kindOf(prop) {
    return /heading|display|title|stat/i.test(prop) ? 'heading' : 'body';
}

/** Rewrite the font declarations in a CSS string, skipping @font-face bodies. */
function rewriteCss(css, ctx, record, { skipFontFace = true } = {}) {
    const skip = [];
    if (skipFontFace) {
        FONT_FACE_RE.lastIndex = 0;
        let f;
        while ((f = FONT_FACE_RE.exec(css)) !== null) skip.push([f.index, f.index + f[0].length]);
    }
    const inSkip = (i) => skip.some(([s, e]) => i >= s && i < e);

    let out = '';
    let last = 0;
    let changed = false;
    FONT_DECL_RE.lastIndex = 0;
    let m;
    while ((m = FONT_DECL_RE.exec(css)) !== null) {
        if (inSkip(m.index)) continue;
        const valueStart = m.index + m[0].length - m[2].length;
        const trailing = m[2].length - m[2].trimEnd().length;
        const rewritten = rewriteStack(m[2].trim(), ctx, kindOf(m[1]), record);
        if (rewritten === null) continue;
        out += css.slice(last, valueStart) + rewritten;
        last = valueStart + m[2].length - trailing;
        changed = true;
    }
    if (!changed) return null;
    return out + css.slice(last);
}

/**
 * Rewrite every font stack in the finished composition HTML so it names only
 * faces this render bundles. Runs on the built HTML, which is the one place that
 * sees every source of a stack at once — theme tokens, authored compositions,
 * templates and directives — so a face none of them agreed to check still cannot
 * reach the renderer.
 */
function substituteRenderFonts(html, { log = console.log } = {}) {
    const source = String(html || '');
    const available = collectDeclaredFamilies(source);
    if (!available.size) return { html: source, substitutions: [] };

    const ctx = { available, defaults: deriveDefaults(source, available) };
    const tally = new Map();
    const record = (from, to) => {
        const label = `${from} → ${to || 'dropped (unrenderable)'}`;
        tally.set(label, (tally.get(label) || 0) + 1);
    };

    let out = source.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (whole, open, body, close) => {
        const rewritten = rewriteCss(body, ctx, record);
        return rewritten === null ? whole : open + rewritten + close;
    });

    out = out.replace(/\bstyle=(["'])([\s\S]*?)\1/gi, (whole, q, body) => {
        if (!/font/i.test(body)) return whole;
        const rewritten = rewriteCss(decodeAttr(body), ctx, record, { skipFontFace: false });
        return rewritten === null ? whole : `style=${q}${encodeAttr(rewritten)}${q}`;
    });

    const substitutions = [...tally.entries()].map(([label, count]) => ({ label, count }));
    if (substitutions.length && typeof log === 'function') {
        const summary = substitutions.map(s => `${s.label}${s.count > 1 ? ` (×${s.count})` : ''}`).join(', ');
        log(`[HyperFrames] Font substitution: ${summary}`);
    }
    return { html: out, substitutions };
}

module.exports = {
    substituteRenderFonts,
    collectDeclaredFamilies,
    FONT_SUBSTITUTIONS,
    GENERIC_FAMILIES,
};
