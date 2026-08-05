/**
 * AI Templates Pipeline — Dedicated template generation system.
 * Handles fullscreen template cards on V3 track: listicle grids, chapter cards,
 * location cards, quote cards, key takeaways, comparison cards, timeline cards.
 *
 * Separate from ai-motion-graphics.js — templates are premium visual moments.
 * Legacy mode can still consume Visual Planner hints. In Editor Agent mode,
 * template candidates are surfaced from scene content and the Editor Agent owns
 * the final editorial decision.
 */

const { callAI } = require('../brain/ai-provider');
const crypto = require('crypto');
const { getTheme, MG_THEME_OVERRIDES, getThemeTokens, TEMPLATE_THEME_OVERRIDES } = require('../data/themes');
const { getNiche } = require('../data/niches');
const { getLanguageBlock } = require('../data/language-helper');
const { normalizeUrlForDedup } = require('../util/url-utils');
const { createByteLimitTransform, requestSafeStream } = require('../security/safe-download');
const {
    validateTemplateHintPlacement,
    distinctiveWords,
} = require('./planner-display-guards');

// ============ TEMPLATE REGISTRY ============

const TEMPLATE_REGISTRY = {
    listicleGrid: {
        label: 'Listicle Grid',
        variants: ['grid', 'strip', 'stack'],
        defaultVariant: 'grid',
        minDur: 3,
        maxDur: 7,
        animations: ['staggerSlide', 'cascade', 'flipIn'],
        defaultAnimation: 'staggerSlide',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
    },
    chapterCard: {
        label: 'Chapter Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 2.5,
        maxDur: 5,
        animations: ['fadeSlide', 'springScale', 'wipeRight'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
        needsBackground: true,
        backgroundMedia: 'video',
    },
    locationCard: {
        label: 'Location Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        // 2s allowed micro-placements (1.6s after timing-guard trims) — too
        // short for any composed template to enter+hold+exit. Floor raised.
        minDur: 2.6,
        maxDur: 4,
        animations: ['fadeSlide', 'slideLeft'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
        needsBackground: true,
        backgroundMedia: 'video',
    },
    quoteCard: {
        label: 'Quote Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 6,
        animations: ['fadeSlide', 'popUp'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
    },
    keyTakeaway: {
        label: 'Key Takeaway',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 5,
        animations: ['fadeSlide', 'springScale'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
    },
    comparisonCard: {
        label: 'Comparison Card',
        variants: ['standard', 'split', 'stacked'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 6,
        animations: ['staggerSlide', 'flipIn'],
        defaultAnimation: 'staggerSlide',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
    },
    timelineCard: {
        label: 'Timeline Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 6,
        animations: ['staggerSlide', 'cascade'],
        defaultAnimation: 'staggerSlide',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
    },
    factCard: {
        label: 'Fact Card',
        variants: ['splitPanel', 'overlay', 'sidebar', 'numbered'],
        defaultVariant: 'splitPanel',
        minDur: 4,
        maxDur: 8,
        animations: ['slideRight', 'fadeUp', 'staggerSlide'],
        defaultAnimation: 'slideRight',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsBackground: true,
        backgroundMedia: 'video',
    },
    imageShowcase: {
        label: 'Image Showcase',
        variants: ['standard', 'minimal', 'cinematic', 'collage'],
        defaultVariant: 'standard',
        minDur: 4,
        maxDur: 8,
        animations: ['slideOpposite', 'fadeSlide', 'springScale', 'scatterDrop'],
        defaultAnimation: 'slideOpposite',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsItemImages: true,
        itemImageCount: 3,
    },
    statCard: {
        label: 'Stat Card',
        variants: ['sideBySide', 'stacked', 'single', 'triple'],
        defaultVariant: 'sideBySide',
        minDur: 3,
        maxDur: 6,
        animations: ['countUp', 'staggerSlide', 'fadeScale'],
        defaultAnimation: 'countUp',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsBackground: true,
        backgroundMedia: 'video',
    },
    personIntro: {
        label: 'Person Intro',
        variants: ['standard', 'cinematic', 'minimal'],
        defaultVariant: 'standard',
        minDur: 4,
        maxDur: 8,
        animations: ['slideRight', 'fadeSlide', 'springScale'],
        defaultAnimation: 'slideRight',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
        needsItemImages: true,
        itemImageCount: 2,
        itemMedia: 'image',
    },
    splitScreen: {
        label: 'Split Screen',
        variants: ['vertical', 'diagonal', 'reveal'],
        defaultVariant: 'vertical',
        minDur: 4,
        maxDur: 8,
        animations: ['slideInward', 'wipeReveal', 'springScale'],
        defaultAnimation: 'slideInward',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsItemImages: true,
        itemImageCount: 2,
    },
    infographic: {
        label: 'Infographic',
        variants: ['grid', 'horizontal', 'radial'],
        defaultVariant: 'grid',
        minDur: 5,
        maxDur: 10,
        animations: ['staggerSlide', 'popIn', 'cascade'],
        defaultAnimation: 'staggerSlide',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsItemImages: true,
        itemImageCount: 5,
    },
};

const TEMPLATE_TYPES = new Set(Object.keys(TEMPLATE_REGISTRY));

function editorAgentOwnsEditing(scriptContext = {}) {
    return process.env.EDITOR_AGENT === 'true'
        || scriptContext?.editorAgentOwnsEditing === true
        || scriptContext?._editorAgentOwnsEditing === true
        || scriptContext?.editorOwnsEditing === true;
}

function editorAgentPreservesPlannerTemplateRoles(scriptContext = {}) {
    if (!editorAgentOwnsEditing(scriptContext)) return false;
    const raw = process.env.EDITOR_AGENT_PRESERVE_VP_MEDIA_ROLES;
    if (raw != null && ['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase())) {
        return false;
    }
    return scriptContext?.editorAgentPreserveVPMediaRoles !== false;
}

// ============ MAIN PIPELINE ============

/**
 * Process templates for the video plan.
 * @param {Array} scenes - All scenes with keywords/media
 * @param {Object} scriptContext - Script context (format, themeId, listicleItems, etc.)
 * @param {Array} mgScenes - Already-placed fullscreen MG scenes on V3
 * @param {string} aiInstructions - Combined AI instructions
 * @returns {{ templateScenes: Array, stats: Object }}
 */
async function processTemplates(scenes, scriptContext, mgScenes, aiInstructions) {
    const themeId = scriptContext?.themeId || 'standard';
    const nicheId = scriptContext?.nicheId || scriptContext?.niche || 'nature';
    const format = scriptContext?.format || 'standard';
    const nicheConfig = getNiche(nicheId);
    const editorOwnsEditing = editorAgentOwnsEditing(scriptContext);
    const preservePlannerTemplateRoles = editorAgentPreservesPlannerTemplateRoles(scriptContext);
    const legacyAllowedTemplates = nicheConfig.allowedTemplates || [...TEMPLATE_TYPES].filter(t => t !== 'listicleGrid');
    const allowedTemplates = editorOwnsEditing
        ? [...TEMPLATE_TYPES].filter(t => t !== 'listicleGrid')
        : legacyAllowedTemplates;
    const templateDensity = nicheConfig.templateDensity || 'low';
    const preservedHintCount = preservePlannerTemplateRoles
        ? scenes.filter(s => {
            if (!s?.templateHint || s.fullscreenMG) return false;
            const { hintType } = _parseTemplateHintParts(s.templateHint);
            return hintType && hintType.toLowerCase() !== 'none' && TEMPLATE_TYPES.has(hintType) && hintType !== 'listicleGrid';
        }).length
        : 0;
    const baseMaxTemplates = templateDensity === 'high' ? 4 : templateDensity === 'medium' ? 3 : 2;
    const maxTemplates = preservePlannerTemplateRoles
        ? Math.max(baseMaxTemplates, preservedHintCount)
        : baseMaxTemplates;

    const templateScenes = [];
    const stats = { total: 0, byType: {}, skipped: 0, conflicts: 0 };

    // Build V3 conflict map from existing fullscreen MGs
    const v3Ranges = (mgScenes || [])
        .filter(mg => mg.trackId === 'video-track-3')
        .map(mg => ({ start: mg.startTime, end: mg.endTime || (mg.startTime + (mg.duration || 3)) }));

    console.log(`  [Templates] V3 occupied ranges: ${v3Ranges.length} fullscreen MG(s)`);
    if (preservePlannerTemplateRoles) {
        console.log('  [Templates] Editor Agent mode - VP template hints preserved as render policy');
    } else if (editorOwnsEditing) {
        console.log('  [Templates] Editor Agent owns template decisions - VP template hints ignored');
    }

    // ── Step 1: Listicle Grid (rule-based, auto-generated) ──
    if (!editorOwnsEditing && format === 'listicle' && scriptContext.listicleItems?.length > 0) {
        const gridScene = _resolveListicleGrid(scenes, scriptContext, themeId);
        if (gridScene) {
            if (!_checkV3Conflict(gridScene, v3Ranges, templateScenes)) {
                templateScenes.push(gridScene);
                v3Ranges.push({ start: gridScene.startTime, end: gridScene.endTime });
                stats.byType.listicleGrid = 1;
                console.log(`  [Templates] Listicle grid on scene ${gridScene.sceneIndex} @ ${gridScene.startTime.toFixed(1)}s-${gridScene.endTime.toFixed(1)}s`);
            } else {
                stats.conflicts++;
                console.log(`  [Templates] Listicle grid skipped — V3 conflict`);
            }
        }
    }

    // ── Step 2: Collect candidates ──
    const hintedScenes = (editorOwnsEditing && !preservePlannerTemplateRoles) ? [] : scenes.filter(s => {
        if (!s.templateHint || s.fullscreenMG) return false;
        const { hintType } = _parseTemplateHintParts(s.templateHint);
        return hintType && hintType.toLowerCase() !== 'none';
    });
    const candidates = preservePlannerTemplateRoles
        ? _buildPreservedPlannerTemplateCandidates(scenes, allowedTemplates)
        : editorOwnsEditing
          ? _buildEditorAgentTemplateCandidates(scenes, scriptContext, allowedTemplates)
          : _buildCandidates(scenes, scriptContext, allowedTemplates);
    if (preservePlannerTemplateRoles) {
        console.log(`  [Templates] ${candidates.length} preserved Visual Planner template role(s) surfaced from ${hintedScenes.length} hint(s)`);
    } else if (editorOwnsEditing) {
        console.log(`  [Templates] ${candidates.length} editor-agent candidate scene(s) surfaced from scene content`);
    } else {
        console.log(`  [Templates] ${candidates.length} candidate scene(s) from ${hintedScenes.length} Visual Planner template hint(s)`);
    }
    if (!editorOwnsEditing && hintedScenes.length !== candidates.length) {
        for (const scene of hintedScenes) {
            if (candidates.some(c => c.sceneIndex === scene.index)) continue;
            const reason = _templateCandidateRejectReason(scene, scriptContext, allowedTemplates, scenes);
            console.log(`  [Templates] Scene ${scene.index} candidate skipped before selection: ${reason}`);
        }
    }

    // ── Step 2.5: Direct-build candidates whose VP hint is already complete ──
    // If VP produced real content (e.g. "statCard: energy -75% Energy; shield -90% Insurance"),
    // skip the second AI call and build the template straight from the hint.
    const directCandidates = [];
    const aiCandidates = [];
    for (const cand of candidates) {
        if (preservePlannerTemplateRoles && cand.selectionMode === 'visual-planner-preserved') {
            directCandidates.push(cand);
            continue;
        }
        if (editorOwnsEditing) {
            aiCandidates.push(cand);
            continue;
        }
        const registry = TEMPLATE_REGISTRY[cand.hintType];
        const parsed = _parseVPTemplateHint(cand.hintType, cand.hintContent);
        if (_isVPHintUsable(cand.hintType, parsed, registry)) {
            directCandidates.push(cand);
        } else {
            aiCandidates.push(cand);
        }
    }

    if (directCandidates.length > 0) {
        const directLabel = preservePlannerTemplateRoles
            ? `${directCandidates.length} preserved VP template role(s) will render directly`
            : `${directCandidates.length} direct-build (VP content used verbatim)`;
        console.log(`  [Templates] ${directLabel} | ${aiCandidates.length} need AI`);
        for (const cand of directCandidates) {
            if (templateScenes.length >= maxTemplates) break;
            const isPreservedTemplate = preservePlannerTemplateRoles && cand.selectionMode === 'visual-planner-preserved';
            const tpl = _buildTemplateFromVPHint(cand, themeId)
                || (isPreservedTemplate
                    // stats.byType is the running tally of everything placed so
                    // far this video (listicle grid, earlier direct builds) —
                    // it is what lets the coverage picker stop repeating itself.
                    ? (_buildFallbackTemplateFromScene(cand, themeId) || _buildCoverageTemplateFromScene(cand, themeId, stats.byType))
                    : null);
            if (!tpl) {
                if (isPreservedTemplate) {
                    console.warn(`  [Templates] Preserved VP template for scene ${cand.sceneIndex} could not be rendered; visual coverage may need continuity fallback`);
                }
                continue;
            }
            if (!_checkV3Conflict(tpl, v3Ranges, templateScenes, { enforceMinGap: !isPreservedTemplate })) {
                templateScenes.push(tpl);
                v3Ranges.push({ start: tpl.startTime, end: tpl.endTime });
                stats.byType[tpl.type] = (stats.byType[tpl.type] || 0) + 1;
                const reveal = tpl.templateContentStartTime != null
                    ? ` reveal ${tpl.templateContentStartTime.toFixed(1)}s-${tpl.templateContentEndTime.toFixed(1)}s`
                    : '';
                console.log(`  [Templates] ${tpl.type} on scene ${tpl.sceneIndex} @ ${tpl.startTime.toFixed(1)}s-${tpl.endTime.toFixed(1)}s${reveal} "${(tpl.text || '').substring(0, 40)}" [${tpl.selectionMode || 'vp-direct'}]`);
            } else {
                stats.conflicts++;
                stats.skipped++;
            }
        }
    }

    // ── Step 3: AI template selection for candidates with thin/missing VP content ──
    if (aiCandidates.length > 0) {
        const nonListicleMax = maxTemplates - templateScenes.length;
        if (nonListicleMax > 0) {
            try {
                const aiTemplates = await _aiSelectTemplates(
                    aiCandidates, scenes, scriptContext, mgScenes,
                    v3Ranges, templateScenes, themeId, nicheId,
                    nonListicleMax, aiInstructions
                );
                for (const tpl of aiTemplates) {
                    if (!_checkV3Conflict(tpl, v3Ranges, templateScenes)) {
                        templateScenes.push(tpl);
                        v3Ranges.push({ start: tpl.startTime, end: tpl.endTime });
                        stats.byType[tpl.type] = (stats.byType[tpl.type] || 0) + 1;
                        const reveal = tpl.templateContentStartTime != null
                            ? ` reveal ${tpl.templateContentStartTime.toFixed(1)}s-${tpl.templateContentEndTime.toFixed(1)}s`
                            : '';
                        console.log(`  [Templates] ${tpl.type} on scene ${tpl.sceneIndex} @ ${tpl.startTime.toFixed(1)}s-${tpl.endTime.toFixed(1)}s${reveal} "${(tpl.text || '').substring(0, 40)}"`);
                    } else {
                        stats.conflicts++;
                        stats.skipped++;
                    }
                }
                const placedIndexes = new Set(templateScenes.map(t => t.sceneIndex));
                for (const cand of aiCandidates) {
                    if (placedIndexes.has(cand.sceneIndex)) continue;
                    console.log(`  [Templates] Scene ${cand.sceneIndex} ${cand.hintType} not placed by template AI (spacing/confidence/content rules)`);
                }
            } catch (err) {
                console.log(`  [Templates] AI selection failed: ${err.message} — continuing with direct-build only`);
            }
        }
    }

    // Assign sequential IDs
    templateScenes.forEach((tpl, i) => { tpl.id = `tpl-${i}`; });
    stats.total = templateScenes.length;

    console.log(`  [Templates] Total: ${stats.total} template(s) placed`);
    return { templateScenes, stats };
}

// ============ LISTICLE GRID (RULE-BASED) ============

/**
 * Generate listicle grid template — migrated from ai-motion-graphics.js.
 * @returns {Object|null} Template scene object
 */
function _resolveListicleGrid(scenes, scriptContext, themeId) {
    const { generateListicleGridMG } = require('../formats/listicle-format');
    const listicleItems = scriptContext.listicleItems;
    const totalItems = listicleItems.length;

    const firstItem = listicleItems[0];
    if (!firstItem) return null;

    const overviewIdx = Math.max(0, firstItem.startSceneIndex - 1);
    const overviewScene = scenes[overviewIdx];
    if (!overviewScene) return null;

    const title = overviewScene.text
        ? overviewScene.text.substring(0, 80).trim()
        : `Top ${totalItems}`;

    // Collect thumbnail media files from each item's start scene
    const itemThumbs = listicleItems.map(item => {
        const itemScene = scenes[item.startSceneIndex];
        return itemScene?.mediaFile || null;
    });

    const startTime = overviewScene.startTime;
    // listicleGrid mirrors the overview scene duration — no hard cap.
    const duration = (overviewScene.endTime || overviewScene.startTime + 5) - overviewScene.startTime;

    // Use listicle-format generator for base structure
    const gridMG = generateListicleGridMG(
        listicleItems, overviewIdx, startTime, duration, title
    );

    // Apply theme styling
    const { variant, animation } = _pickVariantAndAnimation('listicleGrid', themeId);

    // Convert to template scene format
    return {
        ...gridMG,
        templateType: true,
        trackId: 'video-track-3',
        mediaType: 'template',
        endTime: startTime + duration,
        style: _pickStyle(themeId),
        themeId,
        variant,
        animation,
        selectionMode: 'rule',
        _itemThumbnails: itemThumbs,
        keyword: `Template: listicleGrid`,
    };
}

// ============ CANDIDATE BUILDER ============

function _parseTemplateHintParts(templateHint) {
    if (!templateHint || typeof templateHint !== 'string') return { hintType: null, hintContent: '' };
    const colonIdx = templateHint.indexOf(':');
    const hintType = colonIdx > 0 ? templateHint.substring(0, colonIdx).trim() : templateHint.trim();
    const hintContent = colonIdx > 0 ? templateHint.substring(colonIdx + 1).trim() : '';
    return { hintType, hintContent };
}

function _templateCandidateRejectReason(scene, scriptContext, allowedTemplates, scenes = []) {
    if (!scene.templateHint) return 'no templateHint';

    const { hintType } = _parseTemplateHintParts(scene.templateHint);
    if (!TEMPLATE_TYPES.has(hintType)) return `unknown template type "${hintType || 'none'}"`;
    if (hintType === 'listicleGrid') return 'listicleGrid is handled by the rule-based listicle pass';
    if (!allowedTemplates.includes(hintType)) return `template type "${hintType}" not allowed for this niche`;
    if (scene.fullscreenMG) return 'scene became fullscreenMG, so template lane is blocked';

    const hookEnd = scriptContext?.hookEndTime || 0;
    const totalDuration = scriptContext?.totalDuration || scenes[scenes.length - 1]?.endTime || 60;
    const ctaStart = totalDuration * 0.92;
    const sceneStart = scene.startTime || 0;
    if (sceneStart < hookEnd) return `inside hook zone (${sceneStart.toFixed(1)}s < ${Number(hookEnd).toFixed(1)}s)`;
    if (sceneStart > ctaStart) return `inside CTA zone (${sceneStart.toFixed(1)}s > ${ctaStart.toFixed(1)}s)`;
    const placementReason = validateTemplateHintPlacement(scene, scenes, scriptContext);
    if (placementReason) return placementReason;
    return 'unknown candidate guard';
}

/**
 * Collect scenes with templateHint from Visual Planner.
 */
function _templateIdentity(scene, fallbackIndex = 0) {
    const stable = scene?.originalIndex
        ?? scene?.sourceSceneIndex
        ?? scene?.index
        ?? fallbackIndex;
    return {
        sceneIndex: scene?.index ?? stable,
        sourceSceneIndex: stable,
        originalSceneIndex: stable,
    };
}

function _buildCandidates(scenes, scriptContext, allowedTemplates) {
    const candidates = [];
    const hookEnd = scriptContext?.hookEndTime || 0;
    const totalDuration = scriptContext?.totalDuration || scenes[scenes.length - 1]?.endTime || 60;
    const ctaStart = totalDuration * 0.92; // last 8% is CTA territory

    for (const scene of scenes) {
        if (!scene.templateHint) continue;

        // Parse hint: "chapterCard: Chapter 2 — The Rise"
        const { hintType, hintContent } = _parseTemplateHintParts(scene.templateHint);

        // Validate type
        if (!TEMPLATE_TYPES.has(hintType)) continue;
        if (hintType === 'listicleGrid') continue; // handled rule-based
        if (!allowedTemplates.includes(hintType)) continue;

        // Skip hook/CTA scenes
        const sceneStart = scene.startTime || 0;
        if (sceneStart < hookEnd) continue;
        if (sceneStart > ctaStart) continue;

        // Skip scenes that already have fullscreen MGs
        if (scene.fullscreenMG) continue;

        // Prominent template text must belong to this scene, and keyTakeaway
        // cards are reserved for true summary beats.
        if (validateTemplateHintPlacement(scene, scenes, scriptContext)) continue;

        candidates.push({
            ..._templateIdentity(scene),
            scene,
            hintType,
            hintContent,
            templateBgQuery: scene.templateBgQuery || null,
            startTime: scene.startTime,
            endTime: scene.endTime || scene.startTime + 4,
        });
    }

    return candidates;
}

function _buildPreservedPlannerTemplateCandidates(scenes, allowedTemplates) {
    const candidates = [];
    for (const scene of scenes) {
        if (!scene?.templateHint || scene.fullscreenMG) continue;

        const { hintType, hintContent } = _parseTemplateHintParts(scene.templateHint);
        if (!TEMPLATE_TYPES.has(hintType)) continue;
        if (hintType === 'listicleGrid') continue;
        if (!allowedTemplates.includes(hintType)) continue;

        candidates.push({
            ..._templateIdentity(scene),
            scene,
            hintType,
            hintContent,
            templateBgQuery: scene.templateBgQuery || scene.bgQuery || scene.keyword || null,
            startTime: scene.startTime,
            endTime: scene.endTime || scene.startTime + 4,
            selectionMode: 'visual-planner-preserved',
            reason: 'preserved VP template role',
        });
    }
    return candidates;
}

function _buildEditorAgentTemplateCandidates(scenes, scriptContext, allowedTemplates) {
    const candidates = [];
    const seen = new Set();
    const hookEnd = scriptContext?.hookEndTime || 0;
    const totalDuration = scriptContext?.totalDuration || scenes[scenes.length - 1]?.endTime || 60;
    const ctaStart = totalDuration * 0.92;
    const maxCandidates = Math.max(8, Number(process.env.EDITOR_AGENT_TEMPLATE_CANDIDATES || 24));
    const canUse = type => TEMPLATE_TYPES.has(type)
        && type !== 'listicleGrid'
        && allowedTemplates.includes(type);

    const sceneText = scene => [
        scene?.text,
        scene?.keyword,
        scene?.visualIntent,
        scene?.sourceQuery,
        scene?.searchQuery,
    ].filter(Boolean).join(' ');

    const add = (scene, type, reason, content = '') => {
        if (!scene || !canUse(type)) return;
        const sceneStart = scene.startTime || 0;
        if (sceneStart < hookEnd || sceneStart > ctaStart) return;
        if (scene.fullscreenMG) return;
        if (validateTemplateHintPlacement(scene, scenes, scriptContext)) return;
        const key = `${scene.index}:${type}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({
            ..._templateIdentity(scene),
            scene,
            hintType: type,
            hintContent: content,
            templateBgQuery: scene.templateBgQuery || scene.bgQuery || scene.keyword || null,
            startTime: scene.startTime,
            endTime: scene.endTime || scene.startTime + 4,
            selectionMode: 'editor-agent-candidate',
            reason,
        });
    };

    for (const scene of scenes) {
        if (candidates.length >= maxCandidates) break;
        const text = sceneText(scene);
        const lower = text.toLowerCase();
        const sceneStart = scene.startTime || 0;
        const sceneEnd = scene.endTime || sceneStart + 0;
        const duration = sceneEnd - sceneStart;
        if (!text || duration < 2.25) continue;

        if (/\b(vs\.?|versus|compared|comparison|against|before and after|before\/after|while|whereas|instead of)\b/i.test(text)) {
            add(scene, 'comparisonCard', 'comparison cue');
        }
        if (/\b\d[\d,.\s]*(%|percent|million|billion|trillion|years?|days?|hours?|tons?|barrels?|dollars?|usd|km|miles?)\b|[$€£]\s*\d/i.test(text)) {
            add(scene, 'statCard', 'number/stat cue');
        }
        if (/[“"][^”"]{12,120}[”"]/.test(text) || /\b(quote|said|called|claimed|told|warned|announced)\b/i.test(text)) {
            add(scene, 'quoteCard', 'quote/source cue');
        }
        if (/\b(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text)) {
            add(scene, 'timelineCard', 'date/time cue');
        }
        if (/\b(that means|which means|therefore|ultimately|in short|bottom line|the point|the lesson|this is why|key takeaway)\b/i.test(lower)) {
            add(scene, 'keyTakeaway', 'takeaway cue');
        }
        if (/\b(showcase|gallery|collection|row|rows|display|examples|these|those|look like|side by side)\b/i.test(lower)) {
            add(scene, 'imageShowcase', 'visual collection cue');
        }
        if (/\b(first|second|third|fourth|fifth|chapter|part|section|next|now|today|meanwhile|turning point|the question|the answer)\b/i.test(lower)) {
            add(scene, 'chapterCard', 'section/transition cue');
        }
        if (/\b(three|four|five|six|seven|list|reasons|ways|steps|types|categories|factors|features)\b/i.test(lower)) {
            add(scene, 'infographic', 'multi-item cue');
        }
        if (/\b(in|at|near|between|across|from|through)\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}/.test(text)) {
            add(scene, 'locationCard', 'location cue');
        }
        if (/\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(text) && /\b(founder|ceo|president|minister|general|scientist|inventor|engineer|leader|actor|person|man|woman)\b/i.test(text)) {
            add(scene, 'personIntro', 'named-person cue');
        }
        if (/\b(how it works|breakdown|explains?|system|process|chain|network|flow|structure|design)\b/i.test(lower)) {
            add(scene, 'factCard', 'explanation cue');
        }
    }

    return candidates.slice(0, maxCandidates);
}

function _cleanTemplateDisplayText(value) {
    if (value == null) return '';
    return String(value)
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function _normalizeTemplateWord(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/['`]s\b/g, '')
        .replace(/[^a-z0-9%]+/g, '');
}

function _stemTemplateWord(word) {
    if (!word || word.length < 5) return word;
    return word.replace(/(?:ingly|edly|ing|ed|es|s)$/i, '');
}

function _templateWordsMatch(a, b) {
    const left = _normalizeTemplateWord(a);
    const right = _normalizeTemplateWord(b);
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return true;
    const leftStem = _stemTemplateWord(left);
    const rightStem = _stemTemplateWord(right);
    return leftStem.length >= 4 && leftStem === rightStem;
}

function _findTemplateWordTime(scene, candidates = []) {
    if (!scene || !Array.isArray(scene.words) || scene.words.length === 0) return null;
    const targets = candidates.map(_normalizeTemplateWord).filter(Boolean);
    if (targets.length === 0) return null;

    for (const word of scene.words) {
        const wordText = word && word.word;
        if (!wordText) continue;
        const start = Number(word.start);
        if (!Number.isFinite(start)) continue;
        if (targets.some(target => _templateWordsMatch(wordText, target))) return start;
    }
    return null;
}

function _resolveTemplateTiming(scene, type, displayText, registry) {
    const sceneStart = Number(scene?.startTime) || 0;
    const sceneEnd = Number(scene?.endTime) || (sceneStart + 4);
    const sceneDur = Math.max(0, sceneEnd - sceneStart);
    const minDur = Math.min(sceneDur, Number(registry?.minDur) || 3);
    const maxDur = Math.min(sceneDur, Number(registry?.maxDur) || sceneDur);

    if (sceneDur <= 0 || sceneDur < minDur) return null;

    let startTime = sceneStart;

    if (type === 'keyTakeaway') {
        const displayTriggerWords = distinctiveWords(displayText);
        const cueTriggerWords = ['means', 'therefore', 'ultimately', 'because', 'enough', 'result'];
        const triggerTime =
            _findTemplateWordTime(scene, displayTriggerWords) ??
            _findTemplateWordTime(scene, cueTriggerWords);
        if (triggerTime !== null) {
            const latestStartForMin = sceneEnd - minDur;
            startTime = Math.max(sceneStart, Math.min(triggerTime - 0.35, latestStartForMin));
        } else if (sceneDur > maxDur) {
            startTime = sceneEnd - maxDur;
        }
    }

    let duration = Math.min(maxDur, sceneEnd - startTime);
    if (duration < minDur) {
        startTime = Math.max(sceneStart, sceneEnd - minDur);
        duration = sceneEnd - startTime;
    }
    if (duration < minDur) return null;

    return {
        startTime,
        endTime: startTime + duration,
        duration,
    };
}

// ============ AI TEMPLATE SELECTION ============

/**
 * Single batch AI call to select and enrich templates from candidates.
 */
async function _aiSelectTemplates(candidates, scenes, scriptContext, mgScenes, v3Ranges, existingTemplates, themeId, nicheId, maxCount, aiInstructions) {
    if (candidates.length === 0) return [];

    const format = scriptContext?.format || 'standard';
    const summary = scriptContext?.summary || scriptContext?.title || 'video';
    const nicheName = getNiche(nicheId)?.name || nicheId;
    const totalDuration = scriptContext?.totalDuration || 60;

    // Build V3 occupied ranges string
    const occupiedStr = v3Ranges
        .map(r => `${r.start.toFixed(1)}s-${r.end.toFixed(1)}s`)
        .join(', ') || 'none';

    // Build candidate list
    const candidateStr = candidates
        .map(c => {
            const sourceLabel = c.selectionMode === 'editor-agent-candidate' ? 'candidate' : 'hint';
            const reason = c.reason ? ` / ${c.reason}` : '';
            return `SCENE ${c.sceneIndex} [${sourceLabel}: ${c.hintType}${reason}] (${c.startTime.toFixed(1)}s-${c.endTime.toFixed(1)}s): "${(c.scene.text || '').substring(0, 100)}"${c.hintContent ? ` [suggested: ${c.hintContent}]` : ''}`;
        })
        .join('\n');

    const videoTitle = scriptContext.videoTitle || '';
    let prompt = `You are a visual template designer for a ${format} video (${totalDuration.toFixed(0)}s)${videoTitle ? ` titled "${videoTitle}"` : ''} about "${summary}".
Theme: ${themeId} | Niche: ${nicheName}

🎯 GLOBAL EDITORIAL RULE — KEEP TEMPLATES RARE: real footage is the BACKBONE of the video; full-screen
text/data cards are RARE punctuation, never the default. A wall of designed cards is the #1 reason a video
looks AI-made — a human editor stays on footage and lets a stat, place, or quote ride as a small overlay
INSTEAD of cutting to a card. Bias HARD toward SKIP: emit far fewer templates than the candidates suggest,
keep them spread far apart, and reserve them for the few beats where footage genuinely cannot carry the
narration (a hard number, a real list, a thesis, a direct comparison). When in doubt, SKIP.

AVAILABLE TEMPLATE TYPES:
- chapterCard: Section/chapter headers. Use when narration transitions to a new major topic.
- locationCard: Location establishment. Use when a NEW specific place is introduced for the first time.
- quoteCard: Notable quotes. Use when a direct quote is spoken that deserves visual emphasis.
- keyTakeaway: Summary/conclusion points. Use in final 20% of video for key insights.
- comparisonCard: Before/after or X vs Y comparisons. Use when explicit comparison is narrated.
- timelineCard: Chronological event markers. Use when dates/events form a sequence.
- factCard: Fact panel with 4 layout variants (splitPanel: image left + bullet panel right | overlay: floating card over full image | sidebar: narrow strip on right | numbered: large numbers beside each point). Use when narration lists multiple facts, features, or details about a topic. Needs 3-5 bullet items.
- imageShowcase: Dual-image showcase with typewriter title. Two images slide in from opposite sides. Use when narration references two related concepts, people, places, or contrasting visuals. Needs exactly 2 items describing the images.
- statCard: Icon + big number + label infographic (like TV news stats). Use when narration mentions 1-3 specific numbers, percentages, or statistics. Items format: "iconHint number label" per stat. Icon hints: energy, shield, home, money, people, globe, chart, clock, building, car, health, tech. Example: items: "shield -90% Insurance Premiums; energy -75% Energy Bills"
- personIntro: Person introduction card — portrait photo + big name + role/date + optional context image. Use when a NAMED PERSON is introduced for the FIRST TIME. Shows their portrait on one side, name + details on the other, then a context image appears. text=person name, subText=role/title/year, items="person portrait description; context image description". Example: text: "Wallace Neff" | subText: "Architect, 1941" | items: "Wallace Neff portrait photo 1940s; Wallace Neff bubble house dome 1941"
- splitScreen: Vertical split-screen showing two images/concepts side by side with labels. Use when narration EXPLICITLY COMPARES two things visually (before/after, two countries, two perspectives, two locations). Needs exactly 2 items: each item is "label | image search query". Example: text: "Russia vs Japan" | items: "Russia military parade; Japan Self-Defense Forces exercise"
- infographic: Multi-item visual layout with icons, images, titles, and values. Use when narration lists 3-5+ distinct items each with a stat/price/detail (e.g., weapon costs, country GDP, building specs). Items format: "title | value | image search query" per item. Example: text: "Top Defense Budgets" | items: "United States | $886B | pentagon building; China | $296B | chinese military; India | $83B | indian army parade; UK | $75B | british royal navy; France | $56B | french military"

CANDIDATE SCENES (potential template moments surfaced for the Editor Agent):
${candidateStr}

V3 OCCUPIED RANGES (fullscreen MGs — DO NOT overlap): ${occupiedStr}

${aiInstructions ? `ADDITIONAL INSTRUCTIONS:\n${aiInstructions}\n` : ''}
For each candidate, output ONE line in this EXACT format:
SCENE <idx>: type: <templateType> | text: <primary display text, max 60 chars> | subText: <secondary text, max 80 chars> | items: <item1; item2; item3 OR none> | confidence: <0.0-1.0>
Or: SCENE <idx>: SKIP

RULES:
- Select at most ${maxCount} templates (premium visual moments, not filler)
- Minimum 15s gap between any two templates
- NEVER overlap with V3 occupied ranges listed above
- text should be punchy and visual (what appears on screen), not the narration
- subText provides context or subtitle
- items for comparisonCard (left; right), timelineCard (date: event; date: event), factCard (fact1; fact2; fact3; fact4), imageShowcase (image1 description; image2 description), statCard (iconHint number label; iconHint number label), or personIntro (person portrait description; context image description)
- Confidence: 0.9+ = perfect fit, 0.7-0.89 = good, below 0.7 = skip it
- Default to SKIP (per the GLOBAL EDITORIAL RULE above) — only output a template when footage genuinely cannot carry the beat; a light overlay on footage almost always beats a full-screen card`;

    // What this video has already put on screen.
    //
    // The MG author has had this for as long as it has existed
    // (`ALREADY PLACED: …` in ai-motion-graphics.js) and the template selector
    // never did — it was handed `existingTemplates` and only ever used the
    // TIMES inside it, never the types. So it chose every card in ignorance of
    // every other card, and the measured Aug-1 build came out with the same
    // takeaway card five times. That is not a taste failure; nothing told it.
    //
    // Conditional on purpose: a video with nothing placed yet gets exactly the
    // prompt it got before, byte for byte. The correction only exists once the
    // video has a habit to correct, and it is the video's OWN distribution —
    // no quota, no cap, no per-niche table, so it stays right when the niche,
    // the format or the card count changes.
    const placedCounts = {};
    for (const t of (existingTemplates || [])) {
        if (t?.type) placedCounts[t.type] = (placedCounts[t.type] || 0) + 1;
    }
    const placedEntries = Object.entries(placedCounts).sort((a, b) => b[1] - a[1]);
    if (placedEntries.length > 0) {
        const placedStr = placedEntries.map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
        prompt += `\n\nALREADY ON SCREEN IN THIS VIDEO: ${placedStr}`;
        prompt += `\n- Variety is part of looking hand-made: reaching for a card type this video has already used`
            + ` reads as a machine repeating itself. Prefer a type not in that list — or SKIP.`;
        if (placedEntries[0][1] > 1) {
            prompt += ` "${placedEntries[0][0]}" has already been used ${placedEntries[0][1]} times; do not use it again unless the narration leaves no honest alternative.`;
        }
    }

    // Language instruction — affects text/subText/items (user-facing).
    // Template `type` stays English (it's an enum: factCard|statCard|etc.), as does
    // `iconHint` inside items (maps to icon registry). Confidence/idx are numbers.
    prompt += getLanguageBlock(scriptContext?.language);

    const response = await callAI(prompt, { temperature: 0.3, taskType: 'template' });
    return _parseAIResponse(response, candidates, scenes, themeId);
}

/**
 * Parse AI response into template scene objects.
 */
function _parseAIResponse(response, candidates, scenes, themeId) {
    const results = [];
    const lines = (response || '').split('\n').filter(l => l.trim().startsWith('SCENE'));

    for (const line of lines) {
        // Parse: SCENE 3: type: chapterCard | text: ... | subText: ... | items: ... | confidence: 0.85
        const idxMatch = line.match(/SCENE\s+(\d+)/i);
        if (!idxMatch) continue;
        const sceneIdx = parseInt(idxMatch[1]);

        // Check for SKIP
        if (/SKIP/i.test(line) && !/type:/i.test(line)) continue;

        const candidate = candidates.find(c => c.sceneIndex === sceneIdx);
        if (!candidate) continue;

        // Parse fields
        const typeMatch = line.match(/type:\s*(\w+)/i);
        const textMatch = line.match(/text:\s*(.+?)(?:\s*\||$)/i);
        const subTextMatch = line.match(/subText:\s*(.+?)(?:\s*\||$)/i);
        const itemsMatch = line.match(/items:\s*(.+?)(?:\s*\||$)/i);
        const confMatch = line.match(/confidence:\s*([\d.]+)/i);

        const type = typeMatch ? typeMatch[1].trim() : candidate.hintType;
        if (!TEMPLATE_TYPES.has(type) || type === 'listicleGrid') continue;

        const registry = TEMPLATE_REGISTRY[type];
        if (!registry) continue;

        const confidence = confMatch ? parseFloat(confMatch[1]) : 0.7;
        if (confidence < 0.6) continue;

        const text = _cleanTemplateDisplayText(textMatch ? textMatch[1] : (candidate.hintContent || ''));
        const subText = _cleanTemplateDisplayText(subTextMatch ? subTextMatch[1] : '');

        // Parse items
        let items = [];
        if (itemsMatch) {
            const itemsStr = itemsMatch[1].trim();
            if (itemsStr && itemsStr.toLowerCase() !== 'none') {
                items = itemsStr.split(';').map(s => s.trim()).filter(Boolean);
            }
        }

        const scene = candidate.scene;
        const sceneDur = (scene.endTime || scene.startTime + 4) - scene.startTime;
        const sceneStart = scene.startTime;
        const sceneEnd = scene.endTime || scene.startTime + sceneDur;
        // Templates are beats inside a scene. They should not inherit the full
        // clip duration when the registry defines a tighter readable window.
        if (sceneDur < registry.minDur) continue;

        // Item-image templates need ≥ itemImageCount items (one per panel).
        // Without enough items, the template renders with empty/blank panels.
        if (registry.needsItemImages && registry.itemImageCount && items.length < registry.itemImageCount) {
            console.warn(`   ⚠️  Skipping ${type} on scene ${sceneIdx + 1}: needs ${registry.itemImageCount} items, AI returned ${items.length}`);
            continue;
        }
        const timing = _resolveTemplateTiming(scene, type, text, registry);
        if (!timing) continue;
        const { variant, animation } = _pickVariantAndAnimation(type, themeId);

        results.push({
            type,
            templateType: true,
            text,
            subText,
            items,
            startTime: sceneStart,
            endTime: sceneEnd,
            duration: sceneDur,
            templateContentStartTime: timing.startTime,
            templateContentEndTime: timing.endTime,
            templateContentDuration: timing.duration,
            templateContentOffset: Math.max(0, timing.startTime - sceneStart),
            trackId: 'video-track-3',
            mediaType: 'template',
            style: _pickStyle(themeId),
            themeId,
            variant,
            animation,
            sceneIndex: sceneIdx,
            sourceSceneIndex: candidate.sourceSceneIndex ?? scene.originalIndex ?? sceneIdx,
            originalSceneIndex: candidate.originalSceneIndex ?? scene.originalIndex ?? sceneIdx,
            selectionMode: 'ai',
            confidence,
            position: 'center',
            category: 'fullscreen',
            keyword: `Template: ${type}`,
            bgQuery: candidate.templateBgQuery || scene.templateBgQuery || null,
        });
    }

    return results;
}

// ============ VP-HINT DIRECT BUILD ============
// When the Visual Planner already produced usable template content (text + items),
// skip the second AI call and build the template straight from VP's hint. Saves a
// full AI round-trip and makes VP's plan actually the plan.

/**
 * Parse VP's templateHint content into { text, subText, items } per template format.
 * Returns null if the content isn't parseable/complete for that type.
 *
 * Expected formats (from ai-visual-planner.js prompt):
 *   chapterCard    : "Chapter Title"
 *   locationCard   : "Place, Country"
 *   quoteCard      : "the quote text"
 *   keyTakeaway    : "main point"
 *   comparisonCard : "Thing A vs Thing B"
 *   timelineCard   : "Date1: Event | Date2: Event"
 *   factCard       : "Title | fact1; fact2; fact3; fact4"
 *   imageShowcase  : "Title | image1 desc; image2 desc; image3 desc"
 *   statCard       : "energy -75% Label; shield -90% Label"
 *   personIntro    : "Person Name | Role/Title, Year"
 *   splitScreen    : "Title | Left Label; Right Label"
 *   infographic    : "Title | Item1 Title | Value | image; Item2 Title | Value | image"
 */
function _parseVPTemplateHint(type, content) {
    if (!content || typeof content !== 'string') return null;
    const raw = _cleanTemplateDisplayText(content);
    if (!raw || raw.toLowerCase() === 'none') return null;

    const pipeParts = raw.split('|').map(s => s.trim()).filter(Boolean);
    const semiSplit = s => s.split(';').map(x => x.trim()).filter(Boolean);

    switch (type) {
        case 'chapterCard':
        case 'locationCard':
        case 'quoteCard':
        case 'keyTakeaway':
        case 'comparisonCard':
            return { text: raw, subText: '', items: [] };

        case 'personIntro':
            // "Name | Role, Year" — name = text, role = subText. Items come from
            // VP's item-image hints if present beyond the first two parts.
            if (pipeParts.length >= 2) {
                return {
                    text: pipeParts[0],
                    subText: pipeParts[1],
                    items: pipeParts.length >= 3 ? semiSplit(pipeParts.slice(2).join('|')) : [],
                };
            }
            return null; // needs name + role at minimum

        case 'statCard':
            // "iconHint N label; iconHint N label" — no title, items only
            return { text: '', subText: '', items: semiSplit(raw) };

        case 'timelineCard':
        case 'factCard':
        case 'imageShowcase':
        case 'splitScreen':
        case 'infographic': {
            // "Title | item1; item2" — title first, items semi-separated after pipe
            if (pipeParts.length >= 2) {
                const itemsPart = pipeParts.slice(1).join('|');
                return {
                    text: pipeParts[0],
                    subText: '',
                    items: semiSplit(itemsPart),
                };
            }
            // Single pipe-less string — fall back to treating whole thing as items
            const items = semiSplit(raw);
            if (items.length >= 2) return { text: '', subText: '', items };
            return null;
        }

        default:
            return { text: raw, subText: '', items: [] };
    }
}

/**
 * Whether VP's hint content is complete enough to skip the second AI call.
 * Checks item-count requirements for item-image templates.
 */
function _isVPHintUsable(type, parsed, registry) {
    if (!parsed) return false;
    if (type === 'statCard') {
        return _validStatCardItems(parsed.items).length >= 1;
    }
    if (registry?.needsItemImages && registry?.itemImageCount) {
        return (parsed.items?.length || 0) >= registry.itemImageCount;
    }
    if (registry?.requiresItems) {
        // Item-driven templates need real structured items. A lone title like
        // "Worst Case Scenario" should degrade to a simpler coverage card, not
        // become a fake fact/stat/timeline grid.
        return (parsed.items?.length || 0) >= 2;
    }
    // Text-only templates — any non-empty text works
    return (parsed.text || '').length > 0;
}

function _parseStatCardItem(item) {
    if (item && typeof item === 'object') {
        const value = _cleanTemplateDisplayText(item.value || item.stat || item.number || '');
        const label = _cleanTemplateDisplayText(item.label || item.text || item.title || item.name || '');
        if (value && label && _looksLikeRealStatValue(value)) {
            return { ...item, value, label };
        }
        return null;
    }

    const raw = _cleanTemplateDisplayText(item || '')
        .replace(/^(?:nearly|about|around|roughly|approximately|approx\.?|over|under|more than|less than)\s+/i, '');
    if (!raw) return null;
    const match = raw.match(/^(?:(?<icon>[a-z][a-z-]{2,18})\s+)?(?<value>[$€£]?\s*[\d,.]+(?:\s*[–-]\s*[\d,.]+)?\s*(?:%|percent|m|million|bn|b|billion|trillion|x|barrels?|tons?|days?|hours?|years?|km|miles?|usd|dollars?)?)\s+(?<label>.+)$/i);
    if (!match?.groups) return null;

    const rawIcon = _cleanTemplateDisplayText(match.groups.icon || '').toLowerCase();
    const icon = _knownStatIcon(rawIcon) ? rawIcon : '';
    const value = _cleanTemplateDisplayText(match.groups.value)
        .replace(/\s*[–-]\s*/g, '-')
        .replace(/\s+/g, ' ');
    const label = _cleanTemplateDisplayText(match.groups.label);
    if (!_looksLikeRealStatValue(value) || label.length < 3) return null;

    return {
        kind: 'stat',
        icon,
        value,
        label,
    };
}

function _knownStatIcon(value) {
    return new Set([
        'energy', 'shield', 'home', 'money', 'people', 'globe', 'chart',
        'clock', 'building', 'car', 'health', 'tech', 'ship', 'oil',
        'route', 'warning', 'risk', 'trade',
    ]).has(String(value || '').toLowerCase());
}

function _looksLikeRealStatValue(value) {
    const text = _cleanTemplateDisplayText(value).toLowerCase();
    if (!text) return false;
    if (/^(?:19|20)\d{2}$/.test(text)) return false;
    return /(?:%|percent|m|million|bn|b|billion|trillion|x|barrels?|tons?|days?|hours?|years?|km|miles?|usd|dollars?)\b/.test(text)
        || /[$€£]/.test(text)
        || /\d+\s*[–-]\s*\d+/.test(text);
}

function _validStatCardItems(items = []) {
    return (items || []).map(_parseStatCardItem).filter(Boolean);
}

function _fallbackTemplateItems(type, parsedItems = [], scene = {}) {
    const items = (parsedItems || []).map(_cleanTemplateDisplayText).filter(Boolean);
    if (type === 'statCard') {
        const validParsed = _validStatCardItems(parsedItems);
        if (validParsed.length > 0) return validParsed;
    } else if (items.length > 0) {
        return items;
    }

    const words = distinctiveWords(`${scene.text || ''} ${scene.keyword || ''}`).slice(0, 5);
    const keyword = _cleanTemplateDisplayText(scene.keyword || scene.visualIntent || 'documentary context');

    if (type === 'personIntro') {
        return [
            `${keyword || 'person'} portrait`,
            `${keyword || 'context'} documentary image`,
        ];
    }
    if (type === 'splitScreen' || type === 'imageShowcase' || type === 'comparisonCard') {
        const left = words[0] || keyword || 'context';
        const right = words[1] || scene.visualIntent || 'impact';
        return [left, right].map(_cleanTemplateDisplayText).filter(Boolean);
    }
    if (type === 'statCard') {
        const match = String(scene.text || '').match(/[$€£]?\s?\d[\d,.\s]*(?:\s*[–-]\s*[\d,.\s]+)?\s*(?:%|percent|m|million|bn|billion|trillion|years?|days?|hours?|tons?|barrels?|dollars?|usd|km|miles?)\b/i);
        if (match) {
            const label = _cleanTemplateDisplayText((scene.ideaLowerThird || scene.keyword || 'Key figure').replace(match[0], '')) || 'Key figure';
            return [{ kind: 'stat', value: match[0].trim(), label }];
        }
    }
    return (words.length >= 2 ? words : [keyword, scene.visualIntent, scene.text])
        .map(_cleanTemplateDisplayText)
        .filter(Boolean)
        .slice(0, 5);
}

function _fallbackTemplateText(candidate, parsed = null) {
    const scene = candidate.scene || {};
    const raw = _cleanTemplateDisplayText(parsed?.text || scene.ideaLowerThird || candidate.hintContent || scene.keyword || scene.text || scene.visualIntent || '');
    if (raw) return raw.length > 80 ? `${raw.slice(0, 77).trim()}...` : raw;
    return 'Key Context';
}

function _buildFallbackTemplateFromScene(candidate, themeId) {
    const { scene, hintType, hintContent } = candidate;
    const registry = TEMPLATE_REGISTRY[hintType];
    if (!registry || !scene) return null;

    const parsed = _parseVPTemplateHint(hintType, hintContent) || {};
    if (registry.requiresItems && !_isVPHintUsable(hintType, parsed, registry)) {
        if (hintType !== 'statCard') return null;
    }
    let text = _fallbackTemplateText(candidate, parsed);
    const subText = _cleanTemplateDisplayText(parsed.subText || '');
    const items = _fallbackTemplateItems(hintType, parsed.items || [], scene);
    if (registry.requiresItems) {
        if (hintType === 'statCard' && _validStatCardItems(items).length === 0) return null;
        if (hintType !== 'statCard' && (!_isVPHintUsable(hintType, { ...parsed, items }, registry))) return null;
    }
    if (hintType === 'statCard' && _validStatCardItems(items).length > 0) {
        text = _cleanTemplateDisplayText(scene.ideaLowerThird || `${items[0].value || ''} ${items[0].label || ''}`) || text;
    }
    const sceneDur = (scene.endTime || scene.startTime + 4) - scene.startTime;
    const sceneStart = scene.startTime;
    const sceneEnd = scene.endTime || scene.startTime + sceneDur;
    if (sceneDur <= 0 || sceneDur < registry.minDur) return null;

    const timing = _resolveTemplateTiming(scene, hintType, text, registry);
    if (!timing) return null;

    const { variant, animation } = _pickVariantAndAnimation(hintType, themeId);
    return {
        type: hintType,
        templateType: true,
        text,
        subText,
        items,
        startTime: sceneStart,
        endTime: sceneEnd,
        duration: sceneDur,
        templateContentStartTime: timing.startTime,
        templateContentEndTime: timing.endTime,
        templateContentDuration: timing.duration,
        templateContentOffset: Math.max(0, timing.startTime - sceneStart),
        trackId: 'video-track-3',
        mediaType: 'template',
        style: _pickStyle(themeId),
        themeId,
        variant,
        animation,
        sceneIndex: candidate.sceneIndex,
        sourceSceneIndex: candidate.sourceSceneIndex ?? scene.originalIndex ?? candidate.sceneIndex,
        originalSceneIndex: candidate.originalSceneIndex ?? scene.originalIndex ?? candidate.sceneIndex,
        selectionMode: 'visual-planner-preserved-fallback',
        confidence: 0.72,
        position: 'center',
        category: 'fullscreen',
        keyword: `Template: ${hintType}`,
        bgQuery: candidate.templateBgQuery || scene.templateBgQuery || scene.bgQuery || null,
    };
}

function _buildCoverageTemplateFromScene(candidate, themeId, placedByType = {}) {
    const { scene, hintType, hintContent } = candidate;
    if (!scene) return null;

    const sceneStart = Number(scene.startTime) || 0;
    const sceneEnd = Number(scene.endTime) || sceneStart + 4;
    const sceneDur = sceneEnd - sceneStart;
    const type = _pickCoverageTemplateType(sceneDur, placedByType);
    const registry = TEMPLATE_REGISTRY[type];
    if (!type || !registry || sceneDur <= 0) return null;

    const parsed = _parseVPTemplateHint(hintType, hintContent) || {};
    const text = _coverageTemplateText(candidate, parsed);
    const subText = _cleanTemplateDisplayText(parsed.subText || '');
    const timing = _resolveTemplateTiming(scene, type, text, registry);
    if (!timing) return null;

    const { variant, animation } = _pickVariantAndAnimation(type, themeId);
    return {
        type,
        templateType: true,
        text,
        subText,
        items: [],
        startTime: sceneStart,
        endTime: sceneEnd,
        duration: sceneDur,
        templateContentStartTime: timing.startTime,
        templateContentEndTime: timing.endTime,
        templateContentDuration: timing.duration,
        templateContentOffset: Math.max(0, timing.startTime - sceneStart),
        trackId: 'video-track-3',
        mediaType: 'template',
        style: _pickStyle(themeId),
        themeId,
        variant,
        animation,
        sceneIndex: candidate.sceneIndex,
        sourceSceneIndex: candidate.sourceSceneIndex ?? scene.originalIndex ?? candidate.sceneIndex,
        originalSceneIndex: candidate.originalSceneIndex ?? scene.originalIndex ?? candidate.sceneIndex,
        selectionMode: 'visual-planner-preserved-coverage',
        confidence: 0.68,
        position: 'center',
        category: 'fullscreen',
        keyword: `Template: ${type}`,
        bgQuery: candidate.templateBgQuery || scene.templateBgQuery || scene.bgQuery || null,
    };
}

// The three cards a coverage rescue can honestly build. Every other template
// type needs `items` — real stats, a real quote, two real images — and coverage
// rescue has only a line of text recovered from the scene, so offering it
// statCard or splitScreen would mean inventing content. Order is the editorial
// preference, longest-form first; it is still the tie-break below.
const COVERAGE_TEMPLATE_LADDER = ['keyTakeaway', 'chapterCard', 'locationCard'];

/**
 * Which card should this coverage rescue build?
 *
 * This used to be duration alone: any scene of 3s or more became a keyTakeaway,
 * every single time, because the function had no idea what the video had
 * already placed. On the real build that was measured, `key-takeaway` appeared
 * five times out of twenty graphics — the single strongest "made by a machine"
 * signal in the whole page, and it was not a taste failure by any agent. It was
 * a ladder that could only ever return one answer.
 *
 * Now the ladder still decides what is ELIGIBLE (a card the scene is long
 * enough to hold), and the video's own distribution decides which eligible card
 * to use: the one it has leaned on least so far. That counts every template
 * already placed, not just coverage ones, so a video whose AI pass already
 * chose two keyTakeaways gets a chapterCard here without anyone having to say
 * so. No cap, no quota, no per-niche table — the correction is whatever the
 * video has actually been doing, which is the only thing that stays right when
 * the niche, the format or the scene count changes.
 *
 * First-wins tie-breaking keeps the old behaviour exactly for the first
 * placement: on a video with nothing placed yet, a long scene is still a
 * keyTakeaway.
 */
function _pickCoverageTemplateType(sceneDur, placedByType = {}) {
    const eligible = COVERAGE_TEMPLATE_LADDER.filter(
        (t) => sceneDur >= (Number(TEMPLATE_REGISTRY[t]?.minDur) || Infinity)
    );
    // Nothing fits: hand back the shortest card exactly as before and let the
    // timing guard downstream reject it. Changing that here would be a second
    // decision hiding inside a first one.
    if (!eligible.length) return COVERAGE_TEMPLATE_LADDER[COVERAGE_TEMPLATE_LADDER.length - 1];
    let leastUsed = eligible[0];
    for (const type of eligible) {
        if ((placedByType[type] || 0) < (placedByType[leastUsed] || 0)) leastUsed = type;
    }
    return leastUsed;
}

function _coverageTemplateText(candidate, parsed = {}) {
    const scene = candidate.scene || {};
    const raw = _cleanTemplateDisplayText(
        parsed.text
        || scene.ideaLowerThird
        || scene.keyword
        || scene.text
        || scene.visualIntent
        || candidate.hintContent
        || ''
    );
    if (raw) return raw.length > 80 ? `${raw.slice(0, 77).trim()}...` : raw;
    return 'Key Context';
}

/**
 * Build a template scene object directly from VP's hint, mirroring the shape
 * produced by _parseAIResponse so downstream code can't tell the difference.
 */
function _buildTemplateFromVPHint(candidate, themeId) {
    const { scene, hintType, hintContent } = candidate;
    const registry = TEMPLATE_REGISTRY[hintType];
    if (!registry) return null;

    const parsed = _parseVPTemplateHint(hintType, hintContent);
    if (!_isVPHintUsable(hintType, parsed, registry)) return null;
    const statItems = hintType === 'statCard' ? _validStatCardItems(parsed.items) : null;

    const sceneDur = (scene.endTime || scene.startTime + 4) - scene.startTime;
    const sceneStart = scene.startTime;
    const sceneEnd = scene.endTime || scene.startTime + sceneDur;
    if (sceneDur < registry.minDur) return null;

    const timing = _resolveTemplateTiming(scene, hintType, parsed.text, registry);
    if (!timing) return null;

    const { variant, animation } = _pickVariantAndAnimation(hintType, themeId);

    return {
        type: hintType,
        templateType: true,
        text: hintType === 'statCard'
            ? (_cleanTemplateDisplayText(scene.ideaLowerThird || `${statItems[0]?.value || ''} ${statItems[0]?.label || ''}`))
            : _cleanTemplateDisplayText(parsed.text),
        subText: _cleanTemplateDisplayText(parsed.subText),
        items: hintType === 'statCard' ? statItems : parsed.items,
        startTime: sceneStart,
        endTime: sceneEnd,
        duration: sceneDur,
        templateContentStartTime: timing.startTime,
        templateContentEndTime: timing.endTime,
        templateContentDuration: timing.duration,
        templateContentOffset: Math.max(0, timing.startTime - sceneStart),
        trackId: 'video-track-3',
        mediaType: 'template',
        style: _pickStyle(themeId),
        themeId,
        variant,
        animation,
        sceneIndex: candidate.sceneIndex,
        sourceSceneIndex: candidate.sourceSceneIndex ?? scene.originalIndex ?? candidate.sceneIndex,
        originalSceneIndex: candidate.originalSceneIndex ?? scene.originalIndex ?? candidate.sceneIndex,
        selectionMode: candidate.selectionMode || 'vp-direct',
        confidence: 0.9,
        position: 'center',
        category: 'fullscreen',
        keyword: `Template: ${hintType}`,
        bgQuery: candidate.templateBgQuery || scene.templateBgQuery || null,
    };
}

// ============ STYLING HELPERS ============

/**
 * Pick style name from theme's MG style.
 */
function _pickStyle(themeId) {
    const theme = getTheme(themeId);
    return theme?.mgStyle || 'clean';
}

/**
 * Pick variant and animation for a template type based on theme overrides.
 */
function _pickVariantAndAnimation(type, themeId) {
    const registry = TEMPLATE_REGISTRY[type];
    if (!registry) return { variant: 'standard', animation: 'fadeSlide' };

    // Check theme overrides first
    const themeOverrides = TEMPLATE_THEME_OVERRIDES?.[themeId]?.[type];

    const variant = themeOverrides?.variant || registry.defaultVariant;
    const animation = themeOverrides?.animation || registry.defaultAnimation;

    return { variant, animation };
}

// ============ CONFLICT DETECTION ============

/**
 * Check if a template scene would overlap with V3 ranges or existing templates.
 * Enforces 15s minimum gap between templates.
 */
function _checkV3Conflict(tplScene, v3Ranges, existingTemplates, options = {}) {
    const start = tplScene.startTime;
    const end = tplScene.endTime || start + (tplScene.duration || 3);
    const MIN_GAP = 15; // seconds between templates
    const enforceMinGap = options.enforceMinGap !== false;

    // Check overlap with V3 fullscreen MGs
    for (const range of v3Ranges) {
        if (start < range.end && end > range.start) return true;
    }

    // Check minimum gap with existing templates
    for (const existing of existingTemplates) {
        if (!enforceMinGap) continue;
        const exStart = existing.startTime;
        const exEnd = existing.endTime || exStart + (existing.duration || 3);
        const gap = Math.min(Math.abs(start - exEnd), Math.abs(exStart - end));
        if (gap < MIN_GAP && !(start >= exEnd || end <= exStart)) return true;
        // Also check if too close (even if not overlapping)
        if (start < exEnd + MIN_GAP && end > exStart - MIN_GAP) {
            // Allow if it's literally the same scene (e.g., replacing)
            if (tplScene.sceneIndex !== existing.sceneIndex) return true;
        }
    }

    return false;
}

// ============ TEMPLATE BACKGROUND DOWNLOADS ============

/**
 * Download background media for templates that need them (needsBackground: true).
 * Some template backgrounds should be moving video; item-driven templates like
 * personIntro still use image-only item thumbnails instead of a generic bg.
 * Saves to tempDir as tpl-bg-{index}.{ext}, sets templateBgFile on each template.
 *
 * @param {Array} templateScenes - Array of template scene objects
 * @param {string} tempDir - Temp directory path for downloads
 * @param {Object} scriptContext - Script context with themeId, nicheId, entities
 * @returns {number} Count of successfully downloaded backgrounds
 */
async function downloadTemplateBackgrounds(templateScenes, tempDir, scriptContext) {
    const path = require('path');
    const fs = require('fs');
    const config = require('../settings/config');

    const needsBg = templateScenes.filter(tpl => {
        const reg = TEMPLATE_REGISTRY[tpl.type];
        return reg && reg.needsBackground;
    });

    if (needsBg.length === 0) return 0;

    console.log(`  🖼️ Downloading background media for ${needsBg.length} template(s)...`);

    let downloaded = 0;
    const usedBgUrls = new Set();
    const usedBgHashes = new Map();
    const hashFile = (filePath) => crypto
        .createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');

    for (let i = 0; i < needsBg.length; i++) {
        const tpl = needsBg[i];

        // Build search query from template content
        const query = _buildBgSearchQuery(tpl, scriptContext);
        if (!query) continue;

        try {
            const candidates = await _searchBackgroundMedia(query, config, _getTemplateBackgroundMediaMode(tpl));
            if (candidates.length === 0) {
                console.log(`    ⚠️ No background found for "${query}"`);
                continue;
            }

            let saved = false;
            for (const media of candidates) {
                const urlKey = normalizeUrlForDedup(media.url || '');
                if (urlKey && usedBgUrls.has(urlKey)) {
                    console.log(`    ⚠️ Skipping duplicate background URL for "${query}"`);
                    continue;
                }

                const filename = `tpl-bg-${tpl.id || i}${media.ext}`;
                const outputPath = path.join(tempDir, filename);

                try {
                    const maxBytes = media.mediaType === 'video'
                        ? 2 * 1024 * 1024 * 1024
                        : 80 * 1024 * 1024;
                    const response = await requestSafeStream(media.url, {
                        timeout: media.mediaType === 'video' ? 60000 : 30000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    }, { maxRedirects: 5, maxBytes });

                    const contentType = response.headers['content-type'] || '';
                    const looksVideo = media.mediaType === 'video' && (contentType.includes('video') || /\.mp4(\?|$)/i.test(media.url));
                    const looksImage = media.mediaType === 'image' && contentType.includes('image');
                    if (!looksVideo && !looksImage) {
                        console.log(`    ⚠️ Non-${media.mediaType} response for "${query}": ${contentType}`);
                        continue;
                    }

                    const writer = fs.createWriteStream(outputPath);
                    const limiter = createByteLimitTransform(maxBytes);
                    response.data.pipe(limiter).pipe(writer);
                    limiter.on('error', (error) => writer.destroy(error));
                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });

                    // Validate file size
                    const minBytes = media.mediaType === 'video' ? 100000 : 10000;
                    const stat = fs.statSync(outputPath);
                    if (stat.size < minBytes) {
                        console.log(`    ⚠️ Background too small (${stat.size}B) for "${query}"`);
                        try { fs.unlinkSync(outputPath); } catch (e) {}
                        continue;
                    }

                    const mediaHash = hashFile(outputPath);
                    const duplicate = usedBgHashes.get(mediaHash);
                    if (duplicate) {
                        console.log(`    ⚠️ Duplicate template background for "${query}" (same as ${duplicate}); trying next candidate`);
                        try { fs.unlinkSync(outputPath); } catch (e) {}
                        continue;
                    }

                    // Vision + mismatch-penalty gate — mirror regular footage path.
                    // Template bg queries are heuristic (not Sonnet-built), so we must
                    // verify the downloaded media actually depicts the topic before
                    // accepting it. Threshold is mild (≥4): the bg sits behind the
                    // card chrome, so off-angle / wider context is fine; only reject
                    // obvious mismatches (wrong subject, decorative graphics, etc.).
                    const visionScore = await _scoreTemplateBackground(outputPath, media.ext, query, tpl, scriptContext);
                    if (visionScore != null && visionScore < 4) {
                        console.log(`    ⛔ Template bg vision-rejected (${visionScore}/10) for "${query}"; trying next candidate`);
                        try { fs.unlinkSync(outputPath); } catch (e) {}
                        continue;
                    }

                    tpl.templateBgFile = filename;
                    tpl.templateBgMediaType = media.mediaType;
                    if (urlKey) usedBgUrls.add(urlKey);
                    usedBgHashes.set(mediaHash, `${tpl.type}:${tpl.text || tpl.id || i}`);
                    downloaded++;
                    saved = true;
                    console.log(`    ✅ [${tpl.type}] "${tpl.text}" → ${filename} (${media.mediaType}, ${Math.round(stat.size / 1024)}KB)`);
                    break;
                } catch (downloadErr) {
                    console.log(`    ⚠️ ${media.mediaType} background download failed for "${query}": ${downloadErr.message}`);
                }
            }
            if (!saved) console.log(`    ⚠️ No usable background media saved for "${query}"`);

        } catch (e) {
            console.log(`    ⚠️ Background download failed for "${query}": ${e.message}`);
        }
    }

    return downloaded;
}

function _getTemplateBackgroundMediaMode(tpl) {
    const reg = TEMPLATE_REGISTRY[tpl.type];
    return reg?.backgroundMedia === 'image' ? 'image' : 'video';
}

// Lazy-imported so we don't create a circular dependency with footage-manager.
let _fmScoreDownloaded = null;
function _getTemplateScorer() {
    if (_fmScoreDownloaded === null) {
        try {
            const fm = require('../media/footage-manager');
            _fmScoreDownloaded = fm.scoreDownloadedMedia || false;
        } catch (_) {
            _fmScoreDownloaded = false;
        }
    }
    return _fmScoreDownloaded || null;
}

async function _scoreTemplateBackground(filePath, ext, query, tpl, scriptContext) {
    const scorer = _getTemplateScorer();
    if (!scorer) return null; // vision unavailable → fail-open
    try {
        const context = {
            sceneText: tpl?.text || tpl?.subText || '',
            videoTopic: scriptContext?.videoTitle || scriptContext?.summary || '',
            niche: scriptContext?.nicheId || '',
            theme: scriptContext?.themeId || '',
            entities: scriptContext?.entities || [],
            // No mediaHunter — templates accept softer/wider footage than strict-raw scenes.
        };
        const result = await scorer(filePath, ext, query, context);
        return result?.score ?? null;
    } catch (_) {
        return null;
    }
}

/**
 * Build a search query for template background media.
 */
function _buildBgSearchQuery(tpl, scriptContext) {
    if (tpl.bgQuery) return tpl.bgQuery;

    const text = (tpl.text || '').trim();
    const itemsText = Array.isArray(tpl.items) ? tpl.items.join(' ') : '';
    const combined = `${text} ${itemsText}`.trim();
    if (!combined) return null;

    switch (tpl.type) {
        case 'locationCard':
            // Location name → search for scenic/aerial photo
            return `${text} aerial view landscape`;
        case 'chapterCard': {
            // Chapter title → search for thematic image
            const entities = (scriptContext?.entities || []).slice(0, 2).join(' ');
            return entities ? `${entities} ${text}` : text;
        }
        case 'factCard': {
            // Fact panel → search for topic-related image
            const topicEntities = (scriptContext?.entities || []).slice(0, 2).join(' ');
            return topicEntities ? `${topicEntities} ${text}` : `${text} concept`;
        }
        case 'statCard': {
            const lower = combined.toLowerCase();
            if (/\btrade|shipping|barrel|oil|tanker|container|suez|red sea|hormuz|bab\b/.test(lower)) {
                return 'global maritime trade oil tanker shipping';
            }
            return `${combined} statistics infographic background`;
        }
        default:
            return combined;
    }
}

async function _searchBackgroundMedia(query, config, mode = 'video') {
    const candidates = [];

    // Most template backgrounds can look richer as subtle moving B-roll.
    // Image-only template systems (personIntro item portraits, split panels)
    // do not call this path; they use downloadTemplateItemImages instead.
    if (mode === 'video') {
        const videoUrl = await _searchBackgroundVideo(query, config);
        if (videoUrl) candidates.push({ url: videoUrl, mediaType: 'video', ext: '.mp4' });
    }

    const imageUrl = await _searchBackgroundImage(query, config);
    if (imageUrl) candidates.push({ url: imageUrl, mediaType: 'image', ext: '.jpg' });

    return candidates;
}

/**
 * Search for a background video using Storyblocks.
 * Returns direct MP4 URL or null.
 */
async function _searchBackgroundVideo(query, config) {
    try {
        const StoryblocksVideoProvider = require('../media/providers/storyblocks-video');
        const provider = new StoryblocksVideoProvider();
        if (!provider.isAvailable()) return null;
        const results = await provider.search(query);
        if (!results || results.length === 0) return null;
        const pick = results[0];
        return pick._directVideoUrl || pick.url || null;
    } catch (e) {
        return null;
    }
}

/**
 * Search for a background image using Storyblocks.
 * Returns direct image URL or null.
 */
async function _searchBackgroundImage(query, config) {
    try {
        const StoryblocksVideoProvider = require('../media/providers/storyblocks-video');
        const provider = new StoryblocksVideoProvider();
        if (!provider.isAvailable()) return null;
        const results = await provider.search(query);
        if (!results || results.length === 0) return null;
        const pick = results[0];
        return pick._directVideoUrl || pick.thumbnailUrl || pick.url || null;
    } catch (e) {
        return null;
    }
}

// ============ TEMPLATE ITEM IMAGE DOWNLOADS ============

/**
 * Download images for template items that need them (needsItemImages: true).
 * Used by imageShowcase — each item gets its own image via Storyblocks search.
 * Saves to tempDir as tpl-item-{id}-{idx}.jpg, sets _itemThumbnails on each template.
 *
 * @param {Array} templateScenes - Array of template scene objects
 * @param {string} tempDir - Temp directory path for downloads
 * @param {Object} scriptContext - Script context
 * @returns {number} Count of successfully downloaded images
 */
async function downloadTemplateItemImages(templateScenes, tempDir, scriptContext) {
    const path = require('path');
    const fs = require('fs');
    const config = require('../settings/config');

    const needsItems = templateScenes.filter(tpl => {
        const reg = TEMPLATE_REGISTRY[tpl.type];
        return reg && reg.needsItemImages && tpl.items && tpl.items.length > 0;
    });

    if (needsItems.length === 0) return 0;

    console.log(`  🖼️ Downloading item images for ${needsItems.length} template(s)...`);

    let downloaded = 0;

    for (const tpl of needsItems) {
        const reg = TEMPLATE_REGISTRY[tpl.type];
        const maxImages = reg.itemImageCount || tpl.items.length;
        const items = tpl.items.slice(0, maxImages);
        tpl._itemThumbnails = [];

        for (let i = 0; i < items.length; i++) {
            const item = typeof items[i] === 'string' ? items[i] : (items[i].text || items[i].event || '');
            if (!item) { tpl._itemThumbnails.push(null); continue; }

            const filename = `tpl-item-${tpl.id || 'x'}-${i}.jpg`;
            const outputPath = path.join(tempDir, filename);

            // Build search query from item description
            const query = item.length > 5 ? item : `${item} ${tpl.text || ''}`;

            try {
                const url = await _searchBackgroundImage(query, config);
                if (!url) {
                    console.log(`    ⚠️ No image found for item "${item}"`);
                    tpl._itemThumbnails.push(null);
                    continue;
                }

                const maxBytes = 80 * 1024 * 1024;
                const response = await requestSafeStream(url, {
                    timeout: 30000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                }, { maxRedirects: 5, maxBytes });

                const contentType = response.headers['content-type'] || '';
                if (!contentType.includes('image')) {
                    tpl._itemThumbnails.push(null);
                    continue;
                }

                const writer = fs.createWriteStream(outputPath);
                const limiter = createByteLimitTransform(maxBytes);
                response.data.pipe(limiter).pipe(writer);
                limiter.on('error', (error) => writer.destroy(error));
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                const stat = fs.statSync(outputPath);
                if (stat.size < 5000) {
                    try { fs.unlinkSync(outputPath); } catch (e) {}
                    tpl._itemThumbnails.push(null);
                    continue;
                }

                tpl._itemThumbnails.push(filename);
                downloaded++;
                console.log(`    ✅ [${tpl.type}] item ${i}: "${item}" → ${filename} (${Math.round(stat.size / 1024)}KB)`);

            } catch (e) {
                console.log(`    ⚠️ Item image download failed for "${item}": ${e.message}`);
                tpl._itemThumbnails.push(null);
            }
        }
    }

    return downloaded;
}

// ============ EXPORTS ============

module.exports = {
    processTemplates,
    downloadTemplateBackgrounds,
    downloadTemplateItemImages,
    TEMPLATE_TYPES,
    TEMPLATE_REGISTRY,
    // exported for the verify harness
    COVERAGE_TEMPLATE_LADDER,
    _pickCoverageTemplateType,
    _aiSelectTemplates,
};
