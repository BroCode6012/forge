/**
 * Smart Build Orchestrator — AI-powered pipeline manager
 *
 * Sits between pipeline steps to validate, optimize, and catch problems.
 * Five intervention points:
 *   0. Scene Duration Optimizer (after Director, before VP) — niche-aware split/merge
 *   1. Pre-Build Brain (after VP, before downloads) — AI reviews full scene plan
 *   2. Mid-Build Validation (after downloads, before MGs) — logic checks + MG instructions
 *   3. Post-Build Review (after plan creation) — AI reviews + gap-filling
 *
 * Niche-aware: loads niche config and enforces rules across all phases.
 */

const { callAI } = require('../brain/ai-provider');
const { getNiche } = require('../data/niches');
const { getTheme } = require('../data/themes');
const { FULLSCREEN_MG_TYPES } = require('../agents/ai-motion-graphics');
const { extractFallbackKeyword, repairContextualKeywords, _autoStockQuery, _autoWebQuery } = require('../agents/ai-visual-planner');
const { applyMediaIntentController } = require('../media/media-intent-controller');
const { applyRetrievabilityRescue } = require('../media/retrievability-rescue');
const {
    applySearchKeywordSplit,
    normalizeEntityContext,
    trimSearchKeyword,
    observeScenes: observePhraseScenes,
} = require('../media/search-keywords');
const { filterDisabledSources, sanitizeSourceHint } = require('../media/source-policy');
const {
    validateTemplateHintPlacement,
    validateOverlayHintPlacement,
} = require('../agents/planner-display-guards');
const { recoverDataPairs } = require('../agents/mg-data-recovery');

// Data-required fullscreen MG types. If the AI doesn't give real data from the
// narration, the MG renders broken (empty bars, sentence-fragment labels, no
// comparison text). These are repaired into regular templates instead of
// falling back to unrelated footage.
const DATA_REQUIRED_FS_MGS = {
    barChart:       { kind: 'pairs', minPairs: 2 },
    donutChart:     { kind: 'pairs', minPairs: 2 },
    rankingList:    { kind: 'pairs', minPairs: 2 },
    timeline:       { kind: 'pairs', minPairs: 2 },
    bulletList:     { kind: 'items', minItems: 2 },
    comparisonCard: { kind: 'vs' },
};

// Returns { valid, reason? }. mgContent is the string after "<mgType>: ".
function _validateDataMGContent(mgType, mgContent) {
    const spec = DATA_REQUIRED_FS_MGS[mgType];
    if (!spec) return { valid: true };
    const c = (mgContent || '').trim();
    if (!c) return { valid: false, reason: 'empty content' };

    if (spec.kind === 'vs') {
        if (!/\s+vs\.?\s+|\s+versus\s+/i.test(c)) {
            return { valid: false, reason: `needs "A vs B" pattern, got "${c.slice(0, 40)}"` };
        }
        return { valid: true };
    }

    // Split on | or ; — first segment may be a title, rest are data
    const segments = c.split(/\s*\|\s*|\s*;\s*/).map(s => s.trim()).filter(Boolean);
    const firstIsPair = segments.length > 0 && /^[^:]+:\s*[\d.,%$+\-]+/.test(segments[0]);
    const dataSegs = (segments.length > 1 && !firstIsPair) ? segments.slice(1) : segments;

    if (spec.kind === 'pairs') {
        const pairs = dataSegs.filter(s => /^[^:]+:\s*[\d.,%$+\-]+/.test(s));
        if (pairs.length < spec.minPairs) {
            return { valid: false, reason: `needs ≥${spec.minPairs} "Label:Number" pairs, found ${pairs.length} in "${c.slice(0, 60)}"` };
        }
    } else if (spec.kind === 'items') {
        if (dataSegs.length < spec.minItems) {
            return { valid: false, reason: `needs ≥${spec.minItems} items separated by "|", got "${c.slice(0, 60)}"` };
        }
    }
    return { valid: true };
}

// Words that, on their own, are too generic to seed a footage search.
// "Key Facts", "Main Points", "Top 5" all collapse to nothing useful after filtering.
const _GENERIC_MG_TITLE_WORDS = new Set([
    'key', 'main', 'top', 'important', 'popular', 'notable', 'various',
    'different', 'several', 'many', 'few', 'some', 'all', 'every',
    'facts', 'fact', 'things', 'items', 'item', 'numbers', 'number',
    'stats', 'statistic', 'statistics', 'data', 'points', 'point',
    'list', 'lists', 'reasons', 'reason', 'examples', 'example',
    'overview', 'summary', 'breakdown', 'comparison',
]);

// Pull the human-readable title out of a fullscreenMG / overlay MG string.
// Input examples:
//   "barChart: Oil Transport"                       → "Oil Transport"
//   "barChart: Oil Production | USA: 12 | RU: 10"   → "Oil Production"  (first non-pair segment)
//   "barChart: USA: 12 | RU: 10"                    → null              (all data pairs, no title)
//   "comparisonCard: Tesla vs BYD"                  → "Tesla vs BYD"
//   "headline: Key Facts"                           → null              (entirely generic)
function _extractMGTitle(mgString) {
    if (!mgString || typeof mgString !== 'string') return null;
    const colonIdx = mgString.indexOf(':');
    const content = (colonIdx > 0 ? mgString.substring(colonIdx + 1) : mgString).trim();
    if (!content) return null;

    const segments = content.split(/\s*[|;]\s*/).map(s => s.trim()).filter(Boolean);
    const pairLike = /^[^:]+:\s*[\d.,%$+\-]+/;

    // First segment that isn't a Label:Number data pair
    const titleSeg = segments.find(s => !pairLike.test(s));
    if (!titleSeg) return null;

    // Strip leading "Top 5 ", "Key ", etc. — but only if non-generic words remain.
    const tokens = titleSeg.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const meaningful = tokens.filter(t => t.length > 2 && !_GENERIC_MG_TITLE_WORDS.has(t));
    if (meaningful.length === 0) return null;
    return meaningful.slice(0, 4).join(' ');
}

// Smart fallback keyword for any orchestrator rejection (fullscreen MG OR template).
// Uses signals the AI already produced — only falls to prose-mining as last resort.
function _smartFallbackKeyword(scene, originalMgString) {
    const candidates = [
        _extractMGTitle(originalMgString),
        scene?.templateBgQuery,
        scene?.visualIntent,
        Array.isArray(scene?.keywords) ? scene.keywords[0] : null,
        scene?.keyword,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length >= 3) return c.trim();
    }
    return extractFallbackKeyword(scene?.text || '');
}

function _useLeanOrchestrator() {
    const leanFlag = String(process.env.ORCH_LEAN_MODE || '').trim().toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(leanFlag)) return false;
    return String(process.env.ORCH_FULL_GUARDRAILS || '').trim() !== '1';
}

function _editorAgentOwnsEditing(scriptContext = {}) {
    return process.env.EDITOR_AGENT === 'true'
        || scriptContext?.editorAgentOwnsEditing === true
        || scriptContext?._editorAgentOwnsEditing === true
        || scriptContext?.editorOwnsEditing === true;
}

function _cleanTemplateTitle(value, fallback = 'Visual Beat') {
    const raw = String(value || fallback || '')
        .replace(/\s*[|;]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return 'Visual Beat';
    const withoutType = raw.replace(/^[a-zA-Z]+(?:Card|List|Chart)?:\s*/i, '').trim();
    return withoutType || 'Visual Beat';
}

function _templateTypeForInvalidFullscreen(mgType, title) {
    const text = String(title || '').toLowerCase();
    if (mgType === 'bulletList') {
        if (/\b(list|forever|verdict|chapter|number\s+\w+|#\d)\b/.test(text)) return 'chapterCard';
        return 'factCard';
    }
    if (mgType === 'timeline') return 'factCard';
    if (mgType === 'comparisonCard') return /\bvs\.?|\bversus\b/.test(text) ? 'comparisonCard' : 'factCard';
    if (mgType === 'rankingList') return 'factCard';
    return 'factCard';
}

function _repairInvalidFullscreenMG(scene, mgType, mgContent, reason) {
    const before = scene.fullscreenMG;
    const title = _cleanTemplateTitle(mgContent || _smartFallbackKeyword(scene, before));
    const templateType = _templateTypeForInvalidFullscreen(mgType, title);
    scene.fullscreenMG = null;
    scene.templateHint = `${templateType}: ${title}`;
    scene.templateBgQuery = scene.templateBgQuery
        || scene.bgQuery
        || scene.visualIntent
        || scene.keyword
        || title;
    scene.keyword = null;
    scene.searchKeyword = null;
    scene.stockQuery = null;
    scene.webQuery = null;
    scene.mediaType = null;
    scene.sourceHint = null;
    scene.mgHint = null;
    return `Scene ${scene.index}: fullscreenMG "${mgType}" repaired (${reason}) -> templateHint "${scene.templateHint}"`;
}

function _isGenericOrBrokenKeyword(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (/^(?:a|an|the|this|that|these|those|it|its|and|or|but|because|then|now|none|null|undefined)$/i.test(text)) return true;
    if (/[,/]$/.test(text)) return true;
    if (/^(?:the|a|an|and|or|but)\s+/i.test(text)) return true;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return true;
    return false;
}

function _shouldApplyLeanKeywordFix(scene, duplicateKeywords) {
    const current = String(scene?.keyword || '').trim();
    if (_isGenericOrBrokenKeyword(current)) return true;
    if (duplicateKeywords && duplicateKeywords.has(current.toLowerCase())) return true;
    return false;
}

// Niche pacing → scene duration limits
function _restoreFootageAfterTemplateRejection(scene, niche, reason) {
    const before = scene.templateHint;
    const fallback = _smartFallbackKeyword(scene, before);
    scene.templateHint = null;
    scene.templateBgQuery = null;
    scene.keyword = scene.keyword || fallback;
    scene.mediaType = scene.mediaType || 'video';
    scene.sourceHint = sanitizeSourceHint(scene.sourceHint || filterDisabledSources(niche.footagePriority?.video || [])[0] || 'youtube', 'youtube');
    return `Scene ${scene.index}: templateHint "${before}" REJECTED (${reason}) -> fallback to footage "${scene.keyword}"`;
}

const PACING_LIMITS = {
    fast:     { maxDuration: 7,  idealMax: 6,  minDuration: 2.0 },
    moderate: { maxDuration: 9,  idealMax: 7,  minDuration: 2.0 },
    slow:     { maxDuration: 11, idealMax: 9,  minDuration: 2.5 },
};

// Niche overlay density → target MGs per minute
const DENSITY_TARGETS = {
    low:    { mgPerMin: 1.5, maxGapSec: 45 },
    medium: { mgPerMin: 2.5, maxGapSec: 30 },
    high:   { mgPerMin: 3.5, maxGapSec: 20 },
};

// Visual object/category tokens that should not silently disappear from
// search keywords. Dropping "ship" from a strait scene, for example, turns a
// usable footage query into a generic map/place query.
const MODEL_QUALIFIERS = new Set([
    'drone', 'drones', 'tank', 'tanks', 'fighter', 'fighters',
    'jet', 'jets', 'missile', 'missiles', 'rocket', 'rockets',
    'helicopter', 'helicopters', 'aircraft', 'submarine', 'submarines',
    'ship', 'ships', 'carrier', 'carriers', 'bomber', 'bombers',
    'warship', 'warships', 'destroyer', 'destroyers', 'cruiser',
    'rifle', 'pistol', 'interceptor', 'interceptors', 'launcher',
    'aerial', 'overhead', 'satellite',
]);

const PROTECTED_TOKEN_EQUIVALENTS = {
    ship: ['ship', 'ships', 'shipping', 'vessel', 'vessels', 'tanker', 'tankers', 'cargo', 'maritime', 'naval', 'warship', 'warships'],
    ships: ['ship', 'ships', 'shipping', 'vessel', 'vessels', 'tanker', 'tankers', 'cargo', 'maritime', 'naval', 'warship', 'warships'],
    aircraft: ['aircraft', 'plane', 'planes', 'jet', 'jets', 'fighter', 'fighters', 'carrier', 'carriers'],
    carrier: ['carrier', 'carriers', 'aircraft', 'naval', 'ship', 'ships'],
    carriers: ['carrier', 'carriers', 'aircraft', 'naval', 'ship', 'ships'],
    drone: ['drone', 'drones', 'uav', 'uavs'],
    drones: ['drone', 'drones', 'uav', 'uavs'],
    missile: ['missile', 'missiles', 'rocket', 'rockets'],
    missiles: ['missile', 'missiles', 'rocket', 'rockets'],
    aerial: ['aerial', 'drone', 'overhead', 'satellite'],
    overhead: ['aerial', 'drone', 'overhead', 'satellite'],
};

const PROTECTED_TOKEN_APPEND = {
    ship: 'ships',
};

function _isProtectedTokenCovered(token, newWordSet) {
    const equivalents = PROTECTED_TOKEN_EQUIVALENTS[token] || [token];
    return equivalents.some(eq => newWordSet.has(eq));
}

function _mergeProtectedKeywordTokens(keyword, tokens) {
    const words = (keyword || '').trim().split(/\s+/).filter(Boolean);
    const wordSet = new Set(words.map(w => w.toLowerCase()));
    const additions = [];
    for (const token of tokens) {
        const add = PROTECTED_TOKEN_APPEND[token] || token;
        if (!wordSet.has(add.toLowerCase())) additions.push(add);
    }
    if (additions.length === 0) return keyword;

    const visualTailIdx = words.findIndex(w => /^(aerial|drone|footage|video|view)$/i.test(w));
    if (visualTailIdx >= 0) {
        words.splice(visualTailIdx, 0, ...additions);
    } else {
        words.push(...additions);
    }
    return words.join(' ');
}

function _termTokens(term) {
    return String(term || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1);
}

function _isProtectedTermCovered(term, keyword) {
    const tokens = _termTokens(term);
    if (tokens.length === 0) return true;
    const keywordSet = new Set(_termTokens(keyword));
    return tokens.every(t => _isProtectedTokenCovered(t, keywordSet));
}

// ============================================================
// PHASE 0: SCENE DURATION OPTIMIZER
// Runs after AI Director (Step 3), before Visual Planner (Step 4)
// Niche-aware: fast pacing = shorter scenes, slow = longer allowed
// ============================================================

/**
 * Optimize scene durations based on niche pacing rules.
 * Splits scenes that exceed niche max duration at sentence boundaries.
 * Merges scenes below min duration with neighbors.
 *
 * @param {Object[]} scenes - Scenes from AI Director (with words, startTime, endTime)
 * @param {Object} scriptContext - Contains nicheId, format, etc.
 * @param {number} fps - Frames per second
 * @returns {Object} { scenes, stats: { split, merged, before, after } }
 */
function sceneDurationOptimizer(scenes, scriptContext, fps) {
    const beforeCount = scenes.length;
    const ideaLocked = scriptContext?.sceneSplitMode === 'ai-idea' || scenes.some(s => s && s._ideaLocked);
    if (ideaLocked) {
        console.log('\n⏱️  Orchestrator — Phase 0: Scene Duration Optimizer');
        console.log('   Skipped: AI idea scenes are locked by the Director');
        scenes.forEach((s, i) => { s.index = i; });
        return {
            scenes,
            stats: { split: 0, merged: 0, before: beforeCount, after: beforeCount, skipped: 'idea-locked' },
        };
    }

    const nicheId = scriptContext.nicheId || 'general';
    const niche = getNiche(nicheId);
    const pacing = niche.defaultPacing || 'moderate';
    const limits = PACING_LIMITS[pacing] || PACING_LIMITS.moderate;

    console.log('\n⏱️  Orchestrator — Phase 0: Scene Duration Optimizer');
    console.log(`   Niche: ${niche.name} | Pacing: ${pacing} | Max: ${limits.maxDuration}s | Min: ${limits.minDuration}s`);

    let splitCount = 0;
    let mergeCount = 0;

    // ── Pass 1: Split long scenes ──
    const afterSplit = [];
    for (const scene of scenes) {
        const dur = scene.endTime - scene.startTime;

        if (dur <= limits.maxDuration) {
            afterSplit.push(scene);
            continue;
        }

        // Scene exceeds niche max — split at sentence boundaries
        const sceneWords = scene.words || [];
        if (sceneWords.length < 4) {
            // Too few words to split meaningfully
            afterSplit.push(scene);
            continue;
        }

        const targetChunks = Math.ceil(dur / limits.idealMax);
        const targetChunkDur = dur / targetChunks;

        // Find sentence boundary break points
        const breakPoints = [0];
        for (let i = 1; i < sceneWords.length - 1; i++) {
            const word = sceneWords[i];
            const timeSinceStart = word.start - scene.startTime;
            const nearestChunk = Math.round(timeSinceStart / targetChunkDur);
            const targetTime = nearestChunk * targetChunkDur;
            const timeError = Math.abs(timeSinceStart - targetTime);

            if (timeError < 1.5 && _isSentenceBoundary(word)) {
                const lastBreak = breakPoints[breakPoints.length - 1];
                if (i - lastBreak >= 3) {
                    breakPoints.push(i);
                }
            }
        }

        // Fallback: force split at word nearest to target time
        if (breakPoints.length === 1 && targetChunks > 1) {
            for (let chunk = 1; chunk < targetChunks; chunk++) {
                const targetTime = chunk * targetChunkDur;
                let bestIdx = -1, bestDist = Infinity;
                for (let i = 1; i < sceneWords.length - 1; i++) {
                    const dist = Math.abs((sceneWords[i].start - scene.startTime) - targetTime);
                    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
                }
                if (bestIdx > 0) {
                    const lastBreak = breakPoints[breakPoints.length - 1];
                    if (bestIdx - lastBreak >= 3) breakPoints.push(bestIdx);
                }
            }
        }

        breakPoints.push(sceneWords.length);

        if (breakPoints.length <= 2) {
            // Couldn't find valid split points
            afterSplit.push(scene);
            continue;
        }

        // Create sub-scenes
        for (let i = 0; i < breakPoints.length - 1; i++) {
            const startIdx = breakPoints[i];
            const endIdx = breakPoints[i + 1];
            const chunk = sceneWords.slice(startIdx, endIdx);
            if (chunk.length === 0) continue;

            const chunkStart = chunk[0].start;
            const chunkEnd = i < breakPoints.length - 2
                ? sceneWords[endIdx].start
                : scene.endTime;

            afterSplit.push({
                index: 0, // re-indexed below
                text: chunk.map(w => w.word).join(' ').trim(),
                startTime: chunkStart,
                endTime: chunkEnd,
                duration: Math.round((chunkEnd - chunkStart) * fps),
                words: chunk,
                // Preserve any existing fields from director
                sceneType: scene.sceneType,
                narrativeArc: scene.narrativeArc,
                _splitFrom: scene.index,
            });
            splitCount++;
        }
        // We created N chunks from 1 scene, so net new = N-1
        splitCount -= 1;
    }

    // ── Pass 2: Merge tiny scenes ──
    let afterMerge = [...afterSplit];
    let changed = true;
    while (changed) {
        changed = false;
        const next = [];
        for (let i = 0; i < afterMerge.length; i++) {
            const scene = afterMerge[i];
            const dur = (scene.endTime || 0) - (scene.startTime || 0);

            if (dur < limits.minDuration && next.length > 0) {
                // Merge into previous
                const prev = next[next.length - 1];
                prev.endTime = scene.endTime;
                prev.text = (prev.text || '') + ' ' + (scene.text || '');
                if (scene.words) prev.words = [...(prev.words || []), ...scene.words];
                prev.duration = Math.round((prev.endTime - prev.startTime) * fps);
                mergeCount++;
                changed = true;
            } else if (dur < limits.minDuration && i + 1 < afterMerge.length) {
                // First scene tiny — merge into next
                const nextScene = afterMerge[i + 1];
                nextScene.startTime = scene.startTime;
                nextScene.text = (scene.text || '') + ' ' + (nextScene.text || '');
                if (scene.words) nextScene.words = [...(scene.words || []), ...(nextScene.words || [])];
                nextScene.duration = Math.round((nextScene.endTime - nextScene.startTime) * fps);
                mergeCount++;
                changed = true;
            } else {
                next.push(scene);
            }
        }
        afterMerge = next;
    }

    // Re-index
    afterMerge.forEach((s, i) => { s.index = i; });

    // Stats
    const afterCount = afterMerge.length;
    const stats = { split: splitCount, merged: mergeCount, before: beforeCount, after: afterCount };

    if (splitCount > 0 || mergeCount > 0) {
        console.log(`   ✂️  Split ${splitCount} long scenes (>${limits.maxDuration}s)`);
        console.log(`   🔗 Merged ${mergeCount} tiny scenes (<${limits.minDuration}s)`);
        console.log(`   📊 ${beforeCount} → ${afterCount} scenes`);
    } else {
        console.log(`   ✅ All ${beforeCount} scenes within pacing limits`);
    }

    // Duration distribution for logging
    const durations = afterMerge.map(s => s.endTime - s.startTime);
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const maxDur = Math.max(...durations);
    const minDur = Math.min(...durations);
    console.log(`   📈 Duration range: ${minDur.toFixed(1)}s – ${maxDur.toFixed(1)}s (avg: ${avg.toFixed(1)}s)`);
    console.log('   ✅ Phase 0 complete\n');

    return { scenes: afterMerge, stats };
}

/**
 * Check if a word ends with sentence-ending punctuation.
 */
function _isSentenceBoundary(word) {
    const text = (word.word || '').trim();
    return /[.!?,;:]$/.test(text);
}


// ============================================================
// PHASE 1: PRE-BUILD BRAIN
// Runs after Visual Planner (Step 4), before downloads (Step 5)
// ============================================================

/**
 * AI-powered review of the full scene plan before any downloads happen.
 * Catches problems, optimizes keywords, suggests fullscreen MGs, deduplicates.
 *
 * @param {Object[]} scenes - All scenes with VP-assigned keywords/sourceHints/fullscreenMGs
 * @param {Object} scriptContext - From AI Director (theme, niche, entities, format, etc.)
 * @returns {Object} { scenes, manifest, changes[], warnings[] }
 */
async function preBuildReview(scenes, scriptContext) {
    const nicheId = scriptContext.nicheId || 'general';
    const niche = getNiche(nicheId);
    const themeId = scriptContext.themeId || 'standard';
    const theme = getTheme(themeId);
    const format = scriptContext.format || 'documentary';
    const entities = scriptContext.entities || [];

    console.log('\n🧠 Orchestrator — Phase 1: Pre-Build Review');
    console.log(`   Niche: ${niche.name} | Theme: ${themeId} | Format: ${format}`);
    console.log(`   Scenes: ${scenes.length} | Entities: ${entities.length}`);

    // Learn THIS video's compound nouns before any keyword is shortened, so
    // scene 1 is cut with the same knowledge as scene 50. Evidence only —
    // nothing here rewrites a query.
    try {
        const stats = observePhraseScenes(scenes);
        if (stats && stats.learned > 0) {
            console.log(`   [Phrases] learned ${stats.learned} multi-word terms from this script`);
        }
    } catch { /* evidence gathering is best-effort */ }

    const changes = [];
    const warnings = [];
    const leanOrchestrator = _useLeanOrchestrator();
    const editorOwnsEditing = _editorAgentOwnsEditing(scriptContext);
    if (leanOrchestrator) {
        console.log('   [Orchestrator Lean Mode] active: VP plan is source-of-truth; old deterministic rewrite stacks disabled');
    }
    if (editorOwnsEditing) {
        console.log('   [Editor Agent] owns editing decisions: orchestrator will not create/repair fullscreen MGs, template hints, or overlay MG hints');
    }

    // ── Rule-based checks (fast, no AI) ──

    // 1. Keyword deduplication
    const keywordMap = new Map(); // keyword → [sceneIndices]
    for (const s of scenes) {
        if (!s.keyword || s.fullscreenMG || s.templateHint) continue;
        const kw = s.keyword.toLowerCase().trim();
        if (!keywordMap.has(kw)) keywordMap.set(kw, []);
        keywordMap.get(kw).push(s.index);
    }
    for (const [kw, indices] of keywordMap) {
        if (indices.length > 1) {
            warnings.push(`⚠️ Duplicate keyword "${kw}" on scenes ${indices.join(', ')} — footage may repeat`);
        }
    }
    const duplicateKeywords = new Set([...keywordMap.entries()]
        .filter(([, indices]) => indices.length > 1)
        .map(([kw]) => kw));

    // 2. Source hint validation against niche
    const excludedProviders = niche.excludeVideoProviders || [];
    for (const s of scenes) {
        if (s.fullscreenMG || s.templateHint) continue;
        if (excludedProviders.includes(s.sourceHint)) {
            const oldHint = s.sourceHint;
            s.sourceHint = sanitizeSourceHint(filterDisabledSources(niche.footagePriority?.video || [])[0] || 'stock', 'youtube');
            changes.push(`Scene ${s.index}: sourceHint "${oldHint}" excluded for ${niche.name} → "${s.sourceHint}"`);
        }
    }

    // 3. FullscreenMG validation is legacy-only. In Editor Agent mode those
    // fields are archived context, not authority.
    const allowed = new Set(niche.allowedMGs || []);
    const enforceNicheMgGate = process.env.VP_ENFORCE_NICHE_MG === '1';
    if (!editorOwnsEditing) {
        for (const s of scenes) {
            if (!s.fullscreenMG) continue;
            const colonIdx = s.fullscreenMG.indexOf(':');
            const mgType = colonIdx > 0 ? s.fullscreenMG.substring(0, colonIdx).trim() : s.fullscreenMG.trim();
            const structuralListicleGrid = mgType === 'listicleGrid'
                && (format === 'listicle' || s.isListicleOverview);
            if (structuralListicleGrid) continue;
            if (enforceNicheMgGate && allowed.size > 0 && !allowed.has(mgType)) {
                warnings.push(`⚠️ Scene ${s.index}: fullscreenMG "${mgType}" not in ${niche.name} allowedMGs`);
            }
        }

        // 3b. FullscreenMG DATA validation — data-required MGs without real pairs/items
        // render broken (empty bars, sentence-fragment labels). Reject and restore footage.
        for (const s of scenes) {
            if (!s.fullscreenMG) continue;
            const colonIdx = s.fullscreenMG.indexOf(':');
            if (colonIdx <= 0) continue;
            const mgType = s.fullscreenMG.substring(0, colonIdx).trim();
            if (!DATA_REQUIRED_FS_MGS[mgType]) continue;
            const mgContent = s.fullscreenMG.substring(colonIdx + 1).trim();
            const res = _validateDataMGContent(mgType, mgContent);
            if (!res.valid) {
                // Before repairing the graphic away, look for its numbers in the
                // scene's own words. The planner routinely picks the right chart
                // for the right beat and simply doesn't copy the digits into the
                // MG field, and the repair below then costs us twice: the chart
                // AND a footage hunt seeded from its title. Recovery returns null
                // unless the pairs are unambiguous, and whatever it does return
                // must still clear the very same validator every other MG clears
                // — so an unprovable chart takes the identical path it takes now.
                const recovered = recoverDataPairs(s, mgType, mgContent, { minPairs: DATA_REQUIRED_FS_MGS[mgType].minPairs || 2 });
                if (recovered && _validateDataMGContent(mgType, recovered.content).valid) {
                    s.fullscreenMG = `${mgType}: ${recovered.content}`;
                    changes.push(`Scene ${s.index}: fullscreenMG "${mgType}" data recovered from ${recovered.source} -> "${recovered.content}"`);
                    continue;
                }
                changes.push(_repairInvalidFullscreenMG(s, mgType, mgContent, res.reason));
            }
        }
    }

    // 4. Fullscreen MG distribution check
    const fsMGScenes = scenes.filter(s => s.fullscreenMG);
    const footageScenes = scenes.filter(s => !s.fullscreenMG);
    const fsMGRatio = fsMGScenes.length / scenes.length;
    if (fsMGRatio > 0.25) {
        warnings.push(`⚠️ ${(fsMGRatio * 100).toFixed(0)}% scenes are fullscreen MGs — may feel too data-heavy`);
    }

    // 5. Consecutive same-source check
    let consecutiveSame = 0;
    let lastSource = '';
    for (const s of scenes) {
        if (s.fullscreenMG || s.templateHint) { consecutiveSame = 0; lastSource = ''; continue; }
        if (s.sourceHint === lastSource) {
            consecutiveSame++;
            if (consecutiveSame >= 5) {
                warnings.push(`⚠️ Scenes ${s.index - 4}–${s.index}: 5+ consecutive "${s.sourceHint}" — lacks visual variety`);
                consecutiveSame = 0;
            }
        } else {
            consecutiveSame = 1;
            lastSource = s.sourceHint;
        }
    }

    // 6. Contextual keyword guard
    // Short bridge scenes often have weak local text and can drift into generic
    // or unrelated footage keywords. Repair them from neighboring scene context
    // before the AI reviewer sees the plan.
    if (!leanOrchestrator) {
        const preContextFixes = repairContextualKeywords(scenes, scriptContext);
        for (const f of preContextFixes) {
            changes.push(`S${f.index}: contextual keyword "${f.before}" → "${f.after}" (${f.reason})`);
        }
    }

    // ── AI-powered review ──
    // 7. Prominent text placement guard
    // VP can see adjacent scenes and sometimes pulls a word one scene early.
    // Catch that before downloads/templates are committed.
    if (!leanOrchestrator && !editorOwnsEditing) {
        for (const s of scenes) {
            if (s.templateHint && !s.fullscreenMG) {
                const reason = validateTemplateHintPlacement(s, scenes, scriptContext);
                if (reason) {
                    changes.push(_restoreFootageAfterTemplateRejection(s, niche, reason));
                }
            }
            if (s.mgHint && !s.fullscreenMG) {
                const reason = validateOverlayHintPlacement(s, scenes);
                if (reason) {
                    const before = s.mgHint;
                    s.mgHint = null;
                    changes.push(`Scene ${s.index}: mgHint "${before}" REJECTED (${reason})`);
                }
            }
        }
    }

    // Build a concise scene summary for AI
    const sceneSummary = scenes.map(s => {
        if (s.fullscreenMG) {
            return `S${s.index}: [FULLSCREEN MG] ${s.fullscreenMG}`;
        }
        if (s.templateHint) {
            const bg = s.templateBgQuery ? ` bg:"${s.templateBgQuery}"` : '';
            const mg = s.mgHint ? ` mg:"${s.mgHint}"` : '';
            return `S${s.index}: [TEMPLATE] ${s.templateHint}${bg}${mg} — "${(s.text || '').substring(0, 60)}"`;
        }
        const mg = s.mgHint ? ` mg:"${s.mgHint}"` : '';
        const anchor = (s._contextualKeywordAnchor ? ` local-anchor:"${s._contextualKeywordAnchor}"` : '')
            + (Array.isArray(s.protectedTerms) && s.protectedTerms.length ? ` protect:"${s.protectedTerms.join('; ')}"` : '');
        return `S${s.index}: "${s.keyword}" [${s.sourceHint}]${mg}${anchor} — "${(s.text || '').substring(0, 60)}"`;
    }).join('\n');

    // Build comprehensive niche rules for AI — the orchestrator must deeply understand the niche
    const nicheRules = [
        `Niche ID: ${niche.id}`,
        `Niche Name: ${niche.name}`,
        `Description: ${niche.description || 'N/A'}`,
        `Default Theme: ${niche.defaultTheme || 'standard'}`,
        '',
        `Shot Style: ${niche.shotStyle || 'N/A'}`,
        '',
        `Allowed MGs: ${(niche.allowedMGs || []).join(', ')}`,
        `Footage priority (video): ${(niche.footagePriority?.video || []).join(' → ')}`,
        `Footage priority (image): ${(niche.footagePriority?.image || []).join(' → ')}`,
        `Excluded providers: ${excludedProviders.join(', ') || 'none'}`,
        `Pacing: ${niche.defaultPacing || 'moderate'}`,
        `Preferred media type: ${niche.preferredMediaType || 'mixed'}`,
    ];

    // Keyword rules — critical for AI to fix bad keywords
    if (niche.keywordRules) {
        nicheRules.push('');
        nicheRules.push(`KEYWORD STRATEGY: "${niche.keywordRules.strategy}"`);
        if (niche.keywordRules.rules) {
            nicheRules.push('Keyword rules:');
            for (const r of niche.keywordRules.rules) {
                nicheRules.push(`  - ${r}`);
            }
        }
        if (niche.keywordRules.examples) {
            if (niche.keywordRules.examples.good) {
                nicheRules.push(`GOOD keyword examples: ${niche.keywordRules.examples.good.join(', ')}`);
            }
            if (niche.keywordRules.examples.bad) {
                nicheRules.push(`BAD keyword examples (NEVER use these): ${niche.keywordRules.examples.bad.join(', ')}`);
            }
        }
    }

    // Search policy — a PRINCIPLE, not a word list. Trust the model to pick the
    // concrete visual subject of each scene; never inject niche thematic words to
    // glue onto keywords (that's what produced "...view policy geopolitical" junk).
    if (niche.searchPolicy) {
        nicheRules.push('');
        nicheRules.push('Keywords must be the concrete VISUAL subject of the scene (e.g. ship, port, soldier, refinery, map, crowd) — never the topic theme or abstract words ("policy", "geopolitical", "analysis", "overview", "concept", "documentary"). Reason them from the scene; nothing is dictated.');
        if (niche.searchPolicy.stockMaxWords) {
            nicheRules.push(`Keep stock keywords short (max ${niche.searchPolicy.stockMaxWords} words).`);
        }
    }

    // Overlay preferences
    if (niche.overlayPrefs) {
        nicheRules.push('');
        nicheRules.push(`Overlay density: ${niche.overlayPrefs.v2Density || 'medium'} | Min gap: ${niche.overlayPrefs.minGapSec || 10}s | Max overlays: ${niche.overlayPrefs.maxOverlays || 4}`);
    }

    const fullscreenMGTypes = leanOrchestrator
        ? [...FULLSCREEN_MG_TYPES]
        : [...FULLSCREEN_MG_TYPES].filter(t => allowed.has(t));

    const userInstructions = scriptContext.directorsBrief?.freeInstructions || '';

    const editingBoundary = editorOwnsEditing
        ? `EDITING DECISION BOUNDARY:
- Editor Agent owns ALL fullscreen MG, overlay MG, template, composition, layout, animation, and transition decisions.
- The orchestrator may only repair media feasibility: broken keywords, disabled/impossible source hints, and warnings.
- Treat any existing MG/template fields as archived context only. Do not create, remove, repair, validate, or suggest them.`
        : `FULLSCREEN MG TYPES AVAILABLE FOR THIS NICHE: ${fullscreenMGTypes.join(', ')}
(These REPLACE footage — no download needed. Use when scene narration is data-heavy, lists items, compares things, or discusses abstract concepts that no footage can capture well.)`;

    const reviewRules = editorOwnsEditing
        ? `- Do NOT output FULLSCREEN or REMOVE_FULLSCREEN.
- Do NOT output template or overlay MG changes.
- Focus only on KEYWORD, SOURCE, and WARN.
- TEMPLATE scenes do not use footage keywords. Do NOT output KEYWORD or SOURCE fixes for scenes marked [TEMPLATE].`
        : `- Max 15% of scenes should be fullscreen MGs (currently ${fsMGScenes.length}/${scenes.length})
- NEVER make hook scenes (first 3-4 scenes) fullscreen MGs — they need strong visuals
- NEVER make conclusion/CTA scenes fullscreen MGs
- Prefer footage over fullscreen MGs when the subject is visually concrete (real products, places, people)
- EXCEPTION: mapChart fullscreenMG should NEVER be removed. Maps are the BEST way to show geographic locations, borders, straits, trade routes, military positions, regions, and multi-country topics. If the Visual Planner assigned mapChart, KEEP IT — do NOT replace with footage.
- If a scene lists 3+ data points or compares X vs Y with no visual subject → fullscreen MG is better
- TEMPLATE scenes do not use footage keywords. Do NOT output KEYWORD or SOURCE fixes for scenes marked [TEMPLATE].`;

    const prompt = `You are a video production orchestrator reviewing a scene plan BEFORE footage downloads begin.
You are an expert in the "${niche.name}" niche. You deeply understand what visuals work for this type of content, what keywords will actually find good footage, and what pitfalls to avoid.

VIDEO CONTEXT:
- Title/Summary: ${scriptContext.summary || 'N/A'}
- Format: ${format} | Total scenes: ${scenes.length}
- Entities: ${entities.join(', ') || 'none'}
- Theme: ${themeId} | Web context available: ${scriptContext.webContext ? 'yes' : 'no'}
${userInstructions ? `\n🔥 USER INSTRUCTIONS (HIGHEST PRIORITY — respect these):\n${userInstructions}\n` : ''}

═══════════════════════════════════════════
NICHE PROFILE — "${niche.name}" (you MUST enforce ALL of these rules)
═══════════════════════════════════════════
${nicheRules.join('\n')}
═══════════════════════════════════════════

${editingBoundary}
${leanOrchestrator ? '\nLEAN REVIEW MODE: The Visual Planner is the source of truth. Do not re-plan scenes, do not reject templates because of timing/position, do not change sources for taste, and do not simplify good keywords. Only fix objectively broken search terms, disabled sources, impossible media, or render-breaking fullscreen graphics.' : ''}

CURRENT SCENE PLAN:
${sceneSummary}

YOUR TASK — Review this plan as a "${niche.name}" niche expert. Output ONLY actionable fixes. For each fix, output ONE line:

FIX S<index>: <action>

Actions:
- KEYWORD: <new keyword> — ONLY when keyword is truly broken (unsearchable, abstract, or will return wrong footage)
- SOURCE: <new sourceHint> — when sourceHint doesn't match content (e.g., stock for a specific brand → youtube)
${editorOwnsEditing ? '- EDITING/MG/TEMPLATE ACTIONS ARE FORBIDDEN HERE — Editor Agent owns all fullscreen/template/overlay decisions' : '- FULLSCREEN: <mgType>: <data> — when scene should be fullscreen MG instead of footage\n- REMOVE_FULLSCREEN — when a fullscreen MG scene should actually be footage'}
- WARN: <message> — when something looks wrong but you're not sure

RULES:
${reviewRules}

KEYWORD RULES (CRITICAL — read carefully):
- DO NOT "fix" keywords that are already specific and on-topic. The Visual Planner chose them for a reason.
- A keyword like "USS Gerald R Ford fire damage" is GOOD — it's specific, searchable, and on-topic. Do NOT shorten it to "aircraft carrier" or "navy ship fire".
- ONLY fix keywords that are: (a) completely unsearchable/abstract, (b) will return footage from a WRONG/unrelated topic, (c) exact duplicates of another scene's keyword
- Longer keywords (5-7 words) are FINE if they are specific to the video topic. Specificity > brevity.
- NEVER replace a specific keyword with a generic one. "USS Ford flight deck" → "carrier flight deck" is a BAD fix (loses specificity).
- sourceHint must respect the niche's footage priority and excluded providers
- Source meaning: stock=Storyblocks generic/cinematic B-roll, web-image=Bing exact still/reference image, youtube=real moving footage/product demos/factory tours, reddit=community/broadcast/drone/dashcam clips.
- Exact people, exact brands, logos, labels, model plates, city signs, documents, screenshots, diagrams, and historical stills should be image/web-image unless the scene specifically needs moving footage.
- Video source sanity: stock is only for generic cinematic B-roll. Specific real moving footage of a brand/product/place/event/demo/factory/tour/review should be youtube or reddit. Generic filler wrongly routed to youtube/reddit should be stock.
- TOPIC ANCHORING: For news/military niches, keywords MUST include the specific topic entity. Generic keywords like "government building" will return WRONG footage. If a keyword could match a DIFFERENT news story, add the anchor entity.
- LOCAL-ANCHOR: If a scene line includes local-anchor, that scene is a bridge/connector. Keep the keyword on that nearby subject. Do NOT import a place/person/entity from later or earlier unrelated scenes just because it appears globally in the script.
- PROTECTED TERMS: If a scene line includes protect:"...", those terms are non-negotiable meaning anchors chosen by the Visual Planner. Any KEYWORD fix must preserve their meaning or include a clear synonym.

If the plan looks good, output: PLAN OK — no changes needed.

Output ONLY fix lines or "PLAN OK". No explanations, no summaries.`;

    try {
        // Phase 1 reviews the entire visual plan through the task-aware text router.
        const aiResponse = await callAI(prompt, { maxTokens: 1500, temperature: 0.3, taskType: 'review' });
        console.log('\n   [Review] AI Review (task-aware router):');

        if (aiResponse.includes('PLAN OK')) {
            console.log('   ✅ Plan looks good — no changes needed');
        } else {
            // Parse and apply fixes
            const fixLines = aiResponse.split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('FIX S') || l.startsWith('WARN'));

            let applied = 0;
            let skipped = 0;

            for (const line of fixLines) {
                // Parse: FIX S<index>: <action>
                const fixMatch = line.match(/^FIX S(\d+):\s*(\w+)(?::\s*(.+))?$/i);
                if (!fixMatch) {
                    // Try WARN format
                    if (line.startsWith('WARN')) {
                        warnings.push(`🤖 ${line}`);
                    }
                    continue;
                }

                const sceneIdx = parseInt(fixMatch[1]);
                const action = fixMatch[2].toUpperCase();
                const value = (fixMatch[3] || '').trim();
                const scene = scenes.find(s => s.index === sceneIdx);

                if (!scene) {
                    skipped++;
                    continue;
                }

                switch (action) {
                    case 'KEYWORD': {
                        if (!value || scene.fullscreenMG || scene.templateHint) { skipped++; break; }
                        if (leanOrchestrator && !_shouldApplyLeanKeywordFix(scene, duplicateKeywords)) {
                            skipped++;
                            break;
                        }
                        const old = scene.keyword;
                        // Guard: reject if the new keyword simplifies AWAY protected anchors
                        // (entity names, event anchors, weapon model qualifiers, org-name glue words).
                        if (old) {
                            const oldWords = old.toLowerCase().split(/\s+/);
                            const newWords = value.toLowerCase().split(/\s+/);
                            const newSet = new Set(newWords);
                            const dynamicProtectedTerms = Array.isArray(scene.protectedTerms)
                                ? scene.protectedTerms.filter(Boolean)
                                : [];
                            const lostDynamicTerms = dynamicProtectedTerms.filter(term => !_isProtectedTermCovered(term, value));

                            if (lostDynamicTerms.length > 0) {
                                scene.keyword = value;
                                scene.entityContext = normalizeEntityContext(scene, scriptContext);
                                scene.searchKeyword = trimSearchKeyword(value, scene);
                                scene.stockQuery = _autoStockQuery(scene.searchKeyword || value);
                                scene.webQuery = _autoWebQuery(scene.searchKeyword || value, scene.sourceHint);
                                changes.push(`S${sceneIdx}: keyword "${old}" -> "${value}" (kept protectedTerms as entityContext: ${lostDynamicTerms.join('; ')})`);
                                applied++;
                                break;
                            }

                            // Entity tokens (people, orgs, places) from director's extraction
                            const entityWords = (scriptContext.entities || [])
                                .flatMap(e => e.toLowerCase().split(/\s+/))
                                .filter(w => w.length > 2);
                            // Event anchor tokens (main incident/topic) — e.g. "Terra A1", "Shahed"
                            const anchorWords = (scriptContext.eventAnchor || '')
                                .toLowerCase().split(/\s+/)
                                .filter(w => w.length > 2);
                            // Weapon/vehicle model qualifiers — dropping these breaks specificity
                            // ("Shahed drone" → "Shahed" loses the weapon class signal).
                            // Preposition "glue" words that hold org/event names together
                            // ("Council on Foreign Relations", "Ministry of Defense").
                            const GLUE_WORDS = new Set([
                                'on', 'of', 'for', 'and', 'de', 'du', 'van', 'von', 'al', 'el', 'la',
                            ]);

                            const protectedTokens = new Set([
                                ...entityWords.filter(w => oldWords.includes(w)),
                                ...anchorWords.filter(w => oldWords.includes(w)),
                                ...oldWords.filter(w => MODEL_QUALIFIERS.has(w)),
                                ...oldWords.filter(w => GLUE_WORDS.has(w)),
                            ]);

                            const lostTokens = [...protectedTokens].filter(t => !_isProtectedTokenCovered(t, newSet));

                            if (lostTokens.length > 0 && newWords.length <= oldWords.length) {
                                const lostQualifierTokens = lostTokens.filter(t => MODEL_QUALIFIERS.has(t));
                                const hardLostTokens = lostTokens.filter(t => !MODEL_QUALIFIERS.has(t));
                                if (lostQualifierTokens.length > 0 && hardLostTokens.length === 0) {
                                    const mergedValue = trimSearchKeyword(_mergeProtectedKeywordTokens(value, lostQualifierTokens), scene);
                                    scene.keyword = mergedValue;
                                    scene.searchKeyword = mergedValue;
                                    scene.stockQuery = _autoStockQuery(mergedValue);
                                    scene.webQuery = _autoWebQuery(mergedValue, scene.sourceHint);
                                    changes.push(`S${sceneIdx}: keyword "${old}" -> "${mergedValue}" (merged protected: ${lostQualifierTokens.join(', ')})`);
                                    applied++;
                                    break;
                                }
                                changes.push(`S${sceneIdx}: keyword REJECTED "${old}" → "${value}" (lost protected: ${lostTokens.join(', ')})`);
                                skipped++;
                                break;
                            }
                        }
                        scene.keyword = value;
                        scene.entityContext = normalizeEntityContext(scene, scriptContext);
                        scene.searchKeyword = trimSearchKeyword(value, scene);
                        // Regenerate queries from search keyword, not story context.
                        scene.stockQuery = _autoStockQuery(scene.searchKeyword || value);
                        scene.webQuery = _autoWebQuery(scene.searchKeyword || value, scene.sourceHint);
                        changes.push(`S${sceneIdx}: keyword "${old}" → "${value}"`);
                        applied++;
                        break;
                    }
                    case 'SOURCE': {
                        if (!value || scene.fullscreenMG || scene.templateHint) { skipped++; break; }
                        if (leanOrchestrator && scene.sourceHint && !excludedProviders.includes(scene.sourceHint)) {
                            skipped++;
                            break;
                        }
                        // Validate source hint
                        const validSources = ['stock', 'youtube', 'web-image', 'reddit'];
                        if (!validSources.includes(value)) { skipped++; break; }
                        if (excludedProviders.includes(value)) { skipped++; break; }
                        const old = scene.sourceHint;
                        scene.sourceHint = sanitizeSourceHint(value, 'youtube');
                        // Source change → regenerate queries from the canonical keyword.
                        // Stock APIs want 3 short visual nouns, YouTube/web want the full
                        // descriptive form with names/figures preserved. Leaving the stale
                        // stockQuery in place after a flip to YouTube ships a stock-shaped
                        // query (e.g. "el-mandeb strait global") on a source that needed
                        // "Bab el-Mandeb shipping lane Saudi tanker".
                        if (typeof scene.keyword === 'string' && scene.keyword.trim().length > 0) {
                            scene.searchKeyword = trimSearchKeyword(scene.searchKeyword || scene.keyword, scene);
                            const queryBase = scene.searchKeyword || scene.keyword;
                            const newStock = typeof _autoStockQuery === 'function' ? _autoStockQuery(queryBase) : null;
                            const newWeb = typeof _autoWebQuery === 'function' ? _autoWebQuery(queryBase, value) : null;
                            if (newStock) scene.stockQuery = newStock;
                            if (newWeb) scene.webQuery = newWeb;
                        }
                        changes.push(`S${sceneIdx}: source "${old}" → "${value}" (re-queried: stock="${scene.stockQuery || '-'}" web="${scene.webQuery || '-'}")`);
                        applied++;
                        break;
                    }
                    case 'FULLSCREEN': {
                        if (editorOwnsEditing) { skipped++; break; }
                        if (!value) { skipped++; break; }
                        if (leanOrchestrator) { skipped++; break; }
                        // Parse "mgType: data"
                        const cIdx = value.indexOf(':');
                        const mgType = cIdx > 0 ? value.substring(0, cIdx).trim() : value.trim();
                        // Validate: must be allowed fullscreen type in this niche
                        if (!FULLSCREEN_MG_TYPES.has(mgType)) { skipped++; break; }
                        if (allowed.size > 0 && !allowed.has(mgType)) { skipped++; break; }
                        // Don't convert hook/conclusion scenes
                        if (sceneIdx < 4 || sceneIdx >= scenes.length - 3) { skipped++; break; }
                        // Check cap: max 15%
                        const currentFS = scenes.filter(s => s.fullscreenMG).length;
                        if (currentFS >= Math.ceil(scenes.length * 0.15)) { skipped++; break; }

                        scene.fullscreenMG = value;
                        scene.keyword = null;
                        scene.stockQuery = null;
                        scene.webQuery = null;
                        scene.mediaType = null;
                        scene.sourceHint = null;
                        scene.mgHint = null;
                        changes.push(`S${sceneIdx}: → FULLSCREEN MG "${value}"`);
                        applied++;
                        break;
                    }
                    case 'REMOVE_FULLSCREEN': {
                        if (editorOwnsEditing) { skipped++; break; }
                        if (!scene.fullscreenMG) { skipped++; break; }
                        if (leanOrchestrator) { skipped++; break; }
                        // NEVER remove mapChart — maps are the best visual for geographic content
                        if (scene.fullscreenMG.startsWith('mapChart')) {
                            console.log(`      ⛔ Blocked REMOVE_FULLSCREEN for mapChart on S${sceneIdx} — maps are protected`);
                            skipped++;
                            break;
                        }
                        const oldMG = scene.fullscreenMG;
                        scene.fullscreenMG = null;
                        scene.mediaType = 'video';
                        scene.sourceHint = sanitizeSourceHint(filterDisabledSources(niche.footagePriority?.video || [])[0] || 'stock', 'youtube');
                        scene.keyword = scene.visualIntent || scene.text?.substring(0, 40) || 'abstract background';
                        changes.push(`S${sceneIdx}: removed fullscreenMG "${oldMG}" → footage`);
                        applied++;
                        break;
                    }
                    default:
                        if (line.includes('WARN')) {
                            warnings.push(`🤖 S${sceneIdx}: ${value}`);
                        }
                        skipped++;
                }
            }

            console.log(`   Applied: ${applied} fixes | Skipped: ${skipped} (invalid/capped)`);
        }
    } catch (error) {
        console.log(`   ⚠️ AI review failed: ${error.message} — continuing with rule-based checks only`);
    }

    // Run once more after AI fixes. This catches cases where the reviewer tries
    // to "improve" a bridge scene by importing an entity from elsewhere in the
    // script instead of the local neighborhood.
    if (!leanOrchestrator) {
        const postContextFixes = repairContextualKeywords(scenes, scriptContext);
        for (const f of postContextFixes) {
            changes.push(`S${f.index}: contextual keyword "${f.before}" → "${f.after}" (${f.reason})`);
        }
    }

    // 8. Media Intent Controller
    // Final deterministic authority for the downloader lane. The AI reviewer can
    // suggest keyword/source fixes, but this pass owns image-vs-video for obvious
    // cases: concrete factual subjects become real video; static references stay
    // images; fullscreen lanes stay out of normal downloads.
    if (!leanOrchestrator) {
        const mediaIntent = applyMediaIntentController(scenes, scriptContext);
        for (const c of mediaIntent.changes) {
            changes.push(c);
        }
    } else {
        console.log('   [Media Intent] skipped in lean mode (VP media/source choices preserved)');
    }

    const searchSplitChanges = [];
    for (const scene of scenes) {
        const split = applySearchKeywordSplit(scene, scriptContext);
        if (split.changed) {
            scene.stockQuery = _autoStockQuery(scene.searchKeyword);
            scene.webQuery = _autoWebQuery(scene.searchKeyword, scene.sourceHint);
            const msg = `S${scene.index}: searchKeyword "${split.before}" -> "${split.after}" (entityContext kept separate)`;
            if (leanOrchestrator) searchSplitChanges.push(msg);
            else changes.push(msg);
        } else if (scene.searchKeyword && !scene.stockQuery && !scene.webQuery) {
            scene.stockQuery = _autoStockQuery(scene.searchKeyword);
            scene.webQuery = _autoWebQuery(scene.searchKeyword, scene.sourceHint);
        }
    }
    if (leanOrchestrator && searchSplitChanges.length > 0) {
        console.log(`   [Search Keyword Split] normalized ${searchSplitChanges.length} downloader query/query-context split(s):`);
        for (const c of searchSplitChanges.slice(0, 12)) {
            console.log(`      ${c}`);
        }
        if (searchSplitChanges.length > 12) {
            console.log(`      ... ${searchSplitChanges.length - 12} more`);
        }
    }

    // 8.5 Retrievability Rescue — rewrite UN-FINDABLE visual intents (proprietary product /
    // meta-reference like a "thumbnail" or "previous video" / hyper-specific factory close-up)
    // into findable topical B-roll BEFORE downloads, so the downloader doesn't burn the whole
    // per-scene budget hunting footage that doesn't exist. Agentic searchability judge, one
    // batched call, no hardcoded word lists. Runs last so its query rewrites are final.
    // Disable with RETRIEVABILITY_RESCUE=off.
    if (String(process.env.RETRIEVABILITY_RESCUE || 'on').toLowerCase() !== 'off') {
        try {
            const rescue = await applyRetrievabilityRescue(scenes, scriptContext);
            for (const c of rescue.changes) changes.push(c);
        } catch (e) {
            console.log(`   [Retrievability Rescue] error (non-fatal): ${e.message}`);
        }
    }

    // Log all warnings
    if (warnings.length > 0) {
        console.log('\n   ⚠️ Warnings:');
        for (const w of warnings) {
            console.log(`      ${w}`);
        }
    }

    // Log all changes
    if (changes.length > 0) {
        console.log('\n   📝 Changes applied:');
        for (const c of changes) {
            console.log(`      ${c}`);
        }
    }

    // Build the manifest (frozen snapshot of what each scene should be)
    const manifest = scenes.map(s => ({
        index: s.index,
        role: s.fullscreenMG ? 'fullscreen-mg' : (s.templateHint ? 'template' : 'footage'),
        keyword: s.keyword || null,
        searchKeyword: s.searchKeyword || null,
        entityContext: Array.isArray(s.entityContext) ? s.entityContext : [],
        protectedTerms: Array.isArray(s.protectedTerms) ? s.protectedTerms : [],
        sourceHint: s.sourceHint || null,
        mediaType: s.mediaType || null,
        fullscreenMG: s.fullscreenMG || null,
        templateHint: s.templateHint || null,
        templateBgQuery: s.templateBgQuery || null,
        mgHint: s.mgHint || null,
        mediaIntent: s.mediaIntent || null,
        text: (s.text || '').substring(0, 60),
    }));

    const fsMGCount = manifest.filter(m => m.role === 'fullscreen-mg').length;
    const templateCount = manifest.filter(m => m.role === 'template').length;
    const footageCount = manifest.filter(m => m.role === 'footage').length;
    console.log(`\n   📋 Scene Manifest: ${footageCount} footage + ${templateCount} template + ${fsMGCount} fullscreen MG`);
    console.log('   ✅ Phase 1 complete\n');

    return { scenes, manifest, changes, warnings };
}


// ============================================================
// PHASE 2: MID-BUILD VALIDATION
// Runs after downloads (Step 5), before MGs (Step 6)
// No AI — pure logic checks
// ============================================================

/**
 * Validate download results against the manifest.
 *
 * @param {Object[]} scenesWithMedia - Scenes after download step
 * @param {Object[]} manifest - From Phase 1
 * @param {Object} scriptContext
 * @returns {Object} { valid, issues[], stats }
 */
function midBuildValidation(scenesWithMedia, manifest, scriptContext) {
    console.log('🔍 Orchestrator — Phase 2: Mid-Build Validation');

    const issues = [];
    const stats = {
        totalScenes: manifest.length,
        footagePlanned: scenesWithMedia.filter(s => s && !s.fullscreenMG).length,
        footageDownloaded: 0,
        footageDirectDownloaded: 0,
        footageContinuityFilled: 0,
        footageFailed: 0,
        templateMediaPlanned: scenesWithMedia.filter(s => s && s._templateMediaFootage).length,
        templateMediaDownloaded: 0,
        templateMediaFailed: 0,
        fullscreenMGs: manifest.filter(m => m.role === 'fullscreen-mg').length,
        lowVisionScores: 0,
        providerBreakdown: {},
        templateProviderBreakdown: {},
    };

    // Check each footage scene got media
    for (const scene of scenesWithMedia) {
        const isTemplateMedia = !!scene._templateMediaFootage;
        if (scene.mediaFile) {
            const provider = scene.sourceProvider || 'unknown';
            if (isTemplateMedia) {
                stats.templateMediaDownloaded++;
                stats.templateProviderBreakdown[provider] = (stats.templateProviderBreakdown[provider] || 0) + 1;
            }
            stats.footageDownloaded++;
            if (scene.reusedFromContinuity || /continuity/i.test(String(provider))) {
                stats.footageContinuityFilled++;
            } else {
                stats.footageDirectDownloaded++;
            }
            stats.providerBreakdown[provider] = (stats.providerBreakdown[provider] || 0) + 1;
        } else {
            if (isTemplateMedia) stats.templateMediaFailed++;
            stats.footageFailed++;
            issues.push(`❌ Scene ${scene.index}: no media downloaded (keyword: "${scene.keyword}")`);
        }

        // Check vision scores
        if (scene.visionScore !== undefined && scene.visionScore <= 3) {
            stats.lowVisionScores++;
            if (scene.visionScore <= 2) {
                issues.push(`⚠️ Scene ${scene.index}: very low vision score (${scene.visionScore}/10) — may be poor quality`);
            }
        }
    }

    // Provider breakdown log
    console.log('   📊 Download stats:');
    console.log(`      Planned: ${stats.footagePlanned} footage + ${stats.fullscreenMGs} fullscreen MG`);
    console.log(`      Downloaded: ${stats.footageDownloaded}/${stats.footagePlanned} footage scenes`);
    if (stats.footageContinuityFilled > 0) {
        console.log(`      Direct footage: ${stats.footageDirectDownloaded}/${stats.footagePlanned}; continuity-filled: ${stats.footageContinuityFilled}`);
    }
    if (stats.footageFailed > 0) {
        console.log(`      Failed: ${stats.footageFailed} scenes`);
    }
    if (stats.templateMediaPlanned > 0) {
        console.log(`      Template media: ${stats.templateMediaDownloaded}/${stats.templateMediaPlanned} required background scenes${stats.templateMediaFailed ? ` (${stats.templateMediaFailed} failed)` : ''}`);
    }
    if (stats.lowVisionScores > 0) {
        console.log(`      Low quality: ${stats.lowVisionScores} scenes scored ≤3/10`);
    }

    const providers = Object.entries(stats.providerBreakdown).sort((a, b) => b[1] - a[1]);
    if (providers.length > 0) {
        console.log(`      Sources: ${providers.map(([p, n]) => `${p}(${n})`).join(', ')}`);
    }
    const templateProviders = Object.entries(stats.templateProviderBreakdown).sort((a, b) => b[1] - a[1]);
    if (templateProviders.length > 0) {
        console.log(`      Template media sources: ${templateProviders.map(([p, n]) => `${p}(${n})`).join(', ')}`);
    }

    if (issues.length > 0) {
        console.log('\n   ⚠️ Issues:');
        for (const issue of issues) {
            console.log(`      ${issue}`);
        }
    }

    const valid = stats.footageFailed === 0 && issues.length === 0;

    // ── Build MG Instructions for Step 6 ──
    // These guide the MG engine on density, priority scenes, and format-specific hints
    const nicheId = scriptContext.nicheId || 'general';
    const niche = getNiche(nicheId);
    const format = scriptContext.format || 'documentary';
    const totalDuration = scenesWithMedia.length > 0
        ? Math.max(...scenesWithMedia.map(s => s.endTime || 0))
        : 0;
    const durationMin = totalDuration / 60;

    const overlayDensity = niche.overlayPrefs?.v2Density || 'medium';
    const densityTarget = DENSITY_TARGETS[overlayDensity] || DENSITY_TARGETS.medium;
    const targetMGCount = Math.round(durationMin * densityTarget.mgPerMin);
    const maxGapSec = densityTarget.maxGapSec;

    // Find scenes that are long and should be prioritized for overlay MGs
    const longScenes = [];
    const shortScenes = [];
    for (const scene of scenesWithMedia) {
        const dur = (scene.endTime || 0) - (scene.startTime || 0);
        if (dur > 7) longScenes.push(scene.index);
        if (dur < 2.5) shortScenes.push(scene.index);
    }

    // Format-specific MG hints
    const formatHints = [];
    if (format === 'listicle') {
        formatHints.push('This is a listicle — listicleCounter MGs are auto-generated on item scenes, listicleGrid is auto-generated on the overview scene');
        formatHints.push('Avoid placing overlay MGs on item-start scenes (they already have counters)');
        formatHints.push('The overview scene gets a listicleGrid (fullscreen) — do NOT add bulletList there');
    }
    if (format === 'comparison') {
        formatHints.push('This is a comparison video — use comparisonCard MGs for direct A-vs-B segments');
    }
    if (format === 'explainer') {
        formatHints.push('This is an explainer — use bulletList and statCounter MGs for data-heavy passages');
    }

    // Listicle item-start scenes (already get auto-generated listicleCounter)
    const listicleItemScenes = [];
    let listicleOverviewScene = -1;
    if (format === 'listicle' && scriptContext.listicleItems) {
        for (const item of scriptContext.listicleItems) {
            if (item.startSceneIndex != null) listicleItemScenes.push(item.startSceneIndex);
        }
        // Overview scene = scene before first item (gets listicleGrid fullscreen MG)
        const firstItem = scriptContext.listicleItems.find(it => it.startSceneIndex != null);
        if (firstItem) {
            listicleOverviewScene = Math.max(0, firstItem.startSceneIndex - 1);
        }
    }

    // Protect listicle scenes: item scenes should not get extra overlay MGs from AI,
    // overview scene is a fullscreen MG — no overlays needed there either
    const listicleProtectedScenes = [...listicleItemScenes];
    if (listicleOverviewScene >= 0) listicleProtectedScenes.push(listicleOverviewScene);

    const mgInstructions = {
        targetMGCount,
        maxGapSec,
        overlayDensity,
        longScenes,
        shortScenes,
        listicleItemScenes,
        listicleOverviewScene,
        listicleProtectedScenes,
        formatHints,
        nicheName: niche.name,
        nicheId: niche.id,
        pacing: niche.defaultPacing || 'moderate',
    };

    console.log(`\n   🎯 MG Instructions for Step 6:`);
    console.log(`      Target: ~${targetMGCount} overlay MGs (${densityTarget.mgPerMin}/min for "${overlayDensity}" density)`);
    console.log(`      Max gap: ${maxGapSec}s without MG`);
    if (longScenes.length > 0) {
        console.log(`      Priority scenes (>7s): ${longScenes.length} scenes → should get overlay MGs`);
    }
    if (shortScenes.length > 0) {
        console.log(`      Skip scenes (<2.5s): ${shortScenes.length} scenes → too short for MGs`);
    }
    if (formatHints.length > 0) {
        for (const hint of formatHints) {
            console.log(`      📝 ${hint}`);
        }
    }

    console.log(`   ${valid ? '✅' : '⚠️'} Phase 2 ${valid ? 'passed' : `completed with ${issues.length} issue(s)`}\n`);

    return { valid, issues, stats, mgInstructions };
}


// ============================================================
// PHASE 3: POST-BUILD REVIEW
// Runs after video plan creation (Step 7)
// AI reviews the final plan for quality
// ============================================================

/**
 * AI-powered review of the final video plan.
 * Checks MG distribution, variety, coverage gaps, overall quality.
 *
 * @param {Object} videoPlan - The complete video-plan.json
 * @param {Object[]} manifest - From Phase 1
 * @param {Object} midBuildStats - From Phase 2
 * @returns {Object} { score, report, suggestions[] }
 */
async function postBuildReview(videoPlan, manifest, midBuildStats) {
    console.log('📊 Orchestrator — Phase 3: Post-Build Review');

    const scenes = videoPlan.scenes || [];
    const mgScenes = videoPlan.mgScenes || [];
    const overlayMGs = videoPlan.motionGraphics || [];
    const totalDuration = videoPlan.totalDuration || 0;
    const ctx = videoPlan.scriptContext || {};
    const niche = getNiche(ctx.nicheId || 'general');

    const templateScenes = videoPlan.templateScenes || [];

    // ── Rule-based analysis ──
    const analysis = {
        totalScenes: scenes.length,
        totalMGScenes: mgScenes.length,
        totalOverlayMGs: overlayMGs.length,
        totalTemplates: templateScenes.length,
        totalDuration: totalDuration,
        mgDensity: totalDuration > 0 ? ((mgScenes.length + overlayMGs.length) / (totalDuration / 60)).toFixed(1) : 0,
        mgTypes: {},
        templateTypes: {},
        mgGaps: [],
        longestGapSec: 0,
        v3Conflicts: 0,
    };

    // Count MG types
    for (const mg of [...mgScenes, ...overlayMGs]) {
        analysis.mgTypes[mg.type] = (analysis.mgTypes[mg.type] || 0) + 1;
    }
    for (const tpl of templateScenes) {
        analysis.templateTypes[tpl.type] = (analysis.templateTypes[tpl.type] || 0) + 1;
    }

    // ── V3 Track Conflict Detection ──
    // Merge mgScenes + templateScenes on V3, detect overlaps (templates yield to MGs)
    const v3Items = [...mgScenes, ...templateScenes]
        .filter(item => item.trackId === 'video-track-3')
        .sort((a, b) => a.startTime - b.startTime);
    for (let i = 1; i < v3Items.length; i++) {
        const prev = v3Items[i - 1];
        const curr = v3Items[i];
        const prevEnd = prev.endTime || (prev.startTime + (prev.duration || 3));
        if (curr.startTime < prevEnd) {
            analysis.v3Conflicts++;
            console.log(`  ⚠️ V3 overlap: ${prev.type} (${prev.startTime.toFixed(1)}s-${prevEnd.toFixed(1)}s) ↔ ${curr.type} (${curr.startTime.toFixed(1)}s)`);
            // If the conflicting item is a template, remove it
            if (curr.templateType) {
                const tplIdx = templateScenes.indexOf(curr);
                if (tplIdx !== -1) {
                    console.log(`    → Removed template ${curr.type} (yields to MG)`);
                    templateScenes.splice(tplIdx, 1);
                    i--; // recheck
                }
            }
        }
    }
    if (analysis.v3Conflicts > 0) {
        console.log(`  [Orchestrator] Resolved ${analysis.v3Conflicts} V3 track conflict(s)`);
    }
    if (templateScenes.length > 0) {
        console.log(`  [Orchestrator] ${templateScenes.length} template(s): ${Object.entries(analysis.templateTypes).map(([t, n]) => `${t}(${n})`).join(', ')}`);
    }

    // Find longest gap without any MG or template
    const allMGTimes = [...mgScenes, ...overlayMGs, ...templateScenes]
        .map(mg => ({ start: mg.startTime, end: mg.startTime + (mg.duration || 3) }))
        .sort((a, b) => a.start - b.start);

    if (allMGTimes.length > 1) {
        for (let i = 1; i < allMGTimes.length; i++) {
            const gap = allMGTimes[i].start - allMGTimes[i - 1].end;
            if (gap > analysis.longestGapSec) {
                analysis.longestGapSec = gap;
                analysis.mgGaps.push({
                    from: allMGTimes[i - 1].end.toFixed(1),
                    to: allMGTimes[i].start.toFixed(1),
                    duration: gap.toFixed(1)
                });
            }
        }
        // Keep only gaps > 30s
        analysis.mgGaps = analysis.mgGaps.filter(g => parseFloat(g.duration) > 30);
    }

    // ── AI review ──
    const mgSummary = Object.entries(analysis.mgTypes)
        .map(([t, n]) => `${t}(${n})`)
        .join(', ');

    const sceneTimeline = scenes.slice(0, 20).map((s, i) =>
        `S${i}: ${s.keyword || s.type || 'unknown'} [${(s.endTime - s.startTime).toFixed(1)}s]`
    ).join('\n');

    // Build niche context for Phase 3
    const nicheRulesP3 = [
        `Niche: ${niche.name} (${niche.id})`,
        `Description: ${niche.description || 'N/A'}`,
        `Shot style: ${niche.shotStyle || 'N/A'}`,
        `Pacing: ${niche.defaultPacing || 'moderate'}`,
        `Preferred media: ${niche.preferredMediaType || 'mixed'}`,
        `Allowed MGs: ${(niche.allowedMGs || []).join(', ')}`,
        `Overlay density target: ${niche.overlayPrefs?.v2Density || 'medium'} | Min gap: ${niche.overlayPrefs?.minGapSec || 10}s`,
    ];
    if (niche.keywordRules?.strategy) {
        nicheRulesP3.push(`Keyword strategy: ${niche.keywordRules.strategy}`);
    }

    const prompt = `You are reviewing a completed video build as a "${niche.name}" niche expert. Give a quality score and niche-specific suggestions.

VIDEO:
- Duration: ${totalDuration.toFixed(0)}s (${(totalDuration / 60).toFixed(1)} min)
- Format: ${ctx.format || 'documentary'}
- Theme: ${ctx.themeId || 'standard'}
- Scenes: ${scenes.length} footage + ${mgScenes.length} fullscreen MG
- Overlay MGs: ${overlayMGs.length}
- MG density: ${analysis.mgDensity}/min
- MG types: ${mgSummary || 'none'}
- Longest gap without MG: ${analysis.longestGapSec.toFixed(0)}s
- Download success: ${midBuildStats.footageDownloaded}/${midBuildStats.footagePlanned} (${midBuildStats.footageDirectDownloaded || midBuildStats.footageDownloaded} direct, ${midBuildStats.footageContinuityFilled || 0} continuity-filled)
- Low quality footage: ${midBuildStats.lowVisionScores} scenes
- Sources: ${Object.entries(midBuildStats.providerBreakdown).map(([p, n]) => `${p}(${n})`).join(', ')}

NICHE PROFILE:
${nicheRulesP3.join('\n')}

FIRST 20 SCENES:
${sceneTimeline}

Score this build 1-10 considering niche-specific quality standards (pacing, MG density vs niche target, source variety, keyword relevance). Give max 5 SHORT suggestions. Format:

SCORE: <1-10>
- <suggestion 1>
- <suggestion 2>
...`;

    let score = 7; // default
    const suggestions = [];

    try {
        const aiResponse = await callAI(prompt, { maxTokens: 500, temperature: 0.3, taskType: 'review' });

        // Parse score
        const scoreMatch = aiResponse.match(/SCORE:\s*(\d+)/i);
        if (scoreMatch) score = Math.min(10, Math.max(1, parseInt(scoreMatch[1])));

        // Parse suggestions
        const lines = aiResponse.split('\n').filter(l => l.trim().startsWith('-'));
        for (const line of lines.slice(0, 5)) {
            suggestions.push(line.trim().substring(1).trim());
        }
    } catch (error) {
        console.log(`   ⚠️ AI review failed: ${error.message}`);
        suggestions.push('AI review unavailable — check API connection');
    }

    // ── Gap-Filling: Inject overlay MGs into bare stretches ──
    const overlayDensity = niche.overlayPrefs?.v2Density || 'medium';
    const densityTarget = DENSITY_TARGETS[overlayDensity] || DENSITY_TARGETS.medium;
    const maxGapSec = densityTarget.maxGapSec;
    const injected = [];

    // Find all gaps above threshold
    const significantGaps = [];
    if (allMGTimes.length > 0) {
        // Gap before first MG
        if (allMGTimes[0].start > maxGapSec) {
            significantGaps.push({ from: 0, to: allMGTimes[0].start });
        }
        // Gaps between MGs
        for (let i = 1; i < allMGTimes.length; i++) {
            const gapStart = allMGTimes[i - 1].end;
            const gapEnd = allMGTimes[i].start;
            if (gapEnd - gapStart > maxGapSec) {
                significantGaps.push({ from: gapStart, to: gapEnd });
            }
        }
        // Gap after last MG
        if (totalDuration - allMGTimes[allMGTimes.length - 1].end > maxGapSec) {
            significantGaps.push({ from: allMGTimes[allMGTimes.length - 1].end, to: totalDuration });
        }
    } else if (totalDuration > maxGapSec) {
        // No MGs at all — entire video is a gap
        significantGaps.push({ from: 0, to: totalDuration });
    }

    // For each gap, find the best scene in the middle and inject a simple overlay MG
    const LISTICLE_ONLY_TYPES = new Set(['listicleCounter']);
    const allowedOverlayTypes = (niche.allowedMGs || []).filter(t => !FULLSCREEN_MG_TYPES.has(t) && !LISTICLE_ONLY_TYPES.has(t));
    const preferredGapMG = allowedOverlayTypes.includes('lowerThird') ? 'lowerThird'
        : allowedOverlayTypes.includes('headline') ? 'headline'
        : allowedOverlayTypes.includes('focusWord') ? 'focusWord'
        : allowedOverlayTypes[0] || 'lowerThird';

    // Build set of protected scene indices (listicle items + overview already have MGs)
    const protectedSceneIndices = new Set();
    if (ctx.format === 'listicle' && ctx.listicleItems) {
        for (const item of ctx.listicleItems) {
            if (item.startSceneIndex != null) protectedSceneIndices.add(item.startSceneIndex);
        }
        // Overview scene
        const firstItem = ctx.listicleItems.find(it => it.startSceneIndex != null);
        if (firstItem) protectedSceneIndices.add(Math.max(0, firstItem.startSceneIndex - 1));
    }

    // Smart extractor: pick a meaningful MG label from scene text.
    // Priority: (1) named entity mentioned in scene, (2) first clean short sentence,
    // otherwise return null to skip the gap entirely rather than inject a fragment.
    const extractCleanMGText = (sceneText, entities, mgType) => {
        if (!sceneText) return null;
        const cleanText = sceneText.trim();

        // Sentence split (keep terminal punct off final label)
        const sentences = cleanText
            .split(/(?<=[.!?])\s+/)
            .map(s => s.replace(/^[\s\-—"']+|[\s\-—"']+$/g, '').trim())
            .filter(Boolean);

        // Strip trailing commas/semicolons/colons from a fragment
        const tidy = (s) => s.replace(/[.,;:]+$/, '').trim();

        // Entity anchor: first entity name that actually appears in this scene
        const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const entityList = Array.isArray(entities) ? entities : [];
        const foundEntity = entityList.find(e => {
            if (!e || typeof e !== 'string' || e.length < 2) return false;
            const re = new RegExp(`\\b${escapeRe(e)}\\b`, 'i');
            return re.test(cleanText);
        });

        // Pick the first sentence that's 2..10 words and starts with a capital letter
        let cleanSentence = null;
        for (const sent of sentences) {
            const tidied = tidy(sent);
            const wc = tidied.split(/\s+/).length;
            if (wc < 2 || wc > 10) continue;
            if (!/^[A-Z0-9"']/.test(tidied)) continue;
            cleanSentence = tidied;
            break;
        }

        if (mgType === 'focusWord') {
            // Prefer a known entity; else longest capitalized word >3 chars
            if (foundEntity && foundEntity.split(/\s+/).length === 1) return { text: foundEntity };
            const words = cleanText.split(/\s+/).filter(w => w.length > 3 && /^[A-Z]/.test(w));
            const longest = words.sort((a, b) => b.length - a.length)[0];
            return longest ? { text: tidy(longest) } : null;
        }

        // lowerThird / headline: need usable name text
        if (foundEntity) {
            return { name: foundEntity, title: cleanSentence || '', text: foundEntity };
        }
        if (cleanSentence) {
            return { name: cleanSentence, title: '', text: cleanSentence };
        }
        // No entity + no clean sentence = skip rather than inject garbage
        return null;
    };

    let skippedGaps = 0;
    for (const gap of significantGaps) {
        const gapMid = (gap.from + gap.to) / 2;
        // Find the scene at gap midpoint
        const targetScene = scenes.find(s => s.startTime <= gapMid && s.endTime > gapMid);
        if (!targetScene) continue;

        const sceneDur = targetScene.endTime - targetScene.startTime;
        if (sceneDur < 3) continue; // Don't add MGs to tiny scenes

        // Skip listicle-protected scenes (already have counter/tracker/grid)
        const sceneIdx = targetScene.index !== undefined ? targetScene.index : scenes.indexOf(targetScene);
        if (protectedSceneIndices.has(sceneIdx)) continue;

        // Entity-first extraction; skip gap entirely if no clean label found
        const extracted = extractCleanMGText(targetScene.text, ctx.entities, preferredGapMG);
        if (!extracted || !extracted.text || extracted.text.length < 2) {
            skippedGaps++;
            continue;
        }
        const mgText = extracted.text;

        const newMG = {
            id: `orchestrator-gap-${injected.length}`,
            type: preferredGapMG,
            category: 'overlay',
            text: mgText,
            startTime: gapMid - 1,
            duration: 3,
            position: 'bottomLeft',
            sceneIndex: targetScene.index !== undefined ? targetScene.index : scenes.indexOf(targetScene),
            style: videoPlan.mgStyle || 'clean',
            _injectedByOrchestrator: true,
        };

        // Add type-specific fields
        if (preferredGapMG === 'lowerThird') {
            newMG.name = extracted.name || mgText;
            newMG.title = extracted.title || '';
        }

        injected.push(newMG);
    }

    if (injected.length > 0) {
        // Add to the video plan's motionGraphics array
        videoPlan.motionGraphics = [...(videoPlan.motionGraphics || []), ...injected];
        console.log(`\n   🔧 Gap-filling: Injected ${injected.length} overlay MG(s) into bare stretches (>${maxGapSec}s gaps)`);
        for (const mg of injected) {
            console.log(`      + ${mg.type} at ${mg.startTime.toFixed(1)}s (scene ${mg.sceneIndex}): "${mg.text.substring(0, 40)}"`);
        }
        // Recalculate density after injection
        const totalMGs = (videoPlan.mgScenes || []).length + videoPlan.motionGraphics.length;
        analysis.mgDensity = totalDuration > 0 ? (totalMGs / (totalDuration / 60)).toFixed(1) : 0;
    }
    if (skippedGaps > 0) {
        console.log(`   🔧 Gap-filling: Skipped ${skippedGaps} gap(s) — no clean entity/sentence to use (prefer empty over garbage fragment)`);
    }

    // ── Build Report ──
    const report = {
        score,
        grade: score >= 9 ? 'A+' : score >= 8 ? 'A' : score >= 7 ? 'B' : score >= 6 ? 'C' : score >= 5 ? 'D' : 'F',
        duration: `${(totalDuration / 60).toFixed(1)} min`,
        scenes: `${scenes.length} footage + ${mgScenes.length} fullscreen MG`,
        overlayMGs: (videoPlan.motionGraphics || []).length,
        mgDensity: `${analysis.mgDensity}/min`,
        mgTypes: analysis.mgTypes,
        downloadRate: `${midBuildStats.footageDownloaded}/${midBuildStats.footagePlanned}`,
        directDownloadRate: `${midBuildStats.footageDirectDownloaded || midBuildStats.footageDownloaded}/${midBuildStats.footagePlanned}`,
        continuityFilled: midBuildStats.footageContinuityFilled || 0,
        lowQuality: midBuildStats.lowVisionScores,
        longestMGGap: `${analysis.longestGapSec.toFixed(0)}s`,
        sources: midBuildStats.providerBreakdown,
        suggestions,
        injectedMGs: injected.length,
    };

    // Print report
    console.log('\n   ┌─────────────────────────────────────────┐');
    console.log(`   │  BUILD REPORT — Score: ${report.score}/10 (${report.grade})${' '.repeat(Math.max(0, 14 - report.grade.length - String(report.score).length))}│`);
    console.log('   ├─────────────────────────────────────────┤');
    console.log(`   │  Duration:    ${report.duration.padEnd(26)}│`);
    console.log(`   │  Scenes:      ${report.scenes.padEnd(26)}│`);
    console.log(`   │  Overlay MGs: ${String(report.overlayMGs).padEnd(26)}│`);
    console.log(`   │  MG density:  ${report.mgDensity.padEnd(26)}│`);
    console.log(`   │  Downloads:   ${report.downloadRate.padEnd(26)}│`);
    console.log(`   │  Low quality: ${String(report.lowQuality).padEnd(26)}│`);
    console.log(`   │  MG gap max:  ${report.longestMGGap.padEnd(26)}│`);
    if (injected.length > 0) {
    console.log(`   │  Gap-filled:  ${String(injected.length + ' MGs injected').padEnd(26)}│`);
    }
    console.log('   └─────────────────────────────────────────┘');

    if (suggestions.length > 0) {
        console.log('\n   💡 Suggestions:');
        for (const s of suggestions) {
            console.log(`      • ${s}`);
        }
    }

    console.log('   ✅ Phase 3 complete\n');

    return { score, report, suggestions, injectedMGs: injected };
}


module.exports = { sceneDurationOptimizer, preBuildReview, midBuildValidation, postBuildReview };
