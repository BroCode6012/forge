(() => {
'use strict';

/**
 * Graphic shells are structural chrome, not themes.
 *
 * A theme owns color and typography. A shell describes how the visible copy is
 * framed: surface, accent, geometry, hierarchy, width, and emphasis. The Motion
 * Director and Editor Agent receive these dimensions as live capabilities and
 * can combine them contextually instead of mapping graphic types to templates.
 */

const GRAPHIC_SHELL_VALUES = Object.freeze({
    surface: Object.freeze(['none', 'solid', 'soft', 'outline']),
    accent: Object.freeze(['none', 'underline', 'rail', 'tab', 'bracket']),
    geometry: Object.freeze(['square', 'rounded', 'slanted']),
    hierarchy: Object.freeze(['single', 'stacked', 'split']),
    width: Object.freeze(['content', 'compact', 'wide']),
    emphasis: Object.freeze(['quiet', 'balanced', 'strong']),
});

const GRAPHIC_SHELL_RECIPES = Object.freeze({
    auto: Object.freeze({
        label: 'Auto (Agent)',
        description: 'Let the Motion Director compose a structure from the live shell capabilities.',
        auto: true,
    }),
    naked: Object.freeze({
        label: 'Naked',
        description: 'Text only with no container or decorative accent.',
        shell: Object.freeze({
            surface: 'none',
            accent: 'none',
            geometry: 'square',
            hierarchy: 'single',
            width: 'content',
            emphasis: 'quiet',
        }),
        signals: Object.freeze({ minimal: 4, short: 3, single: 2, keyword: 2 }),
        penalties: Object.freeze({ long: 4, dense: 4, secondary: 2 }),
    }),
    underline: Object.freeze({
        label: 'Underline',
        description: 'Open typography with a clean accent rule below.',
        shell: Object.freeze({
            surface: 'none',
            accent: 'underline',
            geometry: 'square',
            hierarchy: 'stacked',
            width: 'content',
            emphasis: 'balanced',
        }),
        signals: Object.freeze({ minimal: 3, editorial: 3, short: 2, medium: 2 }),
        penalties: Object.freeze({ dense: 3 }),
    }),
    rail: Object.freeze({
        label: 'Side Rail',
        description: 'Compact information block anchored by a vertical accent rail.',
        shell: Object.freeze({
            surface: 'soft',
            accent: 'rail',
            geometry: 'square',
            hierarchy: 'stacked',
            width: 'compact',
            emphasis: 'balanced',
        }),
        signals: Object.freeze({ edge: 4, secondary: 2, information: 2, medium: 2 }),
        penalties: Object.freeze({ center: 2 }),
    }),
    'solid-label': Object.freeze({
        label: 'Solid Label',
        description: 'A concise filled nameplate suited to short, high-confidence copy.',
        shell: Object.freeze({
            surface: 'solid',
            accent: 'tab',
            geometry: 'square',
            hierarchy: 'single',
            width: 'content',
            emphasis: 'strong',
        }),
        signals: Object.freeze({ short: 4, identity: 3, strong: 2, edge: 2 }),
        penalties: Object.freeze({ long: 5, dense: 4 }),
    }),
    'split-label': Object.freeze({
        label: 'Split Label',
        description: 'Primary and secondary copy receive distinct stacked label treatment.',
        shell: Object.freeze({
            surface: 'none',
            accent: 'tab',
            geometry: 'square',
            hierarchy: 'split',
            width: 'content',
            emphasis: 'strong',
        }),
        signals: Object.freeze({ secondary: 5, identity: 4, short: 2, edge: 2 }),
        penalties: Object.freeze({ single: 6, long: 3 }),
        requiresSecondary: true,
    }),
    'outline-box': Object.freeze({
        label: 'Outline Box',
        description: 'Transparent framed copy with restrained editorial authority.',
        shell: Object.freeze({
            surface: 'outline',
            accent: 'none',
            geometry: 'square',
            hierarchy: 'stacked',
            width: 'compact',
            emphasis: 'balanced',
        }),
        signals: Object.freeze({ formal: 4, data: 3, information: 2, medium: 2 }),
        penalties: Object.freeze({ energetic: 2 }),
    }),
    'corner-frame': Object.freeze({
        label: 'Corner Frame',
        description: 'Minimal corner brackets frame short focal copy.',
        shell: Object.freeze({
            surface: 'none',
            accent: 'bracket',
            geometry: 'square',
            hierarchy: 'single',
            width: 'content',
            emphasis: 'balanced',
        }),
        signals: Object.freeze({ focus: 4, short: 3, center: 2, keyword: 2 }),
        penalties: Object.freeze({ long: 5, dense: 5, secondary: 2 }),
    }),
    'slanted-tag': Object.freeze({
        label: 'Slanted Tag',
        description: 'Angled compact label for energetic or urgent beats.',
        shell: Object.freeze({
            surface: 'solid',
            accent: 'tab',
            geometry: 'slanted',
            hierarchy: 'single',
            width: 'content',
            emphasis: 'strong',
        }),
        signals: Object.freeze({ energetic: 5, urgent: 4, short: 4, strong: 2 }),
        penalties: Object.freeze({ long: 6, dense: 5, calm: 3 }),
        maxChars: 54,
    }),
    'soft-panel': Object.freeze({
        label: 'Soft Panel',
        description: 'Readability-first soft panel for longer or denser copy.',
        shell: Object.freeze({
            surface: 'soft',
            accent: 'rail',
            geometry: 'rounded',
            hierarchy: 'stacked',
            width: 'wide',
            emphasis: 'quiet',
        }),
        signals: Object.freeze({ long: 5, dense: 5, secondary: 3, calm: 2 }),
        penalties: Object.freeze({ short: 2, energetic: 2 }),
    }),
});

function token(value, fallback = '') {
    const normalized = String(value || '')
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    return normalized || fallback;
}

function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function bool(value) {
    return value === true || /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function stableUnit(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
}

function shellContext(input = {}) {
    const text = compactText(input.text || input.title);
    const secondary = compactText(input.subtext || input.subtitle || input.kicker);
    const type = token(input.type || input.graphicType || input.mgType, 'graphic');
    const itemCount = Array.isArray(input.items)
        ? input.items.length
        : Math.max(0, Number(input.itemCount) || 0);
    const density = token(input.density, itemCount >= 4 ? 'dense' : 'standard');
    const strategy = token(input.textStrategy || input.strategy, 'headline');
    const safeZone = token(input.safeZone || input.position, 'auto');
    const layout = token(input.layout, '');
    const mood = compactText([
        input.mood,
        input.styleMood,
        input.motionReason,
        input.visualIntent,
    ].filter(Boolean).join(' ')).toLowerCase();
    const chars = text.length + Math.min(secondary.length, 80);
    const words = text.split(/\s+/).filter(Boolean).length;
    const signals = new Set();

    if (chars <= 34 && words <= 6) signals.add('short');
    else if (chars >= 82 || words >= 14) signals.add('long');
    else signals.add('medium');
    if (secondary) signals.add('secondary');
    else signals.add('single');
    if (itemCount >= 3 || density === 'dense' || density === 'compact') signals.add('dense');
    if (/left|right/.test(safeZone)) signals.add('edge');
    if (safeZone === 'center' || /center/.test(layout)) signals.add('center');
    if (['keyword', 'minimal'].includes(strategy)) signals.add('keyword');
    if (strategy === 'data' || itemCount > 0) signals.add('data');
    if (['full', 'headline', 'data'].includes(strategy)) signals.add('information');
    if (secondary && /lower-third|identity|profile/.test(`${layout} ${mood}`)) signals.add('identity');
    if (/minimal|clean|quiet|subtle|calm|editorial|documentary/.test(mood)) {
        signals.add('minimal');
        signals.add('calm');
    }
    if (/editorial|documentary|paper|news/.test(mood)) signals.add('editorial');
    if (/formal|corporate|official|evidence|technical|data/.test(mood)) signals.add('formal');
    if (/energy|energetic|urgent|impact|punch|bold|fast|breaking|dramatic/.test(mood)) signals.add('energetic');
    if (/urgent|breaking|warning|alert/.test(mood)) signals.add('urgent');
    if (/strong|bold|impact|punch/.test(mood)) signals.add('strong');
    if (/focus|keyword|hero|center/.test(`${strategy} ${layout} ${mood}`)) signals.add('focus');

    return {
        id: String(input.id || input.clipId || input.sourceId || text),
        role: token(input.role || input.kind, 'overlay'),
        type,
        text,
        secondary,
        itemCount,
        density,
        strategy,
        safeZone,
        layout,
        mood,
        chars,
        words,
        signals,
    };
}

function recipeAllowed(recipe, context) {
    if (!recipe || recipe.auto) return false;
    if (recipe.requiresSecondary && !context.secondary) return false;
    if (Number.isFinite(Number(recipe.maxChars)) && context.chars > Number(recipe.maxChars)) return false;
    if (Number.isFinite(Number(recipe.maxItems)) && context.itemCount > Number(recipe.maxItems)) return false;
    return true;
}

function scoreRecipe(id, recipe, context) {
    if (!recipeAllowed(recipe, context)) return -Infinity;
    let score = 0;
    for (const [signal, weight] of Object.entries(recipe.signals || {})) {
        if (context.signals.has(signal)) score += Number(weight) || 0;
    }
    for (const [signal, weight] of Object.entries(recipe.penalties || {})) {
        if (context.signals.has(signal)) score -= Number(weight) || 0;
    }
    score += stableUnit(`${context.id}:${id}`) * 0.65;
    return score;
}

function recommendedGraphicShells(input = {}, limit = 4) {
    const context = shellContext(input);
    return Object.entries(GRAPHIC_SHELL_RECIPES)
        .filter(([, recipe]) => recipeAllowed(recipe, context))
        .map(([id, recipe]) => ({
            id,
            label: recipe.label,
            description: recipe.description,
            score: Number(scoreRecipe(id, recipe, context).toFixed(3)),
            shell: { ...recipe.shell },
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Number(limit) || 4));
}

function contextualGraphicShell(input = {}) {
    const recommendation = recommendedGraphicShells(input, 1)[0];
    const fallback = GRAPHIC_SHELL_RECIPES.underline;
    return {
        ...(recommendation?.shell || fallback.shell),
        preset: recommendation?.id || 'underline',
        source: 'contextual',
    };
}

function allowedValue(dimension, value, fallback) {
    const normalized = token(value, '');
    return GRAPHIC_SHELL_VALUES[dimension]?.includes(normalized) ? normalized : fallback;
}

function normalizeGraphicShell(raw, input = {}) {
    const context = shellContext(input);
    const manual = bool(input.manual || input.graphicShellManual);
    let source = raw;
    if (typeof raw === 'string') source = { preset: raw };
    if (!source || typeof source !== 'object' || Array.isArray(source)) source = {};

    const presetId = token(source.preset || source.recipe || '', '');
    const requestedRecipe = GRAPHIC_SHELL_RECIPES[presetId];
    const base = requestedRecipe && !requestedRecipe.auto
        ? requestedRecipe.shell
        : contextualGraphicShell(input);
    const dimensionKeys = Object.keys(GRAPHIC_SHELL_VALUES);
    const hasExplicitDimensions = dimensionKeys.some((dimension) => (
        Object.prototype.hasOwnProperty.call(source, dimension)
        && source[dimension] != null
        && source[dimension] !== ''
    ));
    const recipeWasCustomized = Boolean(
        requestedRecipe
        && !requestedRecipe.auto
        && dimensionKeys.some((dimension) => (
            Object.prototype.hasOwnProperty.call(source, dimension)
            && allowedValue(dimension, source[dimension], requestedRecipe.shell[dimension])
                !== requestedRecipe.shell[dimension]
        ))
    );
    const shell = {
        surface: allowedValue('surface', source.surface, base.surface),
        accent: allowedValue('accent', source.accent, base.accent),
        geometry: allowedValue('geometry', source.geometry, base.geometry),
        hierarchy: allowedValue('hierarchy', source.hierarchy, base.hierarchy),
        width: allowedValue('width', source.width, base.width),
        emphasis: allowedValue('emphasis', source.emphasis, base.emphasis),
        preset: requestedRecipe && !requestedRecipe.auto && !recipeWasCustomized
            ? presetId
            : (
                source.preset === 'auto'
                    ? 'auto'
                    : (hasExplicitDimensions ? 'custom' : (base.preset || 'custom'))
            ),
        source: manual
            ? 'manual'
            : token(source.source, requestedRecipe && !requestedRecipe.auto ? 'recipe' : (base.source || 'contextual')),
    };

    if (!context.secondary && shell.hierarchy === 'split') shell.hierarchy = 'single';
    if ((context.chars > 72 || context.itemCount > 2) && shell.geometry === 'slanted') {
        shell.geometry = 'square';
    }
    if (context.chars > 96 && shell.width === 'content') shell.width = 'wide';
    // Dedicated data/stage components own their grid and safe-area geometry.
    // Automatic shells may still provide surface/accent styling, but they must
    // not suggest a narrow structural width that conflicts with the component.
    if (!manual && [
        'comparison-card',
        'bar-chart',
        'donut-chart',
        'ranking-list',
        'bullet-list',
        'timeline',
        'listicle-grid',
        'split-screen',
        'infographic',
    ].includes(context.type)) {
        shell.width = 'wide';
        if (shell.geometry === 'slanted') shell.geometry = 'square';
    }
    // Explicit editing decisions outrank an automatic structural suggestion.
    // Agent/UI edits that intentionally request a surface/accent update clear
    // these flags before render; inherited automatic shells must respect them.
    if (bool(input.transparentBackground || input.noSurface)) shell.surface = 'none';
    if (input.accentRuleVisible === false || bool(input.noAccent)) shell.accent = 'none';
    return shell;
}

function graphicShellClassNames(shellValue, input = {}, prefix = 'hf') {
    const shell = normalizeGraphicShell(shellValue, input);
    return [
        `${prefix}-shell-enabled`,
        `${prefix}-shell-surface-${shell.surface}`,
        `${prefix}-shell-accent-${shell.accent}`,
        `${prefix}-shell-geometry-${shell.geometry}`,
        `${prefix}-shell-hierarchy-${shell.hierarchy}`,
        `${prefix}-shell-width-${shell.width}`,
        `${prefix}-shell-emphasis-${shell.emphasis}`,
    ].join(' ');
}

function graphicShellData(shellValue, input = {}) {
    const shell = normalizeGraphicShell(shellValue, input);
    return {
        shell,
        attrs: [
            `data-hf-shell-surface="${shell.surface}"`,
            `data-hf-shell-accent="${shell.accent}"`,
            `data-hf-shell-geometry="${shell.geometry}"`,
            `data-hf-shell-hierarchy="${shell.hierarchy}"`,
            `data-hf-shell-width="${shell.width}"`,
            `data-hf-shell-emphasis="${shell.emphasis}"`,
            `data-hf-shell-source="${shell.source}"`,
        ].join(' '),
    };
}

function getGraphicShellCapabilities(input = {}) {
    const context = shellContext(input);
    return {
        structuralOnly: true,
        colorsOwnedByTheme: true,
        dimensions: Object.fromEntries(
            Object.entries(GRAPHIC_SHELL_VALUES).map(([key, values]) => [key, [...values]])
        ),
        recommended: recommendedGraphicShells(context, 4).map((entry) => ({
            id: entry.id,
            description: entry.description,
            shell: entry.shell,
        })),
    };
}

function getGraphicShellRecipes() {
    return Object.entries(GRAPHIC_SHELL_RECIPES).map(([id, recipe]) => ({
        id,
        label: recipe.label,
        description: recipe.description,
        auto: recipe.auto === true,
        shell: recipe.shell ? { ...recipe.shell } : null,
    }));
}

function parseGraphicShellInstruction(value) {
    const text = compactText(value).toLowerCase();
    if (!text) return null;
    const structuralIntent = /\b(?:structure|structural|shell|frame|framing|nameplate|label\s+style|graphic\s+style|text\s+style|layout\s+style)\b/.test(text);
    const actionIntent = /\b(?:use|make|change|set|switch|apply|give|turn|design)\b/.test(text);
    if (!structuralIntent && !actionIntent) return null;

    const aliases = [
        ['split-label', /\b(?:split\s+label|two[\s-]?level\s+label|name\s+and\s+(?:role|title)|nameplate)\b/],
        ['solid-label', /\b(?:solid\s+(?:label|tag|bar)|filled\s+(?:label|tag)|title\s+bar)\b/],
        ['outline-box', /\b(?:outline(?:d)?\s+(?:box|frame|label)|wire\s*frame)\b/],
        ['corner-frame', /\b(?:corner\s+(?:frame|bracket)|bracket(?:ed)?\s+(?:frame|label|text))\b/],
        ['slanted-tag', /\b(?:slanted|angled|skewed|diagonal)\s+(?:tag|label|box|frame)\b/],
        ['soft-panel', /\b(?:soft|frosted|subtle)\s+(?:panel|box|plate)\b/],
        ['underline', /\b(?:underline|underlined|bottom\s+(?:line|rule))\b/],
        ['rail', /\b(?:side\s+rail|vertical\s+(?:rail|line|bar)|left\s+accent)\b/],
        ['naked', /\b(?:naked|text\s+only|no\s+(?:box|frame|plate|background))\b/],
    ];
    const recipe = aliases.find(([, pattern]) => pattern.test(text))?.[0];
    const requested = recipe ? { preset: recipe } : {};

    // Fast-mode language support composes dimensions independently. This is a
    // grammar for the live capability vocabulary, not a task-name switchboard;
    // Smart mode can supply any valid combination directly through the schema.
    if (/\b(?:no|without|remove|transparent|open|text\s+only)\s+(?:(?:the|an?|any)\s+)?(?:box|frame|panel|plate|background|surface|structure|shell|style)\b|\bnaked\b/.test(text)) {
        requested.surface = 'none';
    } else if (/\b(?:filled|solid|opaque)\s+(?:box|frame|panel|plate|label|surface)\b/.test(text)) {
        requested.surface = 'solid';
    } else if (/\b(?:soft|frosted|subtle|glass(?:y)?)\s+(?:box|frame|panel|plate|surface)\b/.test(text)) {
        requested.surface = 'soft';
    } else if (/\b(?:outline|outlined|wire)\s+(?:box|frame|panel|plate|label|surface|shell)\b/.test(text)) {
        requested.surface = 'outline';
    }

    if (/\b(?:no|without|remove|hide|delete)\b.{0,28}\b(?:accent|decorative\s+(?:bar|line|rule)|rail|tab|bracket|underline)\b/.test(text)) {
        requested.accent = 'none';
    } else if (/\b(?:underline|underlined|bottom\s+(?:line|rule))\b/.test(text)) {
        requested.accent = 'underline';
    } else if (/\b(?:side|vertical|left)\s+(?:rail|line|bar|accent)\b/.test(text)) {
        requested.accent = 'rail';
    } else if (/\b(?:top\s+tab|accent\s+tab|label\s+tab)\b/.test(text)) {
        requested.accent = 'tab';
    } else if (/\b(?:corner\s+brackets?|bracketed)\b/.test(text)) {
        requested.accent = 'bracket';
    }

    if (/\b(?:rounded|round-cornered|soft-cornered)\b/.test(text)) requested.geometry = 'rounded';
    else if (/\b(?:slanted|angled|skewed|diagonal)\b/.test(text)) requested.geometry = 'slanted';
    else if (/\b(?:square|sharp-cornered|straight-cornered)\b/.test(text)) requested.geometry = 'square';

    if (/\b(?:split|two[\s-]?level|separate)\s+(?:hierarchy|label|levels?|title|copy)\b/.test(text)) {
        requested.hierarchy = 'split';
    } else if (/\b(?:stacked|two[\s-]?line|title\s+over\s+subtitle)\b/.test(text)) {
        requested.hierarchy = 'stacked';
    } else if (/\b(?:single|one[\s-]?line|one[\s-]?level)\b/.test(text)) {
        requested.hierarchy = 'single';
    }

    if (/\b(?:content[\s-]?width|fit\s+(?:the\s+)?text|hug\s+(?:the\s+)?text)\b/.test(text)) requested.width = 'content';
    else if (/\bcompact\b/.test(text)) requested.width = 'compact';
    else if (/\b(?:wide|full[\s-]?width|extended)\b/.test(text)) requested.width = 'wide';

    if (/\b(?:quiet|subtle|restrained|low[\s-]?key)\b/.test(text)) requested.emphasis = 'quiet';
    else if (/\b(?:strong|bold|punchy|high[\s-]?impact)\b/.test(text)) requested.emphasis = 'strong';
    else if (/\b(?:balanced|medium)\b/.test(text)) requested.emphasis = 'balanced';

    if (!Object.keys(requested).length) return null;
    return {
        ...requested,
        source: 'instruction',
    };
}

function buildGraphicShellCss() {
    return `
    /* Agentic graphic shell system. Structure is independent from theme color. */
    .hf-shell-enabled {
      --hf-shell-pad-x: 38px;
      --hf-shell-pad-y: 24px;
      --hf-shell-line: 5px;
      /* Where an accent mark starts horizontally. It tracks the padding so the
       * mark lines up with the first character of the copy instead of with the
       * edge of the box — a rule that starts at the panel edge and a rule that
       * starts under the text read as two different levels of care. */
      --hf-shell-mark-inset: var(--hf-shell-pad-x);
      --hf-shell-surface: color-mix(in srgb, var(--hf-bg), transparent 7%);
      --hf-shell-soft: color-mix(in srgb, var(--hf-bg), transparent 28%);
      --hf-shell-outline: color-mix(in srgb, var(--hf-primary), transparent 36%);
    }
    /* No panel means no padding to sit inside; the copy starts near the box edge
     * and the mark has to follow it there. */
    .hf-shell-enabled.hf-shell-surface-none { --hf-shell-mark-inset: 8px; }
    /*
     * Layout ownership contract:
     * - component-owned graphics keep all position/grid/width/padding geometry;
     * - shells remain visual skin (surface, border, accent, radius);
     * - flow-copy graphics may opt into shell-owned sizing below.
     *
     * This prevents a generic shell from turning an absolute fullscreen layout
     * into a narrow relative box, which used to break comparison/data cards.
     */
    .hf-shell-enabled:not(.hf-component-layout-owned) .hf-agentic-stage { grid-template-columns: minmax(0, 1fr) !important; }
    /*
     * One mark per graphic.
     *
     * The old rule here stood the engine's own accent rule down only for
     * graphics the shell also owned the layout of. Component-owned graphics —
     * lower thirds, callouts, most of what actually ships — kept their rule AND
     * got the shell's accent on top, so two unrelated marks drew on the same
     * card. That doubling is visible in any frame of a finished video once you
     * know to look for it, and it is a large part of why the graphics read as
     * assembled rather than designed.
     *
     * The contract now: whoever provides the accent owns the mark, and nobody
     * else draws one. A shell with an accent silences the engine's rule; a shell
     * with no accent lets it through, because then it is the only mark there is;
     * a naked shell (no surface, no accent) means no mark at all, which is what
     * the recipe promises.
     */
    .hf-shell-enabled:not(.hf-shell-accent-none) .hf-agentic-rule { display: none; }
    .hf-shell-enabled.hf-shell-accent-none.hf-shell-surface-none .hf-agentic-rule { display: none; }
    .hf-shell-enabled:not(.hf-component-layout-owned) .hf-shell-target {
      position: relative;
      box-sizing: border-box;
      padding: var(--hf-shell-pad-y) var(--hf-shell-pad-x) !important;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      backdrop-filter: none;
      isolation: isolate;
    }
    .hf-shell-enabled.hf-component-layout-owned .hf-shell-target {
      box-sizing: border-box;
      isolation: isolate;
    }
    /*
     * Stand down every mark the engine draws on the copy box, so the shell is the
     * only thing that can put an accent on a graphic.
     *
     * This reset was already here and it was already right in intent — it just
     * lost. The engine's per-variant marks are written as type-dot-variant then
     * the copy box and its after-pseudo: three classes deep, where this reset is
     * two. So the engine won the specificity race every time, and a shelled
     * callout drew the shell's tab AND its own bar. Two unrelated accent marks on
     * one card, on every card, is precisely the doubling this whole pass exists to
     * remove; it was invisible in review because each rule looks correct alone.
     *
     * !important rather than more classes, because the point is to be unbeatable
     * by anything downstream, not to win one specificity race today. The shell's
     * own accents below carry their own !important and one more class, so they
     * still come through. A graphic with no shell keeps its engine mark — the
     * reset is scoped to .hf-shell-enabled and cannot reach it.
     */
    .hf-shell-enabled .hf-shell-target::before,
    .hf-shell-enabled .hf-shell-target::after { content: none !important; }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-width-content .hf-shell-target { justify-self: start; width: fit-content; max-width: min(100%, 980px); }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-width-compact .hf-shell-target { width: min(880px, 100%); }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-width-wide .hf-shell-target { width: min(1280px, 100%); }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-agentic-safe-center.hf-shell-width-content .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-agentic-safe-center.hf-shell-width-compact .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-agentic-safe-center.hf-shell-width-wide .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).pos-center.hf-shell-width-content .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).pos-center.hf-shell-width-compact .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).pos-center.hf-shell-width-wide .hf-shell-target { justify-self: center; margin-inline: auto; }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-agentic-safe-top-right.hf-shell-width-content .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-agentic-safe-bottom-right.hf-shell-width-content .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-agentic-safe-center-right.hf-shell-width-content .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).pos-top-right.hf-shell-width-content .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).pos-bottom-right.hf-shell-width-content .hf-shell-target,
    .hf-shell-enabled:not(.hf-component-layout-owned).pos-center-right.hf-shell-width-content .hf-shell-target { justify-self: end; margin-left: auto; }

    .hf-shell-surface-none .hf-shell-target {
      background: transparent !important;
      border-color: transparent !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
    }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-surface-none .hf-shell-target {
      padding-left: 8px !important;
      padding-right: 8px !important;
    }
    .hf-shell-surface-solid .hf-shell-target {
      background: var(--hf-shell-surface) !important;
      box-shadow: var(--hf-shadow) !important;
    }
    .hf-shell-surface-soft .hf-shell-target {
      background: var(--hf-shell-soft) !important;
      box-shadow: 0 18px 52px rgba(0,0,0,0.26) !important;
      backdrop-filter: blur(22px) saturate(1.08) !important;
    }
    .hf-shell-surface-outline .hf-shell-target {
      background: color-mix(in srgb, var(--hf-bg), transparent 72%) !important;
      border: max(2px, var(--hf-stroke)) solid var(--hf-shell-outline) !important;
      box-shadow: none !important;
      backdrop-filter: blur(10px) !important;
    }

    /*
     * Accents.
     *
     * All four of these used to be a thick coloured bar hugging an edge of the
     * box: a full-width underline, a full-height 7.5px left rail, and a
     * primary-to-accent gradient bar across the top-left corner. One of those on
     * one graphic is a design decision. The same one on every graphic in a video
     * is a template, and "looks AI-made" is largely what a template looks like
     * from the outside.
     *
     * They survived this long because the checker could not see them. The widths
     * were written as calc(var(--hf-shell-line) * 1.5), the length parser took
     * the first number it found — the multiplier — and a 7.5px rail measured as
     * 1.5px, comfortably under the floor. The colour parser had the same problem
     * from the other end: it took the first var() in the shorthand, which was the
     * width variable, decided the edge had no colour, and moved on.
     *
     * What replaces them are marks sized to the TYPE rather than to the box: a
     * short rule riding the top edge, a short rule under the copy, a tick beside
     * the first line, corner crop marks. The four recipes stay easy to tell
     * apart, and none of them is a stripe down the side of a card.
     */
    .hf-shell-enabled.hf-shell-accent-underline .hf-shell-target::after {
      content: "" !important;
      position: absolute;
      left: var(--hf-shell-mark-inset);
      bottom: max(3px, calc(var(--hf-shell-pad-y) * 0.4));
      width: 88px;
      height: 3px;
      background: var(--hf-adaptive-accent, var(--hf-accent));
      z-index: 3;
    }
    /* A tick beside the first line, not a bar down the whole block. The height is
     * deliberately about one line of display type: it marks where the copy
     * starts, which is what a rail is for, without turning into chrome. */
    .hf-shell-enabled.hf-shell-accent-rail .hf-shell-target::before {
      content: "" !important;
      position: absolute;
      left: max(6px, calc(var(--hf-shell-mark-inset) * 0.42));
      top: max(6px, calc(var(--hf-shell-pad-y) * 0.9));
      width: 3px;
      height: 34px;
      background: var(--hf-adaptive-accent, var(--hf-accent));
      z-index: 3;
    }
    /* Flat accent, not a gradient. A two-stop brand gradient on a 5px bar is one
     * of the most reliable generated-design signatures there is. */
    .hf-shell-enabled.hf-shell-accent-tab .hf-shell-target::before {
      content: "" !important;
      position: absolute;
      left: var(--hf-shell-mark-inset);
      top: 0;
      width: 64px;
      height: 4px;
      background: var(--hf-adaptive-accent, var(--hf-accent));
      z-index: 3;
    }
    /* Crop marks: longer arms, hairline weight. Heavy 5px corners read as a
     * decorated card; thin ones read as a camera frame, which is the intent. */
    .hf-shell-enabled.hf-shell-accent-bracket .hf-shell-target::before,
    .hf-shell-enabled.hf-shell-accent-bracket .hf-shell-target::after {
      content: "" !important;
      position: absolute;
      width: 34px;
      height: 34px;
      pointer-events: none;
      border-color: var(--hf-adaptive-accent, var(--hf-accent));
      border-style: solid;
      z-index: 3;
    }
    .hf-shell-enabled.hf-shell-accent-bracket .hf-shell-target::before {
      left: 0;
      top: 0;
      border-width: 2px 0 0 2px;
    }
    .hf-shell-enabled.hf-shell-accent-bracket .hf-shell-target::after {
      right: 0;
      bottom: 0;
      border-width: 0 2px 2px 0;
    }

    /*
     * Centred layouts get centred marks.
     *
     * Before this, a mark anchored at left:0 sat hard against the left edge of a
     * copy box whose text was centred — a red bar floating off on its own with
     * nothing under it. It looked like a bug because it was one.
     *
     * The list is placement classes, not type classes. Type is the wrong key: a
     * headline is centred in one layout and left-hung in another, and keying on
     * the type would have centred the mark under copy that was not centred. The
     * placement classes are what the renderer decides alignment with, so they are
     * what the mark follows. Brackets are excluded — a corner frame belongs in
     * the corners.
     *
     * pos-center is scoped to the legacy path on purpose. In the agentic markup
     * it is not a placement signal at all — EVERY agentic graphic carries it,
     * including lower thirds that are explicitly hf-agentic-safe-bottom-left. It
     * was in this list at first and it centred the mark on every graphic in the
     * video; a screenshot showed a bottom-left lower third with its rule floating
     * over the middle of the title, and the class list looked correct right up
     * until it was read past the point where the interesting classes start. In
     * the legacy markup pos-* really does drive placement, so it stays there.
     */
    .hf-shell-enabled:not(.hf-shell-accent-bracket):is(
      .hf-agentic-safe-center,
      .hf-agentic-layout-focus-panel, .hf-agentic-layout-data-focus
    ) .hf-shell-target::before,
    .hf-shell-enabled:not(.hf-shell-accent-bracket):is(
      .hf-agentic-safe-center,
      .hf-agentic-layout-focus-panel, .hf-agentic-layout-data-focus
    ) .hf-shell-target::after,
    .hf-shell-enabled:not(.hf-agentic):not(.hf-shell-accent-bracket).pos-center .hf-shell-target::before,
    .hf-shell-enabled:not(.hf-agentic):not(.hf-shell-accent-bracket).pos-center .hf-shell-target::after {
      left: 50%;
      transform: translateX(-50%);
    }

    .hf-shell-geometry-square .hf-shell-target { border-radius: 0 !important; }
    .hf-shell-geometry-rounded .hf-shell-target { border-radius: max(14px, var(--hf-radius)) !important; }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-geometry-slanted .hf-shell-target {
      border-radius: 0 !important;
      clip-path: polygon(20px 0, 100% 0, calc(100% - 20px) 100%, 0 100%);
      padding-left: calc(var(--hf-shell-pad-x) + 12px) !important;
      padding-right: calc(var(--hf-shell-pad-x) + 12px) !important;
    }

    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-hierarchy-split .hf-shell-target {
      display: grid;
      justify-items: start;
      gap: 5px;
      padding: 0 !important;
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      overflow: visible;
    }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-hierarchy-split .hf-shell-target > :is(
      .hf-agentic-title, .hf-agentic-subtitle, .hf-agentic-kicker,
      .hf-title, .hf-subtitle, .hf-kicker, .hf-stat-value, .hf-stat-label
    ) {
      display: block;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
      padding: 10px 20px;
      background: var(--hf-shell-surface);
    }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-hierarchy-split .hf-shell-target > :is(.hf-agentic-subtitle, .hf-subtitle, .hf-stat-label) {
      padding: 7px 18px 7px 15px;
      /* The same side-bar tell, one level down: a 5px accent stripe on the edge
       * of the secondary chip. A hairline keeps the two chips distinguishable —
       * which is the job — without the stripe. */
      border-left: 1px solid var(--hf-adaptive-accent, var(--hf-accent));
      background: color-mix(in srgb, var(--hf-bg), transparent 22%);
    }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-surface-none.hf-shell-hierarchy-split .hf-shell-target > * {
      background: transparent !important;
    }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-hierarchy-split.hf-shell-geometry-slanted .hf-shell-target > :is(
      .hf-agentic-title, .hf-agentic-subtitle, .hf-agentic-kicker,
      .hf-title, .hf-subtitle, .hf-kicker, .hf-stat-value, .hf-stat-label
    ) {
      clip-path: polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%);
      padding-left: 28px;
      padding-right: 28px;
    }
    .hf-shell-hierarchy-single .hf-agentic-subtitle { margin-top: 2px; }
    .hf-shell-enabled:not(.hf-component-layout-owned).hf-shell-hierarchy-stacked .hf-shell-target { gap: 8px; }

    .hf-shell-emphasis-quiet {
      --hf-shell-line: 3px;
      --hf-shell-pad-x: 28px;
      --hf-shell-pad-y: 18px;
    }
    .hf-shell-emphasis-strong {
      --hf-shell-line: 7px;
      --hf-shell-pad-x: 44px;
      --hf-shell-pad-y: 27px;
    }
    .hf-shell-emphasis-strong :is(.hf-agentic-title, .hf-title, .hf-stat-value) { font-weight: 950; }
    `;
}

const GRAPHIC_SHELL_API = {
    GRAPHIC_SHELL_RECIPES,
    GRAPHIC_SHELL_VALUES,
    buildGraphicShellCss,
    contextualGraphicShell,
    getGraphicShellCapabilities,
    getGraphicShellRecipes,
    graphicShellClassNames,
    graphicShellData,
    normalizeGraphicShell,
    parseGraphicShellInstruction,
    recommendedGraphicShells,
    shellContext,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = GRAPHIC_SHELL_API;
}
if (typeof window !== 'undefined') {
    window._graphicShells = GRAPHIC_SHELL_API;
}
})();
