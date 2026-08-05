/**
 * Media Scout
 *
 * A pre-download candidate judge. Media Hunter defines what good footage means;
 * Media Scout turns that into a lightweight visual contract and uses provider
 * metadata to reject obvious bad candidates before we spend time downloading.
 */

const {
    isTopicAccurateMapFromPremiumStock,
} = require('./relevant-person-rules');

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'from',
    'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that',
    'this', 'these', 'those', 'it', 'its', 'as', 'into', 'over', 'under',
    'about', 'after', 'before', 'during', 'while', 'when', 'where', 'why',
    'how', 'what', 'who', 'which', 'can', 'could', 'would', 'should', 'will',
    'may', 'might', 'not', 'just', 'then', 'than', 'also', 'new', 'video',
    'clip', 'real', 'actual', 'showing', 'shows',
]);

const RAW_SIGNAL_RE = /\b(raw|footage|b-roll|b roll|drone|aerial|cctv|surveillance|dashcam|bodycam|caught on camera|on camera|livecam|4k|hd)\b/i;
const VISUAL_OBJECT_RE = /\b(ship|ships|shipping|vessel|vessels|cargo|container|containers|tanker|tankers|port|ports|harbor|harbour|crane|cranes|sea|ocean|strait|canal|lane|lanes|route|routes|chokepoint|choke point|corridor|factory|warehouse|refinery|pipeline|truck|train|road|street|city|crowd|protest|soldier|military|missile|drone|fire|flood|hospital|doctor|kitchen|stadium|athlete|screen|device|server|lab|police|vehicle|airport|plane|aircraft)\b/i;
const MAP_VISUAL_RE = /\b(map|maps|route map|geographic map|satellite image|satellite view|locator|marked on|highlighted on)\b/i;
const PERSON_RE = /\b(trump|khamenei|biden|putin|zelensky|zelenskyy|netanyahu|president|leader|minister|officials?|spokesperson|diplomat|candidate|soldiers?|troops|forces|police|protesters?|workers?|crew|celebrity|actor|actress|singer|rapper|artist|athlete|player|coach|ceo|founder|executive)\b/i;
const LOCATION_SIGNAL_RE = /\b(bab[-\s]el[-\s]mandeb|hormuz|suez|panama|red sea|persian gulf|gulf of aden|gulf|strait|canal|sea|ocean|port|harbor|harbour|airport|border|city|island|river|mountain|desert|iran|oman|yemen|egypt|saudi|china|russia|ukraine|gaza|israel|taiwan|washington|london|paris|tokyo|beijing)\b/i;
const STORY_ONLY_WORDS = new Set([
    'news', 'breaking', 'live', 'report', 'reports', 'update', 'updates',
    'analysis', 'explained', 'global', 'trade', 'economy', 'economic',
    'disruption', 'disruptions', 'crisis', 'scenario', 'system', 'systems',
    'pressure', 'risk', 'risks', 'threat', 'threats', 'problem', 'problems',
    'issue', 'issues', 'impact', 'impacts', 'reason', 'reasons', 'flow',
    'flows', 'moving', 'keeps', 'keep', 'critical', 'important', 'worst',
    'case', 'supply', 'chain', 'chains', 'plan', 'plans', 'cost', 'costs',
    'time', 'save', 'saving', 'understand', 'understanding',
    'alternative', 'alternatives', 'backup', 'instability', 'decline',
    'declines', 'significance', 'overview', 'geopolitical',
]);
const STORY_PHRASE_NOISE_RE = /\b(global trade|trade moving|global economy|global maritime trade|maritime trade|global supply chains?|supply chains?|worst case|second system|just save time|save time|breaking news|backup plan|alternative routes?|shipping traffic decline|decline in shipping traffic|global trade significance)\b/gi;

const PACKAGED_HARD_RE = /\b(explained|explainer|analysis|opinion|podcast|interview|webinar|lecture|panel discussion|roundtable|reaction video|reacts|cartoon|animated|animation|infographic|slideshow|thumbnail|why|how|documentary full|full episode)\b/i;
const NEWS_PACKAGE_RE = /\b(news|breaking|live|broadcast|anchor|presenter|host|cnn|cnbc|fox news|dw news|bbc|sky news|nbc news|abc news|cbs news|reuters|bloomberg|al jazeera|india today|world business|business watch|quicktake)\b/i;
const REDDIT_LOW_SIGNAL_RE = /\b(meme|shitpost|funny|joke|lol|discussion|megathread|question|ama|eli5|opinion|theory|streamer|podcast|interview|explained|analysis)\b/i;
const LOW_QUALITY_RE = /\b(compilation|top 10|countdown|reaction|review|commentary|debate|livestream|stream highlights)\b/i;
const REFERENCE_IMAGE_SYNTHETIC_RE = /\b(ai[-\s]?generated|image generator|generator|stock vector|vector art|clipart|clip art|cartoon|illustration|icon set|template mockup)\b/i;
const REFERENCE_IMAGE_REAL_RE = /\b(photo|photograph|screenshot|screen shot|close[-\s]?up|label|sticker|logo|document|package|packaging|product|real|original|official)\b/i;
// Web-image titles that are structurally article headers — these almost always
// resolve to an article cover image with baked-in title text rather than clean
// product/event B-roll. Demote them in the scout ranking so cleaner candidates
// (product/parts photos, official sources) win the download slot. Catches:
//   - blog-suffix patterns ("... at NAME blog", "... - Site Name")
//   - listicle-style titles ("7 Ways To Fix ...", "Top 5 ...")
//   - explainer/troubleshooting titles ("Decoding ...", "Troubleshooting ...", "... Explained")
//   - generic "fault codes / error codes" article titles where the title is
//     a content noun phrase, not a product/event name.
const REFERENCE_IMAGE_ARTICLE_HEADER_RE = /\b(\d+\s+ways?\s+to\s+\w+|\d+\s+(?:tips|tricks|fixes|signs|reasons|ways)|top\s+\d+|decoding\s+\w+|troubleshoot(?:ing)?\s+\w+|fixing\s+\w+|how\s+to\s+(?:fix|repair|reset|clear)|\bblog\b|\bexplained\b|\bcauses?\s+(?:and|&)\s+(?:fix|fixes|solutions?)|complete\s+guide|ultimate\s+guide|step[-\s]by[-\s]step|fault\s+codes?\s+(?:explained|guide|list)|error\s+codes?\s+(?:explained|guide|list|chart))\b/i;
const MARITIME_CASUALTY_RE = /\b(final seconds?|breaks?\s+in\s+half|sinks?|sinking|sank|capsiz(?:e|ed|ing)|shipwreck|wreck(?:ed)?|catastrophic failure|disaster|collision|abandon ship|distress call|rough seas sink|vessel lost)\b/i;
const MARITIME_INCIDENT_SCENE_RE = /\b(sinks?|sinking|burn|burning|attack|attacks|strike|strikes|hit|hits|explosion|fire|threat|threaten|target|targeting|war|houthi|missile|drone|combat|disaster|accident|wreck|capsiz)\b/i;
const MARITIME_FOREIGN_EVENT_GEO_RE = /\b(ukraine|ukrainian|russia|russian|black sea|north sea|bartin|turkey|turkish|greece|greek|baltic sea)\b/i;

// Domain-specific concrete anchors. In strict-raw mode we require at least one
// of these to keep a candidate — generic environment words (sea, ocean, water)
// are not enough to anchor a maritime scene against an unrelated snorkeling clip.
const _DOMAIN_ANCHORS = {
    maritime: /\b(ship|ships|shipping|vessel|vessels|tanker|tankers|cargo|container|containers|freighter|freighters|barge|convoy|port|ports|harbor|harbour|dock|docks|crane|cranes|terminal|refinery|pipeline|strait|canal|suez|hormuz|mandeb|aden|chokepoint|choke point|corridor|naval|navy|warship|warships|destroyer|frigate|aircraft carrier|submarine|trade route|sea lane|sea lanes)\b/i,
    event: /\b(raw|footage|scene|aftermath|missile|missiles|rocket|rockets|launch|drone|drones|uav|strike|attack|explosion|blast|smoke|fire|military|forces|soldiers?|troops|damage|emergency|conflict|houthi|houthis|yemen)\b/i,
    industrial: /\b(factory|factories|assembly|assembly line|warehouse|warehouses|machinery|refinery|refineries|pipeline|pipelines|plant|plants|workers?|forklift|conveyor)\b/i,
    health: /\b(hospital|hospitals|clinic|clinics|doctor|doctors|nurse|nurses|surgeon|surgery|patient|patients|ambulance|ambulances|ICU|operating room|medical lab|x-ray|MRI|CT scan|equipment)\b/i,
    food: /\b(kitchen|kitchens|chef|chefs|cook|cooking|recipe|dish|ingredient|ingredients|restaurant|restaurants|stove|oven|knife|chopping|frying|baking|grill|plate|plating)\b/i,
};

const DOMAIN_TERMS = {
    maritime: ['cargo ship', 'container ship', 'oil tanker', 'shipping lane', 'port', 'strait', 'canal', 'sea', 'vessel'],
    industrial: ['factory', 'assembly line', 'warehouse', 'machinery', 'refinery', 'pipeline', 'workers'],
    technology: ['device', 'screen', 'server', 'data center', 'lab', 'software', 'interface'],
    finance: ['trading floor', 'stock exchange', 'bank', 'market', 'currency', 'factory', 'shipping'],
    event: ['raw footage', 'scene footage', 'aftermath', 'street', 'crowd', 'damage', 'emergency'],
    health: ['hospital', 'doctor', 'clinic', 'medical lab', 'ambulance', 'equipment'],
    food: ['cooking', 'kitchen', 'chef', 'ingredients', 'restaurant', 'food prep'],
    travel: ['aerial', 'drone', 'street', 'landmark', 'landscape', 'city'],
    sports: ['game footage', 'training', 'stadium', 'athlete', 'match'],
    history: ['archive footage', 'historical footage', 'old footage', 'documentary footage'],
};

function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
    return clean(value).toLowerCase();
}

function short(value, max = 90) {
    const text = clean(value);
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function tokens(value) {
    return norm(value)
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^-+|-+$/g, '').trim())
        .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function dedupe(values, max = 20) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = clean(value);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
}

function resultText(result) {
    return [
        result?.title,
        result?.description,
        result?._cachedMeta?.title,
        result?._meta?.title,
        result?.url,
        result?._permalink,
        result?._subreddit,
    ].filter(Boolean).join(' ');
}

function textMentionsTerm(text, term) {
    const needle = clean(term);
    if (!needle || needle.length < 3) return false;
    const pattern = needle
        .split(/\s+/)
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s-]+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}($|[^\\p{L}\\p{N}])`, 'iu').test(String(text || ''));
}

function sourceMentionsMandatoryIdentity(text, contract) {
    const identities = Array.isArray(contract?.mandatoryIdentity) ? contract.mandatoryIdentity : [];
    if (!identities.length) return true;
    return identities.some(entity => textMentionsTerm(text, entity));
}

function _contractText(contract) {
    return [
        contract?.keyword,
        contract?.target,
        ...(Array.isArray(contract?.mustShow) ? contract.mustShow : []),
        ...(Array.isArray(contract?.queryTerms) ? contract.queryTerms : []),
        ...(Array.isArray(contract?.entities) ? contract.entities : []),
    ].filter(Boolean).join(' ');
}

function _isPremiumStockProvider(providerKey, providerName) {
    return /\b(storyblocks)\b/i.test(`${providerKey || ''} ${providerName || ''}`);
}

function _isTopicAccuratePremiumStockMap(text, contract, opts = {}) {
    if (!_isPremiumStockProvider(opts.providerKey, opts.providerName)) return false;
    if (!MAP_VISUAL_RE.test(text || '')) return false;
    return isTopicAccurateMapFromPremiumStock(text, {
        sourceProvider: opts.providerName || opts.providerKey || '',
        keyword: contract?.keyword || '',
        sceneText: [
            ...(Array.isArray(contract?.queryTerms) ? contract.queryTerms : []),
            ...(Array.isArray(contract?.mustShow) ? contract.mustShow : []),
        ].filter(Boolean).join(' '),
        videoTopic: contract?.target || '',
        entities: Array.isArray(contract?.entities) ? contract.entities : [],
        mediaHunter: {
            strictRaw: contract?.strictRaw,
            allowGraphics: contract?.allowGraphics,
            targetDescription: contract?.target,
            prefer: contract?.mustShow || [],
            keyword: contract?.keyword || '',
        },
    });
}

function _maritimeWrongEventReason(lower, contract) {
    if (contract?.domain !== 'maritime' || !contract?.strictRaw) return '';
    const context = norm(_contractText(contract));
    const sceneAllowsIncident = MARITIME_INCIDENT_SCENE_RE.test(context);

    if (MARITIME_CASUALTY_RE.test(lower) && !sceneAllowsIncident) {
        return 'maritime casualty/disaster, not logistics B-roll';
    }

    // These are strong title-only wrong-event signals for Red Sea/Bab-el-Mandeb/
    // Suez/Hormuz logistics scenes. They should be rejected before Omni/vision.
    if (MARITIME_FOREIGN_EVENT_GEO_RE.test(lower) && !MARITIME_FOREIGN_EVENT_GEO_RE.test(context)) {
        return 'unrelated maritime geography/event';
    }

    return '';
}

function extractProtectedTerms(scene) {
    return [
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
    ]
        .map(clean)
        .filter(Boolean)
        .filter(t => !/^none$/i.test(t))
        .map(normalizeVisualContractTerm)
        .filter(Boolean)
        .filter(isVisualContractTerm);
}

function isLikelyNamedEntity(value) {
    const text = clean(value);
    if (!text || text.length < 3) return false;
    if (LOCATION_SIGNAL_RE.test(text) || PERSON_RE.test(text)) return true;
    // Keep proper multi-word names such as "Red Sea", "Suez Canal", or
    // "Bab el-Mandeb" even when the object word is not repeated elsewhere.
    return /\b[A-Z][a-z]+(?:[-\s]+(?:[a-z]{1,3}[-\s]+)?[A-Z][a-z]+)+\b/.test(text);
}

function isVisualContractTerm(value) {
    const text = clean(value);
    if (!text) return false;
    if (VISUAL_OBJECT_RE.test(text) || RAW_SIGNAL_RE.test(text) || PERSON_RE.test(text) || isLikelyNamedEntity(text)) {
        return true;
    }
    const termTokens = tokens(text);
    if (termTokens.length === 0) return false;
    return !termTokens.every(t => STORY_ONLY_WORDS.has(t));
}

function stripStoryWords(value) {
    return clean(value)
        .replace(STORY_PHRASE_NOISE_RE, ' ')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .filter(word => {
            const key = word.toLowerCase().replace(/^-+|-+$/g, '');
            return key && !STOP_WORDS.has(key) && !STORY_ONLY_WORDS.has(key);
        })
        .join(' ');
}

function normalizeVisualContractTerm(value) {
    const text = clean(value);
    if (!text || !isVisualContractTerm(text)) return '';
    const stripped = stripStoryWords(text);
    if (!stripped && new RegExp(STORY_PHRASE_NOISE_RE.source, 'i').test(text)) return '';
    return stripped && isVisualContractTerm(stripped) ? stripped : text;
}

function buildVisualContract(scene, scriptContext = {}, opts = {}) {
    const hunter = opts.hunterProfile || scene?._mediaHunterProfile || null;
    const agentPlan = hunter?.agentPlan || scene?._mediaAgentPlan || null;
    const keyword = clean(opts.keyword || scene?.searchKeyword || scene?.researchKeyword || scene?.keyword || '');
    const visualIntent = clean(scene?.visualIntent || '');
    const domain = hunter?.domain || 'general';
    const domainTerms = DOMAIN_TERMS[domain] || [];
    const sceneEntityPlan = agentPlan?.sceneEntities || scene?._sceneEntityPlan || null;
    const sceneRequiredEntities = Array.isArray(sceneEntityPlan?.requiredEntities) ? sceneEntityPlan.requiredEntities : [];
    const sceneVisibleEntities = Array.isArray(sceneEntityPlan?.visibleEntities) ? sceneEntityPlan.visibleEntities : [];
    const sceneContextEntities = Array.isArray(sceneEntityPlan?.contextualEntities) ? sceneEntityPlan.contextualEntities : [];
    const protectedTerms = agentPlan?.enabled
        ? dedupe([...sceneRequiredEntities, ...sceneVisibleEntities], 12)
        : extractProtectedTerms(scene);
    const entities = agentPlan?.enabled
        ? dedupe([...sceneRequiredEntities, ...sceneVisibleEntities, ...sceneContextEntities], 12)
        : Array.isArray(scriptContext?.entities) ? scriptContext.entities : [];
    const strictRaw = Boolean(hunter?.strictRaw && !hunter?.allowGraphics);
    const allowRelevantPeople = Boolean(hunter?.allowRelevantPeople);
    const mandatoryVisible = dedupe([
        ...(Array.isArray(agentPlan?.mandatoryVisible) ? agentPlan.mandatoryVisible : []),
    ], 12);
    const mandatoryIdentity = dedupe([
        ...(Array.isArray(agentPlan?.mandatoryIdentity) ? agentPlan.mandatoryIdentity : []),
        ...(Array.isArray(hunter?.mandatoryIdentity) ? hunter.mandatoryIdentity : []),
        ...mandatoryVisible,
    ], 12);
    const identityEvidenceMode = clean(agentPlan?.identityEvidenceMode || hunter?.identityEvidenceMode || (mandatoryVisible.length ? 'frame-visible' : ''));

    const mustShow = dedupe([
        ...mandatoryVisible,
        ...(agentPlan?.mustShow || []),
        ...(agentPlan?.subjectAnchors || []),
        ...protectedTerms,
        ...(agentPlan?.enabled ? [] : domainTerms),
        ...(hunter?.prefer || []),
    ], 18);

    const mustNotShow = dedupe([
        ...(agentPlan?.mustAvoid || []),
        ...(agentPlan?.rejectIf || []),
        ...(hunter?.avoid || []),
        'presenter', 'anchor', 'studio', 'podcast', 'interview', 'infographic',
        'chart', 'map graphic', 'large watermark', 'headline', 'lower third',
    ], 18);

    const queryTerms = dedupe([
        keyword,
        ...mandatoryVisible,
        ...mandatoryIdentity,
        agentPlan?.viewerNeed,
        agentPlan?.target,
        agentPlan?.acceptanceTest,
        visualIntent,
        scene?.webQuery,
        scene?.stockQuery,
        ...(Array.isArray(agentPlan?.fallbackQueries) ? agentPlan.fallbackQueries : []),
        ...(strictRaw ? mustShow : []),
        ...(allowRelevantPeople ? entities : []),
        // Raw narration goes LAST and story-stripped. It is the one entry here
        // that describes what is being SAID rather than what should be SEEN, so
        // its words reward titles that echo the script while showing nothing —
        // and a full sentence is long enough to crowd the intent-derived terms
        // out of the 24-term / 30-token budget above it. Kept (a scene's subject
        // noun often only appears in the narration) but demoted to a tiebreaker.
        stripStoryWords(scene?.text || ''),
    ], 24);

    return {
        enabled: true,
        strictRaw,
        allowGraphics: Boolean(hunter?.allowGraphics),
        allowRelevantPeople,
        providerStrictness: strictRaw ? 'strict' : 'normal',
        domain,
        agentRole: agentPlan?.role || '',
        acceptanceTest: agentPlan?.acceptanceTest || '',
        keyword,
        target: agentPlan?.target || agentPlan?.viewerNeed || hunter?.targetDescription || visualIntent || keyword || 'literal usable media',
        mandatoryVisible,
        mandatoryIdentity,
        identityEvidenceMode,
        hardVisibleEntities: mandatoryVisible,
        mustShow,
        mustNotShow,
        queryTerms,
        queryTokens: dedupe(queryTerms.flatMap(tokens), 30),
        entities: dedupe(entities, 12),
    };
}

function summarizeVisualContract(contract) {
    if (!contract) return null;
    return {
        strictRaw: Boolean(contract.strictRaw),
        domain: contract.domain,
        target: contract.target,
        mandatoryIdentity: contract.mandatoryIdentity?.slice(0, 8) || [],
        identityEvidenceMode: contract.identityEvidenceMode || '',
        mandatoryVisible: contract.mandatoryVisible?.slice(0, 8) || [],
        mustShow: contract.mustShow?.slice(0, 8) || [],
        mustNotShow: contract.mustNotShow?.slice(0, 8) || [],
    };
}

function scoreCandidate(result, contract, opts = {}) {
    const providerKey = opts.providerKey || '';
    const text = resultText(result);
    const lower = norm(text);
    const title = clean(result?.title || result?._cachedMeta?.title || result?._meta?.title || result?.url || '');
    const sourceIsYouTube = providerKey === 'youtube';
    const sourceIsReddit = providerKey === 'reddit';
    const strictSource = contract?.strictRaw && (sourceIsYouTube || sourceIsReddit);
    const premiumStockMap = contract?.strictRaw
        && _isPremiumStockProvider(providerKey, opts.providerName)
        && MAP_VISUAL_RE.test(lower);
    const topicAccuratePremiumMap = premiumStockMap
        && _isTopicAccuratePremiumStockMap(text, contract, opts);
    const rawSignal = RAW_SIGNAL_RE.test(lower);
    const visualObject = VISUAL_OBJECT_RE.test(lower);
    const personSignal = PERSON_RE.test(lower);
    const duration = Number(result?.duration || result?._cachedMeta?.duration || result?._meta?.duration || 0);
    const reasons = [];
    let score = 0;

    if (!contract?.enabled) return { keep: true, score: 0, reasons: ['no-contract'], title };
    if (result?.url && /\/shorts\//i.test(result.url)) {
        return { keep: false, score: -10, reason: 'shorts/vertical title path', category: 'shorts', title };
    }
    if (duration > 0 && duration < 3) {
        return { keep: false, score: -10, reason: 'too short', category: 'too-short', title };
    }
    if (contract?.identityEvidenceMode === 'source-proven'
        && Array.isArray(contract?.mandatoryIdentity)
        && contract.mandatoryIdentity.length > 0
        && !sourceMentionsMandatoryIdentity(text, contract)) {
        return {
            keep: false,
            score: -10,
            reason: `source title does not prove required identity (${contract.mandatoryIdentity.slice(0, 2).join(', ')})`,
            category: 'missing-identity-source',
            title,
        };
    }
    const wrongMaritimeEvent = _maritimeWrongEventReason(lower, contract);
    if (wrongMaritimeEvent) {
        return { keep: false, score: -10, reason: wrongMaritimeEvent, category: 'wrong-event', title };
    }
    // A premium-stock (Storyblocks) map's TITLE is a brittle relevance judge: a
    // regionally-correct map ("Middle East trade routes", "Arabian Peninsula",
    // "Persian Gulf region") often doesn't echo the exact scene place-name, yet
    // it is the right visual. So we only HARD-reject a map when the scene has no
    // geographic context at all (a map is simply wrong for a "burning ship" raw
    // scene). When the scene IS geographic, the map survives the title cut at a
    // modest score and the real relevance call is deferred to VISION, which can
    // actually look at the map and score it against the scene's region — a
    // wrong-region map still loses there. Niche-agnostic: rides on the existing
    // general location detector + scene entities, not per-topic word lists, so a
    // history battle-map or a nature region-map benefits the same way.
    const geoContextScene = LOCATION_SIGNAL_RE.test(_contractText(contract))
        || (Array.isArray(contract?.entities) && contract.entities.some(e => LOCATION_SIGNAL_RE.test(String(e || ''))));
    if (premiumStockMap && !contract?.allowGraphics && !topicAccuratePremiumMap) {
        if (geoContextScene) {
            score += 2; // survives the cut; ranks below literal topic matches; vision decides
            reasons.push('premium-stock map → vision-judged (geographic scene)');
        } else {
            return { keep: false, score: -9, reason: 'stock map in real-footage lane', category: 'map-in-raw-footage', title };
        }
    } else if (premiumStockMap && contract?.domain === 'maritime' && !topicAccuratePremiumMap && !geoContextScene) {
        return { keep: false, score: -8, reason: 'stock map does not show scene geography', category: 'wrong-map', title };
    }
    if (topicAccuratePremiumMap) {
        score += 18;
        reasons.push('+topic map');
    }

    // Landscape builds reject portrait clips for aspect ratio — but only AFTER
    // downloading them (the dims check in footage-manager), wasting a candidate
    // slot + download time. Storyblocks' map library ships the SAME map in both
    // orientations ("Vertical portrait, zoom in to the map of X" vs "Zoom in to
    // the map of X"). Demote the portrait-titled one at ranking so the landscape
    // version is raced first and wins, instead of burning a slot on a clip we
    // will aspect-reject anyway. This is the #1 waste on Storyblocks map scenes.
    // Demotion only (not a ban) — it stays as a last resort. Skipped when the
    // build explicitly allows vertical (shorts/portrait formats).
    const allowVertical = opts.allowVertical === true || contract?.allowVertical === true;
    if (!allowVertical && /\bvertical(?:[-\s]+portrait)?\b/i.test(lower)) {
        score -= 12;
        reasons.push('-portrait orientation (landscape build prefers landscape cut)');
    }

    // Whole-word matching. A bare substring test hands out the biggest bonus in
    // this function (+7) for accidents: "sea" scores inside "di-sea-se", "ice"
    // inside "pol-ice", "art" inside "he-art". The mis-hit is invisible in the
    // log because the reason line prints the TERM, not the word that matched it,
    // so a wrong clip looks like a confident match. textMentionsTerm is the
    // boundary-aware matcher already used for the identity gate above — same
    // rule, applied consistently.
    for (const term of contract.mustShow || []) {
        const termLower = norm(term);
        if (!termLower || termLower.length < 3) continue;
        if (textMentionsTerm(text, term)) {
            const hardEntityHit = (contract.mandatoryVisible || contract.hardVisibleEntities || [])
                .some(entity => norm(entity) === termLower);
            score += hardEntityHit ? 7 : 4;
            reasons.push(`+${term}`);
        }
    }

    // Cross-lane agreement (see footage-manager's lane loop). A result that came
    // back under two differently-worded searches got an independent second vote
    // on its relevance, which is worth more than any single title keyword. Small
    // and additive: it breaks ties, it cannot carry a bad candidate on its own.
    // Absent for single-lane providers, so this is a no-op there.
    const laneHits = Number(result?._laneHits || 0);
    if (laneHits > 1) {
        score += 2;
        reasons.push(`+found by ${laneHits} searches`);
    }

    const textTokens = new Set(tokens(text));
    let tokenHits = 0;
    for (const token of contract.queryTokens || []) {
        if (textTokens.has(token)) tokenHits++;
    }
    if (tokenHits > 0) {
        score += Math.min(6, tokenHits);
        reasons.push(`+${tokenHits} term hit${tokenHits === 1 ? '' : 's'}`);
    }

    if (rawSignal) {
        score += 4;
        reasons.push('+raw signal');
    }
    if (visualObject) {
        score += 3;
        reasons.push('+visual object');
    }
    if (contract.allowRelevantPeople && personSignal) {
        score += 2;
        reasons.push('+relevant person signal');
    }
    if (contract?.domain === 'reference-image') {
        if (REFERENCE_IMAGE_REAL_RE.test(lower)) {
            score += 3;
            reasons.push('+reference still signal');
        }
        if (REFERENCE_IMAGE_SYNTHETIC_RE.test(lower)) {
            score -= 5;
            reasons.push('-synthetic reference risk');
        }
        // Article-header demotion. Structurally an article cover (likely has
        // baked-in title text), not a clean product/event photo. Soft penalty:
        // these can still win if no cleaner candidate exists, but they should
        // not auto-win over product/parts vendor photos.
        if (REFERENCE_IMAGE_ARTICLE_HEADER_RE.test(lower) || /\sat\s+[a-z]+(?:\s+[a-z]+)?\s+blog\b/i.test(lower)) {
            score -= 3;
            reasons.push('-article-header title risk');
        }
    }
    if (duration >= 8 && duration <= 900) {
        score += 1;
        reasons.push('+usable duration');
    } else if (duration > 1800 && sourceIsYouTube) {
        score -= 2;
        reasons.push('-very long');
    }

    const hardPackaged = PACKAGED_HARD_RE.test(lower);
    const newsPackaged = NEWS_PACKAGE_RE.test(lower);
    const lowQuality = LOW_QUALITY_RE.test(lower);
    const redditLowSignal = sourceIsReddit && REDDIT_LOW_SIGNAL_RE.test(lower);

    if (hardPackaged && !topicAccuratePremiumMap) {
        score -= 7;
        reasons.push('-packaged');
    }
    if (newsPackaged) {
        score -= sourceIsYouTube ? 4 : 2;
        reasons.push('-news package');
    }
    if (lowQuality) {
        score -= 3;
        reasons.push('-low quality title');
    }
    if (redditLowSignal) {
        score -= 4;
        reasons.push('-reddit discussion/meme risk');
    }

    if (strictSource) {
        if (hardPackaged && !rawSignal) {
            return { keep: false, score, reason: 'packaged/explainer metadata', category: 'packaged', reasons, title };
        }
        if (sourceIsYouTube && newsPackaged && !rawSignal && !visualObject) {
            return { keep: false, score, reason: 'news/presenter metadata without raw visual signal', category: 'packaged', reasons, title };
        }
        if (sourceIsReddit && redditLowSignal && !rawSignal && !visualObject) {
            return { keep: false, score, reason: 'reddit discussion/meme metadata', category: 'low-signal', reasons, title };
        }
        // Domain-anchor gate — generic "sea/ocean" or "factory floor" matches
        // are not enough when the scene's domain demands a concrete subject.
        const anchorRe = _DOMAIN_ANCHORS[contract?.domain];
        if (anchorRe && !anchorRe.test(lower)) {
            return { keep: false, score, reason: `no ${contract.domain} subject (environment only)`, category: 'no-domain-anchor', reasons, title };
        }
        if (score < 2 && !rawSignal && !visualObject && !(contract.allowRelevantPeople && personSignal)) {
            return { keep: false, score, reason: 'weak visual contract match', category: 'weak-match', reasons, title };
        }
    }

    return { keep: true, score, reasons, title };
}

function scoutMediaResults(results, contract, opts = {}) {
    if (!contract?.enabled || !Array.isArray(results) || results.length === 0) {
        return { results, rejected: [], kept: results || [], log: '' };
    }
    const structuralRejectCategories = new Set(['shorts', 'too-short']);
    const assessed = results.map((result, index) => ({
        result,
        index,
        assessment: scoreCandidate(result, contract, opts),
    }));

    // Soft rejects (packaged, weak-match, wrong-event...) are deliberately kept
    // as last-resort material, but until now they were sorted by raw score
    // alongside clean keepers — so a candidate this function had just declared
    // wrong could still be raced FIRST if its title happened to score well.
    // Rank them strictly below every clean keeper. The published
    // `_mediaScoutScore` is untouched, so nothing downstream re-reads a
    // different number; only the order changes.
    const sortScore = (item) => item.assessment.score - (item.assessment.keep ? 0 : 100);
    const kept = assessed
        .filter(item => item.assessment.keep || !structuralRejectCategories.has(item.assessment.category || ''))
        .sort((a, b) => (sortScore(b) - sortScore(a)) || (a.index - b.index));
    const rejected = assessed.filter(item =>
        !item.assessment.keep
        && structuralRejectCategories.has(item.assessment.category || '')
    );
    const softened = assessed.filter(item =>
        !item.assessment.keep
        && !structuralRejectCategories.has(item.assessment.category || '')
    );

    const categoryCounts = new Map();
    for (const item of rejected) {
        const key = item.assessment.category || 'rejected';
        categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
    }

    const rejectText = Array.from(categoryCounts.entries())
        .map(([key, count]) => `${count} ${key}`)
        .join(', ') || '0';
    const top = kept[0];
    const providerName = opts.providerName || opts.providerKey || 'provider';
    const topText = top
        ? `; top "${short(top.assessment.title || top.result?.url)}" (${top.assessment.score} pts${top.assessment.reasons?.length ? `: ${top.assessment.reasons.slice(0, 4).join(', ')}` : ''})`
        : '';
    const softText = softened.length ? `, ${softened.length} soft-kept` : '';
    const mode = `reject: ${rejectText}${softText}`;
    const log = `  Media Scout: [${providerName}] ${results.length} -> ${kept.length} kept (${mode})${topText}`;

    return {
        results: kept.map(item => ({
            ...item.result,
            _mediaScoutScore: item.assessment.score,
            _mediaScoutReasons: item.assessment.reasons || [],
            ...(!item.assessment.keep ? {
                _mediaScoutSoftReject: true,
                _mediaScoutSoftRejectReason: item.assessment.reason || item.assessment.category || 'metadata risk',
            } : {}),
        })),
        kept,
        rejected,
        softened,
        log,
    };
}

module.exports = {
    buildVisualContract,
    summarizeVisualContract,
    scoutMediaResults,
    scoreCandidate,
};
