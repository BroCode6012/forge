(() => {
/**
 * MG Registry — Central source of truth for all MG categories and their types/variants.
 *
 * Each category defines:
 * - label: Display name
 * - group: 'overlay' or 'fullscreen'
 * - types: Map of variant key → { label, animation, themeOverridable }
 * - animations: Available animation profiles for this category
 * - defaultType: Fallback when no subType is set
 * - fields: Which sidebar fields are relevant for this category
 *
 * The UI dynamically generates the "Variant" dropdown from types.
 * The renderer resolves subType → render function via dispatcher pattern.
 *
 * Adding a new variant:
 *   1. Add entry to MG_REGISTRY[category].types
 *   2. Add _render{Category}_{Variant}() method in MGRenderer.js
 *   3. Add case in that category's dispatcher
 */

const MG_REGISTRY = {
    // ── Overlay MGs ──
    headline: {
        label: 'Headline',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',      animation: 'springScale' },
            stamp:     { label: 'Stamp',          animation: 'popUp' },
            typewriter:{ label: 'Typewriter',     animation: 'typewriter' },
        },
        animations: ['springScale', 'popUp', 'slideLeft', 'fadeSlide', 'typewriter', 'wordCascade'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    lowerThird: {
        label: 'Lower Third',
        group: 'overlay',
        types: {
            bar:       { label: 'Bar',            animation: 'slideLeft',  themeOverridable: true },
            box:       { label: 'Box',            animation: 'slideLeft',  themeOverridable: true },
            underline: { label: 'Underline',      animation: 'fadeSlide',  themeOverridable: true },
            banner:    { label: 'Banner',         animation: 'wipeRight',  themeOverridable: true },
            glass:     { label: 'Glass',          animation: 'fadeSlide',  themeOverridable: true },
            split:     { label: 'Split',          animation: 'popUp',      themeOverridable: true },
        },
        animations: ['slideLeft', 'wipeRight', 'popUp', 'fadeSlide'],
        defaultType: 'bar',
        fields: ['text', 'subtext', 'position'],
    },

    callout: {
        label: 'Callout',
        group: 'overlay',
        types: {
            standard:  { label: 'Quote Box',      animation: 'springScale' },
            minimal:   { label: 'Minimal',        animation: 'fadeSlide' },
            accent:    { label: 'Accent Bar',     animation: 'slideLeft' },
        },
        animations: ['springScale', 'fadeSlide', 'slideLeft', 'popUp'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    statCounter: {
        label: 'Stat Counter',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'countUp',  themeOverridable: true },
            ticker:    { label: 'Ticker',         animation: 'countUp',  themeOverridable: true },
            ring:      { label: 'Ring Gauge',     animation: 'countUp',  themeOverridable: true },
        },
        animations: ['countUp'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    focusWord: {
        label: 'Focus Word',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'springScale' },
        },
        animations: ['springScale', 'popUp', 'fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'position'],
    },

    progressBar: {
        label: 'Progress Bar',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'slideLeft' },
        },
        animations: ['slideLeft', 'wipeRight'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    // ── Full Screen MGs ──
    barChart: {
        label: 'Bar Chart',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerBars' },
        },
        animations: ['staggerBars', 'popUp'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    donutChart: {
        label: 'Donut Chart',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'spinReveal' },
        },
        animations: ['spinReveal'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    rankingList: {
        label: 'Ranking List',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerSlide' },
        },
        animations: ['staggerSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    timeline: {
        label: 'Timeline',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerSlide' },
        },
        animations: ['staggerSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    comparisonCard: {
        label: 'Comparison',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'springScale' },
        },
        animations: ['springScale'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    bulletList: {
        label: 'Bullet List',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerSlide' },
        },
        animations: ['staggerSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    mapChart: {
        label: 'Map',
        group: 'fullscreen',
        types: {
            standard:       { label: 'Standard',         animation: 'fadeSlide' },
            locator:        { label: 'Locator',           animation: 'fadeSlide' },
            route:          { label: 'Route / Flight',    animation: 'fadeSlide' },
            regionHighlight:{ label: 'Region Highlight',  animation: 'fadeSlide' },
            comparison:     { label: 'Comparison',        animation: 'fadeSlide' },
        },
        animations: ['fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    explainer: {
        label: 'Explainer',
        group: 'overlay',  // always overlays on top of video scene
        types: {
            standard:  { label: 'Standard',       animation: 'fadeSlide' },
            popIn:     { label: 'Pop In',          animation: 'popUp' },
            slideRight:{ label: 'Slide Right',     animation: 'slideLeft' },
        },
        animations: ['fadeSlide', 'popUp', 'slideLeft', 'springScale'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    kineticText: {
        label: 'Kinetic Text',
        group: 'overlay',
        types: {
            centered: { label: 'Centered',  animation: 'springStagger' },
            rise:     { label: 'Rise Up',   animation: 'slideUp' },
            cascade:  { label: 'Cascade',   animation: 'springStagger' },
            punch:    { label: 'Punch',     animation: 'springStagger' },
            stamp:    { label: 'Stamp',     animation: 'springStagger' },
            glitch:   { label: 'Glitch',    animation: 'fadeIn' },
            wave:     { label: 'Wave',      animation: 'springStagger' },
            pop:      { label: 'Pop',       animation: 'springStagger' },
        },
        animations: ['springStagger', 'slideUp', 'fadeIn'],
        defaultType: 'centered',
        fields: ['text'],
    },

    typewriter: {
        label: 'Typewriter',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'slideLeft', themeOverridable: true },
            naked:     { label: 'Naked',          animation: 'slideLeft', themeOverridable: true },
        },
        animations: ['slideLeft', 'fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    subscribeCTA: {
        label: 'Subscribe CTA',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'popUp' },
        },
        animations: ['popUp', 'slideLeft'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },


    // ── Listicle MGs ──
    listicleCounter: {
        label: 'Listicle Counter',
        group: 'listicle',
        types: {
            badge:     { label: 'Badge',           animation: 'popUp',      themeOverridable: true },
            pill:      { label: 'Pill',            animation: 'slideLeft',  themeOverridable: true },
            ribbon:    { label: 'Ribbon',          animation: 'wipeRight',  themeOverridable: true },
            minimal:   { label: 'Minimal',         animation: 'fadeSlide',  themeOverridable: true },
        },
        animations: ['popUp', 'slideLeft', 'wipeRight', 'fadeSlide', 'springScale'],
        defaultType: 'badge',
        fields: ['text', 'subtext', 'position'],
    },

    progressTracker: {
        label: 'Progress Tracker',
        group: 'listicle',
        types: {
            bar:       { label: 'Bar',             animation: 'slideLeft',  themeOverridable: true },
            dots:      { label: 'Dots',            animation: 'popUp',      themeOverridable: true },
            fraction:  { label: 'Fraction',        animation: 'fadeSlide',  themeOverridable: true },
        },
        animations: ['slideLeft', 'popUp', 'fadeSlide'],
        defaultType: 'bar',
        fields: ['text', 'subtext', 'position'],
    },

    listicleGrid: {
        label: 'Listicle Grid',
        group: 'listicle',
        types: {
            grid:      { label: 'Card Grid',       animation: 'staggerSlide', themeOverridable: true },
            strip:     { label: 'Horizontal Strip', animation: 'staggerSlide', themeOverridable: true },
            stack:     { label: 'Stacked Bars',     animation: 'staggerSlide', themeOverridable: true },
        },
        animations: ['staggerSlide', 'popUp', 'fadeSlide'],
        defaultType: 'grid',
        fields: ['text', 'subtext'],
    },
};

/**
 * Resolve the effective subType for an MG.
 * Priority: mg.subType (user-set) > theme override > style preset > registry default
 *
 * @param {Object} mg - The MG data object
 * @param {Object} [themeOverride] - Theme override object (from MG_THEME_OVERRIDES)
 * @param {Object} [stylePreset] - Style preset (from MG_STYLE_PRESETS via MG_STYLES)
 * @returns {string} The resolved subType key
 */
function resolveSubType(mg, themeOverride, stylePreset) {
    // 1. User explicitly set it
    if (mg.subType) return mg.subType;

    const reg = MG_REGISTRY[mg.type];
    if (!reg) return 'standard';

    // 2. Theme override (e.g. crime → banner for lowerThird)
    if (themeOverride?.style && reg.types[themeOverride.style]) {
        return themeOverride.style;
    }

    // 3. Style preset (e.g. cinematic style → banner for lowerThird)
    // Only for lowerThird for now (existing pattern); extend per-category as needed
    if (mg.type === 'lowerThird' && stylePreset?.lowerThirdStyle) {
        return stylePreset.lowerThirdStyle;
    }

    // 4. Registry default
    return reg.defaultType;
}

/**
 * Resolve the effective animation for an MG's subType.
 * Priority: mg.animation (user-set) > theme override > type default > registry default
 */
function resolveAnimation(mg, subType, themeOverride) {
    if (mg.animation) return mg.animation;

    const reg = MG_REGISTRY[mg.type];
    if (!reg) return 'springScale';

    // Theme override animation
    if (themeOverride?.anim) return themeOverride.anim;

    // Type-specific default
    const typeEntry = reg.types[subType];
    if (typeEntry?.animation) return typeEntry.animation;

    // Fallback: first animation in list
    return reg.animations[0] || 'springScale';
}

/**
 * Get the list of available types for a category.
 * Returns [{key, label}] for populating UI dropdowns.
 */
function getTypesForCategory(category) {
    const reg = MG_REGISTRY[category];
    if (!reg) return [];
    return Object.entries(reg.types).map(([key, val]) => ({ key, label: val.label }));
}

/**
 * Get the list of available animations for a category.
 */
function getAnimationsForCategory(category) {
    const reg = MG_REGISTRY[category];
    if (!reg) return [];
    return reg.animations;
}

// ── Exports ──
const MG_REGISTRY_API = {
    MG_REGISTRY,
    registry: MG_REGISTRY,
    resolveSubType,
    resolveAnimation,
    getTypesForCategory,
    getAnimationsForCategory,
};
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MG_REGISTRY_API;
}
if (typeof window !== 'undefined') {
    window._mgRegistry = MG_REGISTRY_API;
}
})();
