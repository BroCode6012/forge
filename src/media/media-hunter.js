/**
 * Media Hunter
 *
 * Builds a scene-level visual target for media search and scoring. The goal is
 * not to decide the media lane; Media Intent Controller already does that.
 * This layer decides what "good footage" means inside the lane.
 */

const {
    isTopicAccurateMapFromPremiumStock,
} = require('./relevant-person-rules');
const {
    getMediaAgentQueries,
} = require('./media-agent');
const {
    detectRequestedPackaging,
} = require('./packaging-intent');
const {
    detectPersonSubject,
} = require('./person-subject');

const STOCK_PROVIDER_KEYS = new Set(['pexels', 'pixabay', 'storyblocks']);

function _isStockProvider(providerKey) {
    return STOCK_PROVIDER_KEYS.has(String(providerKey || '').toLowerCase());
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'from',
    'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that',
    'this', 'these', 'those', 'it', 'its', 'as', 'into', 'over', 'under',
    'about', 'after', 'before', 'during', 'while', 'when', 'where', 'why',
    'how', 'what', 'who', 'which', 'can', 'could', 'would', 'should', 'will',
    'may', 'might', 'not', 'just', 'then', 'than', 'also',
]);

const GLOBAL_AVOID_TERMS = [
    'anchor', 'presenter', 'talking head', 'studio desk', 'podcast', 'interview',
    'webinar', 'lecture', 'panel discussion', 'reaction video', 'explained',
    'animation', 'cartoon', 'ai generated', 'thumbnail', 'slideshow',
];

const TEXT_HEAVY_AVOID_TERMS = [
    'infographic', 'chart', 'graph', 'lower third', 'ticker', 'headline',
    'text overlay', 'subtitle', 'news broadcast', 'screen full of text',
];

const QUERY_NOISE_RE = /\b(news|explained|explanation|analysis|opinion|documentary|report|reports|update|updates|crisis explained|why|how|live|breaking)\b/gi;
const STORY_ONLY_WORDS = new Set([
    'news', 'breaking', 'live', 'report', 'reports', 'update', 'updates',
    'analysis', 'explained', 'global', 'trade', 'economy', 'economic',
    'disruption', 'disruptions', 'security', 'efficiency', 'efficient',
    'backup', 'risk', 'risks', 'threat', 'threats', 'pressure',
    'problem', 'problems', 'issue', 'issues', 'impact', 'impacts',
    'reason', 'reasons', 'flow', 'flows', 'moving', 'keeps', 'keep',
    'critical', 'important',
    'system', 'systems', 'scenario', 'worst', 'case', 'matter', 'matters',
    'defines', 'define', 'assumption', 'unstable', 'instability', 'time',
    'supply', 'chain', 'chains', 'plan', 'plans', 'cost', 'costs',
    'save', 'saving', 'understand', 'understanding',
    'alternative', 'alternatives', 'backup', 'instability', 'decline',
    'declines', 'significance', 'overview', 'policy', 'geopolitical',
]);
// Generic, cross-niche editorial filler (single-video shipping/geopolitics remnants like
// "global maritime trade" / "bab el-mandeb" removed — hardcoded vocabulary from one old
// video, inert and embarrassing on every other niche).
const STORY_QUERY_NOISE_RE = /\b(worst case|best case|save time|just save time|backup plan|breaking news|the bottom line|key takeaway)\b/gi;
const VISUAL_PROTECTED_RE = /\b(ship|ships|shipping|vessel|vessels|cargo|container|containers|tanker|tankers|port|ports|harbor|harbour|crane|cranes|sea|ocean|strait|canal|lane|lanes|route|routes|chokepoint|choke point|corridor|aerial|drone|factory|warehouse|refinery|pipeline|truck|train|road|street|city|crowd|protest|soldier|military|missile|drone|fire|flood|hospital|doctor|kitchen|stadium|athlete|screen|device|server|lab)\b/i;
const RELEVANT_PERSON_SIGNAL_RE = /\b(trump|khamenei|biden|putin|zelensky|zelenskyy|netanyahu|president|leader|minister|officials?|spokesperson|diplomat|candidate|king|queen|prime minister|soldiers?|troops|forces|police|protesters?|workers?|crew|celebrity|actor|actress|singer|rapper|artist|athlete|player|coach|ceo|founder|executive)\b/i;
// MILITARY_EVENT_SIGNAL_RE — REMOVED (2026-06-17): only fed the deleted domain classifier.
const WEAK_STOCK_RANK_TERM_RE = /\b(real footage|stock footage|stock video|b[-\s]?roll|raw video|clean visuals|footage|video|clip|clips|scene)\b/i;
const RAW_CONTEXT_SIGNAL_RE = /\b(aerial|drone|caught on camera|cctv|surveillance|dashcam|bodycam)\b/i;

// DOMAIN_PROFILES — REMOVED (2026-06-17).
// This was a hardcoded array of 11 "domains" (maritime, industrial, technology, finance,
// event, health, food, travel, sports, history) — each a regex classifier plus hardcoded
// prefer / target / queryBoosts lists. The engine no longer classifies a scene into a
// baked-in domain or assumes what footage a niche "should" want. The Media Agent decides
// per scene (target, mustShow, query lanes) and the hunter profile sources everything from
// agentPlan; _inferDomain now returns null (no hardcoded fallback). Fully agentic.

const REFERENCE_IMAGE_PROFILE = {
    key: 'reference-image',
    mode: 'reference-image',
    target: 'exact reference still image: product label, sticker, logo, document, screenshot, package, or specific branded object matching the scene',
    prefer: ['label', 'sticker', 'logo', 'document', 'screenshot', 'product close up', 'brand', 'packaging'],
    queryBoosts: ['photo', 'image', 'close up'],
    allowScreen: true,
};

function _clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function _norm(value) {
    return _clean(value).toLowerCase();
}

function _dedupe(values, max = 10) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = _clean(value);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
}

function _tokens(value) {
    return _norm(value)
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^-+|-+$/g, '').trim())
        .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function _compactQuery(query, maxWords = 8) {
    const words = _clean(query).split(/\s+/).filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const word of words) {
        const key = word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(word);
        if (out.length >= maxWords) break;
    }
    return out.join(' ');
}

function _stripQueryNoise(query) {
    return _clean(query).replace(QUERY_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
}

function _stripStoryNoise(query, profile = null) {
    let clean = _stripQueryNoise(query);
    if (!profile?.strictRaw) return clean;

    clean = clean
        .replace(STORY_QUERY_NOISE_RE, ' ')
        .replace(/\b(global|trade|economy|economic|disruption|disruptions|security|efficiency|efficient|backup|risk|risks|system|systems|scenario|worst|case|matter|matters|defines|define|assumption|unstable|instability)\b/gi, ' ')
        .split(/\s+/)
        .filter(word => {
            const key = word.toLowerCase().replace(/^-+|-+$/g, '');
            return key && !STOP_WORDS.has(key) && !STORY_ONLY_WORDS.has(key);
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    return clean;
}

function _isVisualProtectedTerm(term) {
    const text = _clean(term);
    if (!text) return false;
    if (VISUAL_PROTECTED_RE.test(text)) return true;

    const tokens = _tokens(text);
    if (tokens.length === 0) return false;
    return !tokens.every(t => STORY_ONLY_WORDS.has(t));
}

function _stripStoryTermNoise(term) {
    return _clean(term)
        .replace(STORY_QUERY_NOISE_RE, ' ')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .filter(word => {
            const key = word.toLowerCase().replace(/^-+|-+$/g, '');
            return key && !STORY_ONLY_WORDS.has(key);
        })
        .join(' ');
}

function _normalizeVisualProtectedTerm(term) {
    const text = _clean(term);
    if (!text || !_isVisualProtectedTerm(text)) return '';
    const stripped = _stripStoryTermNoise(text);
    if (!stripped && new RegExp(STORY_QUERY_NOISE_RE.source, 'i').test(text)) return '';
    return stripped && _isVisualProtectedTerm(stripped) ? stripped : text;
}

function _visualProtectedTerms(scene) {
    const terms = Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : [];
    return _dedupe(terms.map(_normalizeVisualProtectedTerm).filter(Boolean), 8);
}

function _isGraphicScene(scene, keyword) {
    const text = `${keyword || ''} ${scene?.text || ''} ${scene?.templateHint || ''} ${scene?.fullscreenMG || ''}`;
    return /\b(map|chart|graph|timeline|counter|stat|statistics|data|diagram|infographic|template|card|comparison|locator)\b/i.test(text);
}

function _matchesAny(value, terms) {
    const lower = _norm(value);
    return terms.some(term => lower.includes(term.toLowerCase()));
}

function _inferNicheBucket(nicheId, scriptContext, text) {
    const joined = `${nicheId || ''} ${scriptContext?.theme || ''} ${scriptContext?.themeId || ''} ${scriptContext?.format || ''} ${text || ''}`.toLowerCase();
    if (/\b(geopolitics|politics|news|military|war|crime|documentary)\b/.test(joined)) return 'hard-news';
    if (/\b(finance|business|economy|economic|market)\b/.test(joined)) return 'business';
    if (/\b(tech|technology|software|ai|science)\b/.test(joined)) return 'technology';
    if (/\b(food|recipe|cooking)\b/.test(joined)) return 'food';
    if (/\b(health|medical|fitness)\b/.test(joined)) return 'health';
    if (/\b(travel|nature|lifestyle)\b/.test(joined)) return 'place';
    if (/\b(sports|sport)\b/.test(joined)) return 'sports';
    if (/\b(history|historical)\b/.test(joined)) return 'history';
    return 'general';
}

function _inferDomain() {
    // Domain classification removed — the engine makes ZERO hardcoded domain assumption
    // about what footage a scene/niche "should" want. The Media Agent owns per-scene
    // target/prefer/queries; buildMediaHunterProfile sources everything from agentPlan.
    return null;
}

function _sceneTerms(scene, keyword) {
    const seeds = [
        scene?._forcedSearchKeyword || scene?.searchKeyword,
        keyword,
    ].filter(Boolean);

    const seedQuery = _clean(seeds.join(' '));
    const tokenQuery = _tokens(seedQuery).slice(0, 5).join(' ');
    return _compactQuery(seedQuery || tokenQuery || keyword || '', 7);
}

function _buildTargetDescription(domain, bucket, graphicScene) {
    if (graphicScene) {
        return 'the planned visual can be graphic/map/template; do not force real footage for this scene';
    }
    if (domain?.target) return domain.target;
    if (bucket === 'hard-news') {
        return 'clean real-world footage from the relevant location/event/process, not anchors or explainers';
    }
    if (bucket === 'business') {
        return 'real business/process footage: work, infrastructure, commerce, logistics, markets, offices, factories, or customers';
    }
    if (bucket === 'technology') {
        return 'real technology footage: devices, screens, labs, servers, products, or demos without presenter faces';
    }
    if (bucket === 'place') {
        return 'real place footage: streets, landscapes, landmarks, aerials, transit, crowds, or environments';
    }
    return 'literal real-world B-roll that visually matches the scene, not a presenter explaining it';
}

function buildMediaHunterProfile(scene, scriptContext = {}, opts = {}) {
    const keyword = opts.keyword || scene?.searchKeyword || scene?.researchKeyword || scene?.keyword || '';
    const nicheId = opts.nicheId || scriptContext?.nicheId || '';
    const mediaType = opts.mediaType || scene?.mediaType || 'video';
    const rawSourceHint = opts.sourceHint || scene?.sourceHint || '';
    const sourceHint = rawSourceHint === 'bing' ? 'web-image' : rawSourceHint;
    const agentPlan = opts.agentPlan || scene?._mediaAgentPlan || null;
    const referenceImageLane = mediaType === 'image' && sourceHint === 'web-image';
    const domain = referenceImageLane ? REFERENCE_IMAGE_PROFILE : _inferDomain(scene, scriptContext, keyword, nicheId);
    const bucket = _inferNicheBucket(nicheId, scriptContext, `${keyword} ${scene?.text || ''}`);
    const lane = scene?.mediaIntent?.lane || '';
    const policy = scene?.mediaIntent?.policy || {};
    const realVideoLane = lane === 'realVideo'
        || lane === 'templateBackground'
        || lane === 'videoBackup'
        || (mediaType === 'video' && policy.download !== 'template' && policy.download !== 'skip');
    const graphicIntent = lane === 'mapImage'
        || lane === 'template'
        || policy.download === 'template'
        || policy.download === 'skip';
    // Real-video intent wins over local map/template words. Those words often
    // describe overlays, not acceptable downloaded media.
    const graphicScene = graphicIntent || (!realVideoLane && _isGraphicScene(scene, keyword));
    const allowScreen = Boolean(domain?.allowScreen) || /\b(screen|software|app|website|dashboard|interface|terminal|code|spreadsheet)\b/i.test(`${keyword} ${scene?.text || ''}`);
    const allowGraphics = graphicIntent || (!realVideoLane && graphicScene);
    const strictRaw = mediaType === 'video' && realVideoLane && !allowGraphics;
    // Template-background scenes have a fullscreen statCard/factCard/etc overlay
    // covering most of the underlying clip. Text overlays or corner watermarks in
    // the background footage will be hidden behind the template UI, so they should
    // not trigger the strictRaw cap-4 penalty.
    const templateBackground = scene?._templateBackupFootage === true
        || lane === 'templateBackground'
        || /template-background/i.test(String(agentPlan?.role || ''));
    const allowRelevantPeople = strictRaw && RELEVANT_PERSON_SIGNAL_RE.test(`${keyword} ${scene?.text || ''} ${scriptContext?.summary || ''} ${(scriptContext?.entities || []).join(' ')}`);
    // Media Agent declared the planned subject IS an inherently-textual object (book/album/
    // poster cover, newspaper, sign, document). On the web-image reference lane its own cover/
    // title text is the subject, so the editorial-text cap is lifted for this scene (vision +
    // footage-manager both honor profile.allowEditorialText). Agent owns the call; default off.
    const allowEditorialText = referenceImageLane && Boolean(agentPlan?.textIsSubject);
    const mode = agentPlan?.enabled
        ? `agentic-${agentPlan.role || (strictRaw ? 'footage' : 'media')}`
        : graphicScene ? 'graphic-ok' : (domain?.mode || (strictRaw ? 'raw-broll' : 'literal'));
    const targetDescription = agentPlan?.target || agentPlan?.viewerNeed || _buildTargetDescription(domain, bucket, graphicScene);
    const mandatoryVisible = _dedupe([
        ...(Array.isArray(agentPlan?.mandatoryVisible) ? agentPlan.mandatoryVisible : []),
    ], 10);
    const mandatoryIdentity = _dedupe([
        ...(Array.isArray(agentPlan?.mandatoryIdentity) ? agentPlan.mandatoryIdentity : []),
        ...mandatoryVisible,
    ], 10);
    const identityEvidenceMode = _clean(agentPlan?.identityEvidenceMode || (mandatoryVisible.length ? 'frame-visible' : ''));
    const prefer = _dedupe([
        ...mandatoryVisible,
        ...mandatoryIdentity,
        ...(agentPlan?.mustShow || []),
        ...(agentPlan?.subjectAnchors || []),
        ...(agentPlan?.niceToShow || []),
        ...(agentPlan?.enabled ? [] : (domain?.prefer || [])),
        ...(strictRaw ? ['real footage', 'b-roll', 'raw video', 'clean visuals'] : []),
        ...(allowScreen ? ['screen recording', 'device close up'] : []),
    ], 14);
    // Does THIS scene's own request ask for the packaging strictRaw is about to
    // punish? Read from the query + the planner's visual intent + the Media
    // Agent's must-show list — never from the narration, which describes the
    // overlay we will draw, not the footage we need to download. Kept separate
    // from `allowGraphics` on purpose: a scene asking for a cutaway still wants
    // raw-footage discipline everywhere else (no anchors, no lower thirds), so
    // strictRaw stays ON and only the requested layer stops counting as a defect.
    const requestedPackaging = detectRequestedPackaging({
        scene,
        keyword,
        visualIntent: scene?.visualIntent || '',
        agentPlan,
        mediaHunter: { prefer, mandatoryVisible },
    });
    // Is this scene about a person the whole video is about? Free stock has no
    // footage of a specific athlete, so the exact-moment bar guarantees an empty
    // scene. Kept separate from `allowRelevantPeople` on purpose: that flag asks
    // "does a person belong in frame at all" from a role vocabulary, while this
    // asks "is THIS scene about THE main character" from the Director's typed
    // entities. strictRaw stays ON either way — anchors and tickers are still
    // rejected; only "right person, wrong day" stops being a failure.
    const personSubject = detectPersonSubject({
        scene,
        scriptContext,
        keyword,
        agentPlan,
        allowGraphics,
    });
    const avoid = _dedupe([
        ...(agentPlan?.mustAvoid || []),
        ...(agentPlan?.rejectIf || []),
        ...GLOBAL_AVOID_TERMS,
        // Telling the searcher and the judge to avoid charts on a scene whose
        // brief IS a chart is how scene 59 ended up with nothing.
        ...(strictRaw && !allowGraphics && !requestedPackaging.graphic ? TEXT_HEAVY_AVOID_TERMS : []),
        ...(allowScreen ? [] : ['screen recording']),
    ], 18);
    const queryBoosts = _dedupe([
        ...getMediaAgentQueries(agentPlan, sourceHint === 'web-image' ? 'bing' : sourceHint, 4),
        ...(agentPlan?.fallbackQueries || []),
        ...(agentPlan?.enabled ? [] : (domain?.queryBoosts || [])),
        ...(strictRaw ? ['footage', 'b roll', 'raw video'] : []),
    ], 8);

    const sampleIntensity = strictRaw ? 'dense' : 'normal';
    const segment = strictRaw
        ? { numSamples: 14, batchSize: 4, scoreThreshold: 3, omniFrames: 9, startMargin: 0.03, endMargin: 0.06 }
        : { numSamples: 6, batchSize: 3, scoreThreshold: 2, omniFrames: 3 };

    return {
        enabled: true,
        bucket,
        domain: agentPlan?.enabled ? 'agentic' : (domain?.key || bucket),
        fallbackDomain: domain?.key || bucket,
        mode,
        strictRaw,
        allowGraphics,
        requestedPackaging,
        personSubject,
        allowScreen,
        allowRelevantPeople,
        allowEditorialText,
        templateBackground,
        mandatoryVisible,
        mandatoryIdentity,
        identityEvidenceMode,
        targetDescription,
        agentPlan,
        prefer,
        avoid,
        queryBoosts,
        sampleIntensity,
        segment,
        keyword: _clean(keyword),
        sourceHint: _clean(sourceHint),
        mediaType,
    };
}

function _baseVisualQuery(keyword, scene, profile = null) {
    const core = _sceneTerms(scene, keyword);
    const stripped = _stripStoryNoise(core, profile);
    if (profile?.strictRaw) return stripped || '';
    return stripped || _stripQueryNoise(core) || core || keyword || '';
}

function _domainVisualQuery(profile, keyword, scene) {
    const agentQueries = getMediaAgentQueries(profile?.agentPlan, profile?.sourceHint === 'web-image' ? 'bing' : profile?.sourceHint, 1);
    if (agentQueries.length > 0) return agentQueries[0];

    // No Media Agent query → fall back to the SCENE-DERIVED visual query. No hardcoded
    // per-domain vocabulary (maritime→"cargo ship", food→"cooking", etc.): the engine makes
    // zero niche/domain assumption about what footage a scene needs. Query hygiene
    // (story/noise stripping) is mechanical and stays; the content comes from the scene.
    const base = _baseVisualQuery(keyword, scene, profile);
    const cleanBase = profile?.strictRaw
        ? (_stripStoryNoise(base, profile) || base)
        : (_stripStoryNoise(base, profile) || _stripQueryNoise(base) || base);
    return cleanBase || base;
}

function buildProviderQueries(baseQuery, keyword, scene, profile, providerKey) {
    const sourceBase = _clean(baseQuery || keyword || '');
    if (!profile?.enabled) return [sourceBase].filter(Boolean);

    const agentQueries = getMediaAgentQueries(profile.agentPlan, providerKey, 5);
    const visualBase = _baseVisualQuery(keyword || sourceBase, scene, profile);
    const strippedSource = _stripStoryNoise(sourceBase, profile);
    const cleanBase = profile.strictRaw
        ? (strippedSource || visualBase)
        : (strippedSource || _stripQueryNoise(sourceBase) || sourceBase);
    const safeSourceBase = profile.strictRaw ? strippedSource : sourceBase;
    const domainVisual = _domainVisualQuery(profile, keyword || sourceBase, scene);
    const isStock = _isStockProvider(providerKey);
    const isVideoWeb = ['youtube', 'reddit'].includes(providerKey);
    const queries = [];
    const forcedRetryQuery = _clean(scene?._forcedSearchKeyword || '');
    const mergeQueries = (providerQueries, maxWords) => {
        const local = providerQueries.map(q => _compactQuery(q, maxWords));
        // Forced retry queries are deliberate exploration. Keep the scene agent
        // brief, but do not let cached agent queries pull every retry back to
        // the first failed search phrase.
        const seed = forcedRetryQuery
            ? [sourceBase, cleanBase, ...local, ...agentQueries]
            : isStock
            ? [sourceBase, cleanBase, ...local, ...agentQueries]
            : [...agentQueries, ...local];
        return _dedupe(seed, 5);
    };

    if (profile.mediaType === 'image') {
        if (profile.allowGraphics) {
            queries.push(sourceBase, cleanBase);
        } else if (isStock) {
            queries.push(domainVisual.replace(/\b(footage|raw video|b roll)\b/gi, '').trim(), visualBase);
        } else {
            queries.push(cleanBase, `${cleanBase} photo`, sourceBase, visualBase);
        }
        return mergeQueries(queries, isStock ? 5 : 8);
    }

    if (profile.allowGraphics) {
        queries.push(sourceBase, cleanBase, visualBase);
        return mergeQueries(queries, 8);
    }

    if (isStock) {
        queries.push(
            domainVisual.replace(/\b(footage|raw video|b roll|news)\b/gi, '').trim(),
            visualBase,
            cleanBase
        );
    } else if (isVideoWeb) {
        queries.push(
            domainVisual,
            `${cleanBase} footage`,
            `${visualBase} b-roll`,
            safeSourceBase
        );
    } else {
        queries.push(`${cleanBase} footage`, domainVisual, sourceBase);
    }

    return mergeQueries(queries, 5)
        .filter(q => q && (!profile.strictRaw || !/^(footage|b roll|raw video|video)$/i.test(q)));
}

// _anchorFromScene + _wantsAerialQuery — REMOVED (2026-06-17): orphaned once the domain
// fallback factory was deleted. _anchorFromScene also carried hardcoded Middle-East shipping
// place names (Strait of Hormuz, Bab el-Mandeb, Suez…) — more single-video remnants.

// _domainFallbackQueries — REMOVED (2026-06-17).
// This was a hardcoded per-domain query factory: maritime→"cargo ship footage",
// event→"missile launch footage", and an `else` default of "hands working tools /
// workshop repair footage". On any video whose domain didn't match (e.g. a 1930s
// Hollywood documentary) the `else` default fired — "hands working tools" was retried
// 49× on that build, wildly off-topic, burning the scene budget while still failing.
// It also baked in niche assumptions (military/maritime/DIY) the engine is supposed to
// be free of. The fallback is now FULLY AGENTIC: getHunterFallbackKeywords relies on the
// Media Agent's own per-scene query lanes (getMediaAgentQueries, inside buildProviderQueries)
// plus the scene-derived visual queries. The AI decides what each scene needs — no
// hardcoded vocabulary, no domain/niche list.

function _isWeakStockRankTerm(term) {
    const text = _norm(term).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return true;
    if (RAW_CONTEXT_SIGNAL_RE.test(text)) return false;
    return WEAK_STOCK_RANK_TERM_RE.test(text)
        && _tokens(text).filter(token => !['real', 'stock', 'clean', 'raw', 'video', 'clip', 'clips', 'scene', 'footage', 'roll', 'visuals'].includes(token)).length === 0;
}

function _titleScore(text, profile, providerName = '') {
    const lower = _norm(text);
    let score = 0;
    const reasons = [];

    if (!lower) return { score, reasons };
    const topicMap = isTopicAccurateMapFromPremiumStock(lower, {
        sourceProvider: providerName,
        keyword: profile?.keyword || '',
        sceneText: profile?.targetDescription || '',
        mediaHunter: profile || {},
    });
    if (topicMap) {
        score += 10;
        reasons.push('+topic-map');
    }

    let concreteHits = 0;
    let weakHits = 0;
    for (const term of profile.prefer || []) {
        const normalizedTerm = _norm(term);
        if (!normalizedTerm) continue;
        if (lower.includes(normalizedTerm)) {
            if (_isWeakStockRankTerm(normalizedTerm)) {
                weakHits++;
                continue;
            }
            score += 2;
            concreteHits++;
            reasons.push(`+${term}`);
        }
    }
    // Penalize the Media Agent's own avoid/reject terms when they surface in the result
    // title. This is what stops a "Sammy Davis Jr" search from ranking an MLK civil-rights
    // march image first: the Agent put "protest / march / crowd" on mustAvoid, so a title
    // naming them sinks. Fully agentic (the Agent owns the avoid list) and loose (we DEMOTE,
    // not hard-drop — vision still has the final verdict on whatever survives to download).
    let avoidHits = 0;
    for (const term of profile.avoid || []) {
        const normalizedTerm = _norm(term);
        if (!normalizedTerm || normalizedTerm.length < 3) continue;
        if (lower.includes(normalizedTerm)) {
            score -= 3;
            avoidHits++;
            reasons.push(`-${term}`);
            if (avoidHits >= 3) break;
        }
    }
    if (RAW_CONTEXT_SIGNAL_RE.test(lower)) {
        score += concreteHits || topicMap ? 2 : 1;
        reasons.push(concreteHits || topicMap ? '+raw-context' : '+weak-raw-context');
    }
    if (WEAK_STOCK_RANK_TERM_RE.test(lower) || weakHits) {
        if (concreteHits || topicMap) {
            score += 1;
            reasons.push('+stock-format');
        } else {
            reasons.push('+generic-stock-only');
        }
    }
    if (profile.strictRaw) {
        const heavyBad = /\b(explained|explainer|why|analysis|podcast|interview|webinar|lecture|animation|animated|cartoon|infographic|chart|graph|slideshow|thumbnail|ai generated|talking head)\b/i;
        const lightBad = /\b(news|report|live|documentary)\b/i;
        if (heavyBad.test(lower) && !topicMap) {
            score -= 5;
            reasons.push('-non-footage-title');
        } else if (lightBad.test(lower)) {
            score -= 1;
            reasons.push('-possibly-packaged');
        }
    }

    return { score, reasons };
}

function rankResultsForHunter(results, profile, providerName = '') {
    if (!profile?.enabled || !Array.isArray(results) || results.length < 2) return results;

    const ranked = results.map((result, index) => {
        const text = [result.title, result.description, result._cachedMeta?.title, result._meta?.title, result.url]
            .filter(Boolean)
            .join(' ');
        const title = _titleScore(text, profile, providerName);
        let durationScore = 0;
        const duration = Number(result.duration || result._cachedMeta?.duration || result._meta?.duration || 0);
        if (profile.strictRaw && duration > 0) {
            if (duration >= 20 && duration <= 600) durationScore += 1;
            if (duration > 1800) durationScore -= 2;
        }
        return {
            result,
            index,
            score: title.score + durationScore,
            reasons: title.reasons,
        };
    });

    const useful = ranked.filter(r => r.score !== 0).length;
    if (useful === 0) return results;

    ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const moved = ranked.some((r, idx) => r.index !== idx);
    if (moved) {
        const top = ranked[0];
        const label = String(top.result.title || top.result.url || '').replace(/\s+/g, ' ').slice(0, 90);
        console.log(`  Media Hunter: [${providerName || 'provider'}] ranked "${label}" first (${top.score} pts${top.reasons.length ? `: ${top.reasons.slice(0, 4).join(', ')}` : ''})`);
    }
    return ranked.map(r => r.result);
}

function getHunterFallbackKeywords(keyword, scene, scriptContext = {}, opts = {}) {
    const profile = buildMediaHunterProfile(scene, scriptContext, { ...opts, keyword });
    const providerKey = opts.providerKey || (profile.mediaType === 'video' ? 'youtube' : 'bing');
    const base = opts.forceKeywordBase ? keyword : (scene?.webQuery || scene?.stockQuery || keyword);
    // Fallback queries are the Media Agent's per-scene query lanes (getMediaAgentQueries,
    // inside buildProviderQueries) + scene-derived visuals — NOT a hardcoded domain list.
    // Fully agentic: the AI decides what this scene needs, regardless of niche/domain.
    const direct = buildProviderQueries(base, keyword, scene, profile, providerKey)
        .slice(1);
    return _dedupe(direct, opts.max || 10)
        .filter(q => q && q.toLowerCase() !== String(keyword || '').toLowerCase());
}

function summarizeMediaHunter(profile) {
    if (!profile) return null;
    return {
        mode: profile.mode,
        domain: profile.domain,
        strictRaw: profile.strictRaw,
        allowRelevantPeople: profile.allowRelevantPeople,
        personSubject: profile.personSubject?.active ? profile.personSubject.people : [],
        target: profile.targetDescription,
        prefer: profile.prefer?.slice(0, 8) || [],
        avoid: profile.avoid?.slice(0, 8) || [],
        sampleIntensity: profile.sampleIntensity,
    };
}

module.exports = {
    buildMediaHunterProfile,
    buildProviderQueries,
    rankResultsForHunter,
    getHunterFallbackKeywords,
    summarizeMediaHunter,
};
