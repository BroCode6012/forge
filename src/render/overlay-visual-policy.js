'use strict';

const MEDIA_TREATMENTS = new Set([
    'transparent',
    'cinematic-background',
    'darken-background',
    'blur-background',
    'image-focus',
    'map-focus',
    'evidence-board',
    'split-background',
]);

// A focusWord is an intentional editorial interruption. Every other overlay
// is an annotation layer and must leave the underlying footage untouched.
const FRAME_FOCUS_OVERLAY_TYPES = new Set(['focus-word']);
const FOCUS_WORD_TREATMENTS = new Set([
    'transparent',
    'cinematic-background',
    'darken-background',
    'blur-background',
    'image-focus',
]);

function token(value, fallback = '') {
    const text = String(value == null ? '' : value).trim();
    if (!text) return fallback;
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .replace(/[^a-zA-Z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || fallback;
}

function normalizeGraphicType(value) {
    const type = token(value, 'graphic');
    const aliases = {
        focusword: 'focus-word',
        kinetictext: 'kinetic-text',
        lowerthird: 'lower-third',
        statcounter: 'stat-counter',
    };
    return aliases[type] || type;
}

function normalizeGraphicRole(value) {
    const role = token(value, 'graphic');
    if (role === 'mg') return 'overlay';
    if (role === 'fullscreen-mg') return 'fullscreen';
    if (role === 'template-scene') return 'template';
    return role;
}

function overlayAllowsFrameTreatment({ role, type } = {}) {
    return normalizeGraphicRole(role) === 'overlay'
        && FRAME_FOCUS_OVERLAY_TYPES.has(normalizeGraphicType(type));
}

function resolveGraphicMediaTreatment({
    role,
    type,
    requested,
    fallback = 'transparent',
} = {}) {
    const normalizedRole = normalizeGraphicRole(role);
    const normalizedType = normalizeGraphicType(type);
    const requestedToken = token(requested, '');
    const fallbackToken = token(fallback, 'transparent');
    let treatment = MEDIA_TREATMENTS.has(requestedToken)
        ? requestedToken
        : (MEDIA_TREATMENTS.has(fallbackToken) ? fallbackToken : 'transparent');

    if (normalizedRole !== 'overlay') return treatment;
    if (!FRAME_FOCUS_OVERLAY_TYPES.has(normalizedType)) return 'transparent';
    if (!FOCUS_WORD_TREATMENTS.has(treatment)) treatment = 'darken-background';
    return treatment;
}

function applyGraphicMediaPolicy(spec, {
    role,
    type,
    fallback = 'transparent',
} = {}) {
    if (!spec || typeof spec !== 'object') return spec;
    const resolvedRole = normalizeGraphicRole(role || spec.role);
    const resolvedType = normalizeGraphicType(type || spec.type);
    return {
        ...spec,
        role: resolvedRole,
        type: resolvedType,
        media: {
            ...(spec.media && typeof spec.media === 'object' ? spec.media : {}),
            treatment: resolveGraphicMediaTreatment({
                role: resolvedRole,
                type: resolvedType,
                requested: spec?.media?.treatment || spec?.mediaTreatment,
                fallback,
            }),
        },
    };
}

module.exports = {
    MEDIA_TREATMENTS,
    FRAME_FOCUS_OVERLAY_TYPES,
    normalizeGraphicType,
    normalizeGraphicRole,
    overlayAllowsFrameTreatment,
    resolveGraphicMediaTreatment,
    applyGraphicMediaPolicy,
};
