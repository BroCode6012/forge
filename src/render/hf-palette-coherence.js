'use strict';

const {
    contrastRatio,
    flatten,
    parseColor,
    relativeLuminance,
    rgbToHex,
} = require('../agents/design-intelligence');

const LIGHT_TEXT = '#fffaf2';
const DARK_TEXT = '#11100e';

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function opaqueColor(value, backdrop = '#111111') {
    return flatten(value, backdrop) || flatten(backdrop, '#111111') || { r: 17, g: 17, b: 17 };
}

function mixRgb(from, to, amount) {
    const a = typeof from === 'object' ? from : parseColor(from);
    const b = typeof to === 'object' ? to : parseColor(to);
    if (!a || !b) return null;
    const t = clamp(Number(amount) || 0, 0, 1);
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
    };
}

function bestNeutral(background) {
    const darkRatio = contrastRatio(DARK_TEXT, background) || 0;
    const lightRatio = contrastRatio(LIGHT_TEXT, background) || 0;
    return lightRatio >= darkRatio ? LIGHT_TEXT : DARK_TEXT;
}

function ensureReadable(color, background, targetRatio, options = {}) {
    const parsed = parseColor(color);
    const currentRatio = parsed ? contrastRatio(parsed, background) : null;
    if (Number.isFinite(currentRatio) && currentRatio >= targetRatio) return color;
    if (options.locked && parsed) return color;

    const neutral = bestNeutral(background);
    if (!parsed) return neutral;
    const target = parseColor(neutral);
    for (let amount = 0.12; amount <= 1.001; amount += 0.08) {
        const mixed = mixRgb(parsed, target, amount);
        if (mixed && (contrastRatio(mixed, background) || 0) >= targetRatio) {
            return rgbToHex(mixed.r, mixed.g, mixed.b);
        }
    }
    return neutral;
}

function harmonizeVisualPalette({
    surface,
    background,
    text,
    textMuted,
    primary,
    accent,
    textLocked = false,
} = {}) {
    const canvas = parseColor(background) ? background : '#111111';
    const effectiveSurface = opaqueColor(surface, canvas);
    const luminance = relativeLuminance(effectiveSurface);
    const coherentText = ensureReadable(text, effectiveSurface, 4.5, { locked: textLocked });
    const coherentMuted = ensureReadable(textMuted || coherentText, effectiveSurface, 4.5);
    const coherentPrimary = ensureReadable(primary || coherentText, effectiveSurface, 3);
    const coherentAccent = ensureReadable(accent || coherentPrimary, effectiveSurface, 3);

    return {
        surface,
        effectiveSurface,
        tone: luminance != null && luminance >= 0.48 ? 'dark' : 'light',
        text: coherentText,
        textMuted: coherentMuted,
        primary: coherentPrimary,
        accent: coherentAccent,
        ratios: {
            text: contrastRatio(parseColor(coherentText), effectiveSurface),
            textMuted: contrastRatio(parseColor(coherentMuted), effectiveSurface),
            primary: contrastRatio(parseColor(coherentPrimary), effectiveSurface),
            accent: contrastRatio(parseColor(coherentAccent), effectiveSurface),
        },
    };
}

module.exports = {
    DARK_TEXT,
    LIGHT_TEXT,
    ensureReadable,
    harmonizeVisualPalette,
    mixRgb,
    opaqueColor,
};
