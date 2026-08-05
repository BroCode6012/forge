const DISABLED_VIDEO_PROVIDER_KEYS = new Set([
    'vkVideo', 'storyblocks', 'unsplash', 'googleScrape',
]);
const DISABLED_SOURCE_HINTS = new Set([
    'vkVideo', 'unsplash', 'googleScrape',
]);
const CANONICAL_SOURCE_HINTS = Object.freeze([
    'stock',
    'youtube',
    'reddit',
    'web-image',
]);

const SOURCE_HINT_FALLBACKS = {
    vkVideo:     'youtube',
    pexels:      'stock',
    pixabay:     'stock',
    unsplash:    'stock',
    bing:        'web-image',
    googleScrape:'web-image',
};

const SOURCE_HINT_ALIASES = {
    bing: 'web-image',
    google: 'web-image',
    googleImages: 'web-image',
    googleScrape: 'web-image',
    storyblocks: 'stock',
    pexels: 'stock',
    pixabay: 'stock',
};

function _clean(value) {
    return String(value || '').trim();
}

function isDisabledSource(value) {
    const key = _clean(value);
    return !!key && (DISABLED_VIDEO_PROVIDER_KEYS.has(key) || DISABLED_SOURCE_HINTS.has(key));
}

function sanitizeSourceHint(value, fallback = 'youtube') {
    const hint = _clean(value);
    if (!hint || hint === 'none' || hint === 'null') return hint || null;
    if (SOURCE_HINT_ALIASES[hint]) return SOURCE_HINT_ALIASES[hint];
    if (DISABLED_SOURCE_HINTS.has(hint)) return SOURCE_HINT_FALLBACKS[hint] || fallback;
    return hint;
}

function filterDisabledSources(values = []) {
    return (values || []).filter(src => src && !isDisabledSource(src));
}

function providerToSourceHint(providerKey) {
    const key = _clean(providerKey);
    if (['storyblocks', 'pexels', 'pixabay'].includes(key)) return 'stock';
    if (['bing', 'brave'].includes(key)) return 'web-image';
    return sanitizeSourceHint(key, key);
}

module.exports = {
    CANONICAL_SOURCE_HINTS,
    DISABLED_VIDEO_PROVIDER_KEYS,
    DISABLED_SOURCE_HINTS,
    SOURCE_HINT_FALLBACKS,
    isDisabledSource,
    sanitizeSourceHint,
    filterDisabledSources,
    providerToSourceHint,
};
