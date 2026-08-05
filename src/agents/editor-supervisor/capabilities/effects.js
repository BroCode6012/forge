'use strict';

const {
    EFFECT_IDS,
    EFFECT_PARAMETER_SCHEMA,
    GRADE_IDS,
} = require('../../../render/hf-effects');
const {
    COLOR_ALIASES,
    normalizeTextColor,
} = require('../../../render/text-style-ranges');
const {
    EFFECT_CATEGORIES,
    EFFECT_PRESETS,
    applyEffectsEdit,
    inspectEffects,
    normalizeEffectEditArgs,
} = require('../workers/effects-editor');
const {
    array,
    boolean: booleanField,
    number,
    object,
    string,
    tool,
} = require('./capability-contract');

function _effectPropertyFields() {
    const fields = {};
    for (const schema of Object.values(EFFECT_PARAMETER_SCHEMA)) {
        for (const [property, descriptor] of Object.entries(schema || {})) {
            if (fields[property]) continue;
            fields[property] = descriptor.type === 'color'
                ? string({ format: 'color' })
                : number({ min: descriptor.min, max: descriptor.max });
        }
    }
    return fields;
}

const EFFECT_ID_FIELD = string({ enum: [...EFFECT_IDS] });
const GRADE_ID_FIELD = string({ enum: [...GRADE_IDS] });
const PRESET_ID_FIELD = string({ enum: Object.keys(EFFECT_PRESETS) });
const CATEGORY_ID_FIELD = string({ enum: Object.keys(EFFECT_CATEGORIES) });
const EFFECT_PROPERTIES_ARGS = object(_effectPropertyFields(), { minProperties: 1 });
const EFFECT_ENTRY_ARGS = object({
    id: EFFECT_ID_FIELD,
    ..._effectPropertyFields(),
}, { required: ['id'] });
const EFFECT_PATCH_ARGS = object({
    id: EFFECT_ID_FIELD,
    properties: EFFECT_PROPERTIES_ARGS,
}, { required: ['id', 'properties'] });
const EFFECT_TUNE_ARGS = object({
    targets: array(EFFECT_ID_FIELD, { maxItems: 32, uniqueItems: true }),
    mode: string({ enum: ['set', 'scale'] }),
    value: number({ min: 0, max: 3 }),
}, { required: ['value'] });

const EDIT_LOOK_ARGS = object({
    add: array(EFFECT_ENTRY_ARGS, { maxItems: 32 }),
    patches: array(EFFECT_PATCH_ARGS, { maxItems: 32 }),
    remove: array(EFFECT_ID_FIELD, { maxItems: 32, uniqueItems: true }),
    removeCategories: array(CATEGORY_ID_FIELD, { maxItems: 16, uniqueItems: true }),
    grade: GRADE_ID_FIELD,
    preset: PRESET_ID_FIELD,
    tune: EFFECT_TUNE_ARGS,
    clearAll: booleanField(),
    reset: booleanField(),
    removeGrade: booleanField(),
    preserveGrade: booleanField(),
});

function tools() {
    return [
        tool('add-effects', 'Add renderer-backed effects to selected footage.', object({
            effects: array(EFFECT_ENTRY_ARGS, { minItems: 1, maxItems: 32 }),
            add: array(EFFECT_ENTRY_ARGS, { minItems: 1, maxItems: 32 }),
        }, { anyOfRequired: [['effects'], ['add']] }), { canonicalAction: 'edit-look' }),
        tool('remove-effects', 'Remove named effects or effect categories.', object({
            effects: array(EFFECT_ID_FIELD, { maxItems: 32, uniqueItems: true }),
            remove: array(EFFECT_ID_FIELD, { maxItems: 32, uniqueItems: true }),
            categories: array(CATEGORY_ID_FIELD, { maxItems: 16, uniqueItems: true }),
            removeCategories: array(CATEGORY_ID_FIELD, { maxItems: 16, uniqueItems: true }),
        }, {
            anyOfRequired: [['effects'], ['remove'], ['categories'], ['removeCategories']],
        }), { canonicalAction: 'edit-look' }),
        tool('set-effect-properties', 'Edit supported properties on existing renderer effects.', object({
            effectId: EFFECT_ID_FIELD,
            effect: EFFECT_ID_FIELD,
            id: EFFECT_ID_FIELD,
            properties: EFFECT_PROPERTIES_ARGS,
            patches: array(EFFECT_PATCH_ARGS, { minItems: 1, maxItems: 32 }),
        }, {
            anyOfRequired: [['effectId', 'properties'], ['effect', 'properties'], ['id', 'properties'], ['patches']],
        }), { canonicalAction: 'edit-look' }),
        tool('tune-effects', 'Set or scale effect intensity.', object({
            effects: array(EFFECT_ID_FIELD, { maxItems: 32, uniqueItems: true }),
            targets: array(EFFECT_ID_FIELD, { maxItems: 32, uniqueItems: true }),
            mode: string({ enum: ['set', 'scale'] }),
            value: number({ min: 0, max: 3 }),
        }, { required: ['value'] }), { canonicalAction: 'edit-look' }),
        tool('apply-preset', 'Apply a renderer-backed effect preset.', object({
            preset: PRESET_ID_FIELD,
            preserveGrade: booleanField(),
        }, { required: ['preset'] }), { canonicalAction: 'edit-look' }),
        tool('set-grade', 'Set the project color grade for selected footage.', object({
            grade: GRADE_ID_FIELD,
        }, { required: ['grade'] }), { canonicalAction: 'edit-look' }),
        tool('remove-grade', 'Remove color grading from selected footage.', object(), { canonicalAction: 'edit-look' }),
        tool('clear-effects', 'Clear effects while optionally preserving the grade.', object({
            preserveGrade: booleanField(),
        }), { canonicalAction: 'edit-look' }),
        tool('reset-look', 'Restore the automated base look.', object(), { canonicalAction: 'edit-look' }),
        tool('edit-look', 'Apply a normalized combination of effect, grade, preset, and tuning changes.', EDIT_LOOK_ARGS, {
            visualRepair: true,
        }),
    ];
}

const EFFECT_ALIASES = [
    ['lightStreaks', /\blight\s+streaks?\b|\bprojector\s+light\b/i],
    ['lensFlare', /\blens\s+flare\b|\banamorphic\s+flare\b/i],
    ['filmScratches', /\bfilm\s+scratch(?:es)?\b|\bscratch(?:es)?\b/i],
    ['vintageFrame', /\bvintage\s+frame\b|\bfilm\s+frame\b|\bprojector\s+frame\b/i],
    ['chromaticEdge', /\bchromatic(?:\s+aberration)?\b|\brgb\s+split\b|\bcolor\s+fringe\b/i],
    ['staticNoise', /\bstatic\s+noise\b|\btv\s+static\b|\bnoise\s+wash\b/i],
    ['glitchPulse', /\bglitch(?:y|\s+pulse)?\b|\bdigital\s+glitch\b/i],
    ['lightLeak', /\blight\s+leaks?\b/i],
    ['fogDrift', /\bfog(?:gy)?\b|\bhaze\b|\bmist(?:y)?\b/i],
    ['oldTv', /\bold\s+tv\b|\bcrt\b|\bscan\s*lines?\b/i],
    ['vhs', /\bvhs\b|\bvideo\s*tape\b|\btape\s+damage\b/i],
    ['embers', /\bembers?\b|\bfloating\s+sparks?\b/i],
    ['vignette', /\bvignette\b|\bdark(?:en)?\s+the\s+edges\b/i],
    ['flicker', /\bflicker\b|\bfilm\s+flicker\b/i],
    ['bloom', /\bbloom\b|\bsoft\s+glow\b/i],
    ['grain', /\bfilm\s+grain\b|\bgrain\b/i],
    ['dust', /\bdust\b|\bspeckles?\b/i],
];

const GRADE_ALIASES = [
    ['teal-orange', /\bteal[\s-]*(?:and|&)?[\s-]*orange\b/i],
    ['warm-film', /\bwarm\s+film\b|\bwarm\s+grade\b/i],
    ['cold-steel', /\bcold\s+steel\b|\bcold\s+grade\b|\bicy\s+grade\b/i],
    ['noir', /\bnoir\b|\bblack[\s-]?(?:and|&)[\s-]?white\b|\bmonochrome\b|\bgrayscale\b/i],
    ['faded', /\bfaded\b|\bwashed\s+out\b/i],
    ['vivid', /\bvivid\b|\bvibrant\b/i],
    ['sepia-archival', /\bsepia\b|\barchival\s+grade\b/i],
    ['vhs-wash', /\bvhs\s+wash\b|\btape\s+grade\b/i],
    ['neon-night', /\bneon\s+night\b|\bneon\s+grade\b/i],
];

const PRESET_ALIASES = [
    ['filmProjector', /\bfilm\s+projector\b|\bold\s+projector\b/i],
    ['vintageFrame', /\bvintage\s+frame\s+(?:look|preset)\b/i],
    ['vhsGlitch', /\bvhs\s+glitch\b|\bdamaged\s+(?:90s|1990s)?\s*(?:tv|television|tape)\b/i],
    ['retroSparkle', /\bretro\s+sparkle\b/i],
    ['vintageWarm', /\bvintage\s+warm\b|\bwarm\s+nostalgic\b/i],
    ['filmNoir', /\bfilm\s+noir\b/i],
    ['cleanGlow', /\bclean\s+glow\b/i],
    ['cinematic', /\bcinematic\s+(?:look|preset)\b/i],
    ['retroDV', /\bretro\s+dv\b|\bold\s+camcorder\b/i],
    ['oldFilm', /\bold\s+film\b|\baged\s+film\b/i],
];

const STYLE_RECIPES = [
    {
        test: /\b(?:cold|icy)\b.{0,28}\b(?:threatening|ominous|menacing|dark)\b|\bthreatening\b.{0,28}\b(?:cold|icy)\b/i,
        args: {
            grade: 'cold-steel',
            add: [
                { id: 'vignette', intensity: 0.42 },
                { id: 'fogDrift', intensity: 0.28 },
            ],
        },
    },
    {
        test: /\b(?:dreamy|ethereal|soft\s+memory|romantic\s+memory)\b/i,
        args: {
            grade: 'faded',
            add: [
                { id: 'bloom', intensity: 0.24 },
                { id: 'lightLeak', intensity: 0.16 },
            ],
        },
    },
    {
        test: /\b(?:epic|heroic|triumphant)\b.{0,24}\b(?:look|feel|moment|shot|scene)\b/i,
        args: {
            add: [
                { id: 'lensFlare', intensity: 0.3 },
                { id: 'bloom', intensity: 0.18 },
            ],
        },
    },
    {
        test: /\b(?:damaged|broken|distorted)\b.{0,28}\b(?:tv|television|vhs|videotape|signal)\b/i,
        args: { preset: 'vhsGlitch' },
    },
    {
        test: /\b(?:archival|historical|old-time|old\s+time)\b.{0,24}\b(?:look|feel|treatment|footage|scene)\b/i,
        args: { preset: 'oldFilm' },
    },
];

function _unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function _matchedEffects(text) {
    return _unique(EFFECT_ALIASES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id));
}

function _matchedGrade(text) {
    return GRADE_ALIASES.find(([, pattern]) => pattern.test(text))?.[0] || '';
}

function _matchedPreset(text) {
    return PRESET_ALIASES.find(([, pattern]) => pattern.test(text))?.[0] || '';
}

function _hasMutationLanguage(text) {
    return /\b(?:add|apply|use|give|make|want|change|set|recolor|tint|turn|remove|delete|clear|strip|disable|increase|decrease|reduce|boost|intensify|soften|reset|restore|match|keep)\b/i.test(text);
}

function _hasArgs(args) {
    return !!(
        args.add?.length
        || args.patches?.length
        || args.remove?.length
        || args.removeCategories?.length
        || args.grade
        || args.preset
        || args.tune
        || args.clearAll
        || args.reset
        || args.removeGrade
    );
}

function _effectSupports(effectId, property) {
    return Boolean(EFFECT_PARAMETER_SCHEMA?.[effectId]?.[property]);
}

function _requestedColorCandidate(text) {
    const raw = String(text || '');
    const explicit = raw.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]{3,80}\)|hsla?\([^)]{3,80}\)/i);
    if (explicit) {
        const normalized = normalizeTextColor(explicit[0]);
        if (normalized) {
            return {
                color: normalized,
                index: explicit.index || 0,
                value: explicit[0],
            };
        }
    }
    const names = Object.keys(COLOR_ALIASES)
        .sort((left, right) => right.length - left.length)
        .join('|');
    const candidates = [...raw.matchAll(new RegExp(`\\b(${names})\\b`, 'ig'))];
    for (const candidate of candidates) {
        const before = raw.slice(Math.max(0, candidate.index - 18), candidate.index).toLowerCase();
        if (/\b(?:not|no|without|instead\s+of|rather\s+than)\s*$/.test(before)) continue;
        const normalized = normalizeTextColor(candidate[1]);
        if (normalized) {
            return {
                color: normalized,
                index: candidate.index || 0,
                value: candidate[1],
            };
        }
    }
    return null;
}

function _clauseAround(text, index) {
    const raw = String(text || '');
    const separators = [...raw.matchAll(/[,;]|\b(?:and|then|while)\b/ig)];
    let start = 0;
    let end = raw.length;
    for (const separator of separators) {
        const at = Number(separator.index) || 0;
        if (at < index) start = at + String(separator[0] || '').length;
        else {
            end = at;
            break;
        }
    }
    return raw.slice(start, end).trim();
}

function _effectMutationAction(text, effectId) {
    const raw = String(text || '');
    const alias = EFFECT_ALIASES.find(([id]) => id === effectId);
    const match = alias ? raw.match(alias[1]) : null;
    if (!match) return '';
    const clause = _clauseAround(raw, match.index || 0);
    const removePattern = /\b(?:remove|delete|strip|disable|without|no|less|lose|get\s+rid\s+of)\b/i;
    const addPattern = /\b(?:add|apply|use|give|make|turn|with|more|boost|want)\b/i;
    if (removePattern.test(clause)) return 'remove';
    if (addPattern.test(clause)) return 'add';

    const prefix = raw.slice(0, match.index || 0);
    const verbs = [...prefix.matchAll(/\b(remove|delete|strip|disable|without|no|less|lose|add|apply|use|give|make|turn|with|more|boost|want)\b/ig)];
    const nearest = String(verbs.at(-1)?.[1] || '').toLowerCase();
    if (['remove', 'delete', 'strip', 'disable', 'without', 'no', 'less', 'lose'].includes(nearest)) {
        return 'remove';
    }
    if (nearest) return 'add';
    return '';
}

function _livePropertyTargets(plan, scope, property) {
    const inspection = inspectEffects(plan, scope);
    const local = new Set();
    const effective = new Set();
    for (const scene of inspection) {
        for (const entry of (scene.deltaEntries || [])) {
            if ((entry.editableProperties || []).includes(property)) local.add(entry.id);
        }
        for (const entry of (scene.effectiveEntries || [])) {
            if ((entry.editableProperties || []).includes(property)) effective.add(entry.id);
        }
    }
    if (local.size === 1) return [...local];
    if (local.size === 0 && effective.size === 1) return [...effective];
    return [];
}

function _namesNonEffectColorTarget(text) {
    return /\b(?:lower[\s-]*third|motion\s+graphic|graphic|overlay|template|stat\s+card|fact\s+card|card|callout|logo|(?:scene|explainer)\s+icon|icon|title|head(?:lines?|ings?|lings?|ines?)|caption|subtitle|subtext|label|font|letter|word|phrase|text|background|backdrop|panel|plate|box|accent\s+(?:bar|line|rule)|decorative\s+(?:bar|line|rule)|bar|rail|rule|strip)\b/i.test(
        String(text || '')
    );
}

function _propertyPatches(text, explicitEffects, plan, scope) {
    const colorCandidate = _requestedColorCandidate(text);
    if (!colorCandidate) return [];
    const colorClause = _clauseAround(text, colorCandidate.index);
    const clauseEffects = _matchedEffects(colorClause);
    if (_namesNonEffectColorTarget(colorClause) && !clauseEffects.length) return [];
    const targets = (clauseEffects.length ? clauseEffects : explicitEffects)
        .filter((id) => _effectSupports(id, 'color'));
    // A color name alone is not permission to recolor a clip effect. When the
    // user names a graphic/text target, that domain owns the request. We only
    // infer a live effect for targetless follow-ups such as "make it black".
    if (!targets.length && _namesNonEffectColorTarget(text)) return [];
    const resolvedTargets = targets.length
        ? targets
        : _livePropertyTargets(plan, scope, 'color');
    return resolvedTargets.map((id) => ({
        id,
        properties: { color: colorCandidate.color },
    }));
}

function _propertyRequestAlreadyRendered(plan, scope, patches) {
    if (!patches.length) return false;
    const inspection = inspectEffects(plan, scope);
    let matchedTargets = 0;
    for (const scene of inspection) {
        for (const patch of patches) {
            const entries = [
                ...(scene.deltaEntries || []),
                ...(scene.effectiveEntries || []),
            ];
            const entry = entries.find((candidate) => candidate.id === patch.id);
            if (!entry || entry.userDirected !== true) return false;
            for (const [property, value] of Object.entries(patch.properties || {})) {
                if (entry.renderedProperties?.[property] !== value) return false;
            }
            matchedTargets++;
        }
    }
    return matchedTargets > 0;
}

function _description(args) {
    const parts = [];
    if (args.reset) parts.push('restore the automated base look');
    if (args.clearAll) parts.push(args.preserveGrade ? 'remove all effects but keep the grade' : 'remove all effects and grading');
    if (args.preset) parts.push(`apply ${EFFECT_PRESETS[args.preset]?.label || args.preset}`);
    if (args.add?.length) parts.push(`add ${args.add.map((entry) => entry.id).join(', ')}`);
    if (args.remove?.length) parts.push(`remove ${args.remove.join(', ')}`);
    if (args.removeCategories?.length) parts.push(`remove ${args.removeCategories.join(', ')} effects`);
    if (args.grade) parts.push(`set ${args.grade} grade`);
    if (args.removeGrade) parts.push('remove color grading');
    if (args.tune) parts.push(`${args.tune.mode === 'set' ? 'set' : 'adjust'} effect intensity`);
    if (args.patches?.length) {
        parts.push(args.patches.map((patch) => (
            `set ${patch.id} ${Object.entries(patch.properties || {})
                .map(([key, value]) => `${key} to ${value}`)
                .join(', ')}`
        )).join('; '));
    }
    return parts.join('; ') || 'edit the selected look';
}

function _operation(args, request, description = '') {
    const normalized = normalizeEffectEditArgs(args);
    return {
        capabilityId: 'effects',
        specialist: 'Effects Agent',
        action: 'edit-look',
        args: normalized,
        scope: request.scope,
        risk: 'moderate',
        description: description || _description(normalized),
        progress: {
            phase: 'effects',
            message: 'Effects Agent is inspecting and rebuilding the selected look...',
        },
    };
}

function planFast({ text, directives, request, plan }) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    const explicitEffects = _matchedEffects(raw);
    const preset = _matchedPreset(raw);
    const grade = _matchedGrade(raw) || directives?.effects?.grade || '';
    const args = {};
    const patches = _propertyPatches(raw, explicitEffects, plan, request.scope);
    const propertiesAlreadyRendered = _propertyRequestAlreadyRendered(
        plan,
        request.scope,
        patches
    );
    if (patches.length) args.patches = patches;
    const soundEffectsContext = /\b(?:sfx|sound\s+effects?)\b/i.test(raw);
    const explicitVisualLookContext = explicitEffects.length > 0
        || !!preset
        || !!grade
        || /\b(?:visual|video)\s+effects?\b|\b(?:look|grade|grading|texture|color\s+grading)\b/i.test(raw);
    if (soundEffectsContext && !explicitVisualLookContext) {
        return { operations: [], claimedDirectiveKeys: [] };
    }

    if (/\b(?:reset|restore)\b.{0,28}\b(?:effects?|look|color|grade)\b|\bback\s+to\s+(?:the\s+)?(?:automatic|agentic|default)\s+look\b/i.test(raw)) {
        args.reset = true;
    } else if (/\b(?:remove|clear|strip|delete|disable|no)\s+(?:all\s+|every\s+)?(?:visual\s+)?effects?\b|\bno\s+effects?\s+at\s+all\b/i.test(raw)) {
        args.clearAll = true;
        args.preserveGrade = /\bkeep\b.{0,18}\b(?:grade|color)\b|\bpreserve\b.{0,18}\b(?:grade|color)\b/i.test(raw);
    }

    if (!args.reset && !args.clearAll && preset) args.preset = preset;

    const removeLanguage = /\b(?:remove|delete|strip|disable|without|no|less|lose|get\s+rid\s+of)\b/i.test(raw);
    if (explicitEffects.length && !args.patches?.length) {
        const effectActions = explicitEffects.map((id) => ({
            id,
            action: _effectMutationAction(raw, id),
        }));
        const remove = effectActions.filter((entry) => entry.action === 'remove').map((entry) => entry.id);
        const add = effectActions.filter((entry) => entry.action === 'add').map((entry) => entry.id);
        if (remove.length) args.remove = remove;
        if (add.length) args.add = add.map((id) => ({ id, intensity: 0.3 }));
    }

    const textureRequest = /\b(?:texture|dirty|grimy|film\s+look|aged\s+texture)\b/i.test(raw);
    if (removeLanguage && textureRequest) args.removeCategories = ['texture'];
    if (!explicitEffects.length && directives?.effects?.noGrain) {
        if (/\bgrain\b/i.test(raw) && !textureRequest) args.remove = ['grain'];
        else args.removeCategories = ['texture'];
    }

    if (/\b(?:remove|clear|disable|no)\b.{0,22}\b(?:color\s+)?grade\b/i.test(raw)) args.removeGrade = true;
    else if (grade) args.grade = grade;

    const stronger = /\b(?:stronger|heavier|more\s+intense|increase|boost|intensify)\b/i.test(raw);
    const weaker = /\b(?:weaker|lighter|less\s+intense|decrease|reduce|subtle|soften)\b/i.test(raw);
    const percent = raw.match(/\b(\d{1,3})(?:\s*%|\s+percent)\b/i);
    const tuningContext = explicitEffects.length > 0
        || (
            !soundEffectsContext
            && /\b(?:effects?|look|grade|grading|texture)\b/i.test(raw)
        );
    if (tuningContext && (stronger || weaker || percent) && !args.patches?.length) {
        args.tune = {
            targets: explicitEffects,
            mode: percent ? 'set' : 'scale',
            value: percent
                ? Math.max(0, Math.min(1, Number(percent[1]) / 100))
                : (stronger ? 1.35 : 0.65),
        };
        if (args.add && args.tune.targets.length) delete args.add;
    }

    if (!_hasArgs(args) && _hasMutationLanguage(raw)) {
        const style = STYLE_RECIPES.find((entry) => entry.test.test(raw));
        if (style) Object.assign(args, JSON.parse(JSON.stringify(style.args)));
    }

    if (!_hasArgs(args)) return { operations: [], claimedDirectiveKeys: [] };
    if (request.scope.kind === 'visual') {
        return {
            operations: [],
            claimedDirectiveKeys: ['effects'],
            unsupported: ['Effects Agent needs footage clips or a timeline range, not only a selected graphic.'],
        };
    }
    return {
        operations: [_operation(args, request)],
        claimedDirectiveKeys: ['effects'],
        supported: [propertiesAlreadyRendered
            ? `Effects Agent: the requested effect properties already match the rendered look; adjust intensity or shape for a stronger visible result`
            : `Effects Agent: ${_description(normalizeEffectEditArgs(args))}`],
        unsupported: [],
    };
}

function normalizeInvocation(invocation, context) {
    const raw = invocation && typeof invocation === 'object' ? invocation : {};
    const action = String(raw.action || 'edit-look');
    const source = raw.args && typeof raw.args === 'object' ? raw.args : {};
    let args = { ...source };
    if (action === 'add-effects') args = { add: source.effects || source.add || [] };
    else if (action === 'remove-effects') args = {
        remove: source.effects || source.remove || [],
        removeCategories: source.categories || source.removeCategories || [],
    };
    else if (action === 'set-effect-properties') {
        const patches = Array.isArray(source.patches)
            ? source.patches
            : [{
                id: source.effectId || source.effect || source.id,
                properties: source.properties || {},
            }];
        args = { patches };
    }
    else if (action === 'tune-effects') args = {
        tune: {
            targets: source.effects || source.targets || [],
            mode: source.mode || 'scale',
            value: source.value,
        },
    };
    else if (action === 'apply-preset') args = { preset: source.preset, preserveGrade: source.preserveGrade };
    else if (action === 'set-grade') args = { grade: source.grade };
    else if (action === 'remove-grade') args = { removeGrade: true };
    else if (action === 'clear-effects') args = { clearAll: true, preserveGrade: source.preserveGrade === true };
    else if (action === 'reset-look') args = { reset: true };
    else if (action !== 'edit-look') return null;

    const normalized = normalizeEffectEditArgs(args);
    if (!_hasArgs(normalized) || context.request.scope.kind === 'visual') return null;
    return _operation(normalized, context.request, String(raw.description || ''));
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'effects',
        specialist: 'Effects Agent',
        domain: 'look',
        description: 'Inspects and edits the complete render-safe look stack for selected footage.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'moderate',
        actions: [
            'add-effects',
            'remove-effects',
            'set-effect-properties',
            'tune-effects',
            'apply-preset',
            'set-grade',
            'remove-grade',
            'clear-effects',
            'reset-look',
            'edit-look',
        ],
        directiveKeys: ['effects'],
        vocabulary: {
            effects: [...EFFECT_IDS],
            effectParameters: EFFECT_PARAMETER_SCHEMA,
            grades: [...GRADE_IDS],
            presets: Object.keys(EFFECT_PRESETS),
            categories: Object.keys(EFFECT_CATEGORIES),
        },
        examples: [
            'Remove the vignette but keep the grade',
            'Make this feel cold and threatening',
            'Add subtle fog and a stronger vignette',
            'Make the existing vignette black with softer edges',
            'Change the fog color to blue without changing its intensity',
            'Give this a damaged 1990s television look',
            'Clear all effects but preserve the color grade',
        ],
    };
}

function execute({ plan, operation, options }) {
    const result = applyEffectsEdit(plan, operation.scope, operation.args, options);
    return {
        changed: result.changed,
        stats: result.stats,
        diagnostics: result.inspection,
    };
}

module.exports = {
    execute,
    inspect: inspectEffects,
    manifest,
    normalizeInvocation,
    planFast,
    tools,
};
