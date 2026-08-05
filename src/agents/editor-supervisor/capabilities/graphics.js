'use strict';

const {
    GRAPHIC_EDITABLE_PROPERTIES,
    editScopedGraphicContent,
    editScopedGraphicProperties,
    editScopedGraphicTextStyle,
    inspectScopedGraphics,
    regenerateScopedGraphics,
} = require('../workers/graphics-editor');
const {
    FULLSCREEN_MG_TYPES,
    STYLE_NAMES,
} = require('../../ai-motion-graphics');
const {
    TEMPLATE_REGISTRY,
    TEMPLATE_TYPES,
} = require('../../ai-templates');
const { MG_REGISTRY } = require('../../../render/mg-registry');
const {
    COLOR_ALIASES,
    normalizeTextColor,
} = require('../../../render/text-style-ranges');
const {
    GRAPHIC_SHELL_VALUES,
    getGraphicShellRecipes,
    parseGraphicShellInstruction,
} = require('../../../render/graphic-shells');
const {
    array,
    boolean: booleanField,
    integer,
    number,
    object,
    string,
    tool,
} = require('./capability-contract');

const GRAPHIC_TYPES = [...new Set([
    ...Object.keys(MG_REGISTRY || {}),
    ...FULLSCREEN_MG_TYPES,
    ...TEMPLATE_TYPES,
])].sort();
const GRAPHIC_ANIMATIONS = [...new Set([
    ...Object.values(MG_REGISTRY || {}).flatMap((entry) => entry?.animations || []),
    ...Object.values(TEMPLATE_REGISTRY || {}).flatMap((entry) => entry?.animations || []),
])].sort();
const GRAPHIC_VARIANTS = [...new Set([
    ...Object.values(MG_REGISTRY || {}).flatMap((entry) => Object.keys(entry?.types || {})),
    ...Object.values(TEMPLATE_REGISTRY || {}).flatMap((entry) => entry?.variants || []),
])].sort();
const GRAPHIC_SHELL_RECIPES = [
    ...getGraphicShellRecipes().map((recipe) => recipe.id),
    'custom',
];
const GRAPHIC_POSITIONS = [
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
    'center-left',
    'center-right',
    'center',
];

const TYPE_ALIASES = [
    ['lowerThird', /\blower[\s-]?thirds?\b/i],
    ['statCounter', /\bstat\s+counter\b/i],
    ['kineticText', /\bkinetic\s+text\b/i],
    ['focusWord', /\bfocus\s+word\b/i],
    ['progressBar', /\bprogress\s+bar\b/i],
    ['bulletList', /\bbullet\s+list\b/i],
    ['barChart', /\bbar\s+chart\b/i],
    ['donutChart', /\b(?:donut|pie)\s+chart\b/i],
    ['comparisonCard', /\bcomparison\s+card\b/i],
    ['rankingList', /\branking\s+list\b/i],
    ['statCard', /\bstat\s+card\b/i],
    ['factCard', /\bfact\s+card\b/i],
    ['quoteCard', /\bquote\s+card\b/i],
    ['chapterCard', /\bchapter\s+card\b/i],
    ['locationCard', /\blocation\s+card\b/i],
    ['keyTakeaway', /\bkey\s+takeaway\b/i],
    ['personIntro', /\bperson\s+intro\b/i],
    ['listicleGrid', /\blisticle\s+grid\b/i],
    ['mapChart', /\bmap(?:\s+chart)?\b/i],
    ['headline', /\bhead(?:lines?|ings?|lings?|ines?)\b/i],
    ['callout', /\bcallout\b/i],
    ['typewriter', /\btypewriter\b/i],
];
const COLOR_WORD_PATTERN = new RegExp(
    `\\b(${Object.keys(COLOR_ALIASES)
        .sort((left, right) => right.length - left.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})\\b`,
    'ig'
);
const GENERIC_GRAPHIC_WORDS = /\b(?:this|that|the|selected|current|existing|graphic|motion\s+graphic|text|copy|wording|words?|title|label|lower[\s-]?thirds?|head(?:lines?|ings?|lings?|ines?)|callout|stat\s+counter)\b/ig;

function _cleanRequestedText(value) {
    let text = String(value || '').trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/[.!?]+$/g, '')
        .trim();
    if (/^the\s+(?:[$€£]?\s*\d)/i.test(text)) text = text.replace(/^the\s+/i, '');
    return text.slice(0, 2_000);
}

function _typeFromText(text, fallback = '') {
    const raw = String(text || '');
    const concrete = TYPE_ALIASES.find(([type, pattern]) => (
        type !== 'typewriter' && pattern.test(raw)
    ))?.[0];
    if (concrete) return concrete;

    const mentionsTypewriter = /\btypewriter\b/i.test(raw);
    const usesTypewriterAsMotion = (
        /\btypewriter\s+(?:animation|motion|entrance|effect|reveal)\b/i.test(raw)
        || /\b(?:animation|motion|entrance|animate|reveal)\b.{0,32}\btypewriter\b/i.test(raw)
    );
    if (mentionsTypewriter && !usesTypewriterAsMotion) return 'typewriter';
    return fallback;
}

function _hasExplicitVisualSelection(request) {
    const scope = request?.scope || {};
    return scope.kind === 'visual'
        || (scope.scopeMode !== 'scene' && (scope.visualRefs || []).length > 0);
}

function _stripTrailingGraphicClause(value) {
    return String(value || '').replace(
        /\s+(?:in|on|from)\s+(?:the\s+)?(?:lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout|stat\s+counter|motion\s+graphic)\s*$/i,
        ''
    );
}

function _selectedVisualType(request, fallback = '') {
    if (!_hasExplicitVisualSelection(request)) return fallback;
    return String(request?.scope?.visualRefs?.[0]?.type || fallback || '').trim();
}

function _selectedVisualLabel(request) {
    if (!_hasExplicitVisualSelection(request)) return '';
    return String(request?.scope?.visualRefs?.[0]?.label || '').trim();
}

function _graphicIntent(text) {
    return /\b(?:graphic|motion\s+graphic|lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout|stat\s+counter|title|text|copy|wording|label|background|bg|box|plate|card\s+background|accent\s+(?:bar|line|rule|rail)|decorative\s+(?:bar|line|rule|rail)|side\s+(?:bar|line|rule|rail)|animation|motion|entrance|animate|typewriter|shadow|position|move|place|style|look|variant|template|layout|font|letter|colou?r|recolou?r|duration|screen\s+time|on\s+screen|display\s+time)\b/i.test(
        String(text || '')
    );
}

function _graphicTarget(request, text, fallback = '') {
    const raw = String(text || '');
    const refs = Array.isArray(request?.scope?.visualRefs)
        ? request.scope.visualRefs.filter((ref) => ref && ref.id != null)
        : [];
    const explicitType = _typeFromText(raw, '');
    const selectedType = _selectedVisualType(request, '');
    const fallbackType = _typeFromText(String(fallback || ''), String(fallback || '').trim());
    const fallbackIsMotionWord = fallbackType === 'typewriter' && (
        /\btypewriter\s+(?:animation|motion|entrance|effect|reveal)\b/i.test(raw)
        || /\b(?:animation|motion|entrance|animate|reveal)\b.{0,32}\btypewriter\b/i.test(raw)
    );
    let targetType = explicitType || selectedType || (fallbackIsMotionWord ? '' : fallbackType);

    if (!targetType && refs.length === 1 && _graphicIntent(raw)) {
        targetType = String(refs[0]?.type || '').trim();
    }

    const matchingIds = targetType
        ? refs
            .filter((ref) => (
                String(ref?.type || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
                === String(targetType).toLowerCase().replace(/[^a-z0-9]+/g, '')
            ))
            .map((ref) => String(ref.id))
        : [];
    const targetIds = matchingIds.length
        ? matchingIds
        : (
            (_hasExplicitVisualSelection(request) || refs.length === 1)
                ? refs.map((ref) => String(ref.id))
                : []
        );
    const label = refs.find((ref) => targetIds.includes(String(ref.id)))?.label || '';
    return {
        targetType,
        targetIds,
        label: String(label || '').trim(),
    };
}

function _registeredVariantsForType(type) {
    return [...new Set([
        ...Object.keys(MG_REGISTRY?.[type]?.types || {}),
        ...(TEMPLATE_REGISTRY?.[type]?.variants || []),
    ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function _stableChoiceIndex(seed, length) {
    if (length <= 1) return 0;
    const value = String(seed || '');
    let hash = 0;
    for (let index = 0; index < value.length; index++) {
        hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
    }
    return hash % length;
}

function _nextDifferent(values, current, seed = '') {
    const pool = [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
    if (!pool.length) return '';
    const currentIndex = pool.indexOf(String(current || ''));
    if (currentIndex >= 0) {
        return pool.length > 1 ? pool[(currentIndex + 1) % pool.length] : '';
    }
    return pool[_stableChoiceIndex(seed, pool.length)] || pool[0] || '';
}

function _compatibleRestyleVariants(type, variants, itemCount) {
    if (type !== 'statCard') return variants;
    if (itemCount <= 1) return variants.includes('single') ? ['single'] : variants;
    if (itemCount === 2) {
        const twoStat = variants.filter((variant) => ['sideBySide', 'stacked'].includes(variant));
        return twoStat.length ? twoStat : variants;
    }
    return variants;
}

function _parseAlternateStyleInstruction(text, directives = {}, request = {}, plan = {}) {
    const raw = String(text || '').trim();
    const alternateIntent = (
        /\b(?:another|different|new|alternate|alternative|fresh)\s+(?:visual\s+)?(?:style|look|design|layout|presentation)\b/i.test(raw)
        || /\b(?:restyle|re-style|redesign|re-design)\b/i.test(raw)
        || /\b(?:change|switch|update)\b.{0,36}\b(?:style|look|design|layout)\b/i.test(raw)
    );
    if (!alternateIntent) return null;

    const target = _graphicTarget(request, raw, directives?.graphics?.requestedType || '');
    if (!target.targetType || !_hasExplicitVisualSelection(request)) return null;

    let candidates = inspectScopedGraphics(plan, request.scope);
    if (target.targetIds.length) {
        const targetIds = new Set(target.targetIds.map(String));
        candidates = candidates.filter((graphic) => targetIds.has(String(graphic.id || '')));
    }
    const wantedType = String(target.targetType).toLowerCase().replace(/[^a-z0-9]+/g, '');
    candidates = candidates.filter((graphic) => (
        String(graphic.type || '').toLowerCase().replace(/[^a-z0-9]+/g, '') === wantedType
    ));
    if (candidates.length !== 1) return null;

    const current = candidates[0];
    const args = {
        targetType: target.targetType,
        targetIds: [String(current.id || target.targetIds[0] || '')].filter(Boolean),
        all: false,
    };
    const style = _nextDifferent(
        STYLE_NAMES,
        current.style,
        `${current.id}:${current.type}:${current.style}`
    );
    if (style && style !== current.style) args.style = style;

    const variants = _compatibleRestyleVariants(
        target.targetType,
        _registeredVariantsForType(target.targetType),
        Number(current.itemCount) || 0
    );
    const variant = _nextDifferent(
        variants,
        current.variant,
        `${current.id}:${current.type}:${current.variant}`
    );
    if (variant && variant !== current.variant) args.variant = variant;

    return Object.keys(args).some((key) => !['targetType', 'targetIds', 'all'].includes(key))
        ? args
        : null;
}

function _requestExplicitlyTargetsSceneIcons(request) {
    const raw = String(request?.originalText || request?.text || '');
    return /\b(?:(?:scene|explainer)\s+)?icons?\b/i.test(raw)
        && !_typeFromText(raw, '');
}

function _extractRequestedColor(text) {
    const raw = String(text || '');
    const candidates = [];
    for (const match of raw.matchAll(/#[0-9a-f]{3,8}\b/ig)) {
        candidates.push({ index: match.index, value: match[0] });
    }
    for (const match of raw.matchAll(/(?:rgba?|hsla?)\([^)]{1,120}\)/ig)) {
        candidates.push({ index: match.index, value: match[0] });
    }
    COLOR_WORD_PATTERN.lastIndex = 0;
    for (const match of raw.matchAll(COLOR_WORD_PATTERN)) {
        candidates.push({ index: match.index, value: match[0] });
    }
    candidates.sort((left, right) => left.index - right.index);
    for (let index = candidates.length - 1; index >= 0; index--) {
        const color = normalizeTextColor(candidates[index].value);
        if (color) return { ...candidates[index], color };
    }
    return null;
}

function _styleMatchCandidate(raw, colorMatch) {
    const quoted = [...String(raw || '').matchAll(/["'`]([^"'`]{1,500})["'`]/g)]
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);
    if (quoted.length) return quoted[0];

    const beforeColor = String(raw || '').slice(0, colorMatch?.index ?? raw.length)
        .replace(/\s+(?:to|into|as)\s+(?:a\s+)?$/i, '')
        .trim();
    const patterns = [
        /\bcolou?r\s+of\s+(.+)$/i,
        /\brecolou?r\s+(.+)$/i,
        /\b(?:make|turn|set)\s+(?:only\s+|just\s+)?(.+)$/i,
        /\b(?:change|edit|update)\s+(.+)$/i,
    ];
    for (const pattern of patterns) {
        const match = beforeColor.match(pattern);
        if (match?.[1]) return String(match[1]).trim();
    }
    return '';
}

function _cleanStyleMatch(value) {
    return String(value || '')
        .replace(/^(?:te|the)\s+colou?r\s+of\s+/i, '')
        .replace(/^(?:only|just)\s+/i, '')
        .replace(/\s+(?:text|copy|wording|words?)$/i, '')
        .replace(/[,:;.!?]+$/g, '')
        .trim()
        .slice(0, 1_000);
}

function _isGenericGraphicReference(value) {
    const remainder = String(value || '')
        .replace(GENERIC_GRAPHIC_WORDS, ' ')
        .replace(/\b(?:of|on|in|for|to|into|as|a|an|its)\b/ig, ' ')
        .replace(/[^a-z0-9$€£]+/ig, '');
    return !remainder;
}

function _parseStyleInstruction(text, directives = {}, request = {}) {
    const raw = String(text || '').trim();
    if (/\b(?:background|bg|box|plate|card\s+background)\b/i.test(raw)) return null;
    const colorMatch = _extractRequestedColor(raw);
    if (!colorMatch) return null;
    const afterColor = raw.slice(colorMatch.index + String(colorMatch.value || '').length).trim();
    const directColorCommand = (
        /\b(?:make|turn|set|change|edit|update)\b/i.test(raw.slice(0, colorMatch.index))
        && !/\b(?:say|read|show|display)\b/i.test(raw)
        && /^(?:colou?r)?(?:\s+(?:without|while)\b.*)?[.!?]*$/i.test(afterColor)
    );
    const hasExplicitStyleIntent = /\b(?:colou?r|recolou?r)\b/i.test(raw)
        || directColorCommand;
    if (!hasExplicitStyleIntent) return null;

    const target = _graphicTarget(request, raw, directives?.graphics?.requestedType || '');
    const targetType = target.targetType;
    if (!targetType) return null;
    const candidate = _cleanStyleMatch(_styleMatchCandidate(raw, colorMatch));
    const selectedLabel = target.label || _selectedVisualLabel(request);
    const matchText = !candidate || _isGenericGraphicReference(candidate)
        ? selectedLabel
        : candidate;
    return {
        targetType,
        targetIds: target.targetIds,
        matchText,
        wholeText: !matchText,
        color: colorMatch.color,
        colorName: String(colorMatch.value || colorMatch.color),
        occurrence: 0,
        allOccurrences: /\b(?:every|all)\s+(?:occurrence|instance|matching)\b/i.test(raw),
        all: /\b(?:all|every|each)\s+(?:lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout|graphic)/i.test(raw),
    };
}

function _parseContentInstruction(text, directives = {}, request = {}) {
    const raw = String(text || '').trim();
    const target = _graphicTarget(request, raw, directives?.graphics?.requestedType || '');
    const targetType = target.targetType;
    if (!targetType) return null;

    let mode = 'set';
    let desired = '';
    const retain = raw.match(/\bkeep\s+(?:only|just)\s+(.+)$/i);
    if (retain) {
        mode = 'retain';
        desired = retain[1];
    }
    if (!desired) {
        const say = raw.match(/\b(?:make|have)\s+(?:the\s+)?(?:lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout|stat\s+counter|motion\s+graphic)\s+(?:say|read|show|display)\s+(?:only\s+|just\s+)?(.+)$/i);
        if (say) desired = say[1];
    }
    if (!desired) {
        const explicit = raw.match(
            /\b(?:change|set|replace|update|edit)\b.*?\b(?:text|copy|content)\b\s*(?:to|with|as)\s+(.+)$/i
        );
        if (explicit) desired = explicit[1];
    }
    if (!desired) return null;

    desired = _cleanRequestedText(_stripTrailingGraphicClause(desired));
    if (!desired) return null;
    return {
        targetType,
        targetIds: target.targetIds,
        text: desired,
        mode,
        clearSubtext: mode === 'retain' || /\b(?:only|just)\b/i.test(raw),
        all: /\b(?:all|every|each)\b/i.test(raw),
    };
}

function _operation(graphics, request) {
    const action = graphics.action
        || (graphics.moreMGs ? 'add' : '')
        || (graphics.fewerMGs ? 'reduce' : '')
        || (graphics.requestedType ? 'add' : '');
    return {
        capabilityId: 'graphics',
        specialist: 'Motion Graphics Editor',
        action: action === 'reduce' ? 'reduce' : action,
        args: {
            action: action === 'reduce' ? 'reduce' : action,
            requestedType: graphics.requestedType || '',
            instruction: graphics.instruction || '',
            fewer: action === 'reduce',
            effort: request.effort,
        },
        scope: request.scope,
        risk: 'moderate',
        exclusiveCapability: request.scope?.kind === 'visual',
        description: action === 'reduce' ? 'reduce graphics in the selected scope' : 'author motion graphics for the selected scope',
        progress: {
            phase: 'graphics',
            message: 'Motion Graphics Editor is authoring visuals for the active scope...',
        },
    };
}

function _contentOperation(args, request, description = '') {
    return {
        capabilityId: 'graphics',
        specialist: 'Motion Graphics Editor',
        action: 'edit-content',
        args,
        scope: request.scope,
        risk: 'low',
        exclusiveCapability: true,
        description: description
            || `edit the existing ${args.targetType || 'graphic'} content without changing its design`,
        progress: {
            phase: 'graphics-content',
            message: 'Motion Graphics Editor is updating the existing graphic copy in place...',
        },
    };
}

function _propertiesOperation(args, request, description = '') {
    return {
        capabilityId: 'graphics',
        specialist: 'Motion Graphics Editor',
        action: 'edit-properties',
        args,
        scope: request.scope,
        risk: 'low',
        exclusiveCapability: true,
        description: description
            || `edit only the selected ${args.targetType || 'graphic'} properties and preserve its content`,
        progress: {
            phase: 'graphics-properties',
            message: 'Motion Graphics Editor is updating the selected graphic in place...',
        },
    };
}

function _styleOperation(args, request, description = '') {
    return {
        capabilityId: 'graphics',
        specialist: 'Motion Graphics Editor',
        action: 'edit-text-style',
        args,
        scope: request.scope,
        risk: 'low',
        exclusiveCapability: true,
        description: description
            || `recolor only the existing ${args.targetType || 'graphic'} text to ${args.colorName || args.color} and preserve its design`,
        progress: {
            phase: 'graphics-style',
            message: 'Motion Graphics Editor is updating only the selected graphic text color...',
        },
    };
}

const POSITION_ALIASES = [
    ['top-left', /\btop[\s-]+left\b/i],
    ['top-right', /\btop[\s-]+right\b/i],
    ['bottom-left', /\bbottom[\s-]+left\b/i],
    ['bottom-right', /\bbottom[\s-]+right\b/i],
    ['center-left', /\bcenter[\s-]+left\b|\bmiddle[\s-]+left\b/i],
    ['center-right', /\bcenter[\s-]+right\b|\bmiddle[\s-]+right\b/i],
    ['center', /\b(?:dead\s+)?center\b|\bmiddle\b/i],
];
const ANIMATION_ALIASES = [
    ['wipeRight', /\bwipe\s+right\b/i],
    ['slideLeft', /\bslide\s+left\b/i],
    ['slideRight', /\bslide\s+right\b/i],
    ['popUp', /\bpop\s+up\b/i],
    ['fadeSlide', /\bfade(?:\s+slide|\s+in)?\b/i],
    ['springScale', /\bspring(?:\s+scale)?\b/i],
    ['countUp', /\bcount\s+up\b/i],
    ['typewriter', /\btypewriter\b/i],
    ['cascade', /\bcascade\b/i],
    ['staggerSlide', /\bstagger(?:ed)?\s+slide\b/i],
];

function _normalizedIdentifierWords(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .toLowerCase();
}

function _registeredAnimationFromText(value) {
    const haystack = ` ${_normalizedIdentifierWords(value)} `;
    return [...GRAPHIC_ANIMATIONS]
        .sort((left, right) => (
            _normalizedIdentifierWords(right).length - _normalizedIdentifierWords(left).length
        ))
        .find((animation) => {
            const phrase = _normalizedIdentifierWords(animation);
            return phrase && haystack.includes(` ${phrase} `);
        }) || '';
}

const GRAPHIC_TARGET_FIELDS = {
    targetType: string({ enum: GRAPHIC_TYPES }),
    type: string({ enum: GRAPHIC_TYPES }),
    graphicType: string({ enum: GRAPHIC_TYPES }),
    targetIds: array(string({ minLength: 1, maxLength: 500 }), { maxItems: 120, uniqueItems: true }),
    all: booleanField(),
};

const GRAPHIC_PROPERTY_FIELD_SCHEMAS = {
    position: string({ enum: GRAPHIC_POSITIONS }),
    animation: string({ enum: GRAPHIC_ANIMATIONS }),
    animationSpeed: number({ min: 0.25, max: 3 }),
    animationSpeedScale: number({ min: 0.1, max: 4 }),
    style: string({ enum: STYLE_NAMES }),
    variant: string({ enum: GRAPHIC_VARIANTS }),
    graphicShell: object({
        preset: string({ enum: GRAPHIC_SHELL_RECIPES }),
        surface: string({ enum: GRAPHIC_SHELL_VALUES.surface }),
        accent: string({ enum: GRAPHIC_SHELL_VALUES.accent }),
        geometry: string({ enum: GRAPHIC_SHELL_VALUES.geometry }),
        hierarchy: string({ enum: GRAPHIC_SHELL_VALUES.hierarchy }),
        width: string({ enum: GRAPHIC_SHELL_VALUES.width }),
        emphasis: string({ enum: GRAPHIC_SHELL_VALUES.emphasis }),
    }, {
        minProperties: 1,
        description: 'Theme-independent structural shell. The theme continues to own color and typography.',
    }),
    background: string({ maxLength: 160 }),
    transparentBackground: booleanField(),
    accentRuleVisible: booleanField(),
    backgroundColor: string({ format: 'color' }),
    cardStyle: string({ maxLength: 80 }),
    textColor: string({ format: 'color' }),
    shadowStrength: number({ min: 0, max: 1 }),
    durationSeconds: number({ min: 0.5, max: 120 }),
    durationScale: number({ min: 0.1, max: 4 }),
};
const GRAPHIC_PRIMARY_PROPERTIES = GRAPHIC_EDITABLE_PROPERTIES.filter((property) => (
    property !== 'cardStyle'
));
for (const property of GRAPHIC_EDITABLE_PROPERTIES) {
    if (!GRAPHIC_PROPERTY_FIELD_SCHEMAS[property]) {
        throw new Error(`Motion Graphics Editor property "${property}" has no capability schema`);
    }
}

const GRAPHIC_PROPERTY_ARGS = object({
    ...GRAPHIC_TARGET_FIELDS,
    ...Object.fromEntries(GRAPHIC_EDITABLE_PROPERTIES.map((property) => [
        property,
        GRAPHIC_PROPERTY_FIELD_SCHEMAS[property],
    ])),
    color: string({ format: 'color' }),
    fill: string({ format: 'color' }),
    duration: number({ min: 0.5, max: 120 }),
}, {
    anyOfRequired: [
        ...GRAPHIC_PRIMARY_PROPERTIES.map((property) => [property]),
        ['color'],
        ['fill'],
        ['duration'],
    ],
});

const GRAPHIC_STYLE_ARGS = object({
    ...GRAPHIC_TARGET_FIELDS,
    matchText: string({ maxLength: 1_000 }),
    text: string({ maxLength: 1_000 }),
    phrase: string({ maxLength: 1_000 }),
    wholeText: booleanField(),
    color: string({ format: 'color' }),
    textColor: string({ format: 'color' }),
    fill: string({ format: 'color' }),
    colorName: string({ maxLength: 120 }),
    occurrence: integer({ min: 0, max: 10_000 }),
    allOccurrences: booleanField(),
}, {
    anyOfRequired: [['color'], ['textColor'], ['fill']],
});

const GRAPHIC_CONTENT_ARGS = object({
    ...GRAPHIC_TARGET_FIELDS,
    text: string({ minLength: 1, maxLength: 2_000 }),
    content: string({ minLength: 1, maxLength: 2_000 }),
    copy: string({ minLength: 1, maxLength: 2_000 }),
    mode: string({ enum: ['set', 'retain'] }),
    clearSubtext: booleanField(),
    only: booleanField(),
}, {
    anyOfRequired: [['text'], ['content'], ['copy']],
});

const GRAPHIC_GENERATION_ARGS = object({
    action: string({ enum: ['add', 'regenerate', 'reduce'] }),
    requestedType: string({ enum: ['', ...GRAPHIC_TYPES] }),
    instruction: string({ maxLength: 2_000 }),
    fewer: booleanField(),
    effort: string({ enum: ['', 'fast', 'smart'] }),
});

function tools() {
    return [
        tool('edit-properties', 'Edit existing graphic geometry, timing, animation, structural shell, background, or style in place.', GRAPHIC_PROPERTY_ARGS, {
            visualTargets: ['graphic'],
            visualRepair: true,
            visualRepairFields: [
                'targetType',
                'targetIds',
                'all',
                'position',
                'graphicShell',
                'background',
                'transparentBackground',
                'backgroundColor',
                'cardStyle',
                'accentRuleVisible',
                'textColor',
                'shadowStrength',
            ],
        }),
        tool('set-position', 'Move an existing graphic to a supported safe zone.', GRAPHIC_PROPERTY_ARGS, { canonicalAction: 'edit-properties' }),
        tool('set-animation', 'Set an animation supported by the live graphics registries.', GRAPHIC_PROPERTY_ARGS, { canonicalAction: 'edit-properties' }),
        tool('set-background', 'Edit an existing graphic background without regenerating it.', GRAPHIC_PROPERTY_ARGS, { canonicalAction: 'edit-properties' }),
        tool('set-graphic-style', 'Set an existing graphic style or variant.', GRAPHIC_PROPERTY_ARGS, { canonicalAction: 'edit-properties' }),
        tool('set-duration', 'Set or scale an existing graphic on-screen duration.', GRAPHIC_PROPERTY_ARGS, { canonicalAction: 'edit-properties' }),
        tool('edit-text-style', 'Edit only matching text style inside an existing graphic.', GRAPHIC_STYLE_ARGS, {
            visualTargets: ['graphic'],
            visualImpact: true,
        }),
        tool('set-text-color', 'Set existing graphic text color in place.', GRAPHIC_STYLE_ARGS, { canonicalAction: 'edit-text-style' }),
        tool('recolor-text', 'Recolor matching existing graphic text in place.', GRAPHIC_STYLE_ARGS, { canonicalAction: 'edit-text-style' }),
        tool('style-text', 'Edit matching graphic text style.', GRAPHIC_STYLE_ARGS, { canonicalAction: 'edit-text-style' }),
        tool('edit-content', 'Edit existing graphic copy without changing its design.', GRAPHIC_CONTENT_ARGS, {
            visualTargets: ['graphic'],
            visualImpact: true,
        }),
        tool('set-text', 'Replace existing graphic wording in place.', GRAPHIC_CONTENT_ARGS, { canonicalAction: 'edit-content' }),
        tool('update-copy', 'Update existing graphic copy in place.', GRAPHIC_CONTENT_ARGS, { canonicalAction: 'edit-content' }),
        tool('add', 'Author a renderer-supported graphic in the active scope.', GRAPHIC_GENERATION_ARGS, { visualImpact: true }),
        tool('regenerate', 'Regenerate scoped graphics with renderer-supported types.', GRAPHIC_GENERATION_ARGS, { visualImpact: true }),
        tool('reduce', 'Reduce scoped graphic density.', GRAPHIC_GENERATION_ARGS, { visualImpact: true }),
        tool('add-graphic', 'Author a renderer-supported graphic in the active scope.', GRAPHIC_GENERATION_ARGS, { canonicalAction: 'add' }),
        tool('regenerate-graphic', 'Regenerate scoped graphics.', GRAPHIC_GENERATION_ARGS, { canonicalAction: 'regenerate' }),
    ];
}

function _parseDurationInstruction(text) {
    const raw = String(text || '');
    const durationIntent = /\b(?:duration|screen\s+time|time\s+on\s+screen|display\s+time|visible\s+for|stay\s+on\s+screen|leave\s+the\s+screen)\b/i.test(raw);
    const animationDuration = /\b(?:animation|motion|entrance)\s+duration\b|\bduration\s+of\s+(?:the\s+)?(?:animation|motion|entrance)\b/i.test(raw);
    if (!durationIntent || animationDuration) return null;

    const seconds = raw.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i);
    if (seconds) {
        return {
            durationSeconds: Math.max(0.5, Math.min(120, Number(seconds[1]))),
        };
    }

    const percent = raw.match(/\b(\d{1,3})(?:\s*%|\s+percent)\s+(shorter|longer)\b/i);
    if (percent) {
        const amount = Math.max(0, Math.min(90, Number(percent[1]))) / 100;
        return {
            durationScale: percent[2].toLowerCase() === 'shorter'
                ? Math.max(0.1, 1 - amount)
                : 1 + amount,
        };
    }
    if (/\b(?:half\s+as\s+long|half\s+(?:the\s+)?duration)\b/i.test(raw)) {
        return { durationScale: 0.5 };
    }
    if (/\b(?:twice\s+as\s+long|double\s+(?:the\s+)?duration)\b/i.test(raw)) {
        return { durationScale: 2 };
    }
    if (/\b(?:shorter|shorten|trim|leave\s+(?:the\s+)?screen\s+sooner|less\s+time)\b/i.test(raw)) {
        return { durationScale: 0.65 };
    }
    if (/\b(?:longer|lengthen|stay\s+(?:on\s+screen\s+)?longer|more\s+time)\b/i.test(raw)) {
        return { durationScale: 1.35 };
    }
    return null;
}

function _parsePropertyInstruction(text, directives = {}, request = {}) {
    const raw = String(text || '').trim();
    if (/\b(?:add|create|insert|generate|author)\b.{0,36}\b(?:graphic|motion\s+graphic|text\s+animation|animated\s+text|lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout|card)\b/i.test(raw)) {
        return null;
    }
    const target = _graphicTarget(request, raw, directives?.graphics?.requestedType || '');
    const targetType = target.targetType;
    const args = {
        targetType,
        targetIds: target.targetIds,
        all: /\b(?:all|every|each)\s+(?:matching\s+)?(?:graphic|lower[\s-]?third|head(?:lines?|ings?|lings?|ines?)|callout)/i.test(raw),
    };

    Object.assign(args, _parseDurationInstruction(raw) || {});

    const position = POSITION_ALIASES.find(([, pattern]) => pattern.test(raw))?.[0] || '';
    if (
        position
        && /\b(?:move|place|position|put|align|shift)\b/i.test(raw)
    ) args.position = position;

    const backgroundIntent = /\b(?:background|bg|box|plate|card\s+background)\b/i.test(raw);
    if (
        backgroundIntent
        && (
            /\btransparent\b/i.test(raw)
            || /\b(?:remove|delete|clear|hide|without|no)\b.{0,24}\b(?:background|bg|box|plate)\b/i.test(raw)
        )
    ) {
        args.transparentBackground = true;
    } else if (backgroundIntent) {
        const color = _extractRequestedColor(raw);
        if (color) args.backgroundColor = color.color;
    }

    const accentRuleIntent = /\b(?:(?:accent|decorative|side|vertical|horizontal|colou?red)\s+)?(?:bar|line|rule|rail)\b/i.test(raw)
        && !/\b(?:progress\s+bar|bar\s+chart)\b/i.test(raw);
    if (
        accentRuleIntent
        && /\b(?:remove|delete|clear|hide|disable|without|no)\b/i.test(raw)
    ) {
        args.accentRuleVisible = false;
    } else if (
        accentRuleIntent
        && /\b(?:add|show|restore|enable|keep)\b/i.test(raw)
    ) {
        args.accentRuleVisible = true;
    }

    const requestedColor = _extractRequestedColor(raw);
    const textColorIntent = /\b(?:head(?:lines?|ings?|lings?|ines?)|title|graphic\s+text|text|copy|wording|words?|label|font|letters?)\b/i.test(raw);
    if (
        requestedColor
        && (
            textColorIntent
            || (
                args.transparentBackground === true
                && /\b(?:white|black|red|blue|green|yellow|orange|purple|pink|gray|grey|colou?r)\b/i.test(raw)
            )
        )
    ) {
        args.textColor = requestedColor.color;
    }

    const motionIntent = /\b(?:animation|motion|entrance|animate)\b/i.test(raw);
    if (motionIntent) {
        const namedAnimation = (
            _registeredAnimationFromText(raw)
            || ANIMATION_ALIASES.find(([, pattern]) => pattern.test(raw))?.[0]
        );
        if (
            namedAnimation
            && !/\b(?:remove|disable|without|no)\b.{0,24}\b(?:animation|motion|entrance)\b/i.test(raw)
            && (
                /\b(?:change|set|switch|use|make|give|add|apply)\b.{0,48}\b(?:animation|motion|entrance)\b/i.test(raw)
                || /\b(?:animation|motion|entrance)\b.{0,32}\b(?:to|as|use)?\s*[a-z]/i.test(raw)
            )
        ) {
            args.animation = namedAnimation;
        }
        const explicitSpeed = raw.match(/\b([0-3](?:\.\d+)?)\s*x\b/i);
        const percent = raw.match(/\b(\d{1,3})(?:\s*%|\s+percent)\s+(faster|slower)\b/i);
        if (explicitSpeed) {
            args.animationSpeed = Math.max(0.25, Math.min(3, Number(explicitSpeed[1])));
        } else if (percent) {
            const amount = Math.max(0, Math.min(200, Number(percent[1]))) / 100;
            args.animationSpeedScale = percent[2].toLowerCase() === 'slower'
                ? Math.max(0.25, 1 - amount)
                : 1 + amount;
        } else if (/\b(?:faster|quicker|speed\s+up)\b/i.test(raw)) {
            args.animationSpeedScale = 1.35;
        } else if (/\b(?:slower|slow\s+down)\b/i.test(raw)) {
            args.animationSpeedScale = 0.72;
        }
    }
    const style = raw.match(/\b(?:style|look)\b.{0,12}\b(?:to|as)\s+(clean|bold|minimal|neon|cinematic|elegant)\b/i);
    if (style) args.style = style[1].toLowerCase();
    const variant = raw.match(/\b(?:variant|template|layout)\b.{0,12}\b(?:to|as)\s+([a-z][a-z0-9-]{1,40})\b/i);
    if (
        variant
        && _registeredVariantsForType(targetType).includes(variant[1])
    ) args.variant = variant[1];
    const graphicShell = parseGraphicShellInstruction(raw);
    if (graphicShell) {
        args.graphicShell = Object.fromEntries(
            Object.entries(graphicShell)
                .filter(([key, value]) => (
                    ['preset', 'surface', 'accent', 'geometry', 'hierarchy', 'width', 'emphasis'].includes(key)
                    && value != null
                    && value !== ''
                ))
        );
    }

    if (/\b(?:remove|disable|no)\s+(?:the\s+)?shadow\b/i.test(raw)) {
        args.shadowStrength = 0;
    } else if (/\b(?:stronger|more|increase)\b.{0,18}\bshadow\b/i.test(raw)) {
        args.shadowStrength = 0.8;
    } else if (/\b(?:softer|less|reduce)\b.{0,18}\bshadow\b/i.test(raw)) {
        args.shadowStrength = 0.25;
    }

    const editable = Object.keys(args).filter((key) => !['targetType', 'targetIds', 'all'].includes(key));
    if (!targetType || !editable.length) return null;
    return args;
}

function planFast({ text, directives, request, plan }) {
    if (_requestExplicitlyTargetsSceneIcons(request)) {
        return { operations: [], claimedDirectiveKeys: [] };
    }
    const styleEdit = _parseStyleInstruction(text, directives, request);
    if (styleEdit) {
        return {
            operations: [_styleOperation(styleEdit, request)],
            claimedDirectiveKeys: ['graphics'],
            supported: [
                `Motion Graphics Editor: recolor existing ${styleEdit.targetType} text in place and preserve its design`,
            ],
        };
    }
    const contentEdit = _parseContentInstruction(text, directives, request);
    if (contentEdit) {
        return {
            operations: [_contentOperation(contentEdit, request)],
            claimedDirectiveKeys: ['graphics'],
            supported: [
                `Motion Graphics Editor: update existing ${contentEdit.targetType} text and preserve its design`,
            ],
        };
    }
    const propertyEdit = _parsePropertyInstruction(text, directives, request);
    if (propertyEdit) {
        return {
            operations: [_propertiesOperation(propertyEdit, request)],
            claimedDirectiveKeys: ['graphics'],
            supported: [
                `Motion Graphics Editor: update existing ${propertyEdit.targetType} properties in place`,
            ],
        };
    }
    const alternateStyleEdit = _parseAlternateStyleInstruction(
        text,
        directives,
        request,
        plan
    );
    if (alternateStyleEdit) {
        return {
            operations: [{
                ..._propertiesOperation(
                    alternateStyleEdit,
                    request,
                    `restyle the selected ${alternateStyleEdit.targetType} in place while preserving its content, timing, and identity`
                ),
                authoritativeSummary: true,
            }],
            claimedDirectiveKeys: ['graphics'],
            supported: [
                `Motion Graphics Editor: restyle the selected ${alternateStyleEdit.targetType} in place`,
            ],
        };
    }
    const source = directives?.graphics || {};
    const graphics = { ...source };
    if (directives?.maps?.want === 'none' && !graphics.action && !graphics.moreMGs && !graphics.fewerMGs) {
        return { operations: [], claimedDirectiveKeys: [] };
    }
    if (directives?.maps?.want === 'more' && !graphics.action) {
        graphics.action = 'add';
        graphics.requestedType = 'mapChart';
        graphics.instruction = directives.raw || '';
    }
    const action = graphics.action
        || (graphics.moreMGs ? 'add' : '')
        || (graphics.fewerMGs ? 'reduce' : '')
        || (graphics.requestedType ? 'add' : '');
    if (!action) return { operations: [], claimedDirectiveKeys: [] };
    return {
        operations: [_operation(graphics, request)],
        claimedDirectiveKeys: [
            'graphics',
            ...(graphics.requestedType === 'mapChart' ? ['maps'] : []),
        ],
        supported: [`Motion Graphics Editor: ${action === 'reduce' ? 'reduce graphics' : 'author graphics'}`],
    };
}

function normalizeInvocation(invocation, context) {
    if (_requestExplicitlyTargetsSceneIcons(context.request)) return null;
    const action = String(invocation?.action || '');
    if ([
        'edit-properties',
        'set-position',
        'set-animation',
        'set-background',
        'set-graphic-style',
        'set-duration',
    ].includes(action)) {
        const source = invocation?.args || {};
        const target = _graphicTarget(
            context.request,
            context.request?.originalText || context.request?.text || '',
            String(source.targetType || source.type || source.graphicType || '')
        );
        const targetType = target.targetType;
        if (!targetType) return null;
        const args = {
            targetType,
            targetIds: Array.isArray(source.targetIds)
                ? source.targetIds
                : target.targetIds,
            all: source.all === true,
        };
        if (POSITION_ALIASES.some(([position]) => position === source.position)) args.position = source.position;
        if (source.animation) args.animation = String(source.animation).slice(0, 80);
        if (Number.isFinite(Number(source.animationSpeed))) args.animationSpeed = Number(source.animationSpeed);
        if (Number.isFinite(Number(source.animationSpeedScale))) args.animationSpeedScale = Number(source.animationSpeedScale);
        if (source.style) args.style = String(source.style).slice(0, 80);
        if (
            source.variant
            && _registeredVariantsForType(targetType).includes(String(source.variant))
        ) args.variant = String(source.variant).slice(0, 80);
        if (source.graphicShell && typeof source.graphicShell === 'object') {
            args.graphicShell = Object.fromEntries(
                Object.entries(source.graphicShell)
                    .filter(([key, value]) => (
                        ['preset', 'surface', 'accent', 'geometry', 'hierarchy', 'width', 'emphasis'].includes(key)
                        && value != null
                        && value !== ''
                    ))
                    .map(([key, value]) => [key, String(value)])
            );
        }
        if (source.background) args.background = String(source.background).slice(0, 160);
        if (source.transparentBackground === true) args.transparentBackground = true;
        if (source.cardStyle) args.cardStyle = String(source.cardStyle).slice(0, 80);
        if (typeof source.accentRuleVisible === 'boolean') {
            args.accentRuleVisible = source.accentRuleVisible;
        }
        const backgroundColor = normalizeTextColor(source.backgroundColor);
        if (backgroundColor) args.backgroundColor = backgroundColor;
        const textColor = normalizeTextColor(source.textColor || source.color || source.fill);
        if (textColor) args.textColor = textColor;
        if (Number.isFinite(Number(source.shadowStrength))) args.shadowStrength = Number(source.shadowStrength);
        if (Number.isFinite(Number(source.durationSeconds ?? source.duration))) {
            args.durationSeconds = Math.max(
                0.5,
                Math.min(120, Number(source.durationSeconds ?? source.duration))
            );
        }
        if (Number.isFinite(Number(source.durationScale))) {
            args.durationScale = Math.max(0.1, Math.min(4, Number(source.durationScale)));
        }
        if (Object.keys(args).length <= 3) return null;
        return _propertiesOperation(args, context.request, String(invocation.description || ''));
    }
    if (['edit-text-style', 'set-text-color', 'recolor-text', 'style-text'].includes(action)) {
        const args = invocation?.args || {};
        const color = normalizeTextColor(args.color || args.textColor || args.fill);
        const target = _graphicTarget(
            context.request,
            context.request?.originalText || context.request?.text || '',
            String(args.targetType || args.type || args.graphicType || '')
        );
        const targetType = target.targetType;
        if (!color || !targetType) return null;
        const scopeLabel = target.label || _selectedVisualLabel(context.request);
        const matchText = _cleanRequestedText(
            args.matchText || args.text || args.phrase || scopeLabel || ''
        );
        return _styleOperation({
            targetType,
            targetIds: Array.isArray(args.targetIds)
                ? args.targetIds
                : target.targetIds,
            matchText,
            wholeText: args.wholeText === true || !matchText,
            color,
            colorName: String(args.color || args.textColor || args.fill || color),
            occurrence: Number.isInteger(Number(args.occurrence))
                ? Math.max(0, Number(args.occurrence))
                : 0,
            allOccurrences: args.allOccurrences === true,
            all: args.all === true,
        }, context.request, String(invocation.description || ''));
    }
    if (['edit-content', 'set-text', 'update-copy'].includes(action)) {
        const args = invocation?.args || {};
        const text = _cleanRequestedText(args.text || args.content || args.copy || '');
        const target = _graphicTarget(
            context.request,
            context.request?.originalText || context.request?.text || '',
            String(args.targetType || args.type || args.graphicType || '')
        );
        const targetType = target.targetType;
        if (!text || !targetType) return null;
        return _contentOperation({
            targetType,
            targetIds: Array.isArray(args.targetIds) ? args.targetIds : target.targetIds,
            text,
            mode: args.mode === 'retain' ? 'retain' : 'set',
            clearSubtext: args.clearSubtext === true || args.only === true,
            all: args.all === true,
        }, context.request, String(invocation.description || ''));
    }
    if (!['add', 'regenerate', 'reduce', 'add-graphic', 'regenerate-graphic'].includes(action)) return null;
    const normalizedAction = action === 'add-graphic'
        ? 'add'
        : (action === 'regenerate-graphic' ? 'regenerate' : action);
    return _operation({
        ...(invocation.args || {}),
        action: normalizedAction,
        instruction: invocation.description || invocation.args?.instruction || '',
    }, context.request);
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'graphics',
        specialist: 'Motion Graphics Editor',
        domain: 'motion-graphics',
        description: 'Edits existing graphic copy in place, or adds, regenerates, and reduces renderable motion graphics.',
        scopes: ['clips', 'range', 'visual', 'playhead', 'project'],
        risk: 'moderate',
        actions: [
            'edit-properties',
            'set-position',
            'set-animation',
            'set-background',
            'set-graphic-style',
            'set-duration',
            'edit-text-style',
            'set-text-color',
            'recolor-text',
            'style-text',
            'edit-content',
            'set-text',
            'update-copy',
            'add',
            'regenerate',
            'reduce',
            'add-graphic',
            'regenerate-graphic',
        ],
        directiveKeys: ['graphics', 'maps'],
        vocabulary: {
            types: GRAPHIC_TYPES,
            properties: GRAPHIC_EDITABLE_PROPERTIES,
            animations: GRAPHIC_ANIMATIONS,
            variants: GRAPHIC_VARIANTS,
            graphicShells: {
                dimensions: GRAPHIC_SHELL_VALUES,
                recipes: getGraphicShellRecipes(),
                note: 'Structural only. Theme colors and fonts remain independent and adaptive.',
            },
            styles: STYLE_NAMES,
            positions: GRAPHIC_POSITIONS,
        },
        examples: [
            'Make only 50 Years red without changing the lower-third design',
            'Change this selected graphic text color to #ef4444',
            'Make the headline background transparent, its text white, and use a typewriter animation',
            'Give this headline an outline shell but keep the current theme colors',
            'Use a split-label structure for the selected graphic',
            'Give this selected graphic another style while keeping its content and timing',
            'Make this callout a clean underline structure without changing its font or palette',
            'Remove the decorative accent bar beside this headline',
            'Make this headline duration 35 percent shorter',
            'Edit the lower third to keep only $300',
            'Change this headline text to The Hidden Cost',
            'Keep the same lower-third design and replace only its wording',
            'Regenerate this stat card',
        ],
    };
}

function execute({ plan, operation, options }) {
    if (operation.action === 'edit-properties') {
        const result = editScopedGraphicProperties(plan, operation.scope, operation.args, { log: options.log });
        return {
            changed: result.changed,
            stats: {
                graphicsPropertiesEdited: result.edited || 0,
            },
            diagnostics: result.edits,
        };
    }
    if (operation.action === 'edit-text-style') {
        const result = editScopedGraphicTextStyle(plan, operation.scope, operation.args, { log: options.log });
        return {
            changed: result.changed,
            stats: {
                graphicsStyleEdited: result.edited || 0,
            },
            diagnostics: result.edits,
        };
    }
    if (operation.action === 'edit-content') {
        const result = editScopedGraphicContent(plan, operation.scope, operation.args, { log: options.log });
        return {
            changed: result.changed,
            stats: {
                graphicsContentEdited: result.edited || 0,
            },
            diagnostics: result.edits,
        };
    }
    const result = regenerateScopedGraphics(plan, operation.scope, operation.args, { log: options.log });
    return {
        changed: result.changed,
        stats: {
            graphicsAdded: result.added || 0,
            graphicsRemoved: result.removed || 0,
        },
    };
}

module.exports = {
    execute,
    inspect: inspectScopedGraphics,
    manifest,
    normalizeInvocation,
    planFast,
    tools,
};
