'use strict';

const { normalizeTextColor } = require('../../../render/text-style-ranges');
const {
    boolean: booleanField,
    integer,
    number,
    object,
    string,
    tool,
} = require('./capability-contract');

const POSITIONS = new Set(['top', 'center', 'bottom']);
const BACKGROUNDS = new Set(['box', 'pill', 'none']);
const SIZE_PRESETS = Object.freeze({
    small: 34,
    medium: 46,
    large: 58,
});

const CAPTION_ARGS = object({
    enabled: booleanField({ description: 'Whether captions are rendered.' }),
    position: string({ enum: [...POSITIONS] }),
    background: string({ enum: [...BACKGROUNDS] }),
    fontSize: number({ min: 24, max: 84 }),
    wordsPerCue: integer({ min: 2, max: 12 }),
    maxDuration: number({ min: 0.8, max: 5 }),
    karaoke: booleanField(),
    color: string({ format: 'color' }),
    backgroundColor: string({ format: 'color' }),
    activeColor: string({ format: 'color' }),
}, {
    anyOfRequired: [
        ['enabled'],
        ['position'],
        ['background'],
        ['fontSize'],
        ['wordsPerCue'],
        ['maxDuration'],
        ['karaoke'],
        ['color'],
        ['backgroundColor'],
        ['activeColor'],
    ],
});

function tools() {
    return [
        tool('edit-captions', 'Edit any supported caption presentation or timing property.', CAPTION_ARGS, {
            visualRepair: true,
        }),
        tool('set-caption-style', 'Edit caption colors and presentation.', CAPTION_ARGS, { canonicalAction: 'edit-captions' }),
        tool('set-caption-position', 'Move captions to a supported screen position.', CAPTION_ARGS, { canonicalAction: 'edit-captions' }),
        tool('set-caption-size', 'Set caption font size.', CAPTION_ARGS, { canonicalAction: 'edit-captions' }),
        tool('set-caption-background', 'Set caption background style or color.', CAPTION_ARGS, { canonicalAction: 'edit-captions' }),
        tool('set-karaoke', 'Enable or disable karaoke highlighting.', CAPTION_ARGS, { canonicalAction: 'edit-captions' }),
        tool('set-caption-density', 'Set words per cue or maximum cue duration.', CAPTION_ARGS, { canonicalAction: 'edit-captions' }),
        tool('set-enabled', 'Enable or disable captions.', CAPTION_ARGS, { canonicalAction: 'edit-captions' }),
    ];
}

function _projectScope(plan) {
    return {
        kind: 'project',
        label: 'Whole project captions',
        fromSec: 0,
        toSec: Number(plan?.totalDuration) || 0,
        currentTime: 0,
        totalDuration: Number(plan?.totalDuration) || 0,
        contiguous: true,
        clipRefs: [],
        visualRefs: [],
    };
}

function _operation(args, request, plan, description = '') {
    return {
        capabilityId: 'captions',
        specialist: 'Caption Editor',
        action: 'edit-captions',
        args,
        scope: _projectScope(plan),
        risk: 'low',
        description: description || 'edit the project captions',
        progress: {
            phase: 'captions',
            message: 'Caption Editor is updating caption timing and presentation...',
        },
    };
}

function _hasCaptionContext(text) {
    return /\b(?:subtitles?|captions?|karaoke)\b/i.test(String(text || ''));
}

function _parseArgs(text) {
    const raw = String(text || '');
    if (!_hasCaptionContext(raw)) return null;
    const args = {};

    if (
        /\b(?:enable|turn\s+on|show|burn\s+in)\b.{0,24}\b(?:subtitles?|captions?)\b/i.test(raw)
        || /\b(?:subtitles?|captions?)\s+on\b/i.test(raw)
    ) {
        args.enabled = true;
    } else if (
        /\b(?:disable|turn\s+off|hide|remove|no)\b.{0,24}\b(?:subtitles?|captions?)\b/i.test(raw)
        || /\b(?:subtitles?|captions?)\s+off\b/i.test(raw)
    ) {
        args.enabled = false;
    }

    if (/\b(?:top|upper)\b.{0,18}\b(?:subtitles?|captions?)\b|\b(?:subtitles?|captions?)\b.{0,18}\b(?:top|upper)\b/i.test(raw)) {
        args.position = 'top';
    } else if (/\b(?:center|middle)\b.{0,18}\b(?:subtitles?|captions?)\b|\b(?:subtitles?|captions?)\b.{0,18}\b(?:center|middle)\b/i.test(raw)) {
        args.position = 'center';
    } else if (/\b(?:bottom|lower)\b.{0,18}\b(?:subtitles?|captions?)\b|\b(?:subtitles?|captions?)\b.{0,18}\b(?:bottom|lower)\b/i.test(raw)) {
        args.position = 'bottom';
    }

    const explicitSize = raw.match(/\b(\d{2,3})\s*(?:px|pixels?)\b/i);
    if (explicitSize) {
        args.fontSize = Number(explicitSize[1]);
    } else if (/\b(?:large|bigger|larger)\b.{0,18}\b(?:subtitles?|captions?)\b|\b(?:subtitles?|captions?)\b.{0,18}\b(?:large|bigger|larger)\b/i.test(raw)) {
        args.fontSize = SIZE_PRESETS.large;
    } else if (/\b(?:small|smaller)\b.{0,18}\b(?:subtitles?|captions?)\b|\b(?:subtitles?|captions?)\b.{0,18}\b(?:small|smaller)\b/i.test(raw)) {
        args.fontSize = SIZE_PRESETS.small;
    }

    if (/\b(?:transparent|no|remove|without)\b.{0,18}\b(?:caption\s+)?(?:background|box)\b/i.test(raw)) {
        args.background = 'none';
    } else if (/\b(?:pill|rounded\s+pill)\b/i.test(raw)) {
        args.background = 'pill';
    } else if (/\b(?:box|boxed|background)\b/i.test(raw)) {
        args.background = 'box';
    }

    const textColor = raw.match(/\b(?:caption|subtitle|text)\s+colou?r\b.{0,12}\b([#a-z][#a-z0-9(),.%\s-]{1,40})/i);
    if (textColor) {
        const normalized = normalizeTextColor(textColor[1].trim());
        if (normalized) args.color = normalized;
    }
    const backgroundColor = raw.match(/\b(?:background|box)\s+colou?r\b.{0,12}\b([#a-z][#a-z0-9(),.%\s-]{1,40})/i);
    if (backgroundColor) {
        const normalized = normalizeTextColor(backgroundColor[1].trim());
        if (normalized) args.backgroundColor = normalized;
    }

    if (/\b(?:enable|turn\s+on|use|add)\b.{0,18}\bkaraoke\b|\bkaraoke\b.{0,12}\bon\b/i.test(raw)) {
        args.karaoke = true;
    } else if (/\b(?:disable|turn\s+off|remove|no)\b.{0,18}\bkaraoke\b|\bkaraoke\b.{0,12}\boff\b/i.test(raw)) {
        args.karaoke = false;
    }

    const words = raw.match(/\b(\d{1,2})\s+words?\s+(?:per|each)\s+(?:caption|subtitle|line)\b/i);
    if (words) args.wordsPerCue = Number(words[1]);
    const duration = raw.match(/\b(\d(?:\.\d+)?)\s*(?:s|sec|seconds?)\s+(?:per|each)\s+(?:caption|subtitle|line)\b/i);
    if (duration) args.maxDuration = Number(duration[1]);

    return Object.keys(args).length ? args : null;
}

function _normalizeArgs(source) {
    const args = {};
    if (typeof source?.enabled === 'boolean') args.enabled = source.enabled;
    if (POSITIONS.has(source?.position)) args.position = source.position;
    if (BACKGROUNDS.has(source?.background)) args.background = source.background;
    if (Number.isFinite(Number(source?.fontSize))) {
        args.fontSize = Math.max(24, Math.min(84, Number(source.fontSize)));
    }
    if (Number.isFinite(Number(source?.wordsPerCue))) {
        args.wordsPerCue = Math.max(2, Math.min(12, Math.round(Number(source.wordsPerCue))));
    }
    if (Number.isFinite(Number(source?.maxDuration))) {
        args.maxDuration = Math.max(0.8, Math.min(5, Number(source.maxDuration)));
    }
    if (typeof source?.karaoke === 'boolean') args.karaoke = source.karaoke;
    for (const field of ['color', 'backgroundColor', 'activeColor']) {
        const color = normalizeTextColor(source?.[field]);
        if (color) args[field] = color;
    }
    return args;
}

function planFast({ text, request, plan }) {
    const args = _normalizeArgs(_parseArgs(text));
    if (!Object.keys(args).length) return { operations: [], claimedDirectiveKeys: [] };
    const descriptions = [];
    if (args.enabled != null) descriptions.push(`${args.enabled ? 'enable' : 'disable'} captions`);
    if (args.position) descriptions.push(`place captions at the ${args.position}`);
    if (args.fontSize) descriptions.push(`set ${args.fontSize}px caption text`);
    if (args.background) descriptions.push(`${args.background} caption background`);
    if (args.karaoke != null) descriptions.push(`${args.karaoke ? 'enable' : 'disable'} karaoke highlighting`);
    return {
        operations: [_operation(args, request, plan, descriptions.join('; '))],
        claimedDirectiveKeys: [],
        supported: [`Caption Editor: ${descriptions.join('; ') || 'caption presentation'}`],
    };
}

function normalizeInvocation(invocation, context) {
    const action = String(invocation?.action || '');
    if (![
        'edit-captions',
        'set-caption-style',
        'set-caption-position',
        'set-caption-size',
        'set-caption-background',
        'set-karaoke',
        'set-caption-density',
        'set-enabled',
    ].includes(action)) return null;
    const source = invocation?.args || {};
    const args = _normalizeArgs({
        ...source,
        ...(action === 'set-enabled' && typeof source.enabled === 'boolean' ? { enabled: source.enabled } : {}),
    });
    if (!Object.keys(args).length) return null;
    return _operation(args, context.request, context.plan, String(invocation.description || ''));
}

function manifest() {
    return {
        contractVersion: 2,
        id: 'captions',
        specialist: 'Caption Editor',
        domain: 'captions',
        description: 'Controls caption visibility, position, typography, background, density, and karaoke highlighting.',
        scopes: ['project'],
        risk: 'low',
        actions: [
            'edit-captions',
            'set-caption-style',
            'set-caption-position',
            'set-caption-size',
            'set-caption-background',
            'set-karaoke',
            'set-caption-density',
            'set-enabled',
        ],
        directiveKeys: [],
        vocabulary: {
            positions: [...POSITIONS],
            backgrounds: [...BACKGROUNDS],
            sizePresets: SIZE_PRESETS,
        },
        examples: [
            'Turn captions on and put them at the top',
            'Make subtitles 38px with no background',
            'Use karaoke captions with four words per line',
        ],
    };
}

function execute({ plan, operation }) {
    const args = _normalizeArgs(operation.args);
    const beforeEnabled = plan.subtitlesEnabled === true;
    const before = JSON.stringify({
        subtitlesEnabled: plan.subtitlesEnabled,
        captionStyle: plan.captionStyle,
        captionKaraoke: plan.captionKaraoke,
        captionWordsPerCue: plan.captionWordsPerCue,
        captionMaxDuration: plan.captionMaxDuration,
    });
    if (args.enabled != null) plan.subtitlesEnabled = args.enabled;
    const stylePatch = {};
    for (const field of ['position', 'fontSize', 'background', 'color', 'backgroundColor', 'activeColor']) {
        if (args[field] != null) stylePatch[field] = args[field];
    }
    if (Object.keys(stylePatch).length) {
        plan.captionStyle = {
            ...(plan.captionStyle && typeof plan.captionStyle === 'object' ? plan.captionStyle : {}),
            ...stylePatch,
        };
    }
    if (args.karaoke != null) plan.captionKaraoke = args.karaoke;
    if (args.wordsPerCue != null) plan.captionWordsPerCue = args.wordsPerCue;
    if (args.maxDuration != null) plan.captionMaxDuration = args.maxDuration;

    const after = JSON.stringify({
        subtitlesEnabled: plan.subtitlesEnabled,
        captionStyle: plan.captionStyle,
        captionKaraoke: plan.captionKaraoke,
        captionWordsPerCue: plan.captionWordsPerCue,
        captionMaxDuration: plan.captionMaxDuration,
    });
    if (before === after) throw new Error('Captions already use those exact settings');
    return {
        changed: 1,
        stats: {
            captionsChanged: 1,
            subtitlesChanged: args.enabled != null && beforeEnabled !== (plan.subtitlesEnabled === true) ? 1 : 0,
        },
    };
}

function inspect(plan) {
    return {
        targetCount: plan?.subtitlesEnabled ? 1 : 0,
        enabled: plan?.subtitlesEnabled === true,
        style: {
            position: plan?.captionStyle?.position || 'bottom',
            fontSize: Number(plan?.captionStyle?.fontSize) || 46,
            background: plan?.captionStyle?.background || 'box',
            color: plan?.captionStyle?.color || '#ffffff',
            backgroundColor: plan?.captionStyle?.backgroundColor || 'rgba(4,8,16,0.64)',
        },
        karaoke: plan?.captionKaraoke === true,
        wordsPerCue: Number(plan?.captionWordsPerCue) || 7,
        maxDuration: Number(plan?.captionMaxDuration) || 3.2,
    };
}

module.exports = { execute, inspect, manifest, normalizeInvocation, planFast, tools };
