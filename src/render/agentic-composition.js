const {
    normalizeGraphicShell,
} = require('./graphic-shells');
const {
    resolveGraphicMediaTreatment,
} = require('./overlay-visual-policy');

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function textValue(...values) {
    for (const value of values) {
        if (value == null) continue;
        const s = String(value).trim();
        if (s && s.toLowerCase() !== 'none' && s !== '-') return s;
    }
    return '';
}

function token(value, fallback = 'standard') {
    return textValue(value, fallback)
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || fallback;
}

function normalizeSpeed(value, fallback = 1) {
    if (value == null || value === '') return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.max(0.25, Math.min(3, numeric));
    const raw = token(value, 'normal');
    if (raw.includes('very-slow')) return 0.55;
    if (raw.includes('slow') || raw.includes('calm') || raw.includes('gentle')) return 0.75;
    if (raw.includes('rapid') || raw.includes('snappy')) return 1.6;
    if (raw.includes('fast') || raw.includes('quick') || raw.includes('energetic')) return 1.35;
    if (raw.includes('normal') || raw.includes('standard') || raw.includes('medium')) return 1;
    return fallback;
}

function normalizeType(value, fallback = 'graphic') {
    const raw = token(value, fallback);
    const aliases = {
        lowerthird: 'lower-third',
        lower_third: 'lower-third',
        statcounter: 'stat-counter',
        focusword: 'focus-word',
        progressbar: 'progress-bar',
        barchart: 'bar-chart',
        donutchart: 'donut-chart',
        comparisoncard: 'comparison-card',
        bulletlist: 'bullet-list',
        rankinglist: 'ranking-list',
        mapchart: 'map-chart',
        kinetictext: 'kinetic-text',
        listiclecounter: 'listicle-counter',
        progresstracker: 'progress-tracker',
        listiclegrid: 'listicle-grid',
        chaptercard: 'chapter-card',
        titlecard: 'title-card',
        locationcard: 'location-card',
        quotecard: 'quote-card',
        keytakeaway: 'key-takeaway',
        timelinecard: 'timeline-card',
        factcard: 'fact-card',
        statcard: 'stat-card',
        imageshowcase: 'image-showcase',
        personintro: 'person-intro',
        splitscreen: 'split-screen',
    };
    return aliases[raw] || raw;
}

function normalizeKind(value) {
    const raw = token(value, 'graphic');
    if (raw === 'mg' || raw === 'overlay') return 'overlay';
    if (raw === 'fullscreen' || raw === 'fullscreen-mg') return 'fullscreen';
    if (raw === 'template' || raw === 'template-scene') return 'template';
    return raw;
}

function normalizePosition(value) {
    const raw = token(value, 'auto');
    const map = {
        lower: 'bottom-left',
        bottom: 'bottom-left',
        bottomleft: 'bottom-left',
        bottomright: 'bottom-right',
        centerleft: 'center-left',
        centerright: 'center-right',
        topleft: 'top-left',
        topright: 'top-right',
        upper: 'top-left',
    };
    return map[raw] || raw;
}

function pickLayout(type, role, source = {}) {
    const explicit = textValue(source.layout, source.layoutHint, source.compositionLayout);
    if (explicit) return token(explicit, 'freeform');
    if (type === 'lower-third') return 'lower-third';
    if (['headline', 'focus-word', 'kinetic-text', 'typewriter'].includes(type)) return 'center-stack';
    if (['stat-counter', 'stat-card', 'bar-chart', 'donut-chart', 'progress-bar', 'progress-tracker'].includes(type)) return 'data-focus';
    if (['comparison-card', 'split-screen'].includes(type)) return 'split-panel';
    if (type === 'map-chart') return 'map-explainer';
    if (['ranking-list', 'bullet-list', 'timeline', 'listicle-grid', 'timeline-card', 'fact-card', 'image-showcase', 'infographic', 'key-takeaway'].includes(type)) return 'evidence-board';
    if (['chapter-card', 'title-card', 'location-card', 'quote-card', 'person-intro'].includes(type)) return 'cinematic-title';
    if (role === 'template' || role === 'fullscreen') return 'cinematic-title';
    return 'focus-panel';
}

function pickSafeZone(position, layout, role, source = {}) {
    const explicit = textValue(source.safeZone, source.safezone, source.safe_zone);
    if (explicit) return normalizePosition(explicit);
    const pos = normalizePosition(position);
    if (pos && pos !== 'auto' && pos !== 'center') return pos;
    if (layout === 'lower-third') return 'bottom-left';
    if (layout === 'data-focus') return 'center';
    if (role === 'template' || role === 'fullscreen') return 'center-left';
    return 'center';
}

function pickDensity(items, text, source = {}) {
    const explicit = textValue(source.density);
    if (explicit) return token(explicit, 'standard');
    if (items.length >= 5) return 'dense';
    if (String(text || '').length > 72) return 'compact';
    return 'standard';
}

function normalizeItems(items) {
    return asArray(items).map((item, i) => {
        if (item == null) return null;
        if (typeof item === 'string') return { kind: 'item', label: item.trim(), value: String(i + 1) };
        if (typeof item !== 'object') return null;
        const label = textValue(item.label, item.title, item.text, item.name);
        const value = textValue(item.value, item.stat, item.number, item.rank);
        const subtext = textValue(item.subtext, item.subText, item.description, item.detail);
        if (!label && !value && !subtext) return null;
        return {
            kind: token(item.kind || 'item', 'item'),
            label,
            value: value || String(i + 1),
            subtext,
            priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : i + 1,
        };
    }).filter(Boolean).slice(0, 8);
}

function pickExplicitSpec(mg = {}) {
    return asObject(mg.agenticComposition)
        || asObject(mg.hyperframeComposition)
        || asObject(mg.compositionSpec)
        || asObject(mg.composition)
        || asObject(mg.mgData?.agenticComposition)
        || asObject(mg.mgData?.hyperframeComposition)
        || null;
}

function extractText(mg = {}, ctx = {}) {
    return textValue(ctx.text, mg.text, mg.title, mg.headline, mg.label, mg.keyword, mg.templateText, mg.templateTitle, mg.mgData?.text, mg.mgData?.title);
}

function extractSubtext(mg = {}, ctx = {}) {
    return textValue(ctx.subtext, mg.subtext, mg.subText, mg.subtitle, mg.description, mg.templateSubtext, mg.templateSubText, mg.mgData?.subtext, mg.mgData?.subtitle);
}

function extractItems(mg = {}, ctx = {}) {
    return normalizeItems(ctx.items || mg.items || mg.templateItems || mg._items || mg.mgData?.items);
}

function normalizeAgenticCompositionSpec(mg = {}, ctx = {}) {
    if (mg.agenticComposition === false || mg.hyperframeComposition === false || mg.disableAgenticComposition) return null;

    const explicitRaw = pickExplicitSpec(mg);
    const explicit = explicitRaw || {};
    const type = normalizeType(ctx.type || mg.type || mg.mgType || mg.templateType || explicit.type, 'graphic');
    const role = normalizeKind(explicit.role || ctx.kind || mg._hfKind || mg.kind || (type.includes('card') ? 'template' : 'overlay'));
    const visual = asObject(ctx.visual) || {};
    const text = textValue(explicit.title, explicit.text, extractText(mg, ctx), type.replace(/-/g, ' '));
    const subtext = textValue(explicit.subtitle, explicit.subtext, extractSubtext(mg, ctx));
    const kicker = textValue(explicit.kicker, explicit.eyebrow, ctx.kicker, mg.kicker, mg.eyebrow);
    const items = normalizeItems(explicit.items).length ? normalizeItems(explicit.items) : extractItems(mg, ctx);
    const layout = pickLayout(type, role, explicit);
    const safeZone = pickSafeZone(mg.position || explicit.position, layout, role, explicit);
    const motionIntent = asObject(explicit.motion) || {};
    const styleIntent = asObject(explicit.style) || {};
    const density = pickDensity(items, text, styleIntent);
    const entrance = token(motionIntent.entrance || explicit.motionIntent || visual.animation || mg.animation || mg.templateAnimation || 'fade-slide', 'fade-slide');
    const hasAsset = Boolean(ctx.hasAsset || mg.mediaPath || mg.assetPath || mg.templateMediaFile || mg.backgroundMediaFile);
    const mediaTreatment = resolveGraphicMediaTreatment({
        role,
        type,
        requested: explicit.media?.treatment || explicit.mediaTreatment,
        fallback: role === 'overlay'
            ? 'transparent'
            : (hasAsset ? 'cinematic-background' : 'transparent'),
    });
    const shell = normalizeGraphicShell(
        mg.graphicShell
        || mg.mgData?.graphicShell
        || explicit.shell
        || styleIntent.shell,
        {
            id: mg.id || mg.clipId || ctx.id || text,
            role,
            type,
            text,
            subtext: subtext || kicker,
            items,
            density,
            textStrategy: explicit.textStrategy || explicit.strategy || layout,
            safeZone,
            layout,
            mood: `${styleIntent.mood || explicit.mood || visual.styleName || mg.style || ''} ${motionIntent.reason || explicit.compositionIntent || ''}`,
            manual: mg.graphicShellManual === true || mg.mgData?.graphicShellManual === true,
            transparentBackground: Boolean(
                mg.transparentBackground === true
                || mg.mgData?.transparentBackground === true
                || visual.cardStyle === 'transparent'
            ),
            accentRuleVisible: (
                visual.accentRuleVisible !== false
                && mg.accentRuleVisible !== false
                && mg.mgData?.accentRuleVisible !== false
            ),
        }
    );

    return {
        mode: 'agentic',
        role,
        type,
        layout,
        safeZone,
        density,
        textStrategy: token(explicit.textStrategy || explicit.strategy || layout, 'title'),
        kicker,
        title: text,
        subtitle: subtext,
        items,
        shell,
        media: {
            hasAsset,
            treatment: mediaTreatment,
        },
        style: {
            mood: token(styleIntent.mood || explicit.mood || visual.styleName || mg.styleName || mg.style || 'clean', 'clean'),
            palette: token(styleIntent.palette || visual.themeId || mg.themeId || 'standard', 'standard'),
            accent: textValue(styleIntent.accent, visual.accent, visual.colors?.accent),
            typography: token(styleIntent.typography || visual.typography || 'editorial', 'editorial'),
            density,
            glass: Boolean(styleIntent.glass || visual.cardStyle === 'glass'),
            shadow: Number.isFinite(Number(styleIntent.shadow)) ? Number(styleIntent.shadow) : Number(visual.shadowStrength || mg.shadowStrength || 0.55),
        },
        motion: {
            entrance,
            emphasis: token(motionIntent.emphasis || explicit.emphasis || 'none', 'none'),
            exit: token(motionIntent.exit || 'soft-out', 'soft-out'),
            stagger: Number.isFinite(Number(motionIntent.stagger)) ? Number(motionIntent.stagger) : 0.065,
            speed: normalizeSpeed(motionIntent.speed, normalizeSpeed(visual.speed ?? mg.animationSpeed, 1)),
            reason: textValue(motionIntent.reason, explicit.motionReason, explicit.compositionIntent),
        },
        constraints: {
            readable: true,
            noOverlap: true,
            maxTextLines: layout === 'lower-third' ? 2 : 4,
            avoidCriticalVisuals: safeZone === 'auto',
            ...asObject(explicit.constraints),
        },
        source: explicitRaw ? textValue(explicit.source, explicitRaw.source, 'explicit') : 'derived',
    };
}

module.exports = {
    normalizeAgenticCompositionSpec,
    normalizeType,
    token,
};
