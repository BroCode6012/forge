/**
 * Shared rules for strict raw-footage scenes where a person may appear.
 *
 * The important distinction:
 * - reject packaging: anchors, presenters, studio shots, PIP, watermarks, lower thirds
 * - allow clean footage of a relevant subject/person: public figures, officials,
 *   celebrities, athletes, workers, soldiers, or participants tied to the scene
 * - and, since Fix 5: do not call a layer "packaging" when the scene's own brief
 *   asked for exactly that layer (see media/packaging-intent.js)
 */

const { detectRequestedPackaging, survivingBuckets } = require('./packaging-intent');

const GRAPHIC_PACKAGED_RE = /\b(map|maps|satellite image|satellite screenshot|route graphic|locator|diagram|infographic|chart|graph|thumbnail|slideshow|animation|animated|cartoon|illustration)\b/i;
// Subset of GRAPHIC_PACKAGED_RE — only map-shaped graphics get the
// "topic-accurate map from premium stock" rescue. Cartoons, illustrations,
// thumbnails, and animated explainers stay rejected.
const TOPIC_MAP_GRAPHIC_RE = /\b(map|maps|satellite image|satellite screenshot|route graphic|locator|diagram|animated maps?|map animation|3[-\s]?d maps?|three[-\s]?dimensional maps?|earth zoom|globe)\b/i;
// Stock libraries whose maps are curated reference visuals (not random
// screen-grabs from a news package). When a clip from one of these providers
// actually shows the topic on the map, we accept it.
const PREMIUM_STOCK_PROVIDER_RE = /\b(storyblocks)\b/i;
const TEXT_PACKAGED_RE = /\b(watermark|watermarks|channel logo|logo bug|channel bug|agency stamp|headline|headlines|ticker|lower.third|lower-third|subtitle|subtitles|caption-heavy|caption|captions|screen full of text|text-heavy|foreign-language text|burn.?in)\b/i;
const WATERMARK_RE = /\b(watermark|watermarks|channel logo|logo bug|channel bug|agency stamp)\b/i;
const SMALL_WATERMARK_RE = /\b(small|tiny|minor|corner|top[- ]right|top[- ]left|bottom[- ]right|bottom[- ]left|logo bug|channel bug|unobtrusive|not covering|does not cover|not obstructing|away from subject|non.?blocking|nonblocking)\b/i;
const HARD_TEXT_OVERLAY_RE = /\b(headline|headlines|ticker|lower.third|lower-third|subtitle|subtitles|caption-heavy|caption|captions|screen full of text|text-heavy|foreign-language text|burn.?in|full-screen text)\b/i;
const DOMINANT_WATERMARK_RE = /\b(large|big|huge|prominent|dominant|center|centered|middle|across|full-screen|repeating|tiled)\b/i;
const BLOCKING_WATERMARK_RE = /\b(covering|obstructing|blocks|blocking)\b/i;
const NON_BLOCKING_WATERMARK_RE = /\b(not covering|does not cover|not obstructing|doesn't obstruct|not blocking|away from subject|non.?blocking|nonblocking)\b/i;
// Corner/edge watermarks the WebGL2 compositor can hide via a tiny scale/zoom
// crop at render time — accept these without penalty.
const CORNER_WATERMARK_POSITION_RE = /\b(corner|top[- ]?(left|right)|bottom[- ]?(left|right)|upper[- ]?(left|right)|lower[- ]?(left|right)|side|edge|logo bug|channel bug)\b/i;
const CENTER_OR_ON_SUBJECT_RE = /\b(center|centered|middle|across|over[- ]?subject|on[- ]?subject|covers? subject|over face|on face|covers face)\b/i;
const PRESENTER_PACKAGED_RE = /\b(news anchor|tv anchor|anchor desk|presenter|host|studio desk|studio|podcast|webinar|lecture|commentator|pundit|panel discussion|talking head|talking to camera|explaining to camera|picture-in-picture|split screen|inset|face inset|webcam|reporter interview|news report|broadcast)\b/i;
const PERSON_VISUAL_RE = /\b(person|people|man|woman|men|women|face|portrait|official|officials|leader|president|minister|spokesperson|diplomat|candidate|king|queen|prime minister|soldier|soldiers|troops|police|protester|protesters|worker|workers|crew|athlete|player|coach|celebrity|actor|actress|singer|rapper|artist|ceo|founder|executive|speech|speaking|talking|addressing|podium|press conference|interview|rally|summit|meeting)\b/i;
const PERSON_PRESENTATION_RE = /\b((person|man|woman|speaker) (speaking|talking|addressing|explaining|sitting|watching|listening|reacting|standing)|people (watching|listening|reacting|sitting)|speech|podium|press conference|interview)\b/i;
const SUBJECT_ROLE_RE = /\b(official|officials|leader|president|minister|spokesperson|diplomat|candidate|king|queen|prime minister|soldier|soldiers|troops|forces|police|protester|protesters|worker|workers|crew|athlete|player|coach|celebrity|actor|actress|singer|rapper|artist|ceo|founder|executive|public figure)\b/i;
const KNOWN_PERSON_RE = /\b(trump|donald trump|khamenei|ali khamenei|biden|joe biden|putin|zelensky|zelenskyy|netanyahu|musk|elon musk|bezos|taylor swift|ronaldo|messi|kim jong un|xi jinping|macron|erdogan|modi)\b/i;
const PERSON_NICHE_RE = /\b(news|politics|military|crime|celebrity|sports?|business|economy|documentary|explainer)\b/i;
const NON_PERSON_ENTITY_RE = /\b(strait|canal|sea|gulf|ocean|route|routes|lane|lanes|port|ship|shipping|tanker|cargo|container|factory|pipeline|refinery|city|country|region|iran|iraq|yemen|oman|saudi|egypt|red sea|persian gulf|bab el|mandeb|hormuz|suez|youtube|reddit)\b/i;

const GEO_ALIAS_GROUPS = [
    ['bab-el-mandeb', /\b(?:bab[-\s]*(?:el|al)[-\s]*mand(?:e|a)b|mand(?:e|a)b)\b/i],
    ['strait-of-hormuz', /\b(?:strait[-\s]*of[-\s]*hormuz|hormuz)\b/i],
    ['suez-canal', /\b(?:suez[-\s]*canal|suez)\b/i],
    ['red-sea', /\bred[-\s]*sea\b/i],
    ['persian-gulf', /\bpersian[-\s]*gulf\b/i],
    ['gulf-of-aden', /\bgulf[-\s]*of[-\s]*aden\b/i],
    ['yemen', /\byemen\b/i],
    ['djibouti', /\bdjibouti\b/i],
    ['eritrea', /\beritrea\b/i],
    ['iran', /\biran\b/i],
    ['shanghai', /\bshanghai\b/i],
    ['rotterdam', /\brotterdam\b/i],
    ['cape-of-good-hope', /\bcape[-\s]*of[-\s]*good[-\s]*hope\b/i],
];

const GEO_ALIAS_TERMS = {
    'bab-el-mandeb': ['bab el mandeb', 'bab-el-mandeb', 'bab al mandab', 'bab-al-mandab', 'bab al mandeb', 'mandeb', 'mandab'],
    'strait-of-hormuz': ['strait of hormuz', 'hormuz'],
    'suez-canal': ['suez canal', 'suez'],
    'red-sea': ['red sea'],
    'persian-gulf': ['persian gulf'],
    'gulf-of-aden': ['gulf of aden'],
    yemen: ['yemen'],
    djibouti: ['djibouti'],
    eritrea: ['eritrea'],
    iran: ['iran'],
    shanghai: ['shanghai'],
    rotterdam: ['rotterdam'],
    'cape-of-good-hope': ['cape of good hope'],
};

function _clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function _geoAliasIds(value) {
    const text = _clean(value);
    if (!text) return [];
    return GEO_ALIAS_GROUPS
        .filter(([, re]) => re.test(text))
        .map(([id]) => id);
}

function _blob(keyword, sceneText, context = {}) {
    const hunter = context?.mediaHunter || {};
    return [
        keyword,
        sceneText,
        context.videoTopic,
        context.niche,
        context.theme,
        context.tone,
        ...(Array.isArray(context.entities) ? context.entities : []),
        hunter.keyword,
        hunter.targetDescription,
        ...(Array.isArray(hunter.prefer) ? hunter.prefer : []),
    ].filter(Boolean).join(' ');
}

function _personEntityTerms(context = {}, keyword = '', sceneText = '') {
    const terms = [];
    const values = [
        ...(Array.isArray(context.entities) ? context.entities : []),
        keyword,
        sceneText,
        context.videoTopic,
    ];

    for (const value of values) {
        const text = _clean(value);
        if (!text) continue;
        if (KNOWN_PERSON_RE.test(text)) {
            const match = text.match(KNOWN_PERSON_RE);
            if (match?.[0]) terms.push(match[0]);
        }
    }

    for (const entity of Array.isArray(context.entities) ? context.entities : []) {
        const text = _clean(entity);
        if (!text || text.length < 3) continue;
        if (NON_PERSON_ENTITY_RE.test(text)) continue;
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length <= 4) terms.push(text);
    }

    return [...new Set(terms.map(t => t.toLowerCase()))];
}

function hasHardPackagedVisual(description, context = {}) {
    const desc = _clean(description);
    if (!desc) return false;
    const allowGraphics = !!context?.mediaHunter?.allowGraphics;
    if (!allowGraphics && GRAPHIC_PACKAGED_RE.test(desc)) {
        // Carve-out: topic-accurate maps from Storyblocks are reference visuals,
        // not packaged news graphics. A clean 3D route map of a geographic topic
        // (e.g. "Bab el-Mandeb shipping lane") should not be rejected as "packaged".
        if (!isTopicAccurateMapFromPremiumStock(desc, context)) return true;
    }
    if (TEXT_PACKAGED_RE.test(desc) && !isSmallNonBlockingWatermark(desc)) return true;
    return PRESENTER_PACKAGED_RE.test(desc);
}

function isTopicAccurateMapFromPremiumStock(description, context = {}) {
    const desc = _clean(description).toLowerCase();
    if (!desc) return false;
    // Only the map-family of graphics qualifies (route, satellite, diagram,
    // locator, globe/earth zoom, 3D map). Illustrations, thumbnails, cartoons,
    // and non-map animated explainers do NOT, even from premium stock.
    if (!TOPIC_MAP_GRAPHIC_RE.test(desc)) return false;
    const provider = String(context?.sourceProvider || '').toLowerCase();
    if (!provider || !PREMIUM_STOCK_PROVIDER_RE.test(provider)) return false;

    // The map must visually reference the topic. Pull candidate terms from
    // keyword/sceneText/entities/videoTopic and require at least one to be
    // present in the description. This is what makes the map "accurate" —
    // a random world map doesn't qualify, only one showing the actual place
    // the scene is about.
    const candidates = _topicMatchTerms(context);
    if (candidates.length === 0) return false;
    return candidates.some(term => term && desc.includes(term));
}

function _topicMatchTerms(context = {}) {
    const out = new Set();
    const push = (val) => {
        const s = _clean(val).toLowerCase();
        if (!s || s.length < 3) return;
        out.add(s);
        for (const id of _geoAliasIds(s)) {
            for (const alias of GEO_ALIAS_TERMS[id] || []) out.add(alias);
        }
        // Also push individual tokens >= 4 chars (so "Bab el-Mandeb shipping
        // lane" contributes both the full phrase and "mandeb", "shipping",
        // "lane" — the vision description rarely echoes the exact phrase).
        for (const tok of s.split(/[^a-z0-9]+/)) {
            if (tok && tok.length >= 4) out.add(tok);
        }
    };
    push(context.keyword);
    push(context.sceneText);
    push(context.videoTopic);
    const entities = Array.isArray(context.entities) ? context.entities : [];
    for (const e of entities) push(e);
    // Stop-words that would falsely match a generic world map.
    for (const stop of [
        'shipping', 'route', 'routes', 'lane', 'lanes', 'video', 'footage',
        'graphic', 'animated', 'animation', 'map', 'maps',
        'global', 'world', 'trade', 'network', 'logistics',
        'strait', 'canal', 'sea', 'gulf', 'ocean', 'chokepoint', 'chokepoints',
        'narrow', 'channel', 'channels',
        'ship', 'ships', 'vessel', 'vessels', 'cargo', 'container', 'containers',
        'tanker', 'tankers', 'port', 'ports', 'passage', 'aerial',
    ]) {
        out.delete(stop);
    }
    return [...out];
}

function isSmallNonBlockingWatermark(description) {
    const raw = _clean(description).toLowerCase();
    if (!WATERMARK_RE.test(raw)) return false;
    // Normalize "non-blocking" / "non blocking" → "nonblocking" so the BLOCKING regex
    // (which has \bblocking\b) doesn't false-match the "blocking" half of "non-blocking".
    const desc = raw.replace(/\bnon[\s-]?blocking\b/gi, 'nonblocking')
                    .replace(/\bnon[\s-]?obstructive\b/gi, 'nonobstructive');
    if (!SMALL_WATERMARK_RE.test(desc)) return false;
    if (HARD_TEXT_OVERLAY_RE.test(desc)) return false;
    if (DOMINANT_WATERMARK_RE.test(desc)) return false;
    if (BLOCKING_WATERMARK_RE.test(desc) && !NON_BLOCKING_WATERMARK_RE.test(desc)) return false;
    return true;
}

// Corner/side watermark the compositor can crop away by a tiny scale/zoom at
// render time — treat as fully acceptable (0 penalty). Stricter than
// isSmallNonBlockingWatermark: requires explicit corner/edge position language
// or an unambiguous "logo bug / channel bug" descriptor.
function isCroppableCornerWatermark(description) {
    const raw = _clean(description).toLowerCase();
    if (!WATERMARK_RE.test(raw)) return false;
    if (HARD_TEXT_OVERLAY_RE.test(raw)) return false;
    const desc = raw.replace(/\bnon[\s-]?blocking\b/gi, 'nonblocking');
    if (DOMINANT_WATERMARK_RE.test(desc)) return false;
    if (CENTER_OR_ON_SUBJECT_RE.test(desc)) return false;
    if (BLOCKING_WATERMARK_RE.test(desc) && !NON_BLOCKING_WATERMARK_RE.test(desc)) return false;
    return CORNER_WATERMARK_POSITION_RE.test(desc);
}

function allowsRelevantPersonFootage(description, keyword = '', sceneText = '', context = {}) {
    const desc = _clean(description).toLowerCase();
    if (!desc || !PERSON_VISUAL_RE.test(desc)) return false;
    if (hasHardPackagedVisual(desc, context)) return false;

    const contextText = _blob(keyword, sceneText, context).toLowerCase();
    const personEntities = _personEntityTerms(context, keyword, sceneText);
    const hasNamedPersonContext = KNOWN_PERSON_RE.test(contextText) || personEntities.length > 0;
    const hasRoleContext = SUBJECT_ROLE_RE.test(contextText) || !!context?.mediaHunter?.allowRelevantPeople;
    const hasRoleOnScreen = SUBJECT_ROLE_RE.test(desc);
    const hasPersonNiche = PERSON_NICHE_RE.test(contextText);

    if (personEntities.some(term => term.length > 2 && desc.includes(term))) return true;
    if (hasRoleOnScreen && (hasRoleContext || hasNamedPersonContext || hasPersonNiche)) return true;

    const cleanSpeech = /\b(speech|speaking|talking|addressing|podium|press conference|rally|summit|meeting|interview)\b/i.test(desc);
    if (cleanSpeech && (hasNamedPersonContext || hasRoleContext)) return true;

    const genericPersonSpeaking = /\b(person|man|woman)\b/i.test(desc) && /\b(speaking|talking|addressing)\b/i.test(desc);
    return genericPersonSpeaking && hasNamedPersonContext;
}

function classifyStrictRawVisual(description, keyword = '', sceneText = '', context = {}) {
    const desc = _clean(description);
    if (!desc) return { reject: false, reason: '', allowedPerson: false };

    const allowGraphics = !!context?.mediaHunter?.allowGraphics;
    // What this scene's own brief asked for. A layer the request named is not a
    // defect — it is the delivery. Resolved once per profile in media-hunter.js;
    // recomputed here only when a caller hands us a context without one.
    const requested = context?.mediaHunter?.requestedPackaging
        || detectRequestedPackaging({
            scene: context?.scene,
            keyword,
            visualIntent: context?.visualIntent || '',
            mediaHunter: context?.mediaHunter,
        });
    const graphicHit = !allowGraphics
        && GRAPHIC_PACKAGED_RE.test(desc)
        && !isTopicAccurateMapFromPremiumStock(desc, context);
    const textHit = TEXT_PACKAGED_RE.test(desc) && !isSmallNonBlockingWatermark(desc);
    const presenterHit = PRESENTER_PACKAGED_RE.test(desc);

    if (graphicHit || textHit || presenterHit) {
        const raw = [];
        if (graphicHit) raw.push('graphic');
        if (textHit) raw.push('text');
        if (presenterHit) raw.push('presenter');
        const buckets = survivingBuckets(raw, requested);
        // Everything we could complain about is something we asked for.
        if (buckets.length === 0) {
            return { reject: false, reason: '', buckets: [], allowedPerson: false, requestedPackaging: raw };
        }
        return {
            reject: true,
            reason: 'packaged graphic/presenter/overlay visual',
            buckets,
            allowedPerson: false,
        };
    }

    if (PERSON_PRESENTATION_RE.test(desc)) {
        const allowedPerson = allowsRelevantPersonFootage(desc, keyword, sceneText, context);
        if (allowedPerson) return { reject: false, reason: '', allowedPerson: true };
        if (requested?.presenter) return { reject: false, reason: '', buckets: [], allowedPerson: true, requestedPackaging: ['presenter'] };
        return { reject: true, reason: 'unrelated presenter/person visual for raw-footage target', buckets: ['presenter'], allowedPerson: false };
    }

    return { reject: false, reason: '', allowedPerson: false };
}

module.exports = {
    allowsRelevantPersonFootage,
    classifyStrictRawVisual,
    hasHardPackagedVisual,
    isSmallNonBlockingWatermark,
    isCroppableCornerWatermark,
    isTopicAccurateMapFromPremiumStock,
};
