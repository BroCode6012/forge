/**
 * AI Visual Planner Module — Step 4 of the pipeline
 *
 * Replaces ai-keywords.js with a BATCH approach.
 * Instead of calling AI once per scene (N calls), we call it ONCE for ALL scenes.
 *
 * Why batch is better:
 *   - AI sees the FULL video story arc → plans visual variety
 *   - AI understands context from ai-director.js → smarter keyword choices
 *   - 1 API call instead of N calls → faster, cheaper
 *   - Visual consistency across the video (no repetition)
 *
 * Receives from ai-director.js:
 *   - scenes: Scene[] with text, timestamps, words
 *   - scriptContext: { theme, tone, mood, pacing, format, entities, hook, CTA, etc. }
 *   - directorsBrief: Quality tier, format, audience hint
 *
 * Outputs:
 *   - Enriched scenes with:
 *     • keyword: "FBI agents raiding mansion at night"
 *     • mediaType: "video" | "image"
 *     • sourceHint: "stock" | "youtube" | "web-image" | "reddit"
 *     • visualIntent: "Aerial establishing shot of large mansion surrounded by police vehicles"
 *     • effects: ["grain", "vignette"] — expanded from effectPreset (preset-based, not individual picks)
 *     • mgHint: "lowerThird: Detective Smith, Lead Investigator" — MG suggestion from niche's allowed list (or null)
 *
 * Uses shared ai-provider.js for all AI calls.
 */

const { callAI } = require('../brain/ai-provider');
const config = require('../settings/config');
const path = require('path');
const fs = require('fs');
const { getMatchingBackgrounds, BACKGROUND_LIBRARY, getTheme } = require('../data/themes');
const {
    validateTemplateHintPlacement,
    validateOverlayHintPlacement,
} = require('./planner-display-guards');
const { filterDisabledSources, sanitizeSourceHint, providerToSourceHint } = require('../media/source-policy');
const {
    repairDisplaySearchQuery,
} = require('../media/search-keywords');
const {
    chooseNumericLabel,
    containsNumericSignal: sharedContainsNumericSignal,
} = require('../directives/numeric-signals');

// ============================================================
// HELPERS
// ============================================================

const VP_SOURCE_HINTS = ['stock', 'youtube', 'web-image', 'reddit'];
const VP_MEDIA_NEEDS = ['exact-still', 'real-demo-video', 'generic-broll', 'template-only', 'data-graphic'];

function _sanitizeVpSourceHint(value, fallback = 'youtube') {
    const hint = sanitizeSourceHint(value, fallback);
    if (!hint) return hint;
    if (hint === 'news') return 'youtube';
    return VP_SOURCE_HINTS.includes(hint) ? hint : fallback;
}

function _sanitizeMediaNeed(value) {
    const raw = String(value || '').trim().toLowerCase()
        .replace(/_/g, '-')
        .replace(/\s+/g, '-');
    if (!raw || _PLACEHOLDER_VALUES.has(raw)) return null;
    const aliases = {
        exact: 'exact-still',
        reference: 'exact-still',
        'reference-still': 'exact-still',
        still: 'exact-still',
        image: 'exact-still',
        demo: 'real-demo-video',
        process: 'real-demo-video',
        'real-video': 'real-demo-video',
        'real-footage': 'real-demo-video',
        youtube: 'real-demo-video',
        broll: 'generic-broll',
        'b-roll': 'generic-broll',
        generic: 'generic-broll',
        stock: 'generic-broll',
        template: 'template-only',
        graphics: 'data-graphic',
        data: 'data-graphic',
        stat: 'data-graphic',
    };
    const need = aliases[raw] || raw;
    return VP_MEDIA_NEEDS.includes(need) ? need : null;
}

function _videoPriorityForVp(niche, fallback = 'youtube') {
    const raw = Array.isArray(niche?.footagePriority?.video) ? niche.footagePriority.video : [fallback];
    return [...new Set(filterDisabledSources(raw).map(providerToSourceHint).filter(Boolean))];
}

/**
 * Scan assets/backgrounds/ for custom background files, optionally filtered by theme.
 * Theme tagging convention: "{theme}--{name}.ext" (e.g., "history--vintage-paper.jpg")
 * Files without a theme prefix are available for all themes.
 */
function _scanCustomBackgrounds(themeId) {
    const bgDir = path.join(__dirname, '..', '..', 'assets', 'backgrounds');
    if (!fs.existsSync(bgDir)) return [];

    const VALID_THEMES = new Set(['crime', 'history', 'modern', 'minimal', 'standard', 'warm-editorial', 'luxury', 'nature']);
    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);

    try {
        const files = fs.readdirSync(bgDir).filter(f => {
            const ext = path.extname(f).toLowerCase();
            return supportedExts.has(ext) && !f.startsWith('.');
        });

        return files.map(f => {
            let name = path.basename(f, path.extname(f));
            let theme = null;
            const dashIdx = name.indexOf('--');
            if (dashIdx > 0) {
                const prefix = name.substring(0, dashIdx).toLowerCase();
                if (VALID_THEMES.has(prefix)) {
                    theme = prefix;
                    name = name.substring(dashIdx + 2);
                }
            }
            return { filename: f, name, theme };
        }).filter(bg => !bg.theme || bg.theme === themeId);
    } catch (e) {
        return [];
    }
}

/**
 * Build a list of available backgrounds for the AI prompt.
 * Includes built-in gradients + custom files matching the current theme.
 */
function _buildBackgroundList(themeId) {
    const matched = getMatchingBackgrounds(themeId || 'standard');
    // Show top 6 gradient matches to keep prompt concise
    const shown = matched.slice(0, 6);
    let lines = shown.map(bg => `   - "${bg.id}" = ${bg.name} (gradient)`);

    // Add custom background files matching this theme
    const customBgs = _scanCustomBackgrounds(themeId);
    for (const bg of customBgs) {
        lines.push(`   - "file:${bg.filename}" = ${bg.name} (custom image/video)`);
    }

    return lines.join('\n');
}

/**
 * Auto-generate a stock-optimized query from a descriptive keyword.
 * Stock APIs work best with 2-3 visual/generic words.
 * Strips names, dates, specifics — keeps visual descriptors.
 */
function _autoStockQuery(keyword) {
    // Common non-visual words to strip for stock search
    const STRIP = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
        'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
        'this', 'that', 'their', 'its', 'photo', 'photos', 'image', 'images',
        'footage', 'video', 'clip', 'picture', 'portrait', 'press', 'conference',
        'report', 'event', 'scene', 'shot', 'view', 'real', 'actual',
    ]);

    // Words that are visual descriptors (keep these)
    const VISUAL = new Set([
        'aerial', 'closeup', 'close-up', 'wide', 'panoramic', 'night', 'dark',
        'dramatic', 'cinematic', 'golden', 'silhouette', 'underwater', 'slow',
        'timelapse', 'drone', 'macro', 'bokeh', 'sunset', 'sunrise', 'rain',
        'fog', 'smoke', 'fire', 'explosion', 'neon', 'glowing', 'abstract',
    ]);

    const words = keyword.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    // Remove stop words, keep visual descriptors and nouns
    const kept = words.filter(w => !STRIP.has(w) && w.length > 2);

    if (kept.length <= 3) return kept.join(' ') || keyword.split(/\s+/).slice(0, 3).join(' ');

    // Prioritize: visual descriptors first, then longest words (likely nouns)
    const visual = kept.filter(w => VISUAL.has(w));
    const rest = kept.filter(w => !VISUAL.has(w)).sort((a, b) => b.length - a.length);
    const selected = [...visual.slice(0, 1), ...rest].slice(0, 3);
    return selected.join(' ');
}

/**
 * Auto-generate a web-optimized query from a descriptive keyword.
 * Web search benefits from specificity — keep names, dates, add context.
 */
function _autoWebQuery(keyword, sourceHint) {
    let query = keyword.trim();
    // If it's already short enough for web, use as-is
    if (query.split(/\s+/).length <= 6) return query;
    // Take first 6 meaningful words
    const words = query.split(/\s+/).slice(0, 6).join(' ');
    return words;
}

function _getTemplateHintType(value) {
    if (!value || typeof value !== 'string') return null;
    const type = value.split(':')[0].trim();
    return type || null;
}

function _buildTemplateBackgroundQuery(scene, scriptContext = {}) {
    if (!scene?.templateHint) return null;
    const type = _getTemplateHintType(scene.templateHint);
    const content = String(scene.templateHint || '').split(':').slice(1).join(':');
    const haystack = [
        scene.text,
        content,
        scene.visualIntent,
        scriptContext.summary,
        scriptContext.videoTitle,
    ].filter(Boolean).join(' ');
    const lower = haystack.toLowerCase();

    const entities = scriptContext.entities || [];
    const entityTypes = scriptContext.entityTypes || {};
    const placeTypes = new Set(['place', 'location', 'country', 'city', 'region']);
    const places = entities
        .filter(e => lower.includes(String(e).toLowerCase()) && placeTypes.has(entityTypes[String(e).toLowerCase()]))
        .slice(0, 2);

    const terms = [];
    const add = (term) => {
        if (term && !terms.includes(term)) terms.push(term);
    };
    const compact = (parts, maxWords = 10) => {
        // Phrase-atomic compaction: keep each input phrase whole.
        // Drop a phrase entirely if it would push the running word count
        // past maxWords (never chop mid-phrase, which produces orphan
        // fragments like "Red Sea Suez Canal" → "Red").
        const seenWords = new Set();
        const kept = [];
        let used = 0;
        for (const phrase of parts) {
            if (!phrase) continue;
            const phraseWords = String(phrase).split(/\s+/).filter(Boolean);
            const novel = phraseWords.filter(w => {
                const key = w.toLowerCase();
                if (seenWords.has(key)) return false;
                return true;
            });
            if (novel.length === 0) continue;
            if (used + novel.length > maxWords) continue;
            for (const w of novel) seenWords.add(w.toLowerCase());
            kept.push(novel.join(' '));
            used += novel.length;
        }
        return kept.join(' ');
    };

    if (/\bglobal trade|world trade|trade\b/.test(lower)) add('global maritime trade');
    if (/\boil|barrels?|tanker|energy\b/.test(lower)) add('oil tanker shipping');
    if (/\bcontainer|cargo|port|crane|logistics\b/.test(lower)) add('container port logistics');
    if (/\bshipping|ship|ships|vessel|maritime|strait|canal|route|corridor\b/.test(lower)) add('shipping route');
    if (/\bsuez|red sea|bab[-\s]?el[-\s]?mandeb|hormuz|persian gulf\b/.test(lower)) add('Red Sea Suez Canal');
    if (/\bblockade|attack|threat|risk|military|naval|defense|radar\b/.test(lower)) add('maritime security');
    if (/\bsupply chain|network|dependency|efficiency|economical|connect\b/.test(lower)) add('global supply chain');
    if (/\bais|tracking|traffic\b/.test(lower)) add('ship tracking map');
    if (/\bwasher|washing machine|laundry|laundromat|agitator|appliance\b/.test(lower)) add('laundry machine repair');
    if (/\bsmall engine|generator|mower|pressure washer|carburetor|recoil\b/.test(lower)) add('small engine repair workshop');
    if (/\bwork boot|work boots|footwear|cobbler|resole|welt|sole|leather boot\b/.test(lower)) add('leather boot repair workshop');
    if (/\bcast iron|skillet|cookware|non-stick|pan\b/.test(lower)) add('cast iron skillet kitchen');
    if (/\bhand tool|wrench|pliers|socket|bolt|steel tools?\b/.test(lower)) add('hand tools workbench');
    if (/\bbuy it for life|forever list|durable|repair rather than replace\b/.test(lower)) add('durable products workbench');

    if (type === 'statCard' && terms.length === 0) add('statistics infographic background');
    if ((type === 'factCard' || type === 'keyTakeaway') && terms.length === 0) add('documentary concept background');

    const queryParts = [...places, ...terms].slice(0, 5);
    if (queryParts.length > 0) return compact(queryParts);

    const words = lower
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(w => w.length > 3 && !['around', 'nearly', 'still', 'just', 'time', 'defines', 'this', 'that', 'with', 'from', 'into', 'over', 'under', 'their', 'there', 'scene'].includes(w));
    const fallback = words.slice(0, 5).join(' ');
    return fallback ? `${fallback} documentary background` : null;
}

function _applyTemplateBackgroundLane(scene, scriptContext = {}) {
    if (!scene?.templateHint || scene.fullscreenMG) return null;
    const before = scene.keyword || null;
    // Prefer Sonnet-emitted bgQuery (context-aware, has full narration in scope).
    // Fall back to the heuristic _buildTemplateBackgroundQuery only when AI
    // omitted the field (older plans / non-template scenes / parse miss).
    const aiBgQuery = _sanitizeSearchValue(scene._aiBgQuery);
    const bgQuery = aiBgQuery || _buildTemplateBackgroundQuery(scene, scriptContext);
    scene.templateBgQuery = bgQuery;
    scene.keyword = null;
    scene.stockQuery = null;
    scene.webQuery = null;
    scene.sourceHint = null;
    scene.mediaType = null;
    scene.protectedTerms = [];
    if ((!scene.visualIntent || _PLACEHOLDER_VALUES.has(String(scene.visualIntent).toLowerCase())) && bgQuery) {
        scene.visualIntent = bgQuery;
    }
    return before && before !== bgQuery ? { before, after: bgQuery } : null;
}

function _sourceDecisionBlob(scene, scriptContext = {}) {
    const protectedTerms = Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : [];
    return [
        scene?.keyword,
        scene?.searchKeyword,
        scene?.stockQuery,
        scene?.webQuery,
        scene?.visualIntent,
        scene?.mediaNeed,
        scene?.sourceReason,
        scene?.text,
        ...protectedTerms,
    ].filter(Boolean).join(' ');
}

function _hasExactEntityCue(scene, scriptContext = {}) {
    const protectedTerms = Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : [];
    const entities = Array.isArray(scriptContext?.entities) ? scriptContext.entities : [];
    const blobLower = _sourceDecisionBlob(scene, scriptContext).toLowerCase();

    const genericTerms = new Set([
        'made in usa', 'cast iron', 'workbench', 'tool', 'tools', 'hands',
        'leather', 'boots', 'boot', 'wrench', 'steel', 'plastic', 'consumer goods',
        'factory', 'facility', 'appliance', 'washer', 'washing machine', 'skillet',
        'pan', 'engine', 'generator', 'shelf', 'aisle', 'store', 'workshop',
    ]);

    if (entities.some(entity => {
        const clean = String(entity || '').trim();
        return clean.length > 2 && blobLower.includes(clean.toLowerCase());
    })) {
        return true;
    }

    return protectedTerms.some(term => {
        const clean = String(term || '').trim();
        if (!clean || genericTerms.has(clean.toLowerCase())) return false;
        return /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(clean) || /\b[A-Z]{2,}\b/.test(clean);
    });
}

function _looksLikeSpecificReference(scene, scriptContext = {}) {
    const blob = _sourceDecisionBlob(scene, scriptContext);

    if (/\b(photo|portrait|headshot|logo|label|city sign|product shot|model plate|nameplate|error code|screenshot|document|article|diagram|schematic|blueprint|historical|archive|archival|official|made in)\b/i.test(blob)) {
        return true;
    }
    if (_hasExactEntityCue(scene, scriptContext) && /\b(factory|facility|headquarters|showroom|store|brand display|product display)\b/i.test(blob)) {
        return true;
    }
    if (/\b(19|20)\d{2}s?\b/.test(blob)) return true;
    return _hasExactEntityCue(scene, scriptContext);
}

function _looksLikeStaticReferenceCue(scene, scriptContext = {}) {
    const blob = _sourceDecisionBlob(scene, scriptContext);
    return /\b(photo|portrait|headshot|logo|label|nameplate|model plate|city sign|signage|screenshot|document|article|chart|graph|infographic|diagram|schematic|blueprint|map|historical|archive|archival|error code|product shot|still image)\b/i.test(blob);
}

function _looksLikeRealMovingFootage(scene, scriptContext = {}) {
    const blob = _sourceDecisionBlob(scene, scriptContext);
    const hasExact = _hasExactEntityCue(scene, scriptContext);
    const hasMotionNeed = /\b(video|footage|clip|demo|demonstration|review|walkthrough|tour|behind[-\s]?the[-\s]?scenes|factory tour|assembly line|production line|manufacturing floor|interview|press conference|speech|event|launch|protest|rally|match|game|highlight|broadcast|dashcam|bodycam|drone|training|operation|combat|attack|strike|running|driving|starts?|fires?|pull|churning|resoling|repairing|stitching|gripping|scraping|testing|drop test)\b/i.test(blob);
    const exactMovingSubject = /\b(factory|facility|headquarters|store|showroom|brand|model|product demo|official|review|tour|walkthrough|interview|press conference|event|launch)\b/i.test(blob);
    return (_NEWS_ACTORS_RE.test(blob) && _MILITARY_VERBS_RE.test(blob)) || (hasExact && (hasMotionNeed || exactMovingSubject));
}

function _looksLikeGenericStockFootage(scene, scriptContext = {}) {
    const blob = _sourceDecisionBlob(scene, scriptContext);
    if (_looksLikeSpecificReference(scene, scriptContext)) return false;
    if (_looksLikeRealMovingFootage(scene, scriptContext)) return false;
    return /\b(generic|abstract|cinematic|mood|background|texture|close[-\s]?up|macro|hands|workbench|office|boardroom|aisle|shelf|store|shopper|consumer|landfill|trash|waste|repair bench|workshop|kitchen|laundry|warehouse|factory|storm|ocean|aerial|family|typing|handshake|empty|tools|gears|steel|leather|plastic|flames?|smoke|sunset|night)\b/i.test(blob);
}

function _mediaNeedMatchesSource(scene) {
    const need = _sanitizeMediaNeed(scene?.mediaNeed);
    if (!need) return true;
    const mediaType = scene?.mediaType || null;
    const source = scene?.sourceHint || null;
    if (need === 'template-only') {
        return !!(scene?.templateHint || scene?.fullscreenMG);
    }
    if (need === 'data-graphic') return !!(scene?.templateHint || scene?.fullscreenMG || scene?.mgHint);
    if (need === 'exact-still') return mediaType === 'image' && source === 'web-image';
    if (need === 'real-demo-video') return mediaType === 'video' && (source === 'youtube' || source === 'reddit');
    if (need === 'generic-broll') return mediaType === 'video' && source === 'stock';
    return true;
}

function _rememberSourcePolicyFix(scene, beforeSource, afterSource, reason, beforeType = scene?.mediaType, afterType = scene?.mediaType) {
    if (!scene) return;
    if (!Array.isArray(scene._sourcePolicyFixes)) scene._sourcePolicyFixes = [];
    scene._sourcePolicyFixes.push({
        beforeSource: beforeSource || null,
        afterSource: afterSource || null,
        beforeType: beforeType || null,
        afterType: afterType || null,
        reason,
    });
}

function _applySemanticSourceRouting(scenes, scriptContext = {}, plannerDirectives = null) {
    const fixes = [];
    const preferredVideoSource = _pickPreferredVideoSource(scriptContext?.nicheId || 'general', plannerDirectives || { user: {} }, 'youtube');
    for (const scene of scenes || []) {
        if (!scene || scene.fullscreenMG || scene.templateHint) continue;
        if (!scene.mediaType) continue;
        const before = scene.sourceHint || null;
        const beforeType = scene.mediaType || null;
        let reason = '';
        let afterSource = before;
        let afterType = beforeType;

        if (beforeType === 'image') {
            if (before === 'youtube' || before === 'reddit') {
                afterSource = _looksLikeSpecificReference(scene, scriptContext) ? 'web-image' : 'stock';
                reason = afterSource === 'web-image'
                    ? 'image scenes need an exact/reference image provider'
                    : 'generic image scenes should use stock images';
            } else if (before === 'web-image') {
                afterSource = 'web-image';
                reason = '';
            } else if ((before === 'stock' || !before) && _looksLikeSpecificReference(scene, scriptContext)) {
                afterSource = 'web-image';
                reason = 'specific reference still should use web-image, not stock';
            }
        } else if (beforeType === 'video') {
            if (before === 'web-image') {
                if (_looksLikeSpecificReference(scene, scriptContext) || _looksLikeStaticReferenceCue(scene, scriptContext)) {
                    afterType = 'image';
                    afterSource = 'web-image';
                    reason = 'web-image is a still-image source';
                } else {
                    afterSource = preferredVideoSource;
                    reason = 'web-image cannot serve video footage';
                }
            } else if (before === 'stock') {
                const mediaNeed = _sanitizeMediaNeed(scene.mediaNeed);
                if ((mediaNeed === 'exact-still' || _looksLikeStaticReferenceCue(scene, scriptContext)) && !_looksLikeRealMovingFootage(scene, scriptContext)) {
                    afterType = 'image';
                    afterSource = 'web-image';
                    reason = 'static exact/reference cue should be image/web-image';
                } else if (mediaNeed === 'real-demo-video') {
                    afterSource = preferredVideoSource;
                    reason = 'AI-declared real moving footage should use a real-footage source';
                }
            } else if ((before === 'youtube' || before === 'reddit') && _sanitizeMediaNeed(scene.mediaNeed) === 'generic-broll') {
                // REVERTED 2026-09-02. This branch briefly required the scene's own signals
                // to agree before demoting to stock, on the theory that it was wrongly
                // starving the web-image lane. Measured: it moved ~100 scenes off stock (54%
                // success) and onto youtube (42%), and the borrow rate went 45.3% -> 47.5%.
                // The premise was wrong — web-image's 89% was a property of the easy scenes
                // the planner sent it, not of the lane — so leave the original behaviour
                // alone. See SPEED-PLAN.md Stage 5.
                afterSource = 'stock';
                reason = 'AI-declared generic b-roll should use stock';
            }
        }

        if (!reason || (afterSource === before && afterType === beforeType)) continue;
        scene.mediaType = afterType;
        scene.sourceHint = afterSource;
        const queryBase = scene.searchKeyword || scene.keyword || scene.webQuery || scene.visualIntent || scene.text || '';
        if (queryBase && !scene.keyword) scene.keyword = String(queryBase).split(/\s+/).slice(0, 8).join(' ');
        if (queryBase && !scene.webQuery) scene.webQuery = _autoWebQuery(queryBase, scene.sourceHint);
        if (queryBase && !scene.stockQuery) scene.stockQuery = _autoStockQuery(queryBase);
        _rememberSourcePolicyFix(scene, before, afterSource, reason, beforeType, afterType);
        fixes.push({ index: scene.index, before, after: afterSource, beforeType, afterType, reason });
    }
    return fixes;
}

// Strip proper-noun entity tokens from a STOCK-lane query. Stock libraries
// index generic visual concepts ("container ship aerial"), never
// micro-toponyms — "Bab el-Mandeb cargo ship" returns nothing on every stock
// provider and the scene dies into continuity-fill. The Director already
// tags entities (places/people/orgs); remove their tokens from the stock
// query only. Web/YouTube lanes keep the literal query — proper nouns are
// exactly right there. Niche-agnostic: driven entirely by tagged entities.
function _sanitizeStockQuery(query, scriptContext = {}) {
    const q = String(query || '').trim();
    if (!q) return q;
    const entityTokens = new Set();
    for (const name of (scriptContext.entities || [])) {
        for (const tok of String(name).toLowerCase().split(/[\s\-–—]+/)) {
            if (tok.length > 2) entityTokens.add(tok);
        }
    }
    if (!entityTokens.size) return q;
    const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
    const kept = q.split(/\s+/).filter(w => {
        const n = norm(w);
        if (!n) return false;
        if (entityTokens.has(n)) return false;
        // hyphenated toponyms ("el-mandeb") — drop if any segment is an entity token
        return !w.toLowerCase().split(/[-–—]/).some(seg => entityTokens.has(norm(seg)));
    });
    // If entity-stripping gutted the query, the generic remainder is still
    // better than a zero-hit toponym; empty falls back to the original.
    return kept.join(' ').trim() || q;
}

function _ensureFootageSearchQueries(scenes, scriptContext = {}) {
    let fixed = 0;
    for (const scene of scenes || []) {
        if (!scene || scene.fullscreenMG || scene.templateHint || !scene.keyword) continue;
        const queryBase = scene.searchKeyword || scene.keyword;
        if (!scene.stockQuery) {
            scene.stockQuery = _autoStockQuery(queryBase);
            fixed++;
        }
        // Sanitize the stock lane regardless of who wrote the query (the
        // AI-provided stockQuery carries toponyms just as often as the auto
        // one). Raw value kept for the media trace.
        const cleaned = _sanitizeStockQuery(scene.stockQuery, scriptContext);
        if (cleaned && cleaned !== scene.stockQuery) {
            scene._stockQueryRaw = scene.stockQuery;
            scene.stockQuery = cleaned;
            fixed++;
        }
        if (!scene.webQuery) {
            scene.webQuery = _autoWebQuery(queryBase, scene.sourceHint);
            fixed++;
        }
    }
    return fixed;
}

function _sourceAuditText(scene, scriptContext = {}, globalOutline = null) {
    const outline = globalOutline?.sceneHints?.[scene?.index];
    return [
        scene?.text,
        scene?.keyword,
        scene?.visualIntent,
        scene?.mgHint,
        scene?.stockQuery,
        scene?.webQuery,
        Array.isArray(scene?.protectedTerms) ? scene.protectedTerms.join(' ') : '',
        outline?.raw,
        outline?.note,
        outline?.source,
    ].filter(Boolean).join(' ');
}

function _isLowInformationSearchQuery(scene, scriptContext = {}, globalOutline = null) {
    if (!scene || scene.fullscreenMG || scene.templateHint) return false;
    const keyword = String(scene.keyword || '').replace(/\s+/g, ' ').trim();
    if (!keyword || _isWeakFootageKeyword(keyword)) return true;
    const words = keyword.split(/\s+/).filter(Boolean);
    const protectedTerms = Array.isArray(scene.protectedTerms) ? scene.protectedTerms : [];
    if (protectedTerms.some(term => keyword.toLowerCase().includes(String(term).toLowerCase()))) return false;
    if (words.length <= 2) {
        const text = _sourceAuditText(scene, scriptContext, globalOutline);
        return !/\b(?:engine|washer|machine|boot|shoe|sole|pan|skillet|tool|wrench|pliers|factory|store|aisle|shelf|workbench|family|appliance|circuit|board|label|logo|model|photo|product|generator|carburetor|spatula|stitch|chrome|steel|leather|plastic|landfill|waste|comment|screenshot)\b/i.test(text);
    }
    return false;
}

function _selectSourceAuditCandidates(scenes, scriptContext = {}, globalOutline = null) {
    const candidates = [];
    for (const scene of scenes || []) {
        if (!scene || scene.fullscreenMG || scene.templateHint) continue;
        const reasons = [];
        const need = _sanitizeMediaNeed(scene.mediaNeed);
        const outlineSource = _sanitizeVpSourceHint(globalOutline?.sceneHints?.[scene.index]?.source, '');
        if (need && !_mediaNeedMatchesSource(scene)) reasons.push(`mediaNeed mismatch: ${need}`);
        if (outlineSource && scene.sourceHint && outlineSource !== scene.sourceHint) reasons.push(`outline source ${outlineSource} vs chosen ${scene.sourceHint}`);
        if (Array.isArray(scene._sourcePolicyFixes) && scene._sourcePolicyFixes.length > 0) reasons.push('source policy changed it');
        if (_isLowInformationSearchQuery(scene, scriptContext, globalOutline)) reasons.push('weak/abstract search query');
        if (scene.sourceHint === 'stock' && _sanitizeMediaNeed(scene.mediaNeed) === 'real-demo-video') reasons.push('AI says real demo but source is stock');
        if (scene.sourceHint === 'youtube' && _sanitizeMediaNeed(scene.mediaNeed) === 'generic-broll') reasons.push('AI says generic b-roll but source is youtube');
        if (reasons.length === 0) continue;
        candidates.push({ scene, reasons });
    }
    return candidates.slice(0, 18);
}

function _auditField(body, name) {
    const match = String(body || '').match(new RegExp(`\\b${name}\\s*:\\s*([^|]+)`, 'i'));
    return match ? match[1].trim() : '';
}

function _applySourceAuditResult(scene, body) {
    const decision = _auditField(body, 'decision').toUpperCase();
    if (!decision) return null;

    const before = {
        mediaType: scene.mediaType || null,
        sourceHint: scene.sourceHint || null,
        keyword: scene.keyword || null,
        stockQuery: scene.stockQuery || null,
        webQuery: scene.webQuery || null,
        mediaNeed: scene.mediaNeed || null,
    };

    const mediaNeed = _sanitizeMediaNeed(_auditField(body, 'mediaNeed') || _auditField(body, 'media need'));
    if (mediaNeed) scene.mediaNeed = mediaNeed;

    const sourceReason = _auditField(body, 'sourceReason') || _auditField(body, 'source reason') || _auditField(body, 'reason');
    if (sourceReason) scene.sourceReason = sourceReason.replace(/\s+/g, ' ').trim();

    if (decision !== 'CHANGE') return { changed: false, before, after: { ...before }, reason: scene.sourceReason || 'auditor kept scene' };

    const mediaType = _auditField(body, 'mediaType') || _auditField(body, 'media type');
    if (/^(video|image)$/i.test(mediaType)) scene.mediaType = mediaType.toLowerCase();

    const sourceHint = _sanitizeVpSourceHint(_auditField(body, 'sourceHint') || _auditField(body, 'source hint'), '');
    if (sourceHint && VP_SOURCE_HINTS.includes(sourceHint)) scene.sourceHint = sourceHint;

    const keyword = _sanitizeSearchValue(_auditField(body, 'keyword'));
    if (keyword) scene.keyword = keyword;

    const stockQuery = _sanitizeSearchValue(_auditField(body, 'stockQuery') || _auditField(body, 'stock query'));
    if (stockQuery) scene.stockQuery = stockQuery;

    const webQuery = _sanitizeSearchValue(_auditField(body, 'webQuery') || _auditField(body, 'web query'));
    if (webQuery) scene.webQuery = webQuery;

    if (scene.keyword && !scene.stockQuery) scene.stockQuery = _autoStockQuery(scene.keyword);
    if (scene.keyword && !scene.webQuery) scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);

    const after = {
        mediaType: scene.mediaType || null,
        sourceHint: scene.sourceHint || null,
        keyword: scene.keyword || null,
        stockQuery: scene.stockQuery || null,
        webQuery: scene.webQuery || null,
        mediaNeed: scene.mediaNeed || null,
    };
    const changed = Object.keys(before).some(key => before[key] !== after[key]);
    if (!changed) return { changed: false, before, after, reason: scene.sourceReason || 'auditor change had no diff' };

    scene._sourceAuditFix = { before, after, reason: scene.sourceReason || 'AI source audit' };
    return { changed: true, before, after, reason: scene.sourceReason || 'AI source audit' };
}

async function _auditQuestionableSourcesWithAI(scenes, scriptContext = {}, directorsBrief = {}, plannerDirectives = null, globalOutline = null) {
    const candidates = _selectSourceAuditCandidates(scenes, scriptContext, globalOutline);
    if (candidates.length === 0) return [];

    const sceneRows = candidates.map(({ scene, reasons }) => {
        const outline = globalOutline?.sceneHints?.[scene.index];
        return [
            `SCENE ${scene.index}`,
            `reasons=${reasons.join('; ')}`,
            `text="${_shortVpLog(scene.text, 220)}"`,
            outline ? `outline="${_shortVpLog(outline.raw || outline.note || '', 220)}"` : null,
            `current=mediaType:${scene.mediaType || 'none'} sourceHint:${scene.sourceHint || 'none'} mediaNeed:${scene.mediaNeed || 'none'}`,
            `keyword="${scene.keyword || 'none'}" stockQuery="${scene.stockQuery || 'none'}" webQuery="${scene.webQuery || 'none'}"`,
            `visualIntent="${_shortVpLog(scene.visualIntent || '', 160)}"`,
            scene.mgHint ? `mgHint="${_shortVpLog(scene.mgHint, 120)}"` : null,
            Array.isArray(scene.protectedTerms) && scene.protectedTerms.length ? `protected="${scene.protectedTerms.join('; ')}"` : null,
        ].filter(Boolean).join(' | ');
    }).join('\n');

    const prompt = `You are the Visual Planner source auditor.

Audit ONLY the listed questionable scenes. Keep editorial judgment with the AI. Do not apply mechanical rules.

Provider meanings:
- stock = Pexels/Pixabay free generic B-roll. Use for concrete hands-on actions, process shots, generic environments with visible activity, non-exact product/category shots.
- web-image = Bing/Brave exact/reference still image. Use for exact people, brands, logos, labels, model plates, screenshots, documents, diagrams, historical proof photos.
- youtube = real moving footage: demos, teardown, repair process, factory tours, reviews, product tests, real actions.
- reddit = raw/community/broadcast/dashcam/drone clips.

mediaNeed values:
- exact-still
- real-demo-video
- generic-broll
- template-only
- data-graphic

Decide like a smart editor:
- If a moving process/demo/repair/teardown/test matters, keep video and choose youtube/reddit.
- If a static exact reference matters, choose image + web-image.
- If the visual is generic but concrete (hands, tools, repair, assembly, cooking, workbench, factory, store, lab), choose video + stock.
- Avoid mood/generic texture/environment stock unless the narration explicitly needs a breathing-room or establishing shot.
- If the keyword is abstract, rewrite it to the concrete visible thing the camera/search should find.
- Queries name what the CAMERA SAW (subject + action + setting), never the packaging or distribution form of the content. Asking for a media product (a show, coverage, a report, a review, a compilation) returns branded, bannered, presenter-wrapped clips that fail vision. The need for "real-event texture" is met by naming the event's visible elements — never by asking for the news product itself.

Return exactly one line per listed scene:
SCENE <n>: decision: KEEP|CHANGE | mediaNeed: <value> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image|reddit> | keyword: <3-7 word search query or none> | stockQuery: <stock query or none> | webQuery: <web/youtube query or none> | sourceReason: <short reason, no pipe characters>

SCENES:
${sceneRows}`;

    try {
        const maxTokens = Math.min(2800, 700 + candidates.length * 130);
        const useBedrock = !!(process.env.BEDROCK_ACCESS_KEY_ID && process.env.BEDROCK_SECRET_ACCESS_KEY);
        const raw = await callAI(prompt, { maxTokens, taskType: 'planner-source-audit', ...(useBedrock ? { provider: 'bedrock' } : {}) });
        if (!raw) return [];
        console.log(`   [Source Auditor IO] scenes=${candidates.length} promptChars=${prompt.length} maxTokens=${maxTokens} responseChars=${String(raw).length}`);

        const lineByIndex = new Map();
        for (const line of String(raw).split(/\r?\n/)) {
            const match = line.match(/^\s*SCENE\s+(\d+)\s*:\s*(.+)$/i);
            if (!match) continue;
            lineByIndex.set(parseInt(match[1], 10), match[2]);
        }

        const fixes = [];
        for (const { scene } of candidates) {
            const body = lineByIndex.get(scene.index);
            if (!body) continue;
            const result = _applySourceAuditResult(scene, body);
            if (result?.changed) {
                fixes.push({ index: scene.index, ...result });
            }
        }
        return fixes;
    } catch (err) {
        console.log(`   [Source Auditor] skipped after error: ${err.message}`);
        return [];
    }
}

function _restoreFootageLaneAfterDisplayStrip(scene, scenes, scriptContext = {}, plannerDirectives = null, globalOutline = null) {
    const nicheId = scriptContext.nicheId || 'general';
    const editorKeyword =
        scene._editorIntent?.footageKeyword ||
        _pickEditorFootageKeyword(scene, scenes, scriptContext, globalOutline);
    const keyword =
        editorKeyword ||
        scene.templateBgQuery ||
        scene.visualIntent ||
        _pickConcreteFootageKeywordFromText(scene.text || '') ||
        extractFallbackKeyword(scene.text || '', scene, scriptContext);

    scene.templateHint = null;
    scene.templateBgQuery = null;

    if (!scene.keyword || scene.keyword === 'none' || _isWeakFootageKeyword(scene.keyword)) {
        scene.keyword = keyword;
    }
    scene.mediaType = scene.mediaType || 'video';
    scene.sourceHint = scene.sourceHint || _pickPreferredVideoSource(nicheId, plannerDirectives, 'youtube');
    scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword);
    scene.webQuery = scene.webQuery || _autoWebQuery(scene.keyword, scene.sourceHint);
    _normalizeProtectedTerms(scene, scriptContext);
}

function _enforceDisplayTextPlacement(scenes, scriptContext = {}, plannerDirectives = null, globalOutline = null) {
    const fixes = [];
    if (!Array.isArray(scenes)) return fixes;

    for (const scene of scenes) {
        if (!scene) continue;

        if (scene.templateHint && !scene.fullscreenMG) {
            const reason = validateTemplateHintPlacement(scene, scenes, scriptContext);
            if (reason) {
                const before = scene.templateHint;
                _restoreFootageLaneAfterDisplayStrip(scene, scenes, scriptContext, plannerDirectives, globalOutline);
                fixes.push({
                    index: scene.index,
                    field: 'templateHint',
                    before,
                    after: scene.keyword || 'footage',
                    reason,
                });
            }
        }

        if (scene.mgHint && !scene.fullscreenMG) {
            const reason = validateOverlayHintPlacement(scene, scenes);
            if (reason) {
                const before = scene.mgHint;
                scene.mgHint = null;
                fixes.push({
                    index: scene.index,
                    field: 'mgHint',
                    before,
                    after: 'none',
                    reason,
                });
            }
        }
    }

    return fixes;
}

function _coerceTemplateOnlyMgHint(scene, scriptContext = {}) {
    if (!scene?.mgHint || scene.fullscreenMG) return null;
    const rawType = String(scene.mgHint).split(':')[0].trim();
    if (!_TEMPLATE_ONLY_MG_HINT_TYPES.has(rawType)) return null;

    const content = String(scene.mgHint).split(':').slice(1).join(':').trim() ||
        String(scene.text || '').split(/[.!?]/)[0].trim().slice(0, 90);
    const before = scene.mgHint;
    scene.templateHint = `${rawType}: ${content}`;
    scene.mgHint = null;
    _applyTemplateBackgroundLane(scene, scriptContext);
    return { before, after: scene.templateHint };
}

function _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function _getScenePhase(scene, scriptContext = {}) {
    const hookEnd = parseFloat(scriptContext.hookEndTime);
    const ctaStart = parseFloat(scriptContext.ctaStartTime);
    if (!Number.isNaN(hookEnd) && (scene.startTime || 0) < hookEnd) return 'hook';
    if (scriptContext.ctaDetected && !Number.isNaN(ctaStart) && (scene.startTime || 0) >= ctaStart) return 'cta';
    return 'body';
}
// Known template + fullscreenMG type names, matched flexibly
// (both camelCase and "two word" spellings).
const _TEMPLATE_TYPE_ALIASES = {
    statCard:        [/\bstat[\s-]*cards?\b/],
    factCard:        [/\bfact[\s-]*cards?\b/],
    personIntro:     [/\bperson[\s-]*intro(?:duction)?s?\b/, /\bperson card\b/],
    locationCard:    [/\blocation[\s-]*cards?\b/, /\bplace cards?\b/],
    chapterCard:     [/\bchapter[\s-]*cards?\b/, /\bsection cards?\b/],
    quoteCard:       [/\bquote[\s-]*cards?\b/],
    keyTakeaway:     [/\bkey[\s-]*takeaways?\b/, /\btakeaway cards?\b/],
    comparisonCard:  [/\bcomparison[\s-]*cards?\b/, /\bvs(?:\.|\s)*cards?\b/],
    timelineCard:    [/\btimeline[\s-]*cards?\b/],
    imageShowcase:   [/\bimage[\s-]*showcase\b/, /\bphoto[\s-]*collage\b/, /\bpicture[\s-]*grid\b/],
    splitScreen:     [/\bsplit[\s-]*screens?\b/, /\bside[\s-]*by[\s-]*sides?\b/],
    infographic:     [/\binfographics?\b/],
};
const _FULLSCREEN_TYPE_ALIASES = {
    mapChart:        [/\bmap[\s-]*charts?\b/, /\broute[\s-]*maps?\b/, /\btrade[\s-]*route[\s-]*maps?\b/, /\bshipping[\s-]*route[\s-]*maps?\b/, /\blocator[\s-]*maps?\b/],
    barChart:        [/\bbar[\s-]*charts?\b/],
    donutChart:      [/\bdonut[\s-]*charts?\b/, /\bpie[\s-]*charts?\b/],
    timeline:        [/\btimeline\b/],
    bulletList:      [/\bbullet[\s-]*lists?\b/],
    rankingList:     [/\branking[\s-]*lists?\b/, /\btop[\s-]*\d+[\s-]*lists?\b/],
    comparisonCard:  [/\bcomparison[\s-]*cards?\b/],
    kineticText:     [/\bkinetic[\s-]*texts?\b/],
    articleHighlight:[/\barticle[\s-]*highlights?\b/, /\bheadline[\s-]*cards?\b/],
};

const _TEMPLATE_ONLY_MG_HINT_TYPES = new Set([
    'chapterCard',
    'locationCard',
    'quoteCard',
    'keyTakeaway',
    'comparisonCard',
    'timelineCard',
    'factCard',
    'imageShowcase',
    'statCard',
    'personIntro',
    'splitScreen',
    'infographic',
]);

// Canonical set of MG types that can occupy the fullscreenMG slot.
// Sourced from ai-motion-graphics.FULLSCREEN_MG_TYPES — duplicated as a literal
// here to avoid a require cycle with ai-motion-graphics.js (which loads VP).
// Every other MG type (focusWord, headline, callout, statCounter, lowerThird,
// dataBar, percentageCircle, typographyReveal, kineticText, broadcastLogo,
// progressBar, etc.) is OVERLAY-ONLY and must live in
// scene.mgHint paired with a background lane (footage or templateHint),
// never in scene.fullscreenMG.
const _FULLSCREEN_ELIGIBLE_MGS = new Set([
    'barChart', 'donutChart', 'rankingList', 'timeline',
    'comparisonCard', 'bulletList', 'mapChart'
]);

function _isFullscreenEligibleMG(type) {
    if (!type) return false;
    return _FULLSCREEN_ELIGIBLE_MGS.has(String(type).trim());
}

function _filterFullscreenEligible(types) {
    if (!Array.isArray(types)) return [];
    return types.filter(_isFullscreenEligibleMG);
}

function _filterOverlayOnly(types) {
    if (!Array.isArray(types)) return [];
    return types.filter(t => t && !_isFullscreenEligibleMG(t) && !_TEMPLATE_ONLY_MG_HINT_TYPES.has(String(t).trim()));
}

function _parseVisualInstructionPrefs(rawInstructions = '') {
    const raw = String(rawInstructions || '').trim();
    const lower = raw.toLowerCase();
    const prefs = {
        raw,
        hasUserDirectives: raw.length > 0,
        avoidStock: /\b(?:no|avoid|without|don't use|dont use)\s+(?:any\s+)?stock\b/.test(lower),
        preferRealFootage: /\b(?:real|raw|authentic)\s+(?:footage|video|clips?)\b/.test(lower) || /\bprefer real footage\b/.test(lower),
        preferMaps: /\b(?:use|prefer|more)\s+maps?\b/.test(lower) || /\bmap animation\b/.test(lower) || /\b(?:map[\s-]*charts?|route[\s-]*maps?|trade[\s-]*route[\s-]*maps?|shipping[\s-]*route[\s-]*maps?|locator[\s-]*maps?)\b/.test(lower),
        preferTemplates: /\b(?:use|prefer|more)\s+(?:templates?|infographics?|cards?)\b/.test(lower) || /\buse more templates?\b/.test(lower),
        preferGraphics: /\b(?:use|prefer|more)\s+(?:graphics|motion graphics|mgs?|overlays)\b/.test(lower),
        forceNumericLowerThird:
            /\b(?:all|every|each)\s+(?:number|numbers|numeric value|numeric values|stat|stats|statistic|statistics)\b.{0,48}\blower[\s-]?thirds?\b/.test(lower)
            || /\blower[\s-]?thirds?\b.{0,48}\b(?:all|every|each)\s+(?:number|numbers|numeric value|numeric values|stat|stats|statistic|statistics)\b/.test(lower),
        minimizeGraphics: /\b(?:no|avoid|less|fewer|minimal)\s+(?:graphics|motion graphics|mgs?|overlays)\b/.test(lower),
        avoidFullscreenMG: /\b(?:no|avoid|less|fewer|minimal|minimize)\s+(?:fullscreen|full-?screen|full screen)(?:\s+(?:graphics|mgs?))?\b/.test(lower),
        preferImages: /\b(?:use|prefer|more)\s+(?:images|photos|stills)\b/.test(lower),
        preferVideos: /\b(?:use|prefer|more)\s+(?:video|videos|footage|clips)\b/.test(lower),
        preferFloating: /\b(?:use|prefer|more)\s+floating\b/.test(lower),
        preferCinematic: /\b(?:use|prefer|more)\s+cinematic\b/.test(lower),
        preferFullscreen: /\b(?:use|prefer|mostly)\s+fullscreen\b/.test(lower),
        requestedTemplateTypes: new Set(),
        requestedFullscreenTypes: new Set(),
        bannedSources: new Set(),
        preferredSources: [],
    };

    // Detect explicit type names the user wrote in instructions — AI still chooses
    // WHERE to apply them; we just surface the ask in the prompt.
    for (const [type, patterns] of Object.entries(_TEMPLATE_TYPE_ALIASES)) {
        if (patterns.some(re => re.test(lower))) prefs.requestedTemplateTypes.add(type);
    }
    for (const [type, patterns] of Object.entries(_FULLSCREEN_TYPE_ALIASES)) {
        if (patterns.some(re => re.test(lower))) prefs.requestedFullscreenTypes.add(type);
    }

    const sourcePatterns = [
        { source: 'stock', bans: [/\b(?:no|avoid|don't use|dont use)\s+stock\b/], prefers: [/\b(?:prefer|use|more)\s+stock\b/] },
        { source: 'youtube', bans: [/\b(?:no|avoid|don't use|dont use)\s+youtube\b/], prefers: [/\b(?:prefer|use|more)\s+youtube\b/] },
        { source: 'web-image', bans: [/\b(?:no|avoid|don't use|dont use)\s+(?:web[-\s]?images?|bing images?|bing)\b/], prefers: [/\b(?:prefer|use|more)\s+(?:web[-\s]?images?|bing images?|bing)\b/] },
        { source: 'reddit', bans: [/\b(?:no|avoid|don't use|dont use)\s+reddit\b/], prefers: [/\b(?:prefer|use|more)\s+reddit\b/] },
    ];

    for (const cfg of sourcePatterns) {
        if (cfg.bans.some(re => re.test(lower))) prefs.bannedSources.add(cfg.source);
        if (cfg.prefers.some(re => re.test(lower))) prefs.preferredSources.push(cfg.source);
    }

    prefs.preferredSources = [...new Set(prefs.preferredSources.map(src => _sanitizeVpSourceHint(src, 'youtube')).filter(Boolean))];
    prefs.preferredVideoRatio =
        prefs.preferVideos ? 0.78 :
        prefs.preferImages ? 0.35 :
        null;
    prefs.preferredFraming =
        prefs.preferFullscreen ? 'fullscreen' :
        prefs.preferFloating ? 'floating' :
        prefs.preferCinematic ? 'cinematic' :
        null;

    return prefs;
}

function _deriveStylePlannerPrefs(styleProfile) {
    if (!styleProfile || typeof styleProfile !== 'object') {
        return {
            hasStyleInfluence: false,
            targetVideoRatio: null,
            preferRealSources: false,
            mgDensity: null,
            preferredMGTypes: [],
            hookUsesMG: false,
            framingBias: null,
        };
    }

    const footage = styleProfile.footage || {};
    const motionGraphics = styleProfile.motionGraphics || {};
    const summaryText = [
        styleProfile.summary || '',
        ...(Array.isArray(styleProfile.systemNotes) ? styleProfile.systemNotes.map(n => `${n.observation || ''} ${n.gap || ''}`) : []),
    ].join(' ').toLowerCase();

    let framingBias = null;
    if (/\bfloating\b|\bframed\b|\bexhibit\b|\bphoto on\b/.test(summaryText)) {
        framingBias = 'floating';
    } else if (/\bcinematic\b|\bpulled back\b|\bletterbox\b/.test(summaryText)) {
        framingBias = 'cinematic';
    }

    const stockVsReal = String(footage.stockVsReal || '').toLowerCase();
    const targetVideoRatio = typeof footage.videoToImageRatio === 'number'
        ? _clamp(footage.videoToImageRatio, 0.2, 0.9)
        : null;

    return {
        hasStyleInfluence: true,
        targetVideoRatio,
        preferRealSources: stockVsReal.includes('real') || stockVsReal.includes('mixed'),
        mgDensity: (motionGraphics.density || '').toLowerCase() || null,
        preferredMGTypes: Array.isArray(motionGraphics.preferredTypes) ? motionGraphics.preferredTypes : [],
        hookUsesMG: !!styleProfile.hook?.usesMG,
        framingBias,
    };
}

// Overlay the compiled creator directives (scriptContext._directives) onto the
// regex-parsed prefs. The compiler is the richer source, so it WINS; the regex
// parse remains the mechanical floor (compiler off/absent → prefs unchanged).
// Also sets explicit "force" flags the niche-ban passes consult so the creator's
// order beats house rules (locked authority model: user wins on creative choices).
function _mergeCompiledDirectives(user, directives) {
    if (!user || !directives || typeof directives !== 'object') return user;
    const f = directives.footage || {};
    if (f.avoidStock) { user.avoidStock = true; user.bannedSources.add('stock'); }
    if (f.preferReal) user.preferRealFootage = true;
    if (f.preferImages) { user.preferImages = true; user.preferredVideoRatio = 0.35; }
    if (f.preferVideos) { user.preferVideos = true; user.preferredVideoRatio = 0.78; }
    for (const s of (Array.isArray(f.bannedSources) ? f.bannedSources : [])) user.bannedSources.add(s);
    if (Array.isArray(f.preferredSources) && f.preferredSources.length) {
        user.preferredSources = [...new Set([...user.preferredSources, ...f.preferredSources])];
    }
    const g = directives.graphics || {};
    if (g.moreTemplates) user.preferTemplates = true;
    if (g.fewerTemplates) user.minimizeTemplates = true;
    if (g.moreMGs) user.preferGraphics = true;
    if (g.fewerMGs) user.minimizeGraphics = true;
    if (g.numericTreatment === 'lowerThird') user.forceNumericLowerThird = true;
    if (Array.isArray(g.bannedTypes) && g.bannedTypes.length) {
        user.bannedMGTypes = new Set([...(user.bannedMGTypes || []), ...g.bannedTypes.map(t => String(t).trim()).filter(Boolean)]);
    }
    const fr = directives.framing || {};
    if (fr.force && ['fullscreen', 'floating', 'cinematic'].includes(fr.force)) {
        user.preferredFraming = fr.force;
        if (fr.force === 'fullscreen') user.preferFullscreen = true;
        else if (fr.force === 'floating') user.preferFloating = true;
        else if (fr.force === 'cinematic') user.preferCinematic = true;
    }
    const m = directives.maps || {};
    if (m.want === 'more') { user.preferMaps = true; user.forceMaps = true; }
    else if (m.want === 'none') { user.avoidMaps = true; user.preferMaps = false; }
    user.hasUserDirectives = true;
    return user;
}

function _buildPlannerDirectives(scenes, scriptContext, directorsBrief) {
    const user = _parseVisualInstructionPrefs(directorsBrief?.freeInstructions || '');
    _mergeCompiledDirectives(user, scriptContext?._directives || null);
    return {
        user,
        style: _deriveStylePlannerPrefs(scriptContext?.styleProfile || directorsBrief?.styleProfile || null),
        sceneCount: scenes.length,
    };
}

// Creator authority: did the user EXPLICITLY ask for maps? If so, the niche's
// mapChart ban must not strip them (their word beats the house rule).
function _userExplicitlyWantsMaps(plannerDirectives) {
    const u = plannerDirectives && plannerDirectives.user;
    return !!(u && (u.forceMaps || u.preferMaps));
}

function _countRegexMatches(text, patterns) {
    const lower = String(text || '').toLowerCase();
    return patterns.reduce((count, pattern) => count + (pattern.test(lower) ? 1 : 0), 0);
}

function _knownGeoPlacesInText(text) {
    const raw = String(text || '');
    const known = [
        ['Strait of Hormuz', /\bstrait\s+of\s+hormuz\b/i],
        ['Persian Gulf', /\bpersian\s+gulf\b/i],
        ['Red Sea', /\bred\s+sea\b/i],
        ['Suez Canal', /\bsuez\s+canal\b/i],
        ['Bab el-Mandeb', /\bbab[-\s]?el[-\s]?mandeb\b/i],
        ['Gulf of Aden', /\bgulf\s+of\s+aden\b/i],
        ['Arabian Sea', /\barabian\s+sea\b/i],
    ];
    return known.filter(([, rx]) => rx.test(raw)).map(([name]) => name);
}

function _deriveSceneSignals(scene, scenes, scriptContext) {
    const text = String(scene.text || '');
    const lower = text.toLowerCase();
    const entities = scriptContext?.entities || [];
    const entityTypes = scriptContext?.entityTypes || {};
    const matchedEntities = entities.filter(e => lower.includes(e.toLowerCase()));
    const placeTypes = new Set(['place', 'location', 'country', 'city', 'region', 'waterbody']);
    const people = matchedEntities.filter(e => entityTypes[e.toLowerCase()] === 'person');
    const entityPlaces = matchedEntities.filter(e => {
        const type = entityTypes[e.toLowerCase()];
        return !type || placeTypes.has(type);
    });
    const places = [...new Set([...entityPlaces, ..._knownGeoPlacesInText(text)])];
    const numericTokens = text.match(/\b(?:\$?\d+(?:\.\d+)?%?|\d{4})\b/g) || [];
    const geoTerms = [
        /\bstrait\b/, /\bgulf\b/, /\bsea\b/, /\bocean\b/, /\broute\b/, /\bcorridor\b/,
        /\bshipping\b/, /\btrade\b/, /\bpipeline\b/, /\bport\b/, /\bterminal\b/,
        /\bharbor\b/, /\bcanal\b/, /\bborder\b/, /\bchokepoint\b/,
    ];
    const geoTermCount = _countRegexMatches(lower, geoTerms);
    const mapCandidate = places.length >= 2 || (places.length >= 1 && geoTermCount >= 1) || geoTermCount >= 2;
    const hasQuote = /["“”]/.test(text) || /\bquote\b|\bsaid\b/.test(lower);
    const likelyAction = /\b(attack|strike|launch|sail|drive|march|fire|moving|tour|training|operation|meeting|speeches?|protests?|election|vote|summit|review|walkthrough)\b/.test(lower);
    const likelyDataImage = numericTokens.length > 0 || /\b(percent|rate|chart|graph|data|ranking|budget|stat)\b/.test(lower);
    const isAbstractMood = !likelyAction && !likelyDataImage && people.length === 0 && places.length === 0 &&
        /\b(sunset|storm|rain|night|crowd|city|smoke|cloud|ocean|aerial|abstract|mood)\b/.test(lower);
    const firstPersonIntro = people.find(person => {
        return !scenes.some(other => {
            if ((other.index || 0) >= (scene.index || 0)) return false;
            return String(other.text || '').toLowerCase().includes(person.toLowerCase());
        });
    }) || null;

    return {
        phase: _getScenePhase(scene, scriptContext),
        matchedEntities,
        people,
        places,
        primaryPerson: people[0] || null,
        firstPersonIntro,
        numericTokens,
        hasNumeric: numericTokens.length > 0,
        hasQuote,
        hasMapCandidate: mapCandidate,
        likelyAction,
        likelyDataImage,
        isAbstractMood,
    };
}

const _CONTEXT_DEPENDENT_SCENE_RE = /\b(exactly what|what we're beginning|because while|while the|meanwhile|however|but that|but this|this is|that is|that's why|this has|that has|to understand|another|the other|it defines|it means|they are|these are)\b/i;
const _GENERIC_CONTEXT_KEYWORD_RE = /\b(global city|city skyline|night traffic|world watches|stormy ocean|ocean waves|abstract|background|generic|city lights|business district|busy street|people walking)\b/i;
const _LOCAL_TOPIC_RE = /\b(choke ?point|chokepoint|strait|gateway|route|shipping|maritime|trade|container|cargo|vessel|ship|ships|traffic|canal|sea|gulf|port|oil|tanker|blockade|supply chain|logistics|security)\b/i;
const _KEYWORD_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'under', 'that', 'this',
    'these', 'those', 'their', 'there', 'where', 'when', 'what', 'which', 'while', 'about',
    'around', 'nearly', 'still', 'just', 'scene', 'footage', 'video', 'view', 'shot'
]);

function _sceneWindow(scene, scenes, radius = 1) {
    if (!Array.isArray(scenes) || scenes.length === 0) return [scene].filter(Boolean);
    const sorted = [...scenes].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const pos = sorted.findIndex(s => s === scene || s.index === scene.index);
    if (pos < 0) return [scene].filter(Boolean);
    return sorted.slice(Math.max(0, pos - radius), Math.min(sorted.length, pos + radius + 1));
}

function _normalizeAnchorKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function _hasKeywordAnchor(keyword, anchor) {
    const kw = _normalizeAnchorKey(keyword);
    const a = _normalizeAnchorKey(anchor);
    if (!kw || !a) return false;
    if (kw.includes(a)) return true;
    const anchorWords = a.split(/\s+/).filter(w => w.length > 2 && !_KEYWORD_STOPWORDS.has(w));
    if (anchorWords.length === 0) return false;
    return anchorWords.some(w => kw.includes(w));
}

function _compactKeywordParts(parts, maxWords = 7) {
    const seen = new Set();
    return parts.join(' ')
        .replace(/[^a-zA-Z0-9\s-]/g, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(Boolean)
        .filter(w => {
            const key = w.toLowerCase();
            if (_KEYWORD_STOPWORDS.has(key)) return false;
            if (key.length < 3 && !/^\d+$/.test(key) && !['el', 'al', 'uk', 'us'].includes(key)) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, maxWords)
        .join(' ');
}

function _extractMapPayloadAnchors(value) {
    const raw = String(value || '');
    if (!/^mapchart\s*:/i.test(raw)) return [];
    const payload = raw
        .replace(/^mapchart\s*:/i, '')
        .replace(/\b(label|marker|pin|locator|regionHighlight|comparison)\b/gi, ' ')
        .replace(/\broute\b/gi, ' route ');
    const chunks = payload
        .split(/\s*,\s*|\s+->\s+|\s+ to \s+/i)
        .map(x => x.replace(/[:;|]/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(x => x.length >= 3);
    return [...new Set(chunks.map(_canonicalGeoAnchor))].slice(0, 4);
}

function _canonicalGeoAnchor(value) {
    return String(value || '')
        .replace(/\bBab\s+el\s+Mandeb\b/ig, 'Bab el-Mandeb')
        .replace(/\bBab-El-Mandeb\b/ig, 'Bab el-Mandeb')
        .replace(/\s+/g, ' ')
        .trim();
}

function _contextTextForSceneWindow(windowScenes, excludeKeywordForIndex = null) {
    return windowScenes.map(s => [
        s?.text,
        s?.index === excludeKeywordForIndex ? null : s?.keyword,
        s?.visualIntent,
        s?.fullscreenMG,
        s?.templateHint,
        s?.templateBgQuery,
    ].filter(Boolean).join(' ')).join(' ');
}

function _isContextDependentFootageScene(scene) {
    if (!scene || scene.fullscreenMG || scene.templateHint) return false;
    if (scene.sceneClass === 'transition-bridge') return true;
    const text = String(scene.text || '');
    if (_CONTEXT_DEPENDENT_SCENE_RE.test(text)) return true;
    const low = text.trim().toLowerCase();
    return /^(this|that|these|those|it|they|but|because|while|meanwhile)\b/.test(low);
}

function _deriveContextualKeywordCandidate(scene, scenes, scriptContext = {}) {
    const windowScenes = _sceneWindow(scene, scenes, 1);
    const contextText = _contextTextForSceneWindow(windowScenes, scene.index);
    const contextLower = contextText.toLowerCase();
    if (!_LOCAL_TOPIC_RE.test(contextLower)) return null;

    const mapAnchors = [];
    for (const s of windowScenes) {
        mapAnchors.push(..._extractMapPayloadAnchors(s.fullscreenMG));
        if (s._mapBlockedBy) mapAnchors.push(..._extractMapPayloadAnchors(s._mapBlockedBy));
    }

    const entities = scriptContext.entities || [];
    const entityTypes = scriptContext.entityTypes || {};
    const placeTypes = new Set(['place', 'location', 'country', 'city', 'region', 'waterbody']);
    const localPlaces = entities
        .filter(e => contextLower.includes(String(e).toLowerCase()))
        .filter(e => {
            const t = entityTypes[String(e).toLowerCase()];
            return !t || placeTypes.has(t);
        });

    const regexPlaces = [];
    if (/\bbab[-\s]?el[-\s]?mandeb\b/i.test(contextText)) regexPlaces.push('Bab el-Mandeb');
    if (/\bred sea\b/i.test(contextText)) regexPlaces.push('Red Sea');
    if (/\bsuez canal\b/i.test(contextText)) regexPlaces.push('Suez Canal');
    if (/\bstrait of hormuz\b/i.test(contextText)) regexPlaces.push('Strait of Hormuz');

    const anchors = [...new Set([...mapAnchors, ...localPlaces, ...regexPlaces].map(_canonicalGeoAnchor))]
        .filter(a => a && !/^(route|label)$/i.test(a))
        .slice(0, 3);

    const topics = [];
    if (/\b(choke ?point|chokepoint|strait|gateway)\b/i.test(contextText)) topics.push('shipping chokepoint');
    if (/\bshipping|ship|ships|vessel|maritime|route|canal\b/i.test(contextText)) topics.push('shipping route');
    if (/\bglobal trade|trade|container|cargo|logistics|supply chain\b/i.test(contextText)) topics.push('trade route');
    if (/\boil|tanker|barrel\b/i.test(contextText)) topics.push('oil tanker');
    if (/\bblockade|attack|threat|security|military|naval\b/i.test(contextText)) topics.push('maritime security');

    const selectedTopics = [...new Set(topics)].slice(0, anchors.length > 0 ? 1 : 2);
    if (anchors.length > 0) {
        return _compactKeywordParts([...anchors.slice(0, 2), ...selectedTopics], 7);
    }
    if (selectedTopics.length > 0) {
        return _compactKeywordParts(['global', ...selectedTopics, 'disruption'], 6);
    }
    return null;
}

function _keywordDriftsFromLocalContext(scene, scenes, scriptContext = {}) {
    const keyword = String(scene?.keyword || '');
    if (!keyword) return false;
    const windowScenes = _sceneWindow(scene, scenes, 1);
    const contextText = _contextTextForSceneWindow(windowScenes, scene.index);
    const contextLower = contextText.toLowerCase();
    const entities = scriptContext.entities || [];

    for (const entity of entities) {
        const e = String(entity || '').trim();
        if (e.length < 3) continue;
        const eLower = e.toLowerCase();
        if (!keyword.toLowerCase().includes(eLower)) continue;
        if (!contextLower.includes(eLower)) return true;
    }
    return false;
}

function repairContextualKeywords(scenes, scriptContext = {}) {
    if (!Array.isArray(scenes)) return [];
    const fixes = [];
    for (const scene of scenes) {
        if (!_isContextDependentFootageScene(scene)) continue;
        const candidate = _deriveContextualKeywordCandidate(scene, scenes, scriptContext);
        if (!candidate) continue;

        const keyword = String(scene.keyword || '');
        const windowScenes = _sceneWindow(scene, scenes, 1);
        const localContext = _contextTextForSceneWindow(windowScenes, scene.index);
        const contextHasCandidateAnchor = _hasKeywordAnchor(localContext, candidate);
        if (!contextHasCandidateAnchor) continue;

        const generic = _GENERIC_CONTEXT_KEYWORD_RE.test(keyword);
        const drift = _keywordDriftsFromLocalContext(scene, scenes, scriptContext);
        const lacksAnchor = candidate && !_hasKeywordAnchor(keyword, candidate);
        if (!generic && !drift && !lacksAnchor) continue;

        const before = scene.keyword || null;
        scene._contextualKeywordAnchor = candidate;
        scene.keyword = candidate;
        scene.stockQuery = _autoStockQuery(candidate);
        scene.webQuery = _autoWebQuery(candidate, scene.sourceHint);
        if (!scene.mediaType) scene.mediaType = 'video';
        if (!scene.sourceHint) {
            scene.sourceHint = _pickPreferredVideoSource(scriptContext.nicheId || 'general', { user: { preferredSources: [] } }, 'youtube');
        }
        fixes.push({
            index: scene.index,
            before,
            after: candidate,
            reason: drift ? 'external entity drift' : (generic ? 'generic bridge keyword' : 'missing local anchor')
        });
    }
    return fixes;
}

function _sceneTagString(scene, scenes, scriptContext) {
    const signals = _deriveSceneSignals(scene, scenes, scriptContext);
    const tags = [signals.phase.toUpperCase()];
    if (signals.hasNumeric) tags.push('STAT');
    if (signals.hasMapCandidate) tags.push('GEO');
    if (signals.firstPersonIntro) tags.push('PERSON-INTRO');
    if (signals.hasQuote) tags.push('QUOTE');
    return tags.join(', ');
}

// Deterministic scene-role classifier. Returns a primary editorial role plus
// hard structural flags the planner prompt can show as CONSTRAINTS — so the
// AI doesn't have to re-derive them and we don't have to fix bad lane picks
// downstream. Logic only uses already-derived signals + niche/mapPolicy +
// scene class — no extra AI cost.
const _NEWS_ACTOR_RE = /\b(iran|russia|houthi|hamas|idf|nato|ukraine|israel|china|north korea|hezbollah|taliban|isis|kremlin|pentagon|cia|fbi|saudi|riyadh|tehran|moscow|beijing|kyiv|gaza|west bank)\b/i;
const _NEWS_VERB_RE  = /\b(navy|forces|strike|patrol|attack|invasion|missile|drone|blockade|sanctions?|airstrike|offensive|deploy|launches?|launch(?:ed|ing)?|deploy(?:ed|ing|ment)?|fired|incursion|ceasefire|treaty|summit)\b/i;
const _ROUTE_RE      = /\b(route|corridor|pipeline|shipping|trade|strait|canal|advance|march|movement|expansion|invasion path|push toward|drove from|sailed from|traveled from|from\s+\w+\s+to\s+\w+)\b/i;
const _REGION_RE     = /\b(region|territory|empire|throughout|across the|all over|continent|peninsula|eastern|western|northern|southern)\b/i;
const _COMPARISON_RE = /\b(versus|vs\.?|compared to|side by side|contrast|in contrast|while .* by contrast)\b/i;
const _PRODUCT_DEMO_RE = /\b(launch|unveil|release|reveal|demo|new model|ces|keynote|reveal event|showcase)\b/i;

function _deriveSceneRoles(scene, signals, scriptContext, niche, mapPolicy, plannerDirectives = null) {
    const text = String(scene.text || '');
    const lower = text.toLowerCase();
    const allowedMGs = (niche && Array.isArray(niche.allowedMGs)) ? niche.allowedMGs : [];
    const nicheAllowsMap = allowedMGs.includes('mapChart');
    const nicheAllowsTimeline = allowedMGs.includes('timeline');
    const nicheAllowsBars = allowedMGs.includes('barChart') || allowedMGs.includes('donutChart') || allowedMGs.includes('rankingList');
    const nicheAllowsStatOverlay = allowedMGs.includes('statCounter');
    const nicheAllowsAnyStat = nicheAllowsBars || nicheAllowsStatOverlay;
    const nicheAllowsTypography = allowedMGs.includes('focusWord') || allowedMGs.includes('kineticText');
    const isNewsActor = _NEWS_ACTOR_RE.test(lower) && _NEWS_VERB_RE.test(lower);
    const phase = signals.phase;

    // Map mode resolution (only meaningful when hasMapCandidate)
    let mapMode = null;
    if (signals.hasMapCandidate) {
        if (_COMPARISON_RE.test(lower) && signals.places.length >= 2) {
            mapMode = 'comparison';
        } else if (_ROUTE_RE.test(lower) && signals.places.length >= 1) {
            mapMode = 'route';
        } else if (_REGION_RE.test(lower) || (signals.places.length === 1 && /\b(across|through|within|inside)\b/.test(lower))) {
            mapMode = 'region';
        } else {
            mapMode = 'locator';
        }
        if (mapPolicy && Array.isArray(mapPolicy.preferredModes) && mapPolicy.preferredModes.length > 0) {
            // Tie-break ambiguous → niche's preferred mode
            const ambiguous = (mapMode === 'locator' && signals.places.length >= 2 && !_ROUTE_RE.test(lower) && !_COMPARISON_RE.test(lower));
            if (ambiguous) mapMode = mapPolicy.preferredModes[0];
        }
    }

    // Hard map flags. Hook + CTA scenes always block fullscreen map graphics —
    // hooks need real grabby visuals, CTAs need closing footage. Niche allowlist
    // also gates this. mapAllowed and mapForbidden must stay mutually exclusive.
    const rawUserInstructions = String(plannerDirectives?.user?.raw || '');
    const explicitHookMap = !!(
        plannerDirectives?.user?.preferMaps &&
        /\b(?:first|opening|hook|intro)\b/i.test(rawUserInstructions) &&
        (scene.index === 0 || (scene.startTime || 0) <= 1.5) &&
        signals.hasMapCandidate &&
        !signals.primaryPerson
    );
    const mapForbidden = !nicheAllowsMap || phase === 'cta' || (phase === 'hook' && !explicitHookMap);
    const mapAllowed = signals.hasMapCandidate && !mapForbidden;
    const mapPreferred = mapAllowed && (
        signals.places.length >= 2 ||
        _ROUTE_RE.test(lower) ||
        (isNewsActor && signals.places.length >= 1)
    );

    // Class block of map: scene class may explicitly block 'map'
    const classBlocked = new Set(scene.treatmentHint?.blocked || []);
    const mapBlockedByClass = classBlocked.has('map');

    const specificReference = !!(_looksLikeSpecificReference(scene, scriptContext) || signals.firstPersonIntro || signals.primaryPerson);
    const specificMovingFootage = _looksLikeRealMovingFootage(scene, scriptContext);
    const dataReference = signals.likelyDataImage && !signals.hasMapCandidate && !signals.likelyAction;

    // Stock appropriateness
    const stockInappropriate = (
        isNewsActor ||
        (signals.primaryPerson != null) ||
        specificReference ||
        specificMovingFootage ||
        signals.hasMapCandidate ||
        (niche?.id?.startsWith?.('news')) ||
        (signals.hasNumeric && signals.likelyDataImage)
    ) && !signals.isAbstractMood;

    // Fullscreen MG framing
    const fullscreenAllowed = (phase !== 'hook' && phase !== 'cta') || explicitHookMap;
    const fullscreenDiscouraged = phase === 'cta' || (phase === 'hook' && !explicitHookMap) || (signals.likelyAction && !signals.hasNumeric);

    // Allowed MG families this scene can SUPPORT (not what to USE — what is editorial-fit)
    const allowedMGFamilies = [];
    if (mapAllowed && !mapBlockedByClass) allowedMGFamilies.push('map');
    if (signals.hasNumeric && nicheAllowsAnyStat) allowedMGFamilies.push('data');
    if (signals.hasQuote) allowedMGFamilies.push('callout');
    if (signals.firstPersonIntro) allowedMGFamilies.push('intro');
    if (signals.isAbstractMood && nicheAllowsTypography && phase !== 'hook' && phase !== 'cta') allowedMGFamilies.push('typography');
    if (allowedMGFamilies.length === 0 && fullscreenAllowed) allowedMGFamilies.push('overlay-only');

    // Preferred source family
    let preferredSourceFamily = null;
    let preferredSourceHint = null;
    const preferredVideoSource = _pickPreferredVideoSource(niche?.id || scriptContext?.nicheId || 'general', plannerDirectives || { user: {} }, 'youtube');

    if (signals.hasMapCandidate && mapAllowed) preferredSourceFamily = 'mapChart';
    else if (specificReference) preferredSourceFamily = 'web-image-reference';
    else if (dataReference) preferredSourceFamily = 'data-graphics-or-web-image';
    else if (isNewsActor || signals.likelyAction || specificMovingFootage) preferredSourceFamily = 'real-footage';
    else if (signals.isAbstractMood) preferredSourceFamily = 'stock-mood';

    if (specificReference || dataReference) preferredSourceHint = 'web-image';
    else if (isNewsActor || signals.likelyAction || specificMovingFootage) preferredSourceHint = preferredVideoSource;
    else if (signals.isAbstractMood) preferredSourceHint = 'stock';

    // Primary role
    let role = 'generic';
    if (mapPreferred && !mapBlockedByClass) {
        if (mapMode === 'route') role = 'geo-route';
        else if (mapMode === 'region') role = 'geo-region';
        else if (mapMode === 'comparison') role = 'geo-compare';
        else role = 'geo-establish';
    } else if (signals.firstPersonIntro) {
        role = 'person-intro';
    } else if (signals.hasQuote) {
        role = 'quote-beat';
    } else if (signals.hasNumeric && signals.numericTokens.length >= 2) {
        role = 'stat-beat';
    } else if (isNewsActor) {
        role = 'escalation-news';
    } else if (_PRODUCT_DEMO_RE.test(lower) && (niche?.id?.startsWith?.('news.tech') || niche?.id?.startsWith?.('explainer.tech'))) {
        role = 'product-demo';
    } else if (signals.isAbstractMood) {
        role = 'abstract-breathing-room';
    } else if (!signals.likelyAction && !signals.likelyDataImage && !signals.hasMapCandidate && signals.matchedEntities.length === 0) {
        role = 'concept-explainer';
    }

    return {
        role,
        mapMode,
        mapAllowed: mapAllowed && !mapBlockedByClass,
        mapForbidden: mapForbidden || mapBlockedByClass,
        mapPreferred: mapPreferred && !mapBlockedByClass,
        fullscreenAllowed,
        fullscreenDiscouraged,
        stockInappropriate,
        preferredSourceFamily,
        preferredSourceHint,
        allowedMGFamilies,
        isNewsActor,
    };
}

function _renderSceneConstraintLine(scene, scenes, scriptContext, niche, mapPolicy, plannerDirectives = null, outlineHint = null) {
    const signals = _deriveSceneSignals(scene, scenes, scriptContext);
    const roles = _deriveSceneRoles(scene, signals, scriptContext, niche, mapPolicy, plannerDirectives);
    const parts = [`ROLE=${roles.role}`];
    // Talking-head: mark presenter beats. 'framed' = the host OWNS the beat (plan nothing).
    // 'split' = the host sits BESIDE B-roll (still plan normal footage for the B-roll half).
    // pip keeps its B-roll base → no token (planned normally).
    const presenterHold = _lookupPresenterHold(scene, scriptContext);
    if (presenterHold) {
        if (presenterHold.layout === 'framed') parts.push('PRESENTER=hold');
        else if (presenterHold.layout === 'split') parts.push('PRESENTER=split');
    }
    if (roles.mapForbidden) {
        parts.push('MAP=forbidden');
    } else if (roles.mapPreferred) {
        parts.push(`MAP=preferred:${roles.mapMode}`);
    } else if (roles.mapAllowed) {
        parts.push(`MAP=allowed:${roles.mapMode || 'locator'}`);
    } else {
        parts.push('MAP=n/a');
    }
    // BLOCKED=map — emitted when this scene's disposition is must_not_map AND
    // the narration actually had map intent (named place or spatial verb). This
    // tells the AI: "the scene wanted a map but the niche/class blocks it —
    // emit a real bgQuery for footage instead". Without this signal, AI can't
    // distinguish 'no map intent' from 'map wanted but blocked'.
    const disp = _lookupSceneDisposition(scene, scriptContext);
    if (disp && disp.disposition === 'must_not_map') {
        const sig = disp.signals || {};
        if (sig.placeCount > 0 || sig.spatialVerb) {
            parts.push('BLOCKED=map');
        }
    }
    parts.push(`FS-MG=${roles.fullscreenDiscouraged ? 'discouraged' : (roles.fullscreenAllowed ? 'allowed' : 'forbidden')}`);
    parts.push(`STOCK=${roles.stockInappropriate ? 'disallowed' : 'ok'}`);
    if (roles.preferredSourceHint) parts.push(`SOURCE-HINT=${roles.preferredSourceHint}`);
    const outlineSource = _sanitizeVpSourceHint(outlineHint?.source, '');
    if (outlineSource && VP_SOURCE_HINTS.includes(outlineSource)) parts.push(`OUTLINE-SOURCE=${outlineSource}`);
    if (roles.preferredSourceFamily) parts.push(`SRC=${roles.preferredSourceFamily}`);
    if (roles.allowedMGFamilies.length > 0) parts.push(`MG-FAMILIES=${roles.allowedMGFamilies.join('+')}`);
    return parts.join(' | ');
}

function _lookupSceneDisposition(scene, scriptContext) {
    const list = scriptContext?._mapDispositions;
    if (!Array.isArray(list)) return null;
    return list.find(d => d && d.sceneIndex === scene.index) || null;
}

// Talking-head: find the presenter HOLD (span) covering this scene, if any.
function _lookupPresenterHold(scene, scriptContext) {
    const list = scriptContext?._presenterDispositions;
    if (!Array.isArray(list)) return null;
    for (const d of list) {
        if (!d) continue;
        const s = d.startSceneIndex;
        const e = (d.endSceneIndex != null) ? d.endSceneIndex : s;
        if (scene.index >= s && scene.index <= e) return d;
    }
    return null;
}

function _getNicheAllowedMGs(nicheId) {
    try {
        const { getNiche } = require('../data/niches');
        const niche = getNiche(nicheId || 'general');
        return Array.isArray(niche?.allowedMGs) ? niche.allowedMGs : [];
    } catch (err) {
        return [];
    }
}

function _nicheAllowsMapChartById(nicheId) {
    const allowedMGs = _getNicheAllowedMGs(nicheId);
    if (allowedMGs.length === 0) return true;
    return allowedMGs.some(type => String(type).toLowerCase() === 'mapchart');
}

function _fullscreenMGType(value) {
    if (!value || typeof value !== 'string') return null;
    const raw = value.split(':')[0].trim();
    return raw || null;
}

function _isMapChartMG(value) {
    const type = _fullscreenMGType(value);
    return !!type && type.toLowerCase() === 'mapchart';
}

const _MAP_INTENT_RE = /\b(strait|gulf|sea|ocean|route|corridor|shipping|trade route|pipeline|port|terminal|harbor|canal|border|chokepoint|region|territory|country|countries|coast|coastline|from\s+[a-z][a-z\s-]{1,40}\s+to\s+[a-z][a-z\s-]{1,40})\b/i;

function _sceneHasMapIntent(scene, scenes, scriptContext) {
    if (!scene) return false;

    const contextScenes = Array.isArray(scenes) && scenes.length ? scenes : [scene];
    const signals = _deriveSceneSignals(scene, contextScenes, scriptContext);
    if (signals.hasMapCandidate) return true;

    const searchableText = [
        scene.text,
        scene.visualIntent,
        scene.fullscreenMG,
    ].filter(Boolean).join(' ');
    if (_MAP_INTENT_RE.test(searchableText)) return true;

    const payload = String(scene.fullscreenMG || '').split(':').slice(1).join(':').toLowerCase();
    const entities = scriptContext?.entities || [];
    const entityTypes = scriptContext?.entityTypes || {};
    const placeTypes = new Set(['place', 'location', 'country', 'city', 'region']);
    return entities.some(entity => {
        const key = String(entity || '').toLowerCase();
        return key && payload.includes(key) && placeTypes.has(entityTypes[key]);
    });
}

function _snapshotRawAIChoice(scene) {
    if (scene._aiChose) return;
    scene._aiChose = {
        templateHint: scene.templateHint ? String(scene.templateHint).split(':')[0].trim() : null,
        fullscreenMG: scene.fullscreenMG ? String(scene.fullscreenMG).split(':')[0].trim() : null,
        mgHint: scene.mgHint ? String(scene.mgHint).split(':')[0].trim() : null,
        sourceHint: scene.sourceHint || null,
        mediaType: scene.mediaType || null,
        mediaNeed: scene.mediaNeed || null,
        sourceReason: scene.sourceReason || null,
        framing: scene.framing || null,
    };
}

// scriptContext is a PARAMETER, not a closure variable. This is a module-level helper —
// every other extractFallbackKeyword call site sits inside a function that has
// scriptContext in scope, and this one silently did not, so the third fallback branch
// threw `ReferenceError: scriptContext is not defined` the moment the first two missed:
// a scene whose keyword is empty/weak, with no editor intent and no concrete keyword in
// its text. That is the ordinary case for a map scene in a niche that bans mapChart, so
// the niche map ban crashed Step 4 outright. Threaded through rather than defaulted to
// null so _subjectFallbackKeyword keeps its subject awareness.
function _restoreFootageAfterFullscreenDrop(scene, nicheId, plannerDirectives = null, scriptContext = null) {
    if (!scene.keyword || scene.keyword === 'none' || _isWeakFootageKeyword(scene.keyword)) {
        scene.keyword =
            scene._editorIntent?.footageKeyword ||
            _pickConcreteFootageKeywordFromText(scene.text || '') ||
            extractFallbackKeyword(scene.text || '', scene, scriptContext);
    }
    scene.mediaType = scene.mediaType || 'video';
    scene.sourceHint = scene.sourceHint || _pickPreferredVideoSource(nicheId || 'general', plannerDirectives, 'stock');
    scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword);
    scene.webQuery = scene.webQuery || _autoWebQuery(scene.keyword, scene.sourceHint);
    scene.visualIntent = scene.visualIntent || scene.keyword;
}

function _dropForbiddenMapChart(scene, nicheId, plannerDirectives = null, restoreFootage = false, scriptContext = null) {
    const fsType = _fullscreenMGType(scene.fullscreenMG);
    if (!fsType || !fsType.toLowerCase().startsWith('map')) return null;
    if (_nicheAllowsMapChartById(nicheId)) return null;
    // Creator authority: the user explicitly asked for maps → keep, even though
    // the niche bans mapChart by default (their order overrides the house rule).
    if (_userExplicitlyWantsMaps(plannerDirectives)) return null;

    const before = scene.fullscreenMG;
    scene.fullscreenMG = null;
    scene.mapVariant = null;
    scene._nicheMapDrop = { before, reason: `niche ${nicheId || 'general'} excludes mapChart` };
    if (restoreFootage) {
        _restoreFootageAfterFullscreenDrop(scene, nicheId, plannerDirectives, scriptContext);
    }
    return { index: scene.index, before, after: scene.keyword || 'footage fallback', reason: scene._nicheMapDrop.reason };
}

function _enforceNicheMapChartBan(scenes, nicheId, plannerDirectives = null, scriptContext = null) {
    if (_nicheAllowsMapChartById(nicheId)) return [];
    // Creator authority: an explicit "use maps" order beats the niche ban entirely.
    if (_userExplicitlyWantsMaps(plannerDirectives)) return [];
    const fixes = [];
    for (const scene of scenes || []) {
        const fix = _dropForbiddenMapChart(scene, nicheId, plannerDirectives, true, scriptContext);
        if (fix) fixes.push(fix);
    }
    return fixes;
}

function _getNicheAllowedTemplates(nicheId) {
    try {
        const { getNiche } = require('../data/niches');
        const niche = getNiche(nicheId || 'general');
        return Array.isArray(niche?.allowedTemplates) ? niche.allowedTemplates.slice() : null;
    } catch (err) {
        return null;
    }
}

/**
 * Niche-level templateHint ban. Step 6.5 (ai-templates.js) silently drops any
 * templateHint outside the niche's allowedTemplates, which leaves the scene
 * with no fallback keyword and a generic background. Run this pass at Step 4
 * so banned templates get converted to footage with proper keywords BEFORE the
 * download queue is built. Mirrors _enforceNicheMapChartBan.
 */
function _enforceNicheTemplateBan(scenes, scriptContext, plannerDirectives = null) {
    const nicheId = scriptContext?.nicheId || 'general';
    const requestedTypes = plannerDirectives?.user?.requestedTemplateTypes || null;
    const nicheAllowed = _getNicheAllowedTemplates(nicheId);
    if (!nicheAllowed || nicheAllowed.length === 0) return [];
    const allowSet = new Set(nicheAllowed);
    const fixes = [];
    for (const scene of scenes || []) {
        if (!scene || !scene.templateHint) continue;
        const tType = String(scene.templateHint).split(':')[0].trim();
        if (!tType) continue;
        // listicleGrid is rule-generated downstream — VP never picks it, and
        // niches that ban it still get it injected via the rule pass.
        if (tType === 'listicleGrid') continue;
        if (allowSet.has(tType)) continue;
        if (scene._editorIntent?.keepTemplateHintType === tType) continue;
        // Creator authority: the user explicitly named this template type → keep it,
        // even though the niche bans it by default (their order beats the house rule).
        if (requestedTypes && requestedTypes.has(tType)) continue;

        const before = scene.templateHint;
        const rest = String(scene.templateHint).split(':').slice(1).join(':').trim()
            || String(scene.text || '').slice(0, 80);
        const treatment = scene.treatmentHint || {};

        // Intersect class-level allowed templates with niche-level. If anything
        // remains, swap type; preserve the payload text.
        const classAllowed = Array.isArray(treatment.allowedTemplates) ? treatment.allowedTemplates : [];
        const intersection = classAllowed.length
            ? classAllowed.filter(t => allowSet.has(t))
            : nicheAllowed.filter(t => t !== 'listicleGrid');

        if (intersection.length > 0) {
            const replacement = intersection[0];
            scene.templateHint = `${replacement}: ${rest}`;
            fixes.push({
                index: scene.index,
                reason: `template "${tType}" banned for niche ${nicheId} -> swap`,
                before,
                after: scene.templateHint
            });
            continue;
        }

        // No niche-allowed template type available — convert scene to footage
        // so it gets a real keyword + sourceHint instead of inheriting the
        // template's generic background after Step 6.5 strips it.
        _coerceSceneToLane(scene, 'footage', treatment, scriptContext);
        fixes.push({
            index: scene.index,
            reason: `template "${tType}" banned for niche ${nicheId} -> footage`,
            before,
            after: `keyword=${scene.keyword || '(derived)'} source=${scene.sourceHint || 'stock'}`
        });
    }
    return fixes;
}

function _renderPlannerDirectiveBlock(plannerDirectives, scriptContext) {
    const lines = [];
    const { user, style } = plannerDirectives;
    const nicheAllowsMapChart = _nicheAllowsMapChartById(scriptContext?.nicheId || 'general');

    if (user.hasUserDirectives) {
        lines.push('VISUAL COMPLIANCE RULES (deterministic, must respect these):');
        if (user.avoidStock) lines.push('- Avoid stock unless the scene is pure abstract mood with no real entity/event.');
        if (user.preferRealFootage) lines.push('- Favor real footage sources over generic stock whenever the scene allows it.');
        if (user.preferMaps) {
            lines.push(nicheAllowsMapChart
                ? '- For geographic / route / chokepoint scenes, prefer maps or route visuals over generic footage.'
                : '- User asked for map/route visuals, but this niche forbids mapChart; use stock route references, real footage, templates, or overlays instead. Never output fullscreenMG=mapChart.');
        }
        if (user.preferredSources.length > 0) lines.push(`- Preferred sources when they fit: ${user.preferredSources.join(', ')}.`);
        if (user.bannedSources.size > 0) lines.push(`- Avoid these sources when alternatives exist: ${[...user.bannedSources].join(', ')}.`);
        if (user.preferredFraming) lines.push(`- Preferred framing bias: ${user.preferredFraming}.`);
        if (user.preferredVideoRatio != null) lines.push(`- Preferred media mix: ~${Math.round(user.preferredVideoRatio * 100)}% video / ${100 - Math.round(user.preferredVideoRatio * 100)}% image.`);
        if (user.preferGraphics || user.preferTemplates) lines.push('- Be more proactive about graphics/templates when the narration has numbers, quotes, or introductions.');
        if (user.minimizeGraphics) lines.push('- Keep motion graphics sparse unless the narration clearly needs one.');
        if (user.avoidFullscreenMG) lines.push('- User asked for FEWER fullscreen MGs. Prefer overlay mgHint or templateHint over fullscreenMG when the scene content allows it.');
        if (user.requestedTemplateTypes && user.requestedTemplateTypes.size > 0) {
            lines.push(`- User explicitly asked for these TEMPLATES where they fit naturally (YOU decide which scenes): ${[...user.requestedTemplateTypes].join(', ')}.`);
        }
        if (user.requestedFullscreenTypes && user.requestedFullscreenTypes.size > 0) {
            lines.push(`- User explicitly asked for these FULLSCREEN MG types where they fit naturally (YOU decide which scenes): ${[...user.requestedFullscreenTypes].join(', ')}.`);
        }
    }

    if (style.hasStyleInfluence) {
        lines.push('STYLE-DRIVEN VISUAL PRIORS (soft constraints, deterministic):');
        if (style.targetVideoRatio != null) lines.push(`- Style media mix target: ~${Math.round(style.targetVideoRatio * 100)}% video / ${100 - Math.round(style.targetVideoRatio * 100)}% image.`);
        if (style.preferRealSources) lines.push('- Style leans toward real/documentary footage over generic stock.');
        if (style.mgDensity) lines.push(`- Style MG density inspiration: ${style.mgDensity}.`);
        if (style.preferredMGTypes.length > 0) lines.push(`- Style frequently uses MG types like: ${style.preferredMGTypes.slice(0, 5).join(', ')}.`);
        if (style.hookUsesMG) lines.push('- Style reference uses graphics in the hook when the narration supports them.');
        if (style.framingBias) lines.push(`- Style framing bias: ${style.framingBias} when it fits the shot.`);
    }

    if (scriptContext.mainPoints?.length > 0) {
        lines.push(`UPSTREAM STORY POINTS: ${scriptContext.mainPoints.slice(0, 6).join(' | ')}`);
    }
    if (scriptContext.sections?.length > 0) {
        const sectionNames = scriptContext.sections
            .map(s => typeof s === 'string' ? s : s?.title)
            .filter(Boolean);
        if (sectionNames.length > 0) lines.push(`UPSTREAM SECTIONS: ${sectionNames.slice(0, 8).join(' | ')}`);
    }

    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function _compactSceneText(text, maxLen = 160) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    return `${clean.substring(0, Math.max(0, maxLen - 3)).trim()}...`;
}

function _renderEditorIdeaLine(scene) {
    if (!scene || !(scene._ideaLocked || scene.ideaVisual || scene.ideaLowerThird || scene.ideaAnchor)) return '';
    const parts = [];
    if (scene.ideaAnchor) parts.push(`anchor="${_compactSceneText(scene.ideaAnchor, 90)}"`);
    if (scene.ideaVisual) parts.push(`visual="${_compactSceneText(scene.ideaVisual, 120)}"`);
    if (scene.ideaLowerThird) parts.push(`lowerThird="${_compactSceneText(scene.ideaLowerThird, 70)}"`);
    if (scene.ideaReason) parts.push(`reason="${_compactSceneText(scene.ideaReason, 120)}"`);
    return parts.length ? `EDITOR-IDEA: ${parts.join(' | ')}` : '';
}

function buildGlobalOutlinePrompt(scenes, scriptContext, directorsBrief, plannerDirectives) {
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche } = require('../data/niches');
    const niche = getNiche(nicheId);
    const nicheAllowsMapChart = _nicheAllowsMapChartById(nicheId);
    const { user, style } = plannerDirectives;

    const sceneList = scenes.map(scene => {
        const duration = ((scene.endTime || 0) - (scene.startTime || 0)).toFixed(1);
        const tags = _sceneTagString(scene, scenes, scriptContext);
        const idea = _renderEditorIdeaLine(scene);
        return `SCENE ${scene.index} (${scene.startTime.toFixed(1)}s-${scene.endTime.toFixed(1)}s, ${duration}s) [${tags}]: "${_compactSceneText(scene.text, 180)}"${idea ? ` | ${idea}` : ''}`;
    }).join('\n');

    const directiveLines = [];
    if (user.hasUserDirectives) {
        directiveLines.push(`- User instructions: ${user.raw}`);
        if (user.preferMaps) {
            directiveLines.push(nicheAllowsMapChart
                ? '- User wants maps / route visuals when they fit.'
                : '- User asked for map/route visuals, but mapChart is forbidden by this niche; use route footage, stock references, templates, or overlays instead.');
        }
        if (user.preferTemplates) directiveLines.push('- User wants more template/card usage when editorially justified.');
        if (user.preferGraphics) directiveLines.push('- User is open to more graphics when the narration benefits.');
        if (user.avoidFullscreenMG) directiveLines.push('- User prefers fewer fullscreen graphics.');
        if (user.avoidStock) directiveLines.push('- User wants less stock footage.');
    }
    if (style.hasStyleInfluence) {
        if (style.targetVideoRatio != null) directiveLines.push(`- Style media mix target: ~${Math.round(style.targetVideoRatio * 100)}% video.`);
        if (style.preferRealSources) directiveLines.push('- Style prefers real/documentary footage over generic stock.');
        if (style.mgDensity) directiveLines.push(`- Style graphics density inspiration: ${style.mgDensity}.`);
        if (style.framingBias) directiveLines.push(`- Style framing bias: ${style.framingBias}.`);
    }

    return `You are creating a VIDEO-WIDE VISUAL OUTLINE before detailed scene planning.

Think across ALL scenes at once. Your job is to create a concise AI blueprint for the full video so later chunk planners can stay globally consistent.

Do NOT write final stockQuery/webQuery fields. Do NOT output the full detailed planner format. This is an OUTLINE pass only.

VIDEO CONTEXT:
- Niche: ${niche.name} (${niche.description})
- Theme: ${scriptContext.theme || 'general'}
- Tone: ${scriptContext.tone || 'informative'}
- Mood: ${scriptContext.mood || 'neutral'}
- Pacing: ${scriptContext.pacing || 'moderate'}
- Format: ${scriptContext.format || 'general'}
- Summary: ${scriptContext.summary || 'none'}
- Event Anchor: ${scriptContext.eventAnchor || 'none'}
- Main Points: ${scriptContext.mainPoints?.length ? scriptContext.mainPoints.slice(0, 8).join(' | ') : 'none'}
- Sections: ${scriptContext.sections?.length ? scriptContext.sections.map(s => typeof s === 'string' ? s : s?.title).filter(Boolean).slice(0, 8).join(' | ') : 'none'}
- Entities: ${scriptContext.entities?.length ? scriptContext.entities.slice(0, 12).join(', ') : 'none'}
${scriptContext.webContext ? `- Research: ${String(scriptContext.webContext).substring(0, 1200)}` : ''}
${directiveLines.length ? `\nDIRECTIVES:\n${directiveLines.map(line => `  ${line}`).join('\n')}` : ''}

SCENES (${scenes.length} total):
${sceneList}

WHAT YOU MUST DO:
1. Think about the WHOLE visual journey, not just single scenes.
2. Decide where the video should lean into footage, overlays, templates, or fullscreen MG.
3. Prevent repetition across neighboring scenes.
4. Preserve stronger moments for hook / reveal / conclusion scenes.
5. Flag the best editorial opportunities for templates instead of letting everything collapse into fullscreen graphics.
6. When a scene has EDITOR-IDEA, preserve that specific intended visual beat in your lane/source note.

SOURCE MEANING FOR OUTLINE NOTES:
- stock = Pexels/Pixabay free generic B-roll for concrete hands-on actions, processes, tools, workbenches, stores, labs, factories, non-exact settings.
- web-image = Bing/Brave exact/reference still image: brands, labels, logos, model plates, screenshots, documents, maps, city signs, historical photos.
- youtube = real moving footage: product demos, factory tours, reviews, walkthroughs, events, interviews.
- reddit = raw community/broadcast/drone/dashcam clips.
- Do not write "stock footage" for exact brands/photos/screenshots/labels, or for real moving demos/tours/reviews.
- Avoid abstract documentary mood/aerial filler; convert abstract beats into physical actions, objects, or templates.

OUTPUT FORMAT:
GLOBAL ARC: <one concise line about the full-video visual journey>
GLOBAL SOURCES: <one concise line about source rhythm across the full video>
GLOBAL GRAPHICS: <one concise line about where templates / overlays / fullscreen graphics should appear>
GLOBAL DIVERSITY: <one concise line about anti-repetition / variation strategy>
Then output ONE line for EVERY scene:
SCENE N: lane=<short editorial role> | source=<best source family> | graphics=<footage|overlay|template|fullscreenMG> | note=<short anti-repeat or emphasis cue>

RULES:
- Cover EVERY scene exactly once.
- Keep each SCENE line under 28 words total and each note under 12 words.
- Output only the four GLOBAL lines plus the required SCENE lines; no commentary.
- Let graphics choices be editorial, not mechanical.
- Use "template" when a card/panel layout would communicate better than raw footage.
- Use "fullscreenMG" only when replacing footage is clearly the better communication choice.
- Keep the outline concise and easy for a later planner pass to follow.`;
}

function _parseGlobalVisualOutline(rawText, scenes) {
    const validSceneIds = new Set(scenes.map(scene => scene.index));
    const lines = String(rawText || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const globalLines = [];
    const sceneHints = {};

    for (const line of lines) {
        const sceneMatch = line.match(/^SCENE\s+(\d+)\s*:\s*(.+)$/i);
        if (sceneMatch) {
            const idx = parseInt(sceneMatch[1], 10);
            if (!validSceneIds.has(idx)) continue;
            const body = sceneMatch[2].trim();
            const field = (name) => {
                const match = body.match(new RegExp(`\\b${name}\\s*=\\s*([^|]+)`, 'i'));
                return match ? match[1].trim() : '';
            };
            sceneHints[idx] = {
                index: idx,
                raw: body,
                lane: field('lane'),
                source: field('source'),
                graphics: field('graphics'),
                note: field('note'),
            };
            continue;
        }
        if (/^GLOBAL\s+[A-Z ]+:/i.test(line)) {
            globalLines.push(line);
        }
    }

    const expected = scenes.length;
    const actual = Object.keys(sceneHints).length;
    const missing = scenes.map(scene => scene.index).filter(idx => !sceneHints[idx]);
    const graphicsCounts = { footage: 0, overlay: 0, template: 0, fullscreenMG: 0, unknown: 0 };
    for (const hint of Object.values(sceneHints)) {
        const g = String(hint.graphics || '').toLowerCase();
        if (g.includes('template')) graphicsCounts.template++;
        else if (g.includes('fullscreen')) graphicsCounts.fullscreenMG++;
        else if (g.includes('overlay')) graphicsCounts.overlay++;
        else if (g.includes('footage')) graphicsCounts.footage++;
        else graphicsCounts.unknown++;
    }

    return {
        rawText: String(rawText || ''),
        globalLines,
        sceneHints,
        coverage: expected > 0 ? actual / expected : 0,
        missing,
        graphicsCounts,
    };
}

function _renderGlobalOutlineBlock(globalOutline, currentScenes) {
    if (!globalOutline) return '';

    const currentIds = currentScenes.map(scene => scene.index);
    const first = currentIds[0];
    const last = currentIds[currentIds.length - 1];
    const currentHints = currentIds
        .map(idx => globalOutline.sceneHints[idx])
        .filter(Boolean);
    const seamIds = [first - 2, first - 1, last + 1, last + 2];
    const seamHints = seamIds
        .map(idx => globalOutline.sceneHints[idx])
        .filter(Boolean);

    const lines = ['FULL-VIDEO AI OUTLINE (generated from ALL scenes before detailed planning):'];
    for (const line of globalOutline.globalLines.slice(0, 4)) {
        lines.push(`- ${line}`);
    }
    if (currentHints.length > 0) {
        lines.push('CURRENT SCENE BLUEPRINT HINTS:');
        for (const hint of currentHints) {
            lines.push(`- Scene ${hint.index}: ${hint.raw}`);
        }
    }
    if (seamHints.length > 0) {
        lines.push('NEIGHBORING SEAM HINTS (for continuity before/after this batch):');
        for (const hint of seamHints) {
            lines.push(`- Scene ${hint.index}: ${hint.raw}`);
        }
    }
    lines.push('Treat this outline as the default whole-video blueprint. Keep the final per-scene plan intelligent and scene-specific, but do not downgrade outline source=web-image exact stills to stock.');
    return `\n${lines.join('\n')}\n`;
}

function _logGlobalOutlineDetails(outline, scenes) {
    if (!outline) return;
    console.log('   [VP Outline Detail] scene-by-scene whole-video blueprint:');
    for (const scene of scenes || []) {
        const hint = outline.sceneHints?.[scene.index];
        if (!hint) {
            console.log(`      S${scene.index}: missing outline hint`);
            continue;
        }
        console.log(
            `      S${scene.index}: lane=${hint.lane || '-'} | source=${hint.source || '-'} | graphics=${hint.graphics || '-'} | note=${_shortVpLog(hint.note || hint.raw, 150)}`
        );
    }
}

async function _generateGlobalVisualOutline(scenes, scriptContext, directorsBrief, plannerDirectives) {
    console.log(`   🧭 [Step 4 Outline] generating whole-video outline for ${scenes.length} scenes...`);
    const prompt = buildGlobalOutlinePrompt(scenes, scriptContext, directorsBrief, plannerDirectives);
    // Reserve enough space for every required scene line plus the four global
    // lines. The old 60-token/scene budget could truncate the tail of longer
    // videos even when the model otherwise followed the contract.
    const maxTokens = Math.min(8000, Math.max(1600, 600 + scenes.length * 72));
    const hasBedrockFallback = !!(process.env.BEDROCK_ACCESS_KEY_ID && process.env.BEDROCK_SECRET_ACCESS_KEY);
    if (hasBedrockFallback) console.log(`   🟣 [VP Outline] routing via task-aware text router (Bedrock fallback available)`);
    const rawText = await callAI(prompt, { maxTokens, taskType: 'planner-outline' });
    if (!rawText) throw new Error('Empty outline response');
    console.log(`   [VP Outline IO] promptChars=${prompt.length} maxTokens=${maxTokens} responseChars=${String(rawText).length}`);

    const outline = _parseGlobalVisualOutline(rawText, scenes);
    const coveragePct = Math.round(outline.coverage * 100);
    const gfx = outline.graphicsCounts;
    console.log(`   🧭 [Step 4 Outline] globals=${outline.globalLines.length} sceneHints=${Object.keys(outline.sceneHints).length}/${scenes.length} (${coveragePct}%) graphics={footage:${gfx.footage}, overlay:${gfx.overlay}, template:${gfx.template}, fs:${gfx.fullscreenMG}, unknown:${gfx.unknown}}`);
    if (outline.globalLines.length > 0) {
        console.log(`   🧭 [Step 4 Outline] ${outline.globalLines.slice(0, 2).join(' | ')}`);
    }
    if (outline.missing.length > 0) {
        console.log(`   ⚠️ [Step 4 Outline] missing scene hints for: ${outline.missing.slice(0, 8).join(', ')}${outline.missing.length > 8 ? '...' : ''}`);
    }
    _logGlobalOutlineDetails(outline, scenes);
    return outline;
}

function _extractFirstStatToken(text) {
    const match = String(text || '').match(/\b(?:\$?\d+(?:\.\d+)?%?|\d{4})\b/);
    return match ? match[0] : null;
}

function _buildMapKeyword(scene, signals, scriptContext) {
    const anchors = [];
    for (const place of signals.places.slice(0, 2)) anchors.push(place);
    if (anchors.length === 0 && scriptContext.eventAnchor) anchors.push(scriptContext.eventAnchor);
    if (anchors.length === 0 && scriptContext.videoTitle) anchors.push(scriptContext.videoTitle.split(/\s+/).slice(0, 4).join(' '));
    const suffix = /\b(route|corridor|pipeline|shipping|trade|strait|canal)\b/i.test(scene.text || '') ? 'route map' : 'map';
    return [...anchors.slice(0, 2), suffix].join(' ').trim() || 'location map';
}

function _pickPreferredVideoSource(nicheId, plannerDirectives, fallback = 'youtube') {
    plannerDirectives = plannerDirectives || {};
    plannerDirectives.user = plannerDirectives.user || {};
    plannerDirectives.user.preferredSources = plannerDirectives.user.preferredSources || [];
    if (!(plannerDirectives.user.bannedSources instanceof Set)) {
        plannerDirectives.user.bannedSources = new Set(plannerDirectives.user.bannedSources || []);
    }
    const { getNiche } = require('../data/niches');
    const niche = getNiche(nicheId || 'general');
    const videoPriority = [...new Set(filterDisabledSources(niche.footagePriority?.video || [fallback]).map(providerToSourceHint))];
    const preferred = plannerDirectives.user.preferredSources
        .map(src => _sanitizeVpSourceHint(src, fallback))
        .filter(src => videoPriority.includes(src) && src !== 'stock');
    const ordered = [...preferred, ...videoPriority.filter(src => !preferred.includes(src))];
    const allowed = ordered.filter(src => !plannerDirectives.user.bannedSources.has(src));
    return _sanitizeVpSourceHint(allowed[0] || ordered[0] || fallback, fallback);
}

function _sanitizeDisabledSourceHints(scenes, fallback = 'youtube') {
    let changed = 0;
    for (const scene of scenes || []) {
        if (!scene) continue;
        const before = scene.sourceHint || null;
        const after = _sanitizeVpSourceHint(before, fallback);
        if (before && after && before !== after) {
            scene.sourceHint = after;
            if (scene.keyword) scene.webQuery = _autoWebQuery(scene.searchKeyword || scene.keyword, after);
            changed++;
        }
        const intent = scene.mediaIntent;
        if (intent) {
            const intentSource = _sanitizeVpSourceHint(intent.sourceHint, fallback);
            if (intent.sourceHint && intentSource && intent.sourceHint !== intentSource) {
                intent.sourceHint = intentSource;
                changed++;
            }
            if (intent.policy?.sourceHint) {
                const policySource = _sanitizeVpSourceHint(intent.policy.sourceHint, fallback);
                if (policySource && intent.policy.sourceHint !== policySource) {
                    intent.policy.sourceHint = policySource;
                    changed++;
                }
            }
        }
    }
    return changed;
}

function _applyPlannerMediaMix(scenes, scriptContext, plannerDirectives, stats) {
    const footageScenes = scenes.filter(s => !s.fullscreenMG);
    if (footageScenes.length < 6) return;

    const nicheId = scriptContext.nicheId || 'general';
    const { user, style } = plannerDirectives;
    let targetVideoRatio = user.preferredVideoRatio;
    if (targetVideoRatio == null && style.targetVideoRatio != null && !nicheId.startsWith('news')) {
        targetVideoRatio = style.targetVideoRatio;
    }
    if (targetVideoRatio == null) return;

    const currentVideoCount = footageScenes.filter(s => s.mediaType === 'video').length;
    const currentRatio = currentVideoCount / footageScenes.length;
    if (Math.abs(currentRatio - targetVideoRatio) < 0.08) return;

    if (currentRatio < targetVideoRatio) {
        const needed = Math.ceil(targetVideoRatio * footageScenes.length) - currentVideoCount;
        const topSource = _pickPreferredVideoSource(nicheId, plannerDirectives);
        const candidates = footageScenes
            .filter(s => s.mediaType === 'image' && !s._personLock)
            .map(scene => ({ scene, signals: _deriveSceneSignals(scene, scenes, scriptContext) }))
            .filter(({ signals }) => !signals.likelyDataImage && !signals.hasMapCandidate && !signals.primaryPerson)
            .sort((a, b) => (a.scene.index || 0) - (b.scene.index || 0));

        let flipped = 0;
        for (const { scene } of candidates) {
            if (flipped >= needed) break;
            scene.mediaType = 'video';
            scene.sourceHint = topSource;
            scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword || extractFallbackKeyword(scene.text, scene, scriptContext));
            flipped++;
        }
        if (flipped > 0) stats.styleMixAdjusted += flipped;
    } else {
        const needed = currentVideoCount - Math.floor(targetVideoRatio * footageScenes.length);
        const candidates = footageScenes
            .filter(s => s.mediaType === 'video')
            .map(scene => ({ scene, signals: _deriveSceneSignals(scene, scenes, scriptContext) }))
            .filter(({ signals }) => signals.likelyDataImage || signals.hasMapCandidate || (!signals.likelyAction && signals.phase === 'body'))
            .sort((a, b) => (a.scene.index || 0) - (b.scene.index || 0));

        let flipped = 0;
        for (const { scene, signals } of candidates) {
            if (flipped >= needed) break;
            scene.mediaType = 'image';
            scene.sourceHint = (signals.likelyDataImage || signals.hasMapCandidate || _looksLikeSpecificReference(scene, scriptContext)) ? 'web-image' : 'stock';
            if (signals.hasMapCandidate) {
                const mapKeyword = _buildMapKeyword(scene, signals, scriptContext);
                scene.keyword = mapKeyword;
                scene.webQuery = `${mapKeyword} reference image`;
            }
            flipped++;
        }
        if (flipped > 0) stats.styleMixAdjusted += flipped;
    }
}

function _applyGraphicDensity(scenes, scriptContext, plannerDirectives, stats) {
    const { user, style } = plannerDirectives;
    if (user.minimizeGraphics) {
        let cleared = 0;
        for (const scene of scenes) {
            const signals = _deriveSceneSignals(scene, scenes, scriptContext);
            if (scene.mgHint && !signals.hasNumeric && !signals.firstPersonIntro) {
                scene.mgHint = null;
                cleared++;
            }
        }
        if (cleared > 0) stats.graphicsTrimmed += cleared;
        return;
    }

    let targetRatio = null;
    if (style.mgDensity === 'high') targetRatio = 0.22;
    if (style.mgDensity === 'medium') targetRatio = 0.15;
    if (style.mgDensity === 'low') targetRatio = 0.08;
    if (user.preferGraphics || user.preferTemplates) targetRatio = Math.max(targetRatio || 0, 0.18);
    if (!targetRatio) return;

    const currentGraphicScenes = scenes.filter(s => s.mgHint || s.templateHint || s.fullscreenMG).length;
    const needed = Math.max(0, Math.ceil(targetRatio * scenes.length) - currentGraphicScenes);
    if (needed === 0) return;

    const candidates = scenes
        .filter(s => !s.mgHint && !s.templateHint && !s.fullscreenMG)
        .map(scene => ({ scene, signals: _deriveSceneSignals(scene, scenes, scriptContext) }))
        .filter(({ signals }) => signals.phase === 'body' && (signals.hasNumeric || signals.firstPersonIntro || signals.hasQuote))
        .sort((a, b) => {
            const scoreA = (a.signals.hasNumeric ? 3 : 0) + (a.signals.firstPersonIntro ? 2 : 0) + (a.signals.hasQuote ? 1 : 0);
            const scoreB = (b.signals.hasNumeric ? 3 : 0) + (b.signals.firstPersonIntro ? 2 : 0) + (b.signals.hasQuote ? 1 : 0);
            return scoreB - scoreA || ((a.scene.index || 0) - (b.scene.index || 0));
        });

    let injected = 0;
    for (const { scene, signals } of candidates) {
        if (injected >= needed) break;
        if (signals.hasNumeric) {
            const stat = _extractFirstStatToken(scene.text);
            if (stat) {
                scene.mgHint = `statCounter: ${stat}`;
                injected++;
            }
        } else if (signals.firstPersonIntro) {
            scene.mgHint = `lowerThird: ${signals.firstPersonIntro}`;
            injected++;
        } else if (signals.hasQuote) {
            const snippet = String(scene.text || '').replace(/^["“”']+|["“”']+$/g, '').split(/[.?!]/)[0].trim();
            if (snippet) {
                scene.mgHint = `callout: ${snippet.substring(0, 80)}`;
                injected++;
            }
        }
    }

    if (injected > 0) stats.graphicsInjected += injected;
}

function _applyPlannerCompliance(scenes, scriptContext, directorsBrief, plannerDirectives) {
    const nicheId = scriptContext.nicheId || 'general';
    // When the Editor Agent (CEO) owns editing, it re-decides framing/scale/
    // background per scene in Step 5.05b (ceo.js overwrites scene.framing/scale/
    // background). So the Planner must NOT also set framing — that's the CEO's job
    // now. The Planner stays a keyword/content/sourcing brain. (Legacy path, with
    // EDITOR_AGENT off, keeps the Planner's framing logic as before.)
    const ceoOwnsEditing = process.env.EDITOR_AGENT === 'true'
        || scriptContext?.editorAgentOwnsEditing === true
        || scriptContext?._editorAgentOwnsEditing === true;
    const stats = {
        sourceOverrides: 0,
        mapOverrides: 0,
        framingOverrides: 0,
        styleMixAdjusted: 0,
        graphicsInjected: 0,
        graphicsTrimmed: 0,
    };

    const topVideoSource = _pickPreferredVideoSource(nicheId, plannerDirectives);

    for (const scene of scenes) {
        const signals = _deriveSceneSignals(scene, scenes, scriptContext);
        scene.sceneType = signals.phase;
        scene.narrativeArc = scene.narrativeArc || signals.phase;

        if (!scene.fullscreenMG) {
            const banned = plannerDirectives.user.bannedSources.has(scene.sourceHint);
            const shouldAvoidStock =
                (plannerDirectives.user.avoidStock || plannerDirectives.user.preferRealFootage || plannerDirectives.style.preferRealSources) &&
                scene.sourceHint === 'stock' &&
                !signals.isAbstractMood;

            if (banned || shouldAvoidStock) {
                if (scene.mediaType === 'image' || signals.primaryPerson || signals.likelyDataImage || signals.hasMapCandidate) {
                    if (plannerDirectives.user.bannedSources.has('stock')) {
                        scene.sourceHint = topVideoSource;
                        scene.mediaType = 'video';
                    } else {
                        scene.mediaType = 'image';
                        scene.sourceHint = (signals.likelyDataImage || signals.hasMapCandidate || _looksLikeSpecificReference(scene, scriptContext)) ? 'web-image' : 'stock';
                    }
                } else {
                    scene.sourceHint = topVideoSource;
                    scene.mediaType = 'video';
                }
                stats.sourceOverrides++;
            }

            if (plannerDirectives.user.preferredSources.length > 0 &&
                scene.mediaType === 'video' &&
                !signals.primaryPerson &&
                !signals.likelyDataImage &&
                !signals.hasMapCandidate &&
                !plannerDirectives.user.bannedSources.has(scene.sourceHint)) {
                const preferredSource = _pickPreferredVideoSource(nicheId, plannerDirectives, scene.sourceHint);
                if (preferredSource && preferredSource !== scene.sourceHint) {
                    scene.sourceHint = preferredSource;
                    stats.sourceOverrides++;
                }
            }

            if (plannerDirectives.user.preferMaps && signals.hasMapCandidate && !signals.primaryPerson && signals.phase !== 'cta') {
                const mapKeyword = _buildMapKeyword(scene, signals, scriptContext);
                scene.keyword = mapKeyword;
                const useWebImage = !plannerDirectives.user.bannedSources.has('web-image');
                scene.mediaType = useWebImage ? 'image' : 'video';
                scene.sourceHint = useWebImage ? 'web-image' : topVideoSource;
                scene.webQuery = `${mapKeyword} reference map`;
                scene.stockQuery = _autoStockQuery(mapKeyword);
                if (!scene.visualIntent || scene.visualIntent === scene.keyword) {
                    scene.visualIntent = `Map / route visualization for ${mapKeyword}`;
                }
                stats.mapOverrides++;
            }

            // Framing is the Editor Agent's decision. Only run the Planner's
            // framing overrides on the legacy (non-CEO) path.
            if (!ceoOwnsEditing) {
                if (plannerDirectives.user.preferredFraming === 'fullscreen') {
                    if (scene.framing !== 'fullscreen') {
                        scene.framing = 'fullscreen';
                        scene.backgroundId = 'none';
                        scene.background = 'none';
                        stats.framingOverrides++;
                    }
                } else if (plannerDirectives.user.preferredFraming === 'cinematic' &&
                    scene.framing === 'fullscreen' &&
                    (scene.mediaType === 'image' || scene.sourceHint === 'stock' || signals.likelyDataImage)) {
                    scene.framing = 'cinematic';
                    scene.backgroundId = scene.backgroundId || 'blur';
                    stats.framingOverrides++;
                } else if (plannerDirectives.user.preferredFraming === 'floating' &&
                    scene.framing === 'fullscreen' &&
                    (scene.mediaType === 'image' || scene.sourceHint === 'stock')) {
                    scene.framing = 'floating';
                    scene.backgroundId = scene.backgroundId || 'soft-beige';
                    scene.floatingAnim = scene.floatingAnim || 'fadeScale';
                    scene.floatingShadow = scene.floatingShadow || 0.5;
                    stats.framingOverrides++;
                } else if (!plannerDirectives.user.preferredFraming &&
                    plannerDirectives.style.framingBias === 'floating' &&
                    scene.framing === 'fullscreen' &&
                    scene.mediaType === 'image' &&
                    scene.sourceHint === 'stock') {
                    scene.framing = 'floating';
                    scene.backgroundId = scene.backgroundId || 'soft-beige';
                    scene.floatingAnim = scene.floatingAnim || 'fadeScale';
                    scene.floatingShadow = scene.floatingShadow || 0.5;
                    stats.framingOverrides++;
                }
            }
        }
    }

    _applyPlannerMediaMix(scenes, scriptContext, plannerDirectives, stats);
    _applyGraphicDensity(scenes, scriptContext, plannerDirectives, stats);

    for (const scene of scenes) {
        if (scene.framing) scene._framingLocked = true;
    }

    const changeParts = [];
    if (stats.sourceOverrides > 0) changeParts.push(`sourceOverrides=${stats.sourceOverrides}`);
    if (stats.mapOverrides > 0) changeParts.push(`mapOverrides=${stats.mapOverrides}`);
    if (stats.framingOverrides > 0) changeParts.push(`framingOverrides=${stats.framingOverrides}`);
    if (stats.styleMixAdjusted > 0) changeParts.push(`styleMixAdjusted=${stats.styleMixAdjusted}`);
    if (stats.graphicsInjected > 0) changeParts.push(`graphicsInjected=${stats.graphicsInjected}`);
    if (stats.graphicsTrimmed > 0) changeParts.push(`graphicsTrimmed=${stats.graphicsTrimmed}`);
    if (changeParts.length > 0) {
        console.log(`   [Planner Guardrails] ${changeParts.join(' | ')}`);
    }
    return stats;
}

function _ideaTextContains(haystack, needle) {
    const norm = value => String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const h = norm(haystack);
    const n = norm(needle);
    return !!(h && n && h.includes(n));
}

function _applyEditorIdeaDirectives(scenes, scriptContext, plannerDirectives) {
    const notes = [];
    for (const scene of scenes) {
        if (!scene || !(scene._ideaLocked || scene.ideaVisual || scene.ideaLowerThird)) continue;

        const lowerThird = String(scene.ideaLowerThird || '').trim();
        if (lowerThird) {
            const terms = Array.isArray(scene.protectedTerms) ? scene.protectedTerms : [];
            if (!terms.some(t => _ideaTextContains(t, lowerThird) || _ideaTextContains(lowerThird, t))) {
                scene.protectedTerms = [...terms, lowerThird];
            }
        }

        if (scene.ideaVisual && !scene.fullscreenMG) {
            const hasUsefulKeyword = scene.keyword && !/^(none|null|n\/a)$/i.test(String(scene.keyword).trim());
            const keywordMatchesIdea = hasUsefulKeyword && (
                _ideaTextContains(scene.keyword, scene.ideaVisual) ||
                (lowerThird && _ideaTextContains(scene.keyword, lowerThird))
            );
            if (!hasUsefulKeyword || (!keywordMatchesIdea && lowerThird && !_ideaTextContains(scene.keyword, lowerThird))) {
                const before = scene.keyword || 'none';
                scene.keyword = String(scene.ideaVisual).trim();
                scene.mediaType = scene.mediaType || 'image';
                scene.sourceHint = scene.sourceHint || _pickPreferredVideoSource(scriptContext.nicheId || 'general', plannerDirectives, 'youtube');
                scene.webQuery = scene.webQuery || _autoWebQuery(scene.keyword, scene.sourceHint);
                scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword);
                notes.push({ index: scene.index, action: `keyword "${before}" -> "${scene.keyword}"`, reason: 'EDITOR-IDEA visual' });
            }
        }

        if (lowerThird && !scene.fullscreenMG && _ideaTextContains(scene.text, lowerThird)) {
            const currentType = scene.mgHint ? String(scene.mgHint).split(':')[0].trim().toLowerCase() : '';
            const canReplace = !scene.mgHint || ['focusword', 'kinetictext', 'headline', 'callout', 'typographyreveal'].includes(currentType);
            if (canReplace) {
                const before = scene.mgHint || 'none';
                scene.mgHint = `lowerThird: ${lowerThird}`;
                notes.push({ index: scene.index, action: `mgHint "${before}" -> "${scene.mgHint}"`, reason: 'EDITOR-IDEA lowerThird' });
            }
        }
    }
    return notes;
}

function _useLeanVpFinalizer() {
    const leanFlag = String(process.env.VP_LEAN_MODE || '').trim().toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(leanFlag)) return false;
    return String(process.env.VP_FULL_GUARDRAILS || '').trim() !== '1';
}

const _NUMERIC_TOKEN_RE = /(?:[$€£¥]\s*)?\d+(?:[.,]\d+)*(?:\s*(?:%|°[cf]?|[a-z]{1,8}(?:\/[a-z0-9³]+)?))?/i;
const _NUMBER_WORD_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|half|quarter)\b/i;

function _containsNumericSignal(value) {
    return sharedContainsNumericSignal(value);
}

function _cleanNumericLabel(value) {
    return String(value || '')
        .replace(/^\s*[a-z][a-z0-9-]*\s*:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

function _numericLowerThirdLabel(scene) {
    const candidates = [
        scene?.ideaLowerThird,
        scene?.mgHint,
        scene?.templateHint,
        scene?.fullscreenMG,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
    ].map(_cleanNumericLabel);
    return chooseNumericLabel(candidates, scene?.text, 80);
}

function _enforceNumericLowerThirdDirective(scenes, scriptContext = {}, directorsBrief = {}, plannerDirectives = {}) {
    const directives = scriptContext?._directives || {};
    const raw = String(directives.raw || directorsBrief?.freeInstructions || '');
    const requested = plannerDirectives?.user?.forceNumericLowerThird === true
        || directives?.graphics?.numericTreatment === 'lowerThird'
        || (
            /\b(?:all|every|each)\s+(?:number|numbers|numeric value|numeric values|stat|stats|statistic|statistics)\b.{0,48}\blower[\s-]?thirds?\b/i.test(raw)
            || /\blower[\s-]?thirds?\b.{0,48}\b(?:all|every|each)\s+(?:number|numbers|numeric value|numeric values|stat|stats|statistic|statistics)\b/i.test(raw)
        );
    if (!requested) return [];

    const fixes = [];
    for (const scene of scenes || []) {
        const content = [
            scene?.text,
            scene?.ideaLowerThird,
            scene?.mgHint,
            scene?.templateHint,
            scene?.fullscreenMG,
            ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ].filter(Boolean).join(' ');
        if (!_containsNumericSignal(content)) continue;

        const label = _numericLowerThirdLabel(scene);
        if (!label) continue;
        const before = {
            fullscreenMG: scene.fullscreenMG || null,
            templateHint: scene.templateHint || null,
            mgHint: scene.mgHint || null,
        };

        const fallbackKeyword = scene.templateBgQuery
            || scene.bgQuery
            || scene.stockQuery
            || scene.webQuery
            || scene.ideaVisual
            || scene.visualIntent
            || extractFallbackKeyword(scene.text || '', scene, scriptContext);
        scene.fullscreenMG = null;
        scene.templateHint = null;
        scene.templateType = null;
        scene.isListicleOverview = false;
        scene.mgHint = `lowerThird: ${label}`;
        scene.keyword = (scene.keyword && scene.keyword !== 'none') ? scene.keyword : fallbackKeyword;
        scene.mediaType = scene.mediaType || (directorsBrief?.tier?.allowVideo === false ? 'image' : 'video');
        scene.sourceHint = scene.sourceHint || _pickPreferredVideoSource(scriptContext.nicheId || 'general', plannerDirectives, 'youtube');
        if (scene.keyword) {
            scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword);
            scene.webQuery = scene.webQuery || _autoWebQuery(scene.keyword, scene.sourceHint);
        }
        scene._numericLowerThirdDirected = true;
        if (!Array.isArray(scene._directiveLock)) scene._directiveLock = [];
        for (const field of ['fullscreenMG', 'templateHint', 'mgHint']) {
            if (!scene._directiveLock.includes(field)) scene._directiveLock.push(field);
        }
        fixes.push({
            index: scene.index,
            before,
            after: scene.mgHint,
            reason: 'creator required every number/stat to use a lower third',
        });
    }
    return fixes;
}

async function _finalizeVisualPlan(enrichedScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline = null) {
    // Listicle keyword variety enforcement
    if (scriptContext.format === 'listicle' && scriptContext.listicleItems) {
        const { enforceKeywordVariety } = require('../formats/listicle-format');
        enforceKeywordVariety(enrichedScenes, scriptContext.listicleItems);

        const firstItem = scriptContext.listicleItems.find(it => it.startSceneIndex != null);
        if (firstItem) {
            const overviewIdx = Math.max(0, firstItem.startSceneIndex - 1);
            const overviewScene = enrichedScenes.find(s => s.index === overviewIdx);
            if (overviewScene && !overviewScene.fullscreenMG) {
                overviewScene.fullscreenMG = 'listicleGrid';
                overviewScene.isListicleOverview = true;
                overviewScene.keyword = null;
                overviewScene.stockQuery = null;
                overviewScene.webQuery = null;
                overviewScene.mediaType = null;
                overviewScene.sourceHint = null;
                overviewScene.protectedTerms = [];
                console.log(`      [Listicle] Scene ${overviewIdx}: forced to listicleGrid overview (no footage needed)`);
            }
        }
    }

    if (_useLeanVpFinalizer()) {
        console.log('   [VP Lean Mode] active: AI visual plan is source-of-truth; skipped heavy rewrite stacks, kept hard source/provider sanity checks');

        const nicheMapFixes = _enforceNicheMapChartBan(enrichedScenes, scriptContext.nicheId, plannerDirectives, scriptContext);
        if (nicheMapFixes.length > 0) {
            console.log(`   [Niche Map Rule] removed ${nicheMapFixes.length} forbidden mapChart scene(s):`);
            for (const f of nicheMapFixes) {
                console.log(`      Scene ${f.index}: "${f.before}" -> "${f.after}" (${f.reason})`);
            }
        }
        const nicheMapDrops = enrichedScenes.filter(s => s._nicheMapDrop).length;

        const numericLowerThirdFixes = _enforceNumericLowerThirdDirective(
            enrichedScenes,
            scriptContext,
            directorsBrief,
            plannerDirectives
        );
        if (numericLowerThirdFixes.length > 0) {
            console.log(`   [Creator Numeric Treatment] forced lowerThird on ${numericLowerThirdFixes.length} number/stat scene(s)`);
        }

        for (const scene of enrichedScenes) {
            _normalizeProtectedTerms(scene, scriptContext);
        }
        const disabledSourceFixes = _sanitizeDisabledSourceHints(enrichedScenes, 'youtube');
        if (disabledSourceFixes > 0) {
            console.log(`   [Source Policy] replaced ${disabledSourceFixes} disabled source hint(s) with active providers`);
        }
        const sourceAuditFixes = await _auditQuestionableSourcesWithAI(enrichedScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline);
        if (sourceAuditFixes.length > 0) {
            console.log(`   [Source Auditor] AI corrected ${sourceAuditFixes.length} questionable source/keyword decision(s):`);
            for (const f of sourceAuditFixes.slice(0, 12)) {
                console.log(`      Scene ${f.index}: ${f.before.mediaType || 'none'}/${f.before.sourceHint || 'none'} -> ${f.after.mediaType || 'none'}/${f.after.sourceHint || 'none'} | "${_shortVpLog(f.before.keyword, 45)}" -> "${_shortVpLog(f.after.keyword, 45)}" (${_shortVpLog(f.reason, 90)})`);
            }
            if (sourceAuditFixes.length > 12) {
                console.log(`      ... ${sourceAuditFixes.length - 12} more`);
            }
        }

        const semanticSourceFixes = _applySemanticSourceRouting(enrichedScenes, scriptContext, plannerDirectives);
        if (semanticSourceFixes.length > 0) {
            console.log(`   [Source Policy] repaired ${semanticSourceFixes.length} semantic source mismatch(es):`);
            for (const f of semanticSourceFixes.slice(0, 12)) {
                const typeChange = f.beforeType !== f.afterType ? ` ${f.beforeType || 'none'}->${f.afterType || 'none'}` : '';
                console.log(`      Scene ${f.index}:${typeChange} ${f.before || 'none'} -> ${f.after} (${f.reason})`);
            }
            if (semanticSourceFixes.length > 12) {
                console.log(`      ... ${semanticSourceFixes.length - 12} more`);
            }
        }
        const stillRunBreaks = _breakStillRuns(enrichedScenes, scriptContext, plannerDirectives);
        if (stillRunBreaks.length > 0) {
            console.log(`   [Still Run Breaker] flipped ${stillRunBreaks.length} scene(s) to footage so no more than ${MAX_CONSECUTIVE_STILLS} stills play back-to-back:`);
            for (const b of stillRunBreaks) {
                console.log(`      Scene ${b.index}: ${b.before.mediaType || 'none'}/${b.before.sourceHint || 'none'} -> video/${b.after.sourceHint} — ${b.reason}`);
            }
        }

        const queryBackfills = _ensureFootageSearchQueries(enrichedScenes, scriptContext);
        if (queryBackfills > 0) {
            console.log(`   [Search Query Policy] backfilled ${queryBackfills} missing stock/web query field(s)`);
        }

        const summary = _buildPlannerSummary(enrichedScenes, {
            ctaGuardStripped: 0,
            kwViolations: 0,
            typographyRunFixes: 0,
            classFixes: 0,
            displayTextFixes: 0,
            nicheMapDrops,
            contextKwFixes: 0,
            editorIdeaFixes: 0,
            sourceOverrides: sourceAuditFixes.length + semanticSourceFixes.length,
            mapOverrides: 0,
            framingOverrides: 0,
            styleMixAdjusted: 0,
            graphicsInjected: numericLowerThirdFixes.length,
            graphicsTrimmed: numericLowerThirdFixes.filter(f => f.before.fullscreenMG || f.before.templateHint).length,
        });
        console.log(summary);
        _logFinalVpDiagnostics(enrichedScenes, scriptContext, globalOutline);

        return enrichedScenes;
    }

    const complianceStats = _applyPlannerCompliance(enrichedScenes, scriptContext, directorsBrief, plannerDirectives) || {};

    _enforceVideoRatio(enrichedScenes, scriptContext.nicheId);

    if (scriptContext.nicheId && scriptContext.nicheId.startsWith('news')) {
        for (const scene of enrichedScenes) {
            if (scene.sourceHint === 'stock' && scene.mediaType !== 'video') {
                scene.sourceHint = 'web-image';
            }
        }
    }

    const entities = scriptContext.entities || [];
    const entityTypes2 = scriptContext.entityTypes || {};
    if (entities.length > 0) {
        for (const scene of enrichedScenes) {
            if (!scene.keyword || scene.sourceHint === 'web-image') continue;
            const kwLower = scene.keyword.toLowerCase();
            const matchedEntities = entities.filter(e => {
                const eLower = e.toLowerCase();
                return kwLower.includes(eLower) || eLower.includes(kwLower);
            });
            const personEntity = matchedEntities.find(e => entityTypes2[e.toLowerCase()] === 'person');
            const hasPortraitHint = /portrait|photo|headshot|face/i.test(kwLower);
            if (personEntity || hasPortraitHint) {
                if (scene.mediaType !== 'image' || scene.sourceHint !== 'web-image') {
                    console.log(`   Person override: "${scene.keyword}" -> [image, web-image]`);
                    scene.mediaType = 'image';
                    scene.sourceHint = 'web-image';
                }
            }
        }
    }

    _validateKeywords(enrichedScenes, scriptContext);

    const templateOnlyMgFixes = [];
    for (const scene of enrichedScenes) {
        const fix = scene._templateOnlyMgCoercion || _coerceTemplateOnlyMgHint(scene, scriptContext);
        if (fix) {
            templateOnlyMgFixes.push({ index: scene.index, ...fix });
            scene._templateOnlyMgCoercion = null;
        }
    }
    if (templateOnlyMgFixes.length > 0) {
        console.log(`   [Template Type Cleanup] moved ${templateOnlyMgFixes.length} template-only overlay choice(s) from mgHint into templateHint:`);
        for (const f of templateOnlyMgFixes) {
            console.log(`      Scene ${f.index}: ${f.before} → ${f.after}`);
        }
    }

    // ── CTA zone fullscreenMG guard ──
    // Conclusion/CTA scenes should never be a fullscreenMG — they need real closing
    // footage. If the planner (or a promoter upstream) left one there, strip it and
    // restore sensible footage defaults.
    let ctaGuardStripped = 0;
    for (const scene of enrichedScenes) {
        if (!scene.fullscreenMG) continue;
        const phase = _getScenePhase(scene, scriptContext);
        if (phase !== 'cta') continue;
        scene._correctedFromFullscreen = scene.fullscreenMG;
        scene.fullscreenMG = null;
        if (!scene.keyword || scene.keyword === 'none') {
            // Clean footage-query fields first; visualIntent is a treatment
            // description on graphics scenes ("Fullscreen ... template presenting").
            scene.keyword = scene.templateBgQuery || scene.bgQuery || scene.stockQuery
                || scene.webQuery || scene.visualIntent || extractFallbackKeyword(scene.text || '', scene, scriptContext);
        }
        if (!scene.mediaType) scene.mediaType = 'video';
        if (!scene.sourceHint) {
            const nicheIdLocal = scriptContext.nicheId || 'general';
            scene.sourceHint = _pickPreferredVideoSource(nicheIdLocal, plannerDirectives, 'stock');
        }
        if (!scene.stockQuery) scene.stockQuery = _autoStockQuery(scene.keyword);
        if (!scene.webQuery)  scene.webQuery  = _autoWebQuery(scene.keyword, scene.sourceHint);
        ctaGuardStripped++;
    }
    if (ctaGuardStripped > 0) {
        console.log(`   [CTA Scene Safety] removed fullscreenMG from ${ctaGuardStripped} conclusion scene(s) and restored footage`);
    }

    // ── Keyword safety rules ──
    // Catches keywords the model generated despite the prompt's abstract/news-actor rules.
    // Logs every violation so we can see whether the prompt is landing, and repairs the
    // scene instead of letting a doomed query hit the provider chain.
    const kwViolations = _enforceKeywordCompliance(enrichedScenes, scriptContext);
    if (kwViolations.length > 0) {
        console.log(`   [Keyword Safety Rules] repaired ${kwViolations.length} unsafe or too-abstract keyword choice(s):`);
        for (const v of kwViolations) {
            console.log(`      Scene ${v.index}: ${v.reason} — "${v.before}" → "${v.after}"${v.sourceChange ? ` (source: ${v.sourceChange})` : ''}`);
        }
    }

    // ── Typography run dedup ──
    // After metaphor scenes get flipped to fullscreenMG focusWord, a cluster of
    // adjacent abstract scenes can all become focusWord — three typography cards
    // in a row look lazy. Alternate them and break long runs. These overlays
    // may sit on footage or on a template background via templateHint.
    const typographyRunFixes = _dedupTypographyRuns(enrichedScenes);
    if (typographyRunFixes.length > 0) {
        console.log(`   [Typography Run Breaker] changed ${typographyRunFixes.length} repeated typography overlay(s):`);
        for (const f of typographyRunFixes) {
            const lane = f.lane ? ` [${f.lane}]` : '';
            console.log(`      Scene ${f.index}${lane}: ${f.before} → ${f.after}`);
        }
    }

    // ── Editor intent controller ──
    // Build a small story-aware note per scene before hard class validation.
    // This protects good charts/comparisons from mechanical rewrites and gives
    // fallback overlays a better short phrase than the discarded MG title.
    const editorIntentNotes = _attachEditorIntentController(enrichedScenes, scriptContext, globalOutline);
    if (editorIntentNotes.length > 0) {
        console.log(`   [Editor Intent Controller] protected ${editorIntentNotes.length} context-aware visual choice(s):`);
        for (const note of editorIntentNotes.slice(0, 8)) {
            console.log(`      Scene ${note.index}: ${note.action} (${note.reason})`);
        }
        if (editorIntentNotes.length > 8) {
            console.log(`      ... ${editorIntentNotes.length - 8} more`);
        }
    }

    // ── Class/treatment validator ──
    // When the Scene Classifier attached sceneClass + treatmentHint, rewrite
    // any scene whose chosen lane conflicts with its class rules.
    // No-op when classes weren't attached (flag off or classifier failed).
    const classFixes = _enforceClassTreatment(enrichedScenes, scriptContext);
    if (classFixes.length > 0) {
        console.log(`   [Class Treatment Rules] rewrote ${classFixes.length} scene(s) to match its scene class:`);
        for (const f of classFixes) {
            console.log(`      Scene ${f.index}: ${f.reason} — "${f.before}" → "${f.after}"`);
        }
    }

    const displayTextFixes = _enforceDisplayTextPlacement(enrichedScenes, scriptContext, plannerDirectives, globalOutline);
    if (displayTextFixes.length > 0) {
        console.log(`   [Display Text Placement] fixed ${displayTextFixes.length} misplaced prominent text choice(s):`);
        for (const f of displayTextFixes) {
            console.log(`      Scene ${f.index}: ${f.field} "${f.before}" -> "${f.after}" (${f.reason})`);
        }
    }

    // Niche template ban. Step 6.5 silently strips templateHints outside the
    // niche's allowedTemplates, but by then the download queue is already
    // built — banned scenes get a generic background instead of real footage.
    // Convert here so they enter Step 5 as footage with proper keywords.
    const nicheTemplateFixes = _enforceNicheTemplateBan(enrichedScenes, scriptContext, plannerDirectives);
    if (nicheTemplateFixes.length > 0) {
        console.log(`   [Niche Template Ban] rewrote ${nicheTemplateFixes.length} banned templateHint(s):`);
        for (const f of nicheTemplateFixes) {
            console.log(`      Scene ${f.index}: ${f.reason} — "${f.before}" → "${f.after}"`);
        }
    }

    // Final niche map gate. Parser-time stripping catches raw AI output; this
    // pass catches later compliance/class rewrites that might reintroduce a
    // map lane after the parse step.
    const nicheMapFixes = _enforceNicheMapChartBan(enrichedScenes, scriptContext.nicheId, plannerDirectives, scriptContext);
    if (nicheMapFixes.length > 0) {
        console.log(`   [Niche Map Rule] removed ${nicheMapFixes.length} forbidden mapChart scene(s):`);
        for (const f of nicheMapFixes) {
            console.log(`      Scene ${f.index}: "${f.before}" -> "${f.after}" (${f.reason})`);
        }
    }
    const nicheMapDrops = enrichedScenes.filter(s => s._nicheMapDrop).length;

    // ── Contextual keyword repair ──
    // Bridge scenes can contain only connector text ("exactly what we're seeing",
    // "because while..."). Anchor their footage keywords to neighboring concrete
    // context instead of allowing generic city/skyline filler or late-entity drift.
    const contextKwFixes = repairContextualKeywords(enrichedScenes, scriptContext);
    if (contextKwFixes.length > 0) {
        console.log(`   [Context Keyword Repair] repaired ${contextKwFixes.length} bridge/connector scene keyword(s):`);
        for (const f of contextKwFixes) {
            console.log(`      Scene ${f.index}: ${f.reason} — "${f.before}" → "${f.after}"`);
        }
    }

    const editorIdeaFixes = _applyEditorIdeaDirectives(enrichedScenes, scriptContext, plannerDirectives);
    if (editorIdeaFixes.length > 0) {
        console.log(`   [Editor Idea Directives] applied ${editorIdeaFixes.length} locked scene intent fix(es):`);
        for (const f of editorIdeaFixes.slice(0, 10)) {
            console.log(`      Scene ${f.index}: ${f.action} (${f.reason})`);
        }
        if (editorIdeaFixes.length > 10) {
            console.log(`      ... ${editorIdeaFixes.length - 10} more`);
        }
    }

    // ── Global Source Diversity ──
    // Run ONCE across the full scene list (was per-batch, which missed
    // cross-chunk skew: e.g. 3 batches each 50% youtube = 50% youtube globally
    // but ran with 2-scene streaks in every chunk seam).
    const numericLowerThirdFixes = _enforceNumericLowerThirdDirective(
        enrichedScenes,
        scriptContext,
        directorsBrief,
        plannerDirectives
    );
    if (numericLowerThirdFixes.length > 0) {
        console.log(`   [Creator Numeric Treatment] forced lowerThird on ${numericLowerThirdFixes.length} number/stat scene(s)`);
    }

    _enforceSourceDiversity(enrichedScenes, scriptContext.nicheId);

    for (const scene of enrichedScenes) {
        _normalizeProtectedTerms(scene, scriptContext);
    }
    const disabledSourceFixes = _sanitizeDisabledSourceHints(enrichedScenes, 'youtube');
    if (disabledSourceFixes > 0) {
        console.log(`   [Source Policy] replaced ${disabledSourceFixes} disabled source hint(s) with active providers`);
    }
    const sourceAuditFixes = await _auditQuestionableSourcesWithAI(enrichedScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline);
    if (sourceAuditFixes.length > 0) {
        console.log(`   [Source Auditor] AI corrected ${sourceAuditFixes.length} questionable source/keyword decision(s):`);
        for (const f of sourceAuditFixes.slice(0, 12)) {
            console.log(`      Scene ${f.index}: ${f.before.mediaType || 'none'}/${f.before.sourceHint || 'none'} -> ${f.after.mediaType || 'none'}/${f.after.sourceHint || 'none'} | "${_shortVpLog(f.before.keyword, 45)}" -> "${_shortVpLog(f.after.keyword, 45)}" (${_shortVpLog(f.reason, 90)})`);
        }
        if (sourceAuditFixes.length > 12) {
            console.log(`      ... ${sourceAuditFixes.length - 12} more`);
        }
    }

    const semanticSourceFixes = _applySemanticSourceRouting(enrichedScenes, scriptContext, plannerDirectives);
    if (semanticSourceFixes.length > 0) {
        console.log(`   [Source Policy] repaired ${semanticSourceFixes.length} semantic source mismatch(es):`);
        for (const f of semanticSourceFixes.slice(0, 12)) {
            const typeChange = f.beforeType !== f.afterType ? ` ${f.beforeType || 'none'}->${f.afterType || 'none'}` : '';
            console.log(`      Scene ${f.index}:${typeChange} ${f.before || 'none'} -> ${f.after} (${f.reason})`);
        }
        if (semanticSourceFixes.length > 12) {
            console.log(`      ... ${semanticSourceFixes.length - 12} more`);
        }
    }
    // ── Still-run distribution ──
    // Runs last, after every source/class/template rewrite has settled, so it
    // measures the runs the build will actually ship — and before query backfill
    // so the scenes it flips to footage get their stock/web queries.
    const stillRunBreaks = _breakStillRuns(enrichedScenes, scriptContext, plannerDirectives);
    if (stillRunBreaks.length > 0) {
        console.log(`   [Still Run Breaker] flipped ${stillRunBreaks.length} scene(s) to footage so no more than ${MAX_CONSECUTIVE_STILLS} stills play back-to-back:`);
        for (const b of stillRunBreaks) {
            console.log(`      Scene ${b.index}: ${b.before.mediaType || 'none'}/${b.before.sourceHint || 'none'} -> video/${b.after.sourceHint} — ${b.reason}`);
        }
    }

    const queryBackfills = _ensureFootageSearchQueries(enrichedScenes, scriptContext);
    if (queryBackfills > 0) {
        console.log(`   [Search Query Policy] backfilled ${queryBackfills} missing stock/web query field(s)`);
    }

    // ── Planner guardrail summary ──
    // Distinguish "AI chose this" from "we corrected it" so it's visible whether
    // the model is actually planning, or the guardrails are doing the work.
    // Loss counters surface every place an AI choice was overridden — high values
    // mean the prompt isn't landing and the guardrails are doing the planning.
    const summary = _buildPlannerSummary(enrichedScenes, {
        ctaGuardStripped,
        kwViolations: kwViolations.length,
        typographyRunFixes: typographyRunFixes.length,
        classFixes: classFixes.length,
        displayTextFixes: displayTextFixes.length,
        nicheMapDrops,
        contextKwFixes: contextKwFixes.length,
        editorIdeaFixes: editorIdeaFixes.length,
        sourceOverrides: (complianceStats.sourceOverrides || 0) + sourceAuditFixes.length + semanticSourceFixes.length,
        mapOverrides: complianceStats.mapOverrides || 0,
        framingOverrides: complianceStats.framingOverrides || 0,
        styleMixAdjusted: complianceStats.styleMixAdjusted || 0,
        graphicsInjected: (complianceStats.graphicsInjected || 0) + numericLowerThirdFixes.length,
        graphicsTrimmed: (complianceStats.graphicsTrimmed || 0) + numericLowerThirdFixes.filter(f => f.before.fullscreenMG || f.before.templateHint).length,
    });
    console.log(summary);
    _logFinalVpDiagnostics(enrichedScenes, scriptContext, globalOutline);

    return enrichedScenes;
}

function _shortVpLog(value, maxLen = 120) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return '-';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
}

function _vpType(value) {
    if (!value || typeof value !== 'string') return null;
    const type = value.split(':')[0].trim();
    return type || null;
}

function _vpLane(sceneLike = {}) {
    if (sceneLike.fullscreenMG) return `fs:${_vpType(sceneLike.fullscreenMG) || 'unknown'}`;
    if (sceneLike.templateHint) return `template:${_vpType(sceneLike.templateHint) || 'unknown'}`;
    if (sceneLike.mgHint) return `overlay:${_vpType(sceneLike.mgHint) || 'unknown'}`;
    if (sceneLike.keyword || sceneLike.mediaType || sceneLike.sourceHint) return 'footage';
    return 'none';
}

function _vpScenePrimary(scene = {}) {
    if (scene.fullscreenMG) return scene.fullscreenMG;
    if (scene.templateHint) return scene.templateHint;
    if (scene.mgHint && scene.keyword) return `${scene.keyword} + ${scene.mgHint}`;
    if (scene.keyword) return scene.keyword;
    if (scene.mgHint) return scene.mgHint;
    return scene.visualIntent || 'none';
}

function _vpSceneChanged(scene = {}) {
    const ai = scene._aiChose || {};
    const changes = [];
    const finalLane = _vpLane(scene);
    const aiLane = _vpLane(ai);
    if (aiLane !== 'none' && aiLane !== finalLane) changes.push(`lane:${aiLane}->${finalLane}`);
    if (ai.sourceHint && scene.sourceHint && ai.sourceHint !== scene.sourceHint) changes.push(`source:${ai.sourceHint}->${scene.sourceHint}`);
    if (ai.mediaType && scene.mediaType && ai.mediaType !== scene.mediaType) changes.push(`media:${ai.mediaType}->${scene.mediaType}`);
    if (ai.framing && scene.framing && ai.framing !== scene.framing) changes.push(`frame:${ai.framing}->${scene.framing}`);
    if (Array.isArray(scene._sourcePolicyFixes) && scene._sourcePolicyFixes.length > 0) {
        const last = scene._sourcePolicyFixes[scene._sourcePolicyFixes.length - 1];
        const typePart = last.beforeType !== last.afterType ? `${last.beforeType || 'none'}->${last.afterType || 'none'} ` : '';
        changes.push(`sourcePolicy:${typePart}${last.beforeSource || 'none'}->${last.afterSource || 'none'}`);
    }
    if (scene._sourceAuditFix) changes.push('sourceAudit');
    if (scene._nicheMapDrop) changes.push('nicheMapDrop');
    if (scene._contextualKeywordAnchor) changes.push(`contextAnchor:${scene._contextualKeywordAnchor}`);
    if (scene._correctedFromFullscreen) changes.push('ctaFsDrop');
    return changes.length ? changes.join(', ') : 'none';
}

function _logFinalVpDiagnostics(scenes, scriptContext = {}, globalOutline = null) {
    if (!Array.isArray(scenes)) return;
    console.log('   [VP Final Decisions] one line per scene after VP guardrails:');
    for (const scene of scenes) {
        const ai = scene._aiChose || {};
        const outline = globalOutline?.sceneHints?.[scene.index];
        const classBits = [
            scene.sceneClass ? `class=${scene.sceneClass}` : null,
            scene.retrievability ? `retr=${scene.retrievability}` : null,
            scene.sceneType ? `phase=${scene.sceneType}` : null,
        ].filter(Boolean).join(' ');
        const mediaBits = [
            scene.mediaType ? `media=${scene.mediaType}` : null,
            scene.sourceHint ? `source=${scene.sourceHint}` : null,
            scene.mediaNeed ? `need=${scene.mediaNeed}` : null,
            scene.framing ? `frame=${scene.framing}` : null,
            scene.backgroundId ? `bgId=${scene.backgroundId}` : null,
        ].filter(Boolean).join(' ');
        const queryBits = [
            scene.stockQuery ? `stock="${_shortVpLog(scene.stockQuery, 70)}"` : null,
            scene.webQuery ? `web="${_shortVpLog(scene.webQuery, 90)}"` : null,
            scene.templateBgQuery ? `templateBg="${_shortVpLog(scene.templateBgQuery, 90)}"` : null,
        ].filter(Boolean).join(' | ');
        const protection = Array.isArray(scene.protectedTerms) && scene.protectedTerms.length
            ? ` | protect=[${scene.protectedTerms.map(t => _shortVpLog(t, 40)).join('; ')}]`
            : '';
        const outlineText = outline
            ? ` | outline=${outline.graphics || '-'}:${_shortVpLog(outline.note || outline.lane || '', 70)}`
            : '';
        console.log(
            `      S${scene.index}: ai=${_vpLane(ai)} final=${_vpLane(scene)} changes={${_vpSceneChanged(scene)}} | ${classBits || 'class=-'} | ${mediaBits || 'media=-'} | visual="${_shortVpLog(_vpScenePrimary(scene), 120)}"${queryBits ? ` | ${queryBits}` : ''}${protection}${outlineText}`
        );
    }
}

function _buildPlannerSummary(scenes, lossBag = {}) {
    // Backward-compat: previous callers passed (scenes, ctaGuardStripped:number).
    // Normalize that into the lossBag shape used below.
    if (typeof lossBag === 'number') lossBag = { ctaGuardStripped: lossBag };
    const {
        ctaGuardStripped = 0,
        kwViolations = 0,
        typographyRunFixes = 0,
        classFixes = 0,
        displayTextFixes = 0,
        nicheMapDrops = 0,
        contextKwFixes = 0,
        editorIdeaFixes = 0,
        sourceOverrides = 0,
        mapOverrides = 0,
        framingOverrides = 0,
        styleMixAdjusted = 0,
        graphicsInjected = 0,
        graphicsTrimmed = 0,
    } = lossBag;

    const total = scenes.length;
    let aiTpl = 0, aiFS = 0, aiMg = 0;
    let finalTpl = 0, finalFS = 0, finalMg = 0;
    let sourceChanges = 0, mediaChanges = 0, framingChanges = 0;
    let aiMapProposed = 0, mapDropped = 0, mapAdded = 0;
    let templateAdded = 0, templateDropped = 0;
    let fullscreenAdded = 0, fullscreenDropped = 0;
    const sourceCounts = {};
    for (const s of scenes) {
        const ai = s._aiChose || {};
        if (ai.templateHint) aiTpl++;
        if (ai.fullscreenMG) aiFS++;
        if (ai.mgHint) aiMg++;
        if (s.templateHint) finalTpl++;
        if (s.fullscreenMG) finalFS++;
        if (s.mgHint) finalMg++;

        // Lane-specific loss accounting.
        const finalFsType = s.fullscreenMG ? String(s.fullscreenMG).split(':')[0].trim() : null;
        const aiIsMap     = typeof ai.fullscreenMG === 'string' && ai.fullscreenMG.toLowerCase().startsWith('map');
        const finalIsMap  = finalFsType && finalFsType.toLowerCase().startsWith('map');
        if (aiIsMap) aiMapProposed++;
        if (aiIsMap && !finalIsMap) mapDropped++;
        if (!aiIsMap && finalIsMap) mapAdded++;
        if (ai.templateHint && !s.templateHint) templateDropped++;
        if (!ai.templateHint && s.templateHint) templateAdded++;
        if (ai.fullscreenMG && !s.fullscreenMG) fullscreenDropped++;
        if (!ai.fullscreenMG && s.fullscreenMG) fullscreenAdded++;

        if (ai.sourceHint && s.sourceHint && ai.sourceHint !== s.sourceHint) sourceChanges++;
        if (ai.mediaType && s.mediaType && ai.mediaType !== s.mediaType) mediaChanges++;
        if (ai.framing && s.framing && ai.framing !== s.framing) framingChanges++;
        const src = s.sourceHint || (s.fullscreenMG ? 'fullscreenGraphics' : 'none');
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    }
    const dist = Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
    const guardrailChanges = sourceChanges + mediaChanges + framingChanges + ctaGuardStripped + kwViolations + typographyRunFixes + classFixes + displayTextFixes + nicheMapDrops + contextKwFixes + editorIdeaFixes;

    // Loss bag — counts every place an AI choice was rewritten, dropped, or
    // injected by a guard. High totals here mean the prompt isn't landing and
    // the guardrails are silently authoring the plan.
    const lossParts = [];
    if (mapDropped > 0)        lossParts.push(`mapRemoved=${mapDropped}`);
    if (mapAdded > 0)          lossParts.push(`mapAdded=${mapAdded}`);
    if (templateDropped > 0)   lossParts.push(`templateRemoved=${templateDropped}`);
    if (templateAdded > 0)     lossParts.push(`templateAdded=${templateAdded}`);
    if (fullscreenDropped > 0) lossParts.push(`fullscreenGraphicsRemoved=${fullscreenDropped}`);
    if (fullscreenAdded > 0)   lossParts.push(`fullscreenGraphicsAdded=${fullscreenAdded}`);
    if (ctaGuardStripped > 0)  lossParts.push(`ctaSceneSafety=${ctaGuardStripped}`);
    if (kwViolations > 0)      lossParts.push(`keywordSafetyFixes=${kwViolations}`);
    if (classFixes > 0)        lossParts.push(`classTreatmentRewrites=${classFixes}`);
    if (displayTextFixes > 0)  lossParts.push(`displayTextPlacement=${displayTextFixes}`);
    if (nicheMapDrops > 0)     lossParts.push(`nicheMapRemoved=${nicheMapDrops}`);
    if (contextKwFixes > 0)    lossParts.push(`contextKeywordRepairs=${contextKwFixes}`);
    if (editorIdeaFixes > 0)   lossParts.push(`editorIdeaFixes=${editorIdeaFixes}`);
    if (typographyRunFixes > 0) lossParts.push(`typographyRunBreaks=${typographyRunFixes}`);
    if (sourceOverrides > 0)   lossParts.push(`sourceOverrides=${sourceOverrides}`);
    if (mapOverrides > 0)      lossParts.push(`mapOverrides=${mapOverrides}`);
    if (framingOverrides > 0)  lossParts.push(`framingOverrides=${framingOverrides}`);
    if (styleMixAdjusted > 0)  lossParts.push(`styleMixAdjusted=${styleMixAdjusted}`);
    if (graphicsInjected > 0)  lossParts.push(`graphicsInjected=${graphicsInjected}`);
    if (graphicsTrimmed > 0)   lossParts.push(`graphicsTrimmed=${graphicsTrimmed}`);
    const lossBlock = lossParts.length > 0 ? ` | rewrites: {${lossParts.join(' ')}}` : '';

    return [
        `   [Planner Summary] ${total} scenes - AI plan: templates=${aiTpl} fullscreenGraphics=${aiFS} overlayGraphics=${aiMg} mapsProposed=${aiMapProposed} | final plan: templates=${finalTpl} fullscreenGraphics=${finalFS} overlayGraphics=${finalMg}`,
        `   [Planner Summary] guardrailChanges=${guardrailChanges} (sourceChanges=${sourceChanges} mediaTypeChanges=${mediaChanges} framingChanges=${framingChanges} ctaSceneSafety=${ctaGuardStripped} keywordSafetyFixes=${kwViolations} contextKeywordRepairs=${contextKwFixes} editorIdeaFixes=${editorIdeaFixes} classTreatmentRewrites=${classFixes} displayTextPlacement=${displayTextFixes} nicheMapRemoved=${nicheMapDrops} typographyRunBreaks=${typographyRunFixes})${lossBlock}`,
        `   [Planner Summary] sources: {${dist}}`,
    ].join('\n');
}

// ============================================================
// PROMPT BUILDER
// ============================================================

/**
 * Build the batch visual planning prompt.
 * AI sees ALL scenes at once and plans visuals with full story context.
 */
function buildBatchPrompt(scenes, scriptContext, directorsBrief, options = {}) {
    const { theme, tone, mood, pacing, format, visualStyle, entities, hookEndTime, ctaDetected, ctaStartTime } = scriptContext;
    const { qualityTier, tier, audienceHint } = directorsBrief;
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche, getSearchPolicy, getKeywordRules } = require('../data/niches');
    const niche = getNiche(nicheId);
    const nicheAllowedMGs = Array.isArray(niche.allowedMGs) ? niche.allowedMGs : [];
    const nicheAllowsMapChart = nicheAllowedMGs.includes('mapChart');
    const fullscreenMGTypes = [
        'articleHighlight',
        'timeline',
        'bulletList',
        'barChart',
        'donutChart',
        'comparisonCard',
        'rankingList',
        ...(nicheAllowsMapChart ? ['mapChart'] : []),
    ].join(', ');

    // Niche-level template allowlist — Step 6.5 strips anything outside this set
    // before assignment. Surface it to the VP so it stops spending tokens on
    // templates that will be killed downstream. listicleGrid is rule-generated,
    // not VP-pickable, so always exclude it from the prompt-facing list.
    const ALL_VP_TEMPLATE_TYPES = [
        'chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway',
        'comparisonCard', 'timelineCard', 'factCard', 'imageShowcase',
        'statCard', 'personIntro', 'splitScreen', 'infographic',
    ];
    const nicheAllowedTemplates = Array.isArray(niche.allowedTemplates)
        ? niche.allowedTemplates.filter(t => t !== 'listicleGrid')
        : ALL_VP_TEMPLATE_TYPES.slice();
    const nicheBannedTemplates = ALL_VP_TEMPLATE_TYPES.filter(t => !nicheAllowedTemplates.includes(t));

    // Final-quarter timestamp for keyTakeaway eligibility — mirrors the
    // deterministic guard in planner-display-guards.js (total * 0.75).
    const _totalDur = Number(scriptContext.totalDuration)
        || (scenes.length ? Number(scenes[scenes.length - 1]?.endTime) || 0 : 0)
        || 60;
    const keyTakeawayMinStart = (_totalDur * 0.75).toFixed(1);

    // Niche source priority (for SOURCE HINTS block). YouTube ranks last for
    // news.* niches because broadcast packages fail strictRaw vision gates and
    // burn the per-scene download budget. Hide demoted sources from the AI so
    // it stops picking them as primary; they remain available as last-resort
    // fallbacks via the downloader's provider walk.
    const nicheVideoPriority = filterDisabledSources(Array.isArray(niche.footagePriority?.video)
        ? niche.footagePriority.video
        : []);
    const nicheScoutDemote = new Set(Array.isArray(niche.scoutDemote) ? niche.scoutDemote : []);
    // Map provider keys to AI-facing sourceHint labels.
    const _providerToHint = (p) => {
        return providerToSourceHint(p);
    };
    const nichePreferredHints = [];
    const seenHints = new Set();
    for (const p of nicheVideoPriority) {
        if (nicheScoutDemote.has(p)) continue;
        const h = _providerToHint(p);
        if (!seenHints.has(h)) { seenHints.add(h); nichePreferredHints.push(h); }
    }
    const nicheDemotedHints = [];
    for (const p of nicheVideoPriority) {
        if (!nicheScoutDemote.has(p)) continue;
        const h = _providerToHint(p);
        if (!seenHints.has(h) && !nicheDemotedHints.includes(h)) nicheDemotedHints.push(h);
    }
    const mapAvailabilityRule = nicheAllowsMapChart
        ? '- mapChart IS AVAILABLE for this niche. When the narration discusses geographic regions, borders, straits, trade routes, military positions, or mentions 2+ countries/locations, use fullscreenMG: "mapChart: Location1: label, Location2: label". Maps are more impactful than generic footage for geographic content. Pick the best scene for it, usually the one introducing locations.'
        : '- mapChart is FORBIDDEN for this niche because it is not in allowedMGs. Geographic narration must use real footage, stock route references, templates, or overlay MGs instead. Do not output fullscreenMG="mapChart: ..." under any condition.';
    const mapFullscreenRules = nicheAllowsMapChart
        ? `     - Scene mentions GEOGRAPHIC LOCATIONS, borders, routes, or geopolitical regions -> "mapChart: Location1: label, Location2: label"
     - Scene describes a SPECIFIC LOCATION being introduced -> "mapChart: Atlanta, Georgia - 1915"
     - IMPORTANT: For narration about straits, trade routes, military positions, borders, or multiple countries, mapChart is STRONGLY preferred over footage. Use it when 2+ locations are mentioned.
     - When using mapChart, also pick a mapVariant based on scene intent:
       - locator -> single place being introduced/spotlit ("the Strait of Hormuz is...")
       - route -> travel/trade/flight path between >=2 points ("ships travel from Shanghai to Rotterdam...")
       - regionHighlight -> one country/region being discussed as a whole ("throughout the Middle East...")
       - comparison -> two or more places contrasted side-by-side ("oil from Saudi Arabia vs Iran...")`
        : `     - Geographic scenes: mapChart is forbidden by this niche allowlist. Do NOT write mapChart in fullscreenMG.
     - For routes, chokepoints, regions, and multi-country scenes, use one of these instead: stock route/map reference, real documentary/news footage, locationCard/comparisonCard/statCard template, or overlay mgHint.`;
    const mapPlanningRules = nicheAllowsMapChart
        ? `       - MAP=preferred:<m>  -> output fullscreenMG="mapChart: <subjects>" with mapVariant=<m>. Skip other lane choices for this scene.
       - MAP=allowed:<m>    -> if the narration is fundamentally about geography, pick mapChart with mapVariant=<m>. If the narration is mostly about a person/quote/stat that happens to mention a place, do NOT pick mapChart.
       - MAP=forbidden      -> never output mapChart, even if you spot place names. Niche policy, hook/CTA rules, or explicit BLOCKED=map blocks it.
       - MAP=n/a            -> skip map entirely.`
        : `       - MAP=preferred/allowed should not appear in this niche; if it does, treat it as MAP=forbidden because mapChart is outside allowedMGs.
       - MAP=forbidden or MAP=n/a -> never output mapChart. Use footage, stock references, templates, or overlays instead.`;
    const outputMapContractRules = nicheAllowsMapChart
        ? `  - If MAP=preferred -> fullscreenMG MUST be a mapChart with the indicated mapVariant.
  - If MAP=forbidden -> fullscreenMG MUST NOT be mapChart.`
        : `  - This niche forbids mapChart. Treat every MAP token as forbidden for fullscreenMG output.`;
    const mapPayloadContractRule = nicheAllowsMapChart
        ? '- mapChart payload contract: must list >=1 concrete place name (locator/region) or >=2 places (route/comparison). "mapChart: this region" with no place names is invalid.'
        : '- mapChart is outside this niche allowlist: never output it. Geographic scenes should become footage, stock references, templates, or overlays.';
    const mapLegendRules = nicheAllowsMapChart
        ? `    forbidden       -> DO NOT output mapChart even if 2+ places appear
    preferred:<m>   -> output fullscreenMG="mapChart: ..." with mapVariant=<m>; do NOT pick another lane
    allowed:<m>     -> mapChart is permitted with that variant; choose it if narration is geographic
    n/a             -> no map signal; choose other lanes`
        : `    forbidden       -> DO NOT output mapChart even if 2+ places appear
    preferred/allowed -> treat as forbidden in this niche because mapChart is outside allowedMGs
    n/a             -> no map signal; choose other lanes`;
    const sourceFamiliesLegend = nicheAllowsMapChart
        ? 'web-image-reference | data-graphics-or-web-image | mapChart | real-footage | stock-mood'
        : 'web-image-reference | data-graphics-or-web-image | real-footage | stock-mood';
    const mgFamiliesLegend = nicheAllowsMapChart
        ? 'map | data | callout | intro | typography | overlay-only'
        : 'data | callout | intro | typography | overlay-only';
    const searchPolicy = getSearchPolicy(nicheId);
    const plannerDirectives = options.plannerDirectives || _buildPlannerDirectives(scenes, scriptContext, directorsBrief);

    if (scriptContext && scriptContext.styleBlock) {
        console.log(`   🎨 [VisualPlanner] Style profile injected into batch prompt: "${scriptContext.styleProfile?.name || 'unnamed'}" (${scriptContext.styleBlock.length} chars)`);
    }

    // Resolve build language for display-text enforcement
    const _langNames = { de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', ko: 'Korean', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese', zh: 'Chinese', ar: 'Arabic', tr: 'Turkish', hi: 'Hindi', sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', el: 'Greek', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', uk: 'Ukrainian' };
    const buildLang = scriptContext.language || 'en';
    const buildLangName = _langNames[buildLang] || buildLang;
    const isNonEnglish = buildLang && buildLang !== 'en';

    // Build scene list with timing info
    // If Scene Classes pass (USE_SCENE_CLASSES=true) attached class/treatment to scenes,
    // inject them per-line so the planner picks strategy deterministically.
    // The CONSTRAINTS line is ALWAYS rendered — derived from existing signals + niche
    // surface + mapPolicy. It tells the planner the structural envelope for each scene
    // BEFORE it picks a lane, so we don't have to fix bad lane picks after the fact.
    const { getNicheMapPolicy: _getMapPolicy } = require('../data/niches');
    const _nicheMapPolicy = _getMapPolicy(nicheId);
    const anyClassTagged = scenes.some(s => s.sceneClass);
    let sceneList = '';
    for (const scene of scenes) {
        const duration = (scene.endTime - scene.startTime).toFixed(1);
        const period = `[${_sceneTagString(scene, scenes, scriptContext)}]`;

        sceneList += `SCENE ${scene.index} (${scene.startTime.toFixed(1)}s-${scene.endTime.toFixed(1)}s, ${duration}s) ${period}:\n`;
        if (scene.sceneClass && scene.treatmentHint) {
            const t = scene.treatmentHint;
            const ladder = Array.isArray(scene.fallbackLadder) ? scene.fallbackLadder.join(' → ') : t.primary;
            sceneList += `   CLASS=${scene.sceneClass} | PRIMARY=${t.primary} | LADDER=${ladder} | SOURCE=${t.preferredSource} | RETRIEVE=${scene.retrievability || 'medium'}\n`;
            // Surface the class-specific MG/template allowlists so the AI doesn't pick
            // a type that's niche-allowed but class-blocked. MAP constraints remain
            // their own lane: mapChart is valid when MAP=preferred/allowed unless
            // MAP=forbidden or BLOCKED=map says otherwise.
            // CRITICAL: split allowedMGs into fullscreen-eligible vs overlay-only — they
            // live in DIFFERENT scene fields. Overlay types in fullscreenMG are dropped
            // downstream; overlay types belong in mgHint paired with a background.
            const allowedMgList = Array.isArray(t.allowedMGs) ? t.allowedMGs.filter(Boolean) : [];
            const allowedTplList = Array.isArray(t.allowedTemplates) ? t.allowedTemplates.filter(Boolean) : [];
            const fsEligible = _filterFullscreenEligible(allowedMgList);
            const overlayOnly = _filterOverlayOnly(allowedMgList);
            if (fsEligible.length > 0) {
                sceneList += `   FULLSCREEN-MGS=${fsEligible.join(',')}   (valid for fullscreenMG field)\n`;
            }
            if (overlayOnly.length > 0) {
                sceneList += `   OVERLAY-MGS=${overlayOnly.join(',')}   (valid for mgHint field — pair with footage or templateHint background)\n`;
            }
            if (allowedTplList.length > 0) {
                sceneList += `   ALLOWED-TEMPLATES=${allowedTplList.join(',')}\n`;
            }
            if (t.blocked && t.blocked.length) {
                sceneList += `   BLOCKED=${t.blocked.join(',')}\n`;
            }
        }
        const outlineHint = options.globalOutline?.sceneHints?.[scene.index] || null;
        sceneList += `   CONSTRAINTS: ${_renderSceneConstraintLine(scene, scenes, scriptContext, niche, _nicheMapPolicy, plannerDirectives, outlineHint)}\n`;
        const editorIdea = _renderEditorIdeaLine(scene);
        if (editorIdea) {
            sceneList += `   ${editorIdea}\n`;
        }
        const contextAnchor = _isContextDependentFootageScene(scene)
            ? _deriveContextualKeywordCandidate(scene, scenes, scriptContext)
            : null;
        if (contextAnchor) {
            sceneList += `   CONTEXT-ANCHOR: ${contextAnchor}   (bridge scene: use this neighborhood anchor for footage keywords; do not invent unrelated cities/places)\n`;
        }
        sceneList += `   "${scene.text}"\n\n`;
    }

    const classLegend = anyClassTagged ? `

SCENE CLASSES & TREATMENT (read before planning):
MAP NOTE: mapChart is its own lane. MAP=preferred/allowed may use fullscreenMG="mapChart: ..." unless MAP=forbidden or BLOCKED=map says no; do not translate a map into lowerThird/statCounter/focusWord.
Each scene carries CLASS (editorial role) and PRIMARY (visual lane to use first). Treat CLASS as the default editorial strategy. MAP=preferred/allowed is its own map lane unless MAP=forbidden or BLOCKED=map says no.
  - PRIMARY=footage  → choose real footage, set keyword + sourceHint, leave fullscreenMG/templateHint null
  - PRIMARY=map      → set fullscreenMG to a map type; keyword is secondary
  - PRIMARY=graphics → use allowed fullscreen data/list MGs or OVERLAY-MGS on a real background; overlay types do not belong in fullscreenMG
  - PRIMARY=template → set templateHint to one of the allowed templates; skip footage
BLOCKED lists lanes you MUST NOT pick for that scene.
RETRIEVE=internal-only means the scene has NO external visual referent — do NOT set keyword or webQuery; use PRIMARY only.
LADDER is the fallback order if PRIMARY is unavailable. Stay on PRIMARY unless clearly wrong.
SOURCE is the concrete footage provider to prefer when PRIMARY=footage (e.g. youtube for news actors, stock for history).
FULLSCREEN-MGS = the only types you may set as fullscreenMG on this scene. ONLY 7 types are fullscreen-eligible globally: barChart, donutChart, rankingList, timeline, comparisonCard, bulletList, mapChart. If FULLSCREEN-MGS is missing or empty, this scene's class does NOT support a non-map fullscreen MG — leave fullscreenMG=null and use OVERLAY-MGS instead, unless MAP=preferred/allowed picks mapChart.
OVERLAY-MGS = types valid only for the mgHint field. focusWord, kineticText, headline, callout, statCounter, lowerThird, dataBar, percentageCircle, broadcastLogo, typographyReveal etc. are OVERLAY-ONLY: they MUST sit on a real background — pair the mgHint with either (a) keyword + sourceHint to fetch footage, or (b) templateHint to draw a template background. locationCard/quoteCard/statCard/factCard/chapterCard are TEMPLATE types, not mgHint overlays. Putting an overlay type in fullscreenMG will be silently moved to mgHint and a template/footage background will be invented for you.
ALLOWED-TEMPLATES lists the specific templateHint types valid for that scene's class. STRICTER than niche, picking outside the list will be rewritten.` : '';

    const constraintsLegend = `

PER-SCENE CONSTRAINTS LEGEND (read before planning each scene):
Each scene now carries a deterministic CONSTRAINTS line derived from the narration + niche map policy + niche allowlist + scene class. THESE ARE HARD STRUCTURAL RULES — not suggestions:
  ROLE — primary editorial role of the scene:
    geo-establish | geo-route | geo-region | geo-compare → MAP scene (see MAP DECISION FIRST below)
    person-intro    → first-time named person → portrait or personIntro template; NEVER fullscreenMG
    quote-beat      → direct quote → quoteCard / callout; never raw stock B-roll alone
    stat-beat       → ≥2 numbers in narration → statCard / barChart / donutChart / rankingList preferred
    escalation-news → state actor + military/political verb → real footage (youtube/reddit), NEVER stock
    abstract-breathing-room → mood / metaphor → focusWord / kineticText (overlay) / mood B-roll
    concept-explainer → no concrete subject → typography or template, AVOID forced footage searches
    product-demo    → tech reveal/launch → real footage of the product/event
    generic         → no signal — pick the most editorial choice
  MAP — map intent for THIS scene:
${mapLegendRules}
  FS-MG — fullscreen MG framing budget:
    allowed         → fullscreenMG (map/graphics/data) is editorially valid here
    discouraged     → prefer overlay mgHint or templateHint instead of replacing the footage
    forbidden       → never set fullscreenMG (CTA, or hook without an explicit first-hook map request)
  STOCK — free-stock library suitability:
    ok              → Pexels/Pixabay is valid IF the narration is concrete generic action/process with no exact identity
    disallowed      → narration names entities/actors/people — stock libraries have NO matches; pick a real-source family or graphics
  SOURCE-HINT - legacy soft source guess when this scene uses an external media lane. The Media Agent decides the final provider mission later:
    web-image       -> Bing still/reference image; use for exact people, brands, labels, model plates, screenshots, documents, diagrams, historical stills
    youtube/reddit  -> real moving footage; use for specific demos, reviews, factory tours, real events, raw community/broadcast clips
    stock           -> Pexels/Pixabay concrete generic B-roll
  OUTLINE-SOURCE - source picked by the full-video outline; preserve it unless the scene text clearly needs a different source
  SRC - preferred source family:
    ${sourceFamiliesLegend}
  MG-FAMILIES — which MG types are editorial-fit for this scene:
    ${mgFamiliesLegend}

PLANNING ORDER (FOLLOW STRICTLY — do not collapse maps into the generic fullscreen lane):
  1. MAP DECISION FIRST — for every scene check the MAP token:
${mapPlanningRules}
  2. After locking the map decision, choose the lane for the remaining scenes using ROLE + MG-FAMILIES + STOCK + SOURCE-HINT + OUTLINE-SOURCE:
       • person-intro       → portrait (web-image) or templateHint=personIntro; sourceHint=web-image; mediaType=image.
       • quote-beat         → templateHint=quoteCard or mgHint=callout. Footage allowed only as backdrop with the overlay.
       • stat-beat          → templateHint=statCard / fullscreenMG=barChart|donutChart|rankingList. Use real numbers from narration.
       • escalation-news    → real footage from the niche's top source (NEVER stock).
        • abstract-breathing-room → typography (focusWord / kineticText) or a concrete establishing/process shot only if it genuinely supports the beat.
       • concept-explainer  → typography or template. Do NOT force a footage keyword that has no concrete referent.
  3. Respect FS-MG=discouraged by preferring overlay/template instead of replacing the footage.
  4. Respect STOCK=disallowed by using SOURCE-HINT/OUTLINE-SOURCE or the niche's best non-stock source.

EDITOR-IDEA LINES:
  Some scenes include EDITOR-IDEA from the AI Director. Treat it as the scene's intended edit beat.
  - Match keyword/source/media to the EDITOR-IDEA visual, not to a vague summary of the whole sentence.
  - If lowerThird is present and appears in this scene's narration, prefer mgHint="lowerThird: <that text>" unless a stronger fullscreen/template treatment is clearly required.
  - Do not merge neighboring EDITOR-IDEA beats conceptually. Named competitors/entities in adjacent scenes should receive distinct visuals.

These rules are deterministic. If you ignore them, downstream guards will rewrite your output and the scene loses your editorial framing.`;

    // Build topic anchor from summary + web context
    const summary = scriptContext.summary || '';
    const webContext = scriptContext.webContext || '';
    const eventType = scriptContext.eventType || '';
    const eventAnchor = scriptContext.eventAnchor || '';
    const videoTitle = scriptContext.videoTitle || '';
    let topicBlock = '';
    if (summary || webContext || videoTitle) {
        topicBlock = `\nTOPIC CONTEXT (use this to stay on-topic and pick relevant visuals):`;
        if (videoTitle) {
            topicBlock += `\n- VIDEO TITLE: "${videoTitle}" — This is the video's title. Use it to understand the overall subject and guide your keyword choices.`;
        }
        if (summary) {
            topicBlock += `\n- Summary: ${summary}`;
        }
        if (eventType) {
            const eventLabels = {
                'real-past': '⚠️ This is a REAL EVENT that already happened — search for REAL footage, photos, and news clips. Do NOT use stock footage for scenes about this event.',
                'real-ongoing': '⚠️ This is a REAL ONGOING EVENT — search for REAL footage and news coverage. Do NOT use stock footage for scenes about this event.',
                'speculative': 'This is speculative/hypothetical — use a mix of real reference footage and mood B-roll.',
                'educational': 'This is educational content — use documentary footage, diagrams, and explainers.',
                'fictional': 'This is fictional — use cinematic/stock footage for mood and atmosphere.',
            };
            topicBlock += `\n- Event type: ${eventLabels[eventType] || eventType}`;
        }
        if (eventAnchor) {
            topicBlock += `\n- ⚡ EVENT ANCHOR: "${eventAnchor}" — For scenes directly about THIS event, INCLUDE the event name in your keyword so searches find REAL footage of THIS incident. Example: instead of "ship fire damage" use "${eventAnchor} fire damage". Instead of "crew sleeping on floor" use "${eventAnchor} crew displaced". For generic/background scenes (nature, mood, equipment) you don't need the anchor.`;
        }
        if (webContext) {
            topicBlock += `\n- Research: ${webContext.substring(0, 1500)}`;
        }
        topicBlock += `\n`;
    }

    // Build cross-chunk awareness block
    const previousKeywords = options.previousKeywords || [];
    const globalOutline = options.globalOutline || null;
    let chunkBlock = '';
    if (previousKeywords.length > 0) {
        chunkBlock = `\nALREADY USED KEYWORDS (from previous scenes — DO NOT repeat these):
${previousKeywords.map(k => `- "${k}"`).join('\n')}

You MUST pick DIFFERENT keywords for the scenes below. Vary your visuals!\n`;
    }
    const outlineBlock = _renderGlobalOutlineBlock(globalOutline, scenes);

    const _isTalkingHead = scriptContext && scriptContext.productionMode === 'talkingHead';
    let prompt = (_isTalkingHead
        ? `You are a visual director planning B-ROLL FOOTAGE for a TALKING-HEAD VIDEO. A recurring on-camera presenter appears at a few key beats (added automatically). Scenes tagged PRESENTER=hold ARE the host — plan NOTHING for those (no keyword/MG/template). Scenes tagged PRESENTER=split show the host BESIDE B-roll — DO plan normal footage for those (the B-roll half). EVERY OTHER scene is B-roll. Never plan or accept footage showing OTHER on-camera presenters/anchors.`
        : `You are a visual director planning B-ROLL FOOTAGE for a FACELESS VIDEO.`) + `

The AI Director has analyzed this script and provided deep context. Your job is to plan SPECIFIC, SEARCHABLE visuals for EVERY scene that:
1. Match the story's theme, mood, and pacing
2. Create visual variety across the video (don't repeat the same type of shot)
3. Use the ENTITIES and context to be specific (not generic)
4. Consider the story arc (hook → body → CTA)
5. INTELLIGENTLY mix sources: stock video, YouTube clips, and web images
${isNonEnglish ? `
🔴🔴🔴 MANDATORY LANGUAGE RULE — THIS VIDEO IS IN ${buildLangName.toUpperCase()} 🔴🔴🔴
ALL viewer-facing text you write MUST be in ${buildLangName}. This applies to:
- mgHint content text (e.g., "statCounter: 75% Energieeinsparung" NOT "75% Energy Savings")
- fullscreenMG data text (e.g., "comparisonCard: Öffentliches Bild vs Private Realität")
- templateHint content text (e.g., "statCard: Energie -75% Stromrechnung")
- Any labels, titles, descriptions that will appear ON SCREEN
The ONLY exception: keyword, stockQuery, webQuery stay in ENGLISH (search engines need English).
This rule applies to EVERY scene — do NOT switch to English for any display text.
🔴🔴🔴 END LANGUAGE RULE 🔴🔴🔴
` : ''}${topicBlock}
${directorsBrief.freeInstructions ? `\n🔥 USER INSTRUCTIONS (HIGHEST PRIORITY — OVERRIDE ALL DEFAULTS):
${directorsBrief.freeInstructions}

↑ These instructions are MANDATORY. Follow them exactly, even if they conflict with the rules below.\n` : ''}
${(scriptContext && scriptContext.styleBlock) ? `\n${scriptContext.styleBlock}

↑ Use this as INSPIRATION for footage variety and shot composition. Niche rules and theme settings below still take priority for MG types and effects.\n` : ''}
${_renderPlannerDirectiveBlock(plannerDirectives, scriptContext)}
${chunkBlock}
${outlineBlock}
DIRECTOR'S ANALYSIS:
- Theme: ${theme || 'general'}
- Tone: ${tone || 'informative'}
- Mood: ${mood || 'neutral'}
- Pacing: ${pacing || 'moderate'}
- Visual Style: ${visualStyle || 'cinematic'}
- Format: ${format}
${entities.length > 0 ? `- Key Entities: ${entities.join(', ')}` : ''}
${hookEndTime ? `- Hook Period: 0-${hookEndTime}s (needs strong visuals to grab attention)` : ''}
${ctaDetected ? `- CTA Period: ${ctaStartTime}s-end (wind down, show branding/channel elements)` : ''}
${audienceHint ? `- Target Audience: ${audienceHint}` : ''}
- Event Anchor: ${scriptContext.eventAnchor || 'none'}
- Main Points: ${scriptContext.mainPoints?.length ? scriptContext.mainPoints.slice(0, 6).join(' | ') : 'none'}
- Section Labels: ${scriptContext.sections?.length ? scriptContext.sections.map(s => typeof s === 'string' ? s : s?.title).filter(Boolean).slice(0, 8).join(' | ') : 'none'}
- Content Niche: ${niche.name} (${niche.description})
${format === 'listicle' && scriptContext.listicleItems ? require('../formats/listicle-format').getListiclePromptRules(scriptContext.listicleItems) : ''}

SEARCH STRATEGY:
- A keyword must describe what the SHOT LOOKS LIKE — the concrete, visible subject of THIS scene (e.g. ship, tanker, port, harbor, refinery, soldier, crowd, building, map). Reason the right visual subject from the scene's meaning and its entities. You are the editor — pick the words; nothing is dictated to you.
- For STOCK providers (Pexels/Pixabay): SHORT keywords, max ${searchPolicy.stockMaxWords || 3} words. These free stock libraries search literal subjects/actions, not the topic's theme.
- Do NOT append abstract/thematic words to a keyword (the niche/topic label, "policy", "geopolitical", "analysis", "overview", "strategy", "concept", "documentary"). They don't index on footage libraries and wreck the search — a clean visual noun beats a themed phrase every time.
- Entity names (people, companies, specific places) help WEB searches; for STOCK use the plain visual subject.

⚠️ AVAILABLE VIDEO SOURCES FOR THIS NICHE (${niche.name}) — PRIORITY ORDER:
${(() => {
    const sourceDescriptions = {
        youtube:      'YouTube — match highlights, documentaries, tours, training footage, interviews',
        reddit:       'Reddit — TV broadcast captures, match highlights, drone footage (BEST FOR SPORTS)',
        stock:        'Pexels/Pixabay — free stock B-roll for concrete generic actions/process/settings',
    };
    const videoPriority = [...new Set(
        filterDisabledSources(niche.footagePriority?.video || ['youtube', 'pexels', 'pixabay', 'reddit'])
            .map(providerToSourceHint)
            .filter(Boolean)
    )];
    return videoPriority.map((src, i) => `  ${i + 1}. ${src} — ${sourceDescriptions[src] || src}`).join('\n');
})()}
- stock — Pexels/Pixabay concrete generic B-roll or generic imagery
- web-image — Bing/Brave exact still/reference imagery for photos, maps, portraits, labels, logos, data, documents

⚠️ CRITICAL SOURCE RULES:
- You MUST prefer sources #1 and #2 for MOST scenes (aim for 70%+ of video scenes)
- "stock" (Pexels/Pixabay) = concrete generic actions/process/settings with NO exact entity
- stock does NOT have: match footage, player clips, sports highlights, specific events, named athletes
- If a scene shows a specific real action, named person, exact event, brand, model, or proof requirement → use real/reference sources, NOT stock
${(() => {
    const videoPriority = _videoPriorityForVp(niche, 'youtube');
    const topSrc = videoPriority[0] || 'youtube';
    const stockIdx = videoPriority.indexOf('stock');
    const isStockLast = stockIdx >= 0 && stockIdx >= videoPriority.length - 2;
    if (isStockLast) return `- FOR THIS "${niche.name}" NICHE: stock should be RARE. Use "${topSrc}" or "${videoPriority[1] || 'youtube'}" for action/event scenes.`;
    return '';
})()}

QUALITY TIER: ${qualityTier}
${tier.allowVideo ? '- Can use VIDEO clips (preferred for motion and impact)' : '- IMAGES ONLY (no video allowed)'}

AVAILABLE EFFECT PRESETS FOR THIS THEME (${scriptContext.themeId || 'standard'}):
${(() => {
    const EFFECT_PRESETS = require('../render/effect-presets');
    const activeTheme = scriptContext.themeId || 'standard';
    const presets = Object.entries(EFFECT_PRESETS)
        .filter(([k, p]) => k !== 'none' && p.themes && (p.themes.includes('*') || p.themes.includes(activeTheme)))
        .map(([k, p]) => `${k}: ${p.description || p.label}`)
        .join('\n');
    return presets || 'none available';
})()}
- Pick ONE effect preset per scene from the list above, or "none" for no effect.
- These are pre-made combos (grain+scratches+color grading etc) — NOT individual effects.
- ONLY use presets listed above — do NOT use presets not in the list.
- Don't overuse effects — ~40-50% of scenes should be "none"
- HOOK scenes benefit from subtle effects for visual impact

ALLOWED MOTION GRAPHICS FOR THIS NICHE (${niche.name}):
${nicheAllowedMGs.join(', ')}
- Suggest an MG only when the scene content clearly benefits from one.
- NOT every scene needs an MG — use "none" for scenes that work best as pure footage.
- Fullscreen MGs (barChart, donutChart, rankingList, timeline, comparisonCard, bulletList, mapChart) replace the footage entirely — use sparingly for impact.
- Overlay MGs (focusWord, kineticText, lowerThird, headline, statCounter, callout, etc.) appear ON TOP of footage or a templateHint background — they MUST sit on a real background, never in fullscreenMG.
${mapAvailabilityRule}

SCENES TO PLAN (${scenes.length} total):
${classLegend}${constraintsLegend}
${sceneList}

PLANNING RULES:

1. VISUAL VARIETY:
   - Look at ALL scenes — plan a visual journey
   - Vary shot types: wide shots, close-ups, aerials, POV, establishing shots
   - Vary subjects: locations → people → objects → actions → data
   - NEVER use the same keyword twice
   - Example: If scene 1 shows "city skyline at night", scene 2 should show something different like "police car with flashing lights"

2. CONTENT TYPE & SOURCE SELECTION (MATCH CONTENT TO BEST SOURCE):

   **Priority 1: EXACT STILL REFERENCES** -> web-image
   - Named people, real brands, logos, labels, model plates, city signs, screenshots, documents, diagrams, product stills, historical photos, and dated proof shots use Bing/web-image.
   - Example: "Gene Hackman photo" -> web-image
   - Example: "Honda GX engine 1985 model plate" -> web-image

   **Priority 2: DATA/STATS** -> graphics first, web-image for exact reference images
   - Numbers, charts, graphs, rankings, comparisons -> use statCard/barChart/rankingList/fullscreenMG when possible.
   - If an external still is needed, use web-image, not stock.
   - Example: "unemployment rate chart" -> fullscreenMG/statCard or web-image

   **Priority 3: REAL EVENTS / ACTION** → use top niche sources (see AVAILABLE VIDEO SOURCES above)
   - Current events, breaking news, match highlights, action footage
   - Use the #1 and #2 sources from the niche priority list above
   - Example: "tennis serve ace" → use top niche source, NOT stock

   **Priority 4: ABSTRACT MOOD / SCENERY** → stock (ONLY if no entity/event)
   - ONLY for: sunsets, rain, generic crowds, abstract backgrounds, nature
   - NOT for: any named person, specific event, sport action, real footage
   - Example: "sunset over stadium" → stock

   **CRITICAL**: Don't default to stock for exact proof. Use stock only for concrete generic action/process/settings with no named identity. For any specific real action, person, event, brand, or proof requirement → use the top real/reference sources.

3. SOURCE HINTS (SOFT PLANNER GUESS ONLY; MEDIA AGENT CHOOSES FINAL PROVIDER):
   Valid sourceHint values: "stock", "youtube", "web-image", "reddit".

   SOFT SOURCE MEANING:
   - "stock" = Pexels/Pixabay free generic B-roll. Use it for hands-on actions, process shots, non-branded settings, tools, workbenches, stores, labs, factories, kitchens.
   - "web-image" = Bing/Brave exact still/reference search. Use it for exact people, brands, logos, labels, model plates, city signs, facilities, documents, screenshots, diagrams, historical photos, and any scene where a generic stock lookalike would be wrong.
   - "youtube" = real moving footage: product demos, factory tours, brand/product footage, reviews, walkthroughs, real events, real locations.
   - "reddit" = community/broadcast/drone/dashcam clips when that is the natural source.

   SOURCE DECISION TESTS (apply before every scene):
   - If mediaType="image" and the scene contains a real brand, product name, logo, label, model plate, city/place sign, document, screenshot, diagram, historical still, or exact photo -> sourceHint MUST be "web-image".
   - If mediaType="image" and sourceHint="stock", the image must be generic and non-specific. No named brands, no exact screenshots, no labels, no exact locations.
   - If mediaType="video" and the scene needs real moving footage of a specific brand/product/place/event/demo/factory/review/tour/interview -> sourceHint MUST be "youtube" (or "reddit" only for raw community/broadcast/drone/dashcam clips).
   - If mediaType="video" and sourceHint="stock", the shot must be concrete generic B-roll with no exact entity requirement.
   - If the best visual is a static exact reference, choose image + web-image. If the best visual is real motion, choose video + youtube/reddit. If the best visual is generic concrete action/process, choose stock.

   **"youtube"** — Documentaries, tours, behind-the-scenes, equipment footage:
   - Real politics/military events through approved channel-scoped search
   - Military interiors (aircraft carrier bridge, cockpit, engine room, command center)
   - Factory/facility tours, equipment demonstrations, training exercises
   - Historical documentaries, archival footage, analysis clips
   - Vehicle/ship/aircraft walkarounds, how-it-works videos
   - Example: "aircraft carrier damage control training" → youtube
   - Example: "F-35 cockpit view" → youtube
   - Example: "Navy berthing quarters tour" → youtube

   **"stock"** — Pexels/Pixabay free stock for concrete generic B-roll with NO exact entity:
    - Hands-on actions: tools, repair, assembly, cooking prep, testing, cleaning, product use
    - Real processes: factory floor, warehouse, lab bench, workshop, retail shelf, kitchen, workbench
    - Generic lifestyle only when it shows a specific action the viewer can understand
    - Abstract/nature mood shots only when the narration explicitly needs an establishing or breathing-room shot
    - Generic non-branded objects/actions where free stock can realistically have a lookalike
   - ⚠️ NEVER use stock for: military scenes, ship interiors, specific equipment, named events, investigations, forensics
   - ⚠️ Stock sites do NOT have: military interiors, sabotage footage, NCIS investigations, damaged ships, exhausted soldiers
   - Example: "stormy ocean waves" → stock
   - Example: "woman typing on laptop" → stock

   **"reddit"** — Community-uploaded video clips (BEST FOR SPORTS & MILITARY):
   - Sports highlights: broadcast captures, match clips, reactions (landscape TV footage)
   - Military/combat: drone footage, missile launches, satellite imagery, dashcam
   - Crime: bodycam footage, dashcam chases, press conferences
   - ⚠️ Reddit is ~70% vertical phone recordings — ONLY use for niches with broadcast/drone content
   - ⚠️ DO NOT use reddit for: celebrity, tech, entertainment (barely any hosted video on those subs)
   - Example: "tennis match point rally" → reddit (broadcast capture)
   - Example: "drone strike footage" → reddit (military subreddits)
   - Example: "police bodycam pursuit" → reddit (police bodycam pursuit)

   **"web-image"** - Specific photos, maps, data, portraits:
   - Specific real people (photos, portraits, headshots)
   - Maps, routes, geographic locations
   - Data visualizations (charts, graphs, infographics)
   - Historical photos, diagrams, technical illustrations
   - Example: "Elon Musk portrait" -> web-image
   - Example: "Persian Gulf naval route map" -> web-image

   ⚠️ NICHE SOURCE PRIORITY (niche=${nicheId}) — HARD RULE:
     Preferred sourceHints for raw footage in this niche (in order): ${nichePreferredHints.length ? nichePreferredHints.join(' > ') : '(none configured — use defaults)'}
${nicheDemotedHints.length ? `     DEMOTED (use only as last resort, NEVER as your first pick): ${nicheDemotedHints.join(', ')}
     Reason: this niche's content (news/military events) on these sources is dominated by broadcast packages and edited content that fail downstream raw-footage vision checks. They consume the per-scene download budget without producing usable clips.
     What this means in practice:
       • For real events, named conflicts, military action → sourceHint: "youtube" (approved channel-scoped search)
        • For concrete generic B-roll, process/action shots, non-branded hardware → sourceHint: "stock" (Pexels/Pixabay free stock)
       • For broadcast captures, drone/dashcam, combat clips → sourceHint: "reddit"
       • For maps, portraits, infographics → sourceHint: "web-image"
       • sourceHint: "${nicheDemotedHints[0]}" — ONLY if no other source can possibly fit (rare). Do NOT use it as a default for "documentaries" or "tours" in this niche — those usually fail strictRaw too.
` : `     Use youtube for real events/interiors/equipment/training, reddit for drone/dashcam/broadcast captures, web-image for exact maps/portraits/reference stills. Use stock for concrete generic hands-on/process shots; avoid abstract mood stock unless the scene explicitly needs it.
`}

4. MEDIA TYPE SELECTION:
${tier.allowVideo
    ? `   - Prefer VIDEO for: action scenes, locations, events, motion-heavy moments
   - Use IMAGE for: data/stats, specific people, charts, historical photos
   - NICHE PREFERENCE: This "${niche.name}" content works best with ${
       niche.preferredMediaType === 'video' && nicheId.startsWith('news') ? 'HEAVILY VIDEO (aim for ~80-85% video, 15-20% image) — news/military content MUST be dominated by real video footage. Only use image for specific portraits, data charts, or historical photos'
     : niche.preferredMediaType === 'video' ? 'MORE VIDEO clips (aim for ~70% video, 30% image) — this niche needs motion and energy'
     : niche.preferredMediaType === 'image' ? 'MORE IMAGES (aim for ~60-70% image, 30-40% video) — this niche relies on photos, stills, and evidence'
     : 'a BALANCED MIX of video and images (~50/50) — use whichever fits each scene best'
   }
   - But ALWAYS override this preference when the scene content clearly calls for the other type (e.g., a named person → image regardless of niche)`
    : `   - IMAGES ONLY (quality tier: ${qualityTier})`}

5. HOOK PERIOD (first ${hookEndTime || 15}s):
   - Use STRONG, ATTENTION-GRABBING visuals
   - Prefer dynamic VIDEO over static images
   - Match the emotional hook (if dramatic → intense visuals, if mysterious → dark/intriguing)

6. CTA PERIOD (${ctaDetected ? `${ctaStartTime}s onwards` : 'N/A'}):
   - Wind down with calmer visuals
   - Can show branding elements, channel graphics, recap moments

 7. ENTITY AWARENESS (CRITICAL):
   - GLOBAL ENTITY SOURCE RULE: exact people, exact brands, exact facilities, exact model labels, exact city/place signs, exact documents/screenshots/diagrams -> mediaType "image" + sourceHint "web-image" unless the scene specifically needs moving demo/factory/event footage, then use "youtube".
   - **PEOPLE**: When a scene mentions a REAL PERSON by name → you MUST show THEIR PHOTO
     ${entities.length > 0 ? `• Key people in this story: ${entities.slice(0, 5).join(', ')}` : ''}
     • Use mediaType: "image" (photos of people are images, not video)
     - Use sourceHint: "web-image" (Bing has exact public/reference photos)
     • Use their REAL NAME in keyword (e.g., "Gene Hackman portrait photo", "Betsy Arakawa photo")
     • Example: "They found the body of John Smith" → keyword: "John Smith photo", mediaType: image, sourceHint: web-image
   - If any older instruction says people/photos use stock, ignore it: exact people/photos use web-image.
   - **LOCATIONS**: Use specific place names (e.g., "Santa Fe mansion" not "luxury house")
   - **COMPANIES**: Show their products/branding (e.g., "Tesla Model 3" not "electric car")
   - **NEWS/CURRENT EVENTS**: When the scene describes a specific real-world event, conflict, or development:
     • Use sourceHint: "youtube" — approved channel-scoped search for real politics/military footage
     • Use sourceHint: "youtube" for: wars, military operations, missile strikes, naval confrontations, troop movements, combat, protests, elections, political speeches, sanctions, summits, diplomacy
     • The keyword should be the EVENT or TOPIC (e.g., "Iran Saudi Arabia tensions", "NATO summit 2024")
   - **YOUTUBE SCENES**: When the scene describes something found in documentaries or real-world footage that ISN'T breaking news:
     • Use sourceHint: "youtube" — real footage from YouTube (tours, documentaries, reviews, behind-the-scenes)
     • Use "youtube" for: military interiors (aircraft carrier bridge, cockpit, engine room), factory tours, historical footage, equipment demonstrations, vehicle/ship/aircraft walkthroughs, training exercises
     • Example: "inside aircraft carrier command center" → youtube (navy tour videos)
     • Example: "F-35 cockpit view" → youtube (pilot footage, military documentaries)
     • Example: "oil refinery operations" → youtube (industrial documentaries)
    - **STOCK SCENES**: When the scene describes concrete generic action/process with no exact entity:
      • Use sourceHint: "stock" — free Pexels/Pixabay B-roll for real-looking generic actions
      • Use "stock" for: hands using tools, repair benches, assembly lines, cooking prep, lab work, retail shelves, warehouse work, generic device close-ups, non-branded product use
      • Example: "person repairing appliance" → stock (hands-on generic repair)
      • Example: "factory worker assembly line" → stock (generic process B-roll)
   - **REDDIT SCENES**: When the scene describes sports highlights or military/combat footage with broadcast or drone footage:
     • Use sourceHint: "reddit" — broadcast captures and drone/dashcam footage from subreddits
     • Use "reddit" for: sports highlights (TV broadcast captures), military drone footage, bodycam/dashcam clips, combat footage
     • ⚠️ Do NOT use reddit for: celebrity, tech, entertainment (almost no hosted video on those subs)
     • Example: "UFC knockout highlights" → reddit (broadcast capture)
     • Example: "drone strike on tank column" → reddit (combat footage sub)
   - **BUSINESS/CORPORATE SCENES**: When the niche is business/corporate:
     • Use sourceHint: "youtube" for: real product demos, company HQs, factory tours, CEO interviews, product launches, brand stores, real-world business footage
     • Use sourceHint: "reddit" for: consumer reactions, product comparisons, brand fails/wins, viral business moments
     • Use sourceHint: "stock" ONLY for generic filler: someone typing on laptop, checking bills, office hallway, angry customer on phone, handshake — generic human actions with no specific entity
     • Example: "Nike's new factory in Vietnam" → youtube (real factory footage)
     • Example: "Tesla Cybertruck delivery" → youtube (real delivery event footage)
     • Example: "customers are angry about the price increase" → stock (generic angry person)
     • Example: "the CEO checking quarterly reports" → stock (generic person at desk)
     • ⚠️ Business = REAL PRODUCTS, REAL BRANDS, REAL BUILDINGS. Use youtube/reddit for anything with a named entity. Stock only for faceless generic visuals.
   - **SOURCE DIVERSITY IS MANDATORY** — NO source should appear on more than 50% of video scenes. Spread across providers:
     • youtube → specific real events, named conflicts, actual military/news/political footage
     • reddit → broadcast captures, drone/dashcam footage, bodycam clips, viral clips
     • youtube → documentaries, tours, behind-the-scenes, training footage, equipment reviews
      • stock → concrete generic B-roll (hands-on actions, process shots, non-branded settings); avoid abstract mood/aerial filler
     • web-image → maps, portraits, infographics, specific photos
   - DISTRIBUTION TARGET${nicheDemotedHints.length ? ` (niche=${nicheId}, youtube demoted)` : ''}: For a 20-scene news video, ${
        nicheDemotedHints.length
            ? `aim for ~7-9 youtube, ~4-6 stock (free generic process/action B-roll), ~3-5 reddit, ~2-3 web-image, ~0-1 ${nicheDemotedHints[0]} (last resort)`
            : `aim for ~8-10 youtube, ~3-5 reddit, ~2-3 web-image, ~0-1 stock`
   }
   - DO NOT just default everything to one source. Each scene should use the BEST source for its specific content.
   - Be SPECIFIC, not generic! Use the entity names we found!

   **VAGUE/ABSTRACT NARRATION (for scenes with no concrete visual):**
   - This rule ONLY applies when the narration is truly ABSTRACT (e.g., "sustained behaviors", "documented interviews", "contemporaries verified") with NO concrete visual.
   - In that case, use the TOPIC CONTEXT to pick a CONCRETE, SEARCHABLE visual that relates to the story.
   - Example: topic "Sammy Davis Jr" + narration "documented interviews" → keyword: "Sammy Davis Jr interview 1960s"
   - ⚠️ This rule does NOT apply when the narration IS concrete. If scene says "cuts energy bills by 75%" → that IS concrete → keyword should be about energy bills, NOT the broader topic.
   - TEST: Does this scene's text describe something a viewer could picture? If YES → keyword from the scene text. If NO → use topic context.

   **NO SPOILERS — keyword must match what the VIEWER knows (CRITICAL):**
   - The keyword must reflect what the NARRATION actually says in THIS scene, not what you know from context.
   - If a scene is an INTRODUCTION/TEASER that says "the man who..." or "but first, we need to understand..." WITHOUT naming the person/topic yet → the keyword must be GENERIC (e.g., "Hollywood director 1910s", "old film projector"), NOT the person's name or specific work.
   - The REVEAL should happen in the NEXT scene where the name/topic is actually spoken.
   - Example: Scene says "But first, we need to understand how the man who led..." → keyword: "vintage Hollywood studio", NOT "D.W. Griffith" or "Birth of a Nation"
   - Example: Scene says "Number nine, DW Griffith" → NOW use keyword: "D.W. Griffith portrait"
   - This prevents showing the viewer WHO or WHAT is being discussed before the narrator reveals it.

   **PERSON INTRODUCTION (listicle/ranked items):**
   - When a scene FIRST NAMES a person (e.g., "Number nine, DW Griffith"), the keyword MUST be their name + "portrait" or "photo" for a clear face shot.
   - Example: "Number nine, DW Griffith. Before there were racist..." → keyword: "D.W. Griffith portrait", NOT "Birth of a Nation poster"
   - The PORTRAIT/PHOTO of the person should appear on the scene where they are NAMED, not on earlier teaser scenes or later detail scenes.

8. VISUAL INTENT:
   - Describe the EXACT shot you want
   - Include: camera angle, lighting, subject, action, mood
   - SHOT STYLE FOR THIS NICHE: ${niche.shotStyle || 'Mix of wide shots, close-ups, and varied perspectives.'}
   - Example: "Aerial drone shot of abandoned mansion at twilight with police tape"
   - Example: "Close-up of hands typing on laptop keyboard, data on screen, dark room"

9. FRAMING (how the footage fills the 16:9 frame):
   - "fullscreen" = media fills the entire frame edge-to-edge (DEFAULT for most scenes)
   - "cinematic" = pulled back with a styled background visible behind the footage
   - "floating" = smaller frame with rounded corners, drop shadow, on a styled background (like a photo/slide on a surface)

   USE "fullscreen" FOR (MOST scenes should be this):
   - Generic B-roll: cityscapes, nature, actions, establishing shots
   - Stock video footage — it's already 16:9, looks best filling the frame
   - Any scene where the visual works as a full-bleed background

   USE "cinematic" FOR:
   - Web images of REAL PEOPLE (portraits, headshots) — gives breathing room, looks polished
   - Screenshots, charts, data images, infographics — important content at edges would be cropped
   - News footage with on-screen graphics/tickers — don't crop out the lower-third
   - Historical photos, archival images — respect the original framing
   - Any image where the subject is CENTERED and cropping edges would lose important detail

   USE "floating" FOR (works with BOTH images AND videos):
   - Archival/historical photos or footage — presented like media on a display
   - Key evidence photos, documents, screenshots, or surveillance clips — spotlighted as visual artifacts
   - Dramatic reveal scenes — footage floats in on a contrasting background
   - Transition moments between major sections — visual breathing room
   - Documentary-style presentations — footage as "exhibit" on neutral background
   - Raw video clips that benefit from a framed, cinematic presentation (e.g. leaked footage, CCTV, phone recordings)
   BEST backgrounds for floating: "soft-beige", "paper", "warm-white", "cream", "warm-charcoal", "slate", "blur"
   How many floating scenes depends on the video type — documentaries/history can use more, fast-paced news/crime should use fewer.

   IMPORTANT: Do NOT overuse non-fullscreen framing! Most scenes should still be "fullscreen".
   Use your judgment on how many cinematic/floating scenes fit the video's style and pacing.

   FLOATING ANIMATION (only when framing is "floating"):
   When you pick floating, also choose:
   - floatingAnim: how the frame enters/exits the screen
     • "slideRight" = slides in from right (good for reveals, new evidence, forward momentum)
     • "slideLeft" = slides in from left (good for flashbacks, returns, looking back)
     • "slideUp" = slides up from bottom (dramatic reveals, rising tension, unveiling)
     • "fadeScale" = fades in with scale (quiet moments, reflective, contemplative)
     DIVERSIFY — don't repeat the same animation for consecutive floating scenes.
   - floatingShadow: shadow intensity behind the frame (0.3 = light/subtle, 0.5 = medium, 0.7 = heavy/dramatic)
     • Light (0.3): clean documentary look, archival photos
     • Medium (0.5): standard, works for most
     • Heavy (0.7): dramatic moments, key evidence, dark themes
   When framing is NOT floating, set both to "none".

10. BACKGROUND ID (only when framing is "cinematic" or "floating"):
   When framing is "cinematic" or "floating", choose a background that shows behind the footage.
   - "blur" = blurred duplicate of same footage (good default for cinematic)
   - Or pick from the available gradient backgrounds:
${_buildBackgroundList(theme)}
   Pick the background that best matches the scene mood. Use "blur" as safe default if unsure.
   For "floating" framing, prefer solid/soft backgrounds: soft-beige, paper, warm-white, cream, warm-charcoal, slate.
   When framing is "fullscreen", set backgroundId to "none".

11. KEYWORD FORMAT (CRITICAL — this is THE primary search term):

   ⚠️ STEP 0 — DECIDE THE BEST VISUAL FOR THIS LINE (reason like an editor; there is NO quota):
   ${_isTalkingHead ? 'This is a TALKING-HEAD video: most beats are B-roll, and the recurring presenter is added automatically on PRESENTER-tagged beats (plan nothing there).' : 'This is a faceless VIDEO.'} The default visual is REAL FOOTAGE that illustrates the narration.
   For each scene ask yourself: "What single shot best carries THIS sentence to a viewer?"

   • Literally filmable line → write a concrete keyword for that shot.
   • Abstract / conceptual line (an idea, cause, feeling, comparison — e.g. "inflation is squeezing
     families", "the system is collapsing", "the mechanism behind this") → do NOT abandon footage.
     Translate the idea into an EVOCATIVE shot a real editor would cut to (a worried family at a
     checkout; cracking infrastructure / falling dominoes; gears grinding to a halt) and write THAT
     keyword. Turning a concept into an image is the craft — defaulting to a text card is the lazy way.

   Reach for a GRAPHIC only when words or data genuinely communicate better than ANY footage could.
   A graphic must EARN its place — it is an accent, not the default. Use your judgment:
   • Real numbers / percentages / rankings → a data graphic (fullscreenMG barChart/donutChart/rankingList, or templateHint "statCard").
   • One short, quotable THESIS that deserves to stand alone → templateHint "keyTakeaway: <line>" (rare — not for every conclusion).
   • A direct quote → templateHint "quoteCard"; a real list of items → a list template.
   • A geographic relationship / 2+ places / a route${nicheAllowsMapChart ? ' → fullscreenMG "mapChart" (more impactful than generic footage for geography).' : ' → use real footage/stock of the place (mapChart is off for this niche).'}
   • To punch a key word/phrase, you can OVERLAY an mgHint (focusWord/kineticText) ON TOP of a footage scene — keep the real keyword, and make the words a meaningful story beat (not a generic single word like "Global"/"Trade"/"System"). Typography MGs are overlay-only, never fullscreenMG.

   TEMPLATE BACKGROUNDS: a template card (statCard/keyTakeaway/quoteCard/factCard…) is NOT a flat
   colour slide — its text sits over a real footage background. So whenever you set templateHint,
   ALSO give it an EVOCATIVE "bgQuery" (relevant b-roll for that beat), exactly like a footage
   keyword — so even the cards look cinematic, not like PowerPoint. (Maps and pure data charts are
   the only graphics that don't need a footage bg.)

   NEWS ACTORS (a named state/military actor + an action, e.g. "Houthi forces strike") → real keyword with sourceHint="youtube"; never "stock" for these.

   RHYTHM: vary treatments scene-to-scene like a good editor — footage should dominate, graphics sprinkled only where they earn it. If the last few scenes leaned on graphics/typography, come back to footage. Trust your pacing; do not force any fixed number of templates or MGs.

   RAW MATERIAL PRINCIPLE (every niche, every query field): a search query
   names what the CAMERA SAW — subject + action + setting, optionally shot
   language (aerial, close-up, night). It must NEVER name the packaging or
   distribution form of the content: asking search engines for a media
   PRODUCT (a show, coverage, a report, a review, a compilation) returns
   finished, branded clips — banners, tickers, channel logos, presenters —
   which fail vision review and are unusable in a faceless edit. You want
   the rushes, not the broadcast. When a beat needs the texture of a real
   event, name the event's visible elements (what was burning, moving,
   launching, where); dates, sources and labels belong in overlay MGs,
   never in the search query.

   The keyword field must be SHORT (3-6 words) and directly searchable.
   Strategy for this niche (${niche.name}): "${(() => {
       const kr = getKeywordRules(nicheId);
       return kr.strategy || 'balanced';
   })()}"
${(() => {
    const kr = getKeywordRules(nicheId);
    let block = '';
    if (kr.rules && kr.rules.length > 0) {
        block += kr.rules.map(r => `   - ${r}`).join('\n');
    }
    if (kr.examples) {
        if (kr.examples.good) {
            block += `\n   - GOOD: ${kr.examples.good.join(', ')}`;
        }
        if (kr.examples.bad) {
            block += `\n   - BAD: ${kr.examples.bad.join(', ')}`;
        }
    }
    return block;
})()}
   The keyword is NOT a shot description. Save cinematic details for visualIntent.
   If the scene names a person, the keyword MUST be that person's name (+ optional context word).

   ⚠️ KEYWORD MUST MATCH THIS SCENE'S NARRATION (CRITICAL):
   - Read ONLY this scene's quoted text. The keyword must reflect what THIS scene says, not the broader video topic.
   - If scene says "It cuts energy bills by up to 75 percent" → keyword: "energy bill savings home", NOT "thermal imaging house energy"
   - If scene says "insurance premiums by up to 90" → keyword: "home insurance policy document", NOT "monolithic dome insulation"
   - If scene says "and can last for centuries" → keyword: "ancient stone building centuries old", NOT "dome construction materials"
   - The VIDEO TOPIC gives context, but the keyword must match what the NARRATOR IS SAYING in this specific 2-5 second clip.
    - ASK: "If I mute everything else and ONLY hear this scene's text, what footage would I show?" THAT is your keyword.
    - When a scene states a NUMBER or PERCENTAGE, consider whether an mgHint (statCounter) or fullscreenMG is BETTER than footage.

   GLOBAL HANDS-ON VISUAL POLICY:
   - Across ALL niches, translate abstract ideas into physical, inspectable visuals.
   - Prefer hands building/repairing/testing/using things, workbenches, tools, kitchens, stores, labs, factories, before/after comparisons, process close-ups, and real objects moving.
   - Avoid generic documentary mood shots, empty aerials, city skylines, clouds, dark textures, and symbolic filler unless the scene explicitly calls for an establishing or breathing-room shot.

   CRITICAL — NEVER use abstract, metaphorical, or conceptual keywords:
   - BANNED WORDS in keyword (these have NO stock match — they describe ideas, not shots):
     montage, mechanism, inflation, dilemma, analogy, principle, strategy, concept,
     collapse, breaking apart, falling apart, grid collapse, system breaking, network grid,
     symbolism, metaphor, paradigm, dichotomy, framework, equilibrium, dynamic,
     side-by-side comparison, juxtaposition, interplay
   - If you want to write any of these words → STOP. Pick one of these instead:
     (a) a CONCRETE physical shot (what a camera would literally capture in that moment), OR
     (b) templateHint="keyTakeaway: <line>" for a typography-focused background, OR
     (c) footage keyword + overlay mgHint (focusWord/kineticText/callout/headline) — abstract ideas belong on typography overlays, not on the keyword itself.
   - BAD: "container ship and oil tanker montage" → GOOD: "oil tanker at sea" + mgHint="focusWord: Oil + Shipping"
   - BAD: "digital network grid breaking apart" → GOOD: templateHint="keyTakeaway: The Network Collapses" + mgHint="kineticText: Collapse" (typography on a template background, no footage keyword)
   - BAD: "grocery store checkout inflation" → GOOD: "grocery store shelves" + mgHint="statCounter: +8.2% Food Prices"
   - BAD: "complex gear system mechanism close-up" → GOOD: "industrial gears turning" (one concrete object)
   - BAD: "large container ship and small freighter side-by-side" → GOOD: "container ship ocean" (pick ONE subject, not a comparison)
   - Other examples: "warfare principles Sun Tzu" → "military command center screens"; "no-win battery dilemma" → "missile battery operator radar screen"
   - TEST: "Can a camera photograph this exact keyword in one shot, today?" If no → rewrite or flip to MG.

   ⚠️ MAX 3 CONCRETE NOUNS (hard cap for stock-routed scenes):
   - If sourceHint is "stock", keyword must have AT MOST 3 concrete nouns.
   - "HMM Algeciras class ship drone" = 4 nouns + brand (HMM Algeciras) = BANNED. Use "container ship ocean" (2 nouns) instead.
   - "Bab el-Mandeb strait container ship drone" = 4 nouns. Use "container ship strait" (2 nouns).
   - Brand/class names (HMM Algeciras, USS Gerald Ford, F-35) are OK on youtube/reddit/web-image, NEVER on stock.

   ⚠️ NEWS-ACTOR HARD RULE (no exceptions):
   - If the scene text mentions a state/military actor (Iran, Russia, Houthi, Hamas, IDF, NATO, Ukraine, Israel, China, North Korea, Hezbollah, Taliban, ISIS) combined with a military/political verb (navy, forces, strike, patrol, attack, invasion, missile, drone, blockade, sanctions) → ${nicheAllowsMapChart ? 'sourceHint MUST be "youtube" OR fullscreenMG="mapChart".' : 'sourceHint MUST be "youtube"; mapChart is forbidden for this niche.'} NEVER "stock".
   - These events do not exist on stock footage libraries. Routing them to stock guarantees failure.
   - If youtube also feels wrong for the scene, ${nicheAllowsMapChart ? 'use a map fullscreenMG instead of forcing footage.' : 'use stock route references, a template, or an overlay instead of stock.'}

   ⚠️ TOPIC ANCHORING (CRITICAL FOR NEWS/POLITICS/MILITARY NICHES):
   - Every keyword MUST be grounded in the SPECIFIC topic of this video.
   - News channels and search engines return the MOST RECENT content matching your words.
   - Generic keywords like "Iran blockade" or "government building" will return footage from whatever conflict is trending TODAY — not from the topic of THIS video.
   - ALWAYS include the specific country, entity, or event anchor in your keyword.
   - BAD: "Tehran control lost" — returns random Iran news, probably unrelated
   - BAD: "two weeks blockade" — returns any blockade from any conflict
   - BAD: "government building" — returns any government building anywhere
   - GOOD: "Iran Strait of Hormuz shipping" — specific to this topic
   - GOOD: "Saudi Arabia oil pipeline Yanbu" — anchored to the exact story
   - GOOD: "Aramco oil terminal Red Sea" — concrete + topic-specific

   ⚠️ EVENT-KEYWORD STRUCTURE (mandatory on news.military / news.politics when scene names an actor + verb):
   - Build the keyword as: <ACTOR> <PLACE/TARGET> <EVENT-VERB or TARGET-NOUN>
   - The keyword MUST include the named actor (Houthi, Iran, IDF, Russia, etc.) AND the named place (Bab-el-Mandeb, Red Sea, Suez, Hormuz, Kerch, etc.) AND an event verb/noun (attack, strike, missile, drone, raid, blockade, intercept, threat).
   - Dropping the ACTOR or the PLACE turns the query into generic news that returns the wrong story.
   - BAD: "Red Sea missile launch" — no actor, returns generic missile-launch B-roll from any conflict
   - BAD: "Houthi missile" — no place, returns archive Yemen footage unrelated to this scene
   - BAD: "Bab-el-Mandeb shipping" — no actor and no event, returns peacetime maritime stock
   - GOOD: "Bab-el-Mandeb Houthi ship attack threat" — actor + place + event-noun, anchored
   - GOOD: "Houthi drone strike Red Sea cargo ship" — actor + verb + place + target
   - GOOD: "IDF Gaza precision strike" — actor + place + verb
   - This rule overrides the stockQuery 3-word cap on news.military/news.politics for the primary 'keyword'; use the shorter stockQuery field for the actual stock API while keeping 'keyword' event-anchored.
   - MARITIME RULE: for canal/strait/shipping scenes, use ship/port/canal/shipping-lane nouns. Use "aerial" only when the scene explicitly asks for an overhead, map, satellite, or drone-camera view. Never write "factory logistics" or "supply chain logistics" unless the narration literally shows a factory/warehouse.
   - BAD: "Suez Canal factory logistics" — routes to finance/news anchors, not useful footage
   - GOOD: "Suez Canal cargo port" or "Suez Canal cargo ship"
   - Rule: If the keyword could match footage from a DIFFERENT news story, add the specific entity/location to anchor it.

12. SEARCH-OPTIMIZED QUERIES (CRITICAL FOR QUALITY):
   You must provide TWO different search queries optimized for different providers:

   **stockQuery** (for Pexels/Pixabay — stock footage APIs):
   - MAXIMUM 3 words — shorter = much better results
   - Use VISUAL/GENERIC terms, NOT specific names or events
   - Focus on what the shot LOOKS LIKE, not what it IS about
   - Good: "hands repairing appliance", "factory assembly line", "kitchen food prep"
   - Bad: "FBI agents raiding Gene Hackman mansion" (too specific, stock won't have this)
   - Bad: "technology" (too vague, returns random results)

   **webQuery** (for Bing, Google — web image search):
   - Can be 4-8 words, specific is BETTER
   - Use REAL NAMES, dates, events — web search is good at this
   - Add context words like "photo", "footage", "press conference"
   - Good: "Gene Hackman 2024 photo", "Tesla Cybertruck reveal event"
   - Bad: "man standing" (too generic for web)
   - NEVER wrap the query in quotation marks — just plain words

   The right stockQuery + webQuery combo is THE difference between good and bad footage!

   **protectedTerms** (for downstream scoring context, NOT search query text):
   - For every FOOTAGE scene, write 2-4 semicolon-separated context terms used later for title/vision relevance checks.
   - These terms will NOT be injected into keyword/search queries, so keep keyword itself short and visual.
   - Include the non-negotiable meaning: exact place/person/entity when relevant, concrete visual subject/object, and essential shot/action.
   - Good: keyword="Bab el-Mandeb cargo ship" → protectedTerms="Bab el-Mandeb; cargo ship; strait"
   - Good health example: keyword="MRI scan hospital patient" → protectedTerms="MRI scan; patient; hospital"
   - Good sports example: keyword="basketball player dunk court" → protectedTerms="basketball; player dunk; court"
   - Do NOT include filler terms like "footage", "video", "scene", "background", "beautiful".
   - For fullscreenMG/templateHint scenes, set protectedTerms="none".

13. EFFECTS (per-scene effect preset):
   - Pick ONE preset from the AVAILABLE EFFECT PRESETS list above, or "none"
   - Each preset is a curated combo (grain, scratches, color grading, etc.) — DO NOT list individual effects
   - Match preset to scene mood/tone (see descriptions above)
   - ~40-50% of scenes should be "none" — don't overuse
   - HOOK scenes benefit from subtle presets for visual impact

14. MG HINT (OVERLAY motion graphic — appears ON TOP of footage):
   - Format: "<mgType>: <brief content description>" or "none"
   - Overlay MGs appear over the footage. Default is "none".${isNonEnglish ? `\n   - ⚠️ LANGUAGE: The content description text MUST be in ${buildLangName}. Example: "statCounter: 75% Energieeinsparung" NOT "75% Energy Savings"` : ''}
   - ONLY add when the narration has a clear CONTENT SIGNAL:
     • A SPECIFIC NUMBER, PERCENTAGE, or STATISTIC → "statCounter: 75% energy savings" — THIS IS HIGH PRIORITY. When the narrator says a number, the viewer NEEDS to see it on screen.
       Examples: "cuts bills by 75 percent" → "statCounter: 75% Energy Bill Reduction"
                 "over a million new houses" → "statCounter: 1,000,000+ Houses Built Annually"
                 "less than 900 of these homes" → "statCounter: <900 Monolithic Domes in America"
     • A NEW PERSON INTRODUCED BY NAME + TITLE → "lowerThird: DW Griffith, Film Director"
       (Do NOT repeat for the same person in later scenes)
     • A DIRECT QUOTE spoken verbatim → "callout: I believe in white supremacy"
   - Overlay types: lowerThird, headline, statCounter, callout, focusWord, progressBar
   - statCounter is for real quantities only (100+, %, $, x/fold, million/billion). Do NOT use it for dates or calendar labels like "March 2026".
   - Most scenes are pure storytelling — they should have NO MG
   - Do NOT cluster MGs — leave gaps of 2-4 scenes between MGs
   - **NO SPOILER MGs**: A lowerThird must ONLY appear on the scene where the person is FIRST NAMED in the narration text. If a scene says "but first, the man who..." without naming anyone → NO lowerThird. The lowerThird goes on the NEXT scene where the name is actually spoken.

15. FULLSCREEN MG (REPLACES footage — no download needed for this scene):
   - Format: "<mgType>: <content data>" or "none"
   - When set, this scene becomes a FULLSCREEN motion graphic — NO footage is downloaded.
   - This is BETTER than footage when the scene's narration is data-heavy or abstract.${isNonEnglish ? `\n   - ⚠️ LANGUAGE: ALL content data (labels, titles, items, comparisons) MUST be in ${buildLangName}. Example: "comparisonCard: Öffentliches Bild vs Private Realität" NOT English.` : ''}

   ⚠️ CRITICAL DATA RULE — DATA MGs REQUIRE REAL DATA FROM THE NARRATION:
   The types barChart, donutChart, rankingList, timeline, bulletList, comparisonCard
   are DATA MGs — they render charts/lists from labels + numbers. DO NOT invent data.
   If the scene's narration does NOT contain real numbers/comparisons/dates/items,
   DO NOT USE a data MG — pick footage, a template, or a non-data MG instead.
   Data MGs with missing/invented data will be REJECTED and the scene will have no visual.

   - FORMAT for data MGs (title + pipe-separated Label:Number pairs):
     • barChart   → "barChart: <Title> | Label1:Num1 | Label2:Num2 | Label3:Num3"  (≥2 numeric pairs, numbers only)
     • donutChart → "donutChart: <Title> | Label1:Num1 | Label2:Num2"  (≥2 numeric pairs, percentages add to ~100)
     • rankingList→ "rankingList: <Title> | #1 Item:Num | #2 Item:Num | #3 Item:Num"  (≥2 numeric pairs)
     • timeline   → "timeline: <Title> | 1915:Event | 1925:Event | 1999:Event"  (≥2 date:event pairs)
     • bulletList → "bulletList: <Title> | Point 1 | Point 2 | Point 3"  (≥2 items, no colons needed)
     • comparisonCard → "comparisonCard: Item A vs Item B"  (must contain " vs ")

   - USE fullscreenMG WHEN:
     • Scene explicitly states 2+ numbers/stats → barChart (e.g. narration says "exports dropped from 100 to 40") → "barChart: Bab-el-Mandeb Transit | Before:100 | Now:40"
     • Scene compares market shares/percentages that add up → donutChart
     • Scene lists ranked items with numeric values → rankingList
     • Scene lists MULTIPLE dates with events (≥2 years mentioned) → timeline
     • Scene lists ≥2 short points/items (no numbers needed) → bulletList
     • Scene makes an explicit COMPARISON — the word "vs", "versus", "compared to" → comparisonCard
     • Scene discusses an article/document/book → "articleHighlight: Title of Article"
${mapFullscreenRules}

   - DO NOT USE data MG WHEN:
     • The narration only names a topic without numbers (e.g. "Bab-el-Mandeb Transit Volume" alone is NOT enough — there are no numbers)
     • You would have to invent numbers or labels the narration doesn't state
     • The scene has only one data point (charts need ≥2 to make sense)
     → In those cases, use mgHint (overlay), templateHint, or footage instead.

   - Fullscreen MG types: ${fullscreenMGTypes || 'none from this niche allowlist'}
   - When fullscreenMG is set, keyword/stockQuery/webQuery are IGNORED (set to "none")
   - Do NOT overuse — max ~15% of scenes. Most scenes should be footage.
   - NEVER use on CTA scenes. Do not use on HOOK scenes unless MAP=preferred/allowed and the user explicitly requested a map in the first hook.

16. TEMPLATE HINT (fullscreen template card on V3 — IMPORTANT visual system):
   - Format: "<templateType>: <brief content>" or "none"${isNonEnglish ? `\n   - ⚠️ LANGUAGE: ALL template content text MUST be in ${buildLangName}. Example: "statCard: Energie -75% Stromrechnung" NOT English.` : ''}
   - ⚠️ NICHE TEMPLATE ALLOWLIST (niche=${nicheId}) — HARD RULE:
     ALLOWED templates for this niche: ${nicheAllowedTemplates.length ? nicheAllowedTemplates.join(', ') : '(none — do not use templateHint at all for this niche)'}
${nicheBannedTemplates.length ? `     BANNED for this niche (will be stripped at render — DO NOT USE): ${nicheBannedTemplates.join(', ')}
     If a scene's content would normally call for a banned template, convert it to footage (set keyword + sourceHint) or an OVERLAY-MG on real footage instead. Do NOT output a banned template just because the narration fits — it will be deleted and the scene will get a generic background.` : ''}
   - 🎯 GLOBAL EDITORIAL RULE — KEEP TEMPLATES RARE (this governs the whole video, above every trigger below):
     Real footage is the BACKBONE; full-screen text/data cards are RARE punctuation, never the default.
     A wall of designed cards is the #1 reason a video looks AI-made — a human editor STAYS ON FOOTAGE and
     lets a stat or quote ride as a small overlay instead of cutting to a card. So bias HARD toward footage
     and deliberately emit FEWER templates than feel natural: when a beat could go either way, it is footage.
     Most videos need only a handful of cards total, spread far apart — not one every few scenes.
   - ⚠️ FOOTAGE-FIRST EDITORIAL JUDGMENT (decide like a human editor):
     A template must EARN its slot against the rule above. Before setting templateHint, ask: "would footage —
     even decent footage with a light overlay — carry this beat?" If yes, and it almost always can, choose footage.
     • A number/place/person merely MENTIONED while narration describes something VISUAL (ships, factories,
       streets, events, people doing things) → footage (+ an overlay MG if the stat matters), NEVER a card.
     • Never place cards back-to-back: if a neighbor already carries a template or map, this scene is footage
       even if it loosely qualifies — adjacent cards read as a slideshow, not a video.
     • A template only beats footage when footage genuinely CANNOT say it (a hard number, a real list, a thesis,
       a direct comparison) AND the moment deserves to stop the footage. A light overlay on decent footage
       almost always beats a full-screen card.
   - The list below tells you when a template is ELIGIBLE — it is NECESSARY, NOT SUFFICIENT. Eligibility is not
     instruction: most eligible beats should still resolve to footage + overlay. A template is ELIGIBLE WHEN:
     • Narration mentions NUMBERS or PERCENTAGES (1-3 stats) → "statCard: -90% Insurance | -75% Energy Bills" — THIS IS THE MOST IMPORTANT TEMPLATE. Icon+number infographics look professional. Use for: "cuts bills by 75%", "saves up to 90%", "less than 900 homes", etc.
     • Narration mentions MANY stats/numbers (4+) → "factCard: Title | fact1; fact2; fact3; fact4"
     • Narration transitions to a NEW MAJOR SECTION/TOPIC → "chapterCard: Chapter Title"
     • A NEW SPECIFIC LOCATION is introduced for the first time → "locationCard: Place Name, Country"
     • A DIRECT QUOTE is spoken that deserves visual emphasis → "quoteCard: The quote text"
     • In the FINAL QUARTER of video (scene.startTime ≥ ${keyTakeawayMinStart}s — total ${_totalDur.toFixed(1)}s), a key insight/conclusion → "keyTakeaway: Main point"
       ⚠️ HARD RULE: keyTakeaway is ONLY valid when sceneStart ≥ ${keyTakeawayMinStart}s. The downstream guard strips any keyTakeaway before that timestamp unless the narration itself opens with summary markers like "in short", "the point is", "the bottom line", "ultimately". Do NOT place keyTakeaway in the first three quarters of the video — pick a different template (or footage) instead.
     • An explicit COMPARISON (X vs Y) in narration → "comparisonCard: Thing A vs Thing B"
     • Dates/events forming a chronological sequence → "timelineCard: Date1: Event | Date2: Event"
     • Narration references two or three related concepts/people/places worth visualizing → "imageShowcase: Title | image1 desc; image2 desc; image3 desc" (2-3 images, collage variant scatters them like photos on a desk)
     • A NAMED PERSON is introduced for the FIRST TIME → "personIntro: Person Name | Role/Title, Year" — Shows portrait + name + context image. MUCH better than just downloading a portrait photo. Use for: "Wallace Neff", "Buckminster Fuller", "David South", etc. Only on FIRST mention — not for every scene about them.
     • Narration EXPLICITLY COMPARES two things visually (before/after, two countries, two sides) → "splitScreen: Title | Left Label; Right Label" — Vertical split with two images side by side. Use when two contrasting visuals would be impactful.
     • Narration lists 3-5+ items each with a stat/price/detail (weapon costs, country budgets, building specs) → "infographic: Title | Item1 Title | Value | image; Item2 Title | Value | image" — Multi-item visual layout with images, titles, and values. More complex than statCard.
   - personIntro FORMAT: "personIntro: Person Name | Role/Title, Year"
     Examples:
     • "Wallace Neff, an architect..." → "personIntro: Wallace Neff | Architect, 1941"
     • "Buckminster Fuller invented..." → "personIntro: Buckminster Fuller | Inventor & Architect"
     • "David South, the founder..." → "personIntro: David South | Founder, Monolithic Dome Institute"
   - statCard FORMAT: "statCard: <icon hint> <number> <label> | <icon hint> <number> <label>"
     Examples:
     • "cuts energy bills by 75%" → "statCard: energy -75% Energy Bills"
     • "insurance premiums by 90%" → "statCard: shield -90% Insurance Premiums"
     • "75% energy, 90% insurance" (same scene, 2 stats) → "statCard: energy -75% Energy Bills; shield -90% Insurance"
     • "less than 900 homes exist" → "statCard: home <900 Dome Homes in USA"
     Icon hints: energy, shield, home, money, people, globe, chart, clock, building, car, health, tech
     Separate multiple stats with semicolons (;), NOT pipes (|)
   - Aim for 3-5 templates per video — they make the video look PROFESSIONAL
   - NEVER on HOOK or CTA scenes
   - Can't be same scene as fullscreenMG (choose one or the other)
   - When templateHint is set, set keyword/stockQuery/webQuery/sourceHint to "none". Template backgrounds are handled by the template system, not the footage keyword lane.
   - NEVER put a vague background phrase in keyword for a template. BAD: keyword="around global trade nearly". GOOD: templateHint="statCard: globe 10-12% Global Trade; barrel 8-9M Oil Per Day" and keyword="none".
   - Default is "none" for most scenes — but ACTIVELY LOOK for template opportunities in every scene

OUTPUT FORMAT (one line per scene):

SCENE 0: keyword: <search term or none> | stockQuery: <query or none> | webQuery: <query or none> | protectedTerms: <term1; term2; term3 or none> | mediaNeed: <exact-still|real-demo-video|generic-broll|template-only|data-graphic> | sourceReason: <short reason, no pipe characters> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | mapVariant: <locator|route|regionHighlight|comparison|none> | templateHint: <template type: content or none> | bgQuery: <real visual search query when templateHint is set OR when MAP=blocked, else none>
SCENE 1: keyword: <search term or none> | stockQuery: <query or none> | webQuery: <query or none> | protectedTerms: <term1; term2; term3 or none> | mediaNeed: <exact-still|real-demo-video|generic-broll|template-only|data-graphic> | sourceReason: <short reason, no pipe characters> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | mapVariant: <locator|route|regionHighlight|comparison|none> | templateHint: <template type: content or none> | bgQuery: <real visual search query when templateHint is set OR when MAP=blocked, else none>
...

CRITICAL: YOU MUST OUTPUT EXACTLY ${scenes.length} LINES (one per scene).
Each footage keyword must be UNIQUE, SEARCHABLE, and SHORT (3-6 words). When a person is named in a footage scene, keyword = their name.
For maritime/canal/strait/supply-chain scenes, keyword must name a visible maritime subject: cargo ship, oil tanker, port, shipping lane, canal, or strait. Use aerial only for explicit overhead/map/satellite/drone-camera scenes. Do NOT use "factory logistics" for Suez/Red Sea/Bab-el-Mandeb/Hormuz unless the scene literally shows a factory.
For bridge/connector scenes with CONTEXT-ANCHOR, the footage keyword MUST use that anchor or its concrete subject. Do not search the connector phrase itself, and do not introduce unrelated places from later scenes.
When fullscreenMG is set, keyword/stockQuery/webQuery can be "none" (footage won't be downloaded).
Do NOT put cinematic shot descriptions in keyword — that goes in visualIntent.
stockQuery and webQuery must BOTH be provided for every footage scene.
protectedTerms must be provided for every footage scene and must be "none" for fullscreenMG/template scenes.
mediaNeed and sourceReason are mandatory for every scene. Use mediaNeed to declare the editorial/source need before provider choice: exact-still, real-demo-video, generic-broll, template-only, or data-graphic.
Before you answer, run this source self-check on every footage scene:
  • If CONSTRAINTS has SOURCE-HINT or OUTLINE-SOURCE, use that source unless the scene clearly needs a different media type.
  • image + stock + exact/protected entity = WRONG -> change to image + web-image.
  • video + stock + exact real moving subject/event/demo/factory/tour/review = WRONG -> change to video + youtube/reddit.
  • video + youtube/reddit + generic cinematic filler = WRONG -> change to video + stock.
  • video + web-image = WRONG -> change to image + web-image if static reference, or video + youtube if moving footage.

OUTPUT CONTRACT (HARD RULES — non-negotiable):
- Mutual exclusivity: NEVER set BOTH fullscreenMG AND templateHint on the same scene. Pick ONE lane.
- Template lane: when templateHint is not "none", keyword/stockQuery/webQuery/sourceHint MUST be "none". Do not create footage searches for template backgrounds.
- bgQuery field (NEW — required when noted):
  • If templateHint is NOT "none" → bgQuery MUST be a real visual-search query (3-6 words) describing footage that should play BEHIND the card. Subject + place if natural. Examples: templateHint="locationCard: Bab-el-Mandeb Strait" → bgQuery: "Bab-el-Mandeb cargo ship strait"; templateHint="statCard: 12% global oil" → bgQuery: "oil tanker shipping lane".
  • If this scene's CONSTRAINTS line says BLOCKED=map (the scene wanted a map but the niche/class forbids it) → bgQuery MUST be a real footage-search query for what to use INSTEAD (the literal subject + place: "Bab-el-Mandeb cargo ship shipping lane", "Suez Canal container ships"). Do NOT include policy/analysis/geopolitical/documentary as keywords — those words don't index well on stock providers.
  • Otherwise (normal footage scene with keyword set) → bgQuery: none.
  • Never use "policy", "geopolitical", "analysis", "documentary", "concept", "background" as bgQuery search tokens — pick concrete visual nouns (ship, tanker, port, capitol, refinery, soldier, harbor, fleet).
  • NEVER write mood/style adjectives as bgQuery — "dark", "ominous", "moody", "atmospheric", "eerie", "dramatic", "cinematic" do NOT exist as stock tags and produce zero results. Stock libraries index by SUBJECT, not by mood. BAD: "dark ominous background with shipping or map elements" — produces 0 hits. GOOD: "shipping container port aerial". State the SUBJECT; the renderer handles mood via filters and overlays.
- mgHint may co-exist with footage; mgHint may NOT co-exist with fullscreenMG (the fullscreen replaces everything).
- Per-scene CONSTRAINTS line is law:
${outputMapContractRules}
  • If FS-MG=forbidden → fullscreenMG MUST be "none" (CTA, or hook without an explicit first-hook map request).
  • If STOCK=disallowed → sourceHint MUST NOT be "stock". Use SOURCE-HINT/OUTLINE-SOURCE or the niche's best non-stock source.
- Niche allowlist is law: fullscreenMG type MUST be one of [${nicheAllowedMGs.join(', ')}] (or "none"). Anything else will be rewritten downstream.
- Class allowlist is STRICTER than niche allowlist for normal graphics, but MAP=preferred/allowed mapChart is a separate map lane unless MAP=forbidden or BLOCKED=map.
  • FULLSCREEN-MGS — the only non-map types valid for the fullscreenMG field. The global fullscreen-eligible set is exactly: barChart, donutChart, rankingList, timeline, comparisonCard, bulletList, mapChart. Anything else placed in fullscreenMG is dropped downstream as an "Unknown type". If a scene has no FULLSCREEN-MGS line, that class cannot use non-map fullscreenMG at all — leave it null unless MAP=preferred/allowed selects mapChart.
  • OVERLAY-MGS — overlay types (focusWord, kineticText, headline, callout, statCounter, lowerThird, dataBar, percentageCircle, broadcastLogo, typographyReveal, etc.). These belong ONLY in the mgHint field and MUST be paired with a real background: either footage (set keyword + sourceHint) or templateHint. locationCard/quoteCard/statCard/factCard/chapterCard are TEMPLATE types, not mgHint overlays. Never set an overlay type as fullscreenMG.
- Same strictness for ALLOWED-TEMPLATES vs templateHint. Class is editorial truth: "concept-metaphor" routes through typography or comparison templates, "data-claim" can use real fullscreen data graphics (barChart/donutChart/rankingList/timeline/comparisonCard) or stat templates, "actor-event" routes through lowerThird/headline on real footage. Picking outside the class allowlist or misplacing overlay→fullscreen will be silently rewritten.
- Data MGs require real numbers: barChart/donutChart/rankingList/timeline/comparisonCard demand ≥2 numeric pairs from the actual narration. If the narration has no numbers/dates/items, do NOT pick a data MG — pick a template, typography, or footage.
${mapPayloadContractRule}
- ROLE alignment: a person-intro scene must NOT route to stock; a quote-beat scene must NOT route to a barChart; a stat-beat scene with 2+ numbers MUST surface a stat lane (statCard | barChart | donutChart | statCounter).

⚠️ MANDATORY — DO NOT SKIP mgHint AND templateHint FIELDS:
You MUST evaluate EVERY scene for mgHint and templateHint. Do NOT default everything to "none".
- Any scene with a NUMBER/PERCENTAGE → must have mgHint: statCounter OR templateHint: statCard
- Any scene with a named person + title → must have mgHint: lowerThird
- Any scene transitioning to a new major section → consider templateHint: chapterCard
- Any scene with a direct quote → consider templateHint: quoteCard or mgHint: callout
- Expect at LEAST 3-5 mgHints and 2-4 templateHints per video. If you output zero, you are doing it wrong.
- statCard templates save API calls by replacing bad-keyword scenes — use them for stat-heavy narration!${isNonEnglish ? `

🔴 FINAL LANGUAGE REMINDER: This video is in ${buildLangName} (lang=${buildLang}).
ALL on-screen text in mgHint, fullscreenMG, and templateHint MUST be written in ${buildLangName}.
keyword/stockQuery/webQuery stay in English (for search engines). Everything else = ${buildLangName}.
Do NOT write English display text. Do NOT switch to English mid-output. EVERY scene, ${buildLangName} only.` : ''}`;

    return prompt;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

// AI sometimes returns placeholder values like "none" / "n/a" / "-" instead of
// omitting the field. For search strings that would leak into the downloader
// (keyword, stockQuery, webQuery) these must be treated as null so the
// fallback repair path in parseBatchResponse can regenerate a real keyword.
const _PLACEHOLDER_VALUES = new Set(['', 'none', 'n/a', 'na', 'null', 'nil', 'undefined', '-', '--', 'tbd']);
// Trailing connector tokens that, if left dangling at the end of a search
// query, signal a truncated or grammar-fragment keyword ("daily flow through",
// "soldiers in"). These are stripped from the tail before validating that the
// query still has at least 2 real content tokens.
const _TRAILING_CONNECTORS = new Set([
    'through', 'of', 'in', 'on', 'at', 'the', 'a', 'an', 'for', 'to',
    'with', 'from', 'by', 'into', 'onto', 'over', 'under', 'between',
    'and', 'or', 'but', 'as', 'near', 'around', 'about',
]);
function _sanitizeSearchValue(raw) {
    if (raw == null) return null;
    const stripped = String(raw).replace(/^["']+|["']+$/g, '').trim();
    if (!stripped) return null;
    if (_PLACEHOLDER_VALUES.has(stripped.toLowerCase())) return null;

    // Reject connector-truncated / fragment keywords. Two patterns we kill:
    //  1) "daily flow through" — dangling connector at the tail.
    //  2) "daily flow through bab" — connector followed by a ≤3-char lowercase
    //     fragment that almost always means a truncated proper noun (e.g.
    //     "Bab-el-Mandeb" cut to "bab" because of token-budget truncation).
    // After stripping, require ≥2 content tokens or the keyword is nuked.
    const tokens = stripped.split(/\s+/).filter(Boolean);
    let mutated = true;
    while (mutated && tokens.length > 1) {
        mutated = false;
        const last = tokens[tokens.length - 1].toLowerCase();
        if (_TRAILING_CONNECTORS.has(last)) {
            tokens.pop();
            mutated = true;
            continue;
        }
        if (tokens.length >= 2) {
            const second = tokens[tokens.length - 2].toLowerCase();
            const lastRaw = tokens[tokens.length - 1];
            // Connector + short-lowercase fragment = truncated proper noun.
            // Allow short tokens that look like real abbreviations (uppercase
            // like "UN", "EU", "US") so we only strike the lowercase case.
            if (_TRAILING_CONNECTORS.has(second) && lastRaw.length <= 3 && lastRaw === lastRaw.toLowerCase()) {
                tokens.pop();
                tokens.pop();
                mutated = true;
            }
        }
    }
    if (tokens.length < 2) return null;
    return tokens.join(' ');
}

function _pickConcreteFootageKeywordFromText(text) {
    const value = String(text || '');
    if (/\bbab[-\s]?el[-\s]?mandeb\b|\bmandeb\b/i.test(value)) return 'Bab el-Mandeb cargo ship';
    if (/\bstrait of hormuz\b|\bhormuz\b/i.test(value)) return 'Strait of Hormuz oil tanker';
    if (/\bsuez canal\b|\bsuez\b/i.test(value)) return 'Suez Canal cargo ship';
    if (/\bred sea\b/i.test(value)) return 'Red Sea cargo ship';
    if (/\bgulf of aden\b/i.test(value)) return 'Gulf of Aden cargo ship';
    return null;
}

function _isWeakFootageKeyword(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return true;
    const lower = text.toLowerCase();
    if (_PLACEHOLDER_VALUES.has(lower)) return true;
    const hasConcreteVisual = /\b(ship|ships|shipping|vessel|vessels|cargo|container|tanker|tankers|port|terminal|crane|cranes|canal|strait|sea|gulf|lane|route|chokepoint|warship|naval|missile|rocket|drone|factory|warehouse|refinery|pipeline|street|crowd|protest|official|briefing)\b/i.test(text);
    if (hasConcreteVisual) return false;
    return /\b(daily flow|flow|flows|global trade|world trade|trade share|trade volume|barrels?|million|billion|percent|percentage|data|chart|bar chart|stat|stats|impact|risk|system|backup)\b/i.test(text);
}

function _parseProtectedTerms(raw) {
    if (raw == null) return [];
    let stripped = String(raw).replace(/^["']+|["']+$/g, '').trim();
    if (!stripped || _PLACEHOLDER_VALUES.has(stripped.toLowerCase())) return [];
    stripped = stripped.replace(/^\[|\]$/g, '').trim();

    const separator = stripped.includes(';') ? /\s*;\s*/ : /\s*,\s*/;
    const seen = new Set();
    const terms = [];
    for (const part of stripped.split(separator)) {
        const term = part.replace(/^["']+|["']+$/g, '').trim();
        if (!term || _PLACEHOLDER_VALUES.has(term.toLowerCase())) continue;
        if (term.length > 80) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push(term);
    }
    return terms.slice(0, 5);
}

function _normalizeProtectedTerms(scene, scriptContext = {}) {
    if (scene.fullscreenMG || scene.templateHint || !scene.keyword) {
        scene.protectedTerms = [];
        return;
    }

    const terms = Array.isArray(scene.protectedTerms) ? [...scene.protectedTerms] : [];
    const keywordLower = String(scene.keyword || '').toLowerCase();

    for (const entity of (scriptContext.entities || [])) {
        const e = String(entity || '').trim();
        if (e && keywordLower.includes(e.toLowerCase())) terms.push(e);
    }

    const anchor = String(scriptContext.eventAnchor || '').trim();
    if (anchor && keywordLower.includes(anchor.toLowerCase())) terms.push(anchor);

    const seen = new Set();
    scene.protectedTerms = terms
        .map(t => String(t || '').replace(/^["']+|["']+$/g, '').trim())
        .filter(Boolean)
        .filter(t => !_PLACEHOLDER_VALUES.has(t.toLowerCase()))
        .filter(t => {
            const key = t.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 5);
}

/**
 * Parse the batch visual plan response.
 * Extracts keyword, mediaType, sourceHint, visualIntent for each scene.
 */
function _collectBatchResponseCoverage(rawText, scenes) {
    const lines = String(rawText || '').trim().split('\n').filter(line => {
        const lower = line.toLowerCase().trim();
        return lower.startsWith('scene ') && lower.includes(':');
    });

    const lineByIndex = new Map();
    const duplicates = [];
    for (const line of lines) {
        const match = line.match(/scene\s+(\d+)/i);
        if (!match) continue;
        const idx = parseInt(match[1], 10);
        if (lineByIndex.has(idx)) {
            duplicates.push(idx);
        } else {
            lineByIndex.set(idx, line);
        }
    }

    const missing = [];
    for (const s of scenes || []) {
        if (!lineByIndex.has(s.index)) missing.push(s.index);
    }

    return { lines, lineByIndex, duplicates, missing };
}

function parseBatchResponse(rawText, scenes, nicheId, themeId, scriptContext, plannerDirectives = null, options = {}) {
    const entities = scriptContext?.entities || [];
    const enrichedScenes = [];
    // Framing/background are the Editor Agent's job when it owns editing — ignore
    // any framing the planner AI emits so the CEO is the single owner.
    const ceoOwnsEditing = process.env.EDITOR_AGENT === 'true'
        || scriptContext?.editorAgentOwnsEditing === true
        || scriptContext?._editorAgentOwnsEditing === true;

    // Build a Map<sceneIndex, line> keyed by the global scene.index the prompt used.
    // Detect duplicates and collect unparseable lines so we can hard-fail the batch.
    const { lineByIndex, duplicates, missing } = _collectBatchResponseCoverage(rawText, scenes);
    if (duplicates.length > 0) {
        throw new Error(`Duplicate scene number(s) in batch response: ${duplicates.join(', ')}`);
    }

    if (missing.length > 0 && !options.allowMissing) {
        throw new Error(`Missing scene number(s) in batch response: ${missing.join(', ')}`);
    }

    const scenesToParse = options.allowMissing
        ? scenes.filter(s => lineByIndex.has(s.index))
        : scenes;

    for (let i = 0; i < scenesToParse.length; i++) {
        const scene = { ...scenesToParse[i] };

        // Match strictly by global scene.index (not loop index — scenes come in chunks).
        const matchedLine = lineByIndex.get(scene.index);

        if (matchedLine) {
            // Remove "SCENE N: " prefix first
            let content = matchedLine.substring(matchedLine.indexOf(':') + 1).trim();

            // Parse: keyword: X | mediaType: Y | sourceHint: Z | visualIntent: W
            const parts = content.split('|').map(p => p.trim());

            for (const part of parts) {
                const lower = part.toLowerCase();

                if (lower.startsWith('keyword:')) {
                    scene.keyword = _sanitizeSearchValue(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('stockquery:') || lower.startsWith('stock query:')) {
                    scene.stockQuery = _sanitizeSearchValue(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('webquery:') || lower.startsWith('web query:')) {
                    scene.webQuery = _sanitizeSearchValue(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('protectedterms:') || lower.startsWith('protected terms:') || lower.startsWith('protect:')) {
                    scene.protectedTerms = _parseProtectedTerms(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('medianeed:') || lower.startsWith('media need:')) {
                    scene.mediaNeed = _sanitizeMediaNeed(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('sourcereason:') || lower.startsWith('source reason:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    scene.sourceReason = _PLACEHOLDER_VALUES.has(val.toLowerCase()) ? null : val.replace(/\s+/g, ' ');
                }
                if (lower.startsWith('mediatype:') || lower.startsWith('media type:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    scene.mediaType = val === 'video' ? 'video' : 'image';
                }
                if (lower.startsWith('sourcehint:') || lower.startsWith('source hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    const safeVal = _sanitizeVpSourceHint(val, 'youtube');
                    if (safeVal && VP_SOURCE_HINTS.includes(safeVal)) {
                        scene.sourceHint = safeVal;
                    }
                }
                if (lower.startsWith('visualintent:') || lower.startsWith('visual intent:')) {
                    scene.visualIntent = part.substring(part.indexOf(':') + 1).trim();
                }
                if (!ceoOwnsEditing && lower.startsWith('background:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['blur', 'none'].includes(val)) {
                        scene.background = val;
                    }
                }
                if (!ceoOwnsEditing && lower.startsWith('framing:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['fullscreen', 'cinematic', 'floating'].includes(val)) {
                        scene.framing = val;
                    }
                }
                if (!ceoOwnsEditing && (lower.startsWith('floatinganim:') || lower.startsWith('floating anim:'))) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['slideright', 'slideleft', 'slideup', 'fadescale'].includes(val)) {
                        // Normalize to camelCase
                        const animMap = { slideright: 'slideRight', slideleft: 'slideLeft', slideup: 'slideUp', fadescale: 'fadeScale' };
                        scene.floatingAnim = animMap[val] || 'slideRight';
                    }
                }
                if (!ceoOwnsEditing && (lower.startsWith('floatingshadow:') || lower.startsWith('floating shadow:'))) {
                    const val = parseFloat(part.substring(part.indexOf(':') + 1).trim());
                    if (!isNaN(val) && val >= 0 && val <= 1) {
                        scene.floatingShadow = val;
                    }
                }
                if (!ceoOwnsEditing && (lower.startsWith('backgroundid:') || lower.startsWith('background id:'))) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    scene.backgroundId = val;
                }
                if (!ceoOwnsEditing && lower.startsWith('effects:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (val === 'none' || val === '') {
                        scene.effects = [];
                        scene.effectPreset = 'none';
                    } else {
                        // val is a preset name (e.g. "retroDV", "oldFilm")
                        const EFFECT_PRESETS = require('../render/effect-presets');
                        const presetKey = Object.keys(EFFECT_PRESETS).find(k => k.toLowerCase() === val) || val;
                        const preset = EFFECT_PRESETS[presetKey];
                        // Validate preset is allowed for this theme
                        const activeThemeId = themeId || 'standard';
                        const themeAllowed = preset && preset.themes &&
                            (preset.themes.includes('*') || preset.themes.includes(activeThemeId));
                        if (!themeAllowed && preset) {
                            console.log(`      ⚠️ Preset "${presetKey}" not allowed for theme "${activeThemeId}", skipping`);
                        }
                        if (preset && themeAllowed) {
                            scene.effectPreset = presetKey;
                            scene.effects = preset.effects ? [...preset.effects] : [];
                            scene.effectOverrides = {};
                            if (preset.params) {
                                for (const [fx, params] of Object.entries(preset.params)) {
                                    scene.effectOverrides[fx] = { ...params, enabled: true };
                                }
                            }
                            if (preset.mask) {
                                scene.effectMask = { ...preset.mask };
                            }
                        } else {
                            // Fallback: treat as comma-separated individual effects (backwards compat)
                            scene.effects = val.split(',').map(e => e.trim()).filter(Boolean);
                        }
                    }
                }
                if (lower.startsWith('mghint:') || lower.startsWith('mg hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.mgHint = null;
                    } else {
                        scene.mgHint = val;
                    }
                }
                if (lower.startsWith('fullscreenmg:') || lower.startsWith('fullscreen mg:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.fullscreenMG = null;
                    } else {
                        scene.fullscreenMG = val;
                        // Fullscreen MG replaces footage — clear download fields
                        scene.keyword = null;
                        scene.stockQuery = null;
                        scene.webQuery = null;
                        scene.mediaType = null;
                        scene.sourceHint = null;
                        scene.protectedTerms = [];
                    }
                }
                if (lower.startsWith('mapvariant:') || lower.startsWith('map variant:')) {
                    const raw = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '').toLowerCase();
                    const variantMap = {
                        locator: 'locator',
                        route: 'route',
                        regionhighlight: 'regionHighlight',
                        region_highlight: 'regionHighlight',
                        'region-highlight': 'regionHighlight',
                        region: 'regionHighlight',
                        comparison: 'comparison',
                        compare: 'comparison',
                    };
                    scene.mapVariant = (raw === 'none' || raw === '') ? null : (variantMap[raw] || null);
                }
                if (lower.startsWith('templatehint:') || lower.startsWith('template hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.templateHint = null;
                    } else {
                        scene.templateHint = val;
                    }
                }
                if (lower.startsWith('bgquery:') || lower.startsWith('bg query:')) {
                    scene._aiBgQuery = _sanitizeSearchValue(part.substring(part.indexOf(':') + 1));
                }
            }

            // Strip wrapping quotes from parsed values (AI sometimes wraps in quotes)
            const stripQuotes = v => v ? v.replace(/^["']+|["']+$/g, '').trim() : v;
            if (scene.keyword) scene.keyword = stripQuotes(scene.keyword);
            if (scene.stockQuery) scene.stockQuery = stripQuotes(scene.stockQuery);
            if (scene.webQuery) scene.webQuery = stripQuotes(scene.webQuery);
            if (scene.visualIntent) scene.visualIntent = stripQuotes(scene.visualIntent);
            if (scene.templateHint) scene.templateHint = stripQuotes(scene.templateHint);
            if (Array.isArray(scene.protectedTerms)) {
                scene.protectedTerms = scene.protectedTerms.map(stripQuotes).filter(Boolean);
            }

            // Snapshot the raw AI lane before guardrails rewrite it. This makes
            // map-dropped visible in the Planner Summary when the model ignores
            // a niche that forbids mapChart.
            _snapshotRawAIChoice(scene);
            _dropForbiddenMapChart(scene, nicheId, plannerDirectives, false, scriptContext);

            // templateHint and fullscreenMG are mutually exclusive — fullscreenMG wins
            if (scene.templateHint && scene.fullscreenMG) {
                scene.templateHint = null;
            }

            const templateOnlyMgCoercion = _coerceTemplateOnlyMgHint(scene, scriptContext);
            if (templateOnlyMgCoercion) {
                scene._templateOnlyMgCoercion = templateOnlyMgCoercion;
            }

            // Template scenes are not footage scenes. The planner's keyword
            // field is often a bad background phrase; carry a separate
            // templateBgQuery and clear footage download fields.
            if (scene.templateHint && !scene.fullscreenMG) {
                _applyTemplateBackgroundLane(scene, scriptContext);
            }

            // Auto-generate stockQuery/webQuery from keyword if AI didn't provide them
            if (scene.keyword && !scene.stockQuery) {
                scene.stockQuery = _autoStockQuery(scene.keyword);
            }
            if (scene.keyword && !scene.webQuery) {
                scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);
            }
            _normalizeProtectedTerms(scene, scriptContext);
        }

        // Fullscreen MG and template scenes don't need footage keywords/media.
        // Template backgrounds are handled later via templateBgQuery.
        if (scene.templateHint && !scene.fullscreenMG) {
            _applyTemplateBackgroundLane(scene, scriptContext);
        } else if (!scene.fullscreenMG) {
            // Fallback: Generate keyword from scene text if missing
            if (!scene.keyword || scene.keyword.length < 3) {
                scene.keyword = _pickConcreteFootageKeywordFromText(scene.text || '') || extractFallbackKeyword(scene.text, scene, scriptContext);
            }

            // Default values
            scene.mediaType = scene.mediaType || 'video';
            scene.sourceHint = scene.sourceHint || 'stock';
            _normalizeProtectedTerms(scene, scriptContext);
        }

        // Person entity override: route exact portraits to web-image. Stock
        // providers will not have exact public people.
        const entityTypes = scriptContext?.entityTypes || {};
        if (entities && entities.length > 0 && scene.keyword) {
            const kwLower = scene.keyword.toLowerCase();
            // Check ALL matching entities — if ANY is a person, trigger person lock
            const matchedEntities = entities.filter(e => {
                const eLower = e.toLowerCase();
                return kwLower.includes(eLower) || eLower.includes(kwLower);
            });
            const personEntity = matchedEntities.find(e => entityTypes[e.toLowerCase()] === 'person');
            const hasPortraitHint = /portrait|photo|headshot|face/i.test(kwLower);

            if ((personEntity || hasPortraitHint) && scene.sourceHint !== 'web-image') {
                const name = personEntity || matchedEntities[0];
                console.log(`  Person detected: "${name}" -> forcing web-image`);
                scene.mediaType = 'image';
                scene.sourceHint = 'web-image';
                scene._personLock = true;
                if (!hasPortraitHint) {
                    scene.keyword = `${scene.keyword} photo`;
                }
            }
        }

        // News niche safety net: only override "stock" default (when AI didn't provide sourceHint)
        // If AI explicitly chose a source, trust it — the prompt now teaches per-scene source selection
        if (nicheId && nicheId.startsWith('news') && scene.sourceHint === 'stock') {
            if (scene.mediaType !== 'video') {
                scene.sourceHint = 'web-image'; // images in news should be real photos, not generic stock
            }
        }

        // ── Niche-aware stock override ──
        // Stock doesn't have real footage for news/military/sport niches.
        // If AI picked stock for a video scene where stock is last-resort, override to niche's #1 source.
        // Other sources (youtube/reddit) are left as-is — let the AI decide.
        if (scene.mediaType === 'video' && nicheId) {
            const { getNiche: _getNiche } = require('../data/niches');
            const _niche = _getNiche(nicheId);
            const videoPriority = _videoPriorityForVp(_niche, 'youtube');

            if (videoPriority.length > 0) {
                const hint = scene.sourceHint || 'stock';
                const isStock = hint === 'stock';
                const stockIdx = videoPriority.indexOf('stock');
                const isStockLastResort = stockIdx >= videoPriority.length - 2;

                if (isStock && isStockLastResort) {
                    const topSource = videoPriority[0];
                    console.log(`      🔄 stock → ${topSource} (stock is last-resort for ${_niche.name})`);
                    scene.sourceHint = topSource;
                }
            }
        }

        scene.framing = scene.framing || 'fullscreen';
        // Floating animation defaults (AI may have set these)
        if (scene.framing === 'floating') {
            scene.floatingAnim = scene.floatingAnim || 'slideRight';
            scene.shadow = scene.floatingShadow || 0.5;
        }
        // Derive background from framing + backgroundId
        if (!scene.background) {
            if (scene.framing === 'cinematic' || scene.framing === 'floating') {
                const bgId = scene.backgroundId || (scene.framing === 'floating' ? 'soft-beige' : 'blur');
                if (bgId === 'blur') {
                    scene.background = 'blur';
                } else if (bgId === 'none') {
                    scene.background = 'none';
                } else if (bgId.startsWith('file:')) {
                    // Custom background file: "file:history--vintage-paper.jpg" → "pattern:history--vintage-paper.jpg"
                    scene.background = `pattern:${bgId.replace('file:', '')}`;
                } else if (BACKGROUND_LIBRARY[bgId]) {
                    scene.background = `gradient:${bgId}`;
                } else {
                    scene.background = 'blur'; // Unknown ID, fall back to blur
                }
            } else {
                scene.background = 'none';
            }
        }
        scene.visualIntent = scene.visualIntent || scene.keyword;
        _normalizeProtectedTerms(scene, scriptContext);
        if (!scene.effects) scene.effects = [];
        if (scene.mgHint === undefined) scene.mgHint = null;

        _snapshotRawAIChoice(scene);

        enrichedScenes.push(scene);
    }

    // Source Diversity enforcement moved to _finalizeVisualPlan so it runs
    // ONCE globally across the full scene list (not per-batch).

    return enrichedScenes;
}

// Connectives, interrogatives and light verbs. None of them can BE the subject
// of a footage search, so a query that opens on one — or is made of nothing
// else — is a sentence fragment rather than a thing to go and film. The old
// "first four long-ish words of the narration" rule turned "When it turns on
// issues a wildcard entry..." into the query "when turns issues wildcard",
// which every provider answers with nothing. Only unambiguous glue is listed:
// words that double as real nouns ("issues", "work", "show") stay searchable.
const KEYWORD_FRAGMENT_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do',
    'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can',
    'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
    'when', 'while', 'then', 'than', 'there', 'here', 'what', 'which', 'who', 'whom',
    'whose', 'where', 'why', 'how', 'because', 'though', 'although', 'unless', 'until',
    'since', 'after', 'before', 'once', 'whether', 'however', 'also', 'even', 'just',
    'very', 'really', 'quite', 'still', 'again', 'ever', 'never', 'always', 'often',
    'about', 'above', 'below', 'under', 'over', 'into', 'onto', 'through', 'during',
    'without', 'within', 'between', 'among', 'across', 'around', 'against', 'upon',
    'being', 'doing', 'done', 'shall', 'something', 'anything', 'nothing', 'everything',
    'someone', 'anyone', 'everyone', 'somebody', 'anybody', 'much', 'many', 'more',
    'most', 'some', 'other', 'another', 'such', 'same', 'each', 'every', 'both',
    'either', 'neither', 'none', 'turns', 'turned', 'turning', 'makes', 'made',
    'making', 'takes', 'taking', 'taken', 'goes', 'going', 'went', 'comes', 'coming',
    'came', 'gets', 'getting', 'seems', 'seemed', 'said', 'says', 'told', 'thought',
    'specific', 'deliberate', 'important', 'simple', 'certain', 'various', 'several',
]);

function _keywordWordsFromProse(text) {
    return String(text || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !KEYWORD_FRAGMENT_WORDS.has(w));
}

/**
 * A keyword is degenerate when it names no subject: empty, or opening on a
 * connective, or built entirely out of glue. Such a query is not merely weak,
 * it is grammatically broken, and it costs a real download attempt to learn so.
 */
function _isDegenerateKeyword(keyword) {
    const tokens = String(keyword || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    if (tokens.length === 0) return true;
    if (KEYWORD_FRAGMENT_WORDS.has(tokens[0])) return true;
    return tokens.every(t => KEYWORD_FRAGMENT_WORDS.has(t));
}

/**
 * What this scene is actually meant to SHOW, in the words the Director and the
 * Planner already wrote. Preferred over mining the narration whenever the
 * narration only yields a fragment — these fields describe a picture, so they
 * name a subject by construction.
 */
function _subjectFallbackKeyword(scene, scriptContext) {
    if (!scene && !scriptContext) return '';
    const protectedTerms = Array.isArray(scene?.protectedTerms) ? scene.protectedTerms.filter(Boolean) : [];
    const sources = [
        protectedTerms.join(' '),
        scene?.visualIntent,
        scene?.ideaVisual,
        scene?.ideaAnchor,
        scriptContext?.eventAnchor,
    ];
    for (const source of sources) {
        const words = _keywordWordsFromProse(source);
        if (!words.length) continue;
        const candidate = words.slice(0, 4).join(' ');
        if (!_isDegenerateKeyword(candidate)) return candidate;
    }
    return '';
}

/**
 * Extract a fallback keyword from scene text (used when AI fails).
 * Takes the most important nouns/verbs from the scene, and — when the prose
 * only yields a fragment — the scene's declared visual subject instead.
 */
function extractFallbackKeyword(text, scene = null, scriptContext = null) {
    const keyword = _keywordWordsFromProse(text).slice(0, 4).join(' ');
    if (keyword && !_isDegenerateKeyword(keyword)) return keyword;

    const subject = _subjectFallbackKeyword(scene, scriptContext);
    if (subject) return subject;

    // Nothing named a subject anywhere. A fragment still beats an empty query.
    return keyword || String(text || '').substring(0, 50);
}

// ============================================================
// VIDEO RATIO ENFORCEMENT
// ============================================================

/**
 * Enforce minimum video ratio for niches that need it.
 * News/military niches target 80-85% video. If AI picked too many images,
 * flip the least-important image scenes to video (skip person portraits, data charts).
 */
function _enforceVideoRatio(scenes, nicheId) {
    if (!nicheId) return;

    // Define target ratios per niche prefix
    let targetVideoRatio = null;
    if (nicheId.startsWith('news')) targetVideoRatio = 0.80;
    if (!targetVideoRatio) return;

    const totalScenes = scenes.filter(s => !s.fullscreenMG).length; // exclude fullscreen MGs
    if (totalScenes < 5) return;

    const videoCount = scenes.filter(s => !s.fullscreenMG && s.mediaType === 'video').length;
    const currentRatio = videoCount / totalScenes;

    if (currentRatio >= targetVideoRatio) return; // already meets target

    // How many image→video flips needed?
    const needed = Math.ceil(targetVideoRatio * totalScenes) - videoCount;

    // Rank image scenes by "flippability" — prefer generic scenes, avoid portraits/data
    const KEEP_AS_IMAGE = /portrait|headshot|chart|graph|data|diagram|infographic|photo of|face of/i;
    const imageScenes = scenes
        .filter(s => !s.fullscreenMG && s.mediaType === 'image' && !s._personLock)
        .map(s => ({
            scene: s,
            priority: KEEP_AS_IMAGE.test(s.keyword || '') ? 100 : (s.sourceHint === 'stock' ? 2 : 1)
        }))
        .sort((a, b) => a.priority - b.priority); // lowest priority = flip first

    let flipped = 0;
    for (const { scene } of imageScenes) {
        if (flipped >= needed) break;
        scene.mediaType = 'video';
        if (scene.sourceHint === 'stock') scene.sourceHint = 'stock';
        flipped++;
    }

    if (flipped > 0) {
        const newRatio = Math.round(((videoCount + flipped) / totalScenes) * 100);
        console.log(`   📊 Video ratio enforcement: flipped ${flipped} image→video (${Math.round(currentRatio * 100)}% → ${newRatio}% video) [target: ${Math.round(targetVideoRatio * 100)}%]`);
    }
}

// ============================================================
// STILL-RUN DISTRIBUTION (anti-slideshow)
// ============================================================

/**
 * scene-risk.js warns at 6 and FAILS the build at 10 consecutive base-track
 * still images with no icon/motion-graphic activity (`still_run`). That run is
 * created here — the planner decides mediaType scene by scene with no view of
 * its neighbours, so a stretch of "exact still" beats can pile up 13 deep. This
 * is the still-image twin of the "Never place cards back-to-back" prompt rule.
 *
 * Two things the planner CANNOT use as breakers, both verified against a real
 * build rather than assumed:
 *   - `_iconMoments`: icon-director treats any pre-set `_iconMoments` as "this
 *     is a saved project, the lane already ran" and skips itself entirely, so
 *     writing one here would cost every OTHER scene its icons.
 *   - `fullscreenMG`: Step 6 rejects most fullscreen hints and the scene falls
 *     back to a background image on the base track, so promoting a scene to a
 *     card can leave the run exactly as long while inflating `card_heavy`.
 * Footage is the one lever the planner owns end to end, and it is also what the
 * detector's own message asks for ("break it up with footage").
 */
const MAX_CONSECUTIVE_STILLS = 4;

// Keywords that name a still on purpose — flipping these to video would fetch
// the wrong thing, not better footage.
const _STILL_LOCKED_KEYWORD_RE = /\b(portrait|headshot|mugshot|\bface\b|photo|chart|graph|infographic|diagram|schematic|blueprint|screenshot|document|newspaper|nameplate|model plate|logo|poster)\b/i;

/**
 * Does this scene read as a still on the base track? Mirrors scene-risk's
 * `isStill(s) && !isCard(s)`, translated to the fields that exist at plan time:
 * a template card owns its frame, anything else without a video lane resolves
 * to a background image.
 */
function _plannerSceneReadsAsStill(scene) {
    if (!scene) return false;
    if (scene.templateHint || scene.templateType || scene.isTemplate) return false;
    return scene.mediaType !== 'video';
}

/**
 * Can this scene carry real footage instead of a still, and how willingly?
 * Lower tier = better break. Ordering is driven by the planner's OWN declared
 * `mediaNeed` contract first: a scene that asked for `real-demo-video` and
 * landed on an image already violates `_mediaNeedMatchesSource`, so flipping it
 * is a repair rather than an override of an editorial choice.
 */
function _stillRunBreakCandidate(scene, scenes, scriptContext) {
    if (!scene || !_plannerSceneReadsAsStill(scene)) return null;
    if (scene.fullscreenMG) return null;
    const keyword = scene.keyword && scene.keyword !== 'none' ? String(scene.keyword) : '';
    if (!keyword) return null;
    if (scene._personLock) return null; // exact person stills stay on web-image

    const need = _sanitizeMediaNeed(scene.mediaNeed);
    if (need === 'real-demo-video') return { tier: 1, reason: 'mediaNeed=real-demo-video was left on a still' };
    if (need === 'data-graphic' || need === 'template-only') return null;

    const signals = _deriveSceneSignals(scene, scenes, scriptContext);
    if (signals.hasMapCandidate) return null;      // map lane owns this frame
    if (signals.likelyDataImage) return null;      // a number/chart beat wants the graphic lane, not B-roll
    if (_STILL_LOCKED_KEYWORD_RE.test(keyword)) return null;

    if (need === 'generic-broll') return { tier: 2, reason: 'mediaNeed=generic-broll was left on a still' };
    if (signals.likelyAction) return { tier: 3, reason: 'narration describes action that moves' };
    if (signals.isAbstractMood) return { tier: 4, reason: 'mood/scenery beat plays better as moving B-roll' };
    if (need !== 'exact-still') return { tier: 5, reason: 'no exact-still requirement on this beat' };
    return { tier: 6, reason: 'generic query, nothing about it demands a frozen frame' };
}

/**
 * Walk the timeline and make sure no more than MAX_CONSECUTIVE_STILLS stills
 * play back-to-back. Niche-agnostic: every decision reads the scene's own
 * planner fields (mediaNeed, keyword, person lock, derived signals).
 * Returns one entry per scene it converted.
 */
function _breakStillRuns(scenes, scriptContext = {}, plannerDirectives = null) {
    const ordered = (scenes || []).filter(Boolean);
    if (ordered.length <= MAX_CONSECUTIVE_STILLS) return [];

    const videoSource = _pickPreferredVideoSource(
        scriptContext.nicheId || 'general',
        plannerDirectives || { user: {} },
        'youtube'
    );
    const breaks = [];
    // `segmentStart` is the first still of the stretch currently on screen. Once
    // that stretch would exceed the limit we must convert one of its last
    // MAX_CONSECUTIVE_STILLS + 1 scenes; if none of them can carry footage the
    // window slides forward one scene at a time and keeps trying, so an
    // unbreakable clump (person portraits, data beats) shortens the run it is
    // in instead of hiding the rest of it behind a reset counter.
    let segmentStart = 0;

    for (let i = 0; i < ordered.length; i++) {
        if (!_plannerSceneReadsAsStill(ordered[i])) { segmentStart = i + 1; continue; }
        if (i - segmentStart + 1 <= MAX_CONSECUTIVE_STILLS) continue;

        let best = null;
        for (let j = segmentStart; j <= i; j++) {
            const candidate = _stillRunBreakCandidate(ordered[j], ordered, scriptContext);
            if (!candidate) continue;
            // Lowest tier wins; on a tie break as late as possible so one flip
            // buys the most runway.
            if (!best || candidate.tier < best.tier || (candidate.tier === best.tier && j > best.at)) {
                best = { ...candidate, at: j, scene: ordered[j] };
            }
        }

        if (!best) { segmentStart++; continue; }

        const scene = best.scene;
        const before = { mediaType: scene.mediaType || null, sourceHint: scene.sourceHint || null };
        scene.mediaType = 'video';
        scene.sourceHint = videoSource;
        scene._stillRunBreak = true;
        const queryBase = scene.searchKeyword || scene.keyword;
        scene.stockQuery = _autoStockQuery(queryBase);
        scene.webQuery = _autoWebQuery(queryBase, videoSource);
        _rememberSourcePolicyFix(scene, before.sourceHint, videoSource, 'still-run breaker', before.mediaType, 'video');
        breaks.push({
            index: scene.index,
            mode: 'video',
            tier: best.tier,
            reason: best.reason,
            keyword: scene.keyword,
            before,
            after: { mediaType: 'video', sourceHint: videoSource },
        });
        segmentStart = best.at + 1;
    }

    return breaks;
}

// ============================================================
// SOURCE DIVERSITY ENFORCEMENT
// ============================================================

/**
 * Redistribute source hints when one video source dominates too heavily.
 * Ensures visual variety — different providers have different footage styles.
 *
 * Rules:
 * - No single video source should exceed 50% of video scenes
 * - Uses niche footagePriority to know which sources are available
 * - Only reassigns scenes where the source is interchangeable (not person photos, not maps)
 * - Prefers round-robin across top 3 niche sources
 */
// Words that describe ideas/editing/comparisons — they have no stock footage match.
// If the model emits any of these in a keyword, the scene was mis-planned: either the
// narration is metaphorical (→ should be MG/template, not footage) or the model copied
// narrator rhythm instead of picking a concrete shot.
const _BANNED_KEYWORD_TOKENS = [
    'montage', 'mechanism', 'inflation', 'dilemma', 'analogy', 'principle',
    'strategy', 'concept', 'symbolism', 'metaphor', 'paradigm', 'dichotomy',
    'framework', 'equilibrium', 'juxtaposition', 'interplay',
    'side-by-side', 'side by side',
    'breaking apart', 'falling apart', 'grid collapse', 'system breaking',
    'network grid', 'collapsing system'
];

// State+military-actor detector — these scenes must not hit stock.
const _NEWS_ACTORS_RE = /\b(iran|iranian|russia|russian|houthi|houthis|hamas|idf|nato|ukraine|ukrainian|israel|israeli|china|chinese|north korea|hezbollah|taliban|isis|isil|putin|netanyahu|zelensky|khamenei)\b/i;
const _MILITARY_VERBS_RE = /\b(navy|forces|strike|patrol|attack|invasion|missile|drone strike|blockade|sanctions|bombing|airstrike|troop|combat|military|warship|coastline|frontline)\b/i;

function _isAbstractKeyword(kw) {
    if (!kw) return null;
    const lower = kw.toLowerCase();
    for (const token of _BANNED_KEYWORD_TOKENS) {
        if (lower.includes(token)) return token;
    }
    return null;
}

function _countConcreteNouns(kw) {
    if (!kw) return 0;
    // Rough heuristic: words that aren't stop/filler words and aren't articles/conjunctions.
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'over', 'under', 'through']);
    return kw.toLowerCase().split(/\s+/).filter(w => w && !STOP.has(w)).length;
}

/**
 * Post-AI keyword compliance. Three rules:
 *   1. Abstract tokens (montage, inflation, ...) → strip keyword, flip to fullscreenMG
 *      or rewrite from visualIntent if concrete fallback exists.
 *   2. News-actor + military verb → force sourceHint to niche's #1 source (never stock).
 *   3. sourceHint=stock AND noun-count > 3 → truncate via _autoStockQuery.
 *
 * Returns an array of { index, reason, before, after, sourceChange } for logging.
 */
function _enforceKeywordCompliance(scenes, scriptContext) {
    const violations = [];
    const { getNiche: _getNiche } = require('../data/niches');
    const niche = _getNiche(scriptContext.nicheId || 'general');
    const videoPriority = _videoPriorityForVp(niche, 'youtube');

    for (const scene of scenes) {
        if (!scene.keyword || scene.keyword === 'none') continue;
        if (scene.fullscreenMG) continue; // already flipped to MG
        if (scene.templateHint) continue; // template background keyword, not standalone footage

        let before = scene.keyword;
        const text = String(scene.text || '');

        const displayRepair = repairDisplaySearchQuery(scene.keyword, scene, scriptContext, {
            maxWords: scene.mediaType === 'image' ? 8 : 6,
        });
        if (displayRepair.changed) {
            scene.keyword = displayRepair.after;
            scene.searchKeyword = displayRepair.after;
            scene.stockQuery = _autoStockQuery(scene.keyword);
            scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);
            violations.push({
                index: scene.index,
                reason: 'display-layer keyword',
                before,
                after: scene.keyword,
            });
            before = scene.keyword;
        }

        // Rule 1: abstract token
        const banned = _isAbstractKeyword(scene.keyword);
        if (banned) {
            // Try to rewrite from visualIntent (first 3 concrete nouns), else flip to
            // fullscreenMG focusWord using the most content-bearing word in the narration.
            const intentWords = String(scene.visualIntent || '')
                .toLowerCase().split(/\s+/)
                .filter(w => w && w.length > 3 && !_isAbstractKeyword(w))
                .slice(0, 3);
            if (intentWords.length >= 2) {
                scene.keyword = intentWords.join(' ');
                scene.stockQuery = _autoStockQuery(scene.keyword);
                scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);
                violations.push({ index: scene.index, reason: `banned token "${banned}"`, before, after: scene.keyword });
            } else {
                // No concrete fallback — flip to focusWord MG so scene still renders
                scene.fullscreenMG = `focusWord: ${text.split(/\s+/).slice(0, 4).join(' ')}`;
                scene.keyword = null;
                scene.sourceHint = null;
                violations.push({ index: scene.index, reason: `banned token "${banned}" (no concrete fallback)`, before, after: '→ fullscreenMG focusWord' });
                continue;
            }
        }

        // Rule 2: news-actor + military verb → force off-stock to niche's #1 source
        if (scene.sourceHint === 'stock') {
            if (_NEWS_ACTORS_RE.test(text) && _MILITARY_VERBS_RE.test(text)) {
                const oldSrc = scene.sourceHint;
                scene.sourceHint = _sanitizeVpSourceHint(videoPriority[0] || 'youtube', 'youtube');
                violations.push({
                    index: scene.index,
                    reason: 'news-actor routed to stock',
                    before: scene.keyword,
                    after: scene.keyword,
                    sourceChange: `${oldSrc} → ${scene.sourceHint}`
                });
            }
        }

        // Rule 3: stock keyword noun cap (max 3) — narrows stockQuery only, leaves
        // scene.keyword as the canonical descriptive form so source flips downstream
        // (orchestrator or diversity rebalancer) keep the full names/figures.
        if (scene.sourceHint === 'stock' && _countConcreteNouns(scene.keyword) > 3) {
            const truncated = _autoStockQuery(scene.keyword);
            if (truncated && truncated !== scene.keyword) {
                violations.push({ index: scene.index, reason: `stock noun-cap (>3)`, before: scene.keyword, after: `stockQuery="${truncated}" (keyword preserved)` });
                scene.stockQuery = truncated;
            }
        }
    }
    return violations;
}

/**
 * Break long runs of adjacent typography overlays (mgHint=focusWord/kineticText/typographyReveal).
 * Rule:
 *   - 2 adjacent scenes with same typography type → flip the 2nd to a different typography type.
 *   - 3 adjacent typography scenes (any mix) → promote the middle one to a keyTakeaway
 *     template (clearing its typography mgHint) when it has narrative weight.
 * Only touches scenes whose mgHint starts with focusWord/kineticText/typographyReveal —
 * leaves data overlays (statCounter, dataBar, etc.) and fullscreen MGs alone.
 */
function _dedupTypographyRuns(scenes) {
    const fixes = [];
    const TYPO_ROTATION = ['focusWord', 'kineticText', 'typographyReveal'];
    const typographyOverlayType = (s) => {
        if (!s.mgHint) return null;
        const m = String(s.mgHint).match(/^(focusWord|kineticText|typographyReveal)\s*:/i);
        if (!m) return null;
        // Normalize back to canonical casing
        const lower = m[1].toLowerCase();
        if (lower === 'focusword') return 'focusWord';
        if (lower === 'kinetictext') return 'kineticText';
        if (lower === 'typographyreveal') return 'typographyReveal';
        return null;
    };

    for (let i = 0; i < scenes.length; i++) {
        const curr = typographyOverlayType(scenes[i]);
        if (!curr) continue;

        // Case 1: same type as previous scene → swap the CURRENT one to a different typography type
        const prev = i > 0 ? typographyOverlayType(scenes[i - 1]) : null;
        if (prev && prev === curr) {
            const other = TYPO_ROTATION.find(t => t !== curr) || 'focusWord';
            const body = String(scenes[i].mgHint).replace(/^[^:]+:/, '').trim();
            const before = scenes[i].mgHint;
            scenes[i].mgHint = `${other}: ${body}`;
            fixes.push({
                index: scenes[i].index,
                lane: scenes[i].templateHint ? 'template overlay' : 'footage overlay',
                before,
                after: scenes[i].mgHint
            });
            continue;
        }

        // Case 2: three typography in a row → promote middle to keyTakeaway template
        const prev2 = i >= 2 ? typographyOverlayType(scenes[i - 2]) : null;
        if (prev && prev2) {
            const mid = scenes[i - 1];
            if (!mid.templateHint) {
                const line = String(mid.text || '').split(/[.!?]/)[0].trim().slice(0, 90);
                if (line.length >= 8) {
                    const beforeMg = mid.mgHint;
                    mid.templateHint = `keyTakeaway: ${line}`;
                    mid.mgHint = null;
                    mid.keyword = mid.keyword || null;
                    fixes.push({
                        index: mid.index,
                        lane: 'overlay converted to template',
                        before: beforeMg,
                        after: `templateHint=${mid.templateHint}`
                    });
                }
            }
        }
    }
    return fixes;
}

const _DATA_FULLSCREEN_MGS = new Set(['barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList']);

function _titleCaseShortPhrase(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9%+\-\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, 4)
        .map(word => {
            if (/^[A-Z0-9%+\-]+$/.test(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
}

function _sceneIntentText(scene, scenes, scriptContext = {}, globalOutline = null, radius = 1) {
    const windowScenes = _sceneWindow(scene, scenes, radius);
    const outlineHint = globalOutline?.sceneHints?.[scene.index];
    return [
        ...windowScenes.flatMap(s => [s?.text, s?.visualIntent, s?.fullscreenMG, s?.templateHint, s?.mgHint]),
        outlineHint?.raw,
    ].filter(Boolean).join(' ');
}

function _countNumericEvidence(value) {
    const text = String(value || '');
    const matches = text.match(/\b\d+(?:[.,]\d+)?\s*(?:%|percent|million|billion|trillion|barrels?|ships?|years?|days?|hours?|km|miles?)?\b/gi) || [];
    return matches.length;
}

function _hasDataVisualEvidence(scene, scenes, scriptContext = {}, globalOutline = null) {
    const ownText = [scene?.text, scene?.fullscreenMG, scene?.templateHint, scene?.mgHint].filter(Boolean).join(' ');
    const windowText = _sceneIntentText(scene, scenes, scriptContext, globalOutline, 1);
    const ownNumbers = _countNumericEvidence(ownText);
    const windowNumbers = _countNumericEvidence(windowText);
    if (ownNumbers >= 2) return true;
    if (scene?.sceneClass === 'data-claim' && ownNumbers >= 1) return true;
    if (scene?.sceneClass === 'data-claim' && /\b(share|traffic|volume|daily|annual|percent|rate|drop|increase|decrease|million|billion|barrels?)\b/i.test(windowText) && windowNumbers >= 1) return true;
    return false;
}

function _hasComparisonOrRouteIntent(scene, scenes, scriptContext = {}, globalOutline = null) {
    const text = _sceneIntentText(scene, scenes, scriptContext, globalOutline, 1);
    const lower = text.toLowerCase();
    if (/\b(vs\.?|versus|compared?\s+to|comparison|before\s+and\s+after)\b/i.test(text)) return true;
    if (/\bfrom\s+[a-z][a-z\s.-]{1,50}\s+to\s+[a-z][a-z\s.-]{1,50}\b/i.test(text)) return true;
    if (/\bbetween\s+[a-z][a-z\s.-]{1,50}\s+and\s+[a-z][a-z\s.-]{1,50}\b/i.test(text)) return true;
    if (/\b(shortest|economical|saves?\s+time|time\s+savings?|route|connection|corridor)\b/i.test(text) &&
        /\b(shanghai|rotterdam|asia|europe|suez|canal|route|shipping)\b/i.test(text)) {
        return true;
    }

    const entities = Array.isArray(scriptContext.entities) ? scriptContext.entities : [];
    const entityTypes = scriptContext.entityTypes || {};
    const placeTypes = new Set(['place', 'location', 'country', 'city', 'region', 'waterbody']);
    const placeHits = entities.filter(entity => {
        const key = String(entity || '').toLowerCase();
        if (!key || !lower.includes(key)) return false;
        const type = entityTypes[key];
        return !type || placeTypes.has(type);
    });
    return placeHits.length >= 2 && /\b(route|connection|between|to|from|trade|shipping)\b/i.test(text);
}

function _hasOwnComparisonOrRouteIntent(scene, scriptContext = {}, globalOutline = null) {
    return _hasComparisonOrRouteIntent(scene, [scene], scriptContext, globalOutline);
}

function _hasTimelineTemplateIntent(scene) {
    const text = [
        scene?.text,
        scene?.visualIntent,
        scene?.templateHint,
        scene?.fullscreenMG,
        scene?.mgHint,
    ].filter(Boolean).join(' ');
    if (/\b(timeline|history|historical|chronology|since|over\s+the\s+(past|last)\s+\d+\s+(years?|decades?|centuries?)|opened|opening|founded|began|started)\b/i.test(text)) {
        return true;
    }
    const years = text.match(/\b(1[89]\d{2}|20[0-3]\d)\b/g) || [];
    return new Set(years).size >= 1 && /\b(before|after|since|from|to|through|years?|decades?|centuries?)\b/i.test(text);
}

const _CONCRETE_FOOTAGE_RE = /\b(cargo|container|ship|ships|vessel|vessels|tanker|tankers|convoy|port|dock|harbor|canal|strait|sea|gulf|ocean|factory|assembly|workers?|officials?|briefing|over[-\s]the[-\s]shoulder|control room|warehouse|logistics|supply chain|truck|rail|train|pipeline|terminal|aerial|satellite|footage|documentary)\b/i;
const _WEAK_FOOTAGE_KEYWORD_RE = /^(?:global|trade|economy|system|risk|route|movement|moving|worst case|just save time|key takeaway|abstract|concept|metaphor)$/i;
const _REAL_SOURCE_HINTS = new Set(['youtube', 'reddit', 'stock']);

function _hasConcreteFootageIntent(scene, scenes, scriptContext = {}, globalOutline = null) {
    if (!scene?.keyword || scene.keyword === 'none') return false;
    if (scene.fullscreenMG || scene.templateHint) return false;
    const keyword = String(scene.keyword || '').trim();
    if (!keyword || _WEAK_FOOTAGE_KEYWORD_RE.test(keyword)) return false;
    const source = String(scene.sourceHint || '').trim();
    if (source && !_REAL_SOURCE_HINTS.has(source)) return false;

    const ownText = [keyword, scene.visualIntent, scene.text].filter(Boolean).join(' ');
    if (_CONCRETE_FOOTAGE_RE.test(ownText)) return true;

    const contextText = _sceneIntentText(scene, scenes, scriptContext, globalOutline, 1);
    if (_CONCRETE_FOOTAGE_RE.test(contextText) && keyword.split(/\s+/).filter(w => w.length > 2 && !_KEYWORD_STOPWORDS.has(w.toLowerCase())).length >= 3) {
        return true;
    }

    return false;
}

function _pickEditorOverlayText(scene, scenes, scriptContext = {}, globalOutline = null) {
    const text = String(scene?.text || '');
    const candidates = [
        [/\bbackup route\b/i, 'Backup Route'],
        [/\bsecond system\b/i, 'Second System'],
        [/\bglobal trade moving\b/i, 'Global Trade Moving'],
        [/\bglobal trade\b/i, 'Global Trade'],
        [/\bshipping chokepoint\b/i, 'Shipping Chokepoint'],
        [/\bsupply chain\b/i, 'Supply Chain'],
        [/\brisk is enough\b/i, 'Risk Alone'],
    ];
    for (const [re, label] of candidates) {
        if (re.test(text)) return label;
    }

    const outlineHint = globalOutline?.sceneHints?.[scene?.index];
    const note = outlineHint?.note || outlineHint?.lane || '';
    if (note && !/^(footage|overlay|template|fullscreen|none)$/i.test(note)) {
        const phrase = _titleCaseShortPhrase(note);
        if (phrase.length >= 4) return phrase;
    }

    const picked = _pickFocusWord(text, scriptContext);
    return picked ? _titleCaseShortPhrase(picked) : null;
}

function _pickEditorFootageKeyword(scene, scenes, scriptContext = {}, globalOutline = null) {
    const text = _sceneIntentText(scene, scenes, scriptContext, globalOutline, 1);
    const concreteMaritime = _pickConcreteFootageKeywordFromText(text);
    if (concreteMaritime) return concreteMaritime;
    if (/\bglobal trade\b/i.test(text) && /\b(route|shipping|moving|system|backup)\b/i.test(text)) return 'global shipping trade route';
    if (/\bcontainer|cargo|port|logistics\b/i.test(text)) return 'container port logistics';
    if (/\boil|barrels?|tanker\b/i.test(text)) return 'oil tanker shipping';
    if (/\bsupply chain\b/i.test(text)) return 'global supply chain logistics';
    return null;
}

function _attachEditorIntentController(scenes, scriptContext = {}, globalOutline = null) {
    const notes = [];
    if (!Array.isArray(scenes)) return notes;

    for (const scene of scenes) {
        if (!scene) continue;
        const fsType = _fullscreenMGType(scene.fullscreenMG);
        const templateType = _getTemplateHintType(scene.templateHint);
        const dataEvidence = _hasDataVisualEvidence(scene, scenes, scriptContext, globalOutline);
        const comparisonIntent = _hasComparisonOrRouteIntent(scene, scenes, scriptContext, globalOutline);
        const ownComparisonIntent = _hasOwnComparisonOrRouteIntent(scene, scriptContext, globalOutline);
        const timelineIntent = _hasTimelineTemplateIntent(scene);
        const concreteFootageIntent = _hasConcreteFootageIntent(scene, scenes, scriptContext, globalOutline);
        const overlayText = _pickEditorOverlayText(scene, scenes, scriptContext, globalOutline);
        const footageKeyword = _pickEditorFootageKeyword(scene, scenes, scriptContext, globalOutline);

        const intent = {
            dataEvidence,
            comparisonIntent,
            ownComparisonIntent,
            timelineIntent,
            concreteFootageIntent,
            overlayText,
            footageKeyword,
            outline: globalOutline?.sceneHints?.[scene.index] || null,
        };

        if (fsType && _DATA_FULLSCREEN_MGS.has(fsType) && (dataEvidence || (fsType === 'comparisonCard' && comparisonIntent))) {
            intent.keepFullscreenMGType = fsType;
            notes.push({ index: scene.index, action: `keep fullscreenMG ${fsType}`, reason: dataEvidence ? 'data evidence in scene/window' : 'comparison/route intent' });
        }
        if (templateType === 'comparisonCard' && (ownComparisonIntent || comparisonIntent)) {
            intent.keepTemplateHintType = templateType;
            notes.push({ index: scene.index, action: `keep templateHint ${templateType}`, reason: 'comparison/route intent across neighboring scenes' });
        }
        if (templateType === 'timelineCard' && timelineIntent) {
            intent.keepTemplateHintType = templateType;
            notes.push({ index: scene.index, action: `keep templateHint ${templateType}`, reason: 'timeline/history intent' });
        }
        if (concreteFootageIntent && scene.retrievability === 'internal-only') {
            intent.keepFootage = true;
            notes.push({ index: scene.index, action: `keep footage keyword`, reason: 'concrete visual referent despite internal-only class' });
        }

        scene._editorIntent = intent;
    }

    return notes;
}

function _payloadForOverlayRelocation(scene, fsType, fallback) {
    const intentText = scene?._editorIntent?.overlayText;
    if (!intentText) return fallback;
    if (_DATA_FULLSCREEN_MGS.has(fsType) && !scene?._editorIntent?.keepFullscreenMGType) {
        return intentText;
    }
    return fallback;
}

function _pickTemplateTypeForEditorIntent(scene, treatment, currentType) {
    const allowed = Array.isArray(treatment?.allowedTemplates) ? treatment.allowedTemplates : [];
    if (allowed.length === 0) return currentType || 'factCard';
    const intent = scene?._editorIntent || {};
    if (allowed.includes(currentType)) return currentType;
    if (currentType === 'timelineCard' && intent.timelineIntent) {
        if (allowed.includes('timelineCard')) return 'timelineCard';
        if (allowed.includes('factCard')) return 'factCard';
        if (allowed.includes('keyTakeaway')) return 'keyTakeaway';
    }
    if (intent.ownComparisonIntent && allowed.includes('comparisonCard')) return 'comparisonCard';
    if (intent.dataEvidence && allowed.includes('statCard')) return 'statCard';
    return allowed[0];
}

/**
 * Post-AI class/treatment validator.
 * When USE_SCENE_CLASSES attached sceneClass+treatmentHint per scene, rewrite
 * any scene whose chosen lane conflicts with its class treatment:
 *   - BLOCKED lane chosen → rewrite to PRIMARY lane
 *   - retrievability=internal-only with a keyword → strip keyword, flip to PRIMARY
 *   - fullscreenMG type not in allowedMGs → replace with first allowed MG
 *   - templateHint not in allowedTemplates → replace with first allowed template
 *
 * Returns array of { index, reason, before, after } for logging.
 */
function _enforceClassTreatment(scenes, scriptContext) {
    const fixes = [];
    for (const scene of scenes) {
        if (!scene.sceneClass || !scene.treatmentHint) continue;
        const t = scene.treatmentHint;
        const blocked = new Set(t.blocked || []);

        // Determine current lane
        let currentLane = null;
        if (scene.fullscreenMG) {
            const fsType = String(scene.fullscreenMG).split(':')[0].trim().toLowerCase();
            currentLane = fsType.startsWith('map') ? 'map' : 'graphics';
        } else if (scene.templateHint) {
            currentLane = 'template';
        } else if (scene.keyword && scene.keyword !== 'none') {
            currentLane = 'footage';
        }

        // Rule 1: internal-only classes must not hit external providers.
        // Use the shared coercion helper so overlay-only allowedMGs are routed
        // through templateHint (with mgHint overlay) instead of being shoved
        // into fullscreenMG (where the renderer would reject them).
        if (scene.retrievability === 'internal-only' && currentLane === 'footage') {
            if (scene._editorIntent?.keepFootage) {
                continue;
            }
            const before = `keyword=${scene.keyword} source=${scene.sourceHint}`;
            const targetLane = (t.primary === 'template' && t.allowedTemplates.length)
                ? 'template'
                : 'graphics';
            _coerceSceneToLane(scene, targetLane, t, scriptContext);
            // _coerceSceneToLane(graphics) may itself fall to template/footage when
            // overlay-only — but we explicitly forbid footage on internal-only, so
            // strip any footage fields it set in that fallback path.
            scene.keyword    = null;
            scene.stockQuery = null;
            scene.webQuery   = null;
            scene.sourceHint = null;
            if (!scene.templateHint && !scene.fullscreenMG) {
                // Last-resort: there were no allowed templates AND no fullscreen
                // MGs available. Force a keyTakeaway template + typography overlay
                // so the scene still has a real background paired with the overlay.
                const line = String(scene.text || '').split(/[.!?]/)[0].trim().slice(0, 90) || _pickFocusWord(scene.text, scriptContext);
                scene.templateHint = `keyTakeaway: ${line}`;
                if (!scene.mgHint) {
                    scene.mgHint = `kineticText: ${_pickFocusWord(scene.text, scriptContext)}`;
                }
            }
            currentLane = scene.templateHint ? 'template'
                        : scene.fullscreenMG ? 'graphics'
                        : 'graphics';
            fixes.push({
                index: scene.index,
                reason: 'internal-only → strip footage',
                before,
                after: scene.fullscreenMG || scene.templateHint || scene.mgHint
            });
            continue;
        }

        // Rule 2: chose a blocked lane → swap to primary lane
        if (currentLane && blocked.has(currentLane)) {
            if (currentLane === 'footage' && scene._editorIntent?.keepFootage) {
                continue;
            }
            const before = `${currentLane}:${scene.fullscreenMG || scene.templateHint || scene.keyword}`;
            _coerceSceneToLane(scene, t.primary, t, scriptContext);
            fixes.push({ index: scene.index, reason: `blocked-lane ${currentLane} → primary ${t.primary}`, before, after: scene.fullscreenMG || scene.templateHint || scene.keyword });
            continue;
        }

        // Rule 3: scene.fullscreenMG must be (a) a fullscreen-eligible type AND
        // (b) inside the class allowlist. Three failure modes, in priority order:
        //   3a. The class has NO fullscreen-eligible types in its allowlist —
        //       this class wasn't designed to carry a fullscreen at all (e.g.
        //       concept-metaphor wants focusWord-as-overlay, actor-event wants
        //       lowerThird-on-footage). Move whatever the AI put in fullscreenMG
        //       to mgHint (using the class's first overlay type when the AI's
        //       pick is itself a fullscreen type that wouldn't read as overlay)
        //       and paint a real background.
        //   3b. AI placed an overlay-only type (focusWord/headline/...) in the
        //       fullscreen slot — same relocation, but keep AI's overlay choice.
        //   3c. AI picked a fullscreen-eligible type that the class blocks —
        //       swap to the first fullscreen-eligible entry in allowedMGs.
        //       If the class has no fullscreen-eligible alternatives, relocate
        //       the type to mgHint with a paired background instead.
        if (scene.fullscreenMG && t.allowedMGs && t.allowedMGs.length) {
            const fsType = _fullscreenMGType(scene.fullscreenMG);
            const rawRest = String(scene.fullscreenMG).split(':').slice(1).join(':').trim() || _pickFocusWord(scene.text, scriptContext);
            const rest = _payloadForOverlayRelocation(scene, fsType, rawRest);
            const inAllow = t.allowedMGs.includes(fsType);
            const isFsEligible = _isFullscreenEligibleMG(fsType);
            const classHasFsEligible = _filterFullscreenEligible(t.allowedMGs).length > 0;
            const overlayChoices = _filterOverlayOnly(t.allowedMGs);
            const isMapChart = _isMapChartMG(scene.fullscreenMG);

            if (scene._editorIntent?.keepFullscreenMGType === fsType && isFsEligible) {
                scene.templateHint = null;
                scene.mgHint = null;
                scene.keyword = null;
                scene.stockQuery = null;
                scene.webQuery = null;
                scene.sourceHint = null;
                continue;
            }

            if (isMapChart) {
                const mapIntent = _sceneHasMapIntent(scene, scenes, scriptContext);
                if (mapIntent && !blocked.has('map')) {
                    // mapChart is its own lane. A geographic scene should not be
                    // translated into lowerThird/statCounter just because the
                    // editorial class mainly lists overlay MGs.
                    scene.templateHint = null;
                    scene.mgHint = null;
                    scene.keyword = null;
                    scene.stockQuery = null;
                    scene.webQuery = null;
                    scene.sourceHint = null;
                    continue;
                }

                const before = scene.fullscreenMG;
                const after = _dropMapChartToFallbackLane(scene, t, scriptContext);
                fixes.push({
                    index: scene.index,
                    reason: mapIntent
                        ? `map blocked for ${scene.sceneClass} -> fallback lane`
                        : `mapChart without map intent -> fallback lane`,
                    before,
                    after
                });
                continue;
            }

            if (!classHasFsEligible) {
                // 3a: Class never wanted a fullscreen MG. The AI's pick is either
                // an overlay type (use it directly as the overlay) or a fullscreen
                // type that doesn't translate (substitute the class's first overlay).
                const before = scene.fullscreenMG;
                const overlayPick = isFsEligible
                    ? (overlayChoices[0] || 'focusWord')
                    : fsType;
                _relocateFullscreenToOverlay(scene, t, overlayPick, rest, scriptContext);
                fixes.push({
                    index: scene.index,
                    reason: isFsEligible
                        ? `class ${scene.sceneClass} has no fullscreen-eligible types — "${fsType}" → mgHint as "${overlayPick}"`
                        : `overlay-only "${fsType}" misplaced as fullscreenMG → moved to mgHint`,
                    before,
                    after: scene.mgHint
                });
            } else if (!isFsEligible) {
                // 3b: Class has fullscreen-eligible options, but AI still picked
                // an overlay type for fullscreenMG. Move it to mgHint and paint
                // a background. (Keeps AI's overlay intent rather than overwriting.)
                const before = scene.fullscreenMG;
                _relocateFullscreenToOverlay(scene, t, fsType, rest, scriptContext);
                fixes.push({
                    index: scene.index,
                    reason: `overlay-only "${fsType}" misplaced as fullscreenMG → moved to mgHint`,
                    before,
                    after: scene.mgHint
                });
            } else if (!inAllow) {
                // 3c: fullscreen-eligible but blocked by class allowlist.
                const before = scene.fullscreenMG;
                const fsAllowed = _filterFullscreenEligible(t.allowedMGs);
                if (fsAllowed.length === 0) {
                    // No fullscreen-eligible options for this class — relocate the
                    // type to mgHint and paint a real background.
                    _relocateFullscreenToOverlay(scene, t, fsType, rest, scriptContext);
                    fixes.push({ index: scene.index, reason: `MG type not allowed for ${scene.sceneClass} (no fs alternatives) → mgHint`, before, after: scene.mgHint });
                } else {
                    const replacement = fsAllowed[0];
                    if (replacement !== fsType) {
                        scene.fullscreenMG = `${replacement}: ${rest}`;
                        fixes.push({ index: scene.index, reason: `MG type not allowed for ${scene.sceneClass}`, before, after: scene.fullscreenMG });
                    }
                }
            }
        }

        // Rule 4: templateHint outside allowedTemplates
        if (scene.templateHint && t.allowedTemplates && t.allowedTemplates.length) {
            const tType = String(scene.templateHint).split(':')[0].trim();
            if (!t.allowedTemplates.includes(tType)) {
                if (scene._editorIntent?.keepTemplateHintType === tType) {
                    continue;
                }
                const before = scene.templateHint;
                const rest = String(scene.templateHint).split(':').slice(1).join(':').trim() || String(scene.text || '').slice(0, 80);
                const replacement = _pickTemplateTypeForEditorIntent(scene, t, tType);
                scene.templateHint = `${replacement}: ${rest}`;
                fixes.push({ index: scene.index, reason: `template type adjusted for ${scene.sceneClass} using editor intent`, before, after: scene.templateHint });
            }
        }

        // Rule 5: footage scene should match preferredSource when AI ignored it
        const preferredSource = _sanitizeVpSourceHint(t.preferredSource, 'youtube');
        if (t.preferredSource && preferredSource !== t.preferredSource) t.preferredSource = preferredSource;
        if (currentLane === 'footage' && preferredSource && scene.sourceHint && scene.sourceHint !== preferredSource) {
            // Only override when source is clearly weaker (stock on news-actor etc.)
            if ((preferredSource === 'youtube' || preferredSource === 'reddit') && (scene.sourceHint === 'stock' || scene.sourceHint === 'storyblocks')) {
                const before = scene.sourceHint;
                scene.sourceHint = preferredSource;
                fixes.push({ index: scene.index, reason: `source ${before} → preferred ${t.preferredSource}`, before, after: t.preferredSource });
            }
        }
    }
    return fixes;
}

// Words that read as filler when shown as a typography card. Pronouns,
// determiners, aux/light verbs, discourse markers, vague nouns. Anything that
// appearing solo on a card looks like the splitter dropped a fragment.
const _FOCUS_WORD_STOPLIST = new Set([
    // pronouns / determiners
    'there', 'their', 'they', 'them', 'this', 'that', 'these', 'those',
    'these', 'whose', 'which', 'what', 'when', 'where', 'while', 'whom',
    // aux / modals / light verbs
    'have', 'having', 'been', 'being', 'were', 'will', 'would', 'could',
    'should', 'shall', 'might', 'must', 'does', 'doing', 'done', 'make',
    'made', 'making', 'take', 'took', 'taken', 'taking', 'give', 'gave',
    'given', 'giving', 'come', 'came', 'going', 'gets', 'getting', 'puts',
    'supposed',
    'said', 'says', 'tell', 'told', 'feel', 'felt', 'know', 'knew', 'known',
    // discourse / fillers
    'well', 'okay', 'just', 'very', 'really', 'maybe', 'pretty', 'quite',
    'somehow', 'anyway', 'actually', 'basically', 'literally', 'honestly',
    'hopefully', 'probably', 'whether', 'about', 'because', 'although',
    'but', 'and', 'also',
    'however', 'meanwhile', 'instead', 'though', 'unless', 'until', 'within',
    'across', 'among', 'between', 'before', 'after', 'around',
    // vague nouns
    'thing', 'things', 'stuff', 'people', 'someone', 'anyone', 'everyone',
    'something', 'anything', 'everything', 'nothing', 'somewhere', 'place',
    'places', 'years', 'days', 'time', 'times', 'side', 'sides', 'idea',
    'ideas', 'kind', 'kinds', 'form', 'forms',
    'global', 'trade', 'shipping', 'route', 'routes', 'system', 'share',
    'economy', 'economic', 'world', 'region', 'movement', 'moving',
    // generic verbs that look weak as a card
    'starts', 'started', 'began', 'begun', 'turns', 'turned', 'looks',
    'looked', 'seems', 'seemed', 'opens', 'opened', 'shows', 'showed',
]);

function _isFocusWordStop(w) {
    if (!w) return true;
    return _FOCUS_WORD_STOPLIST.has(w.toLowerCase());
}

function _isWeakFocusPhrase(value) {
    const words = String(value || '').toLowerCase().match(/\b[a-z0-9]+\b/g) || [];
    if (words.length === 0) return true;
    if (words.length === 1) return _FOCUS_WORD_STOPLIST.has(words[0]);
    return words.length <= 3 && words.every(w => _FOCUS_WORD_STOPLIST.has(w));
}

function _pickFocusPhraseFromNarration(text) {
    const t = String(text || '');
    const patterns = [
        [/\banother route\b/i, 'Backup Route'],
        [/\bbackup\b/i, 'Backup Route'],
        [/\bsecond system\b/i, 'Second System'],
        [/\bkeeps?\s+global\s+trade\s+moving\b/i, 'Trade Lifeline'],
        [/\bquietly\s+becoming\s+unstable\b/i, 'Route Instability'],
        [/\bshipping\s+choke ?point\b/i, 'Shipping Chokepoint'],
        [/\bchoke ?point\b/i, 'Chokepoint Risk'],
        [/\bsupply chain\b/i, 'Supply Chain'],
        [/\brisk\s+is\s+enough\b/i, 'Risk Alone'],
        [/\bnarrowest\s+point\b/i, 'Narrow Chokepoint'],
        [/\btime\s+savings?\b/i, 'Time Savings'],
        [/\bworst\s+case\b/i, 'Worst Case'],
        [/\befficiency\b/i, 'Efficiency'],
        [/\bdisruption\b/i, 'Disruption'],
        [/\binstability\b/i, 'Instability'],
    ];
    for (const [re, label] of patterns) {
        if (re.test(t)) return label;
    }
    return null;
}

// Pick a content-bearing word for use as a focusWord overlay payload.
// Priority ladder:
//   1. Entity from scriptContext.entities that appears in scene text
//   2. Numeric / year / percentage token
//   3. Proper-noun-cased word (capital letter mid-sentence)
//   4. First non-stop, non-abstract content word
//   5. Literal 'focus' fallback
function _pickFocusWord(text, scriptContext) {
    const t = String(text || '');
    if (!t) return 'focus';

    const phrase = _pickFocusPhraseFromNarration(t);
    if (phrase) return phrase;

    // 1. Entity match — pick the longest entity that appears in this scene text.
    const entities = (scriptContext && Array.isArray(scriptContext.entities)) ? scriptContext.entities : [];
    if (entities.length > 0) {
        const lower = t.toLowerCase();
        const matched = entities
            .filter(e => e && lower.includes(String(e).toLowerCase()))
            .filter(e => !_isWeakFocusPhrase(e))
            .sort((a, b) => String(b).length - String(a).length); // prefer most specific
        if (matched.length > 0) return String(matched[0]);
    }

    // 2. Numeric / year / percent / dollar token (e.g. "150", "12%", "$10B", "1869")
    const numMatch = t.match(/\$?\d[\d,.]*%?|\b(?:19|20)\d{2}\b/);
    if (numMatch) return numMatch[0];

    // 3. Proper-noun-cased word mid-sentence (skip first word which is sentence-cap noise)
    //    Strip leading sentence — only check after first word boundary.
    const properRe = /\b[A-Z][a-z]{2,}\b/g;
    const words = t.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
        const m = words[i].match(/^[A-Z][a-z]{2,}$/);
        if (m && !_isFocusWordStop(m[0]) && !_isAbstractKeyword(m[0])) {
            return m[0];
        }
    }
    // First-word fallback: only allow proper nouns (length > 3) — avoids "There"/"When".
    if (words[0]) {
        const first = words[0].replace(/[^A-Za-z]/g, '');
        if (/^[A-Z][a-z]{3,}$/.test(first) && !_isFocusWordStop(first) && !_isAbstractKeyword(first)) {
            return first;
        }
    }

    // 4. First content word — 4+ letters, not stop, not abstract.
    const tokens = t.match(/\b[A-Za-z]{4,}\b/g) || [];
    for (const w of tokens) {
        if (!_isFocusWordStop(w) && !_isAbstractKeyword(w) && !_isWeakFocusPhrase(w)) return w.toLowerCase();
    }

    // 5. Literal fallback — never return a known stopword.
    return 'focus';
}

function _dropMapChartToFallbackLane(scene, treatment, scriptContext) {
    scene.fullscreenMG = null;
    scene.mapVariant = null;

    const templates = Array.isArray(treatment.allowedTemplates) ? treatment.allowedTemplates : [];
    const line = String(scene.text || '').split(/[.!?]/)[0].trim().slice(0, 80);
    const preferTemplate = treatment.primary === 'template' ||
        treatment.primary === 'graphics' ||
        scene.retrievability === 'internal-only';

    if (preferTemplate && templates.length > 0) {
        scene.templateHint = scene.templateHint || `${templates[0]}: ${line}`;
        scene.keyword = null;
        scene.stockQuery = null;
        scene.webQuery = null;
        scene.sourceHint = null;
        scene.mediaType = scene.mediaType || 'video';
        return scene.templateHint;
    }

    scene.templateHint = null;
    if (!scene.keyword || _isWeakFootageKeyword(scene.keyword)) {
        scene.keyword =
            scene._editorIntent?.footageKeyword ||
            _pickConcreteFootageKeywordFromText(scene.text || '') ||
            _pickFocusWord(scene.text, scriptContext);
    }
    scene.sourceHint = _sanitizeVpSourceHint(treatment.preferredSource || scene.sourceHint || 'stock', 'youtube');
    scene.mediaType = scene.mediaType || 'video';
    scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword);
    scene.webQuery = scene.webQuery || _autoWebQuery(scene.keyword, scene.sourceHint);
    return `keyword=${scene.keyword} source=${scene.sourceHint}`;
}

// Move a misplaced fullscreenMG into the overlay (mgHint) slot, then paint a
// real background. Pick the background lane that matches editorial intent:
// classes with primary=footage want real footage under the overlay; classes
// with primary=graphics/template prefer a template background. Used by Rule
// 3a + 3b in _enforceClassTreatment.
function _relocateFullscreenToOverlay(scene, treatment, overlayType, payload, scriptContext) {
    scene.fullscreenMG = null;
    scene.mgHint = `${overlayType}: ${payload}`;

    const preferFootage = treatment.primary === 'footage';
    const hasTemplates  = treatment.allowedTemplates && treatment.allowedTemplates.length;

    if (preferFootage || !hasTemplates) {
        // Footage background — overlay rides on real video.
        if (!scene.keyword || _isWeakFootageKeyword(scene.keyword)) {
            scene.keyword =
                scene._editorIntent?.footageKeyword ||
                _pickConcreteFootageKeywordFromText(scene.text || '') ||
                _pickFocusWord(scene.text, scriptContext);
        }
        scene.sourceHint = _sanitizeVpSourceHint(treatment.preferredSource || scene.sourceHint || 'stock', 'youtube');
        scene.mediaType  = scene.mediaType || 'video';
        scene.templateHint = null;
    } else {
        // Template background — drawn underneath the overlay.
        if (!scene.templateHint) {
            const line = String(scene.text || '').split(/[.!?]/)[0].trim().slice(0, 80);
            scene.templateHint = `${treatment.allowedTemplates[0]}: ${line}`;
        }
        scene.keyword    = null;
        scene.stockQuery = null;
        scene.webQuery   = null;
        scene.sourceHint = null;
    }
}

function _coerceSceneToLane(scene, lane, treatment, scriptContext) {
    // Clear existing lane markers
    if (lane !== 'footage')  { scene.keyword = null; scene.stockQuery = null; scene.webQuery = null; }
    if (lane !== 'graphics' && lane !== 'map') scene.fullscreenMG = null;
    if (lane !== 'template') scene.templateHint = null;

    const line = String(scene.text || '').split(/[.!?]/)[0].trim().slice(0, 80);
    if (lane === 'footage') {
        if (!scene.keyword || _isWeakFootageKeyword(scene.keyword)) {
            scene.keyword =
                scene._editorIntent?.footageKeyword ||
                _pickConcreteFootageKeywordFromText(scene.text || '') ||
                _pickFocusWord(scene.text, scriptContext);
        }
        scene.sourceHint = _sanitizeVpSourceHint(treatment.preferredSource || scene.sourceHint || 'stock', 'youtube');
        scene.mediaType  = scene.mediaType || 'video';
    } else if (lane === 'map') {
        if (treatment.allowedMGs && treatment.allowedMGs.includes('mapChart')) {
            scene.fullscreenMG = scene.fullscreenMG || 'mapChart: locator';
        } else {
            // Map lane chosen but no map type allowed → fall back to graphics handling.
            _coerceSceneToLane(scene, 'graphics', treatment, scriptContext);
            return;
        }
    } else if (lane === 'graphics') {
        // Graphics lane: only fullscreen-eligible types belong in fullscreenMG.
        // Overlay types (focusWord/callout/headline/statCounter/...) need a
        // background, so route them to mgHint and pick a lane that paints one.
        const allowed = Array.isArray(treatment.allowedMGs) ? treatment.allowedMGs : [];
        const fsEligible = _filterFullscreenEligible(allowed);
        const overlayTypes = _filterOverlayOnly(allowed);

        if (fsEligible.length > 0) {
            scene.fullscreenMG = `${fsEligible[0]}: ${_pickFocusWord(scene.text, scriptContext)}`;
            scene.mgHint = null;
            return;
        }

        // No fullscreen-eligible MG → graphics lane can't actually fullscreen here.
        // Fall down the ladder: prefer template (it has its own background), else
        // stock-mood footage. In both cases attach the overlay via mgHint.
        scene.fullscreenMG = null;

        // Preserve AI's existing mgHint when it's already a class-allowed overlay.
        // The AI usually picks better payloads (e.g. "lowerThird: Suez Canal, 1869")
        // than _pickFocusWord can synthesize. Only overwrite when AI gave nothing
        // or gave an out-of-class type.
        let overlayPayload = null;
        if (scene.mgHint) {
            const existingType = String(scene.mgHint).split(':')[0].trim();
            if (allowed.includes(existingType)) {
                overlayPayload = scene.mgHint;
            }
        }
        if (!overlayPayload) {
            const overlayPick = overlayTypes[0] || 'focusWord';
            overlayPayload = `${overlayPick}: ${_pickFocusWord(scene.text, scriptContext)}`;
        }

        if (treatment.allowedTemplates && treatment.allowedTemplates.length) {
            scene.templateHint = `${treatment.allowedTemplates[0]}: ${line}`;
            scene.keyword = null;
            scene.stockQuery = null;
            scene.webQuery = null;
            scene.sourceHint = null;
        } else {
            scene.keyword    = scene.keyword || _pickFocusWord(scene.text, scriptContext);
            scene.sourceHint = 'stock';
            scene.mediaType  = scene.mediaType || 'video';
        }
        scene.mgHint = overlayPayload;
    } else if (lane === 'template') {
        const tpl = (treatment.allowedTemplates && treatment.allowedTemplates[0]) || 'factCard';
        scene.templateHint = `${tpl}: ${line}`;
    }
}

function _enforceSourceDiversity(scenes, nicheId) {
    const { getNiche: _getNiche } = require('../data/niches');
    const niche = _getNiche(nicheId || 'general');
    const videoPriority = [...new Set(
        filterDisabledSources(niche.footagePriority?.video || ['youtube', 'pexels', 'pixabay', 'reddit'])
            .map(providerToSourceHint)
            .filter(Boolean)
    )];

    // Only consider real footage scenes with swappable sources. Template
    // backgrounds and fullscreen MGs are different lanes; do not count or
    // rewrite them as if they were standalone footage downloads.
    const LOCKED_HINTS = new Set(['web-image']); // exact/reference stills stay on Bing
    const videoScenes = scenes.filter(s =>
        s.mediaType === 'video' &&
        !s.fullscreenMG &&
        !s.templateHint &&
        s.keyword &&
        s.keyword !== 'none' &&
        !LOCKED_HINTS.has(s.sourceHint)
    );

    if (videoScenes.length < 6) return; // too few to care about diversity

    // Count source distribution
    const counts = {};
    for (const s of videoScenes) {
        const src = s.sourceHint || 'stock';
        counts[src] = (counts[src] || 0) + 1;
    }

    // Find dominant source
    const maxAllowed = Math.ceil(videoScenes.length * 0.50); // no source should exceed 50%
    let dominant = null;
    let dominantCount = 0;
    for (const [src, count] of Object.entries(counts)) {
        if (count > maxAllowed && count > dominantCount) {
            dominant = src;
            dominantCount = count;
        }
    }

    if (!dominant) return; // distribution is fine

    // How many to reassign from the dominant source
    const excess = dominantCount - maxAllowed;

    // Pick alternative sources from niche priority (skip the dominant one)
    const alternatives = videoPriority.filter(s => s !== dominant);
    if (alternatives.length === 0) return;

    // Scenes eligible for reassignment: dominant source, not hook/CTA, not person-specific
    const PERSON_KW = /portrait|headshot|photo of|face of|mugshot/i;
    const eligible = videoScenes.filter(s =>
        (s.sourceHint || 'stock') === dominant &&
        s.sceneType !== 'hook' && s.sceneType !== 'cta' &&
        !PERSON_KW.test(s.keyword || '')
    );

    // Round-robin reassign from the middle of the video (keep first/last scenes stable)
    // Sort by scene index, skip first 2 and last 2
    eligible.sort((a, b) => (a.index || 0) - (b.index || 0));
    const reassignable = eligible.length > 4
        ? eligible.slice(2, -2)  // skip first 2 and last 2
        : eligible.slice(1);     // at least skip the first

    let reassigned = 0;
    for (let i = 0; i < reassignable.length && reassigned < excess; i++) {
        const scene = reassignable[i];
        const newSource = alternatives[reassigned % alternatives.length];
        scene.sourceHint = newSource;
        scene.stockQuery = _autoStockQuery(scene.keyword);
        scene.webQuery = _autoWebQuery(scene.keyword, newSource);
        reassigned++;
    }

    if (reassigned > 0) {
        // Recount for logging
        const newCounts = {};
        for (const s of videoScenes) {
            const src = s.sourceHint || 'stock';
            newCounts[src] = (newCounts[src] || 0) + 1;
        }
        const distStr = Object.entries(newCounts).map(([k, v]) => `${k}:${v}`).join(', ');
        console.log(`   🔀 Source diversity: ${dominant} was ${dominantCount}/${videoScenes.length} (${Math.round(dominantCount / videoScenes.length * 100)}%) — redistributed ${reassigned} scenes → [${distStr}]`);
    }
}

// ============================================================
// KEYWORD QUALITY VALIDATOR
// ============================================================

// Words that signal abstract/metaphorical/unsearchable keywords
const ABSTRACT_WORDS = new Set([
    'analogy', 'metaphor', 'concept', 'principle', 'philosophy', 'theory',
    'dilemma', 'paradox', 'irony', 'symbolism', 'allegory', 'notion',
    'abstraction', 'essence', 'elegance', 'implications', 'perspective',
    'dynamics', 'paradigm', 'framework', 'methodology', 'rationale',
    'simulation', 'visualization', 'conceptual', 'hypothetical',
    'anchor', 'intro', 'outro', 'cta', 'transition', 'statement',
    'comparison', 'contrast', 'overview', 'summary', 'recap',
]);

// Phrases that are unsearchable (no real footage exists)
const ABSTRACT_PHRASES = [
    /\b(sun tzu|art of war)\b/i,
    /\b(no[- ]win|win[- ]win)\b/i,
    /\blighthouse\s+emission\b/i,
    /\bpaper\s+(defense|strategy|plan)\b/i,
    /\b(physics|math)\s+(trap|trick|principle)\b/i,
    /\b(cost|price)\s+exchange\b/i,
    /\b(daily|trade|traffic)\s+flows?\b/i,
    /\b(global|world)\s+trade\s+(share|volume|flow|flows?)\b/i,
    /\bbab[-\s]?el[-\s]?mandeb\s+daily\s+flows?\b/i,
    /\b(channel|subscribe|like|comment)\s+(comparison|intro|outro|cta)\b/i,
];

// Mood/style adjectives — fine as flavor when paired with a concrete subject
// ("dark warehouse"), but useless when the entire phrase is mood + generic
// staging nouns ("dark ominous background with shipping elements"). Stock
// providers return zero usable results for mood-only queries because no
// footage gets tagged as just "ominous".
const _MOOD_ADJECTIVES = new Set([
    'dark', 'darkened', 'ominous', 'moody', 'atmospheric', 'eerie', 'sinister',
    'gloomy', 'somber', 'melancholic', 'foreboding', 'tense', 'bleak', 'grim',
    'dramatic', 'cinematic', 'epic', 'subtle', 'minimalist', 'abstract',
    'stylized', 'artistic', 'aesthetic',
]);
const _STAGING_NOUNS = new Set([
    'background', 'backdrop', 'atmosphere', 'ambience', 'mood', 'tone',
    'elements', 'aesthetic', 'vibe', 'feel', 'setting', 'scene', 'imagery',
    'composition', 'theme',
]);
const _MOOD_FILLER = new Set([
    'with', 'and', 'or', 'of', 'in', 'on', 'a', 'an', 'the', 'some',
]);

// Returns { stripped, moodHits, stagingHits, concrete } after dropping
// mood/staging tokens. When stripped differs from input and is non-empty,
// the caller can use it as a cleaner search query.
function _stripMoodTokens(kw) {
    const raw = String(kw || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
    const words = raw.split(/\s+/).filter(Boolean);
    let moodHits = 0;
    let stagingHits = 0;
    const kept = [];
    for (const w of words) {
        if (_MOOD_FILLER.has(w)) continue;
        if (_MOOD_ADJECTIVES.has(w)) { moodHits++; continue; }
        if (_STAGING_NOUNS.has(w)) { stagingHits++; continue; }
        kept.push(w);
    }
    return { stripped: kept.join(' '), moodHits, stagingHits, concrete: kept.length };
}

// True when mood/staging tokens dominate the keyword and the concrete
// remainder is too thin to search on its own.
function _isMoodDominatedKeyword(kw) {
    if (!kw) return false;
    const { moodHits, stagingHits, concrete } = _stripMoodTokens(kw);
    if (moodHits === 0 && stagingHits === 0) return false;
    if (concrete === 0) return true;
    // Mood/staging tokens outnumber concrete tokens → mood-dominated.
    return (moodHits + stagingHits) >= concrete;
}

/**
 * Extract a concrete keyword from scene text by picking the most visual nouns.
 * Used as fallback when the AI-generated keyword is abstract/unsearchable.
 */
function _extractConcreteKeyword(text, entities) {
    if (!text) return null;

    // If scene mentions entities, use the first entity + context
    if (entities && entities.length > 0) {
        // Find which entity appears in this scene's text
        for (const entity of entities) {
            if (text.toLowerCase().includes(entity.toLowerCase())) {
                return entity;
            }
        }
    }

    // Extract noun phrases — prefer capitalized words (proper nouns), military/tech terms
    const CONCRETE_PATTERNS = [
        // Specific equipment/systems: "F-35C", "Bavar-373", "S-300"
        /\b[A-Z][\w-]*[-]\d+\w*\b/g,
        // Proper nouns (2+ capitalized words): "Cyber Command", "Persian Gulf"
        /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g,
        // Single proper nouns: "Iran", "Pentagon", "Tomahawk"
        /\b[A-Z][a-z]{3,}\b/g,
    ];

    const found = [];
    for (const pattern of CONCRETE_PATTERNS) {
        const matches = text.match(pattern);
        if (matches) {
            for (const m of matches) {
                // Skip common words that happen to be capitalized (start of sentence)
                const lower = m.toLowerCase();
                if (['the', 'this', 'that', 'when', 'what', 'here', 'there', 'every',
                     'because', 'before', 'after', 'while', 'other', 'something',
                     'nothing', 'everything', 'imagine', 'reverse', 'respect',
                     'not', 'but', 'and', 'start', 'now'].includes(lower)) continue;
                found.push(m);
            }
        }
        if (found.length >= 3) break;
    }

    if (found.length === 0) return null;

    // Take up to 3 unique terms
    const unique = [...new Set(found)].slice(0, 3);
    return unique.join(' ');
}

/**
 * Validate and fix abstract/unsearchable keywords.
 * Runs after AI response is parsed — no extra AI calls needed.
 */
function _validateKeywords(scenes, scriptContext) {
    let fixed = 0;
    let moodFixed = 0;

    for (const scene of scenes) {
        // Template scenes don't have scene.keyword but their templateBgQuery
        // becomes a search query downstream (prepareTemplateBackupFootage).
        // Clean mood-dominated bg queries here so we don't ship junk to
        // Stock searches like "dark ominous background shipping map".
        if (scene.templateBgQuery && _isMoodDominatedKeyword(scene.templateBgQuery)) {
            const before = scene.templateBgQuery;
            const { stripped } = _stripMoodTokens(before);
            const fallback = _pickConcreteFootageKeywordFromText(scene.text || '')
                || _extractConcreteKeyword(scene.text, scriptContext?.entities);
            const replacement = (stripped && stripped.split(/\s+/).length >= 2) ? stripped : fallback;
            if (replacement && replacement !== before) {
                scene.templateBgQuery = replacement;
                console.log(`   🎭 Scene ${scene.index}: mood-dominated templateBgQuery "${before}" → "${replacement}"`);
                moodFixed++;
            }
        }

        if (!scene.keyword || scene.fullscreenMG) continue;

        const keyword = scene.keyword.toLowerCase();
        const words = keyword.split(/\s+/);

        // Check 1: keyword contains abstract words
        const hasAbstract = words.some(w => ABSTRACT_WORDS.has(w));

        // Check 2: keyword matches abstract phrase patterns
        const hasAbstractPhrase = ABSTRACT_PHRASES.some(re => re.test(keyword));

        // Check 3: keyword has no concrete nouns (all generic/filler words)
        const FILLER_WORDS = new Set([
            'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with',
            'and', 'or', 'but', 'not', 'no', 'is', 'was', 'are', 'were', 'be',
            'this', 'that', 'how', 'why', 'what', 'when', 'where', 'who',
            'new', 'old', 'modern', 'real', 'simple', 'complex',
        ]);
        const meaningfulWords = words.filter(w => w.length > 2 && !FILLER_WORDS.has(w));
        const allAbstract = meaningfulWords.length > 0 && meaningfulWords.every(w => ABSTRACT_WORDS.has(w));

        // Check 4: mood-dominated keyword (e.g. "dark ominous background shipping map")
        const isMoodDominated = _isMoodDominatedKeyword(scene.keyword);

        if (hasAbstract || hasAbstractPhrase || allAbstract || isMoodDominated) {
            // Build reason string for logging
            const reasons = [];
            if (hasAbstract) reasons.push(`word: "${words.find(w => ABSTRACT_WORDS.has(w))}"`);
            if (hasAbstractPhrase) reasons.push('abstract phrase');
            if (allAbstract) reasons.push('all abstract');
            if (isMoodDominated) reasons.push('mood-dominated');

            // For mood-dominated keywords prefer the stripped concrete tail
            // ("dark ominous background shipping map" → "shipping map") before
            // falling back to scene-text extraction.
            const moodStripped = isMoodDominated ? _stripMoodTokens(scene.keyword).stripped : '';
            const replacement =
                scene._editorIntent?.footageKeyword ||
                (moodStripped && moodStripped.split(/\s+/).length >= 2 ? moodStripped : null) ||
                _pickConcreteFootageKeywordFromText(scene.text || '') ||
                _extractConcreteKeyword(scene.text, scriptContext?.entities);

            if (replacement && replacement !== scene.keyword) {
                const old = scene.keyword;
                scene.keyword = replacement;
                // Also regenerate stockQuery and webQuery
                const oldStock = scene.stockQuery;
                const oldWeb = scene.webQuery;
                scene.stockQuery = _autoStockQuery(replacement);
                scene.webQuery = _autoWebQuery(replacement, scene.sourceHint);
                console.log(`   🔧 Scene ${scene.index}: keyword "${old}" → "${replacement}" [${reasons.join(', ')}]`);
                console.log(`      stock: "${oldStock || ''}" → "${scene.stockQuery}" | web: "${oldWeb || ''}" → "${scene.webQuery}"`);
                fixed++;
            } else {
                console.log(`   ⚠️ Scene ${scene.index}: abstract keyword "${scene.keyword}" [${reasons.join(', ')}] — no concrete replacement found`);
            }
        }
    }

    if (fixed > 0) {
        console.log(`   📝 Fixed ${fixed} abstract keyword(s)`);
    }
    if (moodFixed > 0) {
        console.log(`   📝 Fixed ${moodFixed} mood-dominated template background query(ies)`);
    }
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

function _envInt(name, fallback) {
    const value = parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function _plannerLargeMaxTokens(sceneCount) {
    // The batch schema is intentionally rich. With Sonnet, 10-scene batches were
    // regularly stopping at max_tokens=2200 and omitting tail scene IDs. Keep this
    // semantic batch path intact by giving the model enough completion room.
    const perScene = _envInt('VP_BATCH_TOKENS_PER_SCENE', 360);
    const minTokens = _envInt('VP_BATCH_MIN_TOKENS', 1800);
    const cap = _envInt('VP_BATCH_MAX_TOKENS', 5200);
    return Math.min(cap, Math.max(minTokens, sceneCount * perScene));
}

function _plannerRepairMaxTokens(sceneCount) {
    return Math.min(
        _envInt('VP_BATCH_REPAIR_MAX_TOKENS', 2400),
        Math.max(_envInt('VP_BATCH_REPAIR_MIN_TOKENS', 700), sceneCount * 420)
    );
}

function _plannerSmallMaxTokens() {
    return _envInt('VP_SINGLE_SCENE_MAX_TOKENS', 520);
}

function buildBatchCompletionPrompt(missingScenes, parentScenes, scriptContext, directorsBrief, plannerDirectives = null, globalOutline = null, usedKeywords = []) {
    const { getNiche } = require('../data/niches');
    const nicheId = scriptContext.nicheId || 'general';
    const niche = getNiche(nicheId);
    const videoPriority = _videoPriorityForVp(niche, 'youtube');
    const buildLang = scriptContext.language || 'en';
    const isNonEnglish = buildLang && buildLang !== 'en';
    const _langNames = { de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', ko: 'Korean', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese', zh: 'Chinese', ar: 'Arabic', tr: 'Turkish', hi: 'Hindi' };
    const buildLangName = _langNames[buildLang] || buildLang;
    const { tier = {} } = directorsBrief || {};
    plannerDirectives = plannerDirectives || _buildPlannerDirectives(parentScenes || missingScenes, scriptContext, directorsBrief);

    const sceneList = missingScenes.map(scene => {
        const duration = Number(scene.endTime) > Number(scene.startTime)
            ? `${scene.startTime.toFixed(1)}s-${scene.endTime.toFixed(1)}s, ${(scene.endTime - scene.startTime).toFixed(1)}s`
            : 'timing unavailable';
        const classLine = scene.sceneClass && scene.treatmentHint
            ? `CLASS=${scene.sceneClass} | PRIMARY=${scene.treatmentHint.primary || 'unknown'} | SOURCE=${scene.treatmentHint.preferredSource || 'unknown'} | RETRIEVE=${scene.retrievability || 'medium'}`
            : `CLASS=${scene.sceneClass || 'unknown'} | RETRIEVE=${scene.retrievability || 'medium'}`;
        const outline = globalOutline?.sceneHints?.[scene.index]
            ? `OUTLINE=${globalOutline.sceneHints[scene.index].raw}`
            : '';
        const editorIdea = _renderEditorIdeaLine(scene);
        return [
            `SCENE ${scene.index} (${duration}) [${_sceneTagString(scene, parentScenes || missingScenes, scriptContext)}]`,
            classLine,
            outline,
            editorIdea,
            `"${scene.text}"`,
        ].filter(Boolean).join('\n');
    }).join('\n\n');

    const usedBlock = usedKeywords.length
        ? `\nALREADY USED KEYWORDS: ${usedKeywords.slice(-30).map(k => `"${k}"`).join(', ')}\nDo not repeat these unless the scene is the same exact object/reference.\n`
        : '';

    return `You are repairing an incomplete Visual Planner batch response.
The previous answer was truncated and missed scene IDs: ${missingScenes.map(s => s.index).join(', ')}.
Do NOT re-plan other scenes. Output exactly ${missingScenes.length} line(s), only these scene IDs, no markdown.

VIDEO TITLE: ${scriptContext.videoTitle || 'unknown'}
NICHE: ${niche.name} (${nicheId})
FORMAT: ${scriptContext.format || 'unknown'}
SUMMARY: ${scriptContext.summary || 'none'}
ENTITIES: ${(scriptContext.entities || []).slice(0, 20).join(', ') || 'none'}
VIDEO SOURCE PRIORITY: ${videoPriority.join(' > ') || 'youtube > stock'}
${isNonEnglish ? `LANGUAGE: On-screen text in mgHint/fullscreenMG/templateHint must be ${buildLangName}. Search queries stay English.\n` : ''}${usedBlock}
SOURCE INTELLIGENCE:
- mediaNeed exact-still -> mediaType image + sourceHint web-image for exact brands, labels, logos, product photos, documents, diagrams, or historical stills.
- mediaNeed real-demo-video -> mediaType video + sourceHint youtube/reddit for real demos, teardowns, factory tours, reviews, repairs, moving product footage.
- mediaNeed generic-broll -> mediaType video + sourceHint stock for concrete generic hands-on/process B-roll from Pexels/Pixabay.
- mediaNeed template-only/data-graphic -> use templateHint or fullscreenMG; set keyword/stockQuery/webQuery to none.
- If a generic stock lookalike would mislead the viewer, do not choose stock.
- Global visual policy: prefer hands building/repairing/testing/using things, workbenches, tools, kitchens, stores, labs, factories, process close-ups, before/after comparisons, and real objects moving. Avoid abstract documentary mood/aerial filler unless explicitly needed.

${_renderPlannerDirectiveBlock(plannerDirectives, scriptContext)}
${_renderGlobalOutlineBlock(globalOutline, missingScenes)}

MISSING SCENES:
${sceneList}

OUTPUT FORMAT, one line per missing scene:
SCENE N: keyword: <search term or none> | stockQuery: <query or none> | webQuery: <query or none> | protectedTerms: <term1; term2; term3 or none> | mediaNeed: <exact-still|real-demo-video|generic-broll|template-only|data-graphic> | sourceReason: <short reason, no pipe characters> | mediaType: <${tier.allowVideo === false ? 'image' : 'video|image'}> | sourceHint: <stock|youtube|web-image|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | mapVariant: <locator|route|regionHighlight|comparison|none> | templateHint: <template type: content or none> | bgQuery: <template background query or none>`;
}

async function _repairMissingBatchScenes(missingScenes, parentScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline, usedKeywords, label = '') {
    if (!missingScenes.length) return [];
    const prompt = buildBatchCompletionPrompt(missingScenes, parentScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline, usedKeywords);
    const maxTokens = _plannerRepairMaxTokens(missingScenes.length);
    const result = await callAI(prompt, {
        maxTokens,
        taskType: 'planner-large',
        returnMeta: true,
    });
    const rawText = typeof result === 'string' ? result : result.text;
    const stop = result?.meta?.stopReason ? ` stop=${result.meta.stopReason}` : '';
    console.log(`      [VP Batch${label ? ` ${label}` : ''} Repair IO] missing=${missingScenes.map(s => s.index).join(',')} promptChars=${prompt.length} maxTokens=${maxTokens} responseChars=${String(rawText).length}${stop}`);
    return parseBatchResponse(rawText, missingScenes, scriptContext.nicheId, scriptContext.themeId, scriptContext, plannerDirectives);
}

async function _planScenesIndividuallyForBatch(missingScenes, parentScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline) {
    const repaired = [];
    const nicheId = scriptContext.nicheId || '';
    for (const scene of missingScenes) {
        try {
            const prompt = buildSingleScenePrompt(scene, parentScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline);
            const rawText = await callAI(prompt, { maxTokens: _plannerSmallMaxTokens(), taskType: 'planner-small' });
            repaired.push(parseSingleSceneResponse(rawText, scene, scriptContext, directorsBrief, plannerDirectives));
        } catch (err) {
            const fallbackHint = nicheId.startsWith('news') ? 'youtube' : 'stock';
            repaired.push({
                ...scene,
                keyword: extractFallbackKeyword(scene.text, scene, scriptContext),
                protectedTerms: [],
                mediaNeed: 'generic-broll',
                sourceReason: 'fallback scene uses generic video b-roll',
                mediaType: 'video',
                sourceHint: fallbackHint,
                visualIntent: scene.text,
                effects: [],
                mgHint: null
            });
        }
    }
    return repaired;
}

async function _parseBatchResponseWithRepair(rawText, scenes, scriptContext, directorsBrief, plannerDirectives, globalOutline, usedKeywords = [], batchLabel = '') {
    const coverage = _collectBatchResponseCoverage(rawText, scenes);
    if (coverage.duplicates.length > 0) {
        throw new Error(`Duplicate scene number(s) in batch response: ${coverage.duplicates.join(', ')}`);
    }
    if (coverage.missing.length === 0) {
        return parseBatchResponse(rawText, scenes, scriptContext.nicheId, scriptContext.themeId, scriptContext, plannerDirectives);
    }

    const partial = parseBatchResponse(rawText, scenes, scriptContext.nicheId, scriptContext.themeId, scriptContext, plannerDirectives, { allowMissing: true });
    const missingScenes = scenes.filter(scene => coverage.missing.includes(scene.index));
    const repairKeywords = [
        ...usedKeywords,
        ...partial.map(scene => scene.keyword).filter(Boolean),
    ];
    console.log(`      🧩 Batch${batchLabel ? ` ${batchLabel}` : ''} incomplete: kept ${partial.length}/${scenes.length}, repairing missing scene(s): ${coverage.missing.join(', ')}`);

    let repaired = [];
    try {
        repaired = await _repairMissingBatchScenes(missingScenes, scenes, scriptContext, directorsBrief, plannerDirectives, globalOutline, repairKeywords, batchLabel);
    } catch (err) {
        console.log(`      ⚠️ Batch${batchLabel ? ` ${batchLabel}` : ''} repair failed: ${err.message}; falling back only missing scene(s) to single-scene planner`);
        repaired = await _planScenesIndividuallyForBatch(missingScenes, scenes, scriptContext, directorsBrief, plannerDirectives, globalOutline);
    }

    const byIndex = new Map();
    for (const scene of partial) byIndex.set(scene.index, scene);
    for (const scene of repaired) byIndex.set(scene.index, scene);
    const stillMissing = scenes.filter(scene => !byIndex.has(scene.index)).map(scene => scene.index);
    if (stillMissing.length > 0) {
        throw new Error(`Batch repair still missing scene number(s): ${stillMissing.join(', ')}`);
    }
    return scenes.map(scene => byIndex.get(scene.index));
}

/**
 * Plan visuals for ALL scenes in one batch AI call.
 * Uses scriptContext from ai-director.js for intelligent planning.
 *
 * @param {Array} scenes - Scenes from ai-director.js
 * @param {Object} scriptContext - Director's analysis
 * @param {Object} directorsBrief - Quality tier, format, audience
 * @returns {Promise<Array>} Enriched scenes with visual planning
 */
async function planVisuals(scenes, scriptContext, directorsBrief) {
    console.log(`\n🎨 Visual Planner — Step 4`);
    console.log(`📡 Provider: ${config.aiProvider.toUpperCase()}`);
    console.log(`🎬 Planning visuals for ${scenes.length} scenes`);
    console.log(`🧠 Using director's context: theme=${scriptContext.theme}, mood=${scriptContext.mood}, pacing=${scriptContext.pacing}, niche=${scriptContext.nicheId || 'general'}`);
    try {
        const { getAIThinking } = require('../brain/ai-provider');
        const t = getAIThinking();
        const provider = (config.aiProvider || 'ollama').toLowerCase();
        const geminiModel = provider === 'gemini' ? (config.gemini?.model || process.env.GEMINI_MODEL || 'gemini') : '';
        console.log(`   🧠 [Step 4 Planner] provider=${provider}${geminiModel ? ` model=${geminiModel}` : ''} thinking=${t.mode} budget=${t.budget}`);
    } catch (_) { /* diagnostic-only, never fail the build */ }
    console.log('');
    const plannerDirectives = _buildPlannerDirectives(scenes, scriptContext, directorsBrief);

    // Auto-chunk based on provider and scene count. Cloud planner prompts now
    // carry class rules, editor context, and style notes, so 15-scene batches
    // can push Llama/Qwen into slow timeout paths. Ten keeps prompts tighter
    // while still avoiding noisy per-scene planning.
    const isOllama = (config.aiProvider || 'ollama') === 'ollama';
    const CHUNK_SIZE = isOllama ? 8 : 10;
    let globalOutline = null;
    const estimatedBatches = Math.ceil(scenes.length / CHUNK_SIZE);
    const estimatedTextCalls = scenes.length > CHUNK_SIZE ? estimatedBatches + 1 : 1;
    console.log(`   [VP Diagnostics] chunkSize=${CHUNK_SIZE} estimatedTextCalls=${estimatedTextCalls} (${scenes.length > CHUNK_SIZE ? `outline + ${estimatedBatches} batches` : 'single batch'})`);
    console.log('   [VP Diagnostics] logging outline detail, batch raw choices, final per-scene decisions, and guardrail rewrites');

    if (scenes.length > CHUNK_SIZE) {
        try {
            globalOutline = await _generateGlobalVisualOutline(scenes, scriptContext, directorsBrief, plannerDirectives);
        } catch (outlineError) {
            console.log(`   ⚠️ [Step 4 Outline] failed: ${outlineError.message} — continuing with chunk-local planning`);
        }
        return await _planVisualsChunked(scenes, scriptContext, directorsBrief, CHUNK_SIZE, plannerDirectives, globalOutline);
    }

    try {
            const prompt = buildBatchPrompt(scenes, scriptContext, directorsBrief, { plannerDirectives, globalOutline });

        // Batch call for ALL scenes. The schema has many fields per scene, so keep
        // enough room for complete output instead of forcing tail-scene fallback.
        const maxTokens = _plannerLargeMaxTokens(scenes.length);
        const hasBedrockFallback = !!(process.env.BEDROCK_ACCESS_KEY_ID && process.env.BEDROCK_SECRET_ACCESS_KEY);
        if (hasBedrockFallback) console.log(`   🟣 [VP Batch] routing via task-aware text router (Bedrock fallback available)`);
        const result = await callAI(prompt, { maxTokens, taskType: 'planner-large', returnMeta: true });
        const rawText = typeof result === 'string' ? result : result.text;
        const stop = result?.meta?.stopReason ? ` stop=${result.meta.stopReason}` : '';

        if (!rawText) throw new Error('Empty AI response');
        console.log(`   [VP Batch IO] promptChars=${prompt.length} maxTokens=${maxTokens} responseChars=${String(rawText).length}${stop}`);

        console.log(`   [AI Response Preview]:\n${rawText.substring(0, 400)}${rawText.length > 400 ? '...' : ''}\n`);

        const parsedScenes = await _parseBatchResponseWithRepair(
            rawText,
            scenes,
            scriptContext,
            directorsBrief,
            plannerDirectives,
            globalOutline,
            [],
            'single'
        );
        const enrichedScenes = await _finalizeVisualPlan(
            parsedScenes,
            scriptContext,
            directorsBrief,
            plannerDirectives,
            globalOutline
        );

        // Log results
        const fsMGCount = enrichedScenes.filter(s => s.fullscreenMG).length;
        const tplCount = enrichedScenes.filter(s => s.templateHint && !s.fullscreenMG).length;
        const tplOverlayCount = enrichedScenes.filter(s => s.templateHint && !s.fullscreenMG && s.mgHint).length;
        const overlayMGCount = enrichedScenes.filter(s => s.mgHint && !s.fullscreenMG && !s.templateHint).length;
        const footageCount = enrichedScenes.length - fsMGCount;
        const plainFootage = enrichedScenes.length - fsMGCount - tplCount - overlayMGCount;
        console.log(`   ✅ Visual plan created for ${enrichedScenes.length} scenes (${footageCount} footage + ${fsMGCount} fullscreen MG):`);
        const tplOverlay = tplOverlayCount ? ` (${tplOverlayCount} with overlay)` : '';
        console.log(`      📊 Breakdown: fs=${fsMGCount}  template=${tplCount}${tplOverlay}  overlay=${overlayMGCount}  plain-footage=${plainFootage}\n`);
        for (const scene of enrichedScenes.slice(0, 5)) { // Show first 5
            if (scene.fullscreenMG) {
                console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${scene.fullscreenMG}`);
            } else if (scene.templateHint) {
                const bg = scene.templateBgQuery || scene.keyword;
                const kw = bg ? ` [bg: "${bg}"]` : '';
                const mg = scene.mgHint ? ` 🪧 mg:"${scene.mgHint}"` : '';
                console.log(`      Scene ${scene.index}: 📇 [TEMPLATE HINT] ${scene.templateHint}${kw}${mg}`);
            } else {
                const sq = scene.stockQuery ? ` stock:"${scene.stockQuery}"` : '';
                const wq = scene.webQuery ? ` web:"${scene.webQuery}"` : '';
                const protect = scene.protectedTerms?.length ? ` protect:[${scene.protectedTerms.join('; ')}]` : '';
                const fx = scene.effectPreset && scene.effectPreset !== 'none' ? ` fx:${scene.effectPreset}` : (scene.effects && scene.effects.length ? ` fx:[${scene.effects.join(',')}]` : '');
                const mg = scene.mgHint ? ` 🪧 mg:"${scene.mgHint}"` : '';
                console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]${sq}${wq}${protect}${fx}${mg}`);
            }
        }
        if (enrichedScenes.length > 5) {
            console.log(`      ... and ${enrichedScenes.length - 5} more scenes`);
        }
        console.log('');

        return enrichedScenes;

    } catch (error) {
        console.log(`   ❌ Batch visual planning failed: ${error.message}`);
        console.log('   ↩️ Falling back to per-scene planning...\n');

        // Fallback: Plan each scene individually
        return await planVisualsPerScene(scenes, scriptContext, directorsBrief, globalOutline);
    }
}

/**
 * Chunked batch planning — splits scenes into smaller groups
 * to prevent timeout on large scripts. Works for all providers.
 */
async function _planVisualsChunked(scenes, scriptContext, directorsBrief, chunkSize, plannerDirectives = null, globalOutline = null) {
    plannerDirectives = plannerDirectives || _buildPlannerDirectives(scenes, scriptContext, directorsBrief);
    const chunks = [];
    for (let i = 0; i < scenes.length; i += chunkSize) {
        chunks.push(scenes.slice(i, i + chunkSize));
    }

    console.log(`   🔀 Splitting ${scenes.length} scenes into ${chunks.length} batches of ~${chunkSize}`);
    if (scriptContext.webContext) {
        console.log(`   🌐 Web research context will be injected into each batch`);
    }
    if (scriptContext.summary) {
        console.log(`   📝 Topic summary will anchor each batch`);
    }
    console.log('');

    const allEnriched = [];
    const usedKeywords = []; // Track keywords across chunks to prevent repeats

    // ── Chunks run in WAVES, not one-at-a-time ────────────────────────────────
    //
    // This was a plain serial `for` over ~35 chunks: 345 scenes / 10 per chunk, each an
    // AI call of ~7s, so ~4 minutes of the build spent waiting on one request at a time.
    // Measured 2026-08-31: planner-large was 124 calls / 14.1 min of the run.
    //
    // It was serial for a REASON, not by oversight: `usedKeywords` is threaded through
    // every chunk so later scenes are told what earlier ones already used and footage
    // does not repeat across the video. Fire them all off at once and that signal is
    // gone.
    //
    // Waves keep the signal at coarser grain. Every chunk in a wave sees the keywords
    // from ALL earlier waves; only its own wave-mates are invisible to it. With
    // VP_PARALLEL_CHUNKS=4 that is ~9 waves instead of 35 serial calls — roughly 4x —
    // while the de-dup window stays 40 scenes wide. The global outline
    // (globalOutline.sceneHints) still covers cross-scene consistency on top.
    //
    // VP_PARALLEL_CHUNKS=1 restores the exact previous behaviour, byte for byte.
    const WAVE = Math.max(1, parseInt(process.env.VP_PARALLEL_CHUNKS, 10) || 4);
    if (WAVE > 1) {
        console.log(`   ⚡ Planning ${chunks.length} batches ${WAVE} at a time (de-dup window = previous waves)`);
    }

    // The body below is unchanged from the serial version. It works in parallel because
    // `allEnriched` and `usedKeywords` are SHADOWED per chunk: reads see the snapshot
    // this wave started with, writes land in a local array, and the wave driver merges
    // them afterwards in chunk order.
    const runChunk = async (c, keywordSnapshot) => {
        const chunk = chunks[c];
        const allEnriched = [];
        const usedKeywords = keywordSnapshot.slice();
        const keywordsBefore = usedKeywords.length;
        console.log(`   📦 Batch ${c + 1}/${chunks.length} (scenes ${chunk[0].index}-${chunk[chunk.length - 1].index})...`);
        if (globalOutline) {
            const hinted = chunk.filter(scene => globalOutline.sceneHints[scene.index]).length;
            const seamIds = [chunk[0].index - 2, chunk[0].index - 1, chunk[chunk.length - 1].index + 1, chunk[chunk.length - 1].index + 2];
            const seamCount = seamIds.filter(idx => !!globalOutline.sceneHints[idx]).length;
            console.log(`      🧭 Outline aware: ${hinted}/${chunk.length} scene hints + ${seamCount} seam cues`);
        }

        try {
            const prompt = buildBatchPrompt(chunk, scriptContext, directorsBrief, {
                previousKeywords: usedKeywords,
                plannerDirectives,
                globalOutline,
            });
            const maxTokens = _plannerLargeMaxTokens(chunk.length);
            const hasBedrockFallback = !!(process.env.BEDROCK_ACCESS_KEY_ID && process.env.BEDROCK_SECRET_ACCESS_KEY);
            if (hasBedrockFallback && c === 0) console.log(`   🟣 [VP Chunked] routing via task-aware text router (Bedrock fallback available)`);
            const result = await callAI(prompt, { maxTokens, taskType: 'planner-large', returnMeta: true });
            const rawText = typeof result === 'string' ? result : result.text;
            const stop = result?.meta?.stopReason ? ` stop=${result.meta.stopReason}` : '';

            if (!rawText) throw new Error('Empty AI response');
            console.log(`      [VP Batch ${c + 1} IO] promptChars=${prompt.length} maxTokens=${maxTokens} responseChars=${String(rawText).length}${stop}`);

            const enriched = await _parseBatchResponseWithRepair(
                rawText,
                chunk,
                scriptContext,
                directorsBrief,
                plannerDirectives,
                globalOutline,
                usedKeywords,
                String(c + 1)
            );
            allEnriched.push(...enriched);

            // Collect keywords for next chunk's awareness
            for (const scene of enriched) {
                if (scene.keyword) usedKeywords.push(scene.keyword);
            }

            const batchFs = enriched.filter(s => s.fullscreenMG).length;
            const batchTpl = enriched.filter(s => s.templateHint && !s.fullscreenMG).length;
            const batchTplOverlay = enriched.filter(s => s.templateHint && !s.fullscreenMG && s.mgHint).length;
            const batchOverlay = enriched.filter(s => s.mgHint && !s.fullscreenMG && !s.templateHint).length;
            const batchPlain = enriched.length - batchFs - batchTpl - batchOverlay;
            const tplOverlay = batchTplOverlay ? ` (${batchTplOverlay} with overlay)` : '';
            console.log(`      📊 Batch ${c + 1} breakdown: fs=${batchFs}  template=${batchTpl}${tplOverlay}  overlay=${batchOverlay}  plain-footage=${batchPlain}`);
            for (const scene of enriched) {
                if (scene.fullscreenMG) {
                    console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${scene.fullscreenMG}`);
                } else if (scene.templateHint) {
                    const bg = scene.templateBgQuery || scene.keyword;
                    const kw = bg ? ` [bg: "${bg}"]` : '';
                    const mg = scene.mgHint ? ` 🪧 mg:"${scene.mgHint}"` : '';
                    console.log(`      Scene ${scene.index}: 📇 [TEMPLATE HINT] ${scene.templateHint}${kw}${mg}`);
                } else {
                    const mg = scene.mgHint ? ` 🪧 mg:"${scene.mgHint}"` : '';
                    const protect = scene.protectedTerms?.length ? ` protect:[${scene.protectedTerms.join('; ')}]` : '';
                    console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]${protect}${mg}`);
                }
            }
        } catch (error) {
            console.log(`      ⚠️ Batch ${c + 1} failed: ${error.message}, falling back to per-scene...`);
            // Fallback: do this chunk's scenes one by one
            const nicheId = scriptContext.nicheId || '';
            for (const scene of chunk) {
                try {
                    const prompt = buildSingleScenePrompt(scene, chunk, scriptContext, directorsBrief, plannerDirectives, globalOutline);
                    const rawText = await callAI(prompt, { maxTokens: _plannerSmallMaxTokens(), taskType: 'planner-small' });
                    const parsed = parseSingleSceneResponse(rawText, scene, scriptContext, directorsBrief, plannerDirectives);
                    allEnriched.push(parsed);
                    if (parsed.fullscreenMG) {
                        console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${parsed.fullscreenMG}`);
                    } else if (parsed.templateHint) {
                        const bg = parsed.templateBgQuery || parsed.keyword;
                        const kw = bg ? ` [bg: "${bg}"]` : '';
                        const mg = parsed.mgHint ? ` 🪧 mg:"${parsed.mgHint}"` : '';
                        console.log(`      Scene ${scene.index}: 📇 [TEMPLATE HINT] ${parsed.templateHint}${kw}${mg}`);
                    } else {
                        const mg = parsed.mgHint ? ` 🪧 mg:"${parsed.mgHint}"` : '';
                        const protect = parsed.protectedTerms?.length ? ` protect:[${parsed.protectedTerms.join('; ')}]` : '';
                        console.log(`      Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}, ${parsed.sourceHint}]${protect}${mg}`);
                    }
                } catch (err) {
                    const fallbackHint = nicheId.startsWith('news') ? 'youtube' : 'stock';
                    allEnriched.push({
                        ...scene,
                        keyword: extractFallbackKeyword(scene.text, scene, scriptContext),
                        protectedTerms: [],
                        mediaNeed: 'generic-broll',
                        sourceReason: 'fallback scene uses generic video b-roll',
                        mediaType: 'video',
                        sourceHint: fallbackHint,
                        visualIntent: scene.text,
                        effects: [],
                        mgHint: null
                    });
                    console.log(`      Scene ${scene.index}: fallback keyword`);
                }
            }
        }
        return { enriched: allEnriched, newKeywords: usedKeywords.slice(keywordsBefore) };
    };

    for (let w = 0; w < chunks.length; w += WAVE) {
        const ids = [];
        for (let c = w; c < Math.min(w + WAVE, chunks.length); c++) ids.push(c);
        const snapshot = usedKeywords.slice();
        const results = await Promise.all(ids.map(c => runChunk(c, snapshot).catch((e) => {
            // runChunk already handles per-chunk failure internally; this only catches a
            // throw from the wrapper itself, and must not take the other chunks down.
            console.log(`   ⚠️ [VP] batch ${c + 1} wrapper failed: ${e.message}`);
            return { enriched: [], newKeywords: [] };
        })));
        for (const r of results) {
            allEnriched.push(...r.enriched);
            for (const k of r.newKeywords) usedKeywords.push(k);
        }
    }

    const finalized = await _finalizeVisualPlan(allEnriched, scriptContext, directorsBrief, plannerDirectives, globalOutline);
    const totalFs = finalized.filter(s => s.fullscreenMG).length;
    const totalTpl = finalized.filter(s => s.templateHint && !s.fullscreenMG).length;
    const totalTplOverlay = finalized.filter(s => s.templateHint && !s.fullscreenMG && s.mgHint).length;
    const totalOverlay = finalized.filter(s => s.mgHint && !s.fullscreenMG && !s.templateHint).length;
    const totalPlain = finalized.length - totalFs - totalTpl - totalOverlay;
    const tplOverlay = totalTplOverlay ? ` (${totalTplOverlay} with overlay)` : '';
    console.log(`\n   ✅ Visual plan created for ${finalized.length} scenes`);
    console.log(`      📊 TOTAL breakdown: fs=${totalFs}  template=${totalTpl}${tplOverlay}  overlay=${totalOverlay}  plain-footage=${totalPlain}\n`);
    return finalized;
}

// ============================================================
// FALLBACK: PER-SCENE PLANNING
// ============================================================

/**
 * Fallback to old per-scene approach if batch fails.
 * Still uses scriptContext for smarter decisions than old ai-keywords.js.
 */
async function planVisualsPerScene(scenes, scriptContext, directorsBrief, globalOutline = null) {
    const plannerDirectives = _buildPlannerDirectives(scenes, scriptContext, directorsBrief);
    const enrichedScenes = [];

    for (const scene of scenes) {
        const prompt = buildSingleScenePrompt(scene, scenes, scriptContext, directorsBrief, plannerDirectives, globalOutline);

        const nicheId = scriptContext.nicheId || '';
        try {
            const rawText = await callAI(prompt, { maxTokens: _plannerSmallMaxTokens(), taskType: 'planner-small' });
            const parsed = parseSingleSceneResponse(rawText, scene, scriptContext, directorsBrief, plannerDirectives);
            enrichedScenes.push(parsed);
            const protect = parsed.protectedTerms?.length ? ` protect:[${parsed.protectedTerms.join('; ')}]` : '';
            console.log(`   Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}, ${parsed.sourceHint}]${protect}`);
        } catch (error) {
            // Ultimate fallback: extract from text
            const fallbackHint = nicheId.startsWith('news') ? 'youtube' : 'stock';
            enrichedScenes.push({
                ...scene,
                keyword: extractFallbackKeyword(scene.text, scene, scriptContext),
                protectedTerms: [],
                mediaNeed: 'generic-broll',
                sourceReason: 'fallback scene uses generic video b-roll',
                mediaType: 'video',
                sourceHint: fallbackHint,
                visualIntent: scene.text,
                effects: [],
                mgHint: null
            });
            console.log(`   Scene ${scene.index}: fallback keyword`);
        }
    }

    console.log('');
    return await _finalizeVisualPlan(enrichedScenes, scriptContext, directorsBrief, plannerDirectives, globalOutline);
}

/**
 * Build prompt for a single scene (fallback mode).
 */
function buildSingleScenePrompt(scene, allScenes, scriptContext, directorsBrief, plannerDirectives = null, globalOutline = null) {
    const { theme, mood, entities } = scriptContext;
    const { tier } = directorsBrief;
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche } = require('../data/niches');
    const niche = getNiche(nicheId);
    const videoPriority = _videoPriorityForVp(niche, 'youtube');
    plannerDirectives = plannerDirectives || _buildPlannerDirectives(allScenes || [scene], scriptContext, directorsBrief);
    const sceneTags = _sceneTagString(scene, allScenes || [scene], scriptContext);
    const outlineBlock = _renderGlobalOutlineBlock(globalOutline, [scene]);

    return `You are planning B-ROLL for a ${theme || 'general'} video with ${mood || 'neutral'} mood.

SCENE ${scene.index} [${sceneTags}]
SCENE TEXT: "${scene.text}"
${entities.length > 0 ? `KEY ENTITIES: ${entities.join(', ')}` : ''}
TOPIC SUMMARY: ${scriptContext.summary || 'none'}
EVENT ANCHOR: ${scriptContext.eventAnchor || 'none'}
${_renderPlannerDirectiveBlock(plannerDirectives, scriptContext)}
${outlineBlock}

AVAILABLE SOURCES (priority order for this ${niche.name} niche): ${videoPriority.join(' → ')}
Pick sourceHint from these. Top sources are BEST for this niche.

OUTPUT FORMAT (one line):
SCENE ${scene.index}: keyword: <searchable keyword or none> | stockQuery: <query or none> | webQuery: <query or none> | protectedTerms: <term1; term2; term3 or none> | mediaNeed: <exact-still|real-demo-video|generic-broll|template-only|data-graphic> | sourceReason: <short reason, no pipe characters> | mediaType: <${tier.allowVideo ? 'video|image' : 'image'}> | sourceHint: <stock|youtube|web-image|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | templateHint: <template type: content or none> | bgQuery: <real visual search query when templateHint is set OR when MAP=blocked, else none>`;
}

/**
 * Parse single scene response.
 */
function parseSingleSceneResponse(rawText, scene, scriptContext, directorsBrief, plannerDirectives = null) {
    const normalized = /scene\s+\d+/i.test(rawText)
        ? rawText
        : `SCENE ${scene.index}: ${rawText.trim()}`;
    return parseBatchResponse(
        normalized,
        [scene],
        scriptContext.nicheId,
        scriptContext.themeId,
        scriptContext,
        plannerDirectives
    )[0];
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    planVisuals,
    buildBatchPrompt,
    parseBatchResponse,
    extractFallbackKeyword,
    repairContextualKeywords,
    _autoStockQuery,
    _autoWebQuery,
};

// Test-only surface (verify-directives.js). Not part of the public API.
module.exports.__test = {
    _buildPlannerDirectives,
    _enforceNumericLowerThirdDirective,
    _mergeCompiledDirectives,
    _parseVisualInstructionPrefs,
    _userExplicitlyWantsMaps,
    _enforceNicheMapChartBan,
    _enforceNicheTemplateBan,
    breakStillRuns: _breakStillRuns,
    MAX_CONSECUTIVE_STILLS,
};
