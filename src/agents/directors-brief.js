/**
 * Director's Brief Module
 *
 * Structured user input inspired by VidRush's Four-Pillar Framework.
 * Reads from environment variables and provides a clean, validated brief
 * that all pipeline steps can consume.
 *
 * Exports:
 *   createDirectorsBrief() — reads env vars, returns validated brief
 *   QUALITY_TIERS         — tier definitions for downstream steps
 */

const fs = require('fs');
const path = require('path');
const { getThemeIds } = require('../data/themes');
const { getNicheIds, resolvePreset, NICHE_PRESETS } = require('../data/niches');
const styleLearner = require('../studio/style-learner');

// ============================================================
// QUALITY TIER DEFINITIONS
// ============================================================

// NOTE: Scene density is higher than typical documentary because FACELESS VIDEOS
// need frequent B-roll cuts (every 3-7s) to keep viewers engaged.
const QUALITY_TIERS = {
    mini: {
        name: 'Mini (Fast)',
        mediaDefault: 'image',        // Images only by default
        allowVideo: false,             // Skip video providers
        maxMGs: 3,                     // Fewer motion graphics
        skipVisionAI: true,            // Skip vision analysis
        skipOverlays: true,            // Skip overlay downloads
        transitionRatio: 0,            // All cuts, no transitions
        sceneDensity: 5,               // Fast cuts: ~1 scene every 12s
    },
    standard: {
        name: 'Standard',
        mediaDefault: 'mixed',         // Video + image mix
        allowVideo: true,
        maxMGs: Infinity,              // No limit
        skipVisionAI: false,
        skipOverlays: false,
        transitionRatio: 0.3,          // 70/30 rule (30% transitions)
        sceneDensity: 4,               // Balanced: ~1 scene every 15s
    },
    pro: {
        name: 'Pro (Best)',
        mediaDefault: 'video',         // Video-heavy
        allowVideo: true,
        maxMGs: Infinity,
        skipVisionAI: false,
        skipOverlays: false,
        transitionRatio: 0.4,          // 60/40 (more transitions)
        sceneDensity: 3.5,             // Cinematic but frequent: ~1 scene every 17s
    }
};

// ============================================================
// CREATE DIRECTOR'S BRIEF
// ============================================================

/**
 * Create a validated Director's Brief from environment variables.
 * Falls back to sensible defaults for every field.
 *
 * Environment variables:
 *   AI_INSTRUCTIONS    — Free-text instructions (existing)
 *   BUILD_FORMAT       — 'auto' | 'documentary' | 'listicle'
 *   BUILD_QUALITY_TIER — 'mini' | 'standard' | 'pro'
 *   BUILD_AUDIENCE     — Optional target audience description
 *   BUILD_THEME        — 'auto' | 'crime' | 'history' | 'modern' | 'minimal' | 'standard' | 'warm-editorial' | 'luxury' | 'nature'
 *   BUILD_NICHE        — Preset key ('auto'|'trueCrime'|'documentary'|'finance'|...) or direct niche ID
 *   BUILD_RECIPE       — Optional genre recipe name (e.g., 'politics', 'tech', 'crime')
 *
 * @returns {DirectorsBrief}
 */
function createDirectorsBrief() {
    const freeInstructions = (process.env.AI_INSTRUCTIONS || '').trim();
    const rawFormat = (process.env.BUILD_FORMAT || 'auto').trim().toLowerCase();
    const rawTier = (process.env.BUILD_QUALITY_TIER || 'standard').trim().toLowerCase();
    const audienceHint = (process.env.BUILD_AUDIENCE || '').trim() || null;
    const rawTheme = (process.env.BUILD_THEME || 'auto').trim().toLowerCase();
    const recipeOverride = (process.env.BUILD_RECIPE || '').trim().toLowerCase() || null;
    const rawNiche = (process.env.BUILD_NICHE || 'auto').trim();

    // Validate format
    const validFormats = ['auto', 'documentary', 'listicle'];
    let format = validFormats.includes(rawFormat) ? rawFormat : 'auto';

    // Validate quality tier
    const validTiers = ['mini', 'standard', 'pro'];
    const qualityTier = validTiers.includes(rawTier) ? rawTier : 'standard';

    // Validate theme (auto = let AI decide, or specific theme ID)
    const validThemes = ['auto', ...getThemeIds()];
    const themeOverride = validThemes.includes(rawTheme) ? rawTheme : 'auto';

    // Resolve niche preset → niche ID + hints
    // BUILD_NICHE can be a preset key (e.g., "trueCrime", "finance") or a niche ID (e.g., "crime", "business")
    let nicheOverride = 'auto';
    let presetHints = { suggestedFormat: null, suggestedPacing: null };

    if (NICHE_PRESETS[rawNiche]) {
        // It's a preset key — resolve to niche ID + hints
        const resolved = resolvePreset(rawNiche);
        nicheOverride = resolved.nicheId || 'auto';
        presetHints = { suggestedFormat: resolved.suggestedFormat, suggestedPacing: resolved.suggestedPacing };
    } else {
        // Try as direct niche ID (backward compat)
        const validNiches = ['auto', ...getNicheIds()];
        nicheOverride = validNiches.includes(rawNiche.toLowerCase()) ? rawNiche.toLowerCase() : 'auto';
    }

    // Apply preset's suggested format if user hasn't explicitly set one
    if (format === 'auto' && presetHints.suggestedFormat) {
        format = presetHints.suggestedFormat;
    }

    // Production mode (orthogonal to format/niche): 'faceless' (default) vs 'talkingHead'.
    // In talkingHead mode a recurring presenter appears at a few high-value beats.
    // The presenter media is a swappable source — a static image now, a per-scene avatar
    // clip later — so we only resolve the image path here; selection/compositing is downstream.
    // Category registry resolves the mode (faceless | talkingHead).
    // Unknown/empty → faceless exactly like the old ternary.
    const productionMode = require('../categories').resolveMode(process.env.BUILD_PRODUCTION_MODE);
    console.log(`[DirectorsBrief] Production mode: ${productionMode}`);
    let presenter = null;
    if (productionMode === 'talkingHead') {
        const userImg = (process.env.BUILD_PRESENTER_IMAGE || '').trim();
        const placeholderPath = path.join(__dirname, '..', '..', 'assets', 'presenter-placeholder.png');
        let imageFile = null;
        let source = null;
        if (userImg && fs.existsSync(userImg)) {
            imageFile = userImg;
            source = 'user';
        } else {
            if (userImg) console.warn(`[DirectorsBrief] Presenter image not found: ${userImg} — falling back to placeholder`);
            if (fs.existsSync(placeholderPath)) {
                imageFile = placeholderPath;
                source = 'placeholder';
            }
        }
        if (imageFile) {
            presenter = { mode: 'static', imageFile, source };
            console.log(`[DirectorsBrief] Talking-head mode: presenter image (${source}) → ${imageFile}`);
        } else {
            console.warn('[DirectorsBrief] Talking-head mode requested but no presenter image or placeholder found — presenter inserts will be skipped (behaves as faceless).');
        }
    }

    const brief = {
        freeInstructions,
        format,
        qualityTier,
        audienceHint,
        themeOverride,  // 'auto' = niche.defaultTheme, or specific theme ID
        nicheOverride,  // 'auto' = AI detects from content, or specific niche ID
        recipeOverride, // explicit genre recipe name, or null for auto-detect
        presetPacing: presetHints.suggestedPacing, // hint for scene density, or null
        productionMode, // 'faceless' | 'talkingHead' (orthogonal production mode)
        presenter,      // { mode, imageFile, source } | null (talking-head presenter media)
        // Resolved tier config for easy access
        tier: QUALITY_TIERS[qualityTier],
        // Reference style profile (optional)
        styleProfile: null,
        styleBlock: ''
    };

    // Load reference style profile if BUILD_STYLE_PROFILE points to a .style.json
    const styleProfilePath = (process.env.BUILD_STYLE_PROFILE || '').trim();
    if (styleProfilePath && styleProfilePath !== 'none') {
        try {
            const profile = styleLearner.loadStyleProfile(styleProfilePath);
            if (profile) {
                brief.styleProfile = profile;
                brief.styleBlock = styleLearner.buildStyleBlock(profile);
                console.log(`[DirectorsBrief] Loaded reference style profile: "${profile.name || styleProfilePath}"`);
            } else {
                console.warn(`[DirectorsBrief] Style profile file not found: ${styleProfilePath}`);
            }
        } catch (e) {
            console.warn(`[DirectorsBrief] Failed to load style profile: ${e.message}`);
        }
    }

    return brief;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = { createDirectorsBrief, QUALITY_TIERS };
