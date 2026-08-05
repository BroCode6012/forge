'use strict';

const {
    contrastRatio,
    parseColor,
} = require('../agents/design-intelligence');

const VERSION = 1;
const DEFAULT_TARGET_RATIO = 4.5;
const DEFAULT_SAMPLE_PERCENTILE = 0.12;
const LIGHT_TEXT = '#fffaf2';
const DARK_TEXT = '#11100e';

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function percentile(values, fraction = DEFAULT_SAMPLE_PERCENTILE) {
    const finite = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) return null;
    const index = clamp(Math.floor((finite.length - 1) * fraction), 0, finite.length - 1);
    return finite[index];
}

function normalizeSample(sample) {
    if (Array.isArray(sample) && sample.length >= 3) {
        return {
            r: clamp(Number(sample[0]) || 0, 0, 255),
            g: clamp(Number(sample[1]) || 0, 0, 255),
            b: clamp(Number(sample[2]) || 0, 0, 255),
        };
    }
    if (sample && typeof sample === 'object') {
        return {
            r: clamp(Number(sample.r) || 0, 0, 255),
            g: clamp(Number(sample.g) || 0, 0, 255),
            b: clamp(Number(sample.b) || 0, 0, 255),
        };
    }
    return null;
}

function robustContrast(color, samples, fraction = DEFAULT_SAMPLE_PERCENTILE) {
    const parsed = parseColor(color);
    if (!parsed) return null;
    const ratios = (samples || [])
        .map(normalizeSample)
        .filter(Boolean)
        .map((sample) => contrastRatio(parsed, sample))
        .filter(Number.isFinite);
    return percentile(ratios, fraction);
}

function compositeSample(sample, scrim, alpha) {
    const bg = normalizeSample(sample);
    const fg = parseColor(scrim);
    if (!bg || !fg) return bg;
    const a = clamp(alpha * (fg.a == null ? 1 : fg.a), 0, 1);
    return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
    };
}

function scrimAlphaFor(color, samples, scrim, targetRatio, fraction) {
    let low = 0;
    let high = 0.88;
    const atHigh = robustContrast(
        color,
        (samples || []).map((sample) => compositeSample(sample, scrim, high)),
        fraction
    );
    if (!Number.isFinite(atHigh) || atHigh < targetRatio) return high;
    for (let i = 0; i < 12; i++) {
        const mid = (low + high) / 2;
        const ratio = robustContrast(
            color,
            (samples || []).map((sample) => compositeSample(sample, scrim, mid)),
            fraction
        );
        if (Number.isFinite(ratio) && ratio >= targetRatio) high = mid;
        else low = mid;
    }
    return clamp(high + 0.025, 0, 0.88);
}

function uniqueColors(values) {
    const seen = new Set();
    const out = [];
    for (const value of values || []) {
        const color = String(value || '').trim();
        if (!parseColor(color)) continue;
        const key = color.toLowerCase().replace(/\s+/g, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(color);
    }
    return out;
}

function chooseAdaptiveContrast({
    samples = [],
    preferredText = LIGHT_TEXT,
    preferredAccent = preferredText,
    explicitText = false,
    targetRatio = DEFAULT_TARGET_RATIO,
    samplePercentile = DEFAULT_SAMPLE_PERCENTILE,
    forceProtection = false,
    contrastTone = 'auto',
} = {}) {
    const stableTone = contrastTone === 'light' || contrastTone === 'dark'
        ? contrastTone
        : 'auto';
    const stableText = stableTone === 'light'
        ? LIGHT_TEXT
        : (stableTone === 'dark' ? DARK_TEXT : preferredText);
    const normalizedSamples = samples.map(normalizeSample).filter(Boolean);
    if (!normalizedSamples.length) {
        return {
            textColor: explicitText ? preferredText : stableText,
            accentColor: explicitText ? (preferredAccent || preferredText) : stableText,
            ratio: null,
            preferredRatio: null,
            scrimColor: stableTone === 'dark' ? '#ffffff' : '#000000',
            scrimAlpha: forceProtection ? 0.5 : 0,
            adjustedText: !explicitText && String(stableText).toLowerCase() !== String(preferredText).toLowerCase(),
            explicitText,
            contrastTone: stableTone,
        };
    }

    const preferredRatio = robustContrast(preferredText, normalizedSamples, samplePercentile);
    const candidates = explicitText
        ? uniqueColors([preferredText])
        : (
            stableTone === 'light'
                ? uniqueColors([LIGHT_TEXT])
                : (
                    stableTone === 'dark'
                        ? uniqueColors([DARK_TEXT])
                        : uniqueColors([preferredText, LIGHT_TEXT, '#ffffff', DARK_TEXT, '#000000'])
                )
        );
    let textColor = candidates[0] || preferredText;
    let ratio = robustContrast(textColor, normalizedSamples, samplePercentile);

    if (!(Number.isFinite(preferredRatio) && preferredRatio >= targetRatio) && !explicitText) {
        for (const candidate of candidates.slice(1)) {
            const candidateRatio = robustContrast(candidate, normalizedSamples, samplePercentile);
            if (!Number.isFinite(candidateRatio)) continue;
            if (!Number.isFinite(ratio) || candidateRatio > ratio) {
                textColor = candidate;
                ratio = candidateRatio;
            }
        }
    }

    let scrimColor = '#000000';
    let scrimAlpha = 0;
    if (forceProtection || !Number.isFinite(ratio) || ratio < targetRatio) {
        const darkAlpha = stableTone === 'dark'
            ? 0.88
            : scrimAlphaFor(
                textColor,
                normalizedSamples,
                '#000000',
                targetRatio,
                samplePercentile
            );
        const lightAlpha = stableTone === 'light'
            ? 0.88
            : scrimAlphaFor(
                textColor,
                normalizedSamples,
                '#ffffff',
                targetRatio,
                samplePercentile
            );
        const darkRatio = robustContrast(
            textColor,
            normalizedSamples.map((sample) => compositeSample(sample, '#000000', darkAlpha)),
            samplePercentile
        );
        const lightRatio = robustContrast(
            textColor,
            normalizedSamples.map((sample) => compositeSample(sample, '#ffffff', lightAlpha)),
            samplePercentile
        );
        if (stableTone === 'dark' || (
            (Number.isFinite(lightRatio) ? lightRatio : 0) > (Number.isFinite(darkRatio) ? darkRatio : 0)
            || (
                Math.abs((lightRatio || 0) - (darkRatio || 0)) < 0.05
                && lightAlpha < darkAlpha
            )
        )) {
            scrimColor = '#ffffff';
            scrimAlpha = lightAlpha;
            ratio = lightRatio;
        } else {
            scrimColor = '#000000';
            scrimAlpha = darkAlpha;
            ratio = darkRatio;
        }
        if (forceProtection) scrimAlpha = Math.max(0.5, scrimAlpha);
    }

    let accentColor = preferredAccent || textColor;
    const accentRatio = robustContrast(accentColor, normalizedSamples, samplePercentile);
    if (!Number.isFinite(accentRatio) || accentRatio < 3) accentColor = textColor;

    return {
        textColor,
        accentColor,
        ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
        preferredRatio: Number.isFinite(preferredRatio)
            ? Math.round(preferredRatio * 100) / 100
            : null,
        scrimColor,
        scrimAlpha: Math.round(clamp(scrimAlpha, 0, 0.88) * 1000) / 1000,
        adjustedText: !explicitText && String(textColor).toLowerCase() !== String(preferredText).toLowerCase(),
        explicitText,
        contrastTone: stableTone,
    };
}

function buildAdaptiveContrastCss() {
    return `
    /* Footage-aware readability. Theme tokens express identity; these rules
       only protect copy when the actual pixels underneath cannot support it. */
    .hf-mg[data-hf-adaptive-contrast="1"] { isolation: isolate; }
    .hf-mg[data-hf-adaptive-contrast="1"][data-hf-text-explicit="0"][data-hf-contrast-tone="light"] {
      --hf-text: #fffaf2 !important;
      --hf-muted: rgba(255,250,242,0.82) !important;
      color: #fffaf2;
    }
    .hf-mg[data-hf-adaptive-contrast="1"][data-hf-text-explicit="0"][data-hf-contrast-tone="dark"] {
      --hf-text: #11100e !important;
      --hf-muted: rgba(17,16,14,0.78) !important;
      color: #11100e;
    }
    .hf-mg[data-hf-adaptive-contrast="1"][data-hf-text-explicit="0"] :is(
      .hf-title, .hf-subtitle, .hf-item, .hf-item-value, .hf-item-label,
      .hf-agentic-title, .hf-agentic-subtitle, .hf-agentic-kicker,
      .hf-agentic-item-value, .hf-agentic-item-label, .hf-agentic-item-subtext,
      .hf-agentic-reason, .hf-template-title, .hf-template-subtitle,
      .hf-template-fallback-title, .hf-template-fallback-subtitle,
      [data-hf-layout-critical]
    ) {
      color: var(--hf-text) !important;
      fill: var(--hf-text) !important;
    }
    /* hf-agentic-text-range is deliberately NOT in that list.
     *
     * data-hf-text-explicit answers "did anyone pick a text colour" for the
     * card as a WHOLE. A per-word range is a narrower answer to the same
     * question, and the bridge only ever emits the class when a colour was
     * actually chosen (buildStyledTextMarkup: no colour, no span at all). So
     * every span this used to catch was an explicit decision, and the
     * !important painted the theme's own text colour straight over it: the
     * Editor Agent's "make those two words red" was correct in the plan,
     * correct in the markup, and invisible on screen. The worst kind of bug,
     * because every stage upstream reports success.
     *
     * Legibility is not given up here. The shadow/stroke rule below is keyed
     * only on adaptive-contrast being on, so a coloured range still gets the
     * same halo as its neighbours. Colour is the agent's call; readability
     * support stays ours.
     *
     * (No backticks in this comment on purpose - the whole block is a JS
     * template literal, so one would end the CSS mid-sentence.) */
    .hf-mg[data-hf-adaptive-contrast="1"] .hf-adaptive-text-node {
      text-shadow: var(--hf-adaptive-text-shadow, inherit);
      -webkit-text-stroke: var(--hf-adaptive-stroke-width, 0px) var(--hf-adaptive-stroke-color, transparent);
      paint-order: stroke fill;
    }
    .hf-mg[data-hf-adaptive-contrast="1"] .hf-agentic-rule {
      background: linear-gradient(180deg, var(--hf-adaptive-accent, var(--hf-primary)), var(--hf-adaptive-accent, var(--hf-accent)));
    }
    .hf-mg[data-hf-adaptive-contrast="1"].hf-variant-underline .hf-agentic-copy,
    .hf-mg[data-hf-adaptive-contrast="1"].hf-variant-underline .hf-copy-shell {
      border-bottom-color: var(--hf-adaptive-accent, var(--hf-accent));
    }
    .hf-mg[data-hf-adaptive-contrast="1"] .hf-adaptive-protection {
      position: absolute;
      display: none;
      z-index: 1;
      pointer-events: none;
      border-radius: 18px;
      transform: translateZ(0);
      box-sizing: border-box;
      backdrop-filter: blur(14px) saturate(0.92);
    }
    .hf-mg[data-hf-adaptive-contrast="1"] > .hf-adaptive-content-layer {
      z-index: 2;
    }
    .hf-mg[data-hf-adaptive-contrast="1"] > .hf-adaptive-content-layer-static {
      position: relative;
    }
    .hf-mg[data-hf-adaptive-contrast="1"] .hf-adaptive-protection[data-tone="dark"] {
      box-shadow: 0 12px 42px rgba(0,0,0,0.24);
    }
    .hf-mg[data-hf-adaptive-contrast="1"] .hf-adaptive-protection[data-tone="light"] {
      box-shadow: 0 12px 42px rgba(70,48,24,0.16);
    }`;
}

function installAdaptiveContrastRuntime(config) {
    var root = document.getElementById('yta-hyperframes');
    if (!root) return null;

    var WIDTH = Number(root.dataset.width || 1920);
    var HEIGHT = Number(root.dataset.height || 1080);
    var SAMPLE_W = Number(config.sampleWidth || 240);
    var SAMPLE_H = Number(config.sampleHeight || 135);
    var TARGET = Number(config.targetRatio || 4.5);
    var FRACTION = Number(config.samplePercentile || 0.12);
    var canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var nodeState = new WeakMap();
    var lastBucket = null;
    var report = {
        version: Number(config.version || 1),
        time: 0,
        graphics: [],
    };

    function clampValue(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function parseColorValue(value) {
        var s = String(value || '').trim();
        var hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (hex) {
            var raw = hex[1];
            if (raw.length === 3) raw = raw.split('').map(function (c) { return c + c; }).join('');
            var n = parseInt(raw, 16);
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
        }
        var rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
        if (!rgb) return null;
        return {
            r: clampValue(Number(rgb[1]) || 0, 0, 255),
            g: clampValue(Number(rgb[2]) || 0, 0, 255),
            b: clampValue(Number(rgb[3]) || 0, 0, 255),
            a: rgb[4] == null ? 1 : clampValue(Number(rgb[4]) || 0, 0, 1),
        };
    }

    function channelLinear(value) {
        var c = value / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function luminance(color) {
        var c = typeof color === 'string' ? parseColorValue(color) : color;
        if (!c) return null;
        return 0.2126 * channelLinear(c.r) + 0.7152 * channelLinear(c.g) + 0.0722 * channelLinear(c.b);
    }

    function ratio(foreground, background) {
        var a = luminance(foreground);
        var b = luminance(background);
        if (a == null || b == null) return null;
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }

    function pct(values, fraction) {
        var finite = values.filter(Number.isFinite).sort(function (a, b) { return a - b; });
        if (!finite.length) return null;
        var index = clampValue(Math.floor((finite.length - 1) * fraction), 0, finite.length - 1);
        return finite[index];
    }

    function robust(color, samples) {
        var parsed = parseColorValue(color);
        if (!parsed || !samples.length) return null;
        return pct(samples.map(function (sample) { return ratio(parsed, sample); }).filter(Number.isFinite), FRACTION);
    }

    function composite(sample, scrim, alpha) {
        var c = parseColorValue(scrim);
        if (!c) return sample;
        var a = clampValue(alpha * c.a, 0, 1);
        return {
            r: c.r * a + sample.r * (1 - a),
            g: c.g * a + sample.g * (1 - a),
            b: c.b * a + sample.b * (1 - a),
        };
    }

    function alphaFor(color, samples, scrim) {
        var low = 0;
        var high = 0.88;
        if ((robust(color, samples.map(function (sample) { return composite(sample, scrim, high); })) || 0) < TARGET) {
            return high;
        }
        for (var i = 0; i < 12; i++) {
            var mid = (low + high) / 2;
            var score = robust(color, samples.map(function (sample) { return composite(sample, scrim, mid); }));
            if (score != null && score >= TARGET) high = mid;
            else low = mid;
        }
        return clampValue(high + 0.025, 0, 0.88);
    }

    function choose(preferredText, preferredAccent, samples, explicitText, forceProtection, contrastTone) {
        var stableTone = contrastTone === 'light' || contrastTone === 'dark'
            ? contrastTone
            : 'auto';
        var stableText = stableTone === 'light'
            ? '#fffaf2'
            : (stableTone === 'dark' ? '#11100e' : preferredText);
        var preferredRatio = robust(preferredText, samples);
        var candidates = explicitText
            ? [preferredText]
            : (
                stableTone === 'light'
                    ? ['#fffaf2']
                    : (
                        stableTone === 'dark'
                            ? ['#11100e']
                            : [preferredText, '#fffaf2', '#ffffff', '#11100e', '#000000']
                    )
            );
        var seen = {};
        candidates = candidates.filter(function (candidate) {
            var key = String(candidate || '').toLowerCase().replace(/\s+/g, '');
            if (!parseColorValue(candidate) || seen[key]) return false;
            seen[key] = true;
            return true;
        });
        var textColor = candidates[0] || preferredText;
        var score = robust(textColor, samples);
        if (!(preferredRatio != null && preferredRatio >= TARGET) && !explicitText) {
            candidates.slice(1).forEach(function (candidate) {
                var candidateScore = robust(candidate, samples);
                if (candidateScore != null && (score == null || candidateScore > score)) {
                    textColor = candidate;
                    score = candidateScore;
                }
            });
        }
        var scrimColor = '#000000';
        var scrimAlpha = 0;
        if (forceProtection || score == null || score < TARGET) {
            var darkAlpha = stableTone === 'dark' ? 0.88 : alphaFor(textColor, samples, '#000000');
            var lightAlpha = stableTone === 'light' ? 0.88 : alphaFor(textColor, samples, '#ffffff');
            var darkScore = robust(textColor, samples.map(function (sample) { return composite(sample, '#000000', darkAlpha); })) || 0;
            var lightScore = robust(textColor, samples.map(function (sample) { return composite(sample, '#ffffff', lightAlpha); })) || 0;
            if (
                stableTone === 'dark'
                || (
                    stableTone !== 'light'
                    && (lightScore > darkScore || (Math.abs(lightScore - darkScore) < 0.05 && lightAlpha < darkAlpha))
                )
            ) {
                scrimColor = '#ffffff';
                scrimAlpha = lightAlpha;
                score = lightScore;
            } else {
                scrimAlpha = darkAlpha;
                score = darkScore;
            }
            if (forceProtection) scrimAlpha = Math.max(0.5, scrimAlpha);
        }
        var accentColor = preferredAccent || textColor;
        var accentScore = robust(accentColor, samples);
        if (accentScore == null || accentScore < 3) accentColor = textColor;
        return {
            textColor: textColor,
            accentColor: accentColor,
            ratio: score == null ? null : Math.round(score * 100) / 100,
            preferredRatio: preferredRatio == null ? null : Math.round(preferredRatio * 100) / 100,
            scrimColor: scrimColor,
            scrimAlpha: Math.round(clampValue(scrimAlpha, 0, 0.88) * 1000) / 1000,
            adjustedText: !explicitText && String(textColor).toLowerCase() !== String(preferredText).toLowerCase(),
            explicitText: explicitText,
            contrastTone: stableTone,
        };
    }

    function activeAt(element, time) {
        var start = Number(
            element.dataset.start
            || element.dataset.hfSceneStart
            || element.dataset.hfStart
            || 0
        );
        var duration = Math.max(0.033, Number(
            element.dataset.duration
            || element.dataset.hfSceneDuration
            || element.dataset.hfDuration
            || 0
        ));
        return time >= start - 0.01 && time < start + duration + 0.01;
    }

    function effectiveOpacity(element) {
        var value = 1;
        var node = element;
        while (node && node !== root.parentElement) {
            var style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return 0;
            value *= Number(style.opacity || 1);
            node = node.parentElement;
            if (node === document.body) break;
        }
        return value;
    }

    function rectInComposition(element) {
        var rootRect = root.getBoundingClientRect();
        var rect = element.getBoundingClientRect();
        if (!rootRect.width || !rootRect.height) return null;
        var sx = WIDTH / rootRect.width;
        var sy = HEIGHT / rootRect.height;
        return {
            x: (rect.left - rootRect.left) * sx,
            y: (rect.top - rootRect.top) * sy,
            width: rect.width * sx,
            height: rect.height * sy,
            right: (rect.right - rootRect.left) * sx,
            bottom: (rect.bottom - rootRect.top) * sy,
        };
    }

    function intrinsicSize(media) {
        if (!media) return null;
        if (media.tagName === 'VIDEO') {
            if (media.readyState < 2 || !media.videoWidth || !media.videoHeight) return null;
            return { width: media.videoWidth, height: media.videoHeight };
        }
        if (media.tagName === 'IMG') {
            if (!media.complete || !media.naturalWidth || !media.naturalHeight) return null;
            return { width: media.naturalWidth, height: media.naturalHeight };
        }
        if (media.tagName === 'CANVAS') {
            return { width: media.width, height: media.height };
        }
        return null;
    }

    function objectPosition(style) {
        var raw = String(style.objectPosition || '50% 50%').trim().split(/\s+/);
        function component(value, fallback) {
            if (/%$/.test(value || '')) return clampValue(parseFloat(value) / 100, 0, 1);
            if (value === 'left' || value === 'top') return 0;
            if (value === 'right' || value === 'bottom') return 1;
            if (value === 'center') return 0.5;
            return fallback;
        }
        return {
            x: component(raw[0], 0.5),
            y: component(raw[1] || raw[0], 0.5),
        };
    }

    function drawMedia(media, destination, alpha) {
        var size = intrinsicSize(media);
        if (!size || !destination || destination.width <= 0 || destination.height <= 0) return false;
        var style = getComputedStyle(media);
        var fit = style.objectFit || 'fill';
        var pos = objectPosition(style);
        var dw = destination.width;
        var dh = destination.height;
        var dx = destination.x;
        var dy = destination.y;
        if (fit === 'cover' || fit === 'contain') {
            var scale = fit === 'cover'
                ? Math.max(destination.width / size.width, destination.height / size.height)
                : Math.min(destination.width / size.width, destination.height / size.height);
            dw = size.width * scale;
            dh = size.height * scale;
            dx = destination.x + (destination.width - dw) * pos.x;
            dy = destination.y + (destination.height - dh) * pos.y;
        }
        ctx.save();
        ctx.globalAlpha = clampValue(alpha, 0, 1);
        try {
            ctx.drawImage(
                media,
                dx / WIDTH * SAMPLE_W,
                dy / HEIGHT * SAMPLE_H,
                dw / WIDTH * SAMPLE_W,
                dh / HEIGHT * SAMPLE_H
            );
        } catch (_) {
            ctx.restore();
            return false;
        }
        ctx.restore();
        return true;
    }

    function renderBackground(time) {
        ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
        ctx.fillStyle = '#111111';
        ctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H);
        var scenes = Array.from(root.querySelectorAll('.hf-scene-wrap'))
            .filter(function (scene) { return activeAt(scene, time) && effectiveOpacity(scene) > 0.01; });
        scenes.forEach(function (scene) {
            var opacity = effectiveOpacity(scene);
            var backdrop = scene.querySelector('.hf-floatbg-fill');
            if (backdrop) {
                drawMedia(backdrop, { x: 0, y: 0, width: WIDTH, height: HEIGHT }, opacity * 0.9);
            }
            var media = scene.querySelector('.hf-scene-media')
                || scene.querySelector('.hf-scene-frame video, .hf-scene-frame img, .hf-scene-frame canvas');
            if (!media) return;
            var frame = media.closest('.hf-scene-frame') || scene;
            drawMedia(media, rectInComposition(frame), effectiveOpacity(media));
        });
    }

    function samplesWithGraphicSurface(node, graphic, samples) {
        if (
            graphic.classList.contains('hf-card-transparent')
            || graphic.classList.contains('hf-variant-underline')
            || graphic.classList.contains('hf-variant-minimal')
        ) {
            return samples;
        }
        var current = node;
        while (current && current !== graphic) {
            var style = getComputedStyle(current);
            var background = parseColorValue(style.backgroundColor);
            var hasImage = style.backgroundImage && style.backgroundImage !== 'none';
            if (background && background.a > 0.12) {
                return samples.map(function (sample) {
                    return composite(sample, style.backgroundColor, 1);
                });
            }
            if (hasImage) {
                var tokenColor = getComputedStyle(graphic).getPropertyValue('--hf-bg').trim();
                if (parseColorValue(tokenColor)) {
                    return samples.map(function (sample) {
                        return composite(sample, tokenColor, 0.72);
                    });
                }
            }
            current = current.parentElement;
        }
        return samples;
    }

    function textElements(graphic) {
        var elements = [];
        var all = Array.from(graphic.querySelectorAll('*'));
        all.forEach(function (element) {
            if (element.classList.contains('hf-adaptive-protection')) return;
            if (element.closest('[data-layout-ignore]')) return;
            var directText = Array.from(element.childNodes).some(function (node) {
                return node.nodeType === 3 && String(node.textContent || '').trim().length > 0;
            });
            if (!directText) return;
            var rect = element.getBoundingClientRect();
            if (rect.width < 3 || rect.height < 3) return;
            if (effectiveOpacity(element) < 0.08) return;
            elements.push(element);
        });
        return elements.slice(0, 48);
    }

    function sampleRect(rect) {
        if (!rect || rect.width <= 0 || rect.height <= 0) return [];
        var x0 = clampValue(Math.floor(rect.x / WIDTH * SAMPLE_W), 0, SAMPLE_W - 1);
        var y0 = clampValue(Math.floor(rect.y / HEIGHT * SAMPLE_H), 0, SAMPLE_H - 1);
        var x1 = clampValue(Math.ceil(rect.right / WIDTH * SAMPLE_W), x0 + 1, SAMPLE_W);
        var y1 = clampValue(Math.ceil(rect.bottom / HEIGHT * SAMPLE_H), y0 + 1, SAMPLE_H);
        var pixels;
        try {
            pixels = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        } catch (_) {
            return [];
        }
        var out = [];
        var step = Math.max(1, Math.floor(Math.sqrt((pixels.width * pixels.height) / 360)));
        for (var y = 0; y < pixels.height; y += step) {
            for (var x = 0; x < pixels.width; x += step) {
                var offset = (y * pixels.width + x) * 4;
                if (pixels.data[offset + 3] < 20) continue;
                out.push({
                    r: pixels.data[offset],
                    g: pixels.data[offset + 1],
                    b: pixels.data[offset + 2],
                });
            }
        }
        return out;
    }

    function originalState(element) {
        var state = nodeState.get(element);
        if (state) return state;
        state = {
            color: element.style.getPropertyValue('color'),
            colorPriority: element.style.getPropertyPriority('color'),
            fill: element.style.getPropertyValue('fill'),
            fillPriority: element.style.getPropertyPriority('fill'),
            textShadow: element.style.getPropertyValue('text-shadow'),
            textShadowPriority: element.style.getPropertyPriority('text-shadow'),
            strokeWidth: element.style.getPropertyValue('-webkit-text-stroke-width'),
            strokeWidthPriority: element.style.getPropertyPriority('-webkit-text-stroke-width'),
            strokeColor: element.style.getPropertyValue('-webkit-text-stroke-color'),
            strokeColorPriority: element.style.getPropertyPriority('-webkit-text-stroke-color'),
        };
        nodeState.set(element, state);
        return state;
    }

    function restoreProperty(element, name, value, priority) {
        if (value) element.style.setProperty(name, value, priority || '');
        else element.style.removeProperty(name);
    }

    function restoreNode(element) {
        var state = nodeState.get(element);
        if (!state) return;
        restoreProperty(element, 'color', state.color, state.colorPriority);
        restoreProperty(element, 'fill', state.fill, state.fillPriority);
        restoreProperty(element, 'text-shadow', state.textShadow, state.textShadowPriority);
        restoreProperty(element, '-webkit-text-stroke-width', state.strokeWidth, state.strokeWidthPriority);
        restoreProperty(element, '-webkit-text-stroke-color', state.strokeColor, state.strokeColorPriority);
        element.classList.remove('hf-adaptive-text-node');
    }

    function applyNodeTreatment(element, treatment, explicitText) {
        originalState(element);
        element.classList.add('hf-adaptive-text-node');
        var svgText = !!element.ownerSVGElement;
        if (!explicitText && treatment.adjustedText) {
            element.style.setProperty('color', treatment.textColor, 'important');
            if (svgText) element.style.setProperty('fill', treatment.textColor, 'important');
        }
        var textLum = luminance(treatment.textColor);
        var darkText = textLum != null && textLum < 0.42;
        var shadow = darkText
            ? '0 1px 2px rgba(255,255,255,0.52), 0 4px 18px rgba(255,255,255,0.22)'
            : '0 2px 4px rgba(0,0,0,0.86), 0 7px 24px rgba(0,0,0,0.72)';
        element.style.setProperty('text-shadow', shadow, 'important');
        element.style.setProperty('-webkit-text-stroke-width', '0.45px', 'important');
        element.style.setProperty(
            '-webkit-text-stroke-color',
            darkText ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.36)',
            'important'
        );
    }

    function unionRect(rects) {
        if (!rects.length) return null;
        var x = Math.min.apply(null, rects.map(function (rect) { return rect.x; }));
        var y = Math.min.apply(null, rects.map(function (rect) { return rect.y; }));
        var right = Math.max.apply(null, rects.map(function (rect) { return rect.right; }));
        var bottom = Math.max.apply(null, rects.map(function (rect) { return rect.bottom; }));
        return { x: x, y: y, right: right, bottom: bottom, width: right - x, height: bottom - y };
    }

    function protection(graphic, tone) {
        var selector = '.hf-adaptive-protection[data-tone="' + tone + '"]';
        var element = graphic.querySelector(selector);
        if (!element) {
            element = document.createElement('div');
            element.className = 'hf-adaptive-protection';
            element.dataset.tone = tone;
            graphic.insertBefore(element, graphic.firstChild);
        }
        return element;
    }

    function hideProtections(graphic) {
        graphic.querySelectorAll('.hf-adaptive-protection').forEach(function (element) {
            element.style.display = 'none';
        });
    }

    function placeProtection(graphic, rect, tone, alpha) {
        if (!rect || alpha <= 0.02) return;
        var graphicRect = rectInComposition(graphic);
        if (!graphicRect) return;
        var element = protection(graphic, tone);
        var padX = 24;
        var padY = 16;
        var x = rect.x - graphicRect.x - padX;
        var y = rect.y - graphicRect.y - padY;
        var width = rect.width + padX * 2;
        var height = rect.height + padY * 2;
        var color = tone === 'light' ? '255,255,255' : '0,0,0';
        var edgeAlpha = Math.max(0, alpha - 0.22);
        element.style.display = 'block';
        element.style.left = x.toFixed(2) + 'px';
        element.style.top = y.toFixed(2) + 'px';
        element.style.width = width.toFixed(2) + 'px';
        element.style.height = height.toFixed(2) + 'px';
        element.style.background = 'linear-gradient(90deg, rgba(' + color + ',' + alpha.toFixed(3) + ') 0%, rgba(' + color + ',' + Math.max(0, alpha - 0.06).toFixed(3) + ') 72%, rgba(' + color + ',' + edgeAlpha.toFixed(3) + ') 100%)';
    }

    function update(time, force) {
        var t = Math.max(0, Number(time) || 0);
        var bucket = Math.floor(t * 4);
        if (!force && bucket === lastBucket) return report;
        lastBucket = bucket;
        renderBackground(t);
        var graphicReports = [];
        var graphics = Array.from(root.querySelectorAll('.hf-mg[data-hf-adaptive-contrast="1"]'));
        graphics.forEach(function (graphic) {
            hideProtections(graphic);
            if (!activeAt(graphic, t) || effectiveOpacity(graphic) < 0.02) return;
            var nodes = textElements(graphic);
            if (!nodes.length) return;
            nodes.forEach(restoreNode);
            nodes.forEach(function (node) {
                var layer = node;
                while (layer.parentElement && layer.parentElement !== graphic) {
                    layer = layer.parentElement;
                }
                if (layer.parentElement === graphic) {
                    layer.classList.add('hf-adaptive-content-layer');
                    if (!layer.dataset.hfAdaptiveOriginalPosition) {
                        layer.classList.remove('hf-adaptive-content-layer-static');
                        layer.dataset.hfAdaptiveOriginalPosition = getComputedStyle(layer).position || 'static';
                    }
                    if (layer.dataset.hfAdaptiveOriginalPosition === 'static') {
                        layer.classList.add('hf-adaptive-content-layer-static');
                    } else {
                        layer.classList.remove('hf-adaptive-content-layer-static');
                    }
                }
            });
            var rootExplicit = graphic.dataset.hfTextExplicit === '1';
            var forceProtection = (
                graphic.dataset.hfContrastForce === 'strong'
                || graphic.dataset.hfContrastForce === 'guarded'
            );
            var contrastTone = graphic.dataset.hfContrastTone || 'auto';
            var darkRects = [];
            var lightRects = [];
            var maxDarkAlpha = 0;
            var maxLightAlpha = 0;
            var minRatio = Infinity;
            var adjustedNodes = 0;
            var accentColor = '';
            var nodeReports = [];
            nodes.forEach(function (node) {
                var style = getComputedStyle(node);
                var preferredText = node.ownerSVGElement && style.fill && style.fill !== 'none'
                    ? style.fill
                    : style.color;
                var preferredAccent = style.getPropertyValue('--hf-accent')
                    || getComputedStyle(graphic).getPropertyValue('--hf-accent')
                    || preferredText;
                var explicitText = rootExplicit
                    || !!node.closest('[data-hf-contrast-lock="manual"]');
                var rect = rectInComposition(node);
                var samples = samplesWithGraphicSurface(node, graphic, sampleRect(rect));
                var treatment = choose(
                    preferredText,
                    preferredAccent,
                    samples,
                    explicitText,
                    forceProtection,
                    contrastTone
                );
                applyNodeTreatment(node, treatment, explicitText);
                if (treatment.adjustedText) adjustedNodes++;
                if (treatment.ratio != null) minRatio = Math.min(minRatio, treatment.ratio);
                accentColor = treatment.accentColor || accentColor;
                if (treatment.scrimAlpha > 0.02 && rect) {
                    if (treatment.scrimColor === '#ffffff') {
                        lightRects.push(rect);
                        maxLightAlpha = Math.max(maxLightAlpha, treatment.scrimAlpha);
                    } else {
                        darkRects.push(rect);
                        maxDarkAlpha = Math.max(maxDarkAlpha, treatment.scrimAlpha);
                    }
                }
                nodeReports.push({
                    text: String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
                    color: treatment.textColor,
                    ratio: treatment.ratio,
                    preferredRatio: treatment.preferredRatio,
                    explicit: explicitText,
                    adjusted: treatment.adjustedText,
                    scrimAlpha: treatment.scrimAlpha,
                    contrastTone: treatment.contrastTone,
                });
            });
            if (accentColor) graphic.style.setProperty('--hf-adaptive-accent', accentColor);
            placeProtection(graphic, unionRect(darkRects), 'dark', maxDarkAlpha);
            placeProtection(graphic, unionRect(lightRects), 'light', maxLightAlpha);
            graphic.dataset.hfContrastStatus = (
                Number.isFinite(minRatio) && minRatio >= TARGET
            ) ? 'pass' : ((maxDarkAlpha > 0 || maxLightAlpha > 0) ? 'protected' : 'unknown');
            graphicReports.push({
                id: graphic.id || '',
                time: t,
                status: graphic.dataset.hfContrastStatus,
                minRatio: Number.isFinite(minRatio) ? Math.round(minRatio * 100) / 100 : null,
                adjustedNodes: adjustedNodes,
                contrastTone: contrastTone,
                protection: {
                    darkAlpha: Math.round(maxDarkAlpha * 1000) / 1000,
                    lightAlpha: Math.round(maxLightAlpha * 1000) / 1000,
                },
                nodes: nodeReports,
            });
        });
        report = {
            version: Number(config.version || 1),
            time: t,
            graphics: graphicReports,
        };
        window.__HF_ADAPTIVE_CONTRAST_REPORT__ = report;
        return report;
    }

    function schedule(time, force) {
        var requestedTime = Math.max(0, Number(time) || 0);
        if (force) lastBucket = null;
        return update(requestedTime, force);
    }

    var controller = {
        version: Number(config.version || 1),
        update: update,
        schedule: schedule,
        getReport: function () { return report; },
    };
    window.__HF_ADAPTIVE_CONTRAST__ = controller;
    window.__HF_ADAPTIVE_CONTRAST_REPORT__ = report;
    return controller;
}

function buildAdaptiveContrastRuntime(options = {}) {
    const config = {
        version: VERSION,
        targetRatio: Number(options.targetRatio || DEFAULT_TARGET_RATIO),
        samplePercentile: Number(options.samplePercentile || DEFAULT_SAMPLE_PERCENTILE),
        sampleWidth: Number(options.sampleWidth || 240),
        sampleHeight: Number(options.sampleHeight || 135),
    };
    return `(${installAdaptiveContrastRuntime.toString()})(${JSON.stringify(config)})`;
}

module.exports = {
    DARK_TEXT,
    DEFAULT_SAMPLE_PERCENTILE,
    DEFAULT_TARGET_RATIO,
    LIGHT_TEXT,
    VERSION,
    buildAdaptiveContrastCss,
    buildAdaptiveContrastRuntime,
    chooseAdaptiveContrast,
    robustContrast,
};
