/**
 * hf-design-doc.js — Generate the DESIGN block for the composition author.
 *
 * The author skill (skills/hyperframes-template/SKILL.md) requires every
 * composition to trace its palette/typography to a DESIGN doc. This module
 * derives that doc from the project's single source of visual truth:
 * theme tokens (src/themes.js getThemeTokens) + optional Style Studio
 * profile + niche. Pure, no AI call.
 */
'use strict';

let getThemeTokens = () => ({});
try { ({ getThemeTokens } = require('../data/themes')); } catch (_) { /* tokens optional */ }

// Design-intelligence math (WCAG contrast, luminance). Optional at load time.
let _di = null;
try { _di = require('../agents/design-intelligence'); } catch (_) { /* optional */ }

// The anti-slop checker's ban list, IMPORTED rather than restated — a second
// copy here would drift and this doc would go back to recommending faces the
// gate rejects. Empty set if the module is unavailable: the doc degrades to
// "no advice" rather than to "wrong advice".
let OVERUSED_FONTS = new Set();
let SLOP_RULES = [];
try { ({ OVERUSED_FONTS, SLOP_RULES } = require('./hf-slop-lint')); } catch (_) { /* optional */ }

// The rendered-pixel checker's title-safe box. Imported, never restated: the
// author must be told the same number it is measured against.
let TITLE_SAFE = null;
try { ({ TITLE_SAFE } = require('./hf-visual-lint')); } catch (_) { /* optional */ }

// Faces that are BOTH shipped in assets/fonts (so the render browser can embed
// them — it has no network) and absent from the ban list. Used only when a
// theme's whole stack is unusable, which should never happen; theme-font-
// contract.js is the gate that keeps it that way.
const SAFE_HEADING_STACK = '"Work Sans", sans-serif';
const SAFE_BODY_STACK = '"Source Sans Pro", sans-serif';

function _familyName(part) {
    return String(part || '').trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
}

/**
 * A font stack is a FALLBACK CHAIN, but the author reads it as a menu.
 *
 * The overused-font rule only judges the PRIMARY face, so a stack like
 * `"Barlow Condensed", Lato, Arial, sans-serif` passes the gate — and then
 * this doc hands the whole string to the composition author, which reasonably
 * picks a name out of the middle and gets rejected for it. In the 2026-08-04
 * build that one confusion was the single largest cause of authoring failures:
 * the rejection even quoted the banned face back as the fix, because the theme
 * legitimately listed it downstream of a clean primary.
 *
 * So the chain the AUTHOR sees is filtered even though the chain the RENDERER
 * uses is not. Generic keywords (serif/sans-serif) survive: they are how CSS
 * degrades, not a face anyone can choose by name.
 */
function _authorSafeStack(stack, fallback) {
    const kept = String(stack || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .filter(part => !OVERUSED_FONTS.has(_familyName(part)));
    // A chain of nothing but generics names no face at all — useless as a
    // direction. Treat it the same as an empty stack.
    const namesAFace = kept.some(part => !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(part.trim()));
    if (!kept.length || !namesAFace) return fallback;
    if (!/^(serif|sans-serif|monospace|cursive|fantasy)$/i.test(kept[kept.length - 1])) {
        kept.push(/serif/i.test(stack) && !/sans-serif/i.test(stack) ? 'serif' : 'sans-serif');
    }
    return kept.join(', ');
}

const THEME_MOODS = {
    crime:    'tense, investigative, high-contrast — evidence-room energy, hard shadows, red accents used sparingly like crime-scene tape',
    history:  'archival, documentary gravitas — aged paper warmth, serif confidence, measured pacing',
    modern:   'sleek tech-forward broadcast — glassy panels, precise grids, cool light',
    minimal:  'calm editorial restraint — generous whitespace, one accent, nothing decorative',
    standard: 'clean professional explainer — confident, neutral, broadcast-news polish',
    'warm-editorial': 'warm print-magazine editorial — cream paper, burnt-orange emphasis, serif headlines, hand-crafted calm; charts look like a beautiful almanac, not a dashboard',
    luxury: 'understated opulence — deep black, soft gold lines, champagne serif type, generous spacing; nothing shouts, everything gleams',
    nature: 'documentary naturalism — deep forest tones, organic shapes, soft light; data feels like field notes',
};

// True WCAG relative luminance (sRGB-linearized) when design-intelligence is
// available; falls back to a perceptual average. White→1, black→0.
function _lum(hex) {
    if (_di && typeof _di.relativeLuminance === 'function') return _di.relativeLuminance(hex);
    const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Deterministic WCAG contrast audit of the theme's own text/background token
// pairs. Any pair below AA (4.5:1 body) is surfaced to the author so it never
// places unreadable text — closes the "white caption on a light panel" gap.
function _contrastNotes(c) {
    if (!_di || typeof _di.validateContrast !== 'function' || typeof _di.flatten !== 'function') return '';
    const bgHex = c.background || '#000000';
    // Panel surfaces are often translucent (rgba) → composite over the canvas
    // so the measured background matches what the eye actually sees.
    const surfEff = _di.flatten(c.surface, bgHex); // {r,g,b} or null
    const pairs = [
        ['text-primary on background', c.textPrimary, c.background],
        ['text-secondary on background', c.textSecondary, c.background],
        ['text-primary on surface/panel', c.textPrimary, surfEff],
        ['text-secondary on surface/panel', c.textSecondary, surfEff],
    ].filter(([, fg, bg]) => fg && bg);
    const lines = [];
    for (const [label, fgRaw, bgRaw] of pairs) {
        // Flatten a translucent text color over its own background before measuring.
        const bgForFlatten = (bgRaw && typeof bgRaw === 'object') ? null : bgRaw;
        const fg = bgForFlatten ? (_di.flatten(fgRaw, bgForFlatten) || fgRaw) : fgRaw;
        const v = _di.validateContrast(fg, bgRaw);
        if (v.unknown) continue; // couldn't parse a color → don't emit a false warning
        if (!v.AA) lines.push(`- ⚠️ ${label} = ${v.ratio}:1 — FAILS WCAG AA (needs 4.5:1). Do NOT use this pair for body text; enlarge/bold it, put it on a scrim, or use a darker/lighter tone.`);
    }
    if (!lines.length) return '';
    return `\n## Contrast (WCAG — enforce)\nEvery text element must clear 4.5:1 against whatever sits behind it (add a scrim/plate over footage). Known unsafe pairs in this palette:\n${lines.join('\n')}\n`;
}

function generateDesignDoc({ themeId = 'standard', styleProfile = null, nicheId = '' } = {}) {
    const tokens = getThemeTokens(themeId) || {};
    const c = tokens.colors || {};
    const t = tokens.typography || {};
    const chrome = tokens.chrome || {};
    const mood = (styleProfile && styleProfile.mood) || THEME_MOODS[themeId] || THEME_MOODS.standard;

    const colorLines = [
        ['primary (brand/emphasis)', c.primary],
        ['accent (highlights/data)', c.accent],
        ['background (canvas)', c.background],
        ['surface (panels/cards)', c.surface],
        ['text-primary', c.textPrimary],
        ['text-secondary', c.textSecondary],
        ['stroke (rules/borders)', c.stroke],
    ].filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n');

    // Name the banned faces outright. Before this, the rule existed only in the
    // checker: the author wrote CSS blind, reached for whichever web font is
    // most common, and lost a composition to a rule it was never shown. One
    // repair round later it fell back to the built-in card. Listing the faces
    // costs a line of prompt and converts a silent rejection into a constraint.
    const bannedFontLine = OVERUSED_FONTS.size
        ? `\nBANNED FACES — naming any of these is an automatic rejection, even as a fallback: ${[...OVERUSED_FONTS].sort().join(', ')}.`
        : '';

    const notTo = [
        'Default grays (#333/#666/#999), default blues (#3b82f6), Roboto/system-default type',
        'Centered bordered box as the layout for every scene',
        'Uniform fade-in/fade-out on everything',
        chrome.glow === false ? 'Neon glows on text (this theme is glow-free — use weight and contrast instead)' : null,
        chrome.shadowStyle === 'hard' ? 'Soft blurry shadows (this theme uses hard offset shadows)' : null,
        styleProfile && styleProfile.avoid ? String(styleProfile.avoid) : null,
    ].filter(Boolean).map(s => `- ${s}`).join('\n');

    // ── The rules the checker enforces, finally stated to the author ───────
    //
    // Every line below already existed — inside the linter only. The author
    // wrote CSS blind, broke a rule it had never been shown, and paid with a
    // repair round and then a fall back to the generic built-in card: exactly
    // the machine-made look this document exists to prevent. In the 2026-08-04
    // build these accounted for 8 of the 15 non-font rejections, and not one of
    // them appeared anywhere in the prompt or the skill.
    //
    // Sourced from the live rule objects and the live safe-area constants, never
    // retyped — otherwise a threshold gets tightened in the checker while the
    // brief goes on quoting the old number, which is how the font rules drifted
    // apart in the first place.
    const houseRules = (SLOP_RULES || [])
        .filter(r => r && r.brief && r.severity === 'error')
        .map(r => `- ${r.brief}`);
    if (TITLE_SAFE) {
        houseRules.push(
            `- Keep TEXT out of the bottom ${TITLE_SAFE.bottomPx}px of the 1080px frame (nothing below `
            + `y=${TITLE_SAFE.bottomLine}px): YouTube paints its progress bar and control row there and `
            + `will sit on it. Stay ${TITLE_SAFE.topPx}px clear of the top edge and ${TITLE_SAFE.edgePx}px `
            + 'clear of each side too. Panels, plates and imagery may bleed to the edge — a bleed is a '
            + 'design choice, a covered word is not.'
        );
    }
    houseRules.push(
        '- No two text elements may overlap. They are measured as RENDERED boxes at the busiest frame, '
        + 'not as you pictured them: give them real vertical separation instead of trusting a transform '
        + 'to have moved one of them out of the way by then.'
    );
    const houseRulesBlock = houseRules.length
        ? `\n## House rules (the checker enforces these — a breach is a rejection)\n${houseRules.join('\n')}\n`
        : '';

    const profileExtra = styleProfile && styleProfile.style_prompt_full
        ? `\n## Style profile (learned from reference video)\n${String(styleProfile.style_prompt_full).slice(0, 900)}\n`
        : '';

    return `# DESIGN — theme "${themeId}"${nicheId ? ` · niche "${nicheId}"` : ''}

## Style Prompt
${mood}. Built for a 1920×1080 faceless YouTube video; every composition must
read instantly at thumbnail size — one dominant element per scene.${_lum(c.background) > 0.4 ? '\nLIGHT CANVAS THEME: the canvas is LIGHT — use text-primary (a dark tone) for text, never white-on-light. Panels are paper tones, not dark slabs. Shadows are soft and warm. Accents carry the color; the canvas stays calm.' : ''}

## Colors (use these exact values)
${colorLines || '- primary: #e8e8e8\n- background: #0b1018\n- text-primary: #ffffff'}

## Typography (CLOSED SET — copy a stack verbatim, never name another face)
- Headings: ${_authorSafeStack(t.headingFont, SAFE_HEADING_STACK)} — weight ${t.headingWeight || '800'}
- Body: ${_authorSafeStack(t.bodyFont, SAFE_BODY_STACK)} — weight ${t.bodyWeight || '500'}
- Numbers/stats: ${_authorSafeStack(t.statFont || t.headingFont, SAFE_HEADING_STACK)} — weight ${t.statWeight || '900'}

Every \`font-family\` you write must be one of the three stacks above, copied
character for character. The render browser has NO network — only these faces
are embedded, so any other name silently falls back to a system default and the
composition is rejected.${bannedFontLine}

## Chrome
- Corner radius: ${chrome.borderRadius != null ? chrome.borderRadius + 'px' : '10px'} · stroke width: ${chrome.strokeWidth || 2}px
- Shadows: ${chrome.shadowStyle || 'soft'}${chrome.glow ? ' · subtle glow allowed on accents' : ' · no glow'}
- Panel fill: ${c.surface || 'rgba(8,12,20,0.9)'}
${profileExtra}${_contrastNotes(c)}${houseRulesBlock}
## What NOT to do
${notTo}
`;
}

// _authorSafeStack is exported so the deterministic repair pass substitutes the
// SAME stack the brief recommended. Two independent notions of "the safe face
// for this theme" is exactly how the checker and the brief drifted apart.
module.exports = { generateDesignDoc, authorSafeStack: _authorSafeStack, SAFE_HEADING_STACK, SAFE_BODY_STACK };
