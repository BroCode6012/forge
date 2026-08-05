/**
 * YTA Empire WEBGL - UI Application
 * FIXED: Playhead - freely draggable, can go to 0, doesn't disappear when panning
 */

// ========================================
// MG Style Themes — from src/themes.js design tokens
// ========================================
// MG_STYLES, THEME_FONTS, THEME_COLORS, getStyledThemeColors, getActiveThemeFonts,
// _resolveActiveTheme are defined in mg-theme-bridge.js (loaded before app.js)
// and shared with qa-studio.html so QA export clips match preview MGs exactly.
// ========================================

// ========================================
// MG Registry helpers — populate variant/animation dropdowns
// ========================================
function _resolveExplainerUrls(mgs) {
    if (!window.electronAPI?.getProjectInfo || !window.electronAPI?.getFileUrl) return;
    for (const mg of mgs) {
        if (mg.type === 'explainer' && mg.explainerImageFile && !mg._explainerImageUrl) {
            window.electronAPI.getProjectInfo().then(async (info) => {
                const imgPath = info.projectDir + '/public/' + mg.explainerImageFile;
                const url = await window.electronAPI.getFileUrl(imgPath);
                if (url) mg._explainerImageUrl = url;
            }).catch(() => {});
        }
    }
}

function _showExplainerControls(show, mg) {
    const scaleRow = document.getElementById('mg-explainer-img-scale-row');
    const shadowRow = document.getElementById('mg-explainer-shadow-row');
    if (!scaleRow) return;
    const display = show ? '' : 'none';
    scaleRow.style.display = display;
    shadowRow.style.display = display;
    if (show && mg) {
        const scaleEl = document.getElementById('mg-explainer-img-scale');
        const scaleVal = document.getElementById('mg-explainer-img-scale-val');
        const shadowEl = document.getElementById('mg-explainer-shadow');
        const imgSc = mg.explainerImgScale != null ? mg.explainerImgScale : 100;
        const shadow = mg.explainerShadow || 'medium';
        if (scaleEl) scaleEl.value = imgSc;
        if (scaleVal) scaleVal.textContent = imgSc + '%';
        if (shadowEl) shadowEl.value = shadow;
    }
}

// Filter Type dropdown to only show types in the same group (overlay↔overlay, fullscreen↔fullscreen)
// Listicle Templates group is always visible — they're a separate category
function _filterTypeDropdownByGroup(mgType) {
    const typeEl = document.getElementById('mg-type');
    if (!typeEl || !window._mgRegistry) return;
    const reg = window._mgRegistry.registry[mgType];
    const currentGroup = reg?.group || 'overlay';
    const isListicle = currentGroup === 'listicle';
    for (const optgroup of typeEl.querySelectorAll('optgroup')) {
        const groupLabel = optgroup.label.toLowerCase();
        const isListicleGroup = groupLabel.includes('listicle');
        const isOverlay = groupLabel.includes('overlay');
        // Listicle group always shown; when editing a listicle, hide overlay/fullscreen
        let show;
        if (isListicleGroup) {
            show = true; // always visible
        } else if (isListicle) {
            show = false; // editing listicle — hide overlay/fullscreen
        } else {
            show = (currentGroup === 'overlay' && isOverlay) || (currentGroup === 'fullscreen' && !isOverlay && !isListicleGroup);
        }
        for (const opt of optgroup.querySelectorAll('option')) {
            opt.disabled = !show;
            opt.style.display = show ? '' : 'none';
        }
    }
}

// Types with actual variant renderers implemented in MGRenderer._variantRenderers
const MG_TYPES_WITH_VARIANTS = new Set(['headline', 'lowerThird', 'callout', 'statCounter', 'typewriter', 'kineticText', 'explainer', 'listicleCounter', 'progressTracker', 'listicleGrid']);

// Listicle item types (overlay counters on LI track)
const LISTICLE_TYPES = new Set(['listicleCounter']);

// Listicle template types (fullscreen V3 — separate system from MGs, will grow over time)
const TEMPLATE_TYPES = new Set(['listicleGrid', 'chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'timelineCard', 'factCard', 'imageShowcase', 'statCard', 'personIntro']);

// Fields synced from QA Studio fixes into live state (crop, framing, QA flags)
const QA_SYNCABLE_FIELDS = [
    'cropTop', 'cropRight', 'cropBottom', 'cropLeft',
    'scale', 'posY', 'posX', 'framing', 'framingMode',
    'floatingBackground', 'floatingAnim', 'floatingShadow',
    'flagForReplacement', 'qaFixed', 'qaReplaced', 'qaFixReason', 'qaFixCount',
    'qaReason', 'qaReplacementKeyword', 'qaReplacementSource', 'qaReplacementDiagnosis',
    'keyword', 'searchKeyword', 'sourceHint', 'mediaType',
];

// ── Template Registry (UI-side) ──
// Single source of truth for per-type variants, animations, labels.
// Mirrors the build-pipeline TEMPLATE_REGISTRY in ai-templates.js.
// When adding a new template type: add entry here + TEMPLATE_TYPES above + index.html dropdown.
const TEMPLATE_REGISTRY = {
    listicleGrid:   { label: 'Listicle Overview',
        variants: { grid: 'Card Grid', strip: 'Strip', stack: 'Stack' },
        animations: { staggerSlide: 'Stagger Slide', cascade: 'Cascade', flipIn: 'Flip In' },
        defaultVariant: 'grid', defaultAnimation: 'staggerSlide' },
    chapterCard:    { label: 'Chapter Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', springScale: 'Spring Scale', wipeRight: 'Wipe Right' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    locationCard:   { label: 'Location Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', slideLeft: 'Slide Left' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    quoteCard:      { label: 'Quote Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', popUp: 'Pop Up' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    keyTakeaway:    { label: 'Key Takeaway',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', springScale: 'Spring Scale' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    comparisonCard: { label: 'Comparison Card',
        variants: { standard: 'Standard', split: 'Split', stacked: 'Stacked' },
        animations: { staggerSlide: 'Stagger Slide', flipIn: 'Flip In' },
        defaultVariant: 'standard', defaultAnimation: 'staggerSlide' },
    timelineCard:   { label: 'Timeline Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { staggerSlide: 'Stagger Slide', cascade: 'Cascade' },
        defaultVariant: 'standard', defaultAnimation: 'staggerSlide' },
    factCard:       { label: 'Fact Card',
        variants: { splitPanel: 'Split Panel', overlay: 'Overlay Card', sidebar: 'Sidebar', numbered: 'Numbered' },
        animations: { slideRight: 'Slide Right', fadeUp: 'Fade Up', staggerSlide: 'Stagger Slide' },
        defaultVariant: 'splitPanel', defaultAnimation: 'slideRight' },
    imageShowcase:  { label: 'Image Showcase',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { slideOpposite: 'Slide Opposite', fadeSlide: 'Fade Slide', springScale: 'Spring Scale' },
        defaultVariant: 'standard', defaultAnimation: 'slideOpposite' },
    statCard:       { label: 'Stat Card',
        variants: { sideBySide: 'Side by Side', stacked: 'Stacked', single: 'Single', triple: 'Triple' },
        animations: { countUp: 'Count Up', staggerSlide: 'Stagger Slide', fadeScale: 'Fade Scale' },
        defaultVariant: 'sideBySide', defaultAnimation: 'countUp' },
    personIntro:    { label: 'Person Intro',
        variants: { standard: 'Standard', cinematic: 'Cinematic', minimal: 'Minimal' },
        animations: { slideRight: 'Slide Right', fadeSlide: 'Fade Slide', springScale: 'Spring Scale' },
        defaultVariant: 'standard', defaultAnimation: 'slideRight' },
};

/**
 * Populate a <select> with options from a { value: label } map.
 * Preserves current value if it exists in the new options.
 */
function _populateTemplateDropdown(selectEl, optionsMap, currentValue, defaultValue) {
    if (!selectEl) return;
    const prev = currentValue || selectEl.value;
    selectEl.innerHTML = '';
    for (const [val, label] of Object.entries(optionsMap)) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        selectEl.appendChild(opt);
    }
    // Keep current value if still valid, otherwise use default
    selectEl.value = (prev && optionsMap[prev]) ? prev : (defaultValue || Object.keys(optionsMap)[0]);
}

function _populateMgVariantDropdown(mgType, currentSubType) {
    const row = document.getElementById('mg-subtype-row');
    const sel = document.getElementById('mg-subtype');
    if (!row || !sel || !window._mgRegistry) { if (row) row.style.display = 'none'; return; }

    // Only show variant dropdown for types that have actual variant renderers
    if (!MG_TYPES_WITH_VARIANTS.has(mgType)) { row.style.display = 'none'; return; }

    const types = window._mgRegistry.getTypesForCategory(mgType);
    if (types.length <= 1) { row.style.display = 'none'; return; }

    sel.innerHTML = '';
    for (const t of types) {
        const opt = document.createElement('option');
        opt.value = t.key;
        opt.textContent = t.label;
        sel.appendChild(opt);
    }
    sel.value = currentSubType || window._mgRegistry.registry[mgType]?.defaultType || types[0]?.key || '';
    row.style.display = '';
}

function _populateMgAnimationDropdown(mgType, currentAnimation) {
    const row = document.getElementById('mg-animation-row');
    const sel = document.getElementById('mg-animation');
    if (!row || !sel || !window._mgRegistry) { if (row) row.style.display = 'none'; return; }

    const anims = window._mgRegistry.getAnimationsForCategory(mgType);
    if (anims.length <= 1) { row.style.display = 'none'; return; }

    sel.innerHTML = '';
    for (const a of anims) {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
        sel.appendChild(opt);
    }
    sel.value = currentAnimation || anims[0] || '';
    row.style.display = '';
}

function _populateMgShellDropdown(mg) {
    const row = document.getElementById('mg-shell-row');
    const select = document.getElementById('mg-shell');
    const registry = window._graphicShells;
    if (!row || !select || !registry?.getGraphicShellRecipes) {
        if (row) row.style.display = 'none';
        return;
    }
    const recipes = registry.getGraphicShellRecipes();
    select.innerHTML = '';
    for (const recipe of recipes) {
        const option = document.createElement('option');
        option.value = recipe.id;
        option.textContent = recipe.label;
        option.title = recipe.description || '';
        select.appendChild(option);
    }
    const currentPreset = mg?.graphicShellManual === true
        ? String(mg?.graphicShell?.preset || '')
        : 'auto';
    if (currentPreset && recipes.some((recipe) => recipe.id === currentPreset)) {
        select.value = currentPreset;
    } else if (mg?.graphicShellManual === true) {
        const custom = document.createElement('option');
        custom.value = 'custom';
        custom.textContent = 'Custom (Agent/API)';
        custom.disabled = true;
        select.appendChild(custom);
        select.value = 'custom';
    } else {
        select.value = 'auto';
    }
    row.style.display = '';
}

function _applyManualGraphicShell(active, presetId) {
    const registry = window._graphicShells;
    if (!active || !registry?.getGraphicShellRecipes) return;
    if (presetId === 'auto') {
        _deleteMgField(active, 'graphicShell');
        _deleteMgField(active, 'graphicShellManual');
        if (active.mg.agenticComposition && typeof active.mg.agenticComposition === 'object') {
            delete active.mg.agenticComposition.shell;
            if (active.mg.agenticComposition.style) delete active.mg.agenticComposition.style.shell;
        }
        if (active.mg.mgData?.agenticComposition) {
            delete active.mg.mgData.agenticComposition.shell;
            if (active.mg.mgData.agenticComposition.style) {
                delete active.mg.mgData.agenticComposition.style.shell;
            }
        }
        return;
    }
    const recipe = registry.getGraphicShellRecipes().find((entry) => entry.id === presetId);
    if (!recipe?.shell) return;
    const shell = registry.normalizeGraphicShell({
        ...recipe.shell,
        preset: presetId,
        source: 'manual',
    }, {
        id: active.mg.id || active.mg.clipId,
        role: active.isScene ? 'fullscreen' : 'overlay',
        type: active.mg.type,
        text: active.mg.text,
        subtext: active.mg.subtext,
        items: active.mg.items || active.mg.mgData?.items || [],
        safeZone: active.mg.safeZone || active.mg.position,
        layout: active.mg.agenticComposition?.layout,
        textStrategy: active.mg.agenticComposition?.textStrategy,
        density: active.mg.agenticComposition?.density,
        manual: true,
    });
    _setMgField(active, 'graphicShell', shell);
    _setMgField(active, 'graphicShellManual', true);
    if (shell.surface !== 'none') {
        _setMgField(active, 'transparentBackground', false);
        if (
            active.mg.cardStyle === 'transparent'
            || active.mg.mgData?.cardStyle === 'transparent'
        ) {
            _setMgField(
                active,
                'cardStyle',
                shell.surface === 'outline'
                    ? 'outline'
                    : (shell.surface === 'soft' ? 'glass' : 'filled')
            );
        }
    }
    _setMgField(active, 'accentRuleVisible', shell.accent !== 'none');
    if (active.mg.agenticComposition && typeof active.mg.agenticComposition === 'object') {
        active.mg.agenticComposition.shell = { ...shell };
        active.mg.agenticComposition.style = {
            ...(active.mg.agenticComposition.style || {}),
            shell: { ...shell },
            accentRule: shell.accent !== 'none',
        };
    }
    if (active.mg.mgData?.agenticComposition) {
        active.mg.mgData.agenticComposition.shell = { ...shell };
        active.mg.mgData.agenticComposition.style = {
            ...(active.mg.mgData.agenticComposition.style || {}),
            shell: { ...shell },
            accentRule: shell.accent !== 'none',
        };
    }
}

// Show/hide listicle template settings and populate dropdowns
function _showListicleControls(mgType, mg) {
    const section = document.getElementById('mg-listicle-section');
    if (!section) return;

    const isListicle = LISTICLE_TYPES.has(mgType);
    section.style.display = isListicle ? '' : 'none';
    if (!isListicle) return;

    // Template dropdown — show variants for this listicle type
    const templateSel = document.getElementById('mg-listicle-template');
    if (templateSel && window._mgRegistry) {
        const types = window._mgRegistry.getTypesForCategory(mgType);
        templateSel.innerHTML = '';
        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t.key;
            opt.textContent = t.label;
            templateSel.appendChild(opt);
        }
        templateSel.value = mg?.subType || window._mgRegistry.registry[mgType]?.defaultType || '';
    }

    // Animation dropdown
    const animSel = document.getElementById('mg-listicle-anim');
    if (animSel && window._mgRegistry) {
        const anims = window._mgRegistry.getAnimationsForCategory(mgType);
        animSel.innerHTML = '';
        for (const a of anims) {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            animSel.appendChild(opt);
        }
        animSel.value = mg?.animation || anims[0] || '';
    }

    // Number field — show for counter/tracker, hide for grid
    const numberRow = document.getElementById('mg-listicle-number-row');
    if (numberRow) numberRow.style.display = mgType === 'listicleGrid' ? 'none' : '';
    const numberEl = document.getElementById('mg-listicle-number');
    if (numberEl && mg) {
        if (mgType === 'listicleCounter') numberEl.value = mg.text || '';
        else if (mgType === 'progressTracker') numberEl.value = mg.text || '';
    }

    // Items field — show for grid, hide for counter/tracker
    const itemsRow = document.getElementById('mg-listicle-items-row');
    if (itemsRow) itemsRow.style.display = mgType === 'listicleGrid' ? '' : 'none';
    const itemsEl = document.getElementById('mg-listicle-items');
    if (itemsEl && mg) {
        const itemCount = mg._listicleItems?.length || (mg.subtext || '').split(',').filter(Boolean).length || 5;
        itemsEl.value = itemCount;
    }

    // Background
    const bgSel = document.getElementById('mg-listicle-bg');
    if (bgSel && mg) bgSel.value = mg.mgBackground || 'auto';
}

const DEFAULT_MG_OVERLAY_SHADOW = 0.55;

function _clampMgOverlayShadow(value) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return DEFAULT_MG_OVERLAY_SHADOW;
    return Math.max(0, Math.min(1, parsed));
}

function _syncMgShadowUI(value) {
    const shadow = _clampMgOverlayShadow(value);
    const slider = document.getElementById('mg-global-shadow');
    const label = document.getElementById('mg-global-shadow-val');
    if (slider) slider.value = shadow.toFixed(2);
    if (label) label.textContent = `${Math.round(shadow * 100)}%`;
}

function _setGlobalMgOverlayShadow(value) {
    const shadow = _clampMgOverlayShadow(value);
    state.mgOverlayShadow = shadow;
    _syncMgShadowUI(shadow);

    for (const mg of (state.motionGraphics || [])) {
        mg.overlayShadowStrength = shadow;
        if (mg.mgData) mg.mgData.overlayShadowStrength = shadow;
    }

    if (state.videoPlan) {
        if (!state.videoPlan.scriptContext) state.videoPlan.scriptContext = {};
        state.videoPlan.scriptContext.mgOverlayShadow = shadow;
    }
    if (state.compositor?._scriptContext) {
        state.compositor._scriptContext.mgOverlayShadow = shadow;
    }
}

function _hydrateMgOverlayShadow(plan) {
    const scriptShadow = plan?.scriptContext?.mgOverlayShadow;
    const firstMgShadow = (plan?.motionGraphics || []).find(mg => mg?.overlayShadowStrength != null)?.overlayShadowStrength;
    _setGlobalMgOverlayShadow(scriptShadow != null ? scriptShadow : firstMgShadow);
}

function _getActiveMgCategoryOverride(mgType) {
    const activeTheme = (typeof _resolveActiveTheme === 'function' && _resolveActiveTheme())
        || state.videoPlan?.scriptContext?.themeId
        || null;
    if (!activeTheme || !window._themeTokens?.getTokens) return null;
    try {
        return window._themeTokens.getTokens(activeTheme)?.chrome?.mgOverrides?.[mgType] || null;
    } catch (_err) {
        return null;
    }
}

function _setMgField(active, key, value) {
    active.mg[key] = value;
    if (active.mg.mgData) active.mg.mgData[key] = value;
}

function _deleteMgField(active, key) {
    delete active.mg[key];
    if (active.mg.mgData) delete active.mg.mgData[key];
}

function _applyManualMgStyle(active, style) {
    _setMgField(active, 'style', style);
    _setMgField(active, 'styleManual', true);

    const themeOverride = _getActiveMgCategoryOverride(active.mg.type);
    if (themeOverride?.style && !active.mg.variantManual && active.mg.subType === themeOverride.style) {
        _deleteMgField(active, 'subType');
        _populateMgVariantDropdown(active.mg.type, null);
    }
    if (themeOverride?.anim && !active.mg.animationManual && active.mg.animation === themeOverride.anim) {
        _deleteMgField(active, 'animation');
        _populateMgAnimationDropdown(active.mg.type, null);
    }
}

// THEME_FONTS, THEME_COLORS — defined in mg-theme-bridge.js

// getStyledThemeColors, _resolveActiveTheme — defined in mg-theme-bridge.js

/**
 * Populate the #build-language dropdown from the language registry.
 * Called during init. The "Auto-Detect" option is already in the HTML — this
 * appends supported languages below it. Adding a language to src/languages.js
 * will automatically appear here on next app reload, no HTML edit required.
 */
function populateLanguageDropdown() {
    const sel = document.getElementById('build-language');
    if (!sel) return;
    if (!window._languages?.getLanguageList) {
        console.warn('Language registry not available — dropdown will only show Auto-Detect');
        return;
    }
    const list = window._languages.getLanguageList();
    for (const lang of list) {
        const opt = document.createElement('option');
        opt.value = lang.code;
        // Show "English" for en, "Korean (한국어)" for non-English to make it easy to find
        opt.textContent = lang.code === 'en' ? lang.name : `${lang.name} (${lang.nativeName})`;
        sel.appendChild(opt);
    }
}

// getActiveThemeFonts — defined in mg-theme-bridge.js

function getActiveThemeColors() {
    const activeTheme = _resolveActiveTheme();
    if (!activeTheme || !THEME_COLORS[activeTheme]) return null;
    return THEME_COLORS[activeTheme];
}

/**
 * Get full design tokens for the active theme.
 * Returns null if no theme is active or tokens unavailable.
 */
function getActiveThemeTokens() {
    const activeTheme = _resolveActiveTheme();
    if (!activeTheme || !window._themeTokens) return null;
    return window._themeTokens.getTokens(activeTheme);
}

function parseKeyValuePairs(subtext) {
    if (!subtext || subtext === 'none') return [];
    const raw = subtext.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const part of raw) {
        const colonIdx = part.indexOf(':');
        if (colonIdx !== -1) {
            // New key:value pair
            results.push({ label: part.substring(0, colonIdx).trim(), value: part.substring(colonIdx + 1).trim() });
        } else if (results.length > 0 && /^\d+$/.test(part.trim())) {
            // Orphaned numeric fragment (e.g. "000" from "900,000") — merge back into previous value
            results[results.length - 1].value += ',' + part.trim();
        } else if (part.trim()) {
            results.push({ label: part.trim(), value: '0' });
        }
    }
    return results;
}

// ========================================
// State Management
// ========================================
const state = {
    audioFile: null,
    audioPath: null,
    scenes: [],
    isProcessing: false,
    videoPlan: null,
    hasProjectFile: false, // True once a .fvp file exists (enables auto-save)
    projectRevision: 0,
    projectPlanHash: null,
    projectHydrating: false, // Suppress settings-driven saves while loading/reconciling the authoritative plan.
    hasProject: false, // True when this window booted with a real project (not the default workspace). Audio import is gated on it.
    currentSceneIndex: 0,
    activeSceneIndices: [], // Active media scene indices (non-overlay, non-MG)
    activeOverlaySceneIndices: [], // Active overlay scene indices
    _mediaUrlCache: {}, // Cache: sceneIndex+ext → mediaUrl (avoids repeated IPC calls)
    _assetVersions: {}, // sceneIndex → version token; bumped after a Retry so the swapped file's URL changes (cache-bust)
    _trackActiveEl: { '1': 'a', '2': 'a', '3': 'a' }, // Double-buffer: which element ('a' or 'b') is active per track
    _trackSwapPending: { '1': false, '2': false, '3': false }, // Per-track: deferred swap in progress
    _trackLastHardSyncMs: { '1': 0, '2': 0, '3': 0 }, // Last forced seek time per track (prevents seek thrash)
    _lastPreloadCheck: 0, // Throttle preload checks
    _sceneLoadPending: false, // True while loadActiveScenes is running
    isPlaying: false,
    playbackStarting: false,
    playbackStartRequest: 0,
    playbackClockFloor: 0,
    playbackClockGuardUntil: 0,
    currentTime: 0,
    totalDuration: 0,
    playbackAnimationFrame: null,
    playbackTimer: null,
    lastPlaybackTime: 0,
    snapEnabled: true,
    snapThreshold: 10, // pixels
    // Undo/Redo history
    undoStack: [],
    redoStack: [],
    maxUndoLevels: 50,
    // Clipboard for copy/paste
    clipboard: null,
    selectedClipIndex: -1,
    selectedClipIndices: [], // Multi-select: array of selected clip indices
    selectedMgIndex: -1, // Selected motion graphic index
    selectedTransitionIndex: -1,
    transitions: [],
    // Audio clip offset (for dragging audio along timeline)
    audioClipOffset: 0,
    audioClipTrack: 'audio-track',
    // Preview zoom ('fit' or number like 25, 50, 100, 200)
    previewZoom: 'fit',
    // Transition system — legacy WebGL2 preview only; 'auto' defers to the AI transition-director (the final HyperFrames render owns transitions)
    transition: {
        style: 'auto',
        duration: 0.5,
        isTransitioning: false,
        activeVideoIndex: 0,
        types: ['crossfade', 'fade', 'wipe', 'slide', 'dissolve'],
        metadata: { cut: { name: 'Cut', icon: '✂', description: 'Instant cut' }, crossfade: { name: 'Crossfade', icon: '🔀' }, fade: { name: 'Fade', icon: '🔀' }, wipe: { name: 'Wipe', icon: '🔀' } }
    },
    volume: 1,
    isMuted: false,
    mutedTracks: {}, // { 'video-track-1': true, 'audio-track': true, ... }
    // Available overlays scanned from assets/overlays/
    availableOverlays: [], // [{ filename, name, ext, mediaType, size, path }]
    // Available backgrounds scanned from assets/backgrounds/
    availableBackgrounds: [], // [{ filename, name, ext, mediaType, size, path }]
    // SFX track authored by the build Sound Designer
    sfxClips: [],
    _sfxAudioPool: [],
    // Motion Graphics system - AI-placed text overlays
    motionGraphics: [],
    mgEnabled: true,
    subtitlesEnabled: false,
    mgStyle: 'clean',
    mgOverlayShadow: DEFAULT_MG_OVERLAY_SHADOW,
    aiInstructions: '',
    videoTitle: '',
    timeline: {
        zoom: 50,
        scrollX: 0,
        minZoom: 0.5,
        maxZoom: 200,
        rulerSecondsOnly: false, // when true, show raw seconds (matches log timestamps) instead of M:SS
        isDraggingPlayhead: false,
        tracks: [
            { id: 'video-track-5', label: 'V5', type: 'video' },
            { id: 'video-track-4', label: 'V4', type: 'video' },
            { id: 'video-track-3', label: 'V3', type: 'video' },
            { id: 'video-track-2', label: 'V2', type: 'video' },
            { id: 'video-track-1', label: 'V1', type: 'video', main: true },
            { id: 'mg-track', label: 'MG', type: 'graphics' },
            { id: 'listicle-track', label: 'LI', type: 'listicle' },
            { id: 'audio-track', label: 'VO', type: 'audio' },
            { id: 'sfx-track', label: 'SFX', type: 'audio' }
        ],
        trackHeights: {
            'video-track-5': 28, 'video-track-4': 28, 'video-track-3': 28, 'video-track-2': 28, 'video-track-1': 40,
            'mg-track': 32, 'listicle-track': 28,
            'audio-track': 36, 'sfx-track': 22
        },
        trackMinHeights: {
            'video-track-5': 22, 'video-track-4': 22, 'video-track-3': 22, 'video-track-2': 22, 'video-track-1': 28,
            'mg-track': 22, 'listicle-track': 20,
            'audio-track': 26, 'sfx-track': 18
        },
        trackMaxHeights: {
            'video-track-5': 120, 'video-track-4': 120, 'video-track-3': 120, 'video-track-2': 120, 'video-track-1': 120,
            'mg-track': 80, 'listicle-track': 60,
            'audio-track': 80, 'sfx-track': 60
        }
    },
    // In/Out point for partial rendering (Premiere-style)
    inPoint: null,              // seconds (null = start of timeline)
    outPoint: null,             // seconds (null = end of timeline)
    // WebGL2 Compositor Engine state
    compositor: null,           // Compositor instance
    compositorActive: false,    // Whether compositor preview is active
    // HyperFrames preview state (uses the same generated HTML as final render)
    hyperframesPreview: {
        active: false,
        loading: false,
        projectDir: null,
        indexPath: null,
        signature: '',
        refreshTimer: null,
        frameReady: false,
        pendingRefresh: false,
        pendingRefreshOptions: null,
        navigationSerial: 0,
        readyToken: '',
    },
};

const TRACK_HEADER_WIDTH = 100;
const timelineContract = window.YtaTimelineContract;
let _clipIdSequence = 0;

function normalizePlanForEditor(plan) {
    if (!plan || typeof plan !== 'object') return plan;
    if (timelineContract?.normalizePlan) return timelineContract.normalizePlan(plan);
    return plan;
}

function getSceneSourceIndex(scene, fallbackIndex = 0) {
    if (timelineContract?.resolveSourceSceneIndex) {
        return timelineContract.resolveSourceSceneIndex(scene, fallbackIndex);
    }
    return scene?.sourceSceneIndex ?? scene?.index ?? fallbackIndex;
}

function getSceneTiming(scene, fallbackDuration = 3) {
    const fps = state.videoPlan?.fps || state.fps || 30;
    if (timelineContract?.normalizeTiming) {
        return timelineContract.normalizeTiming(scene, {
            fps,
            totalDuration: state.totalDuration || state.videoPlan?.totalDuration,
            fallbackDuration,
        });
    }
    const startTime = Number(scene?.startTime) || 0;
    const endTime = Number(scene?.endTime) > startTime
        ? Number(scene.endTime)
        : startTime + (Number(scene?.duration) || fallbackDuration);
    const duration = endTime - startTime;
    return {
        startTime,
        endTime,
        duration,
        durationFrames: Math.max(1, Math.round(duration * fps)),
        durationUnit: 'seconds',
    };
}

function hydratePlanTransitions(plan, scenes = state.scenes) {
    const mediaScenes = (scenes || []).filter((scene) => scene && !scene.isMGScene);
    const byClipId = new Map();
    const bySourceIndex = new Map();
    mediaScenes.forEach((scene, fallbackIndex) => {
        if (scene.clipId) byClipId.set(String(scene.clipId), scene);
        const sourceIndex = String(getSceneSourceIndex(scene, fallbackIndex));
        if (!bySourceIndex.has(sourceIndex)) bySourceIndex.set(sourceIndex, []);
        bySourceIndex.get(sourceIndex).push(scene);
    });

    const resolveScene = (clipId, sourceIndex) => {
        if (clipId && byClipId.has(String(clipId))) return byClipId.get(String(clipId));
        if (sourceIndex == null || sourceIndex === '') return null;
        const matches = bySourceIndex.get(String(sourceIndex)) || [];
        return matches.length === 1 ? matches[0] : null;
    };
    const lane = (Array.isArray(plan?.transitions) ? plan.transitions : [])
        .filter((transition) => transition && typeof transition === 'object')
        .map((transition) => {
            const copy = JSON.parse(JSON.stringify(transition));
            let fromScene = resolveScene(copy.fromClipId, copy.fromSceneIndex);
            let toScene = resolveScene(copy.toClipId, copy.toSceneIndex);
            const boundary = Number(copy.startTime ?? copy.at);
            if ((!fromScene || !toScene) && Number.isFinite(boundary)) {
                for (const candidate of mediaScenes) {
                    if (!fromScene && Math.abs((Number(candidate.endTime) || 0) - boundary) < 0.08) {
                        fromScene = candidate;
                    }
                    if (!toScene && Math.abs((Number(candidate.startTime) || 0) - boundary) < 0.08) {
                        toScene = candidate;
                    }
                }
            }
            if (fromScene) {
                copy.fromClipId = fromScene.clipId;
                copy.fromSceneIndex = getSceneSourceIndex(fromScene, mediaScenes.indexOf(fromScene));
            }
            if (toScene) {
                copy.toClipId = toScene.clipId;
                copy.toSceneIndex = getSceneSourceIndex(toScene, mediaScenes.indexOf(toScene));
            }
            if (!Number.isFinite(Number(copy.startTime)) && toScene) {
                copy.startTime = Number(toScene.startTime) || 0;
            }
            return copy;
        });

    // Older projects sometimes kept the incoming transition only on the scene.
    // Reconstruct those missing lane entries once so subsequent saves preserve a
    // complete transition contract for preview, Agent edits, and undo/redo.
    const existingBoundaries = new Set(lane.map((transition) => (
        transition.fromClipId && transition.toClipId
            ? `${transition.fromClipId}->${transition.toClipId}`
            : `@${Number(transition.startTime ?? transition.at).toFixed(3)}`
    )));
    const byTrack = new Map();
    mediaScenes.forEach((scene) => {
        const trackId = scene.trackId || 'video-track-1';
        if (!byTrack.has(trackId)) byTrack.set(trackId, []);
        byTrack.get(trackId).push(scene);
    });
    for (const trackScenes of byTrack.values()) {
        trackScenes.sort((a, b) => Number(a.startTime) - Number(b.startTime));
        for (let index = 1; index < trackScenes.length; index++) {
            const fromScene = trackScenes[index - 1];
            const toScene = trackScenes[index];
            if (Math.abs((Number(fromScene.endTime) || 0) - (Number(toScene.startTime) || 0)) > 0.08) continue;
            const key = `${fromScene.clipId}->${toScene.clipId}`;
            if (existingBoundaries.has(key)) continue;
            const transitionObject = toScene.transition && typeof toScene.transition === 'object'
                ? toScene.transition
                : null;
            const type = toScene.transitionIn
                || transitionObject?.type
                || (typeof toScene.transition === 'string' ? toScene.transition : '')
                || toScene.transitionType;
            if (!type) continue;
            lane.push({
                fromClipId: fromScene.clipId,
                toClipId: toScene.clipId,
                fromSceneIndex: getSceneSourceIndex(fromScene, mediaScenes.indexOf(fromScene)),
                toSceneIndex: getSceneSourceIndex(toScene, mediaScenes.indexOf(toScene)),
                startTime: Number(toScene.startTime) || 0,
                type,
                duration: String(type).toLowerCase() === 'cut'
                    ? 0
                    : Math.max(0, Number(transitionObject?.duration ?? toScene.transitionDuration) || 0.5),
            });
            existingBoundaries.add(key);
        }
    }

    state.transitions = lane;
    if (state.videoPlan) {
        state.videoPlan.transitions = JSON.parse(JSON.stringify(lane));
    }
    if (state.selectedTransitionIndex >= lane.length) state.selectedTransitionIndex = -1;
    return lane;
}

function createUniqueClipId(scene, prefix = 'clip') {
    const source = timelineContract?.safeToken
        ? timelineContract.safeToken(getSceneSourceIndex(scene, 'source'), 'source')
        : String(getSceneSourceIndex(scene, 'source')).replace(/[^a-zA-Z0-9._-]+/g, '-');
    let candidate;
    do {
        const entropy = window.crypto?.randomUUID
            ? window.crypto.randomUUID()
            : `${Date.now().toString(36)}-${(++_clipIdSequence).toString(36)}`;
        candidate = `${prefix}-${source}-${entropy}`;
    } while (state.scenes.some((item) => item?.clipId === candidate));
    return candidate;
}

function notifyAgentContextChanged() {
    window.dispatchEvent(new CustomEvent('yta:agent-context-changed'));
}

const AGENT_SCOPE_MODES = new Set(['selection', 'scene', 'project']);
let agentScopeMode = 'selection';
try {
    const savedAgentScopeMode = window.localStorage?.getItem('yta.editorAgent.scopeMode');
    if (AGENT_SCOPE_MODES.has(savedAgentScopeMode)) agentScopeMode = savedAgentScopeMode;
} catch (_) { }

function setAgentScopeMode(value) {
    const next = AGENT_SCOPE_MODES.has(value) ? value : 'selection';
    if (agentScopeMode === next) return;
    agentScopeMode = next;
    try {
        window.localStorage?.setItem('yta.editorAgent.scopeMode', next);
    } catch (_) { }
    notifyAgentContextChanged();
}

function _agentClipRef(scene, index) {
    const timing = getSceneTiming(scene);
    return {
        clipId: scene?.clipId || `scene-${getSceneSourceIndex(scene, index)}-${Math.round(timing.startTime * 1000)}`,
        sourceSceneIndex: getSceneSourceIndex(scene, index),
        trackId: scene?.trackId || 'video-track-1',
        startTime: timing.startTime,
        endTime: timing.endTime,
        text: String(scene?.text || '').slice(0, 1500),
        keyword: String(scene?.keyword || scene?.searchKeyword || '').slice(0, 500),
        mediaType: scene?.mediaType || '',
    };
}

function _agentVisualRef(visual, index, collection = '') {
    const timing = getSceneTiming(visual, 3);
    return {
        id: visual?.id || visual?.clipId || `visual-${index}-${Math.round(timing.startTime * 1000)}`,
        type: visual?.type || visual?.templateType || 'motion-graphic',
        collection,
        collectionIndex: index,
        trackId: visual?.trackId || 'video-track-3',
        startTime: timing.startTime,
        endTime: timing.endTime,
        sourceClipId: String(visual?.sourceClipId || ''),
        sourceSceneIndex: Number.isFinite(Number(visual?.sourceSceneIndex))
            ? Number(visual.sourceSceneIndex)
            : null,
        sceneIndex: Number.isFinite(Number(visual?.sceneIndex))
            ? Number(visual.sceneIndex)
            : null,
        label: String(visual?.text || visual?.keyword || visual?.type || 'Motion graphic').slice(0, 500),
    };
}

function _agentIconRef(scene, sceneIndex, moment, momentIndex) {
    const timing = getSceneTiming(scene);
    const at = Math.max(0, Number(moment?.at) || 0);
    const duration = Math.max(0.05, Number(moment?.dur ?? moment?.duration) || 2);
    const clipId = String(
        scene?.clipId
        || `scene-${getSceneSourceIndex(scene, sceneIndex)}-${Math.round(timing.startTime * 1000)}`
    );
    return {
        id: `${clipId}:icon:${momentIndex}`,
        clipId,
        sourceSceneIndex: getSceneSourceIndex(scene, sceneIndex),
        sceneIndex,
        momentIndex,
        kind: String(moment?.kind || 'icon'),
        label: String(
            moment?.concept
            || moment?.label
            || moment?.keyword
            || moment?.query
            || moment?.kind
            || 'Scene icon'
        ).slice(0, 500),
        position: String(moment?.position || 'top-right'),
        color: String(moment?.color || ''),
        scale: Number.isFinite(Number(moment?.scale)) ? Number(moment.scale) : 1,
        startTime: timing.startTime + at,
        endTime: Math.min(timing.endTime, timing.startTime + at + duration),
    };
}

function _agentIconRefsForScene(scene, sceneIndex) {
    return (Array.isArray(scene?._iconMoments) ? scene._iconMoments : [])
        .map((moment, momentIndex) => _agentIconRef(scene, sceneIndex, moment, momentIndex));
}

function _agentVisualEntries() {
    const entries = [];
    const seen = new Set();
    const add = (visual, collection, index) => {
        if (!visual || visual.disabled === true) return;
        const timing = getSceneTiming(visual, collection === 'templateScenes' ? 4 : 3);
        const id = String(visual.id || visual.clipId || '');
        const key = id
            ? `id:${id}`
            : `${collection}:${visual.type || visual.templateType || 'visual'}:${timing.startTime.toFixed(3)}:${timing.endTime.toFixed(3)}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ visual, collection, index });
    };

    (state.motionGraphics || []).forEach((visual, index) => add(visual, 'motionGraphics', index));
    (state.scenes || []).forEach((visual, index) => {
        if (!visual?.isMGScene) return;
        add(visual, visual.templateType ? 'templateScenes' : 'mgScenes', index);
    });
    for (const collection of ['motionGraphics', 'mgScenes', 'templateScenes']) {
        (state.videoPlan?.[collection] || []).forEach((visual, index) => add(visual, collection, index));
    }
    return entries;
}

function _agentVisualBelongsToScene(visual, scene, sceneIndex) {
    if (!visual || !scene) return false;
    const clipId = String(scene.clipId || '');
    if (clipId && String(visual.sourceClipId || '') === clipId) return true;

    const sourceSceneIndex = Number(getSceneSourceIndex(scene, sceneIndex));
    const visualIndexes = [visual.sourceSceneIndex, visual.sceneIndex]
        .map(Number)
        .filter(Number.isFinite);
    if (visualIndexes.some((index) => (
        index === sourceSceneIndex
        || index === Number(scene.index)
        || index === sceneIndex
    ))) return true;

    const sceneTiming = getSceneTiming(scene);
    const visualTiming = getSceneTiming(visual, visual.templateType ? 4 : 3);
    return visualTiming.endTime > sceneTiming.startTime + 0.001
        && visualTiming.startTime < sceneTiming.endTime - 0.001;
}

function _agentOwningSceneIndex(visual) {
    if (!visual) return -1;
    const sourceClipId = String(visual.sourceClipId || '');
    if (sourceClipId) {
        const byClip = state.scenes.findIndex((scene) => (
            scene && !scene.isMGScene && String(scene.clipId || '') === sourceClipId
        ));
        if (byClip >= 0) return byClip;
    }

    const visualIndexes = [visual.sourceSceneIndex, visual.sceneIndex]
        .map(Number)
        .filter(Number.isFinite);
    for (let index = 0; index < state.scenes.length; index++) {
        const scene = state.scenes[index];
        if (!scene || scene.isMGScene) continue;
        const sourceSceneIndex = Number(getSceneSourceIndex(scene, index));
        if (visualIndexes.some((candidate) => (
            candidate === sourceSceneIndex
            || candidate === Number(scene.index)
            || candidate === index
        ))) return index;
    }

    const timing = getSceneTiming(visual, visual.templateType ? 4 : 3);
    const midpoint = timing.startTime + Math.max(0, timing.endTime - timing.startTime) / 2;
    return state.scenes.findIndex((scene) => {
        if (!scene || scene.isMGScene) return false;
        const sceneTiming = getSceneTiming(scene);
        return sceneTiming.startTime <= midpoint && sceneTiming.endTime > midpoint;
    });
}

function _agentSceneIndexesForWholeScene() {
    const selected = [];
    const add = (index) => {
        if (!Number.isInteger(index) || index < 0 || index >= state.scenes.length) return;
        const scene = state.scenes[index];
        if (!scene || scene.isMGScene || selected.includes(index)) return;
        selected.push(index);
    };

    if (state.selectedTransitionIndex >= 0 && state.transitions?.[state.selectedTransitionIndex]) {
        const transition = state.transitions[state.selectedTransitionIndex];
        const ids = new Set([
            String(transition.fromClipId || ''),
            String(transition.toClipId || ''),
        ].filter(Boolean));
        state.scenes.forEach((scene, index) => {
            if (scene && !scene.isMGScene && ids.has(String(scene.clipId || ''))) add(index);
        });
        if (selected.length) return selected;
    }

    if (state.selectedMgIndex >= 0 && state.motionGraphics?.[state.selectedMgIndex]) {
        add(_agentOwningSceneIndex(state.motionGraphics[state.selectedMgIndex]));
        if (selected.length) return selected;
    }

    for (const index of [...new Set(state.selectedClipIndices || [])]) {
        const scene = state.scenes[index];
        if (scene?.isMGScene) add(_agentOwningSceneIndex(scene));
        else add(index);
    }
    if (selected.length) return selected;

    if (state.inPoint !== null || state.outPoint !== null) {
        const fromSec = state.inPoint !== null ? state.inPoint : 0;
        const toSec = state.outPoint !== null ? state.outPoint : state.totalDuration;
        state.scenes.forEach((scene, index) => {
            if (!scene || scene.isMGScene) return;
            const timing = getSceneTiming(scene);
            if (timing.endTime > fromSec + 0.001 && timing.startTime < toSec - 0.001) add(index);
        });
        if (selected.length) return selected;
    }

    const playheadIndex = state.scenes.findIndex((scene) => {
        if (!scene || scene.isMGScene) return false;
        const timing = getSceneTiming(scene);
        return timing.startTime <= state.currentTime && timing.endTime > state.currentTime;
    });
    add(playheadIndex);
    if (!selected.length) add(state.currentSceneIndex);
    return selected;
}

function _agentRefsAreContiguous(refs) {
    if (refs.length < 2) return true;
    const sorted = [...refs].sort((a, b) => a.startTime - b.startTime);
    return sorted.every((ref, index) => index === 0 || ref.startTime <= sorted[index - 1].endTime + 0.05);
}

function _agentProjectScope() {
    return {
        kind: 'project',
        scopeMode: 'project',
        label: 'Whole project',
        fromSec: 0,
        toSec: state.totalDuration,
        currentTime: state.currentTime,
        totalDuration: state.totalDuration,
        contiguous: true,
        clipRefs: [],
        visualRefs: [],
        iconRefs: [],
    };
}

function _agentWholeSceneScope() {
    const indexes = _agentSceneIndexesForWholeScene();
    if (!indexes.length) return _agentProjectScope();

    const clipRefs = indexes.map((index) => _agentClipRef(state.scenes[index], index));
    const visualRefs = _agentVisualEntries()
        .filter(({ visual }) => indexes.some((sceneIndex) => (
            _agentVisualBelongsToScene(visual, state.scenes[sceneIndex], sceneIndex)
        )))
        .map(({ visual, collection, index }) => _agentVisualRef(visual, index, collection));
    const iconRefs = indexes.flatMap((index) => _agentIconRefsForScene(state.scenes[index], index));
    const sceneLabel = indexes.length === 1 ? 'Whole scene' : `${indexes.length} whole scenes`;
    const layers = [
        `${clipRefs.length} clip${clipRefs.length === 1 ? '' : 's'}`,
        visualRefs.length ? `${visualRefs.length} graphic${visualRefs.length === 1 ? '' : 's'}` : '',
        iconRefs.length ? `${iconRefs.length} icon${iconRefs.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' · ');
    return {
        kind: 'clips',
        scopeMode: 'scene',
        label: `${sceneLabel} · ${layers}`,
        fromSec: Math.min(...clipRefs.map((ref) => ref.startTime)),
        toSec: Math.max(...clipRefs.map((ref) => ref.endTime)),
        currentTime: state.currentTime,
        totalDuration: state.totalDuration,
        contiguous: _agentRefsAreContiguous(clipRefs),
        clipRefs,
        visualRefs,
        iconRefs,
    };
}

function getAgentScopeSnapshot() {
    if (agentScopeMode === 'project') return _agentProjectScope();
    if (agentScopeMode === 'scene') return _agentWholeSceneScope();

    if (state.selectedTransitionIndex >= 0 && state.transitions?.[state.selectedTransitionIndex]) {
        const transition = state.transitions[state.selectedTransitionIndex];
        const clipIds = new Set([
            String(transition.fromClipId || ''),
            String(transition.toClipId || ''),
        ].filter(Boolean));
        const clipRefs = state.scenes
            .map((scene, index) => ({ scene, index }))
            .filter(({ scene }) => !scene?.isMGScene && clipIds.has(String(scene.clipId || '')))
            .map(({ scene, index }) => _agentClipRef(scene, index));
        const at = Number(transition.startTime ?? transition.at) || state.currentTime;
        return {
            kind: 'clips',
            scopeMode: 'selection',
            label: `Selected transition: ${transition.type || 'cut'}`,
            fromSec: clipRefs.length ? Math.min(...clipRefs.map((ref) => ref.startTime)) : at,
            toSec: clipRefs.length ? Math.max(...clipRefs.map((ref) => ref.endTime)) : at + 0.001,
            currentTime: at,
            totalDuration: state.totalDuration,
            contiguous: true,
            clipRefs,
            visualRefs: [],
            iconRefs: [],
        };
    }

    if (state.selectedMgIndex >= 0 && state.motionGraphics?.[state.selectedMgIndex]) {
        const visualRef = _agentVisualRef(
            state.motionGraphics[state.selectedMgIndex],
            state.selectedMgIndex,
            'motionGraphics'
        );
        return {
            kind: 'visual',
            scopeMode: 'selection',
            label: `Selected ${visualRef.type}`,
            fromSec: visualRef.startTime,
            toSec: visualRef.endTime,
            currentTime: state.currentTime,
            totalDuration: state.totalDuration,
            contiguous: true,
            clipRefs: [],
            visualRefs: [visualRef],
            iconRefs: [],
        };
    }

    const selected = [...new Set(state.selectedClipIndices || [])]
        .filter((index) => Number.isInteger(index) && state.scenes[index]);
    if (selected.length) {
        const clipRefs = [];
        const visualRefs = [];
        const iconRefs = [];
        selected.forEach((index) => {
            const scene = state.scenes[index];
            if (scene?.isMGScene || scene?.mediaType === 'motion-graphic' || scene?.mediaType === 'template') {
                visualRefs.push(_agentVisualRef(
                    scene,
                    index,
                    scene?.templateType ? 'templateScenes' : 'mgScenes'
                ));
            } else {
                clipRefs.push(_agentClipRef(scene, index));
                iconRefs.push(..._agentIconRefsForScene(scene, index));
            }
        });
        if (clipRefs.length) {
            const allRefs = [...clipRefs, ...visualRefs];
            return {
                kind: 'clips',
                scopeMode: 'selection',
                label: `${clipRefs.length} selected clip${clipRefs.length === 1 ? '' : 's'}`,
                fromSec: Math.min(...allRefs.map((ref) => ref.startTime)),
                toSec: Math.max(...allRefs.map((ref) => ref.endTime)),
                currentTime: state.currentTime,
                totalDuration: state.totalDuration,
                contiguous: _agentRefsAreContiguous(allRefs),
                clipRefs,
                visualRefs,
                iconRefs,
            };
        }
        if (visualRefs.length) {
            return {
                kind: 'visual',
                scopeMode: 'selection',
                label: `${visualRefs.length} selected graphic${visualRefs.length === 1 ? '' : 's'}`,
                fromSec: Math.min(...visualRefs.map((ref) => ref.startTime)),
                toSec: Math.max(...visualRefs.map((ref) => ref.endTime)),
                currentTime: state.currentTime,
                totalDuration: state.totalDuration,
                contiguous: _agentRefsAreContiguous(visualRefs),
                clipRefs: [],
                visualRefs,
                iconRefs: [],
            };
        }
    }

    if (state.inPoint !== null || state.outPoint !== null) {
        const fromSec = state.inPoint !== null ? state.inPoint : 0;
        const toSec = state.outPoint !== null ? state.outPoint : state.totalDuration;
        return {
            kind: 'range',
            scopeMode: 'selection',
            label: `In/Out ${formatTime(fromSec)}-${formatTime(toSec)}`,
            fromSec,
            toSec,
            currentTime: state.currentTime,
            totalDuration: state.totalDuration,
            contiguous: true,
            clipRefs: [],
            visualRefs: [],
            iconRefs: [],
        };
    }

    const playheadIndex = state.scenes.findIndex((scene) => {
        if (!scene || scene.isMGScene) return false;
        const timing = getSceneTiming(scene);
        return timing.startTime <= state.currentTime && timing.endTime > state.currentTime;
    });
    if (playheadIndex >= 0) {
        const clipRef = _agentClipRef(state.scenes[playheadIndex], playheadIndex);
        return {
            kind: 'playhead',
            scopeMode: 'selection',
            label: `Scene at ${formatTime(state.currentTime)}`,
            fromSec: clipRef.startTime,
            toSec: clipRef.endTime,
            currentTime: state.currentTime,
            totalDuration: state.totalDuration,
            contiguous: true,
            clipRefs: [clipRef],
            visualRefs: [],
            iconRefs: _agentIconRefsForScene(state.scenes[playheadIndex], playheadIndex),
        };
    }

    return _agentProjectScope();
}

async function getAgentVisualContext() {
    if (!state.hasProject || !state.videoPlan?.scenes?.length) return null;
    if (state.isPlaying) stopPlayback();

    if (state.hyperframesPreview?.active) {
        syncHyperframesPreview(true);
    } else if (state.compositorActive && state.compositor?.isInitialized) {
        state.compositor.renderAtTime(state.currentTime || 0);
    }

    // Electron/Chromium can throttle requestAnimationFrame while DevTools is
    // docked, the window is occluded, or an automated runtime probe is active.
    // Give the preview up to two paint opportunities, but never let visual
    // grounding hang indefinitely waiting for a frame callback.
    await Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise((resolve) => setTimeout(resolve, 120)),
    ]);

    const preferred = state.hyperframesPreview?.active
        ? elements.hyperframesPreviewFrame
        : elements.videoContainer;
    const container = elements.previewContainer;
    if (!preferred || !container) return null;

    const frameRect = preferred.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const left = Math.max(0, frameRect.left, containerRect.left);
    const top = Math.max(0, frameRect.top, containerRect.top);
    const right = Math.min(window.innerWidth, frameRect.right, containerRect.right);
    const bottom = Math.min(window.innerHeight, frameRect.bottom, containerRect.bottom);
    const width = Math.floor(right - left);
    const height = Math.floor(bottom - top);
    if (width < 64 || height < 36) return null;

    return {
        captureRequested: true,
        currentTime: Number(state.currentTime) || 0,
        renderer: state.hyperframesPreview?.active
            ? 'hyperframes'
            : (state.compositorActive ? 'webgl2' : 'html-preview'),
        frameReady: state.hyperframesPreview?.active
            ? state.hyperframesPreview.frameReady === true
            : true,
        rect: {
            x: Math.floor(left),
            y: Math.floor(top),
            width,
            height,
        },
    };
}

window.EditorAgentHost = {
    getScopeSnapshot: getAgentScopeSnapshot,
    getVisualContext: getAgentVisualContext,
    getScopeMode: () => agentScopeMode,
    setScopeMode: setAgentScopeMode,
    getProjectVersion: () => ({
        revision: state.projectRevision,
        planHash: state.projectPlanHash,
    }),
    hasProject: () => !!(state.hasProject && state.videoPlan?.scenes?.length),
    refreshScope: notifyAgentContextChanged,
};

function createSegmentClipId(scene, startTime, endTime, partIndex) {
    const base = scene?.clipId || createUniqueClipId(scene, 'clip');
    return `${base}-segment-${Math.round(startTime * 1000)}-${Math.round(endTime * 1000)}-${partIndex}`;
}

// ========================================
// Built-in gradient backgrounds (mirrors BACKGROUND_LIBRARY from themes.js)
// ========================================
const GRADIENT_BACKGROUNDS = window.GRADIENT_BACKGROUNDS = {
    'dark-gradient': 'radial-gradient(ellipse at 50% 40%, #1a1a2e 0%, #0a0a14 60%, #000000 100%)',
    'blue-minimal': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'dark-blue': 'radial-gradient(ellipse at 50% 50%, #0f2027 0%, #203a43 40%, #2c5364 100%)',
    'green-gradient': 'linear-gradient(160deg, #0f3443 0%, #34e89e 100%)',
    'warm-sunset': 'linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #fda085 100%)',
    'midnight': 'radial-gradient(ellipse at 30% 50%, #1a0a2e 0%, #0a0014 50%, #000000 100%)',
    'cream': 'linear-gradient(180deg, #fdf6e3 0%, #ede0c8 50%, #d4c5a9 100%)',
    'grid-texture': 'repeating-linear-gradient(0deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), repeating-linear-gradient(90deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 100%)',
    'red-dark': 'radial-gradient(ellipse at 50% 50%, #2a0a0a 0%, #1a0505 50%, #0a0000 100%)',
    'purple-haze': 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #3a1c71 100%)',
    'noir': 'radial-gradient(ellipse at 50% 30%, #1a1a1a 0%, #0a0a0a 40%, #000000 100%)',
    'ocean-deep': 'linear-gradient(180deg, #0c3547 0%, #0a2a3a 40%, #051a2a 100%)',
    // Soft solid-ish backgrounds (great for floating frame)
    'soft-beige': 'linear-gradient(180deg, #e8dcc8 0%, #d4c5a9 50%, #c4b494 100%)',
    'warm-white': 'linear-gradient(180deg, #f5f0e8 0%, #ebe3d5 50%, #ddd3c0 100%)',
    'soft-gray': 'linear-gradient(180deg, #d0d0d0 0%, #b8b8b8 50%, #a0a0a0 100%)',
    'slate': 'linear-gradient(180deg, #2c3e50 0%, #1a252f 50%, #0e171f 100%)',
    'warm-charcoal': 'linear-gradient(180deg, #3a3530 0%, #2a2520 50%, #1a1510 100%)',
    'paper': 'linear-gradient(180deg, #f0ead6 0%, #e6dcc6 50%, #d6ccb2 100%)',
};

const GRADIENT_BACKGROUND_NAMES = {
    'dark-gradient': 'Dark Gradient', 'blue-minimal': 'Blue Minimal',
    'dark-blue': 'Dark Blue', 'green-gradient': 'Green Gradient',
    'warm-sunset': 'Warm Sunset', 'midnight': 'Midnight',
    'cream': 'Cream', 'grid-texture': 'Grid Texture',
    'red-dark': 'Red Dark', 'purple-haze': 'Purple Haze',
    'noir': 'Noir', 'ocean-deep': 'Ocean Deep',
    'soft-beige': 'Soft Beige', 'warm-white': 'Warm White',
    'soft-gray': 'Soft Gray', 'slate': 'Slate',
    'warm-charcoal': 'Warm Charcoal', 'paper': 'Paper',
};

// ========================================
// DOM Elements
// ========================================
const elements = {
    btnNew: document.getElementById('btn-new'),
    btnOpenProject: document.getElementById('btn-open-project'),
    projectNameLabel: document.getElementById('project-name-label'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnRender: document.getElementById('btn-render'),
    btnAgent: document.getElementById('btn-agent'),
    openFootageResources: document.getElementById('open-footage-resources-btn'),
    footageResourceSummary: document.getElementById('footage-resource-summary'),
    btnGenerate: document.getElementById('btn-generate'),
    btnRepeatStep: document.getElementById('btn-repeat-step'),
    btnRemoveAudio: document.getElementById('btn-remove-audio'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    audioImportCard: document.getElementById('audio-import-card'),
    inputSourceHeading: document.getElementById('input-source-heading'),
    audioInfo: document.getElementById('audio-info'),
    audioName: document.getElementById('audio-name'),
    smartAiToggle: document.getElementById('smart-ai-toggle'),
    aiProvider: document.getElementById('ai-provider'),
    // ollama* controls removed (non-bedrock providers dropped 2026-05-25; pruned in P2)
    aiThinking: document.getElementById('ai-thinking'),
    aiInstructions: document.getElementById('ai-instructions'),
    aiInstructionsHint: document.getElementById('ai-instructions-hint'),
    videoTitle: document.getElementById('video-title'),
    buildQuality: document.getElementById('build-quality'),
    buildFormat: document.getElementById('build-format'),
    buildNiche: document.getElementById('build-niche'),
    buildTheme: document.getElementById('build-theme'),
    buildMapStylePack: document.getElementById('build-map-style-pack'),
    buildProductionMode: document.getElementById('build-production-mode'),
    productionModeSummaryTitle: document.getElementById('production-mode-summary-title'),
    productionModeSummaryBadge: document.getElementById('production-mode-summary-badge'),
    productionModeSummaryDescription: document.getElementById('production-mode-summary-description'),
    productionModeSummarySteps: document.getElementById('production-mode-summary-steps'),
    mediaTabLabel: document.getElementById('media-tab-label'),
    buildTabLabel: document.getElementById('build-tab-label'),
    buildQualityHint: document.getElementById('build-quality-hint'),
    presenterImageRow: document.getElementById('presenter-image-row'),
    presenterImagePath: document.getElementById('presenter-image-path'),
    btnPickPresenter: document.getElementById('btn-pick-presenter'),
    btnClearPresenter: document.getElementById('btn-clear-presenter'),
    klingAvatarRow: document.getElementById('kling-avatar-row'),
    klingAvatarEnabled: document.getElementById('kling-avatar-enabled'),
    klingAvatarOpts: document.getElementById('kling-avatar-opts'),
    klingResolution: document.getElementById('kling-resolution'),
    klingAvatarPrompt: document.getElementById('kling-avatar-prompt'),
    veoAiVideoRow: document.getElementById('veo-ai-video-row'),
    veoAiVideoEnabled: document.getElementById('veo-ai-video-enabled'),
    veoAiVideoOpts: document.getElementById('veo-ai-video-opts'),
    veoAiVideoToggleRow: document.getElementById('veo-ai-video-toggle-row'),
    veoAiVideoTitle: document.getElementById('veo-ai-video-title'),
    veoAiVideoModeBadge: document.getElementById('veo-ai-video-mode-badge'),
    veoAiVideoDescription: document.getElementById('veo-ai-video-description'),
    veoScopeGroup: document.getElementById('veo-scope-group'),
    fallbackMediaSettings: document.getElementById('fallback-media-settings'),
    veoScope: document.getElementById('veo-scope'),
    veoResolution: document.getElementById('veo-resolution'),
    veoBackend: document.getElementById('veo-backend'),
    buildVisionBackend: document.getElementById('build-vision-backend'),
    buildLanguage: document.getElementById('build-language'),
    buildStyleProfile: document.getElementById('build-style-profile'),
    btnLearnStyle: document.getElementById('btn-learn-style'),
    learnStyleDialog: document.getElementById('learn-style-dialog'),
    learnStyleUrl: document.getElementById('learn-style-url'),
    learnStyleBrowse: document.getElementById('learn-style-browse'),
    learnStyleStart: document.getElementById('learn-style-start'),
    learnStyleCancel: document.getElementById('learn-style-cancel'),
    learnStyleProgress: document.getElementById('learn-style-progress'),
    learnStyleBar: document.getElementById('learn-style-bar'),
    learnStyleMsg: document.getElementById('learn-style-msg'),
    learnStyleMode: document.getElementById('learn-style-mode'),
    learnStyleUrls: document.getElementById('learn-style-urls'),
    learnStyleName: document.getElementById('learn-style-name'),
    btnCompareStyle: document.getElementById('btn-compare-style'),
    styleComparisonReport: document.getElementById('style-comparison-report'),
    styleComparisonText: document.getElementById('style-comparison-text'),
    styleComparisonClose: document.getElementById('style-comparison-close'),
    // Clip analyzer toggle
    clipAnalyzerToggle: document.getElementById('clip-analyzer-toggle'),
    fastMediaToggle: document.getElementById('fast-media-toggle'),
    fastMediaGroup: document.getElementById('fast-media-group'),
    fastMediaHint: document.getElementById('fast-media-hint'),
    repeatFromStep: document.getElementById('repeat-from-step'),
    forceFreshFootage: document.getElementById('force-fresh-footage-toggle'),
    // Footage source toggles
    srcStoryblocks: document.getElementById('src-storyblocks'),
    srcPexels: document.getElementById('src-pexels'),
    srcPixabay: document.getElementById('src-pixabay'),
    srcYouTube: document.getElementById('src-youtube'),
    srcReddit: document.getElementById('src-reddit'),
    srcBing: document.getElementById('src-bing'),
    srcBrave: document.getElementById('src-brave'),
    previewPlaceholder: document.getElementById('preview-placeholder'),
    hyperframesPreviewFrame: document.getElementById('hyperframes-preview-frame'),
    // Multi-track video system
    videoContainer: document.getElementById('video-transition-container'),
    videoTrack1: document.getElementById('video-track-1'),
    videoTrack2: document.getElementById('video-track-2'),
    videoTrack3: document.getElementById('video-track-3'),
    videoTrack1B: document.getElementById('video-track-1-b'),
    videoTrack2B: document.getElementById('video-track-2-b'),
    videoTrack3B: document.getElementById('video-track-3-b'),
    videoTransitionOut: document.getElementById('video-transition-out'),
    // Image track elements (for image scenes)
    imgTrack1: document.getElementById('img-track-1'),
    imgTrack2: document.getElementById('img-track-2'),
    imgTrack3: document.getElementById('img-track-3'),
    imgTransitionOut: document.getElementById('img-transition-out'),
    // Motion Graphics overlay
    mgOverlay: document.getElementById('mg-overlay'),
    // Video controls
    videoControls: document.getElementById('video-controls'),
    btnPlay: document.getElementById('btn-play'),
    btnMute: document.getElementById('btn-mute'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    volumeSlider: document.getElementById('volume-slider'),
    currentTimeDisplay: document.getElementById('current-time-display'),
    totalTimeDisplay: document.getElementById('total-time-display'),
    // Audio
    previewAudio: document.getElementById('preview-audio'),
    progressContainer: document.getElementById('progress-container'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    progressTimer: document.getElementById('progress-timer'),
    btnCancel: document.getElementById('btn-cancel'),
    sceneList: document.getElementById('scene-list'),
    timelineContainer: document.getElementById('timeline-container'),
    leftPanel: document.getElementById('left-panel'),
    rightPanel: document.getElementById('right-panel'),
    resizeLeft: document.getElementById('resize-left'),
    resizeRight: document.getElementById('resize-right'),
    resizeTimeline: document.getElementById('resize-timeline'),
    // Clip properties panel
    clipProperties: document.getElementById('clip-properties'),
    propScale: document.getElementById('prop-scale'),
    propPosX: document.getElementById('prop-pos-x'),
    propPosY: document.getElementById('prop-pos-y'),
    propScaleVal: document.getElementById('prop-scale-val'),
    propPosXVal: document.getElementById('prop-pos-x-val'),
    propPosYVal: document.getElementById('prop-pos-y-val'),
    propVolume: document.getElementById('prop-volume'),
    propVolumeVal: document.getElementById('prop-volume-val'),
    propBackground: document.getElementById('prop-background'),
    propFitMode: document.getElementById('prop-fit-mode'),
    propAnimate: document.getElementById('prop-animate'),
    propAnimateRow: document.getElementById('prop-animate-row'),
    propKbSpeed: document.getElementById('prop-kb-speed'),
    propKbSpeedVal: document.getElementById('prop-kb-speed-val'),
    propKbSpeedRow: document.getElementById('prop-kb-speed-row'),
    propReset: document.getElementById('prop-reset'),
    propCropTop: document.getElementById('prop-crop-top'),
    propCropBottom: document.getElementById('prop-crop-bottom'),
    propCropLeft: document.getElementById('prop-crop-left'),
    propCropRight: document.getElementById('prop-crop-right'),
    propCropTopVal: document.getElementById('prop-crop-top-val'),
    propCropBottomVal: document.getElementById('prop-crop-bottom-val'),
    propCropLeftVal: document.getElementById('prop-crop-left-val'),
    propCropRightVal: document.getElementById('prop-crop-right-val'),
    btnFillFrame: document.getElementById('btn-fill-frame'),
    propBorderRadius: document.getElementById('prop-border-radius'),
    propBorderRadiusVal: document.getElementById('prop-border-radius-val'),
    // Floating frame controls
    propFloatingSection: document.getElementById('prop-floating-section'),
    propFloatingControls: document.getElementById('prop-floating-controls'),
    propFraming: document.getElementById('prop-framing'),
    propShadow: document.getElementById('prop-shadow'),
    propShadowVal: document.getElementById('prop-shadow-val'),
    propFloatingAnim: document.getElementById('prop-floating-anim'),
    propFloatingAnimDur: document.getElementById('prop-floating-anim-dur'),
    propFloatingAnimDurVal: document.getElementById('prop-floating-anim-dur-val'),
    // Track wrappers (for crop/radius)
    trackWrapper1: document.getElementById('track-wrapper-1'),
    trackWrapper2: document.getElementById('track-wrapper-2'),
    trackWrapper3: document.getElementById('track-wrapper-3'),
    // Background layer elements
    bgVideo: document.getElementById('bg-video'),
    bgImage: document.getElementById('bg-image'),
    bgGradient: document.getElementById('bg-gradient'),
    // Preview zoom
    previewContainer: document.getElementById('preview-container'),
    previewZoomSelect: document.getElementById('preview-zoom-select'),
    previewZoomLabel: document.getElementById('preview-zoom-label'),
    // Subtitles
    subtitlesEnabled: document.getElementById('subtitles-enabled'),
};

// ========================================
// Multi-Track Helper Functions
// ========================================

/**
 * Double-buffer helpers: each track has two video elements (A and B).
 * While one plays, the other preloads the next clip.
 * Switching is instant — just toggle visibility.
 */
function getTrackVideoPair(trackNum) {
    const which = state._trackActiveEl[trackNum] || 'a';
    const a = elements[`videoTrack${trackNum}`];
    const b = elements[`videoTrack${trackNum}B`];
    return {
        active: which === 'a' ? a : b,
        buffer: which === 'a' ? b : a,
    };
}

function swapTrackActive(trackNum) {
    state._trackActiveEl[trackNum] = state._trackActiveEl[trackNum] === 'a' ? 'b' : 'a';
}

function getActiveTrackVideo(trackNum) {
    const which = state._trackActiveEl[trackNum] || 'a';
    if (which === 'a') return elements[`videoTrack${trackNum}`];
    return elements[`videoTrack${trackNum}B`];
}

/**
 * Get all scenes active at a given time across all tracks
 * @param {number} time - Time in seconds
 * @returns {Array<{scene, index}>} - Array of active scenes sorted by track
 */
function getActiveScenesAtTime(time) {
    return state.scenes
        .map((scene, index) => ({ scene, index }))
        .filter(({ scene }) => time >= scene.startTime && time < scene.endTime)
        .sort((a, b) => {
            // Sort by track (lower track number = render first/below)
            const trackA = parseInt(a.scene.trackId?.match(/\d+/)?.[0] || '1');
            const trackB = parseInt(b.scene.trackId?.match(/\d+/)?.[0] || '1');
            return trackA - trackB;
        });
}

// ========================================
// Initialize
// ========================================
// ========================================
// Capture Mode (hidden window for Preview Capture renderer)
// ========================================
const _isCaptureMode = new URLSearchParams(window.location.search).get('mode') === 'capture';

function initCaptureMode() {
    console.log('[CaptureMode] Initializing capture window');

    // Hide ALL UI except the preview video container and MG overlay
    document.querySelectorAll('.header, .sidebar, .timeline-container, .progress-container, .toolbar, .startup-overlay, #notif-center, #video-controls, .preview-zoom-bar, #preview-placeholder').forEach(el => {
        if (el) el.style.display = 'none';
    });

    // Make preview fill the window at exactly 1920x1080
    const previewContainer = document.getElementById('preview-container');
    const videoContainer = document.getElementById('video-container');
    if (previewContainer) {
        previewContainer.style.cssText = 'position:fixed;top:0;left:0;width:1920px;height:1080px;margin:0;padding:0;overflow:hidden;z-index:9999;background:#000;';
    }
    if (videoContainer) {
        videoContainer.classList.remove('hidden');
        videoContainer.style.cssText = 'width:1920px;height:1080px;margin:0;padding:0;';
    }

    // Track which scenes are active to avoid redundant loadActiveScenes calls
    let _captureLastSceneKey = '';
    // Pre-cached media URLs (avoid IPC per frame)
    const _captureMediaCache = {};

    // Listen for plan data from main process
    window.electronAPI.onCaptureLoadPlan(async (planData) => {
        console.log('[CaptureMode] Received plan data');
        try {
            const plan = normalizePlanForEditor(planData);
            state.videoPlan = plan;
            window._mgBridgeVideoPlan = plan;
            state.scenes = plan.scenes || [];
            state.motionGraphics = plan.motionGraphics || [];
            hydratePlanTransitions(plan, state.scenes);
            state.totalDuration = plan.totalDuration || 0;
            state.fps = plan.fps || 30;
            state.mgStyle = plan.mgStyle || 'clean';
            _hydrateMgOverlayShadow(plan);

            // Assign trackIds if missing
            state.scenes.forEach((s, i) => {
                if (!s.trackId) s.trackId = s.isMGScene ? 'video-track-3' : 'video-track-1';
                if (s.index === undefined) s.index = i;
                if (s.sourceSceneIndex === undefined) s.sourceSceneIndex = getSceneSourceIndex(s, i);
            });

            // Pre-cache ALL media URLs upfront (avoids per-frame IPC)
            console.log('[CaptureMode] Pre-caching media URLs for', state.scenes.length, 'scenes');
            for (const scene of state.scenes) {
                if (scene.isMGScene || scene.disabled) continue;
                const idx = getSceneSourceIndex(scene, state.scenes.indexOf(scene));
                try {
                    const url = await getCachedMediaUrl(idx, scene.mediaExtension);
                    _captureMediaCache[idx] = url;
                    console.log(`[CaptureMode] Cached scene ${idx}: ${url ? url.substring(url.lastIndexOf('/') + 1) : 'null'}`);
                } catch (e) {
                    console.warn(`[CaptureMode] Failed to cache scene ${idx}:`, e.message);
                }
            }

            // Pre-load all video elements so they're ready for seeking
            console.log('[CaptureMode] Pre-loading video elements...');
            const videoLoadPromises = [];
            for (const scene of state.scenes) {
                if (scene.isMGScene || scene.disabled || scene.mediaType === 'image') continue;
                const idx = getSceneSourceIndex(scene, state.scenes.indexOf(scene));
                const url = _captureMediaCache[idx];
                if (!url) continue;
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const vid = elements[`videoTrack${trackNum}`];
                if (!vid) continue;
                // Load and wait for ready
                videoLoadPromises.push(new Promise((resolve) => {
                    if (vid._loadedUrl === url && vid.readyState >= 2) { resolve(); return; }
                    vid.src = url;
                    vid._loadedUrl = url;
                    vid.preload = 'auto';
                    vid.muted = true;
                    const onReady = () => { vid.removeEventListener('canplaythrough', onReady); resolve(); };
                    vid.addEventListener('canplaythrough', onReady);
                    setTimeout(resolve, 10000); // 10s max wait
                    vid.load();
                }));
            }
            await Promise.all(videoLoadPromises);

            console.log('[CaptureMode] All media ready, signaling capture-ready');
            window.electronAPI.sendCaptureReady();
        } catch (e) {
            console.error('[CaptureMode] Error loading plan:', e);
            window.electronAPI.sendCaptureReady();
        }
    });

    // Listen for frame seek requests — OPTIMIZED: only do full scene load on scene change
    window.electronAPI.onCaptureSeekFrame(async (data) => {
        const { frame, fps } = data;
        const timeSec = frame / fps;

        try {
            state.currentTime = timeSec;
            state.fps = fps;

            // Check which scenes are active at this time
            const activeScenes = getActiveScenesAtTime(timeSec);
            const sceneKey = activeScenes.map(({ index }) => index).join(',');

            // Only do full loadActiveScenes when the active scene SET changes
            if (sceneKey !== _captureLastSceneKey) {
                _captureLastSceneKey = sceneKey;
                await loadActiveScenes(activeScenes);
                // After scene change, wait for paint
                await new Promise(r => requestAnimationFrame(r));
            }

            // Quick-seek active video elements to exact frame time
            const seekPromises = [];
            for (const { scene } of activeScenes) {
                if (scene.isMGScene || scene.disabled || scene.mediaType === 'image') continue;
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const vid = elements[`videoTrack${trackNum}`];
                if (!vid || vid.readyState < 2) continue;

                const sceneTime = (timeSec - scene.startTime) + (scene.mediaOffset || 0);
                // Only seek if more than half a frame off
                if (Math.abs(vid.currentTime - sceneTime) > 0.5 / fps) {
                    seekPromises.push(new Promise((resolve) => {
                        vid.addEventListener('seeked', resolve, { once: true });
                        setTimeout(resolve, 500); // 500ms timeout (not 2s)
                        vid.currentTime = sceneTime;
                    }));
                }
            }
            if (seekPromises.length > 0) {
                await Promise.all(seekPromises);
            }

            // Update Ken Burns / transforms for images at current time
            for (const { scene } of activeScenes) {
                if (scene.mediaType !== 'image' || scene.isMGScene) continue;
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const img = elements[`imgTrack${trackNum}`];
                if (img) updateKenBurnsTransform(img, scene);
            }

            // Update MG overlays (track 2) — they compute animation from state.currentTime
            // Force bypass throttle by clearing last-active cache (capture needs every frame)
            _mgLastActiveIds = '';
            updateMGOverlay();

            // Single RAF for CSS repaint
            await new Promise(r => requestAnimationFrame(r));

            window.electronAPI.sendCaptureFrameReady();
        } catch (e) {
            console.error('[CaptureMode] Error seeking frame:', e);
            window.electronAPI.sendCaptureFrameReady();
        }
    });
}

async function init() {
    // Check if we're in capture mode (hidden window for Preview Capture renderer)
    if (_isCaptureMode) {
        initCaptureMode();
        console.log('🎬 YTA Empire WEBGL Capture Window Ready');
        return;
    }

    // Add error handlers on video elements to catch loading failures (A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach((video, i) => {
        if (!video) return;
        const label = i < 3 ? `Track ${i + 1}A` : `Track ${i - 2}B`;
        video.addEventListener('error', (e) => {
            const rawSrc = video.getAttribute('src') || '';
            if (!rawSrc && !video._loadedUrl) return;
            const err = video.error;
            console.error(`[Video ${label}] Error: code=${err?.code} message=${err?.message} src=${video.src?.substring(video.src.lastIndexOf('/') + 1)}`);
        });
        video.addEventListener('stalled', () => {
            console.warn(`[Video ${label}] Stalled: src=${video.src?.substring(video.src.lastIndexOf('/') + 1)} readyState=${video.readyState}`);
        });
    });

    // Load and display project info
    loadProjectInfo();

    // Populate language dropdown from the language registry (exposed via preload.js).
    // Adding a language in src/languages.js automatically adds it here — no UI edit needed.
    populateLanguageDropdown();

    setupEventListeners();
    setupElectronListeners();
    setupKeyboardShortcuts();
    setupResizablePanels();
    setupPanelSections();
    setupVideoControls();
    setupClipPropertyListeners();
    setupMgPropertyListeners();
    _initMapPropertiesListeners();
    setupListiclePropertyListeners();
    setupTemplatePropertyListeners();
    // Populate template background dropdown with custom images from assets/backgrounds/
    if (window.electronAPI?.scanBackgrounds) {
        window.electronAPI.scanBackgrounds().then(bgList => {
            const group = document.getElementById('tpl-bg-images');
            if (!group || !bgList || !bgList.length) { if (group) group.remove(); return; }
            for (const bg of bgList) {
                const opt = document.createElement('option');
                opt.value = `image:${bg.filename}`;
                const label = bg.theme ? `${bg.theme} — ${bg.name}` : bg.name;
                opt.textContent = label;
                group.appendChild(opt);
            }
        }).catch(() => {});
    }
    setupPreviewDrag();
    setupPreviewZoom();
    setupNotifCenter();
    loadSettings();
    _syncRepeatStepUI();
    syncFootageResourcesToMainProcess();
    // Push initial project context to Style Studio agent so it knows the video
    // title / niche / instructions immediately, without waiting for an edit.
    try {
        window.electronAPI?.styleStudioSetProjectContext?.({
            videoTitle: state.videoTitle,
            aiInstructions: state.aiInstructions,
            buildNiche: elements.buildNiche ? elements.buildNiche.value : 'auto',
            buildLanguage: elements.buildLanguage ? elements.buildLanguage.value : 'auto',
            buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
        });
    } catch (_) {}
    // Scan available overlays from assets/overlays/
    try {
        state.availableOverlays = await window.electronAPI.scanOverlays();
        console.log(`📁 Found ${state.availableOverlays.length} overlay files in assets/overlays/`);
    } catch (e) {
        console.log('Could not scan overlays folder:', e.message);
        state.availableOverlays = [];
    }

    // Scan available backgrounds from assets/backgrounds/
    try {
        state.availableBackgrounds = await window.electronAPI.scanBackgrounds();
        console.log(`📁 Found ${state.availableBackgrounds.length} background files in assets/backgrounds/`);
    } catch (e) {
        console.log('Could not scan backgrounds folder:', e.message);
        state.availableBackgrounds = [];
    }
    populateBackgroundDropdown();

    // Auto-load last saved project
    try {
        await loadVideoPlan();
        if (state.scenes.length > 0) {
            console.log(`✅ Restored project: ${state.scenes.length} scenes`);
            await jumpToScene(0);
        } else {
            console.warn('⚠️ loadVideoPlan completed but state.scenes is empty');
        }
    } catch (e) {
        console.error('❌ No saved project to restore:', e?.message || e, e?.stack);
    }

    // Initialize WebGL2 Compositor Engine
    initCompositor();

    // Timeline scene right-click menu (retry footage / CEO editor)
    initSceneContextMenu();

    console.log('🎬 YTA Empire WEBGL UI Ready');
}

function setupEventListeners() {
    elements.dropZone.addEventListener('click', () => { if (!_requireProject()) return; elements.fileInput.click(); });
    elements.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); if (state.hasProject) elements.dropZone.classList.add('drag-over'); });
    elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('drag-over'));
    elements.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('drag-over');
        if (!_requireProject()) return;
        if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]).catch((error) => showToast(error.message, 'error'));
    });
    elements.fileInput.addEventListener('change', (e) => {
        if (!_requireProject()) return;
        if (e.target.files.length > 0) {
            handleFileSelect(e.target.files[0]).catch((error) => showToast(error.message, 'error'));
        }
    });
    elements.btnRemoveAudio.addEventListener('click', removeAudio);
    elements.btnGenerate.addEventListener('click', generateVideo);
    if (elements.btnRepeatStep) elements.btnRepeatStep.addEventListener('click', () => generateVideo({ repeatStep: true }));
    // Build Log collapse/expand
    const _blHead = document.querySelector('#build-log .build-log-head');
    if (_blHead) _blHead.addEventListener('click', () => {
        const panel = document.getElementById('build-log');
        const tog = document.getElementById('build-log-toggle');
        if (!panel) return;
        panel.classList.toggle('collapsed');
        if (tog) tog.textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
    });
    elements.btnRender.addEventListener('click', renderVideo);
    if (elements.btnAgent) {
        elements.btnAgent.addEventListener('click', () => window.EditorAgentPanel?.open());
    }
    if (elements.openFootageResources) {
        elements.openFootageResources.addEventListener('click', () => window.electronAPI?.openFootageResources?.());
    }
    elements.btnCancel.addEventListener('click', cancelProcess);
    elements.btnNew.addEventListener('click', newProject);
    if (elements.btnOpenProject) {
        elements.btnOpenProject.addEventListener('click', openExistingProject);
    }
    elements.btnRefresh.addEventListener('click', refreshApp);
    // Smart AI toggle — dims AI settings when off
    if (elements.smartAiToggle) {
        const updateSmartAI = () => {
            const on = elements.smartAiToggle.checked;
            elements.aiProvider.disabled = !on;
            if (elements.aiInstructions) elements.aiInstructions.disabled = !on;
            elements.aiProvider.parentElement.style.opacity = on ? '1' : '0.4';
            if (elements.aiInstructions) elements.aiInstructions.style.opacity = on ? '1' : '0.4';
        };
        elements.smartAiToggle.addEventListener('change', () => { updateSmartAI(); saveSettings(); });
        updateSmartAI();
    }
    if (elements.clipAnalyzerToggle) {
        elements.clipAnalyzerToggle.addEventListener('change', () => {
            saveSettings();
            syncFootageResourcesToMainProcess();
        });
    }
    if (elements.fastMediaToggle) {
        elements.fastMediaToggle.addEventListener('change', _syncFastMediaUI);
    }
    if (elements.repeatFromStep) {
        elements.repeatFromStep.addEventListener('change', () => {
            _syncRepeatStepUI();
            saveSettings();
        });
    }
    if (elements.forceFreshFootage) {
        elements.forceFreshFootage.addEventListener('change', () => saveSettings());
    }

    // Vision health dashboard (uses IPC, not direct Node.js)
    const qwenPoolBtn = document.getElementById('reset-qwen-pool-btn');
    const qwenPoolStatus = document.getElementById('qwen-pool-status');
    const visionHealthSummary = document.getElementById('vision-health-summary');
    const visionHealthMetrics = document.getElementById('vision-health-metrics');
    const visionHealthKeys = document.getElementById('vision-health-keys');
    const visionHealthWarnings = document.getElementById('vision-health-warnings');
    const visionHealthRefreshBtn = document.getElementById('vision-health-refresh-btn');
    const visionHealthLiveBtn = document.getElementById('vision-health-live-btn');
    const visionKeyManagerToggle = document.getElementById('vision-key-manager-toggle');
    const visionKeyManager = document.getElementById('vision-key-manager');
    const visionKeyEnvPath = document.getElementById('vision-key-env-path');
    const visionKeyList = document.getElementById('vision-key-list');
    const visionKeyAdditions = document.getElementById('vision-key-additions');
    const visionKeySaveBtn = document.getElementById('vision-key-save-btn');
    const visionKeyCancelBtn = document.getElementById('vision-key-cancel-btn');
    const visionKeySaveStatus = document.getElementById('vision-key-save-status');
    let visionKeyRows = { image: [], omni: [] };

    const escapeVisionHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const ratioText = (item) => `${Number(item?.available || 0)}/${Number(item?.total || 0)}`;
    const verifiedText = (item) => Number(item?.verifiedOk || 0) > 0 ? `${Number(item.verifiedOk)} live` : 'not probed';

    function setVisionSummary(text, level) {
        if (!visionHealthSummary) return;
        visionHealthSummary.textContent = text;
        visionHealthSummary.className = `vision-health-summary ${level || ''}`.trim();
    }

    function renderVisionHealth(status, modeLabel = '') {
        if (!status) {
            setVisionSummary('unavailable', 'bad');
            return;
        }

        const warnings = status.diagnostics?.warnings || [];
        const hasImage = Number(status.image?.available || 0) > 0;
        const hasOmni = Number(status.omniHttp?.available || 0) > 0 || Number(status.omniRealtime?.available || 0) > 0;
        const level = !hasImage && !hasOmni ? 'bad' : warnings.length ? 'warn' : 'ok';
        const label = !hasImage && !hasOmni ? 'No Qwen Vision' : warnings.length ? 'Degraded' : 'Healthy';
        setVisionSummary(modeLabel ? `${label} - ${modeLabel}` : label, level);

        if (visionHealthMetrics) {
            const healthAge = status.health?.updatedAt
                ? new Date(status.health.updatedAt).toLocaleString()
                : 'no live probe';
            const realtime = status.omniRealtime?.activeInCurrentRuntime ? 'on' : 'off';
            visionHealthMetrics.innerHTML = [
                ['Keys', `${Number(status.imageKeys || 0)} VL / ${Number(status.omniKeys || 0)} Omni`],
                ['Image/VL', `${ratioText(status.image)} (${verifiedText(status.image)})`],
                ['Omni HTTP', `${ratioText(status.omniHttp)} (${verifiedText(status.omniHttp)})`],
                ['Realtime', `${ratioText(status.omniRealtime)} (${realtime})`],
                ['Health Cache', healthAge],
            ].map(([name, value]) => `
                <div class="vision-health-metric">
                    <span>${escapeVisionHtml(name)}</span>
                    <strong title="${escapeVisionHtml(value)}">${escapeVisionHtml(value)}</strong>
                </div>
            `).join('');
        }

        if (visionHealthKeys) {
            const imageCards = (status.image?.perKey || []).map(item => `
                <div class="vision-health-key">
                    <span>Image ${Number(item.keyIndex || 0)} - ${escapeVisionHtml(item.keyTail || 'unknown')}</span>
                    <strong>VL ${ratioText(item)}</strong>
                    <small>${Number(item.verifiedOk || 0)} live verified</small>
                </div>
            `);
            const omniCards = (status.omniHttp?.perKey || []).map(item => {
                const rt = (status.omniRealtime?.perKey || []).find(k => Number(k.keyIndex) === Number(item.keyIndex));
                return `
                    <div class="vision-health-key">
                        <span>Omni ${Number(item.keyIndex || 0)} - ${escapeVisionHtml(item.keyTail || 'unknown')}</span>
                        <strong>HTTP ${ratioText(item)}${rt ? ` | RT ${ratioText(rt)}` : ''}</strong>
                        <small>${Number(item.verifiedOk || 0) + Number(rt?.verifiedOk || 0)} live verified</small>
                    </div>
                `;
            });
            visionHealthKeys.innerHTML = [...imageCards, ...omniCards].join('') || '<div class="vision-health-warning">No Qwen vision keys loaded.</div>';
        }

        if (visionHealthWarnings) {
            const notes = warnings.slice(0, 4);
            visionHealthWarnings.innerHTML = notes.length
                ? notes.map(w => `<div class="vision-health-warning">${escapeVisionHtml(w)}</div>`).join('')
                : '';
        }
    }

    function renderVisionKeyRows(data) {
        const laneDefs = [
            { id: 'image', title: 'Image/VL Keys', description: 'Used for still-image scoring and frame scoring.', fallback: 'shared fallback' },
            { id: 'omni', title: 'Omni Multimodal Keys', description: 'Used for clip analyzer and video-frame reasoning.', fallback: 'shared fallback' },
        ];
        visionKeyRows = {
            image: (data?.image?.keys || []).map(key => ({ ...key, remove: false })),
            omni: (data?.omni?.keys || []).map(key => ({ ...key, remove: false })),
        };
        if (visionKeyEnvPath) {
            visionKeyEnvPath.textContent = data?.envPath || '';
            visionKeyEnvPath.title = data?.envPath || '';
        }
        if (!visionKeyList) return;
        if (visionKeyAdditions) visionKeyAdditions.style.display = 'none';
        visionKeyList.innerHTML = laneDefs.map(lane => {
            const laneData = data?.[lane.id] || {};
            const rows = visionKeyRows[lane.id] || [];
            const badge = laneData.explicit
                ? laneData.envKey
                : `${laneData.envKey || ''} using ${laneData.fallback || lane.fallback}`;
            const emptyText = laneData.explicit
                ? 'No keys in this explicit lane. Add keys below, or remove the env line manually to use shared fallback.'
                : 'No lane-specific keys found. This lane is using shared fallback; add keys below to split it.';
            const rowsHtml = rows.length ? rows.map(row => `
                <div class="vision-key-row" data-key-lane="${lane.id}" data-key-index="${Number(row.index)}">
                    <div class="vision-key-label">
                        <span>${lane.id} key ${Number(row.index) + 1} - ${escapeVisionHtml(row.tail || '')}</span>
                        <strong title="${escapeVisionHtml(row.masked || '')}">${escapeVisionHtml(row.masked || '')}</strong>
                    </div>
                    <input class="vision-key-replace" data-key-replace-lane="${lane.id}" data-key-replace-index="${Number(row.index)}" type="password" placeholder="Paste replacement key (optional)">
                    <button class="vision-key-remove" data-key-remove-lane="${lane.id}" data-key-remove-index="${Number(row.index)}" type="button">Remove</button>
                </div>
            `).join('') : `<div class="vision-health-warning">${escapeVisionHtml(emptyText)}</div>`;
            return `
                <div class="vision-key-section" data-key-section="${lane.id}">
                    <div class="vision-key-section-head">
                        <div>
                            <strong>${escapeVisionHtml(lane.title)}</strong>
                            <small>${escapeVisionHtml(lane.description)}</small>
                        </div>
                        <span>${escapeVisionHtml(badge)}</span>
                    </div>
                    ${rowsHtml}
                    <textarea class="vision-key-additions" data-key-additions="${lane.id}" rows="2" placeholder="Add ${escapeVisionHtml(lane.title)} here, one per line or comma-separated."></textarea>
                </div>
            `;
        }).join('');
        visionKeyList.querySelectorAll('[data-key-remove-lane]').forEach(button => {
            button.addEventListener('click', () => {
                const lane = button.getAttribute('data-key-remove-lane');
                const index = Number(button.getAttribute('data-key-remove-index'));
                const row = (visionKeyRows[lane] || []).find(item => Number(item.index) === index);
                if (!row) return;
                row.remove = !row.remove;
                button.classList.toggle('active', row.remove);
                button.textContent = row.remove ? 'Undo' : 'Remove';
            });
        });
    }

    async function loadVisionKeys() {
        if (!window.electronAPI?.qwenVisionKeysStatus) return;
        try {
            const result = await window.electronAPI.qwenVisionKeysStatus();
            if (result?.success) {
                renderVisionKeyRows(result);
                if (visionKeySaveStatus) visionKeySaveStatus.textContent = '';
            } else if (visionKeySaveStatus) {
                visionKeySaveStatus.textContent = result?.error || 'could not load keys';
                visionKeySaveStatus.style.color = '#fca5a5';
            }
        } catch (err) {
            if (visionKeySaveStatus) {
                visionKeySaveStatus.textContent = err?.message || 'could not load keys';
                visionKeySaveStatus.style.color = '#fca5a5';
            }
        }
    }

    async function saveVisionKeysAndProbe() {
        if (!window.electronAPI?.qwenVisionKeysSave) return;
        const lanes = {};
        for (const lane of ['image', 'omni']) {
            lanes[lane] = {
                rows: (visionKeyRows[lane] || []).map(row => {
                    const input = visionKeyList?.querySelector(`[data-key-replace-lane="${lane}"][data-key-replace-index="${Number(row.index)}"]`);
                    return {
                        index: Number(row.index),
                        remove: row.remove === true,
                        replacement: input?.value || ''
                    };
                }),
                additions: visionKeyList?.querySelector(`[data-key-additions="${lane}"]`)?.value || ''
            };
        }
        if (visionKeySaveStatus) {
            visionKeySaveStatus.textContent = 'saving...';
            visionKeySaveStatus.style.color = '#fbbf24';
        }
        if (visionKeySaveBtn) visionKeySaveBtn.disabled = true;
        try {
            const result = await window.electronAPI.qwenVisionKeysSave({ lanes });
            if (!result?.success) throw new Error(result?.error || 'save failed');
            renderVisionKeyRows(result);
            renderVisionHealth(result.status, 'saved');
            if (visionKeySaveStatus) {
                const saved = result.saved && typeof result.saved === 'object'
                    ? `Image ${result.saved.image || 0}, Omni ${result.saved.omni || 0}`
                    : `${result.saved || 0}`;
                visionKeySaveStatus.textContent = `saved ${saved}; probing...`;
                visionKeySaveStatus.style.color = '#86efac';
            }
            if (window.electronAPI?.visionHealthLiveCheck) {
                setVisionSummary('probing new keys...', 'warn');
                const probe = await window.electronAPI.visionHealthLiveCheck({
                    lanes: ['image', 'omniHttp'],
                    imageLimit: 1,
                    omniLimit: 1,
                    concurrency: 3,
                    timeoutMs: 12000
                });
                if (probe?.success) {
                    renderVisionHealth(probe.status, 'keys checked');
                    if (visionKeySaveStatus) visionKeySaveStatus.textContent = 'saved and checked';
                } else if (visionKeySaveStatus) {
                    visionKeySaveStatus.textContent = 'saved; probe failed';
                    visionKeySaveStatus.style.color = '#fca5a5';
                }
            }
        } catch (err) {
            if (visionKeySaveStatus) {
                visionKeySaveStatus.textContent = err?.message || 'save failed';
                visionKeySaveStatus.style.color = '#fca5a5';
            }
        } finally {
            if (visionKeySaveBtn) visionKeySaveBtn.disabled = false;
            updateQwenPoolStatus();
        }
    }

    async function updateQwenPoolStatus() {
        if (!qwenPoolStatus || !window.electronAPI?.qwenPoolStatus) return;
        try {
            const status = await window.electronAPI.qwenPoolStatus();
            if (status.exhausted > 0) {
                qwenPoolStatus.textContent = `${status.exhausted} exhausted`;
                qwenPoolStatus.style.color = status.exhausted > 12 ? '#fca5a5' : '#fbbf24';
            } else {
                qwenPoolStatus.textContent = 'tracking clean';
                qwenPoolStatus.style.color = '#86efac';
            }
        } catch (_) {
            qwenPoolStatus.textContent = '';
        }
    }

    async function refreshVisionHealth(modeLabel = '') {
        if (!window.electronAPI?.visionHealthStatus) {
            setVisionSummary('unsupported', 'bad');
            return;
        }
        try {
            const result = await window.electronAPI.visionHealthStatus();
            if (result?.success) {
                renderVisionHealth(result.status, modeLabel);
            } else {
                setVisionSummary('status failed', 'bad');
                if (visionHealthWarnings) {
                    visionHealthWarnings.innerHTML = `<div class="vision-health-warning">${escapeVisionHtml(result?.error || 'Could not read vision status.')}</div>`;
                }
            }
        } catch (err) {
            setVisionSummary('status failed', 'bad');
            if (visionHealthWarnings) {
                visionHealthWarnings.innerHTML = `<div class="vision-health-warning">${escapeVisionHtml(err?.message || err)}</div>`;
            }
        }
        updateQwenPoolStatus();
        if (visionKeyManager && !visionKeyManager.classList.contains('hidden')) {
            loadVisionKeys();
        }
    }

    if (qwenPoolBtn) {
        qwenPoolBtn.textContent = 'Reset Tracking';
        qwenPoolBtn.className = 'vision-health-btn danger-soft';
        qwenPoolBtn.removeAttribute('style');
        qwenPoolBtn.addEventListener('click', async () => {
            if (!window.electronAPI?.qwenPoolReset) return;
            qwenPoolBtn.disabled = true;
            try {
                const result = await window.electronAPI.qwenPoolReset();
                if (qwenPoolStatus) {
                    qwenPoolStatus.textContent = result?.success ? 'tracking reset' : 'reset failed';
                    qwenPoolStatus.style.color = result?.success ? '#86efac' : '#fca5a5';
                }
                setTimeout(() => refreshVisionHealth('reset'), 800);
            } catch (_) {
                if (qwenPoolStatus) {
                    qwenPoolStatus.textContent = 'reset failed';
                    qwenPoolStatus.style.color = '#fca5a5';
                }
            } finally {
                qwenPoolBtn.disabled = false;
            }
        });
    }

    if (visionHealthRefreshBtn) {
        visionHealthRefreshBtn.addEventListener('click', () => refreshVisionHealth('cached'));
    }

    if (visionKeyManagerToggle && visionKeyManager) {
        visionKeyManagerToggle.addEventListener('click', async () => {
            const opening = visionKeyManager.classList.contains('hidden');
            visionKeyManager.classList.toggle('hidden', !opening);
            visionKeyManagerToggle.textContent = opening ? 'Hide Keys' : 'Manage Keys';
            if (opening) await loadVisionKeys();
        });
    }

    if (visionKeyCancelBtn && visionKeyManager) {
        visionKeyCancelBtn.addEventListener('click', () => {
            visionKeyManager.classList.add('hidden');
            if (visionKeyManagerToggle) visionKeyManagerToggle.textContent = 'Manage Keys';
            if (visionKeySaveStatus) visionKeySaveStatus.textContent = '';
        });
    }

    if (visionKeySaveBtn) {
        visionKeySaveBtn.addEventListener('click', saveVisionKeysAndProbe);
    }

    if (visionHealthLiveBtn) {
        visionHealthLiveBtn.addEventListener('click', async () => {
            if (!window.electronAPI?.visionHealthLiveCheck) return;
            visionHealthLiveBtn.disabled = true;
            setVisionSummary('probing...', 'warn');
            try {
                const result = await window.electronAPI.visionHealthLiveCheck({
                    lanes: ['image', 'omniHttp'],
                    imageLimit: 1,
                    omniLimit: 1,
                    concurrency: 3,
                    timeoutMs: 12000
                });
                if (result?.success) {
                    const total = result.probe?.summary?.total || 0;
                    renderVisionHealth(result.status, `${total} checked`);
                } else {
                    setVisionSummary('probe failed', 'bad');
                    if (visionHealthWarnings) {
                        visionHealthWarnings.innerHTML = `<div class="vision-health-warning">${escapeVisionHtml(result?.error || 'Live probe failed.')}</div>`;
                    }
                }
            } catch (err) {
                setVisionSummary('probe failed', 'bad');
                if (visionHealthWarnings) {
                    visionHealthWarnings.innerHTML = `<div class="vision-health-warning">${escapeVisionHtml(err?.message || err)}</div>`;
                }
            } finally {
                visionHealthLiveBtn.disabled = false;
                updateQwenPoolStatus();
            }
        });
    }

    refreshVisionHealth();
    elements.aiProvider.addEventListener('change', () => {
        // Apply the brain switch immediately (live for refresh/open, not just builds)
        if (window.electronAPI?.setAiProvider) {
            window.electronAPI.setAiProvider(elements.aiProvider.value).catch(() => {});
        }
        saveSettings();
    });
    if (elements.videoTitle) {
        elements.videoTitle.addEventListener('input', () => {
            state.videoTitle = elements.videoTitle.value;
            triggerAutoSave();
        });
        elements.videoTitle.addEventListener('change', saveSettings);
    }
    if (elements.aiInstructions) {
        elements.aiInstructions.addEventListener('input', () => {
            state.aiInstructions = elements.aiInstructions.value;
            triggerAutoSave();
        });
        elements.aiInstructions.addEventListener('change', saveSettings);
    }
    // Global MG animation speed slider
    const globalAnimSpeedEl = document.getElementById('mg-global-anim-speed');
    if (globalAnimSpeedEl) {
        globalAnimSpeedEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('mg-global-anim-speed-val').textContent = `${val.toFixed(1)}x`;
        });
    }
    _syncMgShadowUI(state.mgOverlayShadow);
    const globalShadowEl = document.getElementById('mg-global-shadow');
    if (globalShadowEl) {
        globalShadowEl.addEventListener('input', (e) => {
            _setGlobalMgOverlayShadow(e.target.value);
            refreshCompositorMGs();
        });
    }
    // Footage source toggle listeners
    ['srcStoryblocks', 'srcPexels', 'srcPixabay', 'srcYouTube', 'srcReddit', 'srcBing', 'srcBrave'].forEach(key => {
        if (elements[key]) elements[key].addEventListener('change', () => {
            saveSettings();
            syncFootageResourcesToMainProcess();
        });
    });

    // Style Learner — populate dropdown, wire learn dialog
    setupStyleLearner();
    // Subtitles toggle
    if (elements.subtitlesEnabled) {
        elements.subtitlesEnabled.addEventListener('change', () => {
            state.subtitlesEnabled = elements.subtitlesEnabled.checked;
            saveSettings();
        });
    }
    // Niche preset dropdown — save settings on change
    if (elements.buildNiche) {
        elements.buildNiche.addEventListener('change', () => {
            saveSettings();
        });
    }
    // Theme dropdown — refresh MG preview when theme changes
    if (elements.buildTheme) {
        elements.buildTheme.addEventListener('change', () => {
            updateMGOverlay();
            saveSettings();
        });
    }
    // Map style pack dropdown — save settings (pack is applied at build time)
    if (elements.buildMapStylePack) {
        elements.buildMapStylePack.addEventListener('change', () => {
            saveSettings();
        });
    }
    // Production mode — toggle the presenter picker row + persist. Talking-head adds a
    // recurring on-camera presenter at a few key beats; faceless is the default B-roll video.
    if (elements.buildProductionMode) {
        elements.buildProductionMode.addEventListener('change', () => {
            _syncPresenterRow();
            _syncProductionModeUI();
            saveSettings();
        });
    }
    // Presenter image picker (talking-head): pick a photo → copy into the project's assets/
    // (never input/, which wipes narration audio) → remember the path for the build.
    if (elements.btnPickPresenter) {
        elements.btnPickPresenter.addEventListener('click', async () => {
            try {
                const picked = await window.electronAPI?.selectFile?.({ filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
                if (!picked) return;
                let finalPath = picked;
                try {
                    const copied = await window.electronAPI?.copyPresenterImage?.(picked);
                    if (copied && copied.success && copied.path) finalPath = copied.path;
                } catch (_) {}
                state.presenterImage = finalPath;
                if (elements.presenterImagePath) elements.presenterImagePath.value = finalPath;
                saveSettings();
            } catch (e) {
                if (typeof showToast === 'function') showToast('Could not set presenter image', 'error');
            }
        });
    }
    if (elements.btnClearPresenter) {
        elements.btnClearPresenter.addEventListener('click', () => {
            state.presenterImage = '';
            if (elements.presenterImagePath) elements.presenterImagePath.value = '';
            saveSettings();
        });
    }
    // Kling avatar toggle → show/hide the resolution + prompt options, persist.
    if (elements.klingAvatarEnabled) {
        elements.klingAvatarEnabled.addEventListener('change', () => { _syncPresenterRow(); saveSettings(); });
    }
    if (elements.klingResolution) elements.klingResolution.addEventListener('change', saveSettings);
    if (elements.klingAvatarPrompt) elements.klingAvatarPrompt.addEventListener('change', saveSettings);
    // AI Video (Veo) toggle → show/hide scope+resolution+backend, persist.
    if (elements.veoAiVideoEnabled) {
        elements.veoAiVideoEnabled.addEventListener('change', () => { _syncVeoRow(); saveSettings(); });
    }
    if (elements.veoScope) elements.veoScope.addEventListener('change', saveSettings);
    if (elements.veoResolution) elements.veoResolution.addEventListener('change', saveSettings);
    if (elements.veoBackend) elements.veoBackend.addEventListener('change', saveSettings);
    _syncVeoRow();
    _syncPresenterRow();
    _syncProductionModeUI();
    _initSettingsTabs();
    // Vision backend dropdown — persist immediately to .env (main process) so the choice
    // survives restart AND the live build/retry pick it up, then save UI settings.
    if (elements.buildVisionBackend) {
        // Reflect the actual current backend from .env on load (overrides the default option).
        if (window.electronAPI && electronAPI.getVisionBackend) {
            electronAPI.getVisionBackend().then((b) => {
                if (b && [...elements.buildVisionBackend.options].some(o => o.value === b)) {
                    elements.buildVisionBackend.value = b;
                }
            }).catch(() => {});
        }
        elements.buildVisionBackend.addEventListener('change', () => {
            const backend = elements.buildVisionBackend.value;
            if (window.electronAPI && electronAPI.setVisionBackend) {
                electronAPI.setVisionBackend(backend).then((r) => {
                    if (r && r.note) showToast(r.note, 'info');
                }).catch(() => {});
            }
            saveSettings();
        });
    }
    setupLightningAccountsUI();
}

// ── Lightning account pool manager (no-code) ──────────────────────────────────────────
// Persisted per-account provisioning/check logs so list re-renders (budget edits, other
// buttons, reopening the modal) don't wipe an in-progress or just-finished log.
const _lightningProvLog = {}; // id -> { text }
function _provBox(id) { return document.querySelector(`[data-provlog="${id}"]`); }
function _provShow(id) { const c = document.querySelector(`[data-provbox="${id}"]`); if (c) c.style.display = 'block'; }
function _provReset(id, text) { _lightningProvLog[id] = { text: text || '' }; _provShow(id); const box = _provBox(id); if (box) box.textContent = text || ''; }
function _provAppend(id, line) {
    const st = _lightningProvLog[id] || (_lightningProvLog[id] = { text: '' });
    st.text = (st.text + '\n' + line).split('\n').slice(-16).join('\n').trim();
    _provShow(id);
    const box = _provBox(id);
    if (box) { box.textContent = st.text; box.scrollTop = box.scrollHeight; }
}

function setupLightningAccountsUI() {
    const modal = document.getElementById('lightning-accounts-modal');
    const openBtn = document.getElementById('btn-manage-lightning');
    const closeBtn = document.getElementById('lightning-modal-close');
    const addBtn = document.getElementById('lightning-add-btn');
    if (!modal || !openBtn) return;

    const open = () => { modal.style.display = 'flex'; renderLightningAccounts(); };
    const close = () => { modal.style.display = 'none'; };
    openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    if (addBtn) addBtn.addEventListener('click', async () => {
        const errEl = document.getElementById('lightning-add-error');
        if (errEl) errEl.style.display = 'none';
        const val = (id) => (document.getElementById(id)?.value || '').trim();
        const account = {
            label: val('la-label'), userId: val('la-userId'), apiKey: val('la-apiKey'),
            studioName: val('la-studioName'), teamspace: val('la-teamspace'), user: val('la-user'),
            machine: val('la-machine') || 'T4', monthlyBudgetHours: Number(val('la-budget')) || 18,
        };
        const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
        if (!account.userId || !account.apiKey || !account.studioName) {
            showErr('User ID, API Key and Studio name are required.'); return;
        }
        const ot = addBtn.textContent;
        addBtn.disabled = true; addBtn.textContent = 'Verifying account…';
        try {
            // Verify the Studio actually resolves BEFORE saving — catches teamspace/username/key
            // typos (e.g. "Ilm" vs "llm") with a clear message instead of failing later at setup.
            const v = await electronAPI.lightningValidate(account);
            if (!v || !v.ok) {
                let msg = (v && v.error) || 'could not reach Lightning.';
                if (/does not exist|not found|Teamspace/i.test(msg)) msg = 'Studio/teamspace not found — double-check Teamspace + Username (they are CASE-SENSITIVE: e.g. “llm” not “Ilm”).';
                else msg = msg.slice(0, 180);
                showErr('❌ ' + msg);
                addBtn.disabled = false; addBtn.textContent = ot; return;
            }
            const r = await electronAPI.lightningPoolAdd(account);
            if (r && r.ok) {
                ['la-label', 'la-userId', 'la-apiKey', 'la-studioName', 'la-teamspace', 'la-user'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
                showToast(`Added + verified “${account.label || account.studioName}” ✓ — now click ⚙ Set up Studio`, 'success');
                renderLightningAccounts();
            } else { showErr((r && r.error) || 'Could not add account.'); }
        } catch (e) { showErr(e.message); }
        addBtn.disabled = false; addBtn.textContent = ot;
    });

    // "Build uses" override — pin builds to one account, or auto-rotate.
    const activeSel = document.getElementById('lightning-active-account');
    if (activeSel) activeSel.addEventListener('change', async () => {
        try {
            await electronAPI.lightningPoolSetActive(activeSel.value);
            const txt = activeSel.options[activeSel.selectedIndex].text;
            showToast(activeSel.value === 'auto' ? 'Builds will auto-rotate accounts' : `Builds pinned to ${txt}`, 'info');
        } catch (_) {}
    });

    // Stream provisioning/check output into the matching account's (persisted) log box.
    if (electronAPI.onLightningProvisionProgress) {
        electronAPI.onLightningProvisionProgress((d) => _provAppend(d.id, d.line));
    }
}

async function renderLightningAccounts() {
    const list = document.getElementById('lightning-accounts-list');
    if (!list || !window.electronAPI || !electronAPI.lightningPoolList) return;
    list.innerHTML = '<div style="color:#888;font-size:12px;">Loading…</div>';
    let accounts = [];
    try { const r = await electronAPI.lightningPoolList(); accounts = (r && r.accounts) || []; } catch (_) {}

    // Populate the "Build uses" dropdown (Auto + each account), preserving the saved choice.
    const activeSel = document.getElementById('lightning-active-account');
    if (activeSel) {
        let active = 'auto';
        try { const r = await electronAPI.lightningPoolGetActive(); active = (r && r.id) || 'auto'; } catch (_) {}
        activeSel.innerHTML = '<option value="auto">🔄 Auto-rotate (recommended)</option>' +
            accounts.map((a) => `<option value="${escapeHTML(a.id)}">📌 ${escapeHTML(a.label)}</option>`).join('');
        activeSel.value = accounts.some((a) => a.id === active) ? active : 'auto';
    }

    if (!accounts.length) {
        list.innerHTML = '<div style="color:#888;font-size:12px;padding:8px;background:#1a1726;border-radius:6px;">No accounts yet — add one below to start the rotation pool.</div>';
        return;
    }
    list.innerHTML = '';
    for (const a of accounts) {
        const pct = a.budgetHours > 0 ? Math.min(100, Math.round((a.usedHours / a.budgetHours) * 100)) : 0;
        let badge, badgeColor;
        if (a.exhausted) { badge = 'Spent'; badgeColor = '#f87171'; }
        else if (a.coolingDown) { badge = 'Cooling down'; badgeColor = '#fbbf24'; }
        else if (!a.healthy) { badge = 'Disabled'; badgeColor = '#888'; }
        else { badge = 'Ready'; badgeColor = '#4ade80'; }
        const row = document.createElement('div');
        row.style.cssText = 'background:#1a1726;border:1px solid #2e2640;border-radius:6px;padding:10px 12px;';
        row.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#eee;">${escapeHTML(a.label)}
                <span style="font-size:10px;font-weight:600;color:${badgeColor};border:1px solid ${badgeColor};border-radius:3px;padding:1px 5px;margin-left:6px;">${badge}</span>
              </div>
              <div style="font-size:10px;color:#888;margin-top:2px;">studio: ${escapeHTML(a.studioName)} · key ${escapeHTML(a.apiKeyMasked)}${a.lastError ? ' · ' + escapeHTML(String(a.lastError)).slice(0, 40) : ''}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button data-check="${escapeHTML(a.id)}" title="Boot the Studio, run a real vision test, then stop it — confirms the account actually works" style="padding:4px 9px;font-size:11px;background:#1a2a3a;color:#7dd3fc;border:1px solid #2a4a6a;border-radius:4px;cursor:pointer;">🔍 Check</button>
              <button data-provision="${escapeHTML(a.id)}" title="Install vLLM + serve script on this Studio (one-time, ~10-15 min, no terminal)" style="padding:4px 9px;font-size:11px;background:#2a2440;color:#c4b5fd;border:1px solid #4a3f6e;border-radius:4px;cursor:pointer;">⚙ Set up Studio</button>
              <button data-reset="${escapeHTML(a.id)}" title="Credit refreshed this month — put this account back in play" style="padding:4px 9px;font-size:11px;background:#1e3a2a;color:#4ade80;border:1px solid #2e5a3e;border-radius:4px;cursor:pointer;">↻ Reset</button>
              <button data-remove="${escapeHTML(a.id)}" title="Remove this account from the pool" style="padding:4px 9px;font-size:11px;background:#3a1e1e;color:#f87171;border:1px solid #5a2e2e;border-radius:4px;cursor:pointer;">Remove</button>
            </div>
          </div>
          <div style="margin-top:8px;height:6px;background:#0e0c16;border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${pct >= 90 ? '#f87171' : pct >= 60 ? '#fbbf24' : '#4ade80'};"></div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:10px;color:#999;margin-top:5px;">
            <span>${a.usedHours}h used ·</span>
            <span>budget</span>
            <input type="number" data-budget="${escapeHTML(a.id)}" value="${a.budgetHours}" min="1" step="1" style="width:52px;padding:2px 4px;font-size:11px;background:#0e0c16;color:#eee;border:1px solid #3a3450;border-radius:3px;">
            <span>h · <b style="color:#bbb;">${a.remainingHours}h left</b></span>
          </div>
          <div data-provbox="${escapeHTML(a.id)}" style="display:none;position:relative;margin-top:8px;">
            <button data-provhide="${escapeHTML(a.id)}" title="Hide this log" style="position:absolute;top:5px;right:7px;z-index:1;background:#2e2640;color:#bbb;border:1px solid #4a4060;border-radius:3px;font-size:10px;padding:1px 7px;cursor:pointer;">✕ hide</button>
            <pre data-provlog="${escapeHTML(a.id)}" style="margin:0;padding:8px;padding-top:24px;background:#0b0a12;border:1px solid #2e2640;border-radius:4px;font-size:10px;color:#9fd39f;white-space:pre-wrap;max-height:140px;overflow:auto;"></pre>
          </div>`;
        list.appendChild(row);
    }
    // Restore any in-progress / finished provisioning logs (survive list re-renders).
    Object.keys(_lightningProvLog).forEach((id) => {
        const box = _provBox(id);
        if (box && _lightningProvLog[id].text) { _provShow(id); box.textContent = _lightningProvLog[id].text; }
    });
    // ✕ hide log → dismiss it.
    list.querySelectorAll('[data-provhide]').forEach((b) => b.addEventListener('click', () => {
        const id = b.getAttribute('data-provhide');
        delete _lightningProvLog[id];
        const c = document.querySelector(`[data-provbox="${id}"]`);
        if (c) c.style.display = 'none';
    }));
    // Budget edit → update + recompute "h left".
    list.querySelectorAll('[data-budget]').forEach((inp) => inp.addEventListener('change', async () => {
        const id = inp.getAttribute('data-budget');
        const v = Number(inp.value);
        if (!(v > 0)) { renderLightningAccounts(); return; }
        await electronAPI.lightningPoolUpdate(id, { monthlyBudgetHours: v });
        renderLightningAccounts();
    }));
    // Check → boot the Studio, run a vision test, stop it, report the verdict (persisted log).
    list.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-check');
        b.disabled = true; const orig = b.textContent; b.textContent = '🔍 Checking…';
        _provReset(id, '🔍 Booting Studio → vision test → stop. A few minutes…');
        try {
            const r = await electronAPI.lightningCheck(id);
            const ok = r && r.ok;
            const summary = ok
                ? ((r && r.steps) || r)
                : { error: (r && r.error) || 'check failed', steps: (r && r.steps) || {} };
            _provAppend(id, (ok ? '✅ CHECK PASSED' : '⚠️ CHECK FAILED') + ' — ' + JSON.stringify(summary));
            if (ok) showToast(`✅ ${(r && r.label) || id}: vision works — “${(r.steps && r.steps.visionReply) || 'ok'}”`, 'success');
            else showToast(`⚠️ ${(r && (r.error || (r.steps && r.steps.visionReply))) || 'check failed'}`, 'error');
        } catch (e) { _provAppend(id, '❌ Check error: ' + e.message); showToast('Check error: ' + e.message, 'error'); }
        b.disabled = false; b.textContent = orig; // no re-render — keep the result box visible
    }));
    // Set up Studio → run the provisioner with live progress (no terminal). The log persists
    // across re-renders and a clear ✅/❌ line is written at the end — no silent disappearing.
    list.querySelectorAll('[data-provision]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-provision');
        b.disabled = true; b.textContent = '⚙ Setting up…';
        _provReset(id, '⚙ Starting setup… (keep this open; ~10-15 min the first time)');
        try {
            const r = await electronAPI.lightningProvision(id);
            const ok = r && r.ok;
            _provAppend(id, ok ? '════════════\n✅ DONE — Studio is set up and ready. Click 🔍 Check to verify.'
                               : `════════════\n❌ Setup did NOT finish${r && r.code != null ? ' (exit ' + r.code + ')' : ''}. Read the log above, then retry.`);
            showToast(ok ? 'Studio set up ✓ — ready for builds' : 'Setup did not finish — see the log in the card', ok ? 'success' : 'error');
        } catch (e) { _provAppend(id, '❌ Error: ' + e.message); showToast('Setup error: ' + e.message, 'error'); }
        b.disabled = false; b.textContent = '⚙ Set up Studio'; // no re-render — keep the log + result visible
    }));
    list.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
        await electronAPI.lightningPoolReset(b.getAttribute('data-reset'));
        showToast('Account credit reset ↻', 'success');
        renderLightningAccounts();
    }));
    list.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-remove');
        if (!confirm(`Remove account "${id}" from the rotation pool?`)) return;
        await electronAPI.lightningPoolRemove(id);
        showToast('Account removed', 'info');
        renderLightningAccounts();
    }));
}

function setupVideoControls() {
    // Create a slightly larger SFX pool so dense sections don't drop nearby hits.
    for (let i = 0; i < 8; i++) {
        const audio = document.createElement('audio');
        audio.preload = 'auto';
        audio.className = 'hidden';
        document.body.appendChild(audio);
        state._sfxAudioPool.push({ element: audio, playing: false });
    }
    // Preload all SFX URLs to avoid IPC latency during playback
    preloadSfxUrls();

    // Play button
    if (elements.btnPlay) {
        elements.btnPlay.addEventListener('click', togglePlayback);
    }

    // Mute button
    if (elements.btnMute) {
        elements.btnMute.addEventListener('click', () => {
            state.isMuted = !state.isMuted;
            elements.btnMute.textContent = state.isMuted ? '🔇' : '🔊';
            applyTrackVolumes();
        });
    }

    // Volume slider
    if (elements.volumeSlider) {
        elements.volumeSlider.addEventListener('input', (e) => {
            state.volume = parseFloat(e.target.value);
            applyTrackVolumes();
        });
    }

    // Fullscreen button
    if (elements.btnFullscreen) {
        elements.btnFullscreen.addEventListener('click', () => {
            if (elements.videoContainer) {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    elements.videoContainer.requestFullscreen();
                }
            }
        });
    }
}

const STRUCTURAL_FULLSCREEN_MG_TYPES = new Set([
    'barChart',
    'donutChart',
    'rankingList',
    'timeline',
    'comparisonCard',
    'bulletList',
    'mapChart',
    'articleHighlight',
    'listicleGrid',
]);

function _samePlanVisual(current, source) {
    if (!current || !source) return false;
    if (current.id && source.id && current.id === source.id) return true;
    if (current.clipId && source.clipId && current.clipId === source.clipId) return true;
    return current.type === source.type
        && Math.abs(Number(current.startTime || 0) - Number(source.startTime || 0)) < 0.02;
}

function _applyStructuralPlanRepairs(plan) {
    const allMotionGraphics = Array.isArray(plan?.motionGraphics) ? plan.motionGraphics : [];
    state.motionGraphics = allMotionGraphics.filter(mg => (
        mg
        && !STRUCTURAL_FULLSCREEN_MG_TYPES.has(mg.type)
        && mg.category !== 'fullscreen'
        && mg.trackId !== 'video-track-3'
    ));
    _resolveExplainerUrls(state.motionGraphics);

    const activeStageVisuals = [
        ...(plan?.mgScenes || []),
        ...(plan?.templateScenes || []),
        ...allMotionGraphics.filter(mg => (
            STRUCTURAL_FULLSCREEN_MG_TYPES.has(mg?.type)
            || mg?.category === 'fullscreen'
            || mg?.trackId === 'video-track-3'
        )),
    ].filter(Boolean);
    const authoredFields = [
        '_authoredComposition',
        '_authoredAssets',
        '_authoredNs',
        '_authoredRendered',
    ];
    const repairFields = [
        'startTime',
        'endTime',
        'duration',
        'durationSeconds',
        'durationFrames',
        'durationUnit',
        'animation',
        'animationSpeed',
        'agenticComposition',
        'position',
        'safeZone',
        'sceneIndex',
        'sourceSceneIndex',
        'originalSceneIndex',
        'targetSceneIndex',
    ];

    state.scenes = state.scenes.filter((scene) => {
        if (!scene?.isMGScene) return true;
        const source = activeStageVisuals.find(item => _samePlanVisual(scene, item));
        if (!source) return false;

        for (const field of repairFields) {
            if (Object.prototype.hasOwnProperty.call(source, field)) scene[field] = source[field];
        }
        for (const field of authoredFields) {
            if (Object.prototype.hasOwnProperty.call(source, field)) {
                scene[field] = source[field];
                if (scene.mgData && typeof scene.mgData === 'object') scene.mgData[field] = source[field];
            } else {
                delete scene[field];
                if (scene.mgData && typeof scene.mgData === 'object') delete scene.mgData[field];
            }
        }
        return true;
    });
}

function setupElectronListeners() {
    if (window.electronAPI) {
        window.electronAPI.onBuildProgress((data) => updateProgress(data.percent, data.message));
        window.electronAPI.onRenderProgress((data) => updateProgress(data.percent, data.message));
        window.electronAPI.onBuildEvent?.((evt) => buildLog.handle(evt));

        // Menu commands (Ctrl+Z/C/V/S routed through Electron menu)
        window.electronAPI.onMenuUndo?.(() => undo());
        window.electronAPI.onMenuCopy?.(() => { void handleCopyCommand(); });
        window.electronAPI.onMenuPaste?.(() => { void handlePasteCommand(); });
        window.electronAPI.onMenuSave?.(() => saveProject());
        window.electronAPI.onMenuDelete?.(() => deleteSelectedClips());
        window.electronAPI.onMenuSelectAll?.(() => handleSelectAllCommand());
        window.electronAPI.onMenuNew?.(() => newProject());
        window.electronAPI.onFootageResourcesUpdated?.((settings) => {
            applyFootageResourceSettings(settings, { save: true });
        });
    }

    // QA Studio persists the unified plan in main, then pushes it here so the
    // open editor/compositor reflects the same state immediately.
    window.electronAPI.onQAPlanUpdated?.((payload) => {
        const plan = payload?.videoPlan || payload;
        if (!plan || !plan.scenes) return;
        if (state.projectHydrating && _autoSaveTimer) {
            clearTimeout(_autoSaveTimer);
            _autoSaveTimer = null;
        }
        state.videoPlan = plan;
        if (payload?.revision != null) state.projectRevision = Number(payload.revision) || state.projectRevision;
        if (payload?.planHash) state.projectPlanHash = payload.planHash;
        window._mgBridgeVideoPlan = plan;
        _applyStructuralPlanRepairs(plan);

        const clearWhenAbsent = new Set([
            'cropTop', 'cropRight', 'cropBottom', 'cropLeft',
            'scale', 'posY', 'posX', 'framing', 'framingMode',
            'floatingBackground', 'floatingAnim', 'floatingShadow',
            'flagForReplacement', 'qaFixed', 'qaReplaced', 'qaFixReason', 'qaFixCount',
            'qaReason', 'qaReplacementKeyword', 'qaReplacementSource', 'qaReplacementDiagnosis',
        ]);
        const syncQaFields = (source, target) => {
            if (!source || !target) return;
            for (const field of QA_SYNCABLE_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(source, field)) target[field] = source[field];
                else if (clearWhenAbsent.has(field)) delete target[field];
            }
        };

        const scenesByClipId = new Map();
        const scenesBySource = new Map();
        state.scenes.filter((scene) => !scene.isMGScene).forEach((scene, fallbackIndex) => {
            if (scene.clipId) scenesByClipId.set(scene.clipId, scene);
            const key = getSceneSourceIndex(scene, fallbackIndex);
            if (!scenesBySource.has(key)) scenesBySource.set(key, []);
            scenesBySource.get(key).push(scene);
        });
        plan.scenes.forEach((fixedScene, i) => {
            const exactTarget = fixedScene.clipId ? scenesByClipId.get(fixedScene.clipId) : null;
            const sourceKey = getSceneSourceIndex(fixedScene, i);
            const targets = exactTarget ? [exactTarget] : (scenesBySource.get(sourceKey) || []);
            targets.forEach((target) => syncQaFields(fixedScene, target));
        });

        for (const fixedTemplate of (plan.templateScenes || [])) {
            const target = state.scenes.find((scene) => (
                scene.isMGScene
                && scene.templateType
                && (scene.id === fixedTemplate.id
                    || (scene.type === fixedTemplate.type
                        && Math.abs(Number(scene.startTime) - Number(fixedTemplate.startTime)) < 0.001))
            ));
            if (target) {
                syncQaFields(fixedTemplate, target);
                if (target.mgData) syncQaFields(fixedTemplate, target.mgData);
            }
        }

        renderScenes();
        renderTimeline();
        loadActiveScenes();
        if (state.compositorActive) loadPlanIntoCompositor();
        if (payload?.source === 'motion-qa-preview') {
            const repairCount = Number(payload?.motionQa?.repairCount || 0);
            showToast(`Motion QA fixed ${repairCount} visual issue${repairCount === 1 ? '' : 's'} — preview and timeline updated`, 'success');
            console.log('[Motion QA] Preview repairs patched into the editor and persisted');
        } else {
            showToast('QA fixes applied — compositor updated');
            console.log('[QA] Unified plan patched from QA Studio — fixes active in memory and on disk');
        }
    });

    // Agent changes are committed as full project transactions. Rehydrate the
    // canonical plan so structural edits, visuals, and renderer state stay exact.
    window.electronAPI.onAgentPlanUpdated?.(async (payload) => {
        const plan = payload?.videoPlan || payload;
        if (!plan?.scenes) return;
        const playheadTime = state.currentTime;
        const selectedVisualRef = state.selectedMgIndex >= 0 && state.motionGraphics?.[state.selectedMgIndex]
            ? _agentVisualRef(state.motionGraphics[state.selectedMgIndex], state.selectedMgIndex)
            : null;
        const selectedTransitionRef = state.selectedTransitionIndex >= 0 && state.transitions?.[state.selectedTransitionIndex]
            ? {
                fromClipId: state.transitions[state.selectedTransitionIndex].fromClipId || '',
                toClipId: state.transitions[state.selectedTransitionIndex].toClipId || '',
                startTime: Number(
                    state.transitions[state.selectedTransitionIndex].startTime
                    ?? state.transitions[state.selectedTransitionIndex].at
                ) || 0,
            }
            : null;
        const selectedRefs = (state.selectedClipIndices || [])
            .map((index) => state.scenes[index])
            .filter(Boolean)
            .map((scene, fallbackIndex) => ({
                clipId: scene.clipId || '',
                sourceSceneIndex: getSceneSourceIndex(scene, fallbackIndex),
                startTime: Number(scene.startTime) || 0,
                isMGScene: !!scene.isMGScene,
            }));
        try {
            await loadVideoPlan({
                hyperframesPreviewOptions: {
                    persistMotionQa: false,
                    source: payload?.source || 'editor-agent',
                    transactionId: payload?.transactionId || '',
                },
            });
            const restoredSelection = [];
            selectedRefs.forEach((ref) => {
                const index = state.scenes.findIndex((scene, fallbackIndex) => {
                    if (ref.clipId && scene.clipId === ref.clipId) return true;
                    return !!scene.isMGScene === ref.isMGScene
                        && getSceneSourceIndex(scene, fallbackIndex) === ref.sourceSceneIndex
                        && Math.abs((Number(scene.startTime) || 0) - ref.startTime) < 0.01;
                });
                if (index >= 0 && !restoredSelection.includes(index)) restoredSelection.push(index);
            });
            const restoredVisualIndex = selectedVisualRef
                ? state.motionGraphics.findIndex((visual, index) => {
                    const ref = _agentVisualRef(visual, index);
                    return ref.id === selectedVisualRef.id
                        || (
                            ref.type === selectedVisualRef.type
                            && Math.abs(ref.startTime - selectedVisualRef.startTime) < 0.02
                        );
                })
                : -1;
            const restoredTransitionIndex = selectedTransitionRef
                ? state.transitions.findIndex((transition) => (
                    (
                        String(transition.fromClipId || '') === String(selectedTransitionRef.fromClipId)
                        && String(transition.toClipId || '') === String(selectedTransitionRef.toClipId)
                    )
                    || Math.abs(
                        (Number(transition.startTime ?? transition.at) || 0)
                        - selectedTransitionRef.startTime
                    ) < 0.02
                ))
                : -1;
            state.selectedMgIndex = restoredVisualIndex;
            state.selectedTransitionIndex = restoredVisualIndex >= 0 ? -1 : restoredTransitionIndex;
            if (restoredVisualIndex >= 0) {
                state.selectedClipIndices = [];
                state.selectedClipIndex = -1;
            } else if (restoredTransitionIndex >= 0) {
                state.selectedClipIndices = [];
                state.selectedClipIndex = -1;
            } else {
                state.selectedClipIndices = restoredSelection;
                state.selectedClipIndex = restoredSelection.length
                    ? restoredSelection[restoredSelection.length - 1]
                    : -1;
            }
            await seekToTime(Math.min(playheadTime, state.totalDuration));
            renderTimeline();
            updateClipProperties();
            notifyAgentContextChanged();

            if (payload?.source === 'editor-agent-undo') {
                showToast('Agent edit undone', 'success');
            } else if (payload?.source === 'editor-agent-redo') {
                showToast('Agent edit restored', 'success');
            } else if (payload?.source === 'editor-agent-rollback') {
                showToast('Agent edit was rolled back safely', 'warning');
            } else {
                showToast('Agent edit applied - preview and timeline updated', 'success');
            }
        } catch (error) {
            console.error('[Agent] Failed to rehydrate edited plan:', error);
            showToast(`Agent edit saved, but editor refresh failed: ${error.message}`, 'error');
        }
    });
}

// ========================================
// Test: Inject all 6 new MG types (Ctrl+Shift+M)
// ========================================
function injectTestMotionGraphics() {
    try {
        if (!state.scenes || state.scenes.length === 0) {
            showNotification('Test MG', 'No scenes loaded — build or load a video first', 'error');
            return;
        }

        const totalDur = state.totalDuration || 60;
        const spacing = Math.max(8, totalDur / 7);
        const style = state.mgStyle || 'clean';

        const testMGs = [
            {
                id: 'test-barchart', type: 'barChart',
                text: 'Market Share 2025',
                subtext: 'Apple:85,Samsung:72,Google:58,Huawei:41,Sony:28',
                duration: 6.0, position: 'center',
            },
            {
                id: 'test-donutchart', type: 'donutChart',
                text: 'Survey Results',
                subtext: 'Agree:45,Disagree:30,Unsure:25',
                duration: 6.0, position: 'center',
            },
            {
                id: 'test-comparison', type: 'comparisonCard',
                text: 'iPhone vs Android',
                subtext: 'Which is better?',
                duration: 5.0, position: 'center',
            },
            {
                id: 'test-timeline', type: 'timeline',
                text: 'Company History',
                subtext: '2018:Founded,2020:Series A,2022:IPO,2024:Global',
                duration: 6.5, position: 'center',
            },
            {
                id: 'test-ranking', type: 'rankingList',
                text: 'Top Languages 2025',
                subtext: 'Python:95,JavaScript:88,TypeScript:76,Rust:62,Go:55',
                duration: 6.0, position: 'center-left',
            },
            {
                id: 'test-kinetic', type: 'kineticText',
                text: 'The Future Is Now',
                subtext: 'Steve Jobs',
                duration: 5.0, position: 'center',
            },
        ];

        // Remove any previously injected test MGs
        state.motionGraphics = (state.motionGraphics || []).filter(mg => !mg.id?.startsWith('test-'));

        // Inject evenly spaced across the video
        testMGs.forEach((mg, i) => {
            const startTime = Math.min(spacing * (i + 0.5), totalDur - mg.duration - 0.5);
            state.motionGraphics.push({
                ...mg,
                startTime: Math.max(0, startTime),
                sceneIndex: 0,
                style,
            });
        });

        renderTracks();
        showNotification('Test MG', 'Injected 6 test motion graphics — seek to each to preview', 'success');
        console.log('[Test MG] Injected 6 test MGs. Timestamps:', state.motionGraphics.filter(m => m.id?.startsWith('test-')).map(m => `${m.type} @ ${m.startTime.toFixed(1)}s`));
    } catch (err) {
        console.error('[Test MG] Error:', err);
        showNotification('Test MG', `Error: ${err.message}`, 'error');
    }
}
// Expose for DevTools console access
window.injectTestMotionGraphics = injectTestMotionGraphics;

/**
 * Snap playhead to the next (+1) or previous (-1) clip edge.
 * Collects all unique start/end times from scenes + motion graphics.
 */
function snapToClipEdge(direction) {
    const edges = new Set();
    for (const s of (state.scenes || [])) {
        if (s.startTime != null) edges.add(+s.startTime.toFixed(3));
        if (s.endTime != null) edges.add(+s.endTime.toFixed(3));
    }
    for (const mg of (state.motionGraphics || [])) {
        if (mg.startTime != null) edges.add(+mg.startTime.toFixed(3));
        if (mg.endTime != null) edges.add(+mg.endTime.toFixed(3));
    }
    const sorted = [...edges].sort((a, b) => a - b);
    if (sorted.length === 0) return;

    const now = +state.currentTime.toFixed(3);
    const EPS = 0.005;
    if (direction > 0) {
        const next = sorted.find(t => t > now + EPS);
        if (next != null) seekToTime(next);
    } else {
        const prev = sorted.slice().reverse().find(t => t < now - EPS);
        if (prev != null) seekToTime(prev);
    }
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const textEditor = _editableTextTarget(e.target);

        // Ctrl shortcuts
        if (e.ctrlKey || e.metaKey) {
            if (e.code === 'KeyC') { e.preventDefault(); void handleCopyCommand(); return; }
            if (e.code === 'KeyV') { e.preventDefault(); void handlePasteCommand(); return; }
            if (e.code === 'KeyA') { e.preventDefault(); handleSelectAllCommand(); return; }
            if (textEditor) return;
            if (e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); redo(); return; }
            if (e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
            if (e.code === 'KeyY') { e.preventDefault(); redo(); return; }
            if (e.code === 'KeyS') { e.preventDefault(); saveProject(); return; }
            if (e.code === 'KeyR') { e.preventDefault(); refreshApp(); return; }
        }

        if (textEditor || e.target.tagName === 'SELECT') return;

        // F5 to refresh app
        if (e.code === 'F5') { e.preventDefault(); refreshApp(); return; }

        // Delete selected clips (single or multi)
        if ((e.code === 'Delete' || e.code === 'Backspace') && (state.selectedClipIndices.length > 0 || state.selectedClipIndex >= 0)) {
            e.preventDefault(); deleteSelectedClips(); return;
        }

        // Ctrl+Shift+M: Inject test motion graphics (all 6 new types)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyM') {
            e.preventDefault(); injectTestMotionGraphics(); return;
        }

        // In/Out points (Premiere-style: I = set in, O = set out)
        if (e.code === 'KeyI' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); setInPoint(state.currentTime); return; }
        if (e.code === 'KeyO' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); setOutPoint(state.currentTime); return; }

        if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
        else if (e.shiftKey && e.code === 'KeyF') { e.preventDefault(); zoomToFit(); }
        else if (e.code === 'KeyF') { e.preventDefault(); cutClipAtPlayhead(); }
        else if (e.code === 'ArrowUp') { e.preventDefault(); snapToClipEdge(1); }
        else if (e.code === 'ArrowDown') { e.preventDefault(); snapToClipEdge(-1); }
        else if (e.code === 'ArrowLeft') { e.preventDefault(); seekToTime(state.currentTime - 1); }
        else if (e.code === 'ArrowRight') { e.preventDefault(); seekToTime(state.currentTime + 1); }
        else if (e.code === 'Home') { e.preventDefault(); seekToTime(0); }
        else if (e.code === 'End') { e.preventDefault(); seekToTime(state.totalDuration); }
        else if (e.code === 'Escape') { deselectClip(); clearInOutPoints(); }
    });
}

// ========================================
// In/Out Points (Premiere-style work area)
// ========================================
function setInPoint(timeSec) {
    // If out point exists and in would be >= out, ignore
    if (state.outPoint !== null && timeSec >= state.outPoint) {
        showToast('In point must be before out point', 'warning');
        return;
    }
    state.inPoint = Math.max(0, timeSec);
    showToast(`In: ${formatTime(state.inPoint)}`, 'info');
    renderInOutMarkers();
    updateInOutDisplay();
    notifyAgentContextChanged();
}

function setOutPoint(timeSec) {
    // If in point exists and out would be <= in, ignore
    if (state.inPoint !== null && timeSec <= state.inPoint) {
        showToast('Out point must be after in point', 'warning');
        return;
    }
    state.outPoint = Math.min(timeSec, state.totalDuration);
    showToast(`Out: ${formatTime(state.outPoint)}`, 'info');
    renderInOutMarkers();
    updateInOutDisplay();
    notifyAgentContextChanged();
}

function clearInOutPoints() {
    if (state.inPoint === null && state.outPoint === null) return;
    state.inPoint = null;
    state.outPoint = null;
    showToast('In/Out points cleared', 'info');
    renderInOutMarkers();
    updateInOutDisplay();
    notifyAgentContextChanged();
}

/** Get effective render range in seconds */
function getRenderRange() {
    const timelineEnd = Math.max(0, Number(state.totalDuration) || 0);
    const inSec = Math.max(0, Math.min(timelineEnd, state.inPoint !== null ? Number(state.inPoint) || 0 : 0));
    const outSec = Math.max(inSec, Math.min(timelineEnd, state.outPoint !== null ? Number(state.outPoint) || 0 : timelineEnd));
    return { inSec, outSec, duration: outSec - inSec };
}

function getFrameAlignedRenderRange(fps) {
    const safeFps = Math.max(1, Number(fps) || 30);
    const { inSec, outSec } = getRenderRange();
    const startFrame = Math.max(0, Math.floor(inSec * safeFps + 1e-7));
    const endFrame = Math.max(startFrame + 1, Math.ceil(outSec * safeFps - 1e-7));
    return {
        startFrame,
        endFrame,
        inSec: startFrame / safeFps,
        outSec: endFrame / safeFps,
        duration: (endFrame - startFrame) / safeFps,
    };
}

/** Draw in/out markers + shaded work area on ruler */
function renderInOutMarkers() {
    const ruler = document.getElementById('timeline-ruler');
    const content = document.getElementById('timeline-content');
    if (!ruler) return;
    const zoom = state.timeline.zoom;

    // Remove old markers from ruler and track content
    ruler.querySelectorAll('.in-out-marker, .in-out-shade, .in-out-workarea').forEach(el => el.remove());
    if (content) content.querySelectorAll('.in-out-track-shade, .in-out-track-border').forEach(el => el.remove());

    const hasIn = state.inPoint !== null;
    const hasOut = state.outPoint !== null;
    if (!hasIn && !hasOut) return;

    const inPx = hasIn ? state.inPoint * zoom : 0;
    const outPx = hasOut ? state.outPoint * zoom : state.totalDuration * zoom;

    // Shaded area before in point (dimmed) — ruler
    if (hasIn && inPx > 0) {
        const shade = document.createElement('div');
        shade.className = 'in-out-shade';
        shade.style.cssText = `left:0; width:${inPx}px;`;
        ruler.appendChild(shade);
    }

    // Shaded area after out point (dimmed) — ruler
    if (hasOut) {
        const shade = document.createElement('div');
        shade.className = 'in-out-shade';
        shade.style.cssText = `left:${outPx}px; right:0;`;
        ruler.appendChild(shade);
    }

    // Work area bar (bright bar between in and out) — ruler
    const workarea = document.createElement('div');
    workarea.className = 'in-out-workarea';
    workarea.style.cssText = `left:${inPx}px; width:${outPx - inPx}px;`;
    ruler.appendChild(workarea);

    // In marker
    if (hasIn) {
        const marker = document.createElement('div');
        marker.className = 'in-out-marker in-marker';
        marker.style.left = `${inPx}px`;
        marker.title = `In: ${formatTime(state.inPoint)}`;
        marker.textContent = 'I';
        ruler.appendChild(marker);
    }

    // Out marker
    if (hasOut) {
        const marker = document.createElement('div');
        marker.className = 'in-out-marker out-marker';
        marker.style.left = `${outPx}px`;
        marker.title = `Out: ${formatTime(state.outPoint)}`;
        marker.textContent = 'O';
        ruler.appendChild(marker);
    }

    // Track-level shading — dim areas outside work area on the tracks themselves
    if (content) {
        if (hasIn && inPx > 0) {
            const shade = document.createElement('div');
            shade.className = 'in-out-track-shade';
            shade.style.cssText = `left:0; width:${inPx}px;`;
            content.appendChild(shade);
        }
        if (hasOut) {
            const shade = document.createElement('div');
            shade.className = 'in-out-track-shade';
            shade.style.cssText = `left:${outPx}px; right:0;`;
            content.appendChild(shade);
        }
        // Vertical boundary lines at in/out points
        if (hasIn) {
            const line = document.createElement('div');
            line.className = 'in-out-track-border';
            line.style.left = `${inPx}px`;
            content.appendChild(line);
        }
        if (hasOut) {
            const line = document.createElement('div');
            line.className = 'in-out-track-border';
            line.style.left = `${outPx}px`;
            content.appendChild(line);
        }
    }
}

/** Update the time display to show in/out range if set */
function updateInOutDisplay() {
    const display = document.getElementById('in-out-display');
    if (!display) return;

    if (state.inPoint === null && state.outPoint === null) {
        display.style.display = 'none';
        return;
    }

    const { inSec, outSec, duration } = getRenderRange();
    display.style.display = 'inline-flex';
    display.innerHTML = `
        <span class="in-out-label">Work Area:</span>
        <span class="in-out-range">${formatTime(inSec)} → ${formatTime(outSec)}</span>
        <span class="in-out-duration">(${formatTime(duration)})</span>
        <button class="in-out-clear" title="Clear In/Out (Esc)">✕</button>
    `;
    display.querySelector('.in-out-clear')?.addEventListener('click', clearInOutPoints);
}

// ========================================
// Undo System
// ========================================
// Snapshot ALL editable timeline state (not just scenes) so undo/redo don't
// silently drop motion-graphic / SFX / transition edits. Only real arrays are
// captured; restore assigns back only what was captured (never wipes a field).
const _UNDO_STATE_KEYS = ['scenes', 'motionGraphics', 'mgScenes', 'sfxClips', 'transitions', 'overlayScenes'];
function _snapshotForUndo() {
    const snap = {};
    for (const k of _UNDO_STATE_KEYS) {
        if (Array.isArray(state[k])) snap[k] = JSON.parse(JSON.stringify(state[k]));
    }
    return snap;
}
function _restoreUndoSnapshot(snap) {
    if (!snap) return;
    if (Array.isArray(snap)) { state.scenes = snap; return; } // back-compat: old scenes-only snapshot
    for (const k of Object.keys(snap)) state[k] = snap[k];
}

function pushUndoState() {
    state.undoStack.push(_snapshotForUndo());
    if (state.undoStack.length > state.maxUndoLevels) {
        state.undoStack.shift();
    }
    // Any new action invalidates the redo stack
    state.redoStack = [];
    // Trigger auto-save to .fvp file (debounced)
    triggerAutoSave();
}

function undo() {
    if (state.undoStack.length === 0) {
        showToast('Nothing to undo', 'info');
        return;
    }
    // Save current state to redo stack before restoring
    state.redoStack.push(_snapshotForUndo());
    _restoreUndoSnapshot(state.undoStack.pop());
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    state.selectedMgIndex = -1;
    state.selectedTransitionIndex = -1;
    recalcTotalDuration();
    renderTimeline();
    updateClipProperties();
    // Reload preview to match restored scene state
    loadActiveScenes();
    showToast('Undo', 'info');
}

function redo() {
    if (state.redoStack.length === 0) {
        showToast('Nothing to redo', 'info');
        return;
    }
    // Save current state to undo stack before redoing
    state.undoStack.push(_snapshotForUndo());
    _restoreUndoSnapshot(state.redoStack.pop());
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    state.selectedMgIndex = -1;
    state.selectedTransitionIndex = -1;
    recalcTotalDuration();
    renderTimeline();
    updateClipProperties();
    // Reload preview to match restored scene state
    loadActiveScenes();
    showToast('Redo', 'info');
}

// ========================================
// Clipboard (Copy / Paste / Delete)
// ========================================
function _editableTextTarget(node = document.activeElement) {
    const element = node?.nodeType === Node.ELEMENT_NODE
        ? node
        : node?.parentElement;
    const editor = element?.closest?.(
        'textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"]'
    );
    if (!editor || editor.disabled || editor.readOnly) return null;
    if (editor.tagName !== 'INPUT') return editor;
    const type = String(editor.type || 'text').toLowerCase();
    return [
        'text', 'search', 'email', 'url', 'tel', 'password', 'number',
    ].includes(type) ? editor : null;
}

function _textClipboardContext() {
    const editor = _editableTextTarget();
    if (
        editor
        && (editor.tagName === 'INPUT' || editor.tagName === 'TEXTAREA')
        && Number.isInteger(editor.selectionStart)
        && Number.isInteger(editor.selectionEnd)
    ) {
        const start = Math.min(editor.selectionStart, editor.selectionEnd);
        const end = Math.max(editor.selectionStart, editor.selectionEnd);
        return {
            editor,
            text: end > start ? editor.value.slice(start, end) : '',
            isTextContext: true,
        };
    }
    const selection = window.getSelection?.();
    const text = selection && !selection.isCollapsed ? selection.toString() : '';
    return {
        editor,
        text,
        isTextContext: Boolean(editor || text),
    };
}

async function _writeTextClipboard(text) {
    if (window.electronAPI?.writeClipboardText) {
        return window.electronAPI.writeClipboardText(text);
    }
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return { success: true };
    }
    return { success: false, error: 'Clipboard API is unavailable' };
}

async function _readTextClipboard() {
    if (window.electronAPI?.readClipboardText) {
        return window.electronAPI.readClipboardText();
    }
    if (navigator.clipboard?.readText) {
        return { success: true, text: await navigator.clipboard.readText() };
    }
    return { success: false, error: 'Clipboard API is unavailable', text: '' };
}

async function handleCopyCommand() {
    const context = _textClipboardContext();
    if (!context.isTextContext) {
        copySelectedClip();
        return false;
    }
    if (!context.text) return true;
    const result = await _writeTextClipboard(context.text);
    if (!result?.success) {
        showToast(result?.error || 'Could not copy text', 'error');
    }
    return true;
}

function _replaceEditorSelection(editor, text) {
    editor.focus();
    if (editor.tagName === 'INPUT' || editor.tagName === 'TEXTAREA') {
        const start = Number.isInteger(editor.selectionStart)
            ? editor.selectionStart
            : editor.value.length;
        const end = Number.isInteger(editor.selectionEnd)
            ? editor.selectionEnd
            : start;
        editor.setRangeText(text, start, end, 'end');
    } else {
        const selection = window.getSelection();
        let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !editor.contains(range.commonAncestorContainer)) {
            range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
        }
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
}

async function handlePasteCommand() {
    const editor = _editableTextTarget();
    if (!editor) {
        pasteClip();
        return false;
    }
    const result = await _readTextClipboard();
    if (!result?.success) {
        showToast(result?.error || 'Could not read the clipboard', 'error');
        return true;
    }
    _replaceEditorSelection(editor, String(result.text || ''));
    return true;
}

function handleSelectAllCommand() {
    const editor = _editableTextTarget();
    if (!editor) {
        selectAllClips();
        return false;
    }
    editor.focus();
    if (editor.tagName === 'INPUT' || editor.tagName === 'TEXTAREA') {
        editor.select();
    } else {
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }
    return true;
}

function selectClip(index, ctrlKey = false) {
    if (ctrlKey) {
        // Multi-select: toggle this clip in the selection
        const pos = state.selectedClipIndices.indexOf(index);
        if (pos >= 0) {
            state.selectedClipIndices.splice(pos, 1);
        } else {
            state.selectedClipIndices.push(index);
        }
        // Primary selection = last added (for properties panel)
        state.selectedClipIndex = state.selectedClipIndices.length > 0
            ? state.selectedClipIndices[state.selectedClipIndices.length - 1]
            : -1;
    } else {
        // Single select: clear others
        state.selectedClipIndices = [index];
        state.selectedClipIndex = index;
    }
    // Deselect any MG selection
    state.selectedMgIndex = -1;
    state.selectedTransitionIndex = -1;
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.transition-marker.selected').forEach(c => c.classList.remove('selected'));
    // Update visual selection
    document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
    state.selectedClipIndices.forEach(idx => {
        const clip = document.querySelector(`.timeline-clip[data-index="${idx}"]`);
        if (clip) clip.classList.add('selected');
    });
    updateClipProperties();
    applySceneTransform(state.selectedClipIndex);
    notifyAgentContextChanged();
}

function selectAllClips() {
    if (state.scenes.length === 0) return;
    state.selectedClipIndices = state.scenes.map((_, i) => i);
    state.selectedClipIndex = state.selectedClipIndices[state.selectedClipIndices.length - 1];
    state.selectedMgIndex = -1;
    state.selectedTransitionIndex = -1;
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.transition-marker.selected').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => c.classList.add('selected'));
    updateClipProperties();
    const count = state.selectedClipIndices.length;
    showToast(`Selected all ${count} clips`, 'info');
    notifyAgentContextChanged();
}

function deselectClip() {
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    state.selectedMgIndex = -1;
    state.selectedTransitionIndex = -1;
    clearSceneTransform();
    document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.transition-marker.selected').forEach(c => c.classList.remove('selected'));
    updateClipProperties();
    notifyAgentContextChanged();
}

function copySelectedClip() {
    if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) {
        showToast('No clip selected to copy', 'info');
        return;
    }
    state.clipboard = JSON.parse(JSON.stringify(state.scenes[state.selectedClipIndex]));
    showToast('Clip copied', 'info');
}

function pasteClip() {
    if (!state.clipboard) {
        showToast('Nothing to paste', 'info');
        return;
    }
    pushUndoState();
    const clip = JSON.parse(JSON.stringify(state.clipboard));
    // Place at current playhead position
    const duration = clip.endTime - clip.startTime;
    clip.startTime = state.currentTime;
    clip.endTime = state.currentTime + duration;
    clip.duration = duration;
    clip.durationFrames = Math.max(1, Math.round(duration * (state.videoPlan?.fps || 30)));
    clip.durationUnit = 'seconds';
    clip.sourceSceneIndex = getSceneSourceIndex(clip, clip.index);
    // A paste is a new timeline instance, but it still resolves the same source media.
    clip.clipId = createUniqueClipId(clip, 'paste');
    state.scenes.push(clip);
    state.scenes.sort((a, b) => a.startTime - b.startTime);
    recalcTotalDuration();
    renderTimeline();
    showToast('Clip pasted', 'info');
}

function deleteSelectedClip() {
    // Legacy single-clip delete, now delegates to multi
    deleteSelectedClips();
}

function deleteSelectedClips() {
    // Collect indices to delete (multi-select or single)
    let toDelete = [...state.selectedClipIndices];
    if (toDelete.length === 0 && state.selectedClipIndex >= 0) {
        toDelete = [state.selectedClipIndex];
    }
    toDelete = toDelete.filter(i => i >= 0 && i < state.scenes.length);
    if (toDelete.length === 0) return;

    pushUndoState();
    // Sort descending so splicing doesn't shift indices
    toDelete.sort((a, b) => b - a);
    for (const idx of toDelete) {
        state.scenes.splice(idx, 1);
    }
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    state.selectedTransitionIndex = -1;
    recalcTotalDuration();
    renderTimeline();
    showToast(`${toDelete.length} clip${toDelete.length > 1 ? 's' : ''} deleted`, 'info');
}

// ========================================
// Cut Clip at Playhead (F key)
// ========================================
function cutClipAtPlayhead() {
    const idx = getSceneAtTime(state.currentTime);
    if (idx < 0) {
        showToast('No clip at playhead to cut', 'info');
        return;
    }
    const scene = state.scenes[idx];

    // Can't cut MG scenes (no media file to split)
    if (scene.isMGScene) {
        showToast('Cannot cut motion graphic scenes', 'info');
        return;
    }

    const cutTime = state.currentTime;

    // Don't cut if too close to edges (min 0.2s per piece)
    if (cutTime - scene.startTime < 0.2 || scene.endTime - cutTime < 0.2) {
        showToast('Clip too short to cut here', 'info');
        return;
    }

    pushUndoState();

    // Create the second half (right side of cut)
    const rightClip = JSON.parse(JSON.stringify(scene));
    rightClip.startTime = cutTime;
    rightClip.clipId = createUniqueClipId(scene, 'cut');
    rightClip.sourceSceneIndex = getSceneSourceIndex(scene, scene.index);
    // mediaOffset tracks how far into the source video this clip starts
    rightClip.mediaOffset = (scene.mediaOffset || 0) + (cutTime - scene.startTime);
    rightClip.duration = rightClip.endTime - rightClip.startTime;
    rightClip.durationFrames = Math.max(1, Math.round(rightClip.duration * (state.videoPlan?.fps || 30)));
    rightClip.durationUnit = 'seconds';

    // Trim the original (left side of cut)
    scene.endTime = cutTime;
    scene.duration = scene.endTime - scene.startTime;
    scene.durationFrames = Math.max(1, Math.round(scene.duration * (state.videoPlan?.fps || 30)));
    scene.durationUnit = 'seconds';

    // Insert right clip after the original
    state.scenes.splice(idx + 1, 0, rightClip);
    recalcTotalDuration();
    renderTimeline();
    showToast('Clip cut at playhead (F)', 'info');
}

// Recalculate totalDuration from scenes + audio
function recalcTotalDuration() {
    const scenesEnd = state.scenes.length > 0 ? Math.max(...state.scenes.map(s => s.endTime)) : 0;
    const audioDur = (elements.previewAudio && isFinite(elements.previewAudio.duration)) ? elements.previewAudio.duration : 0;
    state.totalDuration = Math.max(scenesEnd, audioDur);
}

// ========================================
// Clip Properties (Scale / Position)
// ========================================
function updateClipProperties() {
    const panel = elements.clipProperties;
    const overlayPanel = document.getElementById('overlay-properties');
    const mgPanel = document.getElementById('mg-properties');
    const mapPanel = document.getElementById('map-properties');
    const listiclePanel = document.getElementById('listicle-properties');
    const templatePanel = document.getElementById('template-properties');
    const emptyState = document.getElementById('properties-empty');
    const titleEl = document.getElementById('properties-title');

    // Hide all panels first
    if (panel) panel.classList.add('hidden');
    if (overlayPanel) overlayPanel.classList.add('hidden');
    if (mgPanel) mgPanel.classList.add('hidden');
    if (mapPanel) mapPanel.classList.add('hidden');
    if (listiclePanel) listiclePanel.classList.add('hidden');
    if (templatePanel) templatePanel.classList.add('hidden');

    // MG selected?
    if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
        if (emptyState) emptyState.classList.add('hidden');
        const mgTypeLabels = { headline: 'Headline', lowerThird: 'Lower Third', statCounter: 'Stat Counter', callout: 'Callout', bulletList: 'Bullet List', focusWord: 'Focus Word', progressBar: 'Progress Bar', kineticText: 'Kinetic Text', explainer: 'Explainer', typewriter: 'Typewriter', listicleCounter: 'Listicle Item' };
        const mg = state.motionGraphics[state.selectedMgIndex];
        const mgType = mg.type;
        if (titleEl) titleEl.textContent = mgTypeLabels[mgType] || 'Motion Graphic';

        // Listicle types get their own dedicated panel
        if (LISTICLE_TYPES.has(mgType)) {
            updateListicleProperties(mg);
            expandPropertiesSection();
            return;
        }

        updateMgProperties();
        expandPropertiesSection();
        return;
    }

    // No scene selected?
    if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (titleEl) titleEl.textContent = 'Properties';
        return;
    }

    const scene = state.scenes[state.selectedClipIndex];

    // Full-screen MG scene on V3 — show MG properties panel
    if (scene.isMGScene) {
        if (emptyState) emptyState.classList.add('hidden');
        const mgData = scene.mgData || scene;
        state.selectedMgIndex = -1; // Not from MG track
        state._selectedMgScene = scene; // Temp reference for panel

        // Map scenes get their own dedicated panel
        if (scene.type === 'mapChart') {
            if (titleEl) titleEl.textContent = 'Map';
            updateMapProperties(scene);
            expandPropertiesSection();
            return;
        }

        // Listicle Templates get their own dedicated panel (separate from MGs)
        if (TEMPLATE_TYPES.has(scene.type)) {
            const reg = TEMPLATE_REGISTRY[scene.type];
            if (titleEl) titleEl.textContent = (reg ? reg.label : null) || 'Template';
            updateTemplateProperties(mgData);
            expandPropertiesSection();
            return;
        }

        const mgTypeLabels = { barChart: 'Bar Chart', donutChart: 'Donut Chart', rankingList: 'Ranking List', timeline: 'Timeline', comparisonCard: 'Comparison', bulletList: 'Bullet List', articleHighlight: 'Article' };
        if (titleEl) titleEl.textContent = mgTypeLabels[scene.type] || 'Motion Graphic';

        updateMgPropertiesForScene(scene);
        expandPropertiesSection();
        return;
    }

    // Regular video/image clip
    if (!panel) return;
    if (emptyState) emptyState.classList.add('hidden');
    if (titleEl) titleEl.textContent = 'Clip Properties';
    panel.classList.remove('hidden');
    expandPropertiesSection();

    const scale = scene.scale !== undefined ? scene.scale : 1;
    const posX = scene.posX || 0;
    const posY = scene.posY || 0;

    if (elements.propScale) { elements.propScale.value = scale; }
    if (elements.propPosX) { elements.propPosX.value = posX; }
    if (elements.propPosY) { elements.propPosY.value = posY; }
    if (elements.propScaleVal) { elements.propScaleVal.value = scale.toFixed(2); }
    if (elements.propPosXVal) { elements.propPosXVal.value = `${posX}%`; }
    if (elements.propPosYVal) { elements.propPosYVal.value = `${posY}%`; }

    // Hide volume for images (no audio)
    const volumeRow = document.getElementById('prop-volume-row');
    const isImage = scene.mediaType === 'image';
    if (volumeRow) volumeRow.style.display = isImage ? 'none' : '';

    const volume = scene.volume !== undefined ? scene.volume : 1;
    if (elements.propVolume) { elements.propVolume.value = volume; }
    if (elements.propVolumeVal) { elements.propVolumeVal.value = `${Math.round(volume * 100)}%`; }

    // Background dropdown
    if (elements.propBackground) {
        elements.propBackground.value = scene.background || 'none';
    }
    // Fit mode dropdown
    if (elements.propFitMode) {
        elements.propFitMode.value = scene.fitMode || 'cover';
    }

    // Overlay-specific controls (compositor directives on any upper track)
    const isV2Overlay = !!scene._compositorDirective;
    const slideDirRow = document.getElementById('prop-slide-dir-row');
    const slideSpeedRow = document.getElementById('prop-slide-speed-row');
    const bgBlurRow = document.getElementById('prop-bg-blur-row');
    const bgRow = elements.propBackground?.closest('.property-row');
    const fitRow = elements.propFitMode?.closest('.property-row');
    if (slideDirRow) slideDirRow.style.display = isV2Overlay ? '' : 'none';
    if (slideSpeedRow) slideSpeedRow.style.display = isV2Overlay ? '' : 'none';
    if (bgBlurRow) bgBlurRow.style.display = isV2Overlay ? '' : 'none';
    if (bgRow) bgRow.style.display = isV2Overlay ? 'none' : '';
    if (fitRow) fitRow.style.display = isV2Overlay ? 'none' : '';
    if (isV2Overlay) {
        const slideDirEl = document.getElementById('prop-slide-dir');
        const bgBlurEl = document.getElementById('prop-bg-blur');
        const slideSpeedEl = document.getElementById('prop-slide-speed');
        const slideSpeedValEl = document.getElementById('prop-slide-speed-val');
        if (slideDirEl) slideDirEl.value = scene.slideDirection || 'auto';
        if (bgBlurEl) bgBlurEl.value = scene.bgBlur || 'none';
        const spd = scene.slideDuration || 0.4;
        if (slideSpeedEl) slideSpeedEl.value = spd;
        if (slideSpeedValEl) slideSpeedValEl.textContent = `${spd}s`;
    }

    // Crop sliders
    const cropTop = scene.cropTop || 0;
    const cropBottom = scene.cropBottom || 0;
    const cropLeft = scene.cropLeft || 0;
    const cropRight = scene.cropRight || 0;
    if (elements.propCropTop) { elements.propCropTop.value = cropTop; }
    if (elements.propCropBottom) { elements.propCropBottom.value = cropBottom; }
    if (elements.propCropLeft) { elements.propCropLeft.value = cropLeft; }
    if (elements.propCropRight) { elements.propCropRight.value = cropRight; }
    if (elements.propCropTopVal) { elements.propCropTopVal.value = `${cropTop}%`; }
    if (elements.propCropBottomVal) { elements.propCropBottomVal.value = `${cropBottom}%`; }
    if (elements.propCropLeftVal) { elements.propCropLeftVal.value = `${cropLeft}%`; }
    if (elements.propCropRightVal) { elements.propCropRightVal.value = `${cropRight}%`; }

    // Border radius slider
    const borderRadius = scene.borderRadius || 0;
    if (elements.propBorderRadius) { elements.propBorderRadius.value = borderRadius; }
    if (elements.propBorderRadiusVal) { elements.propBorderRadiusVal.value = `${borderRadius}%`; }

    // Floating frame section — show for all V1 scenes, expand controls when floating
    if (elements.propFloatingSection) {
        const isV1 = !scene.trackId || scene.trackId === 'video-track-1';
        elements.propFloatingSection.style.display = isV1 ? '' : 'none';
        if (isV1) {
            const framing = scene.framing || 'fullscreen';
            if (elements.propFraming) elements.propFraming.value = framing;
            const isFloating = framing === 'floating';
            if (elements.propFloatingControls) elements.propFloatingControls.style.display = isFloating ? '' : 'none';
            if (isFloating) {
                const shadowVal = typeof scene.shadow === 'number' ? scene.shadow : (scene.shadow ? 0.5 : 0);
                if (elements.propShadow) elements.propShadow.value = shadowVal;
                if (elements.propShadowVal) elements.propShadowVal.value = shadowVal.toFixed(2);
                if (elements.propFloatingAnim) elements.propFloatingAnim.value = scene.floatingAnim || 'slideRight';
                const animDur = scene.floatingAnimDuration || 0.6;
                if (elements.propFloatingAnimDur) elements.propFloatingAnimDur.value = animDur;
                if (elements.propFloatingAnimDurVal) elements.propFloatingAnimDurVal.value = animDur.toFixed(2) + 's';

            }
        }
    }

    // Effects controls
    _populateEffectControls(scene);

    // Animate checkbox (only for images)
    if (elements.propAnimateRow) {
        const isImage = scene.mediaType === 'image';
        elements.propAnimateRow.style.display = isImage ? '' : 'none';
        if (isImage && elements.propAnimate) {
            const kbEnabled = scene.kenBurnsEnabled !== false;
            elements.propAnimate.checked = kbEnabled;
            // Show/hide speed slider based on checkbox
            if (elements.propKbSpeedRow) {
                elements.propKbSpeedRow.style.display = kbEnabled ? '' : 'none';
            }
            if (elements.propKbSpeed) {
                const speed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
                elements.propKbSpeed.value = speed;
            }
            if (elements.propKbSpeedVal) {
                const speed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
                elements.propKbSpeedVal.textContent = speed.toFixed(1) + 'x';
            }
        }
    }
}

// ── Effect Presets Registry ──
// Each preset defines: effects[] (shader toggles), params (per-effect values),
// mask (global mask), sliders[] (which UI sliders to show), themes[] (relevant themes)
// To add a new preset: add an entry here — UI builds automatically
// Load effect presets from shared module (via preload) — single source of truth
const EFFECT_PRESETS = window._effectPresets || {
    none: { label: 'None', description: 'No effect', effects: [], params: {}, mask: null, sliders: [], themes: ['*'] }
};

const MASK_TYPES = [
    { value: 'none', label: 'No Mask' },
    { value: 'radialCenter', label: 'Soft Center' },
    { value: 'radialEdge', label: 'Soft Edges' },
    { value: 'linearTB', label: 'Top → Bottom' }
];

function _populateEffectControls(scene) {
    const section = document.getElementById('prop-effects-section');
    const list = document.getElementById('prop-effects-list');
    if (!section || !list) return;

    section.style.display = '';
    list.innerHTML = '';

    if (!scene.effectOverrides) scene.effectOverrides = {};
    if (!scene.effectMask) scene.effectMask = {};

    const activeTheme = _resolveActiveTheme() || 'standard';
    const currentPreset = scene.effectPreset || 'none';

    // ── Preset dropdown ──
    const presetRow = document.createElement('div');
    presetRow.className = 'effect-control-row';
    const presetLabel = document.createElement('span');
    presetLabel.className = 'effect-label';
    presetLabel.textContent = 'Effect';
    const presetSelect = document.createElement('select');
    presetSelect.className = 'property-select effect-preset-select';
    presetSelect.style.cssText = 'flex:1; font-size:0.6rem; height:22px;';

    // Order: 'none' first, then theme-relevant, then rest
    const allKeys = Object.keys(EFFECT_PRESETS);
    const themeFirst = allKeys.filter(k => {
        const p = EFFECT_PRESETS[k];
        return k !== 'none' && p.themes && (p.themes.includes('*') || p.themes.includes(activeTheme));
    });
    const rest = allKeys.filter(k => k !== 'none' && !themeFirst.includes(k));
    const ordered = ['none', ...themeFirst, ...rest];

    for (const key of ordered) {
        const p = EFFECT_PRESETS[key];
        if (!p) continue;
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = p.label;
        // Mark theme-relevant with a star
        if (key !== 'none' && p.themes && p.themes.includes(activeTheme)) {
            opt.textContent = '★ ' + p.label;
        }
        if (key === currentPreset) opt.selected = true;
        presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener('change', () => {
        if (state.selectedClipIndex < 0) return;
        _applyEffectPreset(state.selectedClipIndex, presetSelect.value);
        _populateEffectControls(state.scenes[state.selectedClipIndex]);
        _syncEffectToCompositor(state.selectedClipIndex);
    });
    presetRow.appendChild(presetLabel);
    presetRow.appendChild(presetSelect);
    list.appendChild(presetRow);

    // If none selected, stop here
    if (currentPreset === 'none') return;

    const preset = EFFECT_PRESETS[currentPreset];
    if (!preset) return;

    // ── Preset sliders (Intensity, Speed, Warmth etc) ──
    if (preset.sliders) {
        for (const sl of preset.sliders) {
            if (!scene._presetSliders) scene._presetSliders = {};
            const val = scene._presetSliders[sl.key] !== undefined ? scene._presetSliders[sl.key] : sl.def;

            const row = document.createElement('div');
            row.className = 'effect-control-row';
            const lbl = document.createElement('span');
            lbl.className = 'effect-label';
            lbl.textContent = sl.label;
            const slider = document.createElement('input');
            slider.type = 'range'; slider.className = 'effect-slider';
            slider.min = sl.min; slider.max = sl.max; slider.step = 1; slider.value = val;
            const valSpan = document.createElement('span');
            valSpan.className = 'effect-value';
            valSpan.textContent = Math.round(val);

            slider.addEventListener('input', () => {
                if (state.selectedClipIndex < 0) return;
                const s = state.scenes[state.selectedClipIndex];
                if (!s._presetSliders) s._presetSliders = {};
                const v = parseInt(slider.value);
                s._presetSliders[sl.key] = v;
                valSpan.textContent = v;
                _applyPresetSliders(state.selectedClipIndex);
                _syncEffectToCompositor(state.selectedClipIndex);
            });

            row.appendChild(lbl);
            row.appendChild(slider);
            row.appendChild(valSpan);
            list.appendChild(row);
        }
    }

    // ── Global mask row ──
    const maskRow = document.createElement('div');
    maskRow.className = 'effect-control-row effect-mask-row';
    const maskLabel = document.createElement('span');
    maskLabel.className = 'effect-label';
    maskLabel.textContent = 'Mask';
    const maskSelect = document.createElement('select');
    maskSelect.className = 'property-select effect-mask-select';
    maskSelect.style.cssText = 'flex:0 0 90px; font-size:0.6rem; height:22px;';
    for (const mt of MASK_TYPES) {
        const opt = document.createElement('option');
        opt.value = mt.value;
        opt.textContent = mt.label;
        if (mt.value === (scene.effectMask.type || 'none')) opt.selected = true;
        maskSelect.appendChild(opt);
    }
    const maskSlider = document.createElement('input');
    maskSlider.type = 'range'; maskSlider.className = 'effect-slider';
    maskSlider.min = 0; maskSlider.max = 1; maskSlider.step = 0.05;
    maskSlider.value = scene.effectMask.strength !== undefined ? scene.effectMask.strength : 0.8;
    const maskIsNone = (scene.effectMask.type || 'none') === 'none';
    maskSlider.style.display = maskIsNone ? 'none' : '';
    const maskVal = document.createElement('span');
    maskVal.className = 'effect-value';
    maskVal.textContent = maskIsNone ? '' : Math.round((scene.effectMask.strength || 0.8) * 100) + '%';

    maskSelect.addEventListener('change', () => {
        if (state.selectedClipIndex < 0) return;
        const s = state.scenes[state.selectedClipIndex];
        if (!s.effectMask) s.effectMask = {};
        s.effectMask.type = maskSelect.value;
        const isNone = maskSelect.value === 'none';
        maskSlider.style.display = isNone ? 'none' : '';
        maskVal.textContent = isNone ? '' : Math.round(parseFloat(maskSlider.value) * 100) + '%';
        _syncEffectToCompositor(state.selectedClipIndex);
    });
    maskSlider.addEventListener('input', () => {
        if (state.selectedClipIndex < 0) return;
        const s = state.scenes[state.selectedClipIndex];
        if (!s.effectMask) s.effectMask = {};
        s.effectMask.strength = parseFloat(maskSlider.value);
        maskVal.textContent = Math.round(parseFloat(maskSlider.value) * 100) + '%';
        _syncEffectToCompositor(state.selectedClipIndex);
    });
    maskRow.appendChild(maskLabel);
    maskRow.appendChild(maskSelect);
    maskRow.appendChild(maskSlider);
    maskRow.appendChild(maskVal);
    list.appendChild(maskRow);
}

// Apply a preset — sets effects, params, mask from the preset definition
function _applyEffectPreset(sceneIndex, presetKey) {
    const s = state.scenes[sceneIndex];
    if (!s) return;
    s.effectPreset = presetKey;
    const preset = EFFECT_PRESETS[presetKey];
    if (!preset) return;

    s.effects = preset.effects ? [...preset.effects] : [];
    s.effectOverrides = {};
    if (preset.params) {
        for (const [fx, params] of Object.entries(preset.params)) {
            s.effectOverrides[fx] = { ...params, enabled: true };
        }
    }
    if (preset.mask) {
        s.effectMask = { ...preset.mask };
    } else {
        s.effectMask = { type: 'none', strength: 0.8 };
    }
    // Reset slider values to defaults
    s._presetSliders = {};
    if (preset.sliders) {
        for (const sl of preset.sliders) {
            s._presetSliders[sl.key] = sl.def;
        }
    }
}

// Scale preset params based on slider values (Intensity/Speed/Warmth)
function _applyPresetSliders(sceneIndex) {
    const s = state.scenes[sceneIndex];
    if (!s || !s.effectPreset) return;
    const preset = EFFECT_PRESETS[s.effectPreset];
    if (!preset || !preset.params) return;
    const sliders = s._presetSliders || {};

    // Intensity slider (0-100) scales all effect intensities
    const intensityMul = (sliders.intensity !== undefined ? sliders.intensity : 50) / 50; // 1.0 at 50
    // Speed slider (0-100) scales all speed/animation params
    const speedMul = (sliders.speed !== undefined ? sliders.speed : 50) / 50;
    // Warmth slider (0-100) scales tint strength and light leak warmth
    const warmthMul = (sliders.warmth !== undefined ? sliders.warmth : 50) / 50;
    // Border slider (0-100) scales filmFrame border size
    const borderMul = (sliders.border !== undefined ? sliders.border : 50) / 50;

    // Rebuild overrides from preset base, scaled by sliders
    s.effectOverrides = {};
    for (const [fx, baseParams] of Object.entries(preset.params)) {
        const scaled = { ...baseParams, enabled: true };
        // Scale intensity-like params
        if (scaled.intensity !== undefined) scaled.intensity = baseParams.intensity * intensityMul;
        if (scaled.density !== undefined) scaled.density = baseParams.density * intensityMul;
        if (scaled.desaturation !== undefined) scaled.desaturation = Math.min(1, baseParams.desaturation * intensityMul);
        if (scaled.tintStrength !== undefined) scaled.tintStrength = Math.min(1, baseParams.tintStrength * (warmthMul !== undefined ? warmthMul : intensityMul));
        if (scaled.warmth !== undefined) scaled.warmth = Math.min(1, baseParams.warmth * (warmthMul !== undefined ? warmthMul : 1));
        // Scale speed-like params
        if (scaled.speed !== undefined) scaled.speed = baseParams.speed * speedMul;
        // Scale border-like params (filmFrame)
        if (scaled.border !== undefined) scaled.border = Math.min(0.12, baseParams.border * borderMul);
        if (scaled.radius !== undefined && fx === 'filmFrame') scaled.radius = Math.min(0.08, baseParams.radius * borderMul);
        s.effectOverrides[fx] = scaled;
    }
}

function _fmtEffectVal(fx, val) {
    if (fx === 'chromatic') return val.toFixed(3);
    if (val >= 1) return val.toFixed(1);
    return val.toFixed(2);
}

function _syncEffectToCompositor(sceneIndex) {
    if (!state.compositorActive || !state.compositor || !state.compositor.isInitialized) return;
    const sg = state.compositor.sceneGraph;
    if (!sg) return;
    const srcScene = state.scenes[sceneIndex];
    if (!srcScene) return;
    const target = sg._scenes.find(s => (
        (srcScene.clipId && s.clipId === srcScene.clipId)
        || (!srcScene.clipId && s.index === srcScene.index)
    ));
    if (!target) return;
    target.effects = srcScene.effects;
    target.effectOverrides = srcScene.effectOverrides;
    target.effectMask = srcScene.effectMask;
    // Re-render
    const fps = state.compositor.fps;
    const frame = Math.round((state.currentTime || 0) * fps);
    state.compositor.renderFrame(frame);
}

function expandPropertiesSection() {
    const section = document.getElementById('properties-section');
    if (section) section.classList.remove('collapsed');
}

function updateOverlayProperties(scene) {
    const panel = document.getElementById('overlay-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const intensity = scene.overlayIntensity !== undefined ? scene.overlayIntensity : 0.5;
    const blend = scene.blendMode || 'screen';
    const scale = scene.scale !== undefined ? scene.scale : 1;

    const intensityEl = document.getElementById('overlay-intensity');
    const intensityVal = document.getElementById('overlay-intensity-val');
    const blendEl = document.getElementById('overlay-blend');
    const scaleEl = document.getElementById('overlay-scale');
    const scaleVal = document.getElementById('overlay-scale-val');

    if (intensityEl) intensityEl.value = intensity;
    if (intensityVal) intensityVal.textContent = `${Math.round(intensity * 100)}%`;
    if (blendEl) blendEl.value = blend;
    if (scaleEl) scaleEl.value = scale;
    if (scaleVal) scaleVal.textContent = scale.toFixed(2);
}

function updateMgProperties() {
    const panel = document.getElementById('mg-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = state.motionGraphics[state.selectedMgIndex];
    if (!mg) return;

    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const durVal = document.getElementById('mg-duration-val');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    if (textEl) textEl.value = mg.text || '';
    if (subtextEl) subtextEl.value = mg.subtext || '';
    if (posEl) posEl.value = mg.position || 'center';
    if (durEl) durEl.value = mg.duration || 3;
    if (durVal) durVal.textContent = `${(mg.duration || 3).toFixed(1)}s`;
    if (typeEl) typeEl.value = mg.type || 'headline';
    if (styleEl) styleEl.value = mg.style || state.mgStyle || 'clean';
    _filterTypeDropdownByGroup(mg.type || 'headline');

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    const animSpeedVal = document.getElementById('mg-anim-speed-val');
    if (animSpeedEl) animSpeedEl.value = mg.animationSpeed || 1;
    if (animSpeedVal) animSpeedVal.textContent = `${(mg.animationSpeed || 1).toFixed(1)}x`;

    // Hide background dropdown for overlay MGs (only for fullscreen MG scenes)
    const mgBgRow = document.getElementById('mg-bg-row');
    if (mgBgRow) mgBgRow.style.display = 'none';

    // Show map style row only for mapChart
    const mapStyleRow = document.getElementById('mg-map-style-row');
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleRow) mapStyleRow.style.display = mg.type === 'mapChart' ? '' : 'none';
    if (mapStyleEl && mg.type === 'mapChart') mapStyleEl.value = mg.mapStyle || 'dark';

    // Show explainer-specific controls
    _showExplainerControls(mg.type === 'explainer', mg);

    // Populate variant and animation dropdowns from registry
    _populateMgVariantDropdown(mg.type, mg.subType);
    _populateMgAnimationDropdown(mg.type, mg.animation);
    _populateMgShellDropdown(mg);

    // Show listicle template controls if applicable
    _showListicleControls(mg.type, mg);
}

// Show MG properties panel for a V3 full-screen MG scene
function updateMgPropertiesForScene(scene) {
    const panel = document.getElementById('mg-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = scene.mgData || scene;
    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const durVal = document.getElementById('mg-duration-val');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    if (textEl) textEl.value = mg.text || scene.text || '';
    if (subtextEl) subtextEl.value = mg.subtext || scene.subtext || '';
    if (posEl) posEl.value = mg.position || scene.position || 'center';
    const dur = scene.endTime - scene.startTime;
    if (durEl) durEl.value = dur || 5;
    if (durVal) durVal.textContent = `${(dur || 5).toFixed(1)}s`;
    if (typeEl) typeEl.value = mg.type || scene.type || 'barChart';
    if (styleEl) styleEl.value = mg.style || scene.style || state.mgStyle || 'clean';
    _filterTypeDropdownByGroup(mg.type || scene.type || 'barChart');

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    const animSpeedVal = document.getElementById('mg-anim-speed-val');
    const animSpeed = mg.animationSpeed || scene.animationSpeed || 1;
    if (animSpeedEl) animSpeedEl.value = animSpeed;
    if (animSpeedVal) animSpeedVal.textContent = `${animSpeed.toFixed(1)}x`;

    // Show background dropdown for fullscreen MG scenes
    const mgBgRow = document.getElementById('mg-bg-row');
    const mgBgEl = document.getElementById('mg-background');
    if (mgBgRow) mgBgRow.style.display = '';
    if (mgBgEl) mgBgEl.value = mg.mgBackground || scene.mgBackground || 'none';

    // Show map style row only for mapChart
    const sceneType = mg.type || scene.type;
    const mapStyleRow = document.getElementById('mg-map-style-row');
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleRow) mapStyleRow.style.display = sceneType === 'mapChart' ? '' : 'none';
    if (mapStyleEl && sceneType === 'mapChart') mapStyleEl.value = mg.mapStyle || scene.mapStyle || 'dark';

    // Show explainer-specific controls
    _showExplainerControls(sceneType === 'explainer', mg);

    // Populate variant and animation dropdowns from registry
    _populateMgVariantDropdown(sceneType, mg.subType || scene.subType);
    _populateMgAnimationDropdown(sceneType, mg.animation || scene.animation);
    _populateMgShellDropdown(mg);

    // Show listicle template controls if applicable
    _showListicleControls(sceneType, mg);
}

/**
 * Populate the Map properties panel (#map-properties)
 */
function updateMapProperties(scene) {
    const panel = document.getElementById('map-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = scene.mgData || scene;

    // Map style
    const styleEl = document.getElementById('map-prop-style');
    if (styleEl) styleEl.value = mg.mapStyle || scene.mapStyle || 'satellite';

    // Variant
    const variantEl = document.getElementById('map-prop-variant');
    if (variantEl) variantEl.value = mg.mapVariant || scene.mapVariant || 'auto';

    // Title
    const titleEl = document.getElementById('map-prop-title');
    if (titleEl) titleEl.value = mg.text || scene.text || '';

    // Subtext (locations)
    const subtextEl = document.getElementById('map-prop-subtext');
    if (subtextEl) subtextEl.value = mg.subtext || scene.subtext || '';

    // Waypoints — format from _mapWaypoints array to string
    const wpEl = document.getElementById('map-prop-waypoints');
    if (wpEl) {
        const wps = mg._mapWaypoints || scene._mapWaypoints || [];
        const wpStr = wps.map(wp => {
            let s = `${wp.name} ${wp.startTime}-${wp.endTime}`;
            if (wp.zoom != null) s += ` z${wp.zoom}`;
            if (wp.tilt != null) s += ` t${wp.tilt}`;
            if (wp.bearing != null) s += ` b${wp.bearing}`;
            if (wp.orbit != null) s += ` o${wp.orbit}`;
            if (wp.icon) s += ` i${wp.icon}`;
            return s;
        }).join(', ');
        wpEl.value = wpStr;
    }

    // Zoom speed
    const zsEl = document.getElementById('map-prop-zoom-speed');
    const zsVal = document.getElementById('map-prop-zoom-speed-val');
    const zoomSpeed = mg._mapZoomSpeed || 1;
    if (zsEl) zsEl.value = zoomSpeed;
    if (zsVal) zsVal.textContent = `${zoomSpeed.toFixed(1)}x`;

    // Polygon speed
    const psEl = document.getElementById('map-prop-poly-speed');
    const psVal = document.getElementById('map-prop-poly-speed-val');
    const polySpeed = mg._mapPolySpeed || 1;
    if (psEl) psEl.value = polySpeed;
    if (psVal) psVal.textContent = `${polySpeed.toFixed(1)}x`;

    // Easing
    const easEl = document.getElementById('map-prop-easing');
    if (easEl) easEl.value = mg._mapEasing || 'cubic';

    // Poly color
    const pcEl = document.getElementById('map-prop-poly-color');
    if (pcEl) pcEl.value = mg._mapPolyColor || 'auto';

    // Tilt keyframes
    const tiltSEl = document.getElementById('map-prop-tilt-start');
    const tiltEEl = document.getElementById('map-prop-tilt-end');
    const tiltVal = document.getElementById('map-prop-tilt-val');
    const tiltS = mg._mapTiltKfStart ?? 0;
    const tiltE = mg._mapTiltKfEnd ?? 0.5;
    if (tiltSEl) tiltSEl.value = tiltS;
    if (tiltEEl) tiltEEl.value = tiltE;
    if (tiltVal) tiltVal.textContent = `${Math.round(tiltS * 100)}→${Math.round(tiltE * 100)}%`;

    // Zoom keyframes
    const zoomSEl = document.getElementById('map-prop-zoom-start');
    const zoomEEl = document.getElementById('map-prop-zoom-end');
    const zoomVal = document.getElementById('map-prop-zoom-val');
    const zoomS = mg._mapZoomKfStart ?? 0.8;
    const zoomE = mg._mapZoomKfEnd ?? 1.0;
    if (zoomSEl) zoomSEl.value = zoomS;
    if (zoomEEl) zoomEEl.value = zoomE;
    if (zoomVal) zoomVal.textContent = `${zoomS.toFixed(1)}→${zoomE.toFixed(1)}`;

    // Cinematic
    const cinEl = document.getElementById('map-prop-cinematic');
    if (cinEl) cinEl.checked = !!mg._mapCinematic;
}

function _initMapPropertiesListeners() {
    const _getMapScene = () => {
        if (state.selectedClipIndex < 0) return null;
        const scene = state.scenes[state.selectedClipIndex];
        return (scene && scene.type === 'mapChart') ? scene : null;
    };
    const _setMgProp = (key, val) => {
        const scene = _getMapScene();
        if (!scene) return;
        if (scene.mgData) scene.mgData[key] = val;
        scene[key] = val;
        triggerAutoSave(); refreshCompositorMGs();
    };

    document.getElementById('map-prop-style')?.addEventListener('change', e => {
        _setMgProp('mapStyle', e.target.value);
    });
    document.getElementById('map-prop-variant')?.addEventListener('change', e => {
        _setMgProp('mapVariant', e.target.value);
    });
    document.getElementById('map-prop-title')?.addEventListener('input', e => {
        const scene = _getMapScene(); if (!scene) return;
        scene.text = e.target.value;
        if (scene.mgData) scene.mgData.text = e.target.value;
        triggerAutoSave(); refreshCompositorMGs();
    });
    document.getElementById('map-prop-subtext')?.addEventListener('input', e => {
        const scene = _getMapScene(); if (!scene) return;
        scene.subtext = e.target.value;
        if (scene.mgData) scene.mgData.subtext = e.target.value;
        triggerAutoSave(); refreshCompositorMGs();
    });
    document.getElementById('map-prop-zoom-speed')?.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        _setMgProp('_mapZoomSpeed', val);
        const valEl = document.getElementById('map-prop-zoom-speed-val');
        if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
    });
    document.getElementById('map-prop-poly-speed')?.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        _setMgProp('_mapPolySpeed', val);
        const valEl = document.getElementById('map-prop-poly-speed-val');
        if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
    });
    document.getElementById('map-prop-easing')?.addEventListener('change', e => {
        _setMgProp('_mapEasing', e.target.value);
    });
    document.getElementById('map-prop-poly-color')?.addEventListener('change', e => {
        _setMgProp('_mapPolyColor', e.target.value);
    });
    // Tilt keyframes
    const tiltHandler = () => {
        const s = parseFloat(document.getElementById('map-prop-tilt-start')?.value || 0);
        const e = parseFloat(document.getElementById('map-prop-tilt-end')?.value || 0.5);
        _setMgProp('_mapTiltKfStart', s);
        _setMgProp('_mapTiltKfEnd', e);
        const valEl = document.getElementById('map-prop-tilt-val');
        if (valEl) valEl.textContent = `${Math.round(s * 100)}→${Math.round(e * 100)}%`;
    };
    document.getElementById('map-prop-tilt-start')?.addEventListener('input', tiltHandler);
    document.getElementById('map-prop-tilt-end')?.addEventListener('input', tiltHandler);
    // Zoom keyframes
    const zoomHandler = () => {
        const s = parseFloat(document.getElementById('map-prop-zoom-start')?.value || 0.8);
        const e = parseFloat(document.getElementById('map-prop-zoom-end')?.value || 1.0);
        _setMgProp('_mapZoomKfStart', s);
        _setMgProp('_mapZoomKfEnd', e);
        const valEl = document.getElementById('map-prop-zoom-val');
        if (valEl) valEl.textContent = `${s.toFixed(1)}→${e.toFixed(1)}`;
    };
    document.getElementById('map-prop-zoom-start')?.addEventListener('input', zoomHandler);
    document.getElementById('map-prop-zoom-end')?.addEventListener('input', zoomHandler);
    // Cinematic
    document.getElementById('map-prop-cinematic')?.addEventListener('change', e => {
        _setMgProp('_mapCinematic', e.target.checked);
    });
    // Waypoints text field — parse on blur
    document.getElementById('map-prop-waypoints')?.addEventListener('change', e => {
        const scene = _getMapScene(); if (!scene) return;
        const text = e.target.value;
        // Parse waypoint format: "Name start-end z<zoom> t<tilt> b<bearing> o<orbit>"
        const wpRegex = /^(.+?)\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(.*)$/;
        const entries = text.split(',').map(s => s.trim()).filter(Boolean);
        const waypoints = [];
        for (const entry of entries) {
            const m = entry.match(wpRegex);
            if (!m) continue;
            const extras = m[4] || '';
            const zM = extras.match(/z(\d+(?:\.\d+)?)/);
            const tM = extras.match(/t(\d+(?:\.\d+)?)/);
            const bM = extras.match(/b(-?\d+(?:\.\d+)?)/);
            const oM = extras.match(/o(-?\d+(?:\.\d+)?)/);
            const iM = extras.match(/i([a-zA-Z][a-zA-Z0-9 _-]*)/);
            let icon = null;
            if (iM) { const raw = iM[1].trim(); if (raw.length >= 2 && !['sz','c'].includes(raw)) icon = raw; }
            waypoints.push({
                name: m[1].trim(),
                startTime: parseFloat(m[2]),
                endTime: parseFloat(m[3]),
                zoom: zM ? parseFloat(zM[1]) : null,
                tilt: tM ? parseFloat(tM[1]) : null,
                bearing: bM ? parseFloat(bM[1]) : null,
                orbit: oM ? parseFloat(oM[1]) : null,
                icon: icon,
            });
        }
        if (waypoints.length > 0) {
            _setMgProp('_mapWaypoints', waypoints);
        }
    });
}

/**
 * Populate the dedicated Listicle Items properties panel (#listicle-properties)
 */
function updateListicleProperties(mg) {
    const panel = document.getElementById('listicle-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mgType = mg.type || 'listicleCounter';

    // Type dropdown
    const typeEl = document.getElementById('li-type');
    if (typeEl) typeEl.value = mgType;

    // Template dropdown — populate variants from registry
    const templateSel = document.getElementById('li-template');
    if (templateSel && window._mgRegistry) {
        const types = window._mgRegistry.getTypesForCategory(mgType);
        templateSel.innerHTML = '';
        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t.key;
            opt.textContent = t.label;
            templateSel.appendChild(opt);
        }
        templateSel.value = mg.subType || window._mgRegistry.registry[mgType]?.defaultType || '';
    }

    // Animation dropdown — populate from registry
    const animSel = document.getElementById('li-animation');
    if (animSel && window._mgRegistry) {
        const anims = window._mgRegistry.getAnimationsForCategory(mgType);
        animSel.innerHTML = '';
        for (const a of anims) {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            animSel.appendChild(opt);
        }
        animSel.value = mg.animation || anims[0] || '';
    }

    // Number field — show for counter/tracker, hide for grid
    const numberRow = document.getElementById('li-number-row');
    if (numberRow) numberRow.style.display = mgType === 'listicleGrid' ? 'none' : '';
    const numberEl = document.getElementById('li-number');
    if (numberEl) numberEl.value = mg.text || '';

    // Title field — show for counter, hide for tracker/grid
    const titleRow = document.getElementById('li-title-row');
    if (titleRow) titleRow.style.display = mgType === 'listicleCounter' ? '' : 'none';
    const titleEl = document.getElementById('li-title');
    if (titleEl) titleEl.value = mg.subtext || '';

    // Style
    const styleSel2 = document.getElementById('li-style');
    if (styleSel2) styleSel2.value = mg.style || 'clean';

    // Position
    const posEl = document.getElementById('li-position');
    if (posEl) posEl.value = mg.position || 'bottomLeft';

    // Duration
    const durEl = document.getElementById('li-duration');
    const durVal = document.getElementById('li-duration-val');
    const dur = mg.duration || 4;
    if (durEl) durEl.value = dur;
    if (durVal) durVal.textContent = `${dur.toFixed(1)}s`;

    // Scale
    const scaleEl = document.getElementById('li-scale');
    const scaleValEl = document.getElementById('li-scale-val');
    const scaleV = mg.scale || 1.3;
    if (scaleEl) scaleEl.value = scaleV;
    if (scaleValEl) scaleValEl.textContent = `${scaleV.toFixed(1)}x`;

    // Animation speed
    const animSpeedEl = document.getElementById('li-anim-speed');
    const animSpeedVal = document.getElementById('li-anim-speed-val');
    const speed = mg.animationSpeed || 1;
    if (animSpeedEl) animSpeedEl.value = speed;
    if (animSpeedVal) animSpeedVal.textContent = `${speed.toFixed(1)}x`;
}

function setupClipPropertyListeners() {
    // Capture undo state once when user starts dragging any property slider
    const propSliders = [elements.propScale, elements.propPosX, elements.propPosY, elements.propVolume,
    elements.propCropTop, elements.propCropBottom, elements.propCropLeft, elements.propCropRight, elements.propBorderRadius];
    propSliders.forEach(slider => {
        if (slider) {
            slider.addEventListener('pointerdown', () => {
                if (state.selectedClipIndex >= 0) pushUndoState();
            });
        }
    });

    if (elements.propScale) {
        elements.propScale.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].scale = val;
            if (elements.propScaleVal) elements.propScaleVal.value = val.toFixed(2);
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propPosX) {
        elements.propPosX.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].posX = val;
            if (elements.propPosXVal) elements.propPosXVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propPosY) {
        elements.propPosY.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].posY = val;
            if (elements.propPosYVal) elements.propPosYVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propVolume) {
        elements.propVolume.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].volume = val;
            if (elements.propVolumeVal) elements.propVolumeVal.value = `${Math.round(val * 100)}%`;
            applyTrackVolumes();
        });
    }
    // Crop sliders
    ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(prop => {
        const capProp = prop.charAt(0).toUpperCase() + prop.slice(1);
        const slider = elements[`propCrop${capProp.replace('crop', '').replace('Crop', '')}`] || elements[`prop${capProp}`];
        const valEl = elements[`propCrop${capProp.replace('crop', '').replace('Crop', '')}Val`] || elements[`prop${capProp}Val`];
        // Use direct element references
        const elMap = { cropTop: 'propCropTop', cropBottom: 'propCropBottom', cropLeft: 'propCropLeft', cropRight: 'propCropRight' };
        const valMap = { cropTop: 'propCropTopVal', cropBottom: 'propCropBottomVal', cropLeft: 'propCropLeftVal', cropRight: 'propCropRightVal' };
        const sl = elements[elMap[prop]];
        const vl = elements[valMap[prop]];
        if (sl) {
            sl.addEventListener('input', (e) => {
                if (state.selectedClipIndex < 0) return;
                const val = parseInt(e.target.value);
                state.scenes[state.selectedClipIndex][prop] = val;
                if (vl) vl.value = `${val}%`;
                applySceneTransform(state.selectedClipIndex);
                refreshCompositorScene(state.selectedClipIndex);
            });
        }
    });
    // Border radius slider
    if (elements.propBorderRadius) {
        elements.propBorderRadius.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].borderRadius = val;
            if (elements.propBorderRadiusVal) elements.propBorderRadiusVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }

    // Editable value inputs — commit on Enter or blur
    function setupValueInput(inputEl, sliderEl, { parse, format, apply }) {
        if (!inputEl) return;
        const commit = () => {
            if (state.selectedClipIndex < 0) return;
            const raw = inputEl.value.replace(/%/g, '').trim();
            let val = parse(raw);
            if (isNaN(val)) return;
            // Clamp to slider range
            const min = parseFloat(sliderEl?.min ?? -Infinity);
            const max = parseFloat(sliderEl?.max ?? Infinity);
            val = Math.min(max, Math.max(min, val));
            pushUndoState();
            if (sliderEl) sliderEl.value = val;
            inputEl.value = format(val);
            apply(val);
        };
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); inputEl.blur(); }
            if (e.key === 'Escape') { inputEl.blur(); }
        });
        inputEl.addEventListener('blur', commit);
        // Select all on focus for easy overwrite
        inputEl.addEventListener('focus', () => inputEl.select());
    }

    setupValueInput(elements.propScaleVal, elements.propScale, {
        parse: parseFloat,
        format: v => v.toFixed(2),
        apply: v => { state.scenes[state.selectedClipIndex].scale = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });
    setupValueInput(elements.propPosXVal, elements.propPosX, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].posX = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });
    setupValueInput(elements.propPosYVal, elements.propPosY, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].posY = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });
    setupValueInput(elements.propVolumeVal, elements.propVolume, {
        parse: v => parseFloat(v) / 100,
        format: v => `${Math.round(v * 100)}%`,
        apply: v => { state.scenes[state.selectedClipIndex].volume = v; applyTrackVolumes(); }
    });
    ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(prop => {
        const elMap = { cropTop: 'propCropTop', cropBottom: 'propCropBottom', cropLeft: 'propCropLeft', cropRight: 'propCropRight' };
        const valMap = { cropTop: 'propCropTopVal', cropBottom: 'propCropBottomVal', cropLeft: 'propCropLeftVal', cropRight: 'propCropRightVal' };
        setupValueInput(elements[valMap[prop]], elements[elMap[prop]], {
            parse: parseInt,
            format: v => `${v}%`,
            apply: v => { state.scenes[state.selectedClipIndex][prop] = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
        });
    });
    setupValueInput(elements.propBorderRadiusVal, elements.propBorderRadius, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].borderRadius = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });

    // ── Floating frame controls ──
    if (elements.propFraming) {
        elements.propFraming.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            const newFraming = e.target.value;
            applyEditorFramingPreset(scene, newFraming);
            updateClipProperties();
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    if (elements.propShadow) {
        elements.propShadow.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].shadow = val;
            if (elements.propShadowVal) elements.propShadowVal.value = val.toFixed(2);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    setupValueInput(elements.propShadowVal, elements.propShadow, {
        parse: parseFloat,
        format: v => v.toFixed(2),
        apply: v => { state.scenes[state.selectedClipIndex].shadow = v; refreshCompositorScene(state.selectedClipIndex); }
    });
    if (elements.propFloatingAnim) {
        elements.propFloatingAnim.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].floatingAnim = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propFloatingAnimDur) {
        elements.propFloatingAnimDur.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].floatingAnimDuration = val;
            if (elements.propFloatingAnimDurVal) elements.propFloatingAnimDurVal.value = val.toFixed(2) + 's';
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    setupValueInput(elements.propFloatingAnimDurVal, elements.propFloatingAnimDur, {
        parse: v => parseFloat(v.replace('s', '')),
        format: v => v.toFixed(2) + 's',
        apply: v => { state.scenes[state.selectedClipIndex].floatingAnimDuration = v; refreshCompositorScene(state.selectedClipIndex); }
    });
    if (elements.propReset) {
        elements.propReset.addEventListener('click', () => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            scene.scale = 1;
            scene.posX = 0;
            scene.posY = 0;
            scene.volume = 1;
            scene.background = 'none';
            scene.fitMode = 'cover';
            scene.cropTop = 0;
            scene.cropBottom = 0;
            scene.cropLeft = 0;
            scene.cropRight = 0;
            scene.borderRadius = 0;
            scene.framing = 'fullscreen';
            scene.shadow = 0;
            scene.floatingAnim = 'slideRight';
            scene.floatingAnimDuration = 0.6;
            updateClipProperties();
            applySceneTransform(state.selectedClipIndex);
            applyTrackVolumes();
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Fill Frame button — calculates exact scale to cover the frame given current crop values
    if (elements.btnFillFrame) {
        elements.btnFillFrame.addEventListener('click', () => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            const cropT = scene.cropTop    || 0;
            const cropB = scene.cropBottom || 0;
            const cropL = scene.cropLeft   || 0;
            const cropR = scene.cropRight  || 0;
            // Compute scale to fill frame after crop
            const scaleH = (cropL + cropR) > 0 ? 100 / (100 - cropL - cropR) : 1;
            const scaleV = (cropT + cropB) > 0 ? 100 / (100 - cropT - cropB) : 1;
            const fillScale = Math.round(Math.max(scaleH, scaleV) * 100) / 100;
            scene.scale = Math.max(fillScale, 1);
            scene.fitMode = 'cover';
            // Position offset to center visible area (asymmetric crops need translate)
            scene.posX = parseFloat((scene.scale * (cropR - cropL) / 2).toFixed(2));
            scene.posY = parseFloat((scene.scale * (cropB - cropT) / 2).toFixed(2));
            if (elements.propScale)    elements.propScale.value = scene.scale;
            if (elements.propScaleVal) elements.propScaleVal.value = scene.scale.toFixed(2);
            if (elements.propFitMode)  elements.propFitMode.value = 'cover';
            if (elements.propPosX)     elements.propPosX.value = scene.posX;
            if (elements.propPosXVal)  elements.propPosXVal.value = `${scene.posX}%`;
            if (elements.propPosY)     elements.propPosY.value = scene.posY;
            if (elements.propPosYVal)  elements.propPosYVal.value = `${scene.posY}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    // Background dropdown
    if (elements.propBackground) {
        elements.propBackground.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].background = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Fit mode dropdown
    if (elements.propFitMode) {
        elements.propFitMode.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            scene.fitMode = e.target.value;
            // If switching to contain without a background, auto-set blur
            if (e.target.value === 'contain' && (!scene.background || scene.background === 'none')) {
                scene.background = 'blur';
                if (elements.propBackground) elements.propBackground.value = 'blur';
            }
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // V2 overlay: Slide direction
    const slideDirEl = document.getElementById('prop-slide-dir');
    if (slideDirEl) {
        slideDirEl.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].slideDirection = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    // V2 overlay: Slide speed/duration
    const slideSpeedEl = document.getElementById('prop-slide-speed');
    if (slideSpeedEl) {
        slideSpeedEl.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].slideDuration = val;
            const valEl = document.getElementById('prop-slide-speed-val');
            if (valEl) valEl.textContent = `${val}s`;
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    // V2 overlay: Background blur on video
    const bgBlurEl = document.getElementById('prop-bg-blur');
    if (bgBlurEl) {
        bgBlurEl.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].bgBlur = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Animate checkbox
    if (elements.propAnimate) {
        elements.propAnimate.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].kenBurnsEnabled = e.target.checked;
            // Show/hide speed slider
            if (elements.propKbSpeedRow) {
                elements.propKbSpeedRow.style.display = e.target.checked ? '' : 'none';
            }
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Ken Burns speed slider
    if (elements.propKbSpeed) {
        elements.propKbSpeed.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const speed = parseFloat(e.target.value) || 1;
            state.scenes[state.selectedClipIndex].kenBurnsSpeed = speed;
            if (elements.propKbSpeedVal) {
                elements.propKbSpeedVal.textContent = speed.toFixed(1) + 'x';
            }
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
        elements.propKbSpeed.addEventListener('change', (e) => {
            pushUndoState();
        });
    }
}

/**
 * Populate the Background dropdown with available pattern files from assets/backgrounds/
 */
/**
 * Preload template media (video/image) into a shared cache so MGRenderer
 * can use it immediately without a loading flash.
 */
const _preloadedTemplateMedia = {};
function _preloadTemplateMedia(file, url, offset) {
    if (_preloadedTemplateMedia[file]) return;
    _preloadedTemplateMedia[file] = true;
    const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(file);
    if (isVideo) {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.style.display = 'none';
        document.body.appendChild(video);
        video.onloadeddata = () => {
            // Seek to the offset so the first frame is ready
            if (offset > 0 && video.duration > offset) {
                video.currentTime = offset;
            }
            // Inject into MGRenderer's cache if available
            if (state.compositor?.mgRenderer) {
                const mgr = state.compositor.mgRenderer;
                if (!mgr._templateMedia) mgr._templateMedia = {};
                if (!mgr._templateMedia[file]) {
                    mgr._templateMedia[file] = video;
                    console.log(`[Preload] Template media ready: ${file.split(/[/\\]/).pop()}`);
                }
            }
        };
        video.onerror = () => {
            delete _preloadedTemplateMedia[file];
            if (video.parentNode) video.parentNode.removeChild(video);
        };
        video.src = url;
    } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (state.compositor?.mgRenderer) {
                const mgr = state.compositor.mgRenderer;
                if (!mgr._templateMedia) mgr._templateMedia = {};
                if (!mgr._templateMedia[file]) {
                    mgr._templateMedia[file] = img;
                    console.log(`[Preload] Template media ready: ${file.split(/[/\\]/).pop()}`);
                }
            }
        };
        img.onerror = () => { delete _preloadedTemplateMedia[file]; };
        img.src = url;
    }
}

function populateBackgroundDropdown() {
    const sel = elements.propBackground;
    if (!sel) return;
    // Keep the first two built-in options (None, Blur)
    while (sel.options.length > 2) sel.remove(2);
    // Add built-in gradient backgrounds
    if (Object.keys(GRADIENT_BACKGROUNDS).length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Gradients';
        for (const [id, css] of Object.entries(GRADIENT_BACKGROUNDS)) {
            const opt = document.createElement('option');
            opt.value = `gradient:${id}`;
            opt.textContent = GRADIENT_BACKGROUND_NAMES[id] || id;
            grp.appendChild(opt);
        }
        sel.appendChild(grp);
    }
    // Add pattern files from assets/backgrounds/ — filtered by active theme
    if (state.availableBackgrounds.length > 0) {
        const activeTheme = _resolveActiveTheme();
        // Show only backgrounds matching the current theme (or universal ones with no theme tag)
        const filtered = state.availableBackgrounds.filter(bg => {
            if (!bg.theme) return true;          // universal — always show
            if (!activeTheme) return true;       // no theme resolved — show all
            return bg.theme === activeTheme;     // theme-specific — must match
        });
        if (filtered.length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = activeTheme ? `Custom (${activeTheme})` : 'Custom Files';
            for (const bg of filtered) {
                const opt = document.createElement('option');
                opt.value = `pattern:${bg.filename}`;
                const icon = bg.mediaType === 'video' ? '🎬' : '🖼️';
                opt.textContent = `${icon} ${bg.name}`;
                grp.appendChild(opt);
            }
            sel.appendChild(grp);
        }
    }
}

function setupMgPropertyListeners() {
    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');
    const shellEl = document.getElementById('mg-shell');

    // Helper: get the MG object being edited (overlay MG or V3 fullscreen MG scene)
    function getActiveMG() {
        if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
            return { mg: state.motionGraphics[state.selectedMgIndex], isScene: false };
        }
        if (state._selectedMgScene) {
            return { mg: state._selectedMgScene, isScene: true };
        }
        return null;
    }

    if (textEl) {
        textEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.text = e.target.value;
            if (active.mg.mgData) active.mg.mgData.text = e.target.value;
            renderTracks();
            refreshCompositorMGs();
        });
    }
    if (subtextEl) {
        subtextEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.subtext = e.target.value;
            if (active.mg.mgData) active.mg.mgData.subtext = e.target.value;
            refreshCompositorMGs();
        });
    }
    if (posEl) {
        posEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.position = e.target.value;
            if (active.mg.mgData) active.mg.mgData.position = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }
    if (durEl) {
        durEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            const val = parseFloat(e.target.value);
            active.mg.duration = val;
            if (active.mg.mgData) active.mg.mgData.duration = val;
            if (active.isScene) {
                active.mg.endTime = active.mg.startTime + val;
            }
            document.getElementById('mg-duration-val').textContent = `${val.toFixed(1)}s`;
            renderTracks();
            refreshCompositorMGs();
        });
    }
    if (typeEl) {
        typeEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.type = e.target.value;
            if (active.mg.mgData) active.mg.mgData.type = e.target.value;
            // Reset subType/animation when type changes
            delete active.mg.subType;
            delete active.mg.animation;
            delete active.mg.variantManual;
            delete active.mg.animationManual;
            if (active.mg.mgData) { delete active.mg.mgData.subType; delete active.mg.mgData.animation; }
            if (active.mg.mgData) { delete active.mg.mgData.variantManual; delete active.mg.mgData.animationManual; }
            // Refresh variant/animation dropdowns for new type
            _populateMgVariantDropdown(e.target.value, null);
            _populateMgAnimationDropdown(e.target.value, null);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            renderTracks();
            refreshCompositorMGs();
        });
    }

    // Variant (subType) dropdown
    const subTypeEl = document.getElementById('mg-subtype');
    if (subTypeEl) {
        subTypeEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'subType', e.target.value);
            _setMgField(active, 'variantManual', true);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Animation profile dropdown
    const animEl = document.getElementById('mg-animation');
    if (animEl) {
        animEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'animation', e.target.value);
            _setMgField(active, 'animationManual', true);
            refreshCompositorMGs();
        });
    }
    if (styleEl) {
        styleEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _applyManualMgStyle(active, e.target.value);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }
    if (shellEl) {
        shellEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active || e.target.value === 'custom') return;
            _applyManualGraphicShell(active, e.target.value);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Map style dropdown (only for mapChart type)
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleEl) {
        mapStyleEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.mapStyle = e.target.value;
            if (active.mg.mgData) active.mg.mgData.mapStyle = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Show/hide map style row + explainer + listicle controls when type changes
    if (typeEl) {
        typeEl.addEventListener('change', () => {
            const mapStyleRow = document.getElementById('mg-map-style-row');
            if (mapStyleRow) mapStyleRow.style.display = typeEl.value === 'mapChart' ? '' : 'none';
            _showExplainerControls(typeEl.value === 'explainer', null);
            const active = getActiveMG();
            _showListicleControls(typeEl.value, active?.mg || null);
        });
    }

    // Explainer-specific property listeners
    const explScaleEl = document.getElementById('mg-explainer-img-scale');
    if (explScaleEl) {
        explScaleEl.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            document.getElementById('mg-explainer-img-scale-val').textContent = val + '%';
            const active = getActiveMG();
            if (!active) return;
            active.mg.explainerImgScale = val;
            if (active.mg.mgData) active.mg.mgData.explainerImgScale = val;
            refreshCompositorMGs();
        });
    }
    const explShadowEl = document.getElementById('mg-explainer-shadow');
    if (explShadowEl) {
        explShadowEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.explainerShadow = e.target.value;
            if (active.mg.mgData) active.mg.mgData.explainerShadow = e.target.value;
            refreshCompositorMGs();
        });
    }

    // MG Background dropdown — populate gradient options and listen for changes
    const mgBgEl = document.getElementById('mg-background');
    if (mgBgEl) {
        // Add gradient options from the built-in library
        if (Object.keys(GRADIENT_BACKGROUNDS).length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = 'Gradients';
            for (const [id] of Object.entries(GRADIENT_BACKGROUNDS)) {
                const opt = document.createElement('option');
                opt.value = `gradient:${id}`;
                opt.textContent = GRADIENT_BACKGROUND_NAMES[id] || id;
                grp.appendChild(opt);
            }
            mgBgEl.appendChild(grp);
        }
        mgBgEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.mgBackground = e.target.value;
            if (active.mg.mgData) active.mg.mgData.mgBackground = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    if (animSpeedEl) {
        animSpeedEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            const val = parseFloat(e.target.value);
            active.mg.animationSpeed = val;
            if (active.mg.mgData) active.mg.mgData.animationSpeed = val;
            document.getElementById('mg-anim-speed-val').textContent = `${val.toFixed(1)}x`;
            refreshCompositorMGs();
        });
    }

    // ── Listicle Template Listeners ──
    const listicleTemplateSel = document.getElementById('mg-listicle-template');
    if (listicleTemplateSel) {
        listicleTemplateSel.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'subType', e.target.value);
            _setMgField(active, 'variantManual', true);
            // Also update the main variant dropdown if visible
            const subTypeEl = document.getElementById('mg-subtype');
            if (subTypeEl) subTypeEl.value = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    const listicleAnimSel = document.getElementById('mg-listicle-anim');
    if (listicleAnimSel) {
        listicleAnimSel.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'animation', e.target.value);
            _setMgField(active, 'animationManual', true);
            refreshCompositorMGs();
        });
    }

    const listicleNumberEl = document.getElementById('mg-listicle-number');
    if (listicleNumberEl) {
        listicleNumberEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.text = e.target.value;
            if (active.mg.mgData) active.mg.mgData.text = e.target.value;
            // Sync with main text field
            const textEl = document.getElementById('mg-text');
            if (textEl) textEl.value = e.target.value;
            refreshCompositorMGs();
        });
    }

    const listicleItemsEl = document.getElementById('mg-listicle-items');
    if (listicleItemsEl) {
        listicleItemsEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg._maxVisibleItems = parseInt(e.target.value) || 5;
            if (active.mg.mgData) active.mg.mgData._maxVisibleItems = parseInt(e.target.value) || 5;
            if (active.isScene) loadActiveScenes();
            refreshCompositorMGs();
        });
    }

    const listicleBgSel = document.getElementById('mg-listicle-bg');
    if (listicleBgSel) {
        listicleBgSel.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.mgBackground = e.target.value === 'auto' ? undefined : e.target.value;
            if (active.mg.mgData) active.mg.mgData.mgBackground = e.target.value === 'auto' ? undefined : e.target.value;
            refreshCompositorMGs();
        });
    }
}

/**
 * Setup event listeners for the dedicated Listicle Items properties panel (#listicle-properties)
 */
function setupListiclePropertyListeners() {
    // Helper: get the active listicle MG (overlay or fullscreen scene)
    function getActiveListicleMG() {
        if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
            const mg = state.motionGraphics[state.selectedMgIndex];
            return { mg, isScene: false };
        }
        if (state._selectedMgScene) {
            const mgData = state._selectedMgScene.mgData || state._selectedMgScene;
            return { mg: mgData, isScene: true, scene: state._selectedMgScene };
        }
        return null;
    }

    // Type change — switch between counter/tracker/grid
    const typeEl = document.getElementById('li-type');
    if (typeEl) {
        typeEl.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            pushUndoState();
            active.mg.type = e.target.value;
            if (active.isScene && active.scene) active.scene.type = e.target.value;
            // Re-populate template/animation dropdowns for new type
            updateListicleProperties(active.mg);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
            renderTimeline();
        });
    }

    // Template (variant) change
    const templateSel = document.getElementById('li-template');
    if (templateSel) {
        templateSel.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.subType = e.target.value;
            if (active.mg.mgData) active.mg.mgData.subType = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Style change
    const styleSel = document.getElementById('li-style');
    if (styleSel) {
        styleSel.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.style = e.target.value;
            if (active.mg.mgData) active.mg.mgData.style = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Animation change
    const animSel = document.getElementById('li-animation');
    if (animSel) {
        animSel.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.animation = e.target.value;
            if (active.mg.mgData) active.mg.mgData.animation = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Number field (text for counter/tracker)
    const numberEl = document.getElementById('li-number');
    if (numberEl) {
        numberEl.addEventListener('input', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.text = e.target.value;
            if (active.mg.mgData) active.mg.mgData.text = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Title field (subtext for counter)
    const titleEl = document.getElementById('li-title');
    if (titleEl) {
        titleEl.addEventListener('input', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.subtext = e.target.value;
            if (active.mg.mgData) active.mg.mgData.subtext = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Position
    const posEl = document.getElementById('li-position');
    if (posEl) {
        posEl.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.position = e.target.value;
            if (active.mg.mgData) active.mg.mgData.position = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Duration slider
    const durEl = document.getElementById('li-duration');
    if (durEl) {
        durEl.addEventListener('pointerdown', () => pushUndoState());
        durEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const durVal = document.getElementById('li-duration-val');
            if (durVal) durVal.textContent = `${val.toFixed(1)}s`;

            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.duration = val;
            if (active.mg.mgData) active.mg.mgData.duration = val;
            refreshCompositorMGs();
            renderTimeline();
        });
    }

    // Animation speed slider
    const animSpeedEl = document.getElementById('li-anim-speed');
    if (animSpeedEl) {
        animSpeedEl.addEventListener('pointerdown', () => pushUndoState());
        animSpeedEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const animSpeedVal = document.getElementById('li-anim-speed-val');
            if (animSpeedVal) animSpeedVal.textContent = `${val.toFixed(1)}x`;

            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.animationSpeed = val;
            if (active.mg.mgData) active.mg.mgData.animationSpeed = val;
            refreshCompositorMGs();
        });
    }

    // Scale slider
    const scaleEl = document.getElementById('li-scale');
    if (scaleEl) {
        scaleEl.addEventListener('pointerdown', () => pushUndoState());
        scaleEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const scaleVal = document.getElementById('li-scale-val');
            if (scaleVal) scaleVal.textContent = `${val.toFixed(1)}x`;

            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.scale = val;
            if (active.mg.mgData) active.mg.mgData.scale = val;
            refreshCompositorMGs();
        });
    }
}

// ========================================
// Listicle Template Properties (separate system — overview grid, future templates)
// ========================================

/**
 * Populate the Template properties panel (#template-properties).
 * Variant + Animation dropdowns are dynamically populated from TEMPLATE_REGISTRY
 * so each template type shows only its own valid options.
 */
function updateTemplateProperties(mgOrScene) {
    const panel = document.getElementById('template-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    // Read from scene first (what renderer sees), then mgData fallback
    const scene = state._selectedMgScene || {};
    const mg = scene.type ? scene : mgOrScene;

    const tplType = document.getElementById('tpl-type');
    const tplVariant = document.getElementById('tpl-variant');
    const tplAnimation = document.getElementById('tpl-animation');
    const tplStyle = document.getElementById('tpl-style');
    const tplBackground = document.getElementById('tpl-background');
    const tplAnimSpeed = document.getElementById('tpl-anim-speed');
    const tplAnimSpeedVal = document.getElementById('tpl-anim-speed-val');

    const type = mg.type || 'listicleGrid';
    if (tplType) tplType.value = type;

    // Populate variant + animation dropdowns from registry for THIS template type
    const reg = TEMPLATE_REGISTRY[type];
    if (reg) {
        _populateTemplateDropdown(tplVariant, reg.variants, mg.subType || mg.variant, reg.defaultVariant);
        _populateTemplateDropdown(tplAnimation, reg.animations, mg.animation, reg.defaultAnimation);
    }

    if (tplStyle) tplStyle.value = mg.style || 'clean';
    if (tplBackground) tplBackground.value = mg.mgBackground || 'none';
    if (tplAnimSpeed) {
        const speed = mg.animationSpeed || mg._animationSpeed || 1.0;
        tplAnimSpeed.value = speed;
        if (tplAnimSpeedVal) tplAnimSpeedVal.textContent = `${speed.toFixed(1)}x`;
    }
}

/**
 * Get active template MG (from V3 scene selection)
 */
function getActiveTemplateMG() {
    const scene = state._selectedMgScene;
    if (!scene || !TEMPLATE_TYPES.has(scene.type)) return null;
    return { scene };
}

/** Set a property on both scene and scene.mgData so renderer always sees it */
function _setTemplateProp(scene, key, value) {
    scene[key] = value;
    if (scene.mgData) scene.mgData[key] = value;
}

function _isTransparentTemplateBackground(scene = {}) {
    const fields = [
        scene.mgBackground,
        scene.background,
        scene.templateBackground,
        scene.templateBg,
        scene.backgroundMode,
        scene.mgData?.mgBackground,
        scene.mgData?.background,
        scene.mgData?.templateBackground,
        scene.mgData?.templateBg,
        scene.mgData?.backgroundMode,
    ];
    return fields.some(value => {
        if (typeof value !== 'string') return false;
        const mode = value.trim().toLowerCase();
        return mode === 'none'
            || mode === 'transparent'
            || (mode.includes('transparent') && !mode.startsWith('gradient:') && !mode.startsWith('image:'));
    });
}

function _normalizeTemplateSceneBackground(scene) {
    if (!scene || !scene.templateType) return scene;
    if (!scene.mgBackground) scene.mgBackground = 'none';
    if (scene.mgData && !scene.mgData.mgBackground) scene.mgData.mgBackground = scene.mgBackground;
    return scene;
}

/**
 * Setup event listeners for Template properties panel.
 * tpl-type change → re-populates variant/animation dropdowns from TEMPLATE_REGISTRY.
 */
function setupTemplatePropertyListeners() {
    const tplType = document.getElementById('tpl-type');
    if (tplType) {
        tplType.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            const newType = e.target.value;
            _setTemplateProp(active.scene, 'type', newType);
            // Update keyword display
            active.scene.keyword = `Template: ${newType}`;
            if (active.scene.mgData) active.scene.mgData.keyword = active.scene.keyword;
            // Re-populate variant/animation with new type's options + set defaults
            const reg = TEMPLATE_REGISTRY[newType];
            if (reg) {
                const tplVariant = document.getElementById('tpl-variant');
                const tplAnimation = document.getElementById('tpl-animation');
                _populateTemplateDropdown(tplVariant, reg.variants, null, reg.defaultVariant);
                _populateTemplateDropdown(tplAnimation, reg.animations, null, reg.defaultAnimation);
                _setTemplateProp(active.scene, 'subType', reg.defaultVariant);
                _setTemplateProp(active.scene, 'variant', reg.defaultVariant);
                _setTemplateProp(active.scene, 'animation', reg.defaultAnimation);
            }
            // Update panel title
            const titleEl = document.getElementById('properties-title');
            if (titleEl) titleEl.textContent = reg?.label || 'Template';
            renderTimeline();
            refreshCompositorMGs();
        });
    }

    const tplVariant = document.getElementById('tpl-variant');
    if (tplVariant) {
        tplVariant.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'subType', e.target.value);
            _setTemplateProp(active.scene, 'variant', e.target.value);
            refreshCompositorMGs();
        });
    }

    const tplAnimation = document.getElementById('tpl-animation');
    if (tplAnimation) {
        tplAnimation.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'animation', e.target.value);
            refreshCompositorMGs();
        });
    }

    const tplStyle = document.getElementById('tpl-style');
    if (tplStyle) {
        tplStyle.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'style', e.target.value);
            refreshCompositorMGs();
        });
    }

    const tplBackground = document.getElementById('tpl-background');
    if (tplBackground) {
        tplBackground.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'mgBackground', e.target.value || 'none');
            refreshCompositorMGs();
            triggerAutoSave();
        });
    }

    const tplAnimSpeed = document.getElementById('tpl-anim-speed');
    if (tplAnimSpeed) {
        tplAnimSpeed.addEventListener('pointerdown', () => pushUndoState());
        tplAnimSpeed.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const valEl = document.getElementById('tpl-anim-speed-val');
            if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
            const active = getActiveTemplateMG();
            if (!active) return;
            _setTemplateProp(active.scene, 'animationSpeed', val);
            _setTemplateProp(active.scene, '_animationSpeed', val);
            refreshCompositorMGs();
        });
    }
}

/**
 * Compute effective volume for a scene (clip volume * master volume * track mute)
 */
function getSceneVolume(scene) {
    if (state.isMuted) return 0;
    const trackId = scene.trackId || 'video-track-1';
    if (state.mutedTracks[trackId]) return 0;
    const clipVol = scene.volume !== undefined ? scene.volume : 1;
    return clipVol * state.volume;
}

/**
 * Apply volume to all active video elements and audio based on clip volume + track mute
 */
function applyTrackVolumes() {
    // Video tracks
    if (state.activeSceneIndices) {
        state.activeSceneIndices.forEach(idx => {
            const scene = state.scenes[idx];
            if (!scene) return;
            const trackNum = (scene.trackId || 'video-track-1').match(/(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video) {
                video.volume = getSceneVolume(scene);
                video.muted = false; // Let volume control handle it
            }
        });
    }

    // Voice track
    if (elements.previewAudio) {
        const voiceMuted = state.mutedTracks['audio-track'] || false;
        elements.previewAudio.volume = (state.isMuted || voiceMuted) ? 0 : state.volume;
    }
}

/**
 * Apply scale/position transform to a specific video element
 * @param {HTMLVideoElement} videoElement - The video element to transform
 * @param {Object} scene - The scene with scale/position properties
 */
function applySceneTransformToVideo(videoElement, scene) {
    if (!videoElement || !scene) return;

    const scale = scene.scale !== undefined ? scene.scale : 1;
    const posX = scene.posX || 0;
    const posY = scene.posY || 0;

    // Apply transform - translate first then scale
    videoElement.style.transform = `translate(${posX}%, ${posY}%) scale(${scale})`;
    videoElement.style.transformOrigin = 'center center';
    // Fit mode: contain shows full media (vertical/square), cover fills frame (16:9)
    videoElement.style.objectFit = scene.fitMode || 'cover';

    // Crop on the media element (so scaling can push crop edges out of view)
    applyCrop(videoElement, scene);
    videoElement.style.borderRadius = '';

    // Border-radius on the track wrapper (clean rounded corners)
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const wrapper = elements[`trackWrapper${trackNum}`];
    if (wrapper) {
        applyRadius(wrapper, scene);
        wrapper.style.clipPath = ''; // Ensure no leftover clip-path on wrapper
    }
}

function applyEditorFramingPreset(scene, requestedFraming) {
    if (!scene) return;
    const framing = ['fullscreen', 'cinematic', 'floating'].includes(requestedFraming)
        ? requestedFraming
        : 'fullscreen';
    const width = Number(scene.mediaWidth || scene.width) || 0;
    const height = Number(scene.mediaHeight || scene.height) || 0;
    const ratio = width > 0 && height > 0 ? width / height : Number(scene.aspectRatio) || 0;
    const fillFactor = Math.min(1, Math.max(0, (ratio - 1) / ((1920 / 1080) - 1)));

    scene.framing = framing;
    scene.framingMode = framing;
    scene.fit = 'cover';
    scene.fitMode = 'cover';
    scene.posX = 0;
    scene.posY = 0;
    delete scene._verticalContain;
    delete scene._verticalContainReason;

    if (framing === 'floating') {
        const currentScale = Number(scene.scale);
        scene.scale = currentScale >= 0.4 && currentScale <= 0.6
            ? currentScale
            : Math.round((0.45 + fillFactor * 0.10) * 100) / 100;
        scene.background = scene.background && scene.background !== 'none' ? scene.background : 'blur';
        scene.backgroundId = scene.backgroundId && scene.backgroundId !== 'none' ? scene.backgroundId : 'blur';
        scene.floatingBackground = scene.background;
        scene.borderRadius = 4;
        scene.shadow = 0.5;
        scene.floatingShadow = 0.5;
        scene.floatingAnim = scene.floatingAnim || 'slideRight';
        scene.floatingAnimDuration = Number(scene.floatingAnimDuration) || 0.6;
    } else if (framing === 'cinematic') {
        const currentScale = Number(scene.scale);
        scene.scale = currentScale >= 0.7 && currentScale < 1
            ? currentScale
            : Math.round((0.75 + fillFactor * 0.20) * 100) / 100;
        scene.background = scene.background && scene.background !== 'none' ? scene.background : 'blur';
        scene.backgroundId = scene.backgroundId && scene.backgroundId !== 'none' ? scene.backgroundId : 'blur';
        scene.floatingBackground = scene.background;
        scene.borderRadius = 0;
        scene.shadow = 0;
        scene.floatingShadow = 0;
        scene.floatingAnim = null;
        scene.floatingAnimDuration = null;
    } else {
        scene.scale = 1;
        scene.background = 'none';
        scene.backgroundId = 'none';
        scene.floatingBackground = 'none';
        scene.borderRadius = 0;
        scene.shadow = 0;
        scene.floatingShadow = 0;
        scene.floatingAnim = null;
        scene.floatingAnimDuration = null;
    }
}

/**
 * Apply transform to a scene by index (finds the scene's track video)
 */
function applySceneTransform(sceneIndex) {
    if (sceneIndex < 0 || !state.scenes[sceneIndex]) return;

    const scene = state.scenes[sceneIndex];
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const isImage = scene.mediaType === 'image';

    if (isImage) {
        // For images, update via Ken Burns (which combines scene transform + KB animation)
        const img = elements[`imgTrack${trackNum}`];
        if (img) updateKenBurnsTransform(img, scene);
    } else {
        const video = getActiveTrackVideo(trackNum);
        if (video) applySceneTransformToVideo(video, scene);
    }
}

function clearSceneTransform() {
    // Clear transform and crop from all track video/img elements (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.style.transform = '';
            video.style.transformOrigin = '';
            video.style.objectFit = '';
            video.style.clipPath = '';
        }
    });
    [elements.imgTrack1, elements.imgTrack2, elements.imgTrack3].forEach(img => {
        if (img) {
            img.style.clipPath = '';
        }
    });
    // Clear radius from track wrappers
    [elements.trackWrapper1, elements.trackWrapper2, elements.trackWrapper3].forEach(wrapper => {
        if (wrapper) {
            wrapper.style.clipPath = '';
            wrapper.style.borderRadius = '';
            wrapper.style.overflow = '';
        }
    });
}

// ========================================
// Preview Drag & Scroll (Scale/Position)
// ========================================
function setupPreviewDrag() {
    const videoFrame = elements.videoContainer;
    const previewArea = elements.previewContainer;
    if (!videoFrame || !previewArea) return;

    // Clip position drag (left button on video frame)
    let isDragging = false;
    let startX = 0, startY = 0;
    let startPosX = 0, startPosY = 0;

    videoFrame.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Only left button
        if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) return;
        if (e.target.closest('.video-controls')) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const scene = state.scenes[state.selectedClipIndex];
        startPosX = scene.posX || 0;
        startPosY = scene.posY || 0;
        videoFrame.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || state.selectedClipIndex < 0) return;

        const rect = videoFrame.getBoundingClientRect();
        const deltaX = ((e.clientX - startX) / rect.width) * 100;
        const deltaY = ((e.clientY - startY) / rect.height) * 100;

        const scene = state.scenes[state.selectedClipIndex];
        scene.posX = Math.max(-50, Math.min(50, Math.round(startPosX + deltaX)));
        scene.posY = Math.max(-50, Math.min(50, Math.round(startPosY + deltaY)));

        applySceneTransform(state.selectedClipIndex);
        updateClipProperties();
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            videoFrame.style.cursor = '';
        }
    });

    // ========================================
    // Preview zoom & pan (works from entire preview area)
    // ========================================

    // Scroll wheel: smooth zoom (works anywhere in preview area)
    previewArea.addEventListener('wheel', (e) => {
        e.preventDefault();

        const currentZoom = state.previewZoom === 'fit' ? 100 : state.previewZoom;
        const delta = e.deltaY < 0 ? 5 : -5; // Slower zoom: 5% increments
        let newZoom = currentZoom + delta;

        if (newZoom < 25) newZoom = 'fit';
        else if (newZoom > 200) newZoom = 200;
        else newZoom = Math.round(newZoom / 5) * 5;

        setPreviewZoom(newZoom);
    });

    // Right mouse button: pan when zoomed (works anywhere in preview area)
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panScrollLeft = 0;
    let panScrollTop = 0;

    previewArea.addEventListener('mousedown', (e) => {
        if (e.button === 2 && state.previewZoom !== 'fit') { // Right button
            e.preventDefault();
            isPanning = true;
            panStartX = e.clientX;
            panStartY = e.clientY;
            panScrollLeft = previewArea.scrollLeft;
            panScrollTop = previewArea.scrollTop;
            previewArea.style.cursor = 'grabbing';
        }
    });

    previewArea.addEventListener('mousemove', (e) => {
        if (isPanning) {
            e.preventDefault();
            const dx = e.clientX - panStartX;
            const dy = e.clientY - panStartY;
            previewArea.scrollLeft = panScrollLeft - dx;
            previewArea.scrollTop = panScrollTop - dy;
        }
    });

    previewArea.addEventListener('mouseup', (e) => {
        if (e.button === 2 && isPanning) {
            isPanning = false;
            previewArea.style.cursor = '';
        }
    });

    previewArea.addEventListener('mouseleave', () => {
        if (isPanning) {
            isPanning = false;
            previewArea.style.cursor = '';
        }
    });

    // Prevent default context menu on right click when zoomed
    previewArea.addEventListener('contextmenu', (e) => {
        if (state.previewZoom !== 'fit') {
            e.preventDefault();
        }
    });
}

// ========================================
// Preview Zoom (like Premiere Pro Program Monitor)
// ========================================
function setupPreviewZoom() {
    const select = elements.previewZoomSelect;
    if (!select) return;

    select.addEventListener('change', (e) => {
        const val = e.target.value;
        setPreviewZoom(val === 'fit' ? 'fit' : parseInt(val));
    });
}

function setPreviewZoom(zoom) {
    state.previewZoom = zoom;

    const container = elements.previewContainer;
    const videoFrame = elements.videoContainer;
    const hyperFrame = elements.hyperframesPreviewFrame;
    const previewFrames = [videoFrame, hyperFrame].filter(Boolean);
    if (!container || previewFrames.length === 0) return;

    // Update label
    if (elements.previewZoomLabel) {
        elements.previewZoomLabel.textContent = zoom === 'fit' ? 'Fit' : `${zoom}%`;
    }

    // Update dropdown to closest preset
    if (elements.previewZoomSelect) {
        const presets = [25, 50, 75, 100, 150, 200];
        if (zoom === 'fit') {
            elements.previewZoomSelect.value = 'fit';
        } else {
            // Find closest preset
            const closest = presets.reduce((prev, curr) =>
                Math.abs(curr - zoom) < Math.abs(prev - zoom) ? curr : prev
            );
            // Only update if exact match, otherwise leave dropdown as is
            if (presets.includes(zoom)) {
                elements.previewZoomSelect.value = String(zoom);
            }
        }
    }

    if (zoom === 'fit') {
        // Fit mode: 16:9 frame fills available space
        container.classList.remove('zoomed');
        previewFrames.forEach(frame => {
            frame.style.width = '';
            frame.style.height = '';
            frame.style.minWidth = '';
            frame.style.minHeight = '';
        });
    } else {
        // Specific zoom %: actual pixel size relative to 1920x1080
        const w = Math.round(1920 * zoom / 100);
        const h = Math.round(1080 * zoom / 100);
        container.classList.add('zoomed');
        previewFrames.forEach(frame => {
            frame.style.width = `${w}px`;
            frame.style.height = `${h}px`;
            frame.style.minWidth = `${w}px`;
            frame.style.minHeight = `${h}px`;
        });

        // Center scroll position (only on first zoom, not during pan)
        requestAnimationFrame(() => {
            container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
            container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
        });
    }
}

// ========================================
// Save Project
// ========================================
function syncVideoPlanFromEditor() {
    if (!state.videoPlan) return null;

    const fps = state.videoPlan.fps || 30;
    const mediaScenes = state.scenes.filter(s => !s.isMGScene);
    const normalizedMediaScenes = timelineContract?.normalizeScenes
        ? timelineContract.normalizeScenes(mediaScenes, {
            fps,
            totalDuration: state.totalDuration,
        })
        : mediaScenes.map((scene, index) => ({
            ...scene,
            index: getSceneSourceIndex(scene, index),
            sourceSceneIndex: getSceneSourceIndex(scene, index),
            clipId: scene.clipId || createUniqueClipId(scene),
            ...getSceneTiming(scene),
        }));
    normalizedMediaScenes.forEach((scene, index) => Object.assign(mediaScenes[index], scene));
    state.videoPlan.scenes = timelineContract?.serializeScenes
        ? timelineContract.serializeScenes(normalizedMediaScenes, {
            fps,
            totalDuration: state.totalDuration,
        })
        : normalizedMediaScenes.map((scene, index) => ({
            ...scene,
            index,
            sourceSceneIndex: getSceneSourceIndex(scene, index),
        }));

    const fullscreenMGs = state.scenes.filter(s => s.isMGScene && !s.templateType);
    const normalizedMGs = timelineContract?.normalizeVisualScenes
        ? timelineContract.normalizeVisualScenes(fullscreenMGs, {
            fps,
            totalDuration: state.totalDuration,
            prefix: 'mg',
        })
        : fullscreenMGs.map((scene) => ({ ...scene, ...getSceneTiming(scene) }));
    normalizedMGs.forEach((scene, index) => Object.assign(fullscreenMGs[index], scene));
    state.videoPlan.mgScenes = timelineContract?.serializeVisualScenes
        ? timelineContract.serializeVisualScenes(normalizedMGs, {
            fps,
            totalDuration: state.totalDuration,
            prefix: 'mg',
        })
        : normalizedMGs;

    const templateScenes = state.scenes.filter(s => s.isMGScene && s.templateType);
    const normalizedTemplates = timelineContract?.normalizeVisualScenes
        ? timelineContract.normalizeVisualScenes(templateScenes, {
            fps,
            totalDuration: state.totalDuration,
            prefix: 'template',
            fallbackDuration: 4,
        })
        : templateScenes.map((scene) => ({ ...scene, ...getSceneTiming(scene, 4) }));
    normalizedTemplates.forEach((scene, index) => Object.assign(templateScenes[index], scene));
    const persistedTemplates = normalizedTemplates
        .map(s => ({ ..._normalizeTemplateSceneBackground(s) }));
    state.videoPlan.templateScenes = timelineContract?.serializeVisualScenes
        ? timelineContract.serializeVisualScenes(persistedTemplates, {
            fps,
            totalDuration: state.totalDuration,
            prefix: 'template',
            fallbackDuration: 4,
        })
        : persistedTemplates;
    state.videoPlan.timelineContractVersion = timelineContract?.VERSION || 2;
    state.videoPlan.mutedTracks = { ...state.mutedTracks };
    state.videoPlan.totalDuration = state.totalDuration;
    state.videoPlan.transitions = JSON.parse(JSON.stringify(state.transitions || []));

    // The build Sound Designer owns SFX placement and levels. The editor preserves
    // that authored track verbatim instead of regenerating a second mechanical one.
    delete state.videoPlan.sfxEnabled;
    delete state.videoPlan.sfxVolume;
    state.videoPlan.sfxClips = state.sfxClips.map(sfx => ({
        file: sfx.file,
        startTime: sfx.startTime,
        duration: sfx.duration,
        volume: sfx.volume,
        transitionType: sfx.transitionType || undefined,
        role: sfx.role || undefined,
        why: sfx.why || undefined,
    }));

    state.videoPlan.subtitlesEnabled = state.subtitlesEnabled;
    state.videoPlan.mgStyle = state.mgStyle;
    state.videoPlan.motionGraphics = state.motionGraphics.map(mg => {
        // Preserve the complete authored visual contract. Agentic composition,
        // colors, items, variants, render assets, and future fields must survive
        // an unrelated editor save; only compositor/runtime caches are stripped.
        const base = JSON.parse(JSON.stringify(mg || {}));
        for (const field of [
            '_startFrame', '_endFrame', '_totalFrames', '_trackNum', '_animationSpeed',
            '_authoredRendered', 'explainerImageUrl', 'articleImageUrl', 'mapImageUrl',
        ]) delete base[field];
        base.id = mg.id;
        base.clipId = mg.clipId || mg.id;
        base.type = mg.type;
        base.style = mg.style || state.mgStyle || 'clean';
        base.overlayShadowStrength = mg.overlayShadowStrength != null
            ? mg.overlayShadowStrength
            : state.mgOverlayShadow;
        base.textStyleRanges = Array.isArray(mg.textStyleRanges)
            ? mg.textStyleRanges.map((range) => ({
                match: String(range?.match || range?.text || '').slice(0, 1_000),
                color: String(range?.color || range?.textColor || '').slice(0, 120),
                occurrence: Number.isInteger(Number(range?.occurrence))
                    ? Number(range.occurrence)
                    : 0,
                allOccurrences: range?.allOccurrences === true,
            })).filter((range) => range.match && range.color)
            : undefined;
        if (mg.type === 'explainer') {
            if (mg.explainerImageFile) base.explainerImageFile = mg.explainerImageFile;
            if (mg.explainerLabel) base.explainerLabel = mg.explainerLabel;
            if (mg.explainerQuery) base.explainerQuery = mg.explainerQuery;
            if (mg.explainerBgOpacity != null) base.explainerBgOpacity = mg.explainerBgOpacity;
            if (mg.explainerImgScale != null) base.explainerImgScale = mg.explainerImgScale;
            if (mg.explainerShadow) base.explainerShadow = mg.explainerShadow;
        }
        if (mg.articleImageFile) base.articleImageFile = mg.articleImageFile;
        if (mg.highlightBoxes) base.highlightBoxes = mg.highlightBoxes;
        [
            'mediaFile',
            'mediaPath',
            'assetFile',
            'assetPath',
            'imageFile',
            'imagePath',
            'videoFile',
            'videoPath',
            'backgroundMediaFile',
            'backgroundImageFile',
            'backgroundVideoFile',
            'templateMediaFile',
            'templateBackgroundFile',
            'templateBackgroundMediaFile',
            'templateBackgroundImageFile',
            'templateBackgroundVideoFile'
        ].forEach((key) => {
            if (mg[key]) base[key] = mg[key];
        });
        if (mg.mapImageFile) base.mapImageFile = mg.mapImageFile;
        if (mg.mapImagePath) base.mapImagePath = mg.mapImagePath;
        if (mg.mapImage) base.mapImage = mg.mapImage;
        if (mg._mapView) base._mapView = mg._mapView;
        if (mg._mapPins) base._mapPins = mg._mapPins;
        if (mg.renderAssets) base.renderAssets = mg.renderAssets;
        if (mg.mgData) base.mgData = mg.mgData;
        return base;
    });

    const globalAnimSpeed = parseFloat(document.getElementById('mg-global-anim-speed')?.value) || 1.0;
    if (!state.videoPlan.scriptContext) state.videoPlan.scriptContext = {};
    state.videoPlan.scriptContext.mgAnimationSpeed = globalAnimSpeed;
    state.videoPlan.scriptContext.mgOverlayShadow = state.mgOverlayShadow;
    if (timelineContract?.normalizePlan) {
        state.videoPlan = timelineContract.normalizePlan(state.videoPlan);
    } else {
        state.videoPlan.timelineContractVersion = timelineContract?.VERSION || 3;
    }
    window._mgBridgeVideoPlan = state.videoPlan;
    return state.videoPlan;
}

async function _saveProjectNow(silent = false) {
    if (!state.videoPlan) {
        if (!silent) showToast('No project to save', 'info');
        return;
    }
    try {
        syncVideoPlanFromEditor();

        // Collect current editor settings
        const settings = {
            // Element-backed settings from the schema (single source of truth) —
            // now includes quality/format/theme/etc. that the old list silently dropped.
            ...SettingsIO.collect('fvp'),
            // State-backed + special settings (no simple element control) stay explicit.
            volume: state.volume,
            footageSources: getEnabledSources(),
            subtitlesEnabled: state.subtitlesEnabled,
            aiInstructions: state.aiInstructions,
            videoTitle: state.videoTitle,
            presenterImage: state.presenterImage || '',
            buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
            mutedTracks: state.mutedTracks
        };

        // Save as .fvp project file (includes settings + video plan + writes video-plan.json)
        if (window.electronAPI.saveProjectFile) {
            const expectedRevision = state.projectRevision;
            const expectedPlanHash = state.projectPlanHash;
            const result = await window.electronAPI.saveProjectFile({
                settings,
                videoPlan: state.videoPlan,
                expectedRevision,
                expectedPlanHash,
            });
            if (!result?.success) {
                if (result?.conflict) {
                    const authoritativeRevision = Number(result.currentRevision) || 0;
                    const authoritativePlanHash = result.currentPlanHash || null;
                    const requestWasSuperseded = Number(state.projectRevision) !== Number(expectedRevision)
                        || (!!expectedPlanHash && !!state.projectPlanHash && expectedPlanHash !== state.projectPlanHash);
                    const rendererHasAuthoritativeState = Number(state.projectRevision) === authoritativeRevision
                        && (!authoritativePlanHash || state.projectPlanHash === authoritativePlanHash);
                    if (silent && requestWasSuperseded && rendererHasAuthoritativeState) {
                        console.info('[ProjectStore] Discarded a stale autosave after an authoritative QA update.');
                        return { success: true, skipped: true, stale: true };
                    }
                    showToast('Project changed outside this editor. Reload before saving to avoid data loss.', 'error');
                }
                throw new Error(result?.error || 'Project save failed');
            }
            state.hasProjectFile = true;
            state.projectRevision = Number(result.revision) || state.projectRevision;
            state.projectPlanHash = result.planHash || state.projectPlanHash;
            if (!silent && result && result.path) {
                showToast(`Project saved to ${result.path}`, 'success');
            } else if (!silent) {
                showToast('Project saved', 'success');
            }
        } else {
            // Fallback: old save method
            const fallbackResult = await window.electronAPI.saveVideoPlan(
                state.videoPlan,
                state.projectRevision,
                state.projectPlanHash
            );
            if (fallbackResult?.success === false) {
                throw new Error(fallbackResult.error || 'Video plan save failed');
            }
            state.projectRevision = Number(fallbackResult?.revision) || state.projectRevision;
            state.projectPlanHash = fallbackResult?.planHash || state.projectPlanHash;
            if (!silent) showToast('Project saved', 'success');
        }
        return { success: true };
    } catch (e) {
        console.error('Save failed:', e);
        if (!silent) showToast('Save failed', 'error');
        return { success: false, error: e.message };
    }
}

let _projectSaveChain = Promise.resolve();
function saveProject(silent = false) {
    const run = _projectSaveChain.then(() => _saveProjectNow(silent));
    _projectSaveChain = run.catch(() => {});
    return run;
}

// Debounced auto-save: saves .fvp file 3 seconds after last change
let _autoSaveTimer = null;
function triggerAutoSave() {
    if (state.projectHydrating) return;
    if (state.hyperframesPreview?.active) scheduleHyperframesPreviewRefresh();
    if (!state.hasProjectFile || !state.videoPlan) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
        if (state.isProcessing) {
            triggerAutoSave();
            return;
        }
        saveProject(true); // silent save
    }, 3000);
}

function togglePlayback() {
    if (state.scenes.length === 0) return;

    if (state.isPlaying || state.playbackStarting) {
        stopPlayback();
    } else {
        void startPlayback();
    }
}

function _clampPlaybackTime(time) {
    const value = Math.max(0, Number(time) || 0);
    const duration = Number(state.totalDuration);
    return Number.isFinite(duration) && duration > 0
        ? Math.min(value, duration)
        : value;
}

async function _positionPreviewAudio(audio, targetTime, timeoutMs = 900) {
    if (!audio?.src) return false;

    if (audio.readyState === 0) {
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                audio.removeEventListener('loadedmetadata', finish);
                audio.removeEventListener('canplay', finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            audio.addEventListener('loadedmetadata', finish, { once: true });
            audio.addEventListener('canplay', finish, { once: true });
            try { audio.load(); } catch (_) {}
        });
    }

    const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : state.totalDuration;
    const target = Math.max(0, Math.min(targetTime, duration || targetTime));
    if (!audio.seeking && Math.abs((audio.currentTime || 0) - target) <= 0.04) return true;

    await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            audio.removeEventListener('seeked', finish);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        audio.addEventListener('seeked', finish, { once: true });
        try {
            audio.currentTime = target;
            if (!audio.seeking && Math.abs((audio.currentTime || 0) - target) <= 0.04) {
                queueMicrotask(finish);
            }
        } catch (_) {
            finish();
        }
    });

    // Re-apply once after the wait. Some Windows media backends briefly report
    // currentTime=0 while completing the first seek on a freshly loaded source.
    if (Math.abs((audio.currentTime || 0) - target) > 0.2) {
        try { audio.currentTime = target; } catch (_) {}
    }
    return Math.abs((audio.currentTime || 0) - target) <= 0.25 || audio.seeking;
}

async function startPlayback() {
    if (state.isPlaying || state.playbackStarting) return;

    const requestId = ++state.playbackStartRequest;
    state.playbackStarting = true;
    let targetTime = _clampPlaybackTime(state.currentTime);

    try {
        // If at the end, restart from beginning.
        if (targetTime >= state.totalDuration) {
            state.currentTime = 0;
            state.currentSceneIndex = 0;
            await jumpToScene(0);
            targetTime = 0;
        }

        await _positionPreviewAudio(elements.previewAudio, targetTime);
        if (requestId !== state.playbackStartRequest || !state.playbackStarting) return;

        state.playbackStarting = false;
        actuallyStartPlayback(targetTime);
    } catch (error) {
        if (requestId !== state.playbackStartRequest) return;
        state.playbackStarting = false;
        console.warn('Playback preparation failed:', error);
        actuallyStartPlayback(targetTime);
    }
}

function actuallyStartPlayback(startTime = state.currentTime) {
    const audio = elements.previewAudio;
    state.currentTime = _clampPlaybackTime(startTime);
    const activeScenes = getActiveScenesAtTime(state.currentTime);

    state.isPlaying = true;
    state.lastPlaybackTime = performance.now();
    state.playbackClockFloor = state.currentTime;
    state.playbackClockGuardUntil = performance.now() + 1200;

    // Update play button
    if (elements.btnPlay) {
        elements.btnPlay.textContent = '⏸';
    }

    // Start all active track videos unless HyperFrames owns the visual preview.
    if (!state.hyperframesPreview?.active && activeScenes.length > 0) {
        activeScenes.forEach(({ scene }) => {
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src) {
                video.play().catch(e => console.warn('Video play failed:', e));
            }
        });
    } else if (state.hyperframesPreview?.active) {
        elements.videoContainer?.classList.add('hidden');
        elements.previewPlaceholder?.classList.add('hidden');
    } else {
        // In a timeline gap, keep the last visual frame visible until the next scene/template starts.
        if (state.scenes.length === 0) {
            elements.videoContainer?.classList.add('hidden');
            elements.previewPlaceholder?.classList.remove('hidden');
        } else {
            elements.videoContainer?.classList.remove('hidden');
            elements.previewPlaceholder?.classList.add('hidden');
        }
    }

    // Always start audio - it plays through gaps
    if (audio?.src) {
        _bindPlaybackAudioClock(audio);
        const target = Math.min(state.currentTime, audio.duration || state.totalDuration);
        if (Math.abs((audio.currentTime || 0) - target) > 0.12) {
            try { audio.currentTime = target; } catch (_) {}
        }
        audio.play().catch(e => console.warn('Audio play failed:', e));
    }

    // Start compositor videos if in compositor mode
    if (state.compositorActive && state.compositor) {
        state.compositor.playVideos(state.currentTime);
    }

    syncHyperframesPreview(true);

    // Start the playback loop
    startPlaybackLoop();
}

function stopPlayback() {
    state.playbackStartRequest++;
    state.playbackStarting = false;
    state.playbackClockFloor = 0;
    state.playbackClockGuardUntil = 0;
    state.isPlaying = false;

    // Update play button
    if (elements.btnPlay) {
        elements.btnPlay.textContent = '▶';
    }

    // Cancel both playback schedulers. requestAnimationFrame can be throttled
    // by Windows when DevTools is docked or the Electron surface is considered
    // occluded, so playback also keeps a short timer fallback.
    if (state.playbackAnimationFrame) {
        cancelAnimationFrame(state.playbackAnimationFrame);
        state.playbackAnimationFrame = null;
    }
    if (state.playbackTimer) {
        clearTimeout(state.playbackTimer);
        state.playbackTimer = null;
    }

    // Pause compositor videos
    if (state.compositor) state.compositor.pauseVideos();

    // Reset scene load flag and per-track swap flags
    state._sceneLoadPending = false;
    state._trackSwapPending = { '1': false, '2': false, '3': false };
    state._trackLastHardSyncMs = { '1': 0, '2': 0, '3': 0 };
    state.activeSceneIndices = [];
    state.activeOverlaySceneIndices = [];

    // Flush deferred bgVideo load
    if (elements.bgVideo && elements.bgVideo._pendingSrc) {
        elements.bgVideo.src = elements.bgVideo._pendingSrc;
        elements.bgVideo._pendingSrc = null;
        elements.bgVideo.load();
    }

    // Pause all track video elements (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B,
    elements.videoTransitionOut].forEach(video => {
        if (video && !video.paused) {
            video.pause();
        }
        if (video) {
            video.playbackRate = 1;
        }
    });

    // Stop all SFX
    stopAllSfx();

    // Clean up any ongoing transition
    state.transition.isTransitioning = false;
    if (elements.videoTransitionOut) {
        resetVideoTransitionState(elements.videoTransitionOut);
        elements.videoTransitionOut.src = '';
        elements.videoTransitionOut.style.zIndex = '';
    }
    if (elements.imgTransitionOut) {
        elements.imgTransitionOut.classList.remove('incoming', 'outgoing', 'active');
        elements.imgTransitionOut.src = '';
        elements.imgTransitionOut.style.zIndex = '';
        elements.imgTransitionOut.style.opacity = '';
        elements.imgTransitionOut.style.transform = '';
        elements.imgTransitionOut.style.filter = '';
        elements.imgTransitionOut.style.clipPath = '';
        elements.imgTransitionOut.style.visibility = '';
    }
    if (elements.videoContainer) {
        elements.videoContainer.className = 'video-transition-container';
    }

    // Pause audio
    const audio = elements.previewAudio;
    if (audio && !audio.paused) {
        audio.pause();
    }

    syncHyperframesPreview(true);
}

function _cancelPlaybackTick() {
    if (state.playbackAnimationFrame) {
        cancelAnimationFrame(state.playbackAnimationFrame);
        state.playbackAnimationFrame = null;
    }
    if (state.playbackTimer) {
        clearTimeout(state.playbackTimer);
        state.playbackTimer = null;
    }
}

function _schedulePlaybackTick(loop) {
    let fired = false;
    const run = () => {
        if (fired) return;
        fired = true;
        _cancelPlaybackTick();
        loop();
    };
    state.playbackAnimationFrame = requestAnimationFrame(run);
    state.playbackTimer = setTimeout(run, 50);
}

function _readPlaybackAudioClock(audio) {
    if (!audio?.src || audio.paused) return null;
    const audioTime = Math.max(0, Number(audio.currentTime) || 0);
    const floor = Math.max(0, Number(state.playbackClockFloor) || 0);
    const guardActive = performance.now() < (state.playbackClockGuardUntil || 0);

    if (guardActive && floor > 0.05 && audioTime + 0.25 < floor) {
        // Never let a transient pre-seek `0` overwrite the user's selected
        // playhead. Nudge the media clock back to the requested start as soon
        // as the backend is ready to accept another seek.
        if (!audio.seeking) {
            try { audio.currentTime = floor; } catch (_) {}
        }
        return Math.max(state.currentTime, floor);
    }

    if (!audio.seeking && audioTime + 0.25 >= floor) {
        state.playbackClockGuardUntil = 0;
    }
    return audioTime;
}

function _syncPlaybackFromAudioEvent() {
    if (!state.isPlaying) return;
    const audio = elements.previewAudio;
    const audioTime = _readPlaybackAudioClock(audio);
    if (audioTime === null) return;

    state.currentTime = _clampPlaybackTime(audioTime);
    state.lastPlaybackTime = performance.now();

    if (state.currentTime >= state.totalDuration) {
        state.currentTime = state.totalDuration;
        stopPlayback();
    } else if (state.hyperframesPreview?.active) {
        syncHyperframesPreview();
    } else if (state.compositorActive && state.compositor?.isInitialized) {
        state.compositor.renderAtTime(state.currentTime);
    }

    updatePlayhead();
    updateTimeDisplay();
    const activeScenes = getActiveScenesAtTime(state.currentTime);
    const activeMediaScenes = activeScenes.filter(({ scene }) => !scene.isMGScene && !scene.disabled);
    updateSceneHighlight(activeMediaScenes.length > 0 ? activeMediaScenes[0].index : -1);
}

function _bindPlaybackAudioClock(audio) {
    if (!audio || audio._ytaPlaybackClockBound) return;
    audio._ytaPlaybackClockBound = true;
    audio.addEventListener('timeupdate', _syncPlaybackFromAudioEvent);
    audio.addEventListener('playing', _syncPlaybackFromAudioEvent);
    audio.addEventListener('seeked', _syncPlaybackFromAudioEvent);
    audio.addEventListener('ended', () => {
        if (!state.isPlaying) return;
        const audioEnd = Math.max(0, Number(audio.currentTime) || Number(audio.duration) || 0);
        if (state.totalDuration <= audioEnd + 0.25) {
            state.currentTime = state.totalDuration;
            stopPlayback();
            updatePlayhead();
            updateTimeDisplay();
        } else {
            // Some edits intentionally continue after narration ends. Keep the
            // visual clock running from the last audio position instead of
            // jumping the playhead to the end of the whole timeline.
            state.currentTime = Math.max(state.currentTime, audioEnd);
            state.lastPlaybackTime = performance.now();
        }
    });
}


function startPlaybackLoop() {
    _cancelPlaybackTick();

    const loop = () => {
        if (!state.isPlaying) return;

        const audio = elements.previewAudio;

        // === HyperFrames preview path (same HTML as final render) ===
        if (state.hyperframesPreview?.active) {
            const now = performance.now();
            const delta = Math.max(0, (now - (state.lastPlaybackTime || now)) / 1000);
            state.lastPlaybackTime = now;

            const audioTime = _readPlaybackAudioClock(audio);
            if (audioTime !== null) {
                state.currentTime = audioTime;
            } else {
                state.currentTime = Math.min(state.totalDuration, state.currentTime + delta);
            }

            if (state.currentTime >= state.totalDuration) {
                state.currentTime = state.totalDuration;
                stopPlayback();
                updatePlayhead();
                updateTimeDisplay();
                return;
            }

            // Trigger SFX in the HyperFrames preview (the iframe composition is a
            // MUTED visual scrubber — its <audio> tags never play in preview — so
            // the app's own SFX pool is the ONLY path to the speakers here. Without
            // this block the user hears no SFX at all in the default preview.)
            if (state.sfxClips.length > 0) {
                const ct = state.currentTime;
                state.sfxClips.forEach(sfx => {
                    const sfxEnd = sfx.startTime + sfx.duration;
                    if (ct >= sfx.startTime && ct < sfxEnd && !sfx._triggered) {
                        sfx._triggered = true;
                        playSfxClip(sfx);
                    }
                    if (ct < sfx.startTime || ct >= sfxEnd) {
                        sfx._triggered = false;
                    }
                });
            }

            syncHyperframesPreview();
            updatePlayhead();
            updateTimeDisplay();
            const activeScenes = getActiveScenesAtTime(state.currentTime);
            updateSceneHighlight(activeScenes.length > 0 ? activeScenes[0].index : -1);

            _schedulePlaybackTick(loop);
            return;
        }

        // === WebGL2 Compositor path (when active, bypasses HTML preview) ===
        if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
            // Audio is still the master clock
            const audioTime = _readPlaybackAudioClock(audio);
            if (audioTime !== null) {
                state.currentTime = audioTime;
            }
            // Check end of timeline
            if (state.currentTime >= state.totalDuration) {
                state.currentTime = state.totalDuration;
                stopPlayback();
                updatePlayhead();
                updateTimeDisplay();
                return;
            }
            // Render the frame via WebGL2 engine
            state.compositor.renderAtTime(state.currentTime);
            // Sync audio
            if (audioTime !== null) {
                const audioDiff = Math.abs(audio.currentTime - state.currentTime);
                if (audioDiff > 0.2) {
                    audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
                }
            }
            // Trigger SFX clips at transition points
            if (state.sfxClips.length > 0) {
                const ct = state.currentTime;
                state.sfxClips.forEach(sfx => {
                    const sfxEnd = sfx.startTime + sfx.duration;
                    if (ct >= sfx.startTime && ct < sfxEnd && !sfx._triggered) {
                        sfx._triggered = true;
                        playSfxClip(sfx);
                    }
                    if (ct < sfx.startTime || ct >= sfxEnd) {
                        sfx._triggered = false;
                    }
                });
            }
            // Update UI (playhead, time, scene highlight)
            updatePlayhead();
            updateTimeDisplay();
            const activeScenes = getActiveScenesAtTime(state.currentTime);
            const activeMediaScenes = activeScenes.filter(({ scene }) => !scene.isMGScene && !scene.disabled);
            updateSceneHighlight(activeMediaScenes.length > 0 ? activeMediaScenes[0].index : -1);
            // Continue loop
            _schedulePlaybackTick(loop);
            return;
        }

        // === Original HTML-based preview path ===
        const activeScenes = getActiveScenesAtTime(state.currentTime);
        const activeMediaScenes = activeScenes.filter(({ scene }) =>
            !scene.isMGScene && !scene.disabled
        );
        // Use audio as the master clock - it plays continuously through gaps
        const audioTime = _readPlaybackAudioClock(audio);
        if (audioTime !== null) {
            state.currentTime = audioTime;
        } else if (activeMediaScenes.length > 0) {
            // Use first active video as clock
            const firstScene = activeMediaScenes[0].scene;
            const trackNum = firstScene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src && !video.paused) {
                state.currentTime = firstScene.startTime + video.currentTime - (firstScene.mediaOffset || 0);
            }
        }

        // Update time displays
        if (elements.currentTimeDisplay) {
            elements.currentTimeDisplay.textContent = formatTime(state.currentTime, true);
        }
        if (elements.totalTimeDisplay) {
            elements.totalTimeDisplay.textContent = formatTime(state.totalDuration, true);
        }

        // Check if we've reached the end of the timeline
        if (state.currentTime >= state.totalDuration) {
            state.currentTime = state.totalDuration;
            stopPlayback();
            updatePlayhead();
            updateTimeDisplay();
            return;
        }

        // Check if active scenes changed
        const mediaIndices = activeMediaScenes.map(s => s.index).join(',');
        const prevMediaIndices = (state.activeSceneIndices || []).join(',');
        const shouldReload = mediaIndices !== prevMediaIndices;

        if (shouldReload && !state._sceneLoadPending) {
            // Don't update activeSceneIndices yet — wait until load completes
            // This prevents the time sync from running on wrong video during load
            state._sceneLoadPending = true;
            loadActiveScenes(activeScenes).then(() => {
                state._sceneLoadPending = false;
                state.activeSceneIndices = activeMediaScenes.map(s => s.index);
                // After load completes, ensure videos are playing
                if (state.isPlaying) {
                    getActiveScenesAtTime(state.currentTime).forEach(({ scene }) => {
                        if (scene.mediaType === 'image' || scene.isMGScene) return;
                        const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                        const vid = getActiveTrackVideo(tn);
                        if (vid && vid.paused && vid.src) {
                            vid.play().catch(() => { });
                        }
                    });
                }
                // Immediately preload the NEXT scene after this one finishes loading
                preloadUpcomingScenes(state.currentTime, true);
            }).catch(e => {
                state._sceneLoadPending = false;
                console.error('Scene load error:', e);
            });
        } else if (!shouldReload) {
            // Only sync time when loaded scenes MATCH expected scenes
            const now = performance.now();
            activeMediaScenes.forEach(({ scene }) => {
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                // Skip tracks with a deferred swap in progress — old clip plays naturally
                if (state._trackSwapPending[trackNum]) return;
                const isImage = scene.mediaType === 'image';
                if (isImage) {
                    // Update Ken Burns transform every frame for smooth animation
                    const img = elements[`imgTrack${trackNum}`];
                    if (img) {
                        updateKenBurnsTransform(img, scene);
                    }
                } else {
                    const video = getActiveTrackVideo(trackNum);
                    if (video && !video.paused) {
                        const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
                        const drift = sceneTime - video.currentTime;
                        const absDrift = Math.abs(drift);
                        const lastHardSync = state._trackLastHardSyncMs[trackNum] || 0;

                        // Avoid frequent hard seeks: they cause visible stutter.
                        // Hard-seek only for large drift, otherwise gently nudge playbackRate.
                        if (absDrift > 0.35 || (absDrift > 0.18 && now - lastHardSync > 500)) {
                            video.currentTime = Math.max(0, sceneTime);
                            state._trackLastHardSyncMs[trackNum] = now;
                            video.playbackRate = 1;
                        } else if (absDrift > 0.05) {
                            const correction = Math.max(-0.08, Math.min(0.08, drift * 0.35));
                            video.playbackRate = 1 + correction;
                        } else if (video.playbackRate !== 1) {
                            video.playbackRate = 1;
                        }
                    }
                }
            });
        }
        // else: shouldReload BUT _sceneLoadPending — skip both branches
        // Old clip continues playing naturally until new clip is loaded

        // Sync audio to current time (with tolerance)
        if (audio?.src && !audio.paused) {
            const audioDiff = Math.abs(audio.currentTime - state.currentTime);
            if (audioDiff > 0.2) {
                audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
            }
        }

        // Trigger SFX clips at transition points
        if (state.sfxClips.length > 0) {
            const ct = state.currentTime;
            state.sfxClips.forEach(sfx => {
                const sfxEnd = sfx.startTime + sfx.duration;
                if (ct >= sfx.startTime && ct < sfxEnd && !sfx._triggered) {
                    sfx._triggered = true;
                    playSfxClip(sfx);
                }
                if (ct < sfx.startTime || ct >= sfxEnd) {
                    sfx._triggered = false;
                }
            });
        }

        // Preload upcoming scenes' media URLs (fire-and-forget)
        preloadUpcomingScenes(state.currentTime);

        // Update UI (all optimized: cached DOM lookups, skipped when unchanged)
        updatePlayhead();
        updateTimeDisplay();
        updateSceneHighlight(activeMediaScenes.length > 0 ? activeMediaScenes[0].index : -1);
        updateMGOverlay();

        // Continue loop
        _schedulePlaybackTick(loop);
    };

    _schedulePlaybackTick(loop);
}

// Cache of resolved SFX file URLs to avoid IPC latency on every play
const _sfxUrlCache = {};

async function preloadSfxUrls() {
    // Preload only the exact files selected by the build Sound Designer.
    const allFiles = new Set();
    for (const c of (state.sfxClips || [])) if (c && c.file) allFiles.add(c.file);
    for (const file of allFiles) {
        if (!_sfxUrlCache[file]) {
            try {
                const url = await window.electronAPI.getSfxPath(file);
                if (url) _sfxUrlCache[file] = url;
            } catch (_) { }
        }
    }
}

function playSfxClip(sfx) {
    if (state.isMuted) return;
    const poolEntry = state._sfxAudioPool.find(p => !p.playing) || state._sfxAudioPool[0];
    if (!poolEntry) return;
    const audio = poolEntry.element;

    // Use cached URL for instant playback (no IPC delay)
    const url = _sfxUrlCache[sfx.file];
    if (!url) {
        // Fallback: resolve via IPC (will be slow)
        window.electronAPI.getSfxPath(sfx.file).then(resolvedUrl => {
            if (!resolvedUrl) return;
            _sfxUrlCache[sfx.file] = resolvedUrl;
            audio.src = resolvedUrl;
            audio.volume = Math.min(1, sfx.volume * state.volume * PREVIEW_SFX_GAIN);
            audio.currentTime = 0;
            poolEntry.playing = true;
            audio.play().catch(() => { });
            audio.onended = () => { poolEntry.playing = false; };
            setTimeout(() => { poolEntry.playing = false; }, (sfx.duration + 0.5) * 1000);
        }).catch(() => { });
        return;
    }

    poolEntry.playing = true;
    // If src already matches, just seek to start (avoids reload latency)
    if (audio.src === url) {
        audio.currentTime = 0;
    } else {
        audio.src = url;
    }
    audio.volume = Math.min(1, sfx.volume * state.volume * PREVIEW_SFX_GAIN);
    audio.play().catch(() => { });
    audio.onended = () => { poolEntry.playing = false; };
    setTimeout(() => { poolEntry.playing = false; }, (sfx.duration + 0.5) * 1000);
}

function stopAllSfx() {
    state.sfxClips.forEach(sfx => { sfx._triggered = false; });
    state._sfxAudioPool.forEach(p => {
        p.element.pause();
        p.element.currentTime = 0;
        p.playing = false;
    });
}

/**
 * Update the Motion Graphics overlay in the preview.
 * Shows/hides MG elements based on current playback time.
 */
let _mgMeasureCanvas = null;

function getMGMeasureContext() {
    if (!_mgMeasureCanvas) {
        _mgMeasureCanvas = document.createElement('canvas');
    }
    return _mgMeasureCanvas.getContext('2d');
}

function getKineticTextPreviewLayout(text, fontFamily, options) {
    const words = String(text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(word => word.toUpperCase());
    if (words.length === 0) return null;

    const { hasSubtext = false, variant = 'centered', weight = 700 } = options || {};
    const ctx = getMGMeasureContext();
    const maxWidth = 1920 * 0.9;
    const maxHeight = hasSubtext ? 1080 * 0.58 : 1080 * 0.68;
    const maxRows = words.length <= 3 ? 2 : words.length <= 8 ? 3 : 4;
    const maxFontSize = variant === 'punch'
        ? 192
        : words.length <= 3
            ? 176
            : words.length <= 6
                ? 156
                : 136;
    const minFontSize = 60;
    const previewPxPerCqw = 14.4;

    let best = null;
    for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 4) {
        ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
        const gap = Math.round(Math.max(20, Math.min(40, fontSize * 0.18)));
        const rowHeight = Math.round(fontSize * 1.08);
        const attrFontSize = Math.round(Math.max(28, Math.min(56, fontSize * 0.34)));
        const attrMargin = hasSubtext ? Math.round(Math.max(18, fontSize * 0.5)) : 0;

        const rows = [];
        let currentRow = [];
        let currentWidth = 0;
        for (let i = 0; i < words.length; i++) {
            const width = ctx.measureText(words[i]).width;
            const nextWidth = currentRow.length > 0 ? currentWidth + gap + width : width;
            if (nextWidth > maxWidth && currentRow.length > 0) {
                rows.push({ words: currentRow, width: currentWidth });
                currentRow = [];
                currentWidth = 0;
            }

            currentRow.push({ word: words[i], width, index: i });
            currentWidth = currentRow.length > 1 ? currentWidth + gap + width : width;
        }

        if (currentRow.length > 0) {
            rows.push({ words: currentRow, width: currentWidth });
        }

        const textHeight = rows.length * rowHeight;
        const totalHeight = textHeight + (hasSubtext ? attrMargin + attrFontSize * 1.2 : 0);
        const widestRow = rows.reduce((max, row) => Math.max(max, row.width), 0);

        best = {
            words,
            rows,
            fontSizePx: fontSize,
            fontSizeCqw: fontSize / previewPxPerCqw,
            gapPx: gap,
            gapCqw: gap / previewPxPerCqw,
            attrFontSizePx: attrFontSize,
            attrFontSizeCqw: attrFontSize / previewPxPerCqw,
            attrMarginPx: attrMargin,
            attrMarginCqw: attrMargin / previewPxPerCqw,
            lineHeight: 1.02,
            maxWidthPct: 92,
        };

        if (rows.length <= maxRows && widestRow <= maxWidth && totalHeight <= maxHeight) {
            return best;
        }
    }

    return best;
}

function buildKineticTextPreviewHtml(mg, scene, styleVars, fontFamily, opacity, elapsed, enterDur, posClass, extraClasses) {
    const weightByStyle = { clean: 800, bold: 900, minimal: 500, neon: 900, cinematic: 700, elegant: 600 };
    const layout = getKineticTextPreviewLayout(mg.text || scene.text, fontFamily, {
        hasSubtext: !!(mg.subtext && mg.subtext !== 'none'),
        variant: mg.subType || 'centered',
        weight: weightByStyle[mg.style || scene.style || 'clean'] || 700,
    });

    if (!layout) {
        return `<div class="mg-preview-element mg-pos-center ${extraClasses || ''}" style="${styleVars};opacity:${opacity}"></div>`;
    }

    const kineticStyleVars = `${styleVars};--mg-kinetic-font-size:${layout.fontSizeCqw.toFixed(3)}cqw;--mg-kinetic-gap:${layout.gapCqw.toFixed(3)}cqw;--mg-kinetic-attr-size:${layout.attrFontSizeCqw.toFixed(3)}cqw;--mg-kinetic-attr-margin:${layout.attrMarginCqw.toFixed(3)}cqw;--mg-kinetic-line-height:${layout.lineHeight};--mg-kinetic-max-width:${layout.maxWidthPct}%`;
    const wordsHTML = layout.words.map((word, i) => {
        const wOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.1 - i * 0.12) / 0.15));
        const wScale = 1 + (1 - wOp) * 0.5;
        return `<span class="mg-kinetic-word" style="opacity:${wOp};transform:scale(${wScale})">${escapeHTML(word)}</span>`;
    }).join('');
    const allWordsEnd = enterDur * 0.1 + layout.words.length * 0.12 + 0.3;
    const attrOp = elapsed > allWordsEnd ? Math.min(1, (elapsed - allWordsEnd) / 0.3) : 0;
    const subHtml = mg.subtext && mg.subtext !== 'none'
        ? `<div class="mg-kinetic-attr" style="opacity:${attrOp}">\u2014 ${escapeHTML(mg.subtext)}</div>` : '';

    return `<div class="mg-preview-element mg-kinetic ${posClass} ${extraClasses || ''}" style="${kineticStyleVars};opacity:${opacity}">
        <div class="mg-kinetic-scrim" style="opacity:${Math.min(0.3, elapsed * 2)}"></div>
        <div class="mg-shell-copy">
            <div class="mg-kinetic-words">${wordsHTML}</div>
            ${subHtml}
        </div>
    </div>`;
}

// Full-screen MG preview for V3 scenes (opaque background + centered content)
function renderFullscreenMGPreview(scene) {
    const mg = scene.mgData || scene;
    const mgStyleName = mg.style || scene.style || state.mgStyle || 'clean';
    const styledColors = getStyledThemeColors(mgStyleName);
    const baseS = MG_STYLES[mgStyleName] || MG_STYLES.clean;
    // Manual style pick → MG_STYLES palette wins; auto-placed → theme wins.
    const manualStyle = mg.styleManual || scene.styleManual;
    const s = styledColors
        ? (manualStyle ? { ...styledColors, ...baseS } : { ...baseS, ...styledColors })
        : baseS;
    const tf = getActiveThemeFonts();
    // Replace double quotes with single quotes in font names to avoid breaking style="" attribute
    const fontH = tf.heading.replace(/"/g, "'");
    const fontB = tf.body.replace(/"/g, "'");
    const styleVars = `--mg-primary:${s.primary};--mg-accent:${s.accent};--mg-bg:${s.bg};--mg-text:${s.text};--mg-text-sub:${s.textSub};--mg-font-heading:${fontH};--mg-font-body:${fontB}`;

    const elapsed = Math.max(0, state.currentTime - (mg.startTime || scene.startTime));
    const duration = mg.duration || (scene.endTime - scene.startTime);
    const enterDur = Math.min(0.5, duration * 0.35);
    const exitDur = Math.min(0.3, duration * 0.2);
    const isExiting = elapsed > duration - exitDur;
    const opacity = isExiting ? Math.max(0, (duration - elapsed) / exitDur) : Math.min(1, elapsed / enterDur);
    const enterDone = elapsed >= enterDur;
    const type = mg.type || scene.type;

    // Background gradients per style
    const bgGradients = {
        clean: 'radial-gradient(ellipse at center, #0a0a2e, #000000)',
        bold: 'radial-gradient(ellipse at center, #1a0000, #0a0a0a)',
        minimal: 'radial-gradient(ellipse at center, #1a1a2e, #0f0f0f)',
        neon: 'radial-gradient(ellipse at center, #000020, #000008)',
        cinematic: 'radial-gradient(ellipse at center, #1a1500, #000000)',
        elegant: 'radial-gradient(ellipse at center, #0a0020, #050010)',
    };
    const bgGrad = bgGradients[mg.style || scene.style] || bgGradients.clean;

    let innerHtml = '';
    switch (type) {
        case 'barChart': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
            const barsHTML = items.slice(0, 6).map((item, i) => {
                const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.15) / 0.5));
                const barEased = 1 - Math.pow(1 - barProg, 3);
                const heightPct = ((parseFloat(item.value) || 0) / maxVal) * 100 * barEased;
                return `<div class="mg-bar-col">
                    <div class="mg-bar-value" style="opacity:${Math.min(1, Math.max(0, barProg - 0.3))}">${escapeHTML(item.value)}</div>
                    <div class="mg-bar" style="height:${heightPct}%"></div>
                    <div class="mg-bar-label">${escapeHTML(item.label)}</div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-bar-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-bars-container">${barsHTML}</div>
            </div>`;
            break;
        }
        case 'donutChart': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
            const legendHTML = items.slice(0, 5).map((item, i) => {
                const itemOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5 - i * 0.12) / 0.2));
                return `<div class="mg-donut-legend-item" style="opacity:${itemOp}">
                    <span class="mg-donut-dot" style="background:${i === 0 ? 'var(--mg-primary)' : 'var(--mg-accent)'}"></span>
                    ${escapeHTML(item.label)} ${escapeHTML(item.value)}%
                </div>`;
            }).join('');
            let gradientStops = [], cumPct = 0;
            const colors = ['var(--mg-primary)', 'var(--mg-accent)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.15)'];
            items.slice(0, 5).forEach((item, i) => {
                const pct = (parseFloat(item.value) || 0) / total * 100;
                const drawProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.5));
                const drawnPct = pct * (1 - Math.pow(1 - drawProg, 3));
                gradientStops.push(`${colors[i % colors.length]} ${cumPct}% ${cumPct + drawnPct}%`);
                cumPct += drawnPct;
            });
            gradientStops.push(`transparent ${cumPct}% 100%`);
            innerHtml = `<div class="mg-preview-element mg-donut-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-donut-row">
                    <div class="mg-donut-ring" style="background:conic-gradient(from 0deg, ${gradientStops.join(', ')})"><div class="mg-donut-hole"></div></div>
                    <div class="mg-donut-legend">${legendHTML}</div>
                </div>
            </div>`;
            break;
        }
        case 'comparisonCard': {
            const parts = (mg.text || scene.text).split(/\s+vs\.?\s+/i);
            const slideAmt = enterDone ? 0 : (1 - elapsed / enterDur) * 30;
            const vsProg = Math.min(1, Math.max(0, (elapsed - 0.3) / 0.3));
            innerHtml = `<div class="mg-preview-element mg-comparison mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-comp-panel mg-comp-left" style="transform:translateX(${-slideAmt}px)">${escapeHTML(parts[0] || 'A')}</div>
                <div class="mg-comp-vs" style="transform:scale(${vsProg})">VS</div>
                <div class="mg-comp-panel mg-comp-right" style="transform:translateX(${slideAmt}px)">${escapeHTML(parts[1] || 'B')}</div>
            </div>`;
            break;
        }
        case 'timeline': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const lineW = enterDone ? 100 : Math.min(100, elapsed / enterDur * 100);
            const markersHTML = items.slice(0, 5).map((item, i) => {
                const pct = items.length > 1 ? (i / (items.length - 1)) * 100 : 50;
                const mOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.25) / 0.25));
                return `<div class="mg-tl-marker" style="left:${pct}%;opacity:${mOp}">
                    <div class="mg-tl-year">${escapeHTML(item.label)}</div>
                    <div class="mg-tl-dot"></div>
                    <div class="mg-tl-event">${escapeHTML(item.value)}</div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-timeline mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-tl-container">
                    <div class="mg-tl-line" style="width:${lineW}%"></div>
                    ${markersHTML}
                </div>
            </div>`;
            break;
        }
        case 'rankingList': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
            const rowsHTML = items.slice(0, 6).map((item, i) => {
                const rowOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.18) / 0.25));
                const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.35 - i * 0.18) / 0.5));
                const barW = (1 - Math.pow(1 - barProg, 3)) * ((parseFloat(item.value) || 0) / maxVal) * 100;
                return `<div class="mg-rank-row" style="opacity:${rowOp}">
                    <span class="mg-rank-num ${i === 0 ? 'mg-rank-top' : ''}">${i + 1}</span>
                    <div class="mg-rank-content">
                        <div class="mg-rank-header"><span>${escapeHTML(item.label)}</span><span class="mg-rank-val">${escapeHTML(item.value)}</span></div>
                        <div class="mg-rank-track"><div class="mg-rank-bar ${i === 0 ? 'mg-rank-bar-top' : ''}" style="width:${barW}%"></div></div>
                    </div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-ranking mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                ${rowsHTML}
            </div>`;
            break;
        }
        case 'bulletList': {
            const bulletItems = (mg.text || scene.text).split(/[,;]|\d+\.\s/).filter(s => s.trim());
            const bulletsHTML = bulletItems.map((item, i) => {
                const bOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.3));
                return `<div class="mg-bullet-item" style="opacity:${bOp}"><span class="mg-bullet-marker">▸</span>${escapeHTML(item.trim())}</div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-bullets-list mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                ${bulletsHTML}
            </div>`;
            break;
        }
        case 'kineticText': {
            innerHtml = buildKineticTextPreviewHtml(
                mg,
                scene,
                styleVars,
                fontH,
                opacity,
                elapsed,
                enterDur,
                'mg-pos-center',
                'mg-fullscreen'
            );
            break;
        }
        case 'mapChart': {
            // Map visual style presets (matches MotionGraphics.jsx MAP_VISUAL_STYLES)
            const MAP_PREVIEW_STYLES = {
                dark: { ocean: '#0a1628', land: '#1a2744', border: 'rgba(30,58,95,0.4)', marker: null, label: null, labelBg: null, grid: true },
                natural: { ocean: '#1a4a6e', land: '#3a6b4a', border: 'rgba(42,80,56,0.4)', marker: '#ffffff', label: '#ffffff', labelBg: 'rgba(15,30,20,0.88)', grid: false },
                satellite: { ocean: '#050d1a', land: '#141e14', border: 'rgba(26,48,32,0.3)', marker: '#00ffcc', label: '#ffffff', labelBg: 'rgba(5,10,15,0.9)', grid: false },
                light: { ocean: '#d4e6f1', land: '#ecf0f1', border: 'rgba(189,195,199,0.6)', marker: '#e74c3c', label: '#2c3e50', labelBg: 'rgba(255,255,255,0.92)', grid: true },
                political: { ocean: '#b8d4e8', land: '#f0e6d3', border: 'rgba(138,122,106,0.5)', marker: '#c0392b', label: '#2c1810', labelBg: 'rgba(240,230,211,0.92)', grid: true },
            };
            const mps = MAP_PREVIEW_STYLES[mg.mapStyle || 'dark'] || MAP_PREVIEW_STYLES.dark;

            // Country coordinate lookup for geographic positioning
            const MAP_COORDS = {
                'China': [104, 35], 'United States': [-98, 39], 'USA': [-98, 39],
                'India': [78, 22], 'Japan': [138, 36], 'Germany': [10.5, 51.2],
                'United Kingdom': [-2, 54], 'UK': [-2, 54], 'France': [2.2, 46.2],
                'Brazil': [-51, -10], 'Italy': [12.5, 42.5], 'Canada': [-106, 56],
                'Russia': [100, 60], 'South Korea': [128, 36], 'Australia': [134, -25],
                'Spain': [-3.7, 40.4], 'Mexico': [-102, 23], 'Indonesia': [118, -2],
                'Norway': [9, 62], 'Turkey': [35, 39], 'Saudi Arabia': [45, 24],
                'South Africa': [25, -29], 'Argentina': [-64, -34], 'Nigeria': [8, 10],
                'Egypt': [30, 27], 'Thailand': [101, 15], 'Vietnam': [108, 16],
                'Iran': [53, 32], 'Colombia': [-74, 4], 'Chile': [-71, -35],
                'Pakistan': [70, 30], 'Philippines': [122, 13], 'Malaysia': [110, 4],
                'Ukraine': [32, 49], 'Kenya': [38, 0], 'Morocco': [-5, 32],
                'Myanmar': [96, 20], 'Taiwan': [121, 24], 'Afghanistan': [67, 33],
            };
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            // Equirectangular projection: lng/lat → x%/y%
            const pinPositions = items.slice(0, 8).map((item, i) => {
                const coords = MAP_COORDS[item.label];
                let x, y;
                if (coords) {
                    x = ((coords[0] + 180) / 360) * 85 + 7;
                    y = ((90 - coords[1]) / 180) * 80 + 5;
                } else {
                    const hash = (item.label || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                    x = 12 + ((hash * 7 + i * 137) % 76);
                    y = 15 + ((hash * 13 + i * 89) % 60);
                }
                return { ...item, x, y, i };
            });
            const pinColor = mps.marker || 'var(--mg-accent)';
            const pinLabelColor = mps.label || 'var(--mg-text)';
            const pinLabelBg = mps.labelBg || 'var(--mg-bg)';
            const pinsHTML = pinPositions.map((pin) => {
                const pinOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - pin.i * 0.2) / 0.3));
                const bounce = pinOp < 1 ? (1 - pinOp) * 10 : 0;
                return `<div class="mg-map-pin" style="left:${pin.x}%;top:${pin.y}%;opacity:${pinOp};transform:translateY(${-bounce}px)">
                    <div class="mg-map-pin-dot" style="background:${pinColor};box-shadow:0 0 8px ${pinColor}"></div>
                    <div class="mg-map-pin-label" style="color:${pinLabelColor};background:${pinLabelBg}">${escapeHTML(pin.label)}</div>
                    ${pin.value && pin.value !== '0' ? `<div class="mg-map-pin-value" style="color:${pinColor}">${escapeHTML(pin.value)}</div>` : ''}
                </div>`;
            }).join('');
            const gridHTML = mps.grid ? `<div class="mg-map-grid" style="background:linear-gradient(90deg, ${mps.border} 1px, transparent 1px), linear-gradient(0deg, ${mps.border} 1px, transparent 1px);background-size:20% 25%"></div>` : '';
            // Map-specific background (ocean + land representation)
            const mapBg = `radial-gradient(ellipse at center, ${mps.ocean}, ${mps.ocean})`;
            const containerBg = `radial-gradient(ellipse 60% 50% at center, ${mps.land}60, transparent)`;
            innerHtml = `<div class="mg-preview-element mg-map-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title" style="color:${pinLabelColor}">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-map-container" style="background:${containerBg};border-color:${mps.border}">
                    ${gridHTML}
                    ${pinsHTML}
                </div>
            </div>`;
            // Override bgGrad for map to use ocean color
            innerHtml = `<div class="mg-fullscreen-bg" style="${styleVars};background:${mapBg}">${innerHtml}</div>`;
            // Return early since we handle the wrapper ourselves
            return innerHtml;
        }
        case 'articleHighlight': {
            // IMAGE MODE: real article screenshot with highlight boxes
            const articleImgUrl = mg._articleImageUrl || scene._articleImageUrl;
            const hlBoxes = mg.highlightBoxes || scene.highlightBoxes || [];
            if (articleImgUrl) {
                const blurAmt = Math.max(0, 12 - elapsed * 12);
                const cardScale = 1 + elapsed * 0.01;
                const rotY = elapsed / (mg.duration || 7) * 6;
                // Build yellow highlighter marker overlays (staggered sweep per phrase)
                let boxesHtml = '';
                for (let bi = 0; bi < hlBoxes.length; bi++) {
                    const b = hlBoxes[bi];
                    const yOff = (bi % 2 === 0) ? 0.3 : -0.2;
                    const rot = (bi % 2 === 0) ? -0.3 : 0.4;
                    const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - bi * 0.3) / 0.5));
                    const sweepEased = 1 - Math.pow(1 - sweepProg, 2.5);
                    if (sweepEased > 0) {
                        boxesHtml += `<div style="position:absolute;left:${(b.x - 1).toFixed(1)}%;top:${(b.y + yOff).toFixed(1)}%;width:${(b.w + 2).toFixed(1)}%;height:${Math.max(b.h, 3.8).toFixed(1)}%;background:rgba(255,230,0,0.38);border-radius:3px;transform:rotate(${rot}deg);mix-blend-mode:multiply;clip-path:inset(0 ${((1 - sweepEased) * 100).toFixed(1)}% 0 0);pointer-events:none"></div>`;
                    }
                }
                innerHtml = `<div class="mg-preview-element mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity};filter:blur(${blurAmt > 0.1 ? blurAmt : 0}px);transform:scale(${cardScale.toFixed(3)}) perspective(1200px) rotateY(${rotY.toFixed(2)}deg)">
                    <div style="position:relative;border-radius:12px;overflow:hidden;box-shadow:0 20px 80px rgba(0,0,0,0.35)">
                        <img src="${articleImgUrl}" style="display:block;width:100%;height:auto;max-height:100%" />
                        ${boxesHtml}
                        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.35) 100%);pointer-events:none"></div>
                    </div>
                </div>`;
                break;
            }
            // HTML CARD MODE (fallback): generated article card
            const rawSub = mg.subtext || scene.subtext || '';
            const pipeParts = rawSub.split('|');
            let artSource = '', artAuthor = '', artDate = '', rawExcerpt = '';
            if (pipeParts.length >= 4) {
                artSource = (pipeParts[0] || '').trim();
                artAuthor = (pipeParts[1] || '').trim();
                artDate = (pipeParts[2] || '').trim();
                rawExcerpt = pipeParts.slice(3).join('|').trim();
            } else if (pipeParts.length === 3) {
                artSource = (pipeParts[0] || '').trim();
                if (/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(pipeParts[1])) {
                    artDate = (pipeParts[1] || '').trim();
                } else {
                    artAuthor = (pipeParts[1] || '').trim();
                }
                rawExcerpt = (pipeParts[2] || '').trim();
            } else if (pipeParts.length === 2) {
                artSource = (pipeParts[0] || '').trim();
                rawExcerpt = (pipeParts[1] || '').trim();
            } else {
                // No pipes — entire subtext is excerpt
                rawExcerpt = rawSub.trim();
            }
            // Extract highlighted phrases and build excerpt HTML
            const highlightPhrases = [];
            rawExcerpt.replace(/\*\*([^*]+)\*\*/g, (_, p) => highlightPhrases.push(p));
            // Auto-highlight if no ** markers: highlight numbers and key terms
            if (highlightPhrases.length === 0 && rawExcerpt.length > 0) {
                const numMatches = [];
                rawExcerpt.replace(/\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?/gi, (m) => { numMatches.push(m.trim()); });
                if (numMatches.length > 0) {
                    numMatches.slice(0, 3).forEach(m => highlightPhrases.push(m));
                } else {
                    const common = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'was', 'one', 'our', 'has', 'with', 'that', 'this', 'from', 'they', 'been', 'have', 'many', 'some', 'them', 'than', 'its', 'over', 'also', 'each', 'which', 'their', 'will', 'there', 'then', 'about', 'would', 'these', 'could', 'after', 'where']);
                    const words = rawExcerpt.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 4 && !common.has(w.toLowerCase().replace(/[^a-z]/g, '')));
                    words.sort((a, b) => b.length - a.length);
                    words.slice(0, 2).forEach(w => highlightPhrases.push(w));
                }
            }
            let excerptHTML = escapeHTML(rawExcerpt.replace(/\*\*([^*]+)\*\*/g, '$1'));
            for (let hi = 0; hi < highlightPhrases.length; hi++) {
                const phrase = escapeHTML(highlightPhrases[hi]);
                const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - hi * 0.4) / 0.5));
                const sweepEased = 1 - Math.pow(1 - sweepProg, 2);
                const sweepW = Math.round(sweepEased * 100);
                excerptHTML = excerptHTML.replace(phrase,
                    `<span class="mg-article-hl-wrap"><span class="mg-article-hl-bg" style="width:${sweepW}%"></span><strong>${phrase}</strong></span>`
                );
            }
            const blurAmt = Math.max(0, 12 - elapsed * 12);
            const cardScale = 1 + elapsed * 0.01;
            const byline = (artAuthor ? `By ${escapeHTML(artAuthor)}` : '') + (artAuthor && artDate ? '  \u00B7  ' : '') + escapeHTML(artDate);
            innerHtml = `<div class="mg-preview-element mg-article-card mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity};filter:blur(${blurAmt > 0.1 ? blurAmt : 0}px);transform:scale(${cardScale.toFixed(3)})">
                ${artSource ? `<div class="mg-article-source">${escapeHTML(artSource)}</div>` : ''}
                <div class="mg-article-headline">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-article-sep" style="width:${Math.min(100, enterDone ? 100 : elapsed / enterDur * 100)}%"></div>
                ${byline ? `<div class="mg-article-byline">${byline}</div>` : ''}
                ${rawExcerpt ? `<div class="mg-article-excerpt">\u201C${excerptHTML}\u201D</div>` : ''}
            </div>`;
            break;
        }
        default:
            innerHtml = `<div class="mg-preview-element mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text || type)}</div>
            </div>`;
    }

    return `<div class="mg-fullscreen-bg" style="${styleVars};background:${bgGrad}">${innerHtml}</div>`;
}

// Throttled MG overlay — only rebuilds innerHTML when active MG set changes,
// uses lightweight style updates for per-frame animation (opacity, counters)
let _mgLastActiveIds = '';
let _mgLastUpdateTime = 0;
let _mgLastHtml = '';
const _MG_ANIMATION_INTERVAL = 120; // ms between MG redraws (lower CPU -> smoother video preview)

function updateMGOverlay() {
    const overlay = elements.mgOverlay;
    if (!overlay) return;

    if (!state.mgEnabled || !state.motionGraphics || state.motionGraphics.length === 0) {
        if (overlay.children.length > 0) overlay.innerHTML = '';
        _mgLastActiveIds = '';
        _mgLastHtml = '';
        return;
    }

    const ct = state.currentTime;
    const activeMGs = state.motionGraphics.filter(mg =>
        !mg.disabled && ct >= mg.startTime && ct < mg.startTime + mg.duration
    );

    if (activeMGs.length === 0) {
        if (overlay.children.length > 0) overlay.innerHTML = '';
        _mgLastActiveIds = '';
        _mgLastHtml = '';
        return;
    }

    // Check if active MG set changed (new MG appeared/disappeared)
    const currentIds = activeMGs.map(mg => `${mg.type}:${mg.startTime}`).join('|');
    const setChanged = currentIds !== _mgLastActiveIds;
    _mgLastActiveIds = currentIds;

    // Throttle animation updates to ~20fps (full rebuilds always run)
    const now = performance.now();
    if (!setChanged && now - _mgLastUpdateTime < _MG_ANIMATION_INTERVAL) return;
    _mgLastUpdateTime = now;

    // Build HTML for active MG elements
    const tf = getActiveThemeFonts();
    // Replace double quotes with single quotes in font names to avoid breaking style="" attribute
    const fontH = tf.heading.replace(/"/g, "'");
    const fontB = tf.body.replace(/"/g, "'");

    const html = activeMGs.map(mg => {
        // Per-MG style variables (with style-modified theme colors)
        const mgStyleName = mg.style || state.mgStyle || 'clean';
        const styledColors = getStyledThemeColors(mgStyleName);
        const baseS = MG_STYLES[mgStyleName] || MG_STYLES.clean;
        // Manual style pick → MG_STYLES palette wins so the change is visible.
        // Auto-placed MGs → theme colors win (matches AI intent + theme identity).
        const s = styledColors
            ? (mg.styleManual ? { ...styledColors, ...baseS } : { ...baseS, ...styledColors })
            : baseS;
        const styleVars = `--mg-primary:${s.primary};--mg-accent:${s.accent};--mg-bg:${s.bg};--mg-text:${s.text};--mg-text-sub:${s.textSub};--mg-font-heading:${fontH};--mg-font-body:${fontB}`;

        const elapsed = ct - mg.startTime;
        const enterDur = Math.min(0.5, mg.duration * 0.35);
        const exitDur = Math.min(0.3, mg.duration * 0.2);
        const isExiting = elapsed > mg.duration - exitDur;
        const opacity = isExiting
            ? Math.max(0, (mg.duration - elapsed) / exitDur)
            : Math.min(1, elapsed / enterDur);
        const enterDone = elapsed > enterDur;

        const shellContext = {
            id: mg.id || mg.clipId || `${mg.type}:${mg.startTime}`,
            role: 'overlay',
            type: mg.type,
            text: mg.text,
            subtext: mg.subtext,
            items: mg.items || mg.mgData?.items || mg.agenticComposition?.items || [],
            density: mg.agenticComposition?.density,
            textStrategy: mg.agenticComposition?.textStrategy,
            safeZone: mg.safeZone || mg.position,
            layout: mg.agenticComposition?.layout,
            mood: `${mg.style || ''} ${mg.agenticComposition?.style?.mood || ''}`,
            manual: mg.graphicShellManual === true,
            transparentBackground: mg.transparentBackground === true
                || mg.cardStyle === 'transparent',
            accentRuleVisible: mg.accentRuleVisible !== false,
        };
        const shellClasses = window._graphicShells?.graphicShellClassNames
            ? window._graphicShells.graphicShellClassNames(
                mg.graphicShell || mg.agenticComposition?.shell,
                shellContext,
                'mg'
            )
            : '';
        const componentOwnsLayout = new Set([
            'barChart',
            'donutChart',
            'rankingList',
            'timeline',
            'comparisonCard',
            'bulletList',
            'mapChart',
            'listicleGrid',
        ]).has(mg.type);
        const posClass = `mg-pos-${mg.position || 'center'} ${componentOwnsLayout ? 'mg-component-layout-owned ' : ''}${shellClasses}`;

        switch (mg.type) {
            case 'headline':
                return `<div class="mg-preview-element mg-headline ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-shell-copy">
                        <div class="mg-headline-text">${escapeHTML(mg.text)}</div>
                        <div class="mg-headline-bar" style="width:${enterDone ? 100 : Math.min(100, elapsed / enterDur * 100)}%"></div>
                        ${mg.subtext && mg.subtext !== 'none' ? `<div class="mg-headline-sub">${escapeHTML(mg.subtext)}</div>` : ''}
                    </div>
                </div>`;

            case 'lowerThird':
                return `<div class="mg-preview-element mg-lower-third ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-lt-accent"></div>
                    <div class="mg-lt-content mg-shell-copy">
                        <div class="mg-lt-text">${escapeHTML(mg.text)}</div>
                        ${mg.subtext && mg.subtext !== 'none' ? `<div class="mg-lt-sub">${escapeHTML(mg.subtext)}</div>` : ''}
                    </div>
                </div>`;

            case 'statCounter': {
                const numMatch = mg.text.match(/[\d,.]+/);
                const target = numMatch ? parseFloat(numMatch[0].replace(/,/g, '')) : 0;
                const countProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.4) / 1.0));
                const eased = 1 - Math.pow(1 - countProg, 3);
                const current = target % 1 !== 0
                    ? (target * eased).toFixed(1)
                    : Math.round(target * eased).toLocaleString();
                const prefix = mg.text.substring(0, mg.text.indexOf(numMatch?.[0] || '')).trim();
                const suffix = mg.text.substring(mg.text.indexOf(numMatch?.[0] || '') + (numMatch?.[0]?.length || 0)).trim();
                return `<div class="mg-preview-element mg-stat ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-shell-copy">
                        <div class="mg-stat-number">${escapeHTML(prefix)}${current}</div>
                        <div class="mg-stat-label">${escapeHTML(suffix || mg.subtext || '')}</div>
                    </div>
                </div>`;
            }

            case 'callout':
                return `<div class="mg-preview-element mg-callout ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-callout-box mg-shell-copy">
                        <span class="mg-callout-quote">\u201C</span>
                        <p class="mg-callout-text">${escapeHTML(mg.text)}</p>
                        ${mg.subtext && mg.subtext !== 'none' ? `<p class="mg-callout-attr">\u2014 ${escapeHTML(mg.subtext)}</p>` : ''}
                    </div>
                </div>`;

            case 'bulletList': {
                const items = mg.text.split(/[,;]|\d+\.\s/).map(s => s.trim()).filter(Boolean);
                const staggerDelay = 0.25;
                const bulletsHTML = items.map((item, i) => {
                    const itemOpacity = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * staggerDelay) / 0.3));
                    return `<div class="mg-bullet-item" style="opacity:${itemOpacity}">
                        <span class="mg-bullet-dot"></span>
                        <span>${escapeHTML(item)}</span>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-bullets ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-shell-copy">${bulletsHTML}</div>
                </div>`;
            }

            case 'focusWord': {
                const subHtml = mg.subtext && mg.subtext !== 'none'
                    ? `<div class="mg-focus-sub" style="opacity:${Math.min(1, Math.max(0, (elapsed - enterDur * 0.5) / 0.3))}">${escapeHTML(mg.subtext)}</div>` : '';
                return `<div class="mg-preview-element mg-focus-word ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-focus-scrim" style="opacity:${Math.min(1, elapsed / 0.15)}"></div>
                    <div class="mg-shell-copy">
                        <div class="mg-focus-text">${escapeHTML(mg.text)}</div>
                        ${subHtml}
                    </div>
                </div>`;
            }

            case 'progressBar': {
                const numMatch = mg.text.match(/[\d,.]+/);
                const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
                const label = mg.text.replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';
                const fillProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5) / 1.2));
                const fillEased = 1 - Math.pow(1 - fillProg, 3);
                const currentPct = Math.round(targetPct * fillEased);
                return `<div class="mg-preview-element mg-progress ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-shell-copy">
                        ${label ? `<div class="mg-progress-label">${escapeHTML(label)}</div>` : ''}
                        <div class="mg-progress-track"><div class="mg-progress-fill" style="width:${targetPct * fillEased}%"></div></div>
                        <div class="mg-progress-number">${currentPct}%</div>
                    </div>
                </div>`;
            }

            case 'barChart': {
                const items = parseKeyValuePairs(mg.subtext);
                const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
                const barsHTML = items.slice(0, 6).map((item, i) => {
                    const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.15) / 0.5));
                    const barEased = 1 - Math.pow(1 - barProg, 3);
                    const heightPct = ((parseFloat(item.value) || 0) / maxVal) * 100 * barEased;
                    return `<div class="mg-bar-col">
                        <div class="mg-bar-value" style="opacity:${Math.min(1, Math.max(0, barProg - 0.3))}">${escapeHTML(item.value)}</div>
                        <div class="mg-bar" style="height:${heightPct}%"></div>
                        <div class="mg-bar-label">${escapeHTML(item.label)}</div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-bar-chart ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title mg-shell-copy">${escapeHTML(mg.text)}</div>
                    <div class="mg-bars-container">${barsHTML}</div>
                </div>`;
            }

            case 'donutChart': {
                const items = parseKeyValuePairs(mg.subtext);
                const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
                const legendHTML = items.slice(0, 5).map((item, i) => {
                    const itemOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5 - i * 0.12) / 0.2));
                    return `<div class="mg-donut-legend-item" style="opacity:${itemOp}">
                        <span class="mg-donut-dot" style="background:${i === 0 ? 'var(--mg-primary)' : 'var(--mg-accent)'}"></span>
                        ${escapeHTML(item.label)} ${escapeHTML(item.value)}%
                    </div>`;
                }).join('');
                let gradientStops = [];
                let cumPct = 0;
                const colors = ['var(--mg-primary)', 'var(--mg-accent)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.15)'];
                items.slice(0, 5).forEach((item, i) => {
                    const pct = (parseFloat(item.value) || 0) / total * 100;
                    const drawProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.5));
                    const drawnPct = pct * (1 - Math.pow(1 - drawProg, 3));
                    gradientStops.push(`${colors[i % colors.length]} ${cumPct}% ${cumPct + drawnPct}%`);
                    cumPct += drawnPct;
                });
                gradientStops.push(`transparent ${cumPct}% 100%`);
                const conicGrad = `conic-gradient(from 0deg, ${gradientStops.join(', ')})`;
                return `<div class="mg-preview-element mg-donut-chart ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title mg-shell-copy">${escapeHTML(mg.text)}</div>
                    <div class="mg-donut-row">
                        <div class="mg-donut-ring" style="background:${conicGrad}"><div class="mg-donut-hole"></div></div>
                        <div class="mg-donut-legend">${legendHTML}</div>
                    </div>
                </div>`;
            }

            case 'comparisonCard': {
                const parts = mg.text.split(/\s+vs\.?\s+/i);
                const itemA = parts[0] || 'A';
                const itemB = parts[1] || 'B';
                const slideAmt = enterDone ? 0 : (1 - elapsed / enterDur) * 30;
                const vsProg = Math.min(1, Math.max(0, (elapsed - 0.3) / 0.3));
                return `<div class="mg-preview-element mg-comparison ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-shell-copy mg-shell-comparison">
                        <div class="mg-comp-panel mg-comp-left" style="transform:translateX(${-slideAmt}px)">${escapeHTML(itemA)}</div>
                        <div class="mg-comp-vs" style="transform:scale(${vsProg})">VS</div>
                        <div class="mg-comp-panel mg-comp-right" style="transform:translateX(${slideAmt}px)">${escapeHTML(itemB)}</div>
                    </div>
                </div>`;
            }

            case 'timeline': {
                const items = parseKeyValuePairs(mg.subtext);
                const lineW = enterDone ? 100 : Math.min(100, elapsed / enterDur * 100);
                const markersHTML = items.slice(0, 5).map((item, i) => {
                    const pct = items.length > 1 ? (i / (items.length - 1)) * 100 : 50;
                    const mOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.25) / 0.25));
                    return `<div class="mg-tl-marker" style="left:${pct}%;opacity:${mOp}">
                        <div class="mg-tl-year">${escapeHTML(item.label)}</div>
                        <div class="mg-tl-dot"></div>
                        <div class="mg-tl-event">${escapeHTML(item.value)}</div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-timeline ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title mg-shell-copy">${escapeHTML(mg.text)}</div>
                    <div class="mg-tl-container">
                        <div class="mg-tl-line" style="width:${lineW}%"></div>
                        ${markersHTML}
                    </div>
                </div>`;
            }

            case 'rankingList': {
                const items = parseKeyValuePairs(mg.subtext);
                const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
                const rowsHTML = items.slice(0, 6).map((item, i) => {
                    const rowOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.18) / 0.25));
                    const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.35 - i * 0.18) / 0.5));
                    const barW = (1 - Math.pow(1 - barProg, 3)) * ((parseFloat(item.value) || 0) / maxVal) * 100;
                    return `<div class="mg-rank-row" style="opacity:${rowOp}">
                        <span class="mg-rank-num ${i === 0 ? 'mg-rank-top' : ''}">${i + 1}</span>
                        <div class="mg-rank-content">
                            <div class="mg-rank-header"><span>${escapeHTML(item.label)}</span><span class="mg-rank-val">${escapeHTML(item.value)}</span></div>
                            <div class="mg-rank-track"><div class="mg-rank-bar ${i === 0 ? 'mg-rank-bar-top' : ''}" style="width:${barW}%"></div></div>
                        </div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-ranking ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title mg-shell-copy">${escapeHTML(mg.text)}</div>
                    ${rowsHTML}
                </div>`;
            }

            case 'kineticText': {
                return buildKineticTextPreviewHtml(
                    mg,
                    mg,
                    styleVars,
                    fontH,
                    opacity,
                    elapsed,
                    enterDur,
                    posClass,
                    ''
                );
            }

            default:
                return '';
        }
    }).join('');

    if (html !== _mgLastHtml) {
        overlay.innerHTML = html;
        _mgLastHtml = html;
    }
}

function escapeHTML(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Hard-cut transition between clips (no animation).
 */
async function performTrackTransition(trackVideo, transOut, sceneIndex, newVideoUrl, scene) {
    if (!trackVideo) return;
    trackVideo.pause();
    trackVideo.src = newVideoUrl;
    trackVideo.load();
    const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
    trackVideo.currentTime = sceneTime;
    trackVideo.volume = getSceneVolume(scene);
    trackVideo.muted = false;
    trackVideo.classList.remove('outgoing');
    trackVideo.classList.add('active');
    applySceneTransformToVideo(trackVideo, scene);
    if (transOut) { transOut.pause(); transOut.src = ''; }
    state.transition.isTransitioning = false;
    if (state.isPlaying) trackVideo.play().catch(() => { });
}

/**
 * Hard-cut transition between images (no animation).
 */
async function performImageTransition(trackImg, transOutImg, scene, newImgUrl) {
    if (!trackImg) return;
    trackImg.src = newImgUrl;
    updateKenBurnsTransform(trackImg, scene);
    trackImg.classList.remove('outgoing');
    trackImg.classList.add('active');
    state.transition.isTransitioning = false;
}

// Helper to reset video element to clean state
function resetVideoTransitionState(videoElement) {
    if (!videoElement) return;
    videoElement.classList.remove('active', 'outgoing', 'incoming');
    videoElement.style.opacity = '';
    videoElement.style.transform = '';
    videoElement.style.filter = '';
    videoElement.style.clipPath = '';
    videoElement.style.visibility = '';
}

// Simple scene jump (no visual effects)
async function simpleTransitionToScene(nextIndex, wasPlaying) {
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video && !video.paused) video.pause();
    });

    const nextScene = state.scenes[nextIndex];
    state.currentTime = nextScene.startTime;
    updateSceneHighlight(nextIndex);
    await loadActiveScenes();

    if (wasPlaying && state.isPlaying) {
        const activeScenes = getActiveScenesAtTime(state.currentTime);
        activeScenes.forEach(({ scene }) => {
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src) video.play().catch(e => console.warn('Video play failed:', e));
        });
    }
}

// ========================================
// Resizable Panels
// ========================================
function setupResizablePanels() {
    setupPanelResize(elements.resizeLeft, 'left');
    setupPanelResize(elements.resizeRight, 'right');
    setupTimelineResize();
}

function setupPanelResize(handle, side) {
    if (!handle) return;
    let isDragging = false, startX = 0, startWidth = 0;
    handle.addEventListener('mousedown', (e) => {
        isDragging = true; startX = e.clientX;
        startWidth = (side === 'left' ? elements.leftPanel : elements.rightPanel).offsetWidth;
        document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const panel = side === 'left' ? elements.leftPanel : elements.rightPanel;
        const deltaX = e.clientX - startX;
        let newWidth = side === 'left' ? startWidth + deltaX : startWidth - deltaX;
        const minWidth = side === 'left' ? 280 : 200;
        const maxWidth = side === 'left' ? 520 : 420;
        panel.style.width = `${Math.max(minWidth, Math.min(maxWidth, newWidth))}px`;
    });
    document.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; } });
}

function setupTimelineResize() {
    const handle = elements.resizeTimeline;
    if (!handle) return;

    const TL_MIN = 180;
    const TL_MAX = 600;
    const TL_STORAGE_KEY = 'yta.timelineHeight';

    // Restore persisted height on startup so layout doesn't reset every session
    try {
        const saved = parseInt(localStorage.getItem(TL_STORAGE_KEY), 10);
        if (Number.isFinite(saved) && saved >= TL_MIN && saved <= TL_MAX) {
            elements.timelineContainer.style.height = `${saved}px`;
        }
    } catch (_err) { /* localStorage may be unavailable */ }

    let isDragging = false, startY = 0, startHeight = 0;
    handle.addEventListener('mousedown', (e) => {
        isDragging = true; startY = e.clientY; startHeight = elements.timelineContainer.offsetHeight;
        document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const h = Math.max(TL_MIN, Math.min(TL_MAX, startHeight + startY - e.clientY));
        elements.timelineContainer.style.height = `${h}px`;
    });
    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Persist final height
        try {
            const finalH = elements.timelineContainer.offsetHeight;
            if (Number.isFinite(finalH)) localStorage.setItem(TL_STORAGE_KEY, String(finalH));
        } catch (_err) { /* ignore */ }
    });
}

// ========================================
// Collapsible Panel Sections
// ========================================
function setupPanelSections() {
    document.querySelectorAll('.panel-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.panel-section-collapsible');
            if (section) section.classList.toggle('collapsed');
        });
    });
}

// ========================================
// File Handling
// ========================================
async function handleFileSelect(file) {
    if (!['.mp3', '.wav', 'audio/mpeg', 'audio/wav'].some(t => file.name.toLowerCase().endsWith(t) || file.type === t)) {
        showToast('Please select an MP3 or WAV file', 'error'); return;
    }
    const imported = await window.electronAPI?.importAudioFile?.(file);
    if (!imported?.success || !imported.path) {
        showToast(imported?.error || 'Could not import the audio file', 'error');
        return;
    }
    const filePath = imported.path;
    state.audioFile = { name: file.name, path: filePath };
    state.audioPath = filePath || file.name;
    elements.audioName.textContent = file.name;
    elements.audioInfo.classList.remove('hidden');
    elements.dropZone.style.display = 'none';
    showToast(`Audio loaded: ${file.name}`, 'success');
    loadAudioFile(filePath);
    _syncProductionModeUI();
}

async function loadAudioFile(filePath) {
    if (!elements.previewAudio || !filePath) return;
    try {
        const audioUrl = window.electronAPI?.getFileUrl ? await window.electronAPI.getFileUrl(filePath) : filePath;
        if (audioUrl) {
            elements.previewAudio.src = audioUrl;
            elements.previewAudio.load();
            // Update totalDuration to include full audio length
            elements.previewAudio.addEventListener('loadedmetadata', () => {
                if (elements.previewAudio.duration && isFinite(elements.previewAudio.duration)) {
                    const scenesEnd = state.scenes.length > 0 ? Math.max(...state.scenes.map(s => s.endTime)) : 0;
                    state.totalDuration = Math.max(scenesEnd, elements.previewAudio.duration);
                    updateTimeDisplay();
                }
            }, { once: true });
        }
    } catch (e) { console.error('Failed to load audio:', e); }
}

function removeAudio() {
    state.audioFile = null; state.audioPath = null;
    elements.audioInfo.classList.add('hidden');
    elements.dropZone.style.display = 'block';
    elements.fileInput.value = '';
    clearScenes();
    _syncProductionModeUI();
}

// ========================================
// Cancel Process
// ========================================
async function cancelProcess() {
    if (!state.isProcessing) return;
    let waitForAsyncCancellation = false;
    elements.btnCancel.disabled = true;
    elements.btnCancel.textContent = 'Cancelling...';
    try {
        // Cancel WebGL2 export pipeline if active (main-process FFmpeg).
        if (state.exportPipeline) {
            console.log('[Cancel] Cancelling WebGL2 export pipeline...');
            state.exportPipeline.cancel();
            // Pipeline cancel sets the local flag and requests main-process termination.
            // The frame loop will throw on its next iteration.
            // Show feedback immediately — don't wait for IPC.
            stopTimer();
            updateProgress(0, '⛔ Export cancelled');
            showToast('Export cancelled', 'info');
        }
        // Also signal main process (for build processes, legacy exports)
        const result = await window.electronAPI?.cancelProcess();
        if (result?.success && !state.exportPipeline) {
            waitForAsyncCancellation = /AI Video/i.test(String(result.message || ''));
            // Only show IPC cancel feedback if there was no pipeline cancel above
            stopTimer();
            updateProgress(0, `⛔ ${result.message || 'Cancelled'}`);
            showToast(waitForAsyncCancellation ? 'AI Video cancellation requested' : 'Process cancelled', 'info');
        }
    } catch (e) {
        console.error('Cancel error:', e);
    } finally {
        elements.btnCancel.disabled = false;
        elements.btnCancel.textContent = 'Cancel';
        // Force-cleanup state after short delay if renderVideo() is stuck and never resolves
        if (!waitForAsyncCancellation) setTimeout(() => {
            if (state.isProcessing) {
                console.warn('[Cancel] Force cleanup — render loop did not exit cleanly');
                state.isProcessing = false;
                state.exportPipeline = null;
                elements.btnRender.disabled = false;
                elements.btnCancel.disabled = false;
                elements.btnCancel.textContent = 'Cancel';
                // Restore compositor preview mode
                if (state.compositor) {
                    state.compositor._exporting = false;
                    state.compositor._restorePreviewResolution?.();
                }
                setTimeout(() => showProgress(false), 3000);
            }
        }, 2000);
    }
}

function _syncGenerateAvailability() {
    const canGenerate = !!state.hasProject && !state.isProcessing && !!state.audioFile?.path;
    if (elements.btnGenerate) {
        elements.btnGenerate.disabled = !canGenerate;
        elements.btnGenerate.title = !state.hasProject
            ? 'Create or open a project first'
            : canGenerate ? '' : 'Import narration audio first';
    }
    const canRepeat = !!state.hasProject && !state.isProcessing && !!state.audioFile?.path;
    if (elements.btnRepeatStep) elements.btnRepeatStep.disabled = !canRepeat;
}

function _syncRepeatStepUI() {
    const mode = elements.repeatFromStep?.value || 'visual-planner';
    const graphicsOnly = mode === 'motion-graphics';
    const mediaOnly = mode === 'media';
    const hint = document.getElementById('repeat-from-step-hint');
    if (elements.btnRepeatStep) {
        elements.btnRepeatStep.textContent = graphicsOnly
            ? 'Rebuild Motion Graphics + Test'
            : 'Repeat Selected Step';
    }
    if (hint) {
        hint.textContent = graphicsOnly
            ? 'Rebuilds only existing graphics and templates, proof-renders them through Motion QA, and preserves planning, footage, narration, transitions, and SFX.'
            : mediaOnly
                ? 'Starts at media download and reuses the saved Director and Visual Planner checkpoint.'
                : 'Starts at the Visual Planner and keeps the existing transcription and scene split.';
    }
    if (elements.forceFreshFootage) {
        elements.forceFreshFootage.disabled = !mediaOnly;
        const row = elements.forceFreshFootage.closest('.toggle-row');
        if (row) row.style.opacity = mediaOnly ? '1' : '0.45';
    }
}

// ========================================
// Video Generation
// ========================================
function _collectEffectiveBuildOptions() {
    const collected = SettingsIO.collect(null);
    const mode = elements.buildProductionMode?.value || 'faceless';
    const effective = {
        ...collected,
        buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
        footageSources: getEnabledSources(),
        aiInstructions: state.aiInstructions,
        videoTitle: state.videoTitle,
        presenterImage: state.presenterImage || '',
    };

    if (mode !== 'talkingHead') {
        effective.presenterImage = '';
        effective.klingAvatar = false;
        effective.klingAvatarPrompt = '';
    }
    return effective;
}

function _captureProjectCreativeFields(source = state) {
    return {
        videoTitle: String(source?.videoTitle ?? ''),
        aiInstructions: String(source?.aiInstructions ?? ''),
    };
}

async function _persistProjectSettingsBeforeBuild() {
    if (!state.hasProject || !state.videoPlan) return { success: true, skipped: true };
    if (_autoSaveTimer) {
        clearTimeout(_autoSaveTimer);
        _autoSaveTimer = null;
    }
    const result = await saveProject(true);
    if (!result?.success) {
        throw new Error(result?.error || 'Could not save project settings before the build');
    }
    return result;
}

async function generateVideo(options = {}) {
    if (state.isProcessing) return;
    if (!state.hasProject) { _requireProject(); return; }
    if (!state.audioFile) {
        showToast('Import narration audio first', 'error');
        return;
    }
    if (!state.audioFile.path) {
        showToast('Audio file path is missing. Please re-import the audio file.', 'error'); return;
    }
    const repeatFromStep = options.repeatStep ? (elements.repeatFromStep?.value || 'visual-planner') : '';
    // Only meaningful when repeating from Media Download — re-download clips instead of
    // reusing cached scene media (the Director/VP plan is still reused from the checkpoint).
    const forceFreshFootage = options.repeatStep ? !!(elements.forceFreshFootage?.checked) : false;
    state.isProcessing = true; elements.btnGenerate.disabled = true; if (elements.btnRepeatStep) elements.btnRepeatStep.disabled = true; showProgress(true); startTimer();
    buildLog.reset();
    try {
        updateProgress(5, 'Audio ready in project input...');
        updateProgress(
            10,
            repeatFromStep === 'motion-graphics'
                ? 'Rebuilding and proof-testing motion graphics...'
                : '🎙️ Transcribing audio with Whisper...'
        );
        const audioFileName = state.audioFile.name || state.audioFile.path?.split(/[\\/]/).pop();
        const effectiveSettings = _collectEffectiveBuildOptions();
        await _persistProjectSettingsBeforeBuild();
        if (effectiveSettings.fastMedia && elements.fastMediaToggle) {
            // Diagnostic mode is intentionally one-shot. Keep it in this payload, then
            // immediately return the production UI to its safe default for the next run.
            elements.fastMediaToggle.checked = false;
            _syncFastMediaUI();
            showToast('Fast pipeline test launched: random media; footage relevance checks skipped; Motion QA stays active', 'info');
        }
        const result = await window.electronAPI.runBuild({
            ...effectiveSettings,
            audioFileName,
            // Conditional: only sent when the Repeat button was used — override collect's raw values.
            repeatFromStep,
            forceFreshFootage,
        });
        if (result.success) {
            updateProgress(90, '📋 Loading video plan...'); await loadVideoPlan({ freshBuild: true });
            state.hasProjectFile = true; // Enable auto-save for the new plan
            await saveProject(true); // Commit fresh build data to every project mirror
            stopTimer();
            const genTime = getElapsedString();
            const graphicsOnly = repeatFromStep === 'motion-graphics';
            updateProgress(
                100,
                graphicsOnly
                    ? `✅ Motion graphics rebuilt and QA-tested! (${genTime})`
                    : `✅ Ready to render! (${genTime})`
            );
            showToast(
                graphicsOnly
                    ? `Motion graphics rebuilt and tested in ${genTime}!`
                    : `Video generated in ${genTime}!`,
                'success'
            );
            showNotification(
                graphicsOnly ? 'Motion Graphics Ready' : 'Generation Complete',
                graphicsOnly
                    ? `Graphics rebuilt and QA-tested in ${genTime}; planning and media were preserved`
                    : `Video generated in ${genTime}`
            );
            elements.btnRender.disabled = false;
            if (state.scenes.length > 0) await jumpToScene(0);
        } else {
            const errorMsg = result.error || 'Build failed';
            if (errorMsg === 'Cancelled') {
                stopTimer(); updateProgress(0, '⛔ Generation cancelled'); showToast('Generation cancelled', 'info'); showNotification('Generation Cancelled', `Stopped after ${getElapsedString()}`, 'cancel');
            } else {
                throw new Error(errorMsg);
            }
        }
    } catch (error) { console.error('❌ Generation error:', error); stopTimer(); showToast(`Error: ${error.message}`, 'error'); }
    finally {
        state.isProcessing = false;
        _syncGenerateAvailability();
        elements.btnCancel.disabled = false;
        elements.btnCancel.textContent = 'Cancel';
        setTimeout(() => showProgress(false), 5000);
    }
}

// ========================================
// Video Plan & Scenes
// ========================================
async function loadVideoPlan({ freshBuild = false, hyperframesPreviewOptions = null } = {}) {
    // A build may finish before the debounced project-settings save runs. Capture
    // the live title/instructions before loading the newly generated plan so stale
    // .fvp settings cannot erase the exact text the user currently has in the UI.
    const freshProjectFields = freshBuild ? _captureProjectCreativeFields() : null;
    state.projectHydrating = true;
    if (_autoSaveTimer) {
        clearTimeout(_autoSaveTimer);
        _autoSaveTimer = null;
    }
    try {
        // Main reconciles .fvp/public/temp and returns the newest plan with the
        // project-scoped settings. Fresh builds no longer need a stale-.fvp bypass.
        let plan = null;
        let fvpSettings = null;
        if (window.electronAPI.loadProjectFile) {
            console.log(`[loadVideoPlan] Loading unified project state${freshBuild ? ' after build' : ''}...`);
            const projectData = await window.electronAPI.loadProjectFile();
            if (projectData && projectData.videoPlan) {
                plan = projectData.videoPlan;
                fvpSettings = projectData.settings || null;
                state.hasProjectFile = true;
                state.projectRevision = Number(projectData.revision) || 0;
                state.projectPlanHash = projectData.planHash || null;
                console.log(`✅ Loaded unified plan from ${projectData.source || '.fvp'} (${plan.scenes?.length || 0} scenes)`);
            } else {
                console.warn('[loadVideoPlan] Unified project state returned no videoPlan:', projectData ? Object.keys(projectData) : 'null');
            }
        }

        // Compatibility fallback for older preload/main combinations.
        if (!plan) {
            console.log('[loadVideoPlan] Falling back to direct video-plan load...');
            plan = await window.electronAPI.loadVideoPlan();
            if (plan) {
                console.log(`✅ Loaded from video-plan.json (${plan.scenes?.length || 0} scenes)`);
            } else {
                console.warn('[loadVideoPlan] video-plan.json also returned null');
            }
        }

        if (plan) {
            plan = normalizePlanForEditor(plan);

            // Restore editor settings from .fvp if available
            if (fvpSettings) {
                applyProjectSettings(fvpSettings, { projectFieldOverride: freshProjectFields });
            }

            state.videoPlan = plan;
            window._mgBridgeVideoPlan = plan;
            state._mediaUrlCache = {}; // Clear media URL cache on new plan load
            state._trackActiveEl = { '1': 'a', '2': 'a', '3': 'a' }; // Reset double-buffer state
            state._trackSwapPending = { '1': false, '2': false, '3': false }; // Reset deferred swaps
            // Clear _loadedUrl on all buffer elements
            [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
            elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(v => {
                if (v) { v._loadedUrl = null; v.src = ''; }
            });

            // Builds already carry trackIds, so trackId cannot distinguish a fresh
            // build from an edited project. Restore the canonical normalized timing
            // exactly; gaps are real timeline gaps and must not be silently expanded.
            state.scenes = (plan.scenes || []).map((scene) => ({
                ...scene,
                trackId: scene.trackId || 'video-track-1',
            }));
            hydratePlanTransitions(plan, state.scenes);
            const sceneEnd = state.scenes.length
                ? Math.max(...state.scenes.map((scene) => Number(scene.endTime) || 0))
                : 0;
            state.totalDuration = plan.totalDuration || sceneEnd;

            state.currentTime = 0;

            if (plan.audio) {
                try {
                    const audioPath = await window.electronAPI.getAudioPath?.(plan.audio);
                    if (audioPath) {
                        state.audioPath = audioPath;
                        state.audioFile = { name: plan.audio, path: audioPath };
                        elements.audioName.textContent = plan.audio;
                        elements.audioInfo.classList.remove('hidden');
                        elements.dropZone.style.display = 'none';
                        await loadAudioFile(audioPath);
                    }
                } catch (e) { console.warn('Audio loading failed:', e.message); }
            }
            _syncProductionModeUI();

            // Enable render button if we have scenes
            if (state.scenes.length > 0) {
                elements.btnRender.disabled = false;
            }

            // The build is the sole SFX authority. An empty array means the Sound
            // Designer intentionally left this cut silent; the editor must not invent
            // a replacement track.
            try {
                hydratePlanSfx(Array.isArray(plan.sfxClips) ? plan.sfxClips : []);
                preloadSfxUrls();
            } catch (e) { console.warn('SFX hydrate failed:', e.message); }

            // Load motion graphics from plan
            // Full-screen types (barChart, donutChart, etc.) go on V3 as scene objects
            try {
            const FULLSCREEN_MG_TYPES = new Set(['barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList', 'mapChart', 'articleHighlight', 'listicleGrid']);
            const allMGs = plan.motionGraphics || [];
            // Explainer always stays as overlay MG (never fullscreen V3 scene)
            state.motionGraphics = allMGs.filter(mg => !FULLSCREEN_MG_TYPES.has(mg.type));
            state.mgStyle = plan.mgStyle || 'clean';
            _hydrateMgOverlayShadow(plan);

            // Resolve explainer image URLs for overlay MGs
            _resolveExplainerUrls(state.motionGraphics);

            // Load full-screen MGs onto V3 (from mgScenes, templateScenes, or classified from motionGraphics)
            const fullscreenMGs = [
                ...(plan.mgScenes || []),
                ...(plan.templateScenes || []),
                ...allMGs.filter(mg => FULLSCREEN_MG_TYPES.has(mg.type))
            ];
            // Deduplicate (in case both mgScenes and motionGraphics have the same MG)
            const seenIds = new Set();
            for (const mg of fullscreenMGs) {
                if (!mg) continue;
                const key = mg.id || `${mg.type}-${mg.startTime}`;
                if (seenIds.has(key)) continue;
                seenIds.add(key);
                // Strip nested mgData to avoid recursive bloat in saved plans
                const { mgData: _nested, ...mgFlat } = mg;
                // Resolve deeply nested mgData to get the actual core data
                let core = mg;
                while (core.mgData) core = core.mgData;
                const mgTiming = timelineContract?.normalizeTiming
                    ? timelineContract.normalizeTiming(mg, {
                        fps: plan.fps || 30,
                        totalDuration: plan.totalDuration,
                        fallbackDuration: mg.templateType ? 4 : 3,
                    })
                    : getSceneTiming(mg, mg.templateType ? 4 : 3);
                const sceneObj = {
                    isMGScene: true,
                    disabled: mg.disabled === true,
                    trackId: 'video-track-3',
                    mediaType: mg.templateType ? 'template' : 'motion-graphic',
                    clipId: mg.clipId || `mg-${timelineContract?.safeToken?.(key, 'visual') || key}-${Math.round(mgTiming.startTime * 1000)}`,
                    ...mgTiming,
                    text: mg.text || '',
                    subtext: mg.subtext || mg.subText || '',
                    type: mg.type,
                    position: mg.position || 'center',
                    style: mg.style || state.mgStyle || 'clean',
                    keyword: mg.templateType ? `Template: ${mg.type}` : `MG: ${mg.type}`,
                    mgData: core === mg ? mgFlat : core,
                };
                for (const identityKey of [
                    'sceneIndex',
                    'sourceSceneIndex',
                    'originalSceneIndex',
                    'targetSceneIndex',
                ]) {
                    const identityValue = core[identityKey] != null ? core[identityKey] : mg[identityKey];
                    if (identityValue == null) continue;
                    sceneObj[identityKey] = identityValue;
                    if (sceneObj.mgData && typeof sceneObj.mgData === 'object') {
                        sceneObj.mgData[identityKey] = identityValue;
                    }
                }
                if (mg.templateType) sceneObj.templateType = true;
                if (mg.templateType) {
                    const templateBg = core.mgBackground || mg.mgBackground || core.background || mg.background || 'none';
                    sceneObj.mgBackground = templateBg;
                    if (sceneObj.mgData && !sceneObj.mgData.mgBackground) sceneObj.mgData.mgBackground = templateBg;
                    const templateTimingKeys = [
                        'templateContentStartTime',
                        'templateContentEndTime',
                        'templateContentDuration',
                        'templateContentOffset',
                    ];
                    for (const key of templateTimingKeys) {
                        const value = core[key] != null ? core[key] : mg[key];
                        if (value == null) continue;
                        sceneObj[key] = value;
                        if (sceneObj.mgData) sceneObj.mgData[key] = value;
                    }
                }
                if (mg.variant) sceneObj.variant = mg.variant;
                if (mg.animation) sceneObj.animation = mg.animation;
                if (mg.themeId) sceneObj.themeId = mg.themeId;
                if (mg.items) sceneObj.items = mg.items;
                if (mg.mapStyle) sceneObj.mapStyle = mg.mapStyle;
                // Propagate article image properties for image mode
                if (core.articleImageFile) {
                    sceneObj.articleImageFile = core.articleImageFile;
                    if (sceneObj.mgData) sceneObj.mgData.articleImageFile = core.articleImageFile;
                }
                if (core.highlightBoxes) {
                    sceneObj.highlightBoxes = core.highlightBoxes;
                    if (sceneObj.mgData) sceneObj.mgData.highlightBoxes = core.highlightBoxes;
                }
                // Propagate map image properties
                if (core.mapImageFile) {
                    sceneObj.mapImageFile = core.mapImageFile;
                    if (sceneObj.mgData) sceneObj.mgData.mapImageFile = core.mapImageFile;
                }
                if (core._mapView) {
                    sceneObj._mapView = core._mapView;
                    if (sceneObj.mgData) sceneObj.mgData._mapView = core._mapView;
                }
                if (core._mapPins) {
                    sceneObj._mapPins = core._mapPins;
                    if (sceneObj.mgData) sceneObj.mgData._mapPins = core._mapPins;
                }
                if (core._mapWaypoints) {
                    sceneObj._mapWaypoints = core._mapWaypoints;
                    if (sceneObj.mgData) sceneObj.mgData._mapWaypoints = core._mapWaypoints;
                }
                if (core._bigMapSize) {
                    sceneObj._bigMapSize = core._bigMapSize;
                    if (sceneObj.mgData) sceneObj.mgData._bigMapSize = core._bigMapSize;
                }
                if (core._wpCoords) {
                    sceneObj._wpCoords = core._wpCoords;
                    if (sceneObj.mgData) sceneObj.mgData._wpCoords = core._wpCoords;
                }
                if (core._mapBigMap) {
                    sceneObj._mapBigMap = core._mapBigMap;
                    if (sceneObj.mgData) sceneObj.mgData._mapBigMap = core._mapBigMap;
                }
                if (core._osmBoundaries) {
                    sceneObj._osmBoundaries = core._osmBoundaries;
                    if (sceneObj.mgData) sceneObj.mgData._osmBoundaries = core._osmBoundaries;
                }
                if (core._mapIcons) {
                    sceneObj._mapIcons = core._mapIcons;
                    if (sceneObj.mgData) sceneObj.mgData._mapIcons = core._mapIcons;
                }
                if (core._mapRoutePath) {
                    sceneObj._mapRoutePath = core._mapRoutePath;
                    if (sceneObj.mgData) sceneObj.mgData._mapRoutePath = core._mapRoutePath;
                }
                if (core._mapRouteGeometry) {
                    sceneObj._mapRouteGeometry = core._mapRouteGeometry;
                    if (sceneObj.mgData) sceneObj.mgData._mapRouteGeometry = core._mapRouteGeometry;
                }
                if (core._mapAlternateRouteGeometry) {
                    sceneObj._mapAlternateRouteGeometry = core._mapAlternateRouteGeometry;
                    if (sceneObj.mgData) sceneObj.mgData._mapAlternateRouteGeometry = core._mapAlternateRouteGeometry;
                }
                // Phase B prep: authoritative MapScene (subjects, cameraPlan,
                // annotationPlan, geometry, renderAssets). Renderer will consume
                // this directly once the legacy per-field lookups are retired.
                if (core._mapScene) {
                    sceneObj._mapScene = core._mapScene;
                    if (sceneObj.mgData) sceneObj.mgData._mapScene = core._mapScene;
                }
                // Pre-resolve map image URL for preview
                if (core.mapImageFile && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getProjectInfo().then(async (info) => {
                        const mapPath = info.projectDir + '/public/' + core.mapImageFile;
                        const url = await window.electronAPI.getFileUrl(mapPath);
                        if (url) {
                            sceneObj._mapImageUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._mapImageUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate explainer image properties
                if (core.explainerImageFile) {
                    sceneObj.explainerImageFile = core.explainerImageFile;
                    if (sceneObj.mgData) sceneObj.mgData.explainerImageFile = core.explainerImageFile;
                }
                if (core.explainerLabel) {
                    sceneObj.explainerLabel = core.explainerLabel;
                    if (sceneObj.mgData) sceneObj.mgData.explainerLabel = core.explainerLabel;
                }
                // Pre-resolve explainer image URL for preview
                if (core.explainerImageFile && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getProjectInfo().then(async (info) => {
                        const imgPath = info.projectDir + '/public/' + core.explainerImageFile;
                        const url = await window.electronAPI.getFileUrl(imgPath);
                        if (url) {
                            sceneObj._explainerImageUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._explainerImageUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate listicle grid data (items + thumbnails)
                if (core._listicleItems) {
                    sceneObj._listicleItems = core._listicleItems;
                    if (sceneObj.mgData) sceneObj.mgData._listicleItems = core._listicleItems;
                }
                if (core._itemThumbnails) {
                    sceneObj._itemThumbnails = core._itemThumbnails;
                    if (sceneObj.mgData) sceneObj.mgData._itemThumbnails = core._itemThumbnails;
                    // Pre-resolve thumbnail URLs via Electron IPC
                    // Template item images (tpl-item-*) are in public/, listicle thumbs use getFileUrl directly
                    const isTemplateItems = core._itemThumbnails.some(t => t && t.startsWith('tpl-item-'));
                    if (isTemplateItems && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                        window.electronAPI.getProjectInfo().then(async (info) => {
                            const urls = await Promise.all(core._itemThumbnails.map(async (thumbFile) => {
                                if (!thumbFile) return null;
                                try {
                                    const fullPath = info.projectDir + '/public/' + thumbFile;
                                    return await window.electronAPI.getFileUrl(fullPath);
                                } catch { return null; }
                            }));
                            sceneObj._itemThumbnailUrls = urls;
                            if (sceneObj.mgData) sceneObj.mgData._itemThumbnailUrls = urls;
                        }).catch(() => { });
                    } else if (window.electronAPI?.getFileUrl) {
                        Promise.all(core._itemThumbnails.map(async (thumbPath) => {
                            if (!thumbPath) return null;
                            try { return await window.electronAPI.getFileUrl(thumbPath); } catch { return null; }
                        })).then(urls => {
                            sceneObj._itemThumbnailUrls = urls;
                            if (sceneObj.mgData) sceneObj.mgData._itemThumbnailUrls = urls;
                        }).catch(() => { });
                    }
                }
                // Pre-resolve article image URL for preview
                if (core.articleImageFile && window.electronAPI?.getSceneMediaPath) {
                    const ext = core.articleImageFile.match(/\.\w+$/)?.[0] || '.jpg';
                    window.electronAPI.getSceneMediaPath(0, ext, 'article').then(async (filePath) => {
                        if (filePath && window.electronAPI.getFileUrl) {
                            const url = await window.electronAPI.getFileUrl(filePath);
                            sceneObj._articleImageUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._articleImageUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate template background media properties
                if (core.templateBgFile) {
                    sceneObj.templateBgFile = core.templateBgFile;
                    if (sceneObj.mgData) sceneObj.mgData.templateBgFile = core.templateBgFile;
                }
                // Pre-resolve template background media URL
                if (core.templateBgFile && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getProjectInfo().then(async (info) => {
                        const bgPath = info.projectDir + '/public/' + core.templateBgFile;
                        const url = await window.electronAPI.getFileUrl(bgPath);
                        if (url) {
                            sceneObj._templateBgUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._templateBgUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate template media file (video/image from underlying scene)
                if (core.templateMediaFile) {
                    sceneObj.templateMediaFile = core.templateMediaFile;
                    sceneObj.templateMediaOffset = core.templateMediaOffset || 0;
                    if (sceneObj.mgData) {
                        sceneObj.mgData.templateMediaFile = core.templateMediaFile;
                        sceneObj.mgData.templateMediaOffset = core.templateMediaOffset || 0;
                    }
                }
                // Pre-resolve template media URL and preload the media element
                if (core.templateMediaFile && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getFileUrl(core.templateMediaFile).then(url => {
                        if (url) {
                            sceneObj._templateMediaUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._templateMediaUrl = url;
                            // Preload media now so it's ready before user seeks to it
                            _preloadTemplateMedia(core.templateMediaFile, url, core.templateMediaOffset || 0);
                        }
                    }).catch(() => { });
                }
                state.scenes.push(sceneObj);
            }
            // Carve out V2 scenes that overlap with full-screen MGs
            // Full-screen MGs ARE the visual — no footage underneath
                if (seenIds.size > 0) {
                const mgRanges = state.scenes
                    .filter(s => s.isMGScene && !(_isTransparentTemplateBackground(s) && s.templateType))
                    .map(s => ({ start: s.startTime, end: s.endTime }));
                if (mgRanges.length === 0) {
                    console.log(`Loaded ${seenIds.size} full-screen MGs onto V3 (kept V2 under timed templates)`);
                } else {
                const carved = [];
                for (const scene of state.scenes) {
                    if (scene.isMGScene) {
                        carved.push(scene);
                        continue;
                    }
                    let parts = [{ start: scene.startTime, end: scene.endTime }];
                    for (const range of mgRanges) {
                        const next = [];
                        for (const p of parts) {
                            if (range.start >= p.end || range.end <= p.start) {
                                next.push(p);
                            } else if (range.start <= p.start && range.end >= p.end) {
                                // fully covered — remove
                            } else if (range.start > p.start && range.end < p.end) {
                                next.push({ start: p.start, end: range.start });
                                next.push({ start: range.end, end: p.end });
                            } else if (range.start <= p.start) {
                                next.push({ start: range.end, end: p.end });
                            } else {
                                next.push({ start: p.start, end: range.start });
                            }
                        }
                        parts = next;
                    }
                    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                        const p = parts[partIndex];
                        if (p.end - p.start < 0.3) continue;
                        const trimmed = { ...scene };
                        const offset = p.start - scene.startTime;
                        trimmed.startTime = p.start;
                        trimmed.endTime = p.end;
                        trimmed.duration = p.end - p.start;
                        trimmed.durationFrames = Math.max(1, Math.round(trimmed.duration * (plan.fps || 30)));
                        trimmed.durationUnit = 'seconds';
                        trimmed.sourceSceneIndex = getSceneSourceIndex(scene, scene.index);
                        const unchanged = parts.length === 1
                            && Math.abs(p.start - scene.startTime) < 0.001
                            && Math.abs(p.end - scene.endTime) < 0.001;
                        if (!unchanged) {
                            trimmed.clipId = createSegmentClipId(scene, p.start, p.end, partIndex);
                        }
                        if (offset > 0) {
                            trimmed.mediaOffset = (scene.mediaOffset || 0) + offset;
                        }
                        carved.push(trimmed);
                    }
                }
                state.scenes = carved;
                console.log(`Loaded ${seenIds.size} full-screen MGs onto V3 (carved gaps in V2)`);
                }
            }
            } catch (mgError) {
                console.warn('MG/overlay loading failed (scenes still OK):', mgError.message);
            }

            renderScenes();
            renderTimeline();

            // Pre-cache ALL scene media URLs upfront so playback never waits for IPC
            console.log(`[PreCache] Pre-caching media URLs for ${state.scenes.length} scenes...`);
            const cachePromises = state.scenes
                .filter(s => !s.isMGScene)
                .map(async (scene, i) => {
                    // V2 overlay scenes have mediaFile — cache their URL directly
                    if (scene.mediaFile) {
                        const url = await window.electronAPI.getFileUrl(scene.mediaFile).catch(() => null);
                        if (url) {
                            const sourceIndex = getSceneSourceIndex(scene, i);
                            const cacheKey = `${sourceIndex}:${scene.mediaExtension || ''}:scene`;
                            state._mediaUrlCache[cacheKey] = url;
                            return url;
                        }
                    }
                    const idx = getSceneSourceIndex(scene, i);
                    return getCachedMediaUrl(idx, scene.mediaExtension).catch(() => null);
                });
            await Promise.all(cachePromises);
            console.log(`[PreCache] Done. Cached ${Object.keys(state._mediaUrlCache).length} URLs`);

            // Keep the selected preview engine in sync with the loaded plan.
            const rendererMode = document.getElementById('renderer-select')?.value || 'hyperframes';
            if (rendererMode === 'hyperframes') {
                await setHyperframesPreviewMode(true, hyperframesPreviewOptions || {});
            } else if (state.compositor) {
                loadPlanIntoCompositor().catch(e => console.warn('[Compositor] Plan load deferred:', e.message));
            }

            // Pre-buffer the SECOND video scene into the buffer element for instant first transition
            preloadUpcomingScenes(0, true);
        }
    } catch (error) {
        console.error('❌ Failed to load video plan:', error?.message || error, error?.stack);
    } finally {
        state.projectHydrating = false;
    }
}

// ========================================
// Test Plan Loader (DevTools: window._loadTestPlan or paste one-liner)
// ========================================
window._loadTestPlan = async function(plan) {
    if (!plan) {
        // Load the fixed project test-plan path through narrow IPC.
        try {
            const result = await window.electronAPI.loadTestMgPlan();
            if (!result?.success) throw new Error(result?.error || 'Failed to load test MG plan');
            plan = result.plan;
        } catch (e) {
            console.error('Failed to load test-mg-plan.json:', e.message);
            return;
        }
    }
    plan = normalizePlanForEditor(plan);
    state.videoPlan = plan;
    window._mgBridgeVideoPlan = plan; // sync with mg-theme-bridge.js for MG style resolution
    state._mediaUrlCache = {};
    state.scenes = [];
    state.motionGraphics = [];
    state.transitions = [];

    const FULLSCREEN_MG_TYPES = new Set(['barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList', 'mapChart', 'articleHighlight']);
    const allMGs = plan.motionGraphics || [];
    state.motionGraphics = allMGs.filter(mg => !FULLSCREEN_MG_TYPES.has(mg.type));
    hydratePlanTransitions(plan, plan.scenes || []);
    state.mgStyle = plan.mgStyle || 'clean';
    _hydrateMgOverlayShadow(plan);

    // Resolve explainer image URLs for overlay MGs
    _resolveExplainerUrls(state.motionGraphics);

    // Process regular scenes
    let nextIndex = 0;
    for (const s of (plan.scenes || [])) {
        const scene = { ...s };
        scene.trackId = scene.trackId || 'video-track-1';
        if (!scene.mediaType) scene.mediaType = 'video';
        state.scenes.push(scene);
        const numericSource = Number(getSceneSourceIndex(scene, nextIndex));
        if (Number.isFinite(numericSource)) nextIndex = Math.max(nextIndex, numericSource + 1);
    }

    // Process fullscreen MG scenes (includes templates from ai-templates.js)
    const fullscreenMGs = [
        ...(plan.mgScenes || []),
        ...(plan.templateScenes || []),
        ...allMGs.filter(mg => FULLSCREEN_MG_TYPES.has(mg.type))
    ];
    for (const mg of fullscreenMGs) {
        if (!mg) continue;
        const timing = getSceneTiming(mg, mg.templateType ? 4 : 3);
        const scene = {
            ...mg,
            index: mg.index !== undefined ? mg.index : nextIndex++,
            clipId: mg.clipId || `mg-test-${nextIndex}-${Math.round(timing.startTime * 1000)}`,
            ...timing,
            isMGScene: true,
            mediaType: 'motion-graphic',
            trackId: mg.trackId || 'video-track-3',
        };
        state.scenes.push(scene);
    }

    state.currentTime = 0;
    resetTimelineDomCache();
    renderTimeline();
    updateClipProperties();
    console.log(`✅ Test plan loaded: ${state.scenes.length} scenes, ${state.motionGraphics.length} overlay MGs`);

    // Pre-cache media URLs for video scenes
    for (const s of state.scenes) {
        if (s.mediaType === 'video' && s.mediaExtension) {
            await getCachedMediaUrl(getSceneSourceIndex(s, s.index), s.mediaExtension).catch(() => null);
        }
    }

    // Load into legacy preview
    if (state.scenes.length > 0) {
        await jumpToScene(0);
    }

    const rendererMode = document.getElementById('renderer-select')?.value || 'hyperframes';
    if (rendererMode === 'hyperframes') {
        await setHyperframesPreviewMode(true);
        console.log('[HyperFrames Preview] Test plan reloaded');
    } else if (state.compositor) {
        await loadPlanIntoCompositor();
        console.log('✅ Compositor plan reloaded');
    }
};

// ========================================
// Build-authored SFX track
// ========================================
// Final renders are loudness-normalized, while browser preview plays raw files.
// This preview-only gain makes the build-authored cues audible for QA.
const PREVIEW_SFX_GAIN = 1.9;

function hydratePlanSfx(clips) {
    state.sfxClips = (clips || [])
        .filter((sfx) => sfx && typeof sfx.file === 'string')
        .map((sfx, index) => ({
            id: `sfx-${index}`,
            file: sfx.file,
            startTime: Math.max(0, Number(sfx.startTime) || 0),
            duration: Math.max(0.01, Number(sfx.duration) || 0.5),
            volume: Math.max(0, Math.min(1, Number.isFinite(Number(sfx.volume)) ? Number(sfx.volume) : 0.35)),
            transitionType: sfx.transitionType || '',
            role: sfx.role || '',
            why: sfx.why || '',
            _triggered: false,
        }));
}

function renderScenes() {
    // Show all scenes including full-screen MG scenes (they are real scenes on V3)
    const displayScenes = state.scenes;
    if (displayScenes.length === 0) { elements.sceneList.innerHTML = '<p class="empty-state">No scenes yet</p>'; return; }
    elements.sceneList.replaceChildren();
    displayScenes.forEach((scene) => {
        const i = state.scenes.indexOf(scene);
        const trType = scene.transitionType || (state.transition.style !== 'auto' ? state.transition.style : null) || scene.transition?.type || 'crossfade';
        const keyword = scene.isMGScene
            ? `MG · ${scene.type || 'motion graphic'}`
            : (scene.keyword ? `Search · ${scene.keyword}` : '');

        const card = document.createElement('div');
        card.className = `scene-card${scene.isMGScene ? ' scene-card-mg' : ''}${scene.flagForReplacement ? ' scene-card-qa-flagged' : ''}`;
        card.dataset.index = String(i);

        const number = document.createElement('div');
        number.className = 'scene-number';
        number.appendChild(document.createTextNode(`Scene ${i}`));

        const addBadge = (className, title, text) => {
            const badge = document.createElement('span');
            badge.className = className;
            badge.title = String(title || '');
            badge.textContent = String(text || '');
            number.appendChild(badge);
        };
        if (i > 0 && !scene.isMGScene) {
            addBadge('scene-transition-badge', trType, trType.toUpperCase());
        }
        if (scene.isMGScene) {
            const type = scene.type || 'MG';
            addBadge('scene-mg-badge', `Motion Graphic: ${type}`, `MG · ${type}`);
        }
        if (scene.flagForReplacement) {
            addBadge('scene-qa-badge', scene.qaReason || 'Flagged by QA', '⚠ QA');
        }

        const text = document.createElement('div');
        text.className = 'scene-text';
        text.textContent = scene.text || '';

        const keywordEl = document.createElement('div');
        keywordEl.className = 'scene-keyword';
        keywordEl.textContent = keyword;
        keywordEl.classList.toggle('hidden', !keyword);

        card.append(number, text, keywordEl);
        card.addEventListener('click', () => jumpToScene(i));
        elements.sceneList.appendChild(card);
    });
}

// ========================================
// Timeline Rendering - COMPLETELY FIXED
// ========================================
function renderTimeline() {
    const container = elements.timelineContainer;
    const duration = Math.max(state.totalDuration, 60);
    const totalWidth = (duration * state.timeline.zoom) + TRACK_HEADER_WIDTH + 500;

    // Preserve scroll position before innerHTML destroys it
    const prevScroll = state.timeline.scrollX || 0;

    // Reset cached DOM refs — innerHTML destroys old elements
    resetTimelineDomCache();

    container.innerHTML = `
        <div class="timeline-header">
            <div class="timeline-header-left">
                <span>Timeline</span>
                <button id="snap-toggle" class="snap-toggle ${state.snapEnabled ? 'active' : ''}" title="Toggle Snap to Clips">
                    <span class="snap-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 2v6a5 5 0 0 0 10 0V2M3 5h3M10 5h3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>
                    <span class="snap-label">Snap</span>
                </button>
                <button id="time-format-toggle" class="snap-toggle ${state.timeline.rulerSecondsOnly ? 'active' : ''}" title="Toggle ruler time format (M:SS ↔ seconds-only, for matching log timestamps)">
                    <span class="snap-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="4.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.25V2.5M6.25 2.5h3.5M8 9V6.5M8 9l2 1.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
                    <span class="snap-label">${state.timeline.rulerSecondsOnly ? 'Sec' : 'M:SS'}</span>
                </button>
            </div>
            <div class="timeline-info">
                <div class="zoom-control">
                    <span class="zoom-label" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.25 10.25 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
                    <button id="zoom-fit-btn" class="zoom-fit-btn" title="Fit timeline to view (Shift+F)">Fit</button>
                    <input type="range" id="zoom-slider" class="zoom-slider" min="0" max="1000" value="${zoomToSlider(state.timeline.zoom)}" step="1">
                    <span id="timeline-zoom">${formatZoomLabel(state.timeline.zoom)}</span>
                </div>
                <span class="divider">|</span>
                <span id="timeline-time">${formatTime(state.currentTime, true)} / ${formatTime(state.totalDuration, true)}</span>
                <span id="in-out-display" class="in-out-display"></span>
            </div>
        </div>
        <div class="timeline-body">
            <div class="timeline-ruler" id="timeline-ruler" style="width:${totalWidth}px; margin-left:${TRACK_HEADER_WIDTH}px"></div>
            <div class="timeline-scroll" id="timeline-scroll">
                <div class="timeline-content" id="timeline-content" style="width:${totalWidth}px"></div>
            </div>
            <div class="playhead" id="playhead"><div class="playhead-head"></div><div class="playhead-line"></div></div>
        </div>
    `;

    renderRuler(duration);
    renderTracks();
    updatePlayhead();
    renderInOutMarkers();
    updateInOutDisplay();

    const scroll = document.getElementById('timeline-scroll');
    // Restore scroll position after innerHTML rebuild
    if (prevScroll > 0) scroll.scrollLeft = prevScroll;
    scroll.addEventListener('scroll', () => { state.timeline.scrollX = scroll.scrollLeft; updatePlayhead(); });
    scroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey) { e.preventDefault(); changeZoom(e.deltaY < 0 ? 10 : -10); }
        else if (e.shiftKey || e.altKey) { e.preventDefault(); scroll.scrollLeft += e.deltaY; }
    });

    // Setup zoom slider (logarithmic scale)
    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider) {
        zoomSlider.addEventListener('input', (e) => {
            const newZoom = sliderToZoom(parseFloat(e.target.value));
            applyZoom(newZoom);
        });
    }

    // Fit button - zoom to fit entire timeline in view
    const fitBtn = document.getElementById('zoom-fit-btn');
    if (fitBtn) {
        fitBtn.addEventListener('click', zoomToFit);
    }

    // Setup snap toggle
    const snapToggle = document.getElementById('snap-toggle');
    if (snapToggle) {
        snapToggle.addEventListener('click', () => {
            state.snapEnabled = !state.snapEnabled;
            snapToggle.classList.toggle('active', state.snapEnabled);
            showToast(`Snap ${state.snapEnabled ? 'enabled' : 'disabled'}`, 'info');
        });
    }

    // Setup time format toggle (M:SS ↔ seconds-only, for matching log timestamps)
    const timeFmtToggle = document.getElementById('time-format-toggle');
    if (timeFmtToggle) {
        timeFmtToggle.addEventListener('click', () => {
            state.timeline.rulerSecondsOnly = !state.timeline.rulerSecondsOnly;
            timeFmtToggle.classList.toggle('active', state.timeline.rulerSecondsOnly);
            const lbl = timeFmtToggle.querySelector('.snap-label');
            if (lbl) lbl.textContent = state.timeline.rulerSecondsOnly ? 'Sec' : 'M:SS';
            renderRuler(state.totalDuration);
            const timeEl = document.getElementById('timeline-time');
            if (timeEl) timeEl.textContent = `${formatTime(state.currentTime, true)} / ${formatTime(state.totalDuration, true)}`;
            showToast(`Timeline: ${state.timeline.rulerSecondsOnly ? 'seconds-only' : 'M:SS'}`, 'info');
        });
    }

    setupPlayhead();
    setupRulerClick();
}

function renderRuler(duration) {
    const ruler = document.getElementById('timeline-ruler');
    const zoom = state.timeline.zoom;

    // Adaptive step: ensure ticks are at least ~50px apart, labels ~100px apart
    let step;
    let fractional = false;
    if (zoom >= 200) { step = 0.5; fractional = true; }   // 0.5s ticks at high zoom
    else if (zoom >= 50) step = 1;
    else if (zoom >= 20) step = 5;
    else if (zoom >= 5) step = 10;
    else if (zoom >= 2) step = 30;     // 30s steps
    else if (zoom >= 1) step = 60;     // 1min steps
    else if (zoom >= 0.5) step = 120;  // 2min steps
    else step = 300;                   // 5min steps

    const labelEvery = fractional ? 1 : (step <= 5 ? step * 2 : step);
    const majorEvery = fractional ? 1 : (step <= 10 ? step * 5 : step * 2);

    let html = '';
    for (let t = 0; t <= duration + step; t += step) {
        t = Math.round(t * 100) / 100; // avoid float drift
        const left = t * zoom;
        const isMajor = fractional ? (t % 1 === 0) : (t % majorEvery === 0);
        html += `<div class="ruler-tick ${isMajor ? 'major' : ''}" style="left:${left}px"></div>`;
        const showLabel = fractional ? (t % 1 === 0) : (t % labelEvery === 0);
        if (showLabel) {
            html += `<div class="ruler-label" style="left:${left}px">${formatTime(t, fractional)}</div>`;
        }
    }
    ruler.innerHTML = html;
}

function renderTracks() {
    const content = document.getElementById('timeline-content');
    let html = '';
    const svgMuted = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    const svgUnmuted = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    // Determine which video tracks have clips (auto-collapse empty upper tracks)
    const usedVideoTracks = new Set();
    state.scenes.forEach(s => usedVideoTracks.add(s.trackId || 'video-track-1'));
    const continuityHolds = timelineContract?.buildContinuityHolds
        ? timelineContract.buildContinuityHolds(
            state.scenes.filter((scene) => !scene?.isMGScene),
            {
                fps: state.videoPlan?.fps || state.fps || 30,
                totalDuration: state.totalDuration,
            }
        )
        : (state.videoPlan?.continuityHolds || []);

    state.timeline.tracks.forEach((track, trackIndex) => {
        const canMuteTrack = track.id !== 'sfx-track';
        const isMuted = canMuteTrack && (state.mutedTracks[track.id] || false);
        const muteIcon = isMuted ? svgMuted : svgUnmuted;
        const muteClass = isMuted ? 'track-muted' : '';
        let trackHeight = state.timeline.trackHeights[track.id] || 36;

        // Auto-collapse empty upper video tracks (V4, V5) to save space
        const trackNum = parseInt(track.id.match(/\d+/)?.[0] || '0', 10);
        const isEmptyUpper = track.type === 'video' && trackNum > 3 && !usedVideoTracks.has(track.id);
        if (isEmptyUpper) trackHeight = 12;

        const mgTestBtn = track.id === 'mg-track' ? `<button class="mg-test-btn" data-action="inject-test-mg" title="Inject 6 test MGs">+</button>` : '';
        const muteButton = canMuteTrack
            ? `<button class="track-mute-btn ${isMuted ? 'muted' : ''}" data-track-mute="${track.id}" title="${isMuted ? 'Unmute' : 'Mute'} track">${muteIcon}</button>`
            : '';
        html += `<div class="timeline-row ${muteClass}" data-track="${track.id}" style="height:${trackHeight}px">
            <div class="track-label"><span class="track-label-text">${track.label}</span>${mgTestBtn}${muteButton}</div>
            <div class="track-content ${track.type}-track" data-track="${track.id}">`;

        // Audio clip on its current track - use actual audio duration, not totalDuration
        if (track.id === (state.audioClipTrack || 'audio-track') && state.audioFile && state.totalDuration > 0) {
            const audioLeft = (state.audioClipOffset || 0) * state.timeline.zoom;
            const actualAudioDur = (elements.previewAudio && isFinite(elements.previewAudio.duration)) ? elements.previewAudio.duration : state.totalDuration;
            const w = actualAudioDur * state.timeline.zoom;
            // Generate pseudo-waveform bars
            let waveHtml = '<div class="audio-waveform-bars">';
            const barCount = Math.min(Math.floor(w / 3), 500);
            for (let b = 0; b < barCount; b++) { waveHtml += `<div class="waveform-bar" style="height:${20 + Math.random() * 60}%"></div>`; }
            waveHtml += '</div>';
            const safeAudioName = escapeHTML(String(state.audioFile.name || 'Audio'));
            html += `<div class="timeline-clip audio-clip" data-audio-clip="voice" data-track="audio-track" style="left:${audioLeft}px;width:${w}px" title="${safeAudioName}">
                ${waveHtml}
                <span class="clip-label">${safeAudioName}</span>
                <button class="audio-clip-delete" title="Remove audio">✕</button>
            </div>`;
        }

        // Motion Graphics clips on mg-track (per-type colors) — listicle types go to listicle-track
        if ((track.id === 'mg-track' || track.id === 'listicle-track') && state.motionGraphics.length > 0) {
            const mgMeta = {
                headline: { icon: 'H', colorClass: 'mg-headline' },
                lowerThird: { icon: 'L3', colorClass: 'mg-lowerthird' },
                statCounter: { icon: '#', colorClass: 'mg-stat' },
                callout: { icon: '"', colorClass: 'mg-callout' },
                bulletList: { icon: '::', colorClass: 'mg-bullets' },
                focusWord: { icon: 'F', colorClass: 'mg-focusword' },
                progressBar: { icon: '%', colorClass: 'mg-progressbar' },
                barChart: { icon: 'BC', colorClass: 'mg-barchart' },
                donutChart: { icon: 'DC', colorClass: 'mg-donutchart' },
                comparisonCard: { icon: 'VS', colorClass: 'mg-comparison' },
                timeline: { icon: 'TL', colorClass: 'mg-timeline-clip' },
                rankingList: { icon: 'RK', colorClass: 'mg-ranking' },
                kineticText: { icon: 'KT', colorClass: 'mg-kinetic' },
                listicleCounter: { icon: '#1', colorClass: 'mg-listicle-counter' },
                progressTracker: { icon: '•••', colorClass: 'mg-listicle-tracker' },
                listicleGrid: { icon: '▦', colorClass: 'mg-listicle-grid' },
            };
            const isListicleTrack = track.id === 'listicle-track';
            state.motionGraphics.forEach((mg, i) => {
                const isListicleMG = LISTICLE_TYPES.has(mg.type);
                // Only render listicle MGs on listicle-track, others on mg-track
                if (isListicleTrack !== isListicleMG) return;

                const left = mg.startTime * state.timeline.zoom;
                const w = mg.duration * state.timeline.zoom;
                const meta = mgMeta[mg.type] || { icon: '?', colorClass: '' };
                const isDisabled = mg.disabled === true;
                const isSelected = state.selectedMgIndex === i;
                const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
                const clampedW = Math.max(w, 20);
                html += `<div class="timeline-clip mg-clip ${meta.colorClass} ${isDisabled ? 'clip-disabled' : ''} ${isSelected ? 'selected' : ''}" data-mg-index="${i}"
                    style="left:${left}px;width:${clampedW}px"
                    title="${escapeHTML(mg.type)}: ${escapeHTML(mg.text)} [${mg.startTime.toFixed(2)}s → ${(mg.startTime + mg.duration).toFixed(2)}s] (${mg.duration.toFixed(2)}s)${isDisabled ? ' [OFF]' : ''}">
                    <span class="clip-label">${meta.icon}</span>
                    <button class="clip-toggle-btn" data-toggle-mg="${i}" title="${isDisabled ? 'Enable' : 'Disable'} graphic">${eyeIcon}</button>
                </div>`;
            });
        }

        // SFX clips on sfx-track
        if (track.id === 'sfx-track' && state.sfxClips.length > 0) {
            state.sfxClips.forEach((sfx, i) => {
                const left = sfx.startTime * state.timeline.zoom;
                const w = sfx.duration * state.timeline.zoom;
                const icon = state.transition.metadata[sfx.transitionType]?.icon || '🔊';
                const cueName = sfx.transitionType || sfx.role || String(sfx.file || 'sound effect').replace(/^sfx-|\.(mp3|wav|ogg|m4a)$/gi, '');
                html += `<div class="timeline-clip sfx-clip" data-sfx-index="${i}"
                    style="left:${left}px;width:${Math.max(w, 8)}px"
                    title="SFX: ${escapeHTML(cueName)} (${sfx.duration.toFixed(2)}s)">
                    <span class="clip-label">${icon}</span>
                </div>`;
            });
        }

        // Derived continuity clips make intentional previous-frame holds visible
        // in the editor. They are non-destructive and are recomputed from the
        // current base-track scene timing instead of mutating downloaded media.
        if (track.id === 'video-track-1') {
            continuityHolds.forEach((hold) => {
                const left = Number(hold.startTime || 0) * state.timeline.zoom;
                const width = Math.max(
                    Number(hold.endTime || 0) - Number(hold.startTime || 0),
                    0
                ) * state.timeline.zoom;
                const sourceLabel = hold.sourceSceneIndex != null
                    ? `scene ${hold.sourceSceneIndex}`
                    : 'previous scene';
                html += `<div class="timeline-clip clip-continuity-hold"
                    data-continuity-hold="${escapeHTML(String(hold.clipId || 'hold'))}"
                    style="left:${left}px;width:${Math.max(width, 8)}px"
                    title="Continuity hold from ${escapeHTML(sourceLabel)} [${Number(hold.startTime || 0).toFixed(2)}s → ${Number(hold.endTime || 0).toFixed(2)}s]">
                    <span class="clip-label">HOLD</span>
                </div>`;
            });
        }

        // Scene clips on this track
        const trackScenes = state.scenes.filter(s => (s.trackId || 'video-track-1') === track.id);
        let overlayLaneIndex = 0; // Track overlay lane for vertical stacking
        trackScenes.forEach((scene, i) => {
            const idx = state.scenes.indexOf(scene);
            const left = scene.startTime * state.timeline.zoom;
            const width = (scene.endTime - scene.startTime) * state.timeline.zoom;

            // Full-screen MG scene on V3
            if (scene.isMGScene) {
                const mgMeta = {
                    barChart: { name: 'Bar Chart', colorClass: 'mg-barchart' },
                    donutChart: { name: 'Donut Chart', colorClass: 'mg-donutchart' },
                    comparisonCard: { name: 'Comparison', colorClass: 'mg-comparison' },
                    timeline: { name: 'Timeline', colorClass: 'mg-timeline-clip' },
                    rankingList: { name: 'Ranking', colorClass: 'mg-ranking' },
                    bulletList: { name: 'Bullet List', colorClass: 'mg-bullets' },
                    mapChart: { name: 'Map', colorClass: 'mg-mapchart' },
                    articleHighlight: { name: 'Article', colorClass: 'mg-article' },
                };
                const meta = mgMeta[scene.type] || { name: scene.type || 'MG', colorClass: '' };
                const clipName = scene.text ? `${meta.name}: ${scene.text}` : meta.name;
                const safeClipName = escapeHTML(clipName);
                const isDisabled = scene.disabled === true;
                const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
                html += `<div class="timeline-clip clip-mg-scene ${meta.colorClass} ${isDisabled ? 'clip-disabled' : ''} ${state.selectedClipIndices.includes(idx) ? 'selected' : ''}"
                    data-index="${idx}" style="left:${left}px;width:${width}px"
                    title="${safeClipName} [${scene.startTime.toFixed(2)}s → ${scene.endTime.toFixed(2)}s] (${(scene.endTime - scene.startTime).toFixed(2)}s)${isDisabled ? ' [OFF]' : ''}">
                    <div class="clip-trim-handle clip-trim-handle-left" data-index="${idx}" data-edge="left"></div>
                    <span class="clip-label">${safeClipName}</span>
                    <button class="clip-toggle-btn" data-toggle-idx="${idx}" title="${isDisabled ? 'Enable' : 'Disable'} graphic">${eyeIcon}</button>
                    <div class="clip-trim-handle clip-trim-handle-right" data-index="${idx}" data-edge="right"></div>
                </div>`;
                return;
            }

            const isOverlayDirective = scene._compositorDirective;
            const mediaClass = isOverlayDirective ? 'clip-v2-overlay' : (scene.mediaType === 'image' ? 'clip-image' : 'clip-video');
            const isDisabled = scene.disabled === true;
            const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
            // Transition icon between clips (per-scene override > global force > AI-assigned)
            const trType = scene.transitionType || (state.transition.style !== 'auto' ? state.transition.style : null) || scene.transition?.type || 'crossfade';
            const trIcons = { cut: '✂️', crossfade: '🔀', fade: '🔀', dissolve: '🔀', blur: '🔀', crossBlur: '🔀', luma: '🌗', morph: '🔀', dreamFade: '💭', ripple: '🌊', wipe: '↔️', slide: '↔️', push: '↔️', swipe: '↔️', splitWipe: '↔️', zoom: '🔎', zoomBlur: '🔎', whip: '💨', bounce: '⬆️', shutterSlice: '📷', flash: '⚡', directionalBlur: '💨', colorFade: '🎨', spin: '🌀', cameraFlash: '📸', filmBurn: '🎞️', filmGrain: '🎞️', flare: '✨', lightLeak: '✨', shadowWipe: '🌑', vignetteBlink: '👁️', reveal: '🔀', ink: '🖋️', prismShift: '🔮', glitch: '⚡', pixelate: '🟦', mosaic: '🟦', dataMosh: '⚡', scanline: '📺', rgbSplit: '🌈', static: '📺', fade_to_black: '⬛' };
            const trIcon = trIcons[trType] || '🔀';
            // Show transition marker between clips (skip first scene)
            if (i > 0 && trIcon) {
                const prevScene = trackScenes[i - 1];
                const transitionIndex = (state.transitions || []).findIndex((transition) => (
                    (
                        String(transition.fromClipId || '') === String(prevScene.clipId || '')
                        && String(transition.toClipId || '') === String(scene.clipId || '')
                    )
                    || (
                        !transition.fromClipId
                        && !transition.toClipId
                        && Math.abs((Number(transition.startTime ?? transition.at) || 0) - Number(scene.startTime || 0)) < 0.05
                    )
                ));
                const selectedClass = transitionIndex >= 0 && state.selectedTransitionIndex === transitionIndex
                    ? ' selected'
                    : '';
                html += `<div class="transition-marker${selectedClass}" data-transition-index="${transitionIndex}" style="left:${left - 8}px" title="${escapeHTML(trType)}">${trIcon}</div>`;
            }
            // Clip separator line for adjacent clips
            if (i > 0) {
                const prevScene = trackScenes[i - 1];
                if (Math.abs(prevScene.endTime - scene.startTime) < 0.05) {
                    html += `<div class="clip-separator" style="left:${left}px"></div>`;
                }
            }

            const clipText = String(scene.text || scene.keyword || '');
            const clipLabel = clipText.substring(0, 30) + (clipText.length > 30 ? '...' : '');
            html += `<div class="timeline-clip ${mediaClass} ${isDisabled ? 'clip-disabled' : ''} ${idx === state.currentSceneIndex ? 'active' : ''} ${state.selectedClipIndices.includes(idx) ? 'selected' : ''}"
                data-index="${idx}" style="left:${left}px;width:${width}px" title="${escapeHTML(clipText)}${isDisabled ? ' [OFF]' : ''}">
                <div class="clip-trim-handle clip-trim-handle-left" data-index="${idx}" data-edge="left"></div>
                <span class="clip-label">${escapeHTML(clipLabel)}</span>
                <button class="clip-toggle-btn" data-toggle-idx="${idx}" title="${isDisabled ? 'Enable' : 'Disable'} clip">${eyeIcon}</button>
                <div class="clip-trim-handle clip-trim-handle-right" data-index="${idx}" data-edge="right"></div>
            </div>`;
        });

        html += `</div></div>`;
        // Add resize handle between tracks (except after last track)
        if (trackIndex < state.timeline.tracks.length - 1) {
            html += `<div class="track-resize-handle" data-resize-track="${track.id}"></div>`;
        }
    });
    content.innerHTML = html;

    // Clip events
    document.querySelectorAll('.timeline-clip[data-index]').forEach(clip => {
        clip.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // only left-drag — right/middle click is for the context menu (no drag, no preview refresh)
            if (e.target.classList.contains('clip-toggle-btn')) return;
            startDragClip(e, clip);
        });
        clip.addEventListener('click', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return;
            e.stopPropagation();
            const idx = parseInt(clip.dataset.index);
            selectClip(idx, e.ctrlKey || e.metaKey);
            if (!e.ctrlKey && !e.metaKey) jumpToScene(idx);
        });
    });

    document.querySelectorAll('.transition-marker[data-transition-index]').forEach(marker => {
        marker.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = Number(marker.dataset.transitionIndex);
            if (!Number.isInteger(index) || index < 0 || !state.transitions[index]) return;
            state.selectedTransitionIndex = index;
            state.selectedClipIndices = [];
            state.selectedClipIndex = -1;
            state.selectedMgIndex = -1;
            const transition = state.transitions[index];
            seekToTime(Number(transition.startTime ?? transition.at) || state.currentTime);
            renderTimeline();
            notifyAgentContextChanged();
        });
    });

    // Trim handle events (must come before general clip drag)
    document.querySelectorAll('.clip-trim-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // left-drag only — don't start a trim on right-click
            e.stopPropagation();
            startTrimClip(e, handle);
        });
    });

    // Audio clip drag (horizontal only, locked to audio tracks)
    document.querySelectorAll('.timeline-clip[data-audio-clip]').forEach(audioClip => {
        audioClip.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('audio-clip-delete')) return; // Don't drag when clicking delete
            startDragAudioClip(e, audioClip);
        });
    });

    // Audio clip delete button
    document.querySelectorAll('.audio-clip-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Remove audio from project?')) {
                removeAudio();
                renderTimeline();
                showToast('Audio removed', 'info');
            }
        });
    });

    // Click empty track to seek (only if not marquee selecting)
    document.querySelectorAll('.track-content').forEach(tc => {
        tc.addEventListener('click', (e) => {
            if (e.target.classList.contains('track-content') && !state._marqueeUsed) {
                const rect = tc.getBoundingClientRect();
                const time = (e.clientX - rect.left + document.getElementById('timeline-scroll').scrollLeft) / state.timeline.zoom;
                seekToTime(Math.max(0, time));
            }
            state._marqueeUsed = false;
        });
    });

    // Track mute buttons
    document.querySelectorAll('.track-mute-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const trackId = btn.dataset.trackMute;
            state.mutedTracks[trackId] = !state.mutedTracks[trackId];
            const isMuted = state.mutedTracks[trackId];
            btn.textContent = isMuted ? '🔇' : '🔊';
            btn.classList.toggle('muted', isMuted);
            btn.title = (isMuted ? 'Unmute' : 'Mute') + ' track';
            btn.closest('.timeline-row').classList.toggle('track-muted', isMuted);
            applyTrackVolumes();
            // Sync MG track mute with MG enable flag
            if (trackId === 'mg-track') {
                state.mgEnabled = !isMuted;
                saveSettings();
            }
        });
    });

    // MG test inject button
    document.querySelectorAll('[data-action="inject-test-mg"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            injectTestMotionGraphics();
        });
    });

    // Per-clip toggle buttons (MG clips)
    document.querySelectorAll('.clip-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Overlay clip toggle
            if (btn.dataset.toggleIdx !== undefined) {
                const idx = parseInt(btn.dataset.toggleIdx);
                const scene = state.scenes[idx];
                if (scene) {
                    scene.disabled = !scene.disabled;
                    renderTracks();
                }
            }
            // MG clip toggle
            if (btn.dataset.toggleMg !== undefined) {
                const mgIdx = parseInt(btn.dataset.toggleMg);
                const mg = state.motionGraphics[mgIdx];
                if (mg) {
                    mg.disabled = !mg.disabled;
                    renderTracks();
                }
            }
        });
    });

    // MG clip click to select and show properties
    document.querySelectorAll('.mg-clip').forEach(clip => {
        clip.addEventListener('click', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return; // Don't select when toggling
            e.stopPropagation();
            const mgIdx = parseInt(clip.dataset.mgIndex);
            if (isNaN(mgIdx)) return;
            // Deselect any regular/overlay clip
            state.selectedClipIndex = -1;
            state.selectedClipIndices = [];
            clearSceneTransform();
            document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
            // Select this MG
            state.selectedMgIndex = mgIdx;
            state.selectedTransitionIndex = -1;
            document.querySelectorAll('.transition-marker.selected').forEach(c => c.classList.remove('selected'));
            document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
            clip.classList.add('selected');
            updateClipProperties();
            notifyAgentContextChanged();
        });
    });

    // Marquee drag-to-select on timeline
    setupMarqueeSelect();

    // Track resize handles
    setupTrackResize();

    // Async load thumbnails for video/image clips
    loadClipThumbnails();
}

// ========================================
// Track Resize
// ========================================
function setupTrackResize() {
    document.querySelectorAll('.track-resize-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const trackId = handle.dataset.resizeTrack;
            const startY = e.clientY;
            const startHeight = state.timeline.trackHeights[trackId] || 36;
            handle.classList.add('active');
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';

            const onMove = (me) => {
                const delta = me.clientY - startY;
                const min = state.timeline.trackMinHeights[trackId] || 18;
                const max = state.timeline.trackMaxHeights[trackId] || 120;
                const newHeight = Math.max(min, Math.min(max, startHeight + delta));
                state.timeline.trackHeights[trackId] = newHeight;
                const row = document.querySelector(`.timeline-row[data-track="${trackId}"]`);
                if (row) row.style.height = `${newHeight}px`;
            };

            const onUp = () => {
                handle.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

// ========================================
// Clip Thumbnails
// ========================================
const thumbnailCache = {};

// Poster generation is throttled so the first timeline render doesn't decode 100+ videos at once.
let _posterActive = 0;
const _posterQueue = [];
function _posterSlot() {
    if (_posterActive < 4) { _posterActive++; return Promise.resolve(); }
    return new Promise(res => _posterQueue.push(res)).then(() => { _posterActive++; });
}
function _posterRelease() {
    _posterActive = Math.max(0, _posterActive - 1);
    const next = _posterQueue.shift();
    if (next) next();
}

// Draw the first real frame of a video into a small JPEG data URL for a timeline clip background.
// CSS background-image can't render an .mp4, so video clips need a still poster like this — without
// it they show up as dark "empty" slots even though the footage is present and will render fine.
function generateVideoPoster(url) {
    return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.muted = true; v.preload = 'auto'; v.src = url;
        let settled = false;
        const finish = (val, err) => {
            if (settled) return; settled = true;
            try { v.removeAttribute('src'); v.load(); } catch (_) {}
            err ? reject(err) : resolve(val);
        };
        v.addEventListener('loadeddata', () => {
            try { v.currentTime = Math.min(0.5, (v.duration || 2) * 0.1); } catch (_) { finish(null, new Error('seek failed')); }
        });
        v.addEventListener('seeked', () => {
            try {
                const w = v.videoWidth || 160, h = v.videoHeight || 90;
                const scale = 160 / w;
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(w * scale));
                c.height = Math.max(1, Math.round(h * scale));
                c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                finish(c.toDataURL('image/jpeg', 0.6));
            } catch (e) { finish(null, e); }
        });
        v.addEventListener('error', () => finish(null, new Error('video load error')));
        setTimeout(() => finish(null, new Error('poster timeout')), 8000);
    });
}

async function loadClipThumbnails() {
    if (!window.electronAPI?.getSceneMediaPath) return;
    document.querySelectorAll('.timeline-clip[data-index]').forEach(async (clipEl) => {
        const idx = parseInt(clipEl.dataset.index);
        const scene = state.scenes[idx];
        if (!scene) return;

        // Check cache first
        if (thumbnailCache[idx] !== undefined) {
            if (thumbnailCache[idx] && clipEl.isConnected) {
                clipEl.style.backgroundImage = `url("${thumbnailCache[idx]}")`;
                clipEl.classList.add('has-thumbnail');
            }
            return;
        }

        try {
            // Try frame-{index}.jpg first (from vision analysis)
            const originalIdx = getSceneSourceIndex(scene, idx);
            let framePath = await window.electronAPI.getSceneMediaPath(originalIdx, '.jpg', 'frame');
            if (framePath) {
                const url = await window.electronAPI.getFileUrl(framePath);
                thumbnailCache[idx] = url;
                if (url && clipEl.isConnected) {
                    clipEl.style.backgroundImage = `url("${url}")`;
                    clipEl.classList.add('has-thumbnail');
                }
                return;
            }
            // Fallback: use the scene's ACTUAL resolved media. mediaFile is always set by the
            // build and points at the real file — including candidate-race names like
            // scene-30.race-3-xxxx.mp4 that a scene-{index}.{ext} lookup would miss. Images go
            // straight to the clip background; videos get a client-side poster frame (a raw .mp4
            // can't be a CSS background-image, which is why video clips looked like empty slots).
            if (scene.mediaFile) {
                const url = await window.electronAPI.getFileUrl(scene.mediaFile).catch(() => null);
                if (url && clipEl.isConnected) {
                    const ext = (String(scene.mediaFile).split('.').pop() || '').toLowerCase();
                    const isVideo = ['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext);
                    if (!isVideo) {
                        thumbnailCache[idx] = url;
                        clipEl.style.backgroundImage = `url("${url}")`;
                        clipEl.classList.add('has-thumbnail');
                        return;
                    }
                    await _posterSlot();
                    try {
                        const poster = await generateVideoPoster(url);
                        if (poster) {
                            thumbnailCache[idx] = poster;
                            if (clipEl.isConnected) {
                                clipEl.style.backgroundImage = `url("${poster}")`;
                                clipEl.classList.add('has-thumbnail');
                            }
                            return;
                        }
                    } catch (_) { /* fall through to null */ }
                    finally { _posterRelease(); }
                }
            }
            thumbnailCache[idx] = null;
        } catch (e) {
            thumbnailCache[idx] = null;
        }
    });
}

// ========================================
// Marquee Drag-to-Select (like Premiere Pro)
// ========================================
function setupMarqueeSelect() {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll) return;

    let marquee = document.getElementById('timeline-marquee');
    if (!marquee) {
        marquee = document.createElement('div');
        marquee.id = 'timeline-marquee';
        marquee.className = 'timeline-marquee';
        scroll.style.position = 'relative';
        scroll.appendChild(marquee);
    }

    let isMarquee = false;
    let startX = 0, startY = 0;

    scroll.addEventListener('mousedown', (e) => {
        // Only start marquee on left-click on empty area (not on a clip or handle)
        if (e.button !== 0) return;
        if (e.target.closest('.timeline-clip') || e.target.closest('.clip-trim-handle') || e.target.closest('.playhead') || e.target.closest('.transition-marker')) return;

        isMarquee = true;
        const scrollRect = scroll.getBoundingClientRect();
        startX = e.clientX - scrollRect.left + scroll.scrollLeft;
        startY = e.clientY - scrollRect.top + scroll.scrollTop;

        marquee.style.display = 'none';

        // Deselect if not holding Ctrl
        if (!e.ctrlKey && !e.metaKey) {
            deselectClip();
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!isMarquee) return;

        const scrollRect = scroll.getBoundingClientRect();
        const curX = e.clientX - scrollRect.left + scroll.scrollLeft;
        const curY = e.clientY - scrollRect.top + scroll.scrollTop;

        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        const width = Math.abs(curX - startX);
        const height = Math.abs(curY - startY);

        // Only show marquee if dragged more than 5px (avoid accidental selections)
        if (width > 5 || height > 5) {
            marquee.style.display = 'block';
            marquee.style.left = left + 'px';
            marquee.style.top = top + 'px';
            marquee.style.width = width + 'px';
            marquee.style.height = height + 'px';

            // Live highlight: check intersection with clips
            highlightClipsInMarquee(left, top, width, height, e.ctrlKey || e.metaKey);
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (!isMarquee) return;
        isMarquee = false;

        if (marquee.style.display === 'block') {
            state._marqueeUsed = true; // Prevent seek on this click
            marquee.style.display = 'none';
        }
    });
}

function highlightClipsInMarquee(mLeft, mTop, mWidth, mHeight, addToExisting) {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll) return;

    const scrollRect = scroll.getBoundingClientRect();
    const mRight = mLeft + mWidth;
    const mBottom = mTop + mHeight;

    const newSelection = addToExisting ? [...state.selectedClipIndices] : [];

    document.querySelectorAll('.timeline-clip[data-index]').forEach(clip => {
        const idx = parseInt(clip.dataset.index);
        // Use getBoundingClientRect relative to scroll container for accuracy
        const clipRect = clip.getBoundingClientRect();
        const clipLeft = clipRect.left - scrollRect.left + scroll.scrollLeft;
        const clipTop = clipRect.top - scrollRect.top + scroll.scrollTop;
        const clipRight = clipLeft + clipRect.width;
        const clipBottom = clipTop + clipRect.height;

        // Check overlap
        const overlaps = !(clipRight < mLeft || clipLeft > mRight || clipBottom < mTop || clipTop > mBottom);

        if (overlaps && !newSelection.includes(idx)) {
            newSelection.push(idx);
        }
    });

    // Update selection visually
    state.selectedClipIndices = newSelection;
    state.selectedClipIndex = newSelection.length > 0 ? newSelection[newSelection.length - 1] : -1;
    state.selectedMgIndex = -1;
    state.selectedTransitionIndex = -1;

    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => {
        const idx = parseInt(c.dataset.index);
        c.classList.toggle('selected', newSelection.includes(idx));
    });
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.transition-marker.selected').forEach(c => c.classList.remove('selected'));
    notifyAgentContextChanged();
}

// Logarithmic zoom slider: maps 0-1000 slider range to 0.5-200 px/s zoom
// This makes low zoom values (for long videos) easy to fine-tune
function sliderToZoom(sliderVal) {
    const minLog = Math.log(state.timeline.minZoom);
    const maxLog = Math.log(state.timeline.maxZoom);
    return Math.exp(minLog + (sliderVal / 1000) * (maxLog - minLog));
}

function zoomToSlider(zoom) {
    const minLog = Math.log(state.timeline.minZoom);
    const maxLog = Math.log(state.timeline.maxZoom);
    return Math.round(((Math.log(zoom) - minLog) / (maxLog - minLog)) * 1000);
}

function formatZoomLabel(zoom) {
    if (zoom >= 10) return `${Math.round(zoom)}px/s`;
    if (zoom >= 1) return `${zoom.toFixed(1)}px/s`;
    return `${zoom.toFixed(2)}px/s`;
}

function changeZoom(delta) {
    // Scale delta proportionally to current zoom for smooth feel
    const scaledDelta = delta * Math.max(0.1, state.timeline.zoom * 0.15);
    applyZoom(state.timeline.zoom + scaledDelta, true);
}

function zoomToFit() {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll || state.totalDuration <= 0) return;
    // Calculate zoom so entire duration fits in visible area (with some padding)
    const availableWidth = scroll.clientWidth - 40; // small padding
    const fitZoom = availableWidth / state.totalDuration;
    applyZoom(Math.max(state.timeline.minZoom, Math.min(state.timeline.maxZoom, fitZoom)), true);
    // Scroll to start
    requestAnimationFrame(() => { scroll.scrollLeft = 0; });
}

function applyZoom(newZoom, fullRerender = false) {
    const scroll = document.getElementById('timeline-scroll');
    const oldZoom = state.timeline.zoom;
    newZoom = Math.max(state.timeline.minZoom, Math.min(state.timeline.maxZoom, newZoom));
    if (newZoom === oldZoom) return;

    // Keep playhead centered in viewport after zoom
    const playheadRatio = scroll ? ((state.currentTime * oldZoom - scroll.scrollLeft) / scroll.clientWidth) : 0.5;

    state.timeline.zoom = newZoom;

    if (fullRerender) {
        // Full re-render (from Ctrl+scroll or other non-slider sources)
        renderTimeline();
    } else {
        // Lightweight update - don't rebuild header (preserves slider drag state)
        const duration = Math.max(state.totalDuration, 60);
        const totalWidth = (duration * newZoom) + TRACK_HEADER_WIDTH + 500;

        const ruler = document.getElementById('timeline-ruler');
        const content = document.getElementById('timeline-content');
        if (ruler) { ruler.style.width = `${totalWidth}px`; renderRuler(duration); }
        if (content) { content.style.width = `${totalWidth}px`; }
        renderTracks();
        updatePlayhead();

        // Update zoom label and slider position
        const zoomLabel = document.getElementById('timeline-zoom');
        if (zoomLabel) zoomLabel.textContent = formatZoomLabel(newZoom);
        const slider = document.getElementById('zoom-slider');
        if (slider) slider.value = zoomToSlider(newZoom);
    }

    // Restore scroll so playhead stays at same viewport position
    const newScroll = document.getElementById('timeline-scroll');
    if (newScroll) {
        const newPlayheadAbsX = state.currentTime * newZoom;
        newScroll.scrollLeft = newPlayheadAbsX - playheadRatio * newScroll.clientWidth;
        state.timeline.scrollX = newScroll.scrollLeft;
        updatePlayhead();
    }
}

// ========================================
// PLAYHEAD - FIXED
// ========================================
function setupPlayhead() {
    const playhead = document.getElementById('playhead');
    playhead.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.timeline.isDraggingPlayhead = true;
        playhead.classList.add('dragging');
        document.body.style.cursor = 'ew-resize';

        const onMove = (me) => {
            const scroll = document.getElementById('timeline-scroll');
            const body = document.querySelector('.timeline-body');
            const rect = body.getBoundingClientRect();
            const x = me.clientX - rect.left - TRACK_HEADER_WIDTH + scroll.scrollLeft;
            const time = Math.max(0, x / state.timeline.zoom);
            state.currentTime = time;
            updatePlayhead();
            updateTimeDisplay();
            scrubMedia(time);
        };

        const onUp = () => {
            state.timeline.isDraggingPlayhead = false;
            playhead.classList.remove('dragging');
            document.body.style.cursor = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            seekToTime(state.currentTime);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function setupRulerClick() {
    document.getElementById('timeline-ruler')?.addEventListener('click', (e) => {
        const rect = e.target.closest('.timeline-ruler').getBoundingClientRect();
        const scroll = document.getElementById('timeline-scroll');
        const x = e.clientX - rect.left + scroll.scrollLeft;
        seekToTime(Math.max(0, x / state.timeline.zoom));
    });
}

// Cached DOM refs for per-frame functions (avoid getElementById every frame)
let _cachedPlayhead = null;
let _cachedTimelineScroll = null;
let _cachedTimelineTime = null;

// Reset cached timeline DOM refs before any innerHTML rebuild of the timeline —
// innerHTML destroys the old nodes, leaving these refs stale (a documented
// playhead-freeze bug). Single owner so every rebuild site resets identically.
function resetTimelineDomCache() {
    _cachedPlayhead = null;
    _cachedTimelineScroll = null;
    _cachedTimelineTime = null;
}

function updatePlayhead() {
    if (!_cachedPlayhead) _cachedPlayhead = document.getElementById('playhead');
    if (!_cachedTimelineScroll) _cachedTimelineScroll = document.getElementById('timeline-scroll');
    if (!_cachedPlayhead || !_cachedTimelineScroll) return;

    // Calculate position relative to viewport
    const absoluteX = TRACK_HEADER_WIDTH + (state.currentTime * state.timeline.zoom);
    const visibleX = absoluteX - _cachedTimelineScroll.scrollLeft;

    _cachedPlayhead.style.left = `${visibleX}px`;
    _cachedPlayhead.style.display = visibleX < TRACK_HEADER_WIDTH - 10 ? 'none' : 'block';
}

function updateTimeDisplay() {
    if (!_cachedTimelineTime) _cachedTimelineTime = document.getElementById('timeline-time');
    if (_cachedTimelineTime) _cachedTimelineTime.textContent = `${formatTime(state.currentTime, true)} / ${formatTime(state.totalDuration, true)}`;
}

async function scrubMedia(time) {
    const audio = elements.previewAudio;

    // Stop playback while scrubbing
    if (state.isPlaying) {
        stopPlayback();
    }

    // Update audio position
    if (audio?.src) {
        audio.currentTime = Math.min(time, audio.duration || state.totalDuration);
    }

    // Update state current time
    state.currentTime = time;

    // Load all active scenes at this time
    if (state.hyperframesPreview?.active) {
        syncHyperframesPreview(true);
    } else {
        await loadActiveScenes();
    }

    // Get active scenes for highlighting
    const activeScenes = getActiveScenesAtTime(time);
    updateSceneHighlight(activeScenes.length > 0 ? activeScenes[0].index : -1);
}

// ========================================
// Clip Dragging
// ========================================

// Get snap points from all clips except the one being dragged
function getSnapPoints(excludeIndex, trackId) {
    const points = [0]; // Always snap to start

    state.scenes.forEach((scene, i) => {
        if (i === excludeIndex) return;
        // Only snap to clips on same track or all tracks if holding shift
        if (scene.trackId === trackId || trackId === null) {
            points.push(scene.startTime);
            points.push(scene.endTime);
        }
    });

    // Add playhead position
    points.push(state.currentTime);

    // Add total duration
    points.push(state.totalDuration);

    return [...new Set(points)].sort((a, b) => a - b);
}

// Find nearest snap point
function findSnapPoint(time, clipDuration, excludeIndex, trackId) {
    if (!state.snapEnabled) return { start: time, snapped: false };

    const snapPoints = getSnapPoints(excludeIndex, trackId);
    const threshold = state.snapThreshold / state.timeline.zoom; // Convert pixels to time

    // Check snap for clip start
    for (const point of snapPoints) {
        if (Math.abs(time - point) < threshold) {
            return { start: point, snapped: true, snapTo: 'start' };
        }
    }

    // Check snap for clip end
    const clipEnd = time + clipDuration;
    for (const point of snapPoints) {
        if (Math.abs(clipEnd - point) < threshold) {
            return { start: point - clipDuration, snapped: true, snapTo: 'end' };
        }
    }

    return { start: time, snapped: false };
}

function startDragClip(e, clip) {
    e.stopPropagation();
    const idx = parseInt(clip.dataset.index);
    const scene = state.scenes[idx];
    const startX = e.clientX;
    const origTime = scene.startTime;
    const origTrackId = scene.trackId || 'video-track-1';
    const clipDuration = scene.endTime - scene.startTime;
    let moved = false;
    let undoPushed = false;
    let lastSnapped = false;
    clip.classList.add('dragging');

    // Create snap indicator line
    let snapLine = document.createElement('div');
    snapLine.className = 'snap-indicator';
    snapLine.style.display = 'none';
    document.querySelector('.timeline-body')?.appendChild(snapLine);

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;
        let newTime = Math.max(0, origTime + delta);

        // Apply snapping
        const snapResult = findSnapPoint(newTime, clipDuration, idx, scene.trackId);
        newTime = snapResult.start;

        // Show/hide snap indicator
        if (snapResult.snapped && !lastSnapped) {
            clip.classList.add('snapping');
            const snapX = (snapResult.snapTo === 'end' ? newTime + clipDuration : newTime) * state.timeline.zoom + TRACK_HEADER_WIDTH;
            snapLine.style.left = `${snapX - document.getElementById('timeline-scroll').scrollLeft}px`;
            snapLine.style.display = 'block';
        } else if (!snapResult.snapped && lastSnapped) {
            clip.classList.remove('snapping');
            snapLine.style.display = 'none';
        }
        lastSnapped = snapResult.snapped;

        clip.style.left = `${newTime * state.timeline.zoom}px`;
    };

    const onUp = (ue) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        clip.classList.remove('dragging');
        clip.classList.remove('snapping');
        snapLine.remove();

        if (!moved) return;

        const delta = (ue.clientX - startX) / state.timeline.zoom;
        let newTime = Math.max(0, origTime + delta);

        // Apply snapping on release
        const snapResult = findSnapPoint(newTime, clipDuration, idx, scene.trackId);
        newTime = Math.max(0, snapResult.start);

        scene.startTime = newTime;
        scene.endTime = newTime + clipDuration;

        // Only allow dropping on tracks of the same type (video->video, audio->audio)
        const target = document.elementsFromPoint(ue.clientX, ue.clientY).find(el => el.classList.contains('track-content'));
        if (target) {
            const targetTrackId = target.dataset.track;
            const sourceTrack = state.timeline.tracks.find(t => t.id === origTrackId);
            const targetTrack = state.timeline.tracks.find(t => t.id === targetTrackId);
            // Only switch track if types match
            if (sourceTrack && targetTrack && sourceTrack.type === targetTrack.type) {
                scene.trackId = targetTrackId;
            }
            // Otherwise keep original track
        }

        state.scenes.sort((a, b) => a.startTime - b.startTime);
        renderTimeline();
        // Refresh compositor with updated scene timing/track assignments
        if (state.compositorActive) loadPlanIntoCompositor();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function startDragAudioClip(e, clip) {
    e.stopPropagation();
    const startX = e.clientX;
    const origOffset = state.audioClipOffset || 0;
    const origTrack = state.audioClipTrack || 'audio-track';
    let moved = false;
    let undoPushed = false;
    clip.classList.add('dragging');

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;
        const newOffset = Math.max(0, origOffset + delta);
        clip.style.left = `${newOffset * state.timeline.zoom}px`;
    };

    const onUp = (ue) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        clip.classList.remove('dragging');

        if (!moved) return;

        const delta = (ue.clientX - startX) / state.timeline.zoom;
        state.audioClipOffset = Math.max(0, origOffset + delta);

        // Only allow dropping on audio-type tracks
        const target = document.elementsFromPoint(ue.clientX, ue.clientY).find(el => el.classList.contains('track-content'));
        if (target) {
            const targetTrackId = target.dataset.track;
            const targetTrack = state.timeline.tracks.find(t => t.id === targetTrackId);
            if (targetTrack && targetTrack.type === 'audio') {
                state.audioClipTrack = targetTrackId;
            }
        }

        renderTimeline();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ========================================
// Clip Edge Trimming
// ========================================
function startTrimClip(e, handle) {
    e.preventDefault();
    const idx = parseInt(handle.dataset.index);
    const edge = handle.dataset.edge; // 'left' or 'right'
    const scene = state.scenes[idx];
    if (!scene) return;

    const startX = e.clientX;
    const origStartTime = scene.startTime;
    const origEndTime = scene.endTime;
    const origMediaOffset = scene.mediaOffset || 0;
    const minDuration = 0.2; // minimum clip duration in seconds
    let moved = false;
    let undoPushed = false;

    const clipEl = handle.closest('.timeline-clip');
    if (clipEl) clipEl.classList.add('trimming');
    document.body.style.cursor = edge === 'left' ? 'w-resize' : 'e-resize';

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;

        if (edge === 'left') {
            // Trimming left edge: move startTime, adjust mediaOffset
            let newStart = Math.max(0, origStartTime + delta);
            // Enforce minimum duration
            if (origEndTime - newStart < minDuration) newStart = origEndTime - minDuration;
            // Can't go before original media start (mediaOffset can't go negative)
            const mediaOffsetDelta = newStart - origStartTime;
            if (origMediaOffset + mediaOffsetDelta < 0) newStart = origStartTime - origMediaOffset;

            scene.startTime = newStart;
            scene.mediaOffset = origMediaOffset + (newStart - origStartTime);

            // Update clip element live
            if (clipEl) {
                clipEl.style.left = `${newStart * state.timeline.zoom}px`;
                clipEl.style.width = `${(scene.endTime - newStart) * state.timeline.zoom}px`;
            }
        } else {
            // Trimming right edge: just move endTime
            let newEnd = origEndTime + delta;
            // Enforce minimum duration
            if (newEnd - origStartTime < minDuration) newEnd = origStartTime + minDuration;
            // Don't allow negative or zero
            newEnd = Math.max(origStartTime + minDuration, newEnd);

            scene.endTime = newEnd;

            // Update clip element live
            if (clipEl) {
                clipEl.style.width = `${(newEnd - origStartTime) * state.timeline.zoom}px`;
            }
        }
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        if (clipEl) clipEl.classList.remove('trimming');

        if (!moved) return;

        state.scenes.sort((a, b) => a.startTime - b.startTime);
        recalcTotalDuration();
        renderTimeline();
        // Refresh compositor with updated scene timing
        if (state.compositorActive) loadPlanIntoCompositor();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ========================================
// Playback Control
// ========================================

// Helper to wait for video to be ready
function waitForVideoReady(video, timeout = 3000) {
    return new Promise((resolve) => {
        if (video.readyState >= 2) {
            resolve();
            return;
        }
        const timeoutId = setTimeout(() => {
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('loadeddata', onReady);
            resolve(); // Resolve anyway after timeout
        }, timeout);

        const onReady = () => {
            clearTimeout(timeoutId);
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('loadeddata', onReady);
            resolve();
        };

        video.addEventListener('canplay', onReady);
        video.addEventListener('loadeddata', onReady);
    });
}

// Clean up video event handlers
function cleanupVideoHandlers() {
    // Clean up handlers from all track videos (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.ontimeupdate = null;
            video.onended = null;
            video.onplay = null;
            video.onpause = null;
            video.onerror = null;
            video.onloadeddata = null;
        }
    });
}

async function jumpToScene(index) {
    if (index < 0 || index >= state.scenes.length) return;

    const wasPlaying = state.isPlaying;
    const audio = elements.previewAudio;
    const scene = state.scenes[index];

    // Stop current playback temporarily
    if (wasPlaying) {
        stopPlayback();
    }

    // Clean up old handlers
    cleanupVideoHandlers();

    state.currentTime = scene.startTime;

    // Update UI
    updateSceneHighlight(index);
    updatePlayhead();
    updateTimeDisplay();

    // Sync audio position
    if (audio?.src) {
        audio.currentTime = Math.min(scene.startTime, audio.duration || state.totalDuration);
    }

    // Load all active scenes at this time
    if (state.hyperframesPreview?.active) {
        syncHyperframesPreview(true);
    } else {
        await loadActiveScenes();
    }

    // Resume playback if we were playing
    if (wasPlaying) {
        startPlayback();
    }
}

async function seekToTime(time) {
    const wasPlaying = state.isPlaying;

    // Stop playback during seek
    if (wasPlaying) {
        stopPlayback();
    }

    state.currentTime = Math.max(0, time);

    // Clean up old handlers
    cleanupVideoHandlers();

    // Load all active scenes at this time
    if (state.hyperframesPreview?.active) {
        syncHyperframesPreview(true);
    } else if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
        // WebGL2 compositor: just render the frame
        state.compositor.renderAtTime(state.currentTime);
    } else {
        await loadActiveScenes();
    }

    // Sync audio
    const audio = elements.previewAudio;
    if (audio?.src) {
        audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
    }

    // Get active scenes for highlighting
    const activeScenes = getActiveScenesAtTime(state.currentTime);
    updateSceneHighlight(activeScenes.length > 0 ? activeScenes[0].index : -1);
    updatePlayhead();
    updateTimeDisplay();
    if (!state.compositorActive && !state.hyperframesPreview?.active) updateMGOverlay();

    // Resume if was playing and within content
    if (wasPlaying && activeScenes.length > 0) {
        startPlayback();
    }
    notifyAgentContextChanged();
}

function getSceneAtTime(time) {
    for (let i = state.scenes.length - 1; i >= 0; i--) {
        if (time >= state.scenes[i].startTime && time < state.scenes[i].endTime) return i;
    }
    // Allow sitting exactly at the end of the last scene
    if (state.scenes.length > 0) {
        const last = state.scenes[state.scenes.length - 1];
        if (Math.abs(time - last.endTime) < 0.05) return state.scenes.length - 1;
    }
    return -1;
}

/**
 * Compute Ken Burns start/end transform values for native export.
 * Returns { sStart, sEnd, txStart, txEnd, tyStart, tyEnd } in native units
 * (scale as factor, translate as pixels).
 */
function computeKenBurnsForExport(scene, rtW, rtH) {
    const none = { sStart: 1, sEnd: 1, txStart: 0, txEnd: 0, tyStart: 0, tyEnd: 0 };
    if (scene.kenBurnsEnabled === false) return none;

    const originalIndex = getSceneSourceIndex(scene, 0);
    const kbTypes = [
        'zoomIn', 'zoomOut',
        'panLeft', 'panRight', 'panUp', 'panDown',
        'zoomPanRight', 'zoomPanLeft',
        'zoomOutPanRight', 'zoomOutPanLeft',
        'driftTopLeftToBottomRight', 'driftBottomRightToTopLeft',
        'driftTopRightToBottomLeft', 'driftBottomLeftToTopRight',
    ];
    const kbType = kbTypes[(originalIndex * 13 + 7) % kbTypes.length];
    const gentle = scene.fitMode === 'contain';
    const s = gentle ? 0.4 : 1;

    // Helper: evaluate Ken Burns at progress p (0=start, 1=end)
    // Returns { scale, txPct, tyPct } where tx/ty are in % of RT size
    function evalKB(p) {
        let scale = 1, txPct = 0, tyPct = 0;
        switch (kbType) {
            case 'zoomIn':    scale = 1 + (0.03 + p * 0.12) * s; break;
            case 'zoomOut':   scale = 1 + (0.15 - p * 0.12) * s; break;
            case 'panLeft':   scale = 1 + 0.12 * s; txPct = (3 - p * 6) * s; break;
            case 'panRight':  scale = 1 + 0.12 * s; txPct = (-3 + p * 6) * s; break;
            case 'panUp':     scale = 1 + 0.12 * s; tyPct = (3 - p * 6) * s; break;
            case 'panDown':   scale = 1 + 0.12 * s; tyPct = (-3 + p * 6) * s; break;
            case 'zoomPanRight':    scale = 1 + (0.05 + p * 0.1) * s; txPct = (-2 + p * 4) * s; break;
            case 'zoomPanLeft':     scale = 1 + (0.05 + p * 0.1) * s; txPct = (2 - p * 4) * s; break;
            case 'zoomOutPanRight': scale = 1 + (0.15 - p * 0.08) * s; txPct = (-2 + p * 4) * s; break;
            case 'zoomOutPanLeft':  scale = 1 + (0.15 - p * 0.08) * s; txPct = (2 - p * 4) * s; break;
            case 'driftTopLeftToBottomRight':  scale = 1 + 0.15 * s; txPct = (-2 + p * 4) * s; tyPct = (-2 + p * 4) * s; break;
            case 'driftBottomRightToTopLeft':  scale = 1 + 0.15 * s; txPct = (2 - p * 4) * s; tyPct = (2 - p * 4) * s; break;
            case 'driftTopRightToBottomLeft':  scale = 1 + 0.15 * s; txPct = (2 - p * 4) * s; tyPct = (-2 + p * 4) * s; break;
            case 'driftBottomLeftToTopRight':  scale = 1 + 0.15 * s; txPct = (-2 + p * 4) * s; tyPct = (2 - p * 4) * s; break;
        }
        return { scale, txPct, tyPct };
    }

    const kbSpeed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
    const start = evalKB(0);
    const end = evalKB(Math.min(1, kbSpeed));
    // Convert translate from % of RT to pixels
    return {
        sStart: start.scale,
        sEnd: end.scale,
        txStart: start.txPct / 100 * rtW,
        txEnd: end.txPct / 100 * rtW,
        tyStart: start.tyPct / 100 * rtH,
        tyEnd: end.tyPct / 100 * rtH,
    };
}

/**
 * Update Ken Burns transform on an image element based on current time
 */
function updateKenBurnsTransform(img, scene) {
    // If Ken Burns disabled for this scene, just apply scene transform
    if (scene.kenBurnsEnabled === false) {
        const sceneScale = scene.scale !== undefined ? scene.scale : 1;
        const scenePosX = scene.posX || 0;
        const scenePosY = scene.posY || 0;
        img.style.transform = `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})`;
        img.style.transformOrigin = 'center center';
        // Crop on img, radius on wrapper
        applyCrop(img, scene);
        const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
        const wr = elements[`trackWrapper${tn}`];
        if (wr) { applyRadius(wr, scene); wr.style.clipPath = ''; }
        return;
    }
    const originalIndex = getSceneSourceIndex(scene, 0);
    const kbTypes = [
        'zoomIn', 'zoomOut',
        'panLeft', 'panRight', 'panUp', 'panDown',
        'zoomPanRight', 'zoomPanLeft',
        'zoomOutPanRight', 'zoomOutPanLeft',
        'driftTopLeftToBottomRight', 'driftBottomRightToTopLeft',
        'driftTopRightToBottomLeft', 'driftBottomLeftToTopRight',
    ];
    const kbType = kbTypes[(originalIndex * 13 + 7) % kbTypes.length];
    const sceneDur = scene.endTime - scene.startTime;
    const kbSpeed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
    // Linear motion scaled by speed — higher speed = faster animation
    const rawP = sceneDur > 0 ? Math.max(0, Math.min(1, (state.currentTime - scene.startTime) / sceneDur)) : 0;
    const p = Math.min(1, rawP * kbSpeed);
    // Gentle Ken Burns for contain mode (charts, infographics stay mostly visible)
    const gentle = scene.fitMode === 'contain';
    const s = gentle ? 0.4 : 1; // scale factor for gentle mode
    let kbTransform = '';
    switch (kbType) {
        case 'zoomIn': kbTransform = `scale(${1 + (0.03 + p * 0.12) * s})`; break;
        case 'zoomOut': kbTransform = `scale(${1 + (0.15 - p * 0.12) * s})`; break;
        case 'panLeft': kbTransform = `scale(${1 + 0.12 * s}) translateX(${(3 - p * 6) * s}%)`; break;
        case 'panRight': kbTransform = `scale(${1 + 0.12 * s}) translateX(${(-3 + p * 6) * s}%)`; break;
        case 'panUp': kbTransform = `scale(${1 + 0.12 * s}) translateY(${(3 - p * 6) * s}%)`; break;
        case 'panDown': kbTransform = `scale(${1 + 0.12 * s}) translateY(${(-3 + p * 6) * s}%)`; break;
        case 'zoomPanRight': kbTransform = `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(-2 + p * 4) * s}%)`; break;
        case 'zoomPanLeft': kbTransform = `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(2 - p * 4) * s}%)`; break;
        case 'zoomOutPanRight': kbTransform = `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(-2 + p * 4) * s}%)`; break;
        case 'zoomOutPanLeft': kbTransform = `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(2 - p * 4) * s}%)`; break;
        case 'driftTopLeftToBottomRight': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)`; break;
        case 'driftBottomRightToTopLeft': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(2 - p * 4) * s}%)`; break;
        case 'driftTopRightToBottomLeft': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)`; break;
        case 'driftBottomLeftToTopRight': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(2 - p * 4) * s}%)`; break;
    }
    // Combine Ken Burns with scene scale/position
    const sceneScale = scene.scale !== undefined ? scene.scale : 1;
    const scenePosX = scene.posX || 0;
    const scenePosY = scene.posY || 0;
    const sceneTransform = `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})`;
    img.style.transform = kbTransform ? `${sceneTransform} ${kbTransform}` : sceneTransform;
    img.style.transformOrigin = 'center center';
    // Crop on img, radius on wrapper
    applyCrop(img, scene);
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const wrapper = elements[`trackWrapper${trackNum}`];
    if (wrapper) { applyRadius(wrapper, scene); wrapper.style.clipPath = ''; }
}

/**
 * Apply crop (clip-path) and border-radius to an element
 */
/**
 * Apply crop (clip-path) to a media element (video/img).
 * Crop is on the media so scaling can push cropped edges out of view.
 */
function applyCrop(el, scene) {
    const cropTop = scene.cropTop || 0;
    const cropRight = scene.cropRight || 0;
    const cropBottom = scene.cropBottom || 0;
    const cropLeft = scene.cropLeft || 0;
    if (cropTop || cropRight || cropBottom || cropLeft) {
        el.style.clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`;
    } else {
        el.style.clipPath = '';
    }
}

/**
 * Apply border-radius to a wrapper element.
 * Radius is on the wrapper so it clips the entire content area cleanly.
 */
function applyRadius(el, scene) {
    const borderRadius = scene.borderRadius || 0;
    if (borderRadius) {
        el.style.borderRadius = `${borderRadius}%`;
        el.style.overflow = 'hidden';
    } else {
        el.style.borderRadius = '';
        el.style.overflow = '';
    }
}

/**
 * Get cached media URL for a scene (avoids repeated IPC calls)
 */
async function getCachedMediaUrl(sceneIndex, mediaExtension, type) {
    const cacheKey = `${sceneIndex}:${mediaExtension || ''}:${type || 'scene'}`;
    if (state._mediaUrlCache[cacheKey]) return state._mediaUrlCache[cacheKey];

    let mediaPath;
    if (type === 'overlay') {
        mediaPath = await window.electronAPI.getSceneMediaPath(sceneIndex, mediaExtension || '.mp4', 'overlay');
    } else {
        mediaPath = await window.electronAPI.getSceneMediaPath(sceneIndex, mediaExtension);
    }
    if (!mediaPath) {
        console.warn(`[MediaCache] No path for scene ${sceneIndex} ext=${mediaExtension} type=${type || 'scene'}`);
        return null;
    }
    let mediaUrl = await window.electronAPI.getFileUrl(mediaPath);
    // Cache-bust: if this scene was retried, its file changed at the SAME path, so append a
    // version token to force the browser/compositor to re-fetch instead of serving the
    // cached old texture. The asset:// handler strips this query before reading the file.
    const ver = state._assetVersions?.[sceneIndex];
    if (mediaUrl && ver) {
        mediaUrl += (mediaUrl.includes('?') ? '&' : '?') + 'cb=' + ver;
    }
    if (mediaUrl) {
        state._mediaUrlCache[cacheKey] = mediaUrl;
    } else {
        console.warn(`[MediaCache] No URL for path: ${mediaPath}`);
    }
    return mediaUrl;
}

/**
 * Pre-buffer the NEXT video clip into each track's buffer element.
 * This ensures instant swap when the scene changes during playback.
 * URLs are pre-cached at plan load time; this loads the actual video data.
 */
function preloadUpcomingScenes(currentTime, force) {
    // Throttle: only check every 250ms (or immediately if forced)
    const now = performance.now();
    if (!force && now - state._lastPreloadCheck < 250) return;
    state._lastPreloadCheck = now;

    for (const tn of ['1', '2', '3']) {
        const trackId = `video-track-${tn}`;
        const { buffer } = getTrackVideoPair(tn);
        if (!buffer) continue;
        // Skip if this track has a swap pending (buffer is in use)
        if (state._trackSwapPending[tn]) continue;

        // Find the next video scene on this track (starts after current time, within 15s)
        const nextScene = state.scenes.find(s =>
            s.trackId === trackId &&
            !s.isMGScene && !s.disabled &&
            s.mediaType !== 'image' &&
            s.startTime > currentTime &&
            s.startTime - currentTime < 15
        );
        if (!nextScene) continue;

        const idx = getSceneSourceIndex(nextScene, state.scenes.indexOf(nextScene));
        const cacheKey = `${idx}:${nextScene.mediaExtension || ''}:scene`;
        const url = state._mediaUrlCache[cacheKey];

        if (url && buffer._loadedUrl !== url) {
            console.log(`[PreBuffer] Preloading scene ${idx} into track ${tn} buffer`);
            buffer.src = url;
            buffer._loadedUrl = url;
            buffer.load();
        }
    }
}

/**
 * Load all scenes that are active at the current time across all tracks
 */
async function loadActiveScenes(activeScenes) {
    // When compositor is active, it handles all rendering — skip HTML scene loading
    if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
        return;
    }
    // Use passed-in activeScenes to avoid duplicate getActiveScenesAtTime call
    if (!activeScenes) activeScenes = getActiveScenesAtTime(state.currentTime);
    const hasActiveBaseScene = activeScenes.some(({ scene }) => (
        scene
        && !scene.isMGScene
        && !scene.disabled
        && (scene.trackId || 'video-track-1') === 'video-track-1'
    ));
    if (!hasActiveBaseScene && timelineContract?.buildContinuityHolds) {
        const holds = timelineContract.buildContinuityHolds(
            state.scenes.filter((scene) => !scene?.isMGScene),
            {
                fps: state.videoPlan?.fps || state.fps || 30,
                totalDuration: state.totalDuration,
            }
        );
        const hold = holds.find((item) => (
            state.currentTime >= Number(item.startTime || 0) - 0.001
            && state.currentTime < Number(item.endTime || 0) + 0.001
        ));
        if (hold) {
            const sourceIndex = state.scenes.findIndex((scene) => (
                !scene?.isMGScene
                && (
                    String(scene.clipId || '') === String(hold.sourceClipId || '')
                    || (
                        !hold.sourceClipId
                        && String(getSceneSourceIndex(scene)) === String(hold.sourceSceneIndex)
                    )
                )
            ));
            if (sourceIndex >= 0) {
                const source = state.scenes[sourceIndex];
                activeScenes = [
                    ...activeScenes,
                    {
                        index: sourceIndex,
                        scene: {
                            ...source,
                            startTime: hold.startTime,
                            endTime: hold.endTime,
                            duration: hold.duration,
                            mediaOffset: hold.freezeTime,
                            _continuityHold: true,
                        },
                    },
                ];
            }
        }
    }

    if (activeScenes.length === 0) {
        if (state.scenes.length === 0) {
            if (elements.videoContainer) {
                elements.videoContainer.classList.add('hidden');
            }
            if (elements.videoControls) {
                elements.videoControls.classList.add('hidden');
            }
            if (elements.previewPlaceholder) {
                elements.previewPlaceholder.classList.remove('hidden');
            }
        } else {
            // Keep the existing frame/track state through gaps so templates do not pre-roll over black.
            if (elements.previewPlaceholder) {
                elements.previewPlaceholder.classList.add('hidden');
            }
            if (elements.videoContainer) {
                elements.videoContainer.classList.remove('hidden');
            }
            if (elements.videoControls) {
                elements.videoControls.classList.remove('hidden');
            }
        }
        return;
    }

    // Determine which tracks have active scenes
    const activeTracks = new Set();
    activeScenes.forEach(({ scene }) => {
        if (!scene.isMGScene && !scene.disabled) {
            const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            activeTracks.add(tn);
        }
    });

    // Apply blur to base video track when any upper-track overlay has bgBlur enabled
    const upperBlurScene = activeScenes.find(({ scene }) => {
        const tn = parseInt(scene.trackId?.match(/\d+/)?.[0] || '1', 10);
        return tn > 1 && !scene.disabled && scene.bgBlur && scene.bgBlur !== 'none';
    });
    const blurLevel = upperBlurScene?.scene?.bgBlur || 'none';
    const blurMap = { none: '', light: 'blur(3px)', medium: 'blur(6px)', heavy: 'blur(10px)' };
    const blurFilter = blurMap[blurLevel] || '';
    const t1Video = elements.videoTrack1;
    const t1VideoB = elements.videoTrack1B;
    const t1Img = elements.imgTrack1;
    if (t1Video) t1Video.style.filter = blurFilter;
    if (t1VideoB) t1VideoB.style.filter = blurFilter;
    if (t1Img) t1Img.style.filter = blurFilter;

    // Only hide tracks that are NOT active (avoids unnecessary DOM thrashing)
    ['1', '2', '3', '4', '5'].forEach(tn => {
        if (!activeTracks.has(tn)) {
            const videoA = elements[`videoTrack${tn}`];
            const videoB = elements[`videoTrack${tn}B`];
            const img = elements[`imgTrack${tn}`];
            if (videoA) videoA.classList.remove('active');
            if (videoB) videoB.classList.remove('active');
            if (img) {
                img.classList.remove('active');
                img.style.transform = '';
                img.style.objectFit = '';
            }
        }
    });
    // Hide background layer (will be re-shown if needed below)
    if (elements.bgVideo) elements.bgVideo.classList.remove('active');
    if (elements.bgImage) elements.bgImage.classList.remove('active');
    if (elements.bgGradient) elements.bgGradient.classList.remove('active');

    // Show video container
    elements.previewPlaceholder.classList.add('hidden');
    if (elements.videoContainer) {
        elements.videoContainer.classList.remove('hidden');
    }
    if (elements.videoControls) {
        elements.videoControls.classList.remove('hidden');
    }

    // Clear V3 MG preview layer if exists
    const mgV3Layer = document.getElementById('mg-v3-preview');
    if (mgV3Layer) {
        mgV3Layer.classList.remove('active');
        mgV3Layer.innerHTML = '';
    }

    // Load and show each active scene on its track (in parallel for speed)
    const sceneLoadPromises = [];
    for (const { scene, index } of activeScenes) {
        if (scene.disabled) continue; // Skip disabled clips

        // Full-screen MG scene on V3: render as HTML overlay (synchronous, no IPC)
        if (scene.isMGScene) {
            if (state.mutedTracks['video-track-3']) continue;
            const video3A = elements.videoTrack3;
            const video3B = elements.videoTrack3B;
            const img3 = elements.imgTrack3;
            if (video3A) video3A.classList.remove('active');
            if (video3B) video3B.classList.remove('active');
            if (img3) img3.classList.remove('active');

            const layer = document.getElementById('mg-v3-preview');
            if (layer) {
                layer.classList.add('active');
                const html = renderFullscreenMGPreview(scene);
                layer.innerHTML = html;
            }
            continue;
        }

        // Each scene loads in parallel (async IPC calls run concurrently)
        sceneLoadPromises.push((async () => {
            try {
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const img = elements[`imgTrack${trackNum}`];
                const isImage = scene.mediaType === 'image';

                const originalIndex = getSceneSourceIndex(scene, index);
                // V2 overlay scenes have mediaFile set directly — use it instead of index-based lookup
                let mediaUrl;
                if (scene.mediaFile) {
                    mediaUrl = await window.electronAPI.getFileUrl(scene.mediaFile);
                }
                if (!mediaUrl) {
                    mediaUrl = await getCachedMediaUrl(originalIndex, scene.mediaExtension);
                }
                if (!mediaUrl) {
                    console.warn(`[Preview] Scene ${index} (track ${trackNum}): no media URL found for index=${originalIndex} ext=${scene.mediaExtension}`);
                    return;
                }

                // Only log when source actually changes (avoid spamming console)
                const prevUrl = state._lastLoadedUrls && state._lastLoadedUrls[`t${trackNum}`];
                if (prevUrl !== mediaUrl) {
                    console.log(`[Preview] Loading scene ${index} on track ${trackNum}, isImage=${isImage}, url=${mediaUrl.substring(mediaUrl.lastIndexOf('/') + 1)}`);
                    if (!state._lastLoadedUrls) state._lastLoadedUrls = {};
                    state._lastLoadedUrls[`t${trackNum}`] = mediaUrl;
                }

                if (isImage && img) {
                    // IMAGE SCENE: show img, hide both video buffers for this track
                    const videoA = elements[`videoTrack${trackNum}`];
                    const videoB = elements[`videoTrack${trackNum}B`];
                    if (videoA) videoA.classList.remove('active');
                    if (videoB) videoB.classList.remove('active');
                    img.style.objectFit = scene.fitMode || 'cover';

                    const imgSourceChanging = img.src !== mediaUrl;

                    if (imgSourceChanging && img.src && state.isPlaying && !state.transition.isTransitioning) {
                        const transOutImg = elements.imgTransitionOut;
                        const container = elements.videoContainer;
                        if (transOutImg && container) {
                            transOutImg.style.zIndex = parseInt(trackNum) + 5;
                            img.classList.add('active');
                            performImageTransition(img, transOutImg, scene, mediaUrl);
                        }
                    } else {
                        if (imgSourceChanging) img.src = mediaUrl;
                        updateKenBurnsTransform(img, scene);
                        img.classList.add('active');
                    }
                } else {
                    // VIDEO SCENE: double-buffer swap for lag-free playback
                    if (img) img.classList.remove('active');

                    const { active: activeVid, buffer: bufferVid } = getTrackVideoPair(trackNum);
                    const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);

                    if (activeVid._loadedUrl === mediaUrl) {
                        // Same source already active — just sync time
                        if (Math.abs(activeVid.currentTime - sceneTime) > 0.15) {
                            activeVid.currentTime = sceneTime;
                        }
                        activeVid.volume = getSceneVolume(scene);
                        activeVid.muted = false;
                        activeVid.classList.add('active');
                        applySceneTransformToVideo(activeVid, scene);
                        if (state.isPlaying && activeVid.paused) {
                            activeVid.play().catch(() => { });
                        }
                    } else if (bufferVid._loadedUrl === mediaUrl && bufferVid.readyState >= 2) {
                        // Buffer has this source pre-loaded and ready
                        const transOut = elements.videoTransitionOut;
                        const shouldAnimate = state.isPlaying && !state.transition.isTransitioning
                            && activeVid._loadedUrl && transOut;

                        if (shouldAnimate) {
                            // Animated transition — load into dedicated transition-out element
                            // (browser cache serves it instantly since buffer already fetched it)
                            console.log(`[DoubleBuffer] Animated transition on track ${trackNum}`);
                            state._trackSwapPending[trackNum] = true;

                            transOut.src = mediaUrl;
                            transOut.load();
                            transOut.currentTime = sceneTime;
                            transOut.volume = getSceneVolume(scene);
                            transOut.muted = false;
                            transOut.style.zIndex = parseInt(trackNum) + 5;
                            applySceneTransformToVideo(transOut, scene);

                            // Fire-and-forget — performTrackTransition manages its own lifecycle
                            performTrackTransition(activeVid, transOut, originalIndex, mediaUrl, scene)
                                .then(() => {
                                    state._trackSwapPending[trackNum] = false;
                                    // After transition, activeVid has new source — update tracking
                                    activeVid._loadedUrl = mediaUrl;
                                    bufferVid._loadedUrl = null; // free buffer for next preload
                                }).catch(() => {
                                    state._trackSwapPending[trackNum] = false;
                                });
                        } else {
                            // Instant swap (not playing, already transitioning, or scrubbing)
                            console.log(`[DoubleBuffer] Instant swap on track ${trackNum}: buffer ready`);
                            activeVid.classList.remove('active');
                            activeVid.pause();

                            bufferVid.currentTime = sceneTime;
                            bufferVid.volume = getSceneVolume(scene);
                            bufferVid.muted = false;
                            bufferVid.classList.add('active');
                            applySceneTransformToVideo(bufferVid, scene);
                            if (state.isPlaying) bufferVid.play().catch(() => { });

                            swapTrackActive(trackNum);
                        }
                    } else if (!activeVid._loadedUrl) {
                        // First load on this track — load directly into active element
                        console.log(`[DoubleBuffer] First load on track ${trackNum}`);
                        activeVid.src = mediaUrl;
                        activeVid._loadedUrl = mediaUrl;
                        activeVid.load();
                        activeVid.currentTime = sceneTime;
                        activeVid.volume = getSceneVolume(scene);
                        activeVid.muted = false;
                        activeVid.classList.add('active');
                        applySceneTransformToVideo(activeVid, scene);
                        if (state.isPlaying && activeVid.paused) {
                            activeVid.play().catch(() => { });
                        }
                    } else {
                        // Fallback: NON-BLOCKING — old clip stays visible while buffer loads
                        // The swap happens asynchronously when buffer is ready (no await)
                        console.log(`[DoubleBuffer] Deferred swap on track ${trackNum} (buffer miss)`);
                        state._trackSwapPending[trackNum] = true;

                        // Only re-load if buffer doesn't already have this URL
                        if (bufferVid._loadedUrl !== mediaUrl) {
                            bufferVid.src = mediaUrl;
                            bufferVid._loadedUrl = mediaUrl;
                            bufferVid.load();
                        }

                        // Fire-and-forget: swap when buffer is ready
                        let swapped = false;
                        const doSwap = () => {
                            if (swapped) return;
                            swapped = true;
                            // Guard: if scene is no longer active (user seeked), skip stale swap
                            if (state.currentTime < scene.startTime || state.currentTime >= scene.endTime) {
                                state._trackSwapPending[trackNum] = false;
                                return;
                            }
                            // Use CURRENT time (not stale sceneTime from when load started)
                            const now = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
                            activeVid.classList.remove('active');
                            activeVid.pause();

                            bufferVid.currentTime = Math.max(0, now);
                            bufferVid.volume = getSceneVolume(scene);
                            bufferVid.muted = false;
                            bufferVid.classList.add('active');
                            applySceneTransformToVideo(bufferVid, scene);
                            if (state.isPlaying) bufferVid.play().catch(() => { });

                            swapTrackActive(trackNum);
                            state._trackSwapPending[trackNum] = false;
                        };
                        if (bufferVid.readyState >= 2) {
                            doSwap();
                        } else {
                            bufferVid.addEventListener('canplay', doSwap, { once: true });
                            setTimeout(doSwap, 300); // short timeout — old clip plays naturally meanwhile
                        }
                        // Don't await — loadActiveScenes returns immediately, old clip keeps playing
                    }
                }
            } catch (e) {
                console.error('[Preview] Failed to load scene media:', e);
            }
        })());
    }
    // Wait for all scene loads to complete in parallel
    if (sceneLoadPromises.length > 0) await Promise.all(sceneLoadPromises);

    // ===== Background layer rendering =====
    // Find primary visible scene (lowest track, non-overlay, non-MG) and show its background
    const primaryScene = activeScenes.find(s => !s.scene.isMGScene && !s.scene.disabled);
    if (primaryScene && primaryScene.scene.background && primaryScene.scene.background !== 'none') {
        const bgType = primaryScene.scene.background;
        const scene = primaryScene.scene;

        if (bgType === 'blur') {
            // Blur mode: duplicate the same video/image source behind it
            if (elements.bgGradient) elements.bgGradient.classList.remove('active');
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const activeVideo = getActiveTrackVideo(trackNum);
            const img = elements[`imgTrack${trackNum}`];
            const isImage = scene.mediaType === 'image';

            if (isImage && img && img.src) {
                // Blur background from image source
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgImage) {
                    if (elements.bgImage.src !== img.src) elements.bgImage.src = img.src;
                    elements.bgImage.style.filter = 'blur(25px)';
                    elements.bgImage.style.transform = 'scale(1.3)';
                    elements.bgImage.classList.add('active');
                }
            } else if (activeVideo && activeVideo.src) {
                // Blur background from video source
                // During playback, DEFER bgVideo.load() to avoid competing with buffer decode
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                if (elements.bgVideo) {
                    if (elements.bgVideo.src !== activeVideo.src) {
                        if (state.isPlaying) {
                            // Defer: just mark the URL, load lazily on next pause/seek
                            elements.bgVideo._pendingSrc = activeVideo.src;
                            elements.bgVideo.classList.add('active');
                        } else {
                            elements.bgVideo.src = activeVideo.src;
                            elements.bgVideo._pendingSrc = null;
                            elements.bgVideo.load();
                        }
                    }
                    if (elements.bgVideo.src && !elements.bgVideo._pendingSrc) {
                        elements.bgVideo.currentTime = activeVideo.currentTime;
                    }
                    elements.bgVideo.classList.add('active');
                    if (state.isPlaying && elements.bgVideo.paused && elements.bgVideo.src) elements.bgVideo.play().catch(() => { });
                }
            } else {
                // Fallback: blur source not yet loaded — show dark gradient instead of pure black
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgGradient) {
                    elements.bgGradient.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)';
                    elements.bgGradient.classList.add('active');
                }
            }
        } else if (bgType.startsWith('pattern:')) {
            // Pattern mode: show a background file from assets/backgrounds/
            if (elements.bgGradient) elements.bgGradient.classList.remove('active');
            const filename = bgType.replace('pattern:', '');
            const bg = state.availableBackgrounds.find(b => b.filename === filename);
            if (bg) {
                try {
                    const bgUrl = await window.electronAPI.getBackgroundUrl(filename);
                    if (bgUrl) {
                        const isImage = bg.mediaType === 'image';
                        if (isImage) {
                            if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                            if (elements.bgImage) {
                                if (elements.bgImage.src !== bgUrl) elements.bgImage.src = bgUrl;
                                elements.bgImage.style.filter = '';
                                elements.bgImage.style.transform = '';
                                elements.bgImage.classList.add('active');
                            }
                        } else {
                            if (elements.bgImage) elements.bgImage.classList.remove('active');
                            if (elements.bgVideo) {
                                if (elements.bgVideo.src !== bgUrl) {
                                    elements.bgVideo.src = bgUrl;
                                    elements.bgVideo.load();
                                }
                                elements.bgVideo.style.filter = '';
                                elements.bgVideo.style.transform = '';
                                elements.bgVideo.classList.add('active');
                                if (state.isPlaying && elements.bgVideo.paused) elements.bgVideo.play().catch(() => { });
                            }
                        }
                    }
                } catch (e) { /* best effort */ }
            }
        } else if (bgType.startsWith('gradient:')) {
            // Gradient mode: show a CSS gradient from the built-in library
            const gradientId = bgType.replace('gradient:', '');
            const gradientCSS = GRADIENT_BACKGROUNDS[gradientId];
            if (gradientCSS && elements.bgGradient) {
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                elements.bgGradient.style.background = gradientCSS;
                elements.bgGradient.classList.add('active');
            }
        }
    }

    // Update MG overlay for current time
    updateMGOverlay();
}

function setupVideoPlayback(scene) {
    // Multi-track system: playback handled in the main playback loop
    // This function is kept for compatibility but is now a no-op
    // All video loading and syncing happens in loadActiveScenes() and the playback loop
}

let _lastHighlightIndex = -1;
let _lastAutoSelectIndex = -1;
function updateSceneHighlight(index) {
    // Skip if highlight hasn't changed
    if (index === _lastHighlightIndex) return;
    _lastHighlightIndex = index;
    document.querySelectorAll('.scene-card').forEach((c, i) => c.classList.toggle('active', i === index));
    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => c.classList.toggle('active', parseInt(c.dataset.index) === index));

    // Auto-select the topmost track scene under playhead for properties panel
    // Skip if user has a multi-selection active (Ctrl+click)
    if (state.selectedClipIndices.length > 1) return;

    // Find ALL active scenes at current time, pick topmost track (highest z-order)
    const activeScenes = getActiveScenesAtTime(state.currentTime);
    const activeMedia = activeScenes.filter(({ scene }) => !scene.isMGScene && !scene.disabled);
    // Last in array = highest track number = topmost visual layer
    const topScene = activeMedia.length > 0 ? activeMedia[activeMedia.length - 1] : null;
    const autoIndex = topScene ? topScene.index : index;

    if (autoIndex >= 0 && autoIndex !== _lastAutoSelectIndex) {
        _lastAutoSelectIndex = autoIndex;
        state.selectedClipIndex = autoIndex;
        state.selectedClipIndices = [autoIndex];
        state.selectedMgIndex = -1;
        // Update visual selection on timeline
        document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
        const clip = document.querySelector(`.timeline-clip[data-index="${autoIndex}"]`);
        if (clip) clip.classList.add('selected');
        updateClipProperties();
    }
}

// ========================================
// Render Video
// ========================================
// ========================================
// WebGL2 Compositor Engine Integration
// ========================================

function getHyperframesPreviewSignature() {
    // The generated HTML consumes much more than media + transform fields:
    // effects, transition lanes, authored graphics, theme/base-look data, and
    // framing/background directives all change the rendered result. Fingerprint
    // the complete synchronized render contract so no valid Agent action can be
    // incorrectly skipped as "same preview".
    return JSON.stringify({
        hfPreviewRuntime: 7,
        videoPlan: state.videoPlan,
        editorDuration: state.totalDuration,
        mgStyle: state.mgStyle,
        mgOverlayShadow: state.mgOverlayShadow,
    });
}

function syncHyperframesPreview(force = false) {
    const frame = elements.hyperframesPreviewFrame;
    if (!state.hyperframesPreview?.active || !frame?.contentWindow) return;
    if (!force && !state.hyperframesPreview.frameReady) return;
    frame.contentWindow.postMessage({
        type: 'hf-preview-seek',
        time: state.currentTime || 0,
        playing: !!state.isPlaying,
    }, '*');
}

function scheduleHyperframesPreviewRefresh(delay = 700) {
    if (!state.hyperframesPreview?.active) return;
    if (state.hyperframesPreview.refreshTimer) {
        clearTimeout(state.hyperframesPreview.refreshTimer);
    }
    state.hyperframesPreview.refreshTimer = setTimeout(() => {
        state.hyperframesPreview.refreshTimer = null;
        refreshHyperframesPreview({ force: true }).catch(err => {
            console.warn('[HyperFrames Preview] Refresh failed:', err);
        });
    }, delay);
}

function markHyperframesPreviewReady(token = '') {
    const frame = elements.hyperframesPreviewFrame;
    if (!frame || !state.hyperframesPreview?.active) return;
    const expected = String(state.hyperframesPreview.readyToken || '');
    if (token && expected && token !== expected) return;
    state.hyperframesPreview.frameReady = true;
    syncHyperframesPreview(true);
    console.log('[HyperFrames Preview] Ready:', state.hyperframesPreview.indexPath);
}

window.addEventListener('message', (event) => {
    const frame = elements.hyperframesPreviewFrame;
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
    const message = event.data || {};
    if (message.type === 'hf-preview-ready') {
        markHyperframesPreviewReady(String(message.rev || ''));
    }
});

async function refreshHyperframesPreview({
    force = false,
    persistMotionQa = true,
    source = '',
    transactionId = '',
} = {}) {
    if (!state.hyperframesPreview?.active || !state.videoPlan) return;
    if (!window.electronAPI?.hyperframesGenerateProject) {
        showToast('HyperFrames preview IPC is not available. Restart the app.', 'error');
        return;
    }

    syncVideoPlanFromEditor();
    const signature = getHyperframesPreviewSignature();
    if (state.hyperframesPreview.loading) {
        if (force || state.hyperframesPreview.signature !== signature) {
            state.hyperframesPreview.pendingRefresh = true;
            const pending = state.hyperframesPreview.pendingRefreshOptions || {};
            state.hyperframesPreview.pendingRefreshOptions = {
                persistMotionQa: pending.persistMotionQa === false || persistMotionQa === false
                    ? false
                    : true,
                source: source || pending.source || '',
                transactionId: transactionId || pending.transactionId || '',
            };
        }
        return;
    }
    if (!force && state.hyperframesPreview.indexPath && state.hyperframesPreview.signature === signature) {
        syncHyperframesPreview(true);
        return;
    }

    state.hyperframesPreview.loading = true;
    try {
        console.log('[HyperFrames Preview] Generating preview project...');
        const result = await window.electronAPI.hyperframesGenerateProject({
            plan: state.videoPlan,
            fps: state.videoPlan.fps || 30,
            options: {
                preview: true,
                persistMotionQa: persistMotionQa !== false,
                previewSource: source || '',
                agentTransactionId: transactionId || '',
            },
        });
        if (!result?.success || !result.previewUrl) {
            throw new Error(result?.error || 'HyperFrames preview project generation failed');
        }
        if (result.revision != null) {
            const revision = Number(result.revision);
            if (Number.isFinite(revision)) state.projectRevision = revision;
        }
        if (result.planHash) state.projectPlanHash = result.planHash;

        const frame = elements.hyperframesPreviewFrame;
        if (!frame) return;
        state.hyperframesPreview.projectDir = result.projectDir;
        state.hyperframesPreview.indexPath = result.indexPath;
        state.hyperframesPreview.signature = signature;
        state.hyperframesPreview.frameReady = false;
        if (Number(result.motionQa?.repairCount || 0) > 0) {
            console.log(`[Motion QA] Preview preflight repaired ${result.motionQa.repairCount} visual issue(s).`);
        }
        const navigationSerial = ++state.hyperframesPreview.navigationSerial;
        const readyToken = `${navigationSerial}-${Date.now()}`;
        state.hyperframesPreview.readyToken = readyToken;
        frame.onload = () => {
            if (navigationSerial !== state.hyperframesPreview.navigationSerial) return;
            markHyperframesPreviewReady(readyToken);
        };
        frame.src = `${result.previewUrl}?preview=1&t=${encodeURIComponent((state.currentTime || 0).toFixed(3))}&rev=${encodeURIComponent(readyToken)}`;
    } catch (err) {
        console.error('[HyperFrames Preview] Failed:', err);
        showToast(`HyperFrames preview failed: ${err.message || err}`, 'error');
    } finally {
        state.hyperframesPreview.loading = false;
        if (state.hyperframesPreview.pendingRefresh) {
            state.hyperframesPreview.pendingRefresh = false;
            const pendingOptions = state.hyperframesPreview.pendingRefreshOptions || {};
            state.hyperframesPreview.pendingRefreshOptions = null;
            queueMicrotask(() => {
                refreshHyperframesPreview({ force: true, ...pendingOptions }).catch(err => {
                    console.warn('[HyperFrames Preview] Queued refresh failed:', err);
                });
            });
        }
    }
}

async function setHyperframesPreviewMode(active, previewOptions = {}) {
    const frame = elements.hyperframesPreviewFrame;
    const container = elements.previewContainer;
    if (!frame || !container) return;

    state.hyperframesPreview.active = !!active;
    container.classList.toggle('hyperframes-preview-active', !!active);
    frame.classList.toggle('hidden', !active);

    if (active) {
        if (state.compositorActive) {
            await setCompositorMode(false);
        }
        document.querySelectorAll('.preview-video').forEach(video => {
            try { video.pause(); } catch (_) {}
        });
        elements.videoContainer?.classList.add('hidden');
        elements.previewPlaceholder?.classList.add('hidden');
        elements.videoControls?.classList.add('hidden');
        await refreshHyperframesPreview({ force: false, ...previewOptions });
        syncHyperframesPreview(true);
    } else {
        frame.contentWindow?.postMessage({ type: 'hf-preview-pause' }, '*');
        state.hyperframesPreview.frameReady = false;
        state.hyperframesPreview.readyToken = '';
        if (!state.compositorActive) {
            elements.videoContainer?.classList.remove('hidden');
            elements.previewPlaceholder?.classList.remove('hidden');
        }
    }
}

/**
 * Release the live HyperFrames preview while render QA owns headless browsers.
 */
async function suspendHyperframesPreviewForRender() {
    const frame = elements.hyperframesPreviewFrame;
    const container = elements.previewContainer;
    if (!frame || !container || !state.hyperframesPreview?.active) {
        return async () => {};
    }

    if (state.isPlaying || state.playbackStarting) stopPlayback();
    if (state.hyperframesPreview.refreshTimer) {
        clearTimeout(state.hyperframesPreview.refreshTimer);
        state.hyperframesPreview.refreshTimer = null;
    }

    const snapshot = {
        src: frame.getAttribute('src') || '',
        readyToken: state.hyperframesPreview.readyToken || '',
    };
    try {
        frame.contentWindow?.postMessage({ type: 'hf-preview-pause' }, '*');
    } catch (_) {}

    state.hyperframesPreview.active = false;
    state.hyperframesPreview.frameReady = false;
    container.classList.remove('hyperframes-preview-active');
    frame.classList.add('hidden');

    // The live preview owns video decoders and a Chromium graphics context.
    // Release both before Motion QA launches its own headless browser(s), then
    // restore the exact preview document after the render attempt finishes.
    await new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            frame.removeEventListener('load', done);
            resolve();
        };
        const timer = setTimeout(done, 750);
        frame.addEventListener('load', done, { once: true });
        frame.src = 'about:blank';
    });
    console.log('[HyperFrames Preview] Suspended during render preflight');

    return async () => {
        if (!frame.isConnected || !container.isConnected) return;
        state.hyperframesPreview.active = true;
        state.hyperframesPreview.frameReady = false;
        state.hyperframesPreview.readyToken = snapshot.readyToken;
        container.classList.add('hyperframes-preview-active');
        frame.classList.remove('hidden');
        elements.videoContainer?.classList.add('hidden');
        elements.previewPlaceholder?.classList.add('hidden');
        elements.videoControls?.classList.add('hidden');

        if (snapshot.src && snapshot.src !== 'about:blank') {
            frame.onload = () => {
                if (!state.hyperframesPreview?.active) return;
                state.hyperframesPreview.frameReady = true;
                syncHyperframesPreview(true);
            };
            frame.src = snapshot.src;
        } else {
            await refreshHyperframesPreview({ force: true });
        }
        console.log('[HyperFrames Preview] Restored after render preflight');
    };
}

/**
 * Initialize the WebGL2 compositor engine.
 * Called once during init() — creates the engine but does NOT activate it.
 */
function initCompositor() {
    const canvas = document.getElementById('compositor-canvas');
    if (!canvas) {
        console.warn('[Compositor] Canvas element not found');
        return;
    }

    try {
        state.compositor = new Compositor(canvas, {
            width: 1920, height: 1080, fps: 30,
        });
        console.log('[Compositor] Engine created (not yet active)');

        // Wire up the compositor toggle button
        const toggleBtn = document.getElementById('btn-compositor-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', async () => {
                if (document.getElementById('renderer-select')?.value === 'hyperframes') {
                    await setHyperframesPreviewMode(true);
                    showToast('HyperFrames preview is active. Switch to WebGL2 to use Engine ON.', 'info');
                    return;
                }
                setCompositorMode(!state.compositorActive);
            });
        }

        // Wire up preview quality selector
        const qualitySelect = document.getElementById('preview-quality');
        if (qualitySelect) {
            qualitySelect.addEventListener('change', () => {
                const scale = parseFloat(qualitySelect.value) || 0.5;
                if (state.compositor) {
                    state.compositor.setPreviewScale(scale);
                    // Re-render current frame at new resolution
                    if (state.compositorActive && state.compositor.isInitialized) {
                        state.compositor.renderAtTime(state.currentTime);
                    }
                }
            });
        }

        // Auto-activate when WebGL2 renderer is selected + show legacy toggle
        const rendererSelect = document.getElementById('renderer-select');
        const legacyLabel = document.getElementById('legacy-export-label');
        if (rendererSelect) {
            const updateLegacyVisibility = () => {
                const isWebgl2 = rendererSelect.value === 'webgl2';
                if (legacyLabel) legacyLabel.style.display = isWebgl2 ? 'flex' : 'none';
                if (toggleBtn) toggleBtn.style.display = isWebgl2 ? 'inline-block' : 'none';
                if (qualitySelect && !isWebgl2) qualitySelect.style.display = 'none';
            };
            rendererSelect.addEventListener('change', async () => {
                const useHyperframesPreview = rendererSelect.value === 'hyperframes';
                if (useHyperframesPreview) {
                    if (state.compositorActive) await setCompositorMode(false);
                    await setHyperframesPreviewMode(true);
                } else {
                    await setHyperframesPreviewMode(false);
                    if (rendererSelect.value === 'webgl2' && !state.compositorActive) {
                        await setCompositorMode(true);
                    }
                }
                updateLegacyVisibility();
            });
            updateLegacyVisibility();
        }
    } catch (e) {
        console.error('[Compositor] Failed to create engine:', e);
        state.compositor = null;
    }
}

/**
 * Toggle between HTML preview and WebGL2 compositor preview.
 */
async function setCompositorMode(active) {
    state.compositorActive = active;
    const canvas = document.getElementById('compositor-canvas');
    const htmlLayers = document.querySelectorAll('.track-wrapper, .mg-overlay, .mg-v3-preview-layer, .bg-media');
    const toggleBtn = document.getElementById('btn-compositor-toggle');
    const qualitySelect = document.getElementById('preview-quality');

    if (active) {
        if (state.hyperframesPreview?.active) {
            state.hyperframesPreview.active = false;
            elements.previewContainer?.classList.remove('hyperframes-preview-active');
            elements.hyperframesPreviewFrame?.classList.add('hidden');
            elements.hyperframesPreviewFrame?.contentWindow?.postMessage({ type: 'hf-preview-pause' }, '*');
        }
        // Initialize if not yet done
        if (state.compositor && !state.compositor.isInitialized) {
            state.compositor.init();
        }
        // Load plan into compositor if we have one
        if (canvas) canvas.classList.add('active');
        htmlLayers.forEach(el => el.style.visibility = 'hidden');
        if (toggleBtn) {
            toggleBtn.textContent = 'Engine: ON';
            toggleBtn.style.background = '#22c55e';
            toggleBtn.style.color = '#000';
        }
        if (qualitySelect) qualitySelect.style.display = '';
        console.log('[Compositor] Preview mode ENABLED');
        // Load plan (async preload) THEN render — must await so elements are ready
        if (state.compositor && state.videoPlan) {
            await loadPlanIntoCompositor();
        }
        // Render current frame AFTER preload completes so textures are available
        if (state.compositor && state.compositor.isInitialized) {
            state.compositor.renderAtTime(state.currentTime);
        }
    } else {
        if (canvas) canvas.classList.remove('active');
        htmlLayers.forEach(el => el.style.visibility = '');
        if (toggleBtn) {
            toggleBtn.textContent = 'Engine: OFF';
            toggleBtn.style.background = '';
            toggleBtn.style.color = '';
        }
        if (qualitySelect) qualitySelect.style.display = 'none';
        // Pause compositor videos
        if (state.compositor) state.compositor.pauseVideos();
        console.log('[Compositor] Preview mode DISABLED');
    }
}

/**
 * Load the current video plan into the compositor engine.
 * Builds a synthetic plan from the PROCESSED state (state.scenes + state.motionGraphics)
 * so the compositor sees the exact same data as the timeline preview.
 * Uses getCachedMediaUrl as the URL resolver.
 */

/**
 * Lightweight sync: push current MG overlay data into the compositor's
 * scene graph and re-render the current frame.  Does NOT reload videos
 * or rebuild the full plan — safe to call on every property edit.
 */
/**
 * Sync a scene's visual properties (scale, pos, crop, etc.) to the compositor's SceneGraph copy
 * so changes are reflected in the WebGL preview without toggling the engine.
 */
function refreshCompositorScene(sceneIndex) {
    if (!state.compositorActive || !state.compositor || !state.compositor.isInitialized) return;
    const sg = state.compositor.sceneGraph;
    if (!sg) return;
    const srcScene = state.scenes[sceneIndex];
    if (!srcScene) return;

    // Find the matching scene in the SceneGraph's internal copy
    const target = sg._scenes.find(s => (
        (srcScene.clipId && s.clipId === srcScene.clipId)
        || (!srcScene.clipId && s.index === srcScene.index)
    ));
    if (!target) return;

    // Sync mutable visual properties
    target.scale = srcScene.scale;
    target.posX = srcScene.posX;
    target.posY = srcScene.posY;
    target.fitMode = srcScene.fitMode;
    target.focusX = srcScene.focusX;
    target.focusY = srcScene.focusY;
    target.cropTop = srcScene.cropTop;
    target.cropBottom = srcScene.cropBottom;
    target.cropLeft = srcScene.cropLeft;
    target.cropRight = srcScene.cropRight;
    target.borderRadius = srcScene.borderRadius;
    target.background = srcScene.background;
    target.volume = srcScene.volume;
    target.kenBurnsEnabled = srcScene.kenBurnsEnabled;
    target.kenBurnsSpeed = srcScene.kenBurnsSpeed;
    target.effectOverrides = srcScene.effectOverrides;
    target.effectMask = srcScene.effectMask;
    target.framing = srcScene.framing;
    target.shadow = srcScene.shadow;
    target.floatingAnim = srcScene.floatingAnim;
    target.floatingAnimDuration = srcScene.floatingAnimDuration;

    // Re-render current frame
    const fps = state.compositor.fps;
    const frame = Math.round((state.currentTime || 0) * fps);
    state.compositor.renderFrame(frame);
}

// ─────────────────────────────────────────────────────────────────────────
// Timeline scene right-click menu — Retry footage / CEO Editor (single or batch)
// Reuses src/scene-actions.js (Media Agent + footage download + editor-agent CEO).
// ─────────────────────────────────────────────────────────────────────────
let _sceneMenuEl = null;

function _selectedSceneIndices() {
    if (state.selectedClipIndices && state.selectedClipIndices.length) return [...state.selectedClipIndices];
    if (state.selectedClipIndex >= 0) return [state.selectedClipIndex];
    return [];
}

function _hideSceneMenu() {
    if (_sceneMenuEl) { _sceneMenuEl.remove(); _sceneMenuEl = null; }
    document.removeEventListener('click', _hideSceneMenu);
    document.removeEventListener('contextmenu', _hideSceneMenuOnOutside, true);
}
function _hideSceneMenuOnOutside(e) {
    if (_sceneMenuEl && !_sceneMenuEl.contains(e.target)) _hideSceneMenu();
}

function initSceneContextMenu() {
    // Delegate on document, NOT #timeline-content: renderTimeline() rebuilds the
    // timeline via innerHTML on every change, so any listener bound inside it is
    // destroyed. document is stable and this covers clips on ALL tracks at once
    // (V1 footage + V2/V3 templates, MGs, overlays).
    document.addEventListener('contextmenu', (e) => {
        const clip = e.target.closest('.timeline-clip[data-index]');
        if (!clip) return;
        e.preventDefault();
        const idx = parseInt(clip.dataset.index, 10);
        if (Number.isNaN(idx)) return;
        // If the right-clicked clip isn't already in the selection, select just it.
        if (!_selectedSceneIndices().includes(idx)) {
            state.selectedClipIndices = [idx];
            state.selectedClipIndex = idx;
            document.querySelectorAll('.timeline-clip.selected').forEach(c => c.classList.remove('selected'));
            clip.classList.add('selected');
            notifyAgentContextChanged();
        }
        _showSceneMenu(e.clientX, e.clientY);
    });
}

function _showSceneMenu(x, y) {
    _hideSceneMenu();
    const indices = _selectedSceneIndices();
    if (!indices.length) return;
    const first = state.scenes[indices[0]] || {};
    const typeLabel = first.isMGScene ? (first.type || 'MG') : (first.mediaType === 'image' ? 'image' : 'video');
    const label = indices.length > 1 ? `${indices.length} scenes selected` : `Scene ${indices[0]} · ${typeLabel}`;

    const menu = document.createElement('div');
    menu.className = 'scene-context-menu';
    menu.innerHTML = `
        <div class="scm-header">${escapeHTML(label)}</div>
        <div class="scm-item" data-act="retry">🔄 Retry footage</div>
        <div class="scm-item" data-act="agent">✨ Edit with Agent…</div>
        <div class="scm-sep"></div>
        <div class="scm-item" data-act="ceo:reframe">🎬 AI re-frame</div>`;
    document.body.appendChild(menu);
    menu.style.left = Math.min(x, window.innerWidth - 250) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 280) + 'px';
    _sceneMenuEl = menu;

    menu.addEventListener('click', (ev) => {
        const item = ev.target.closest('.scm-item[data-act]');
        if (!item || item.classList.contains('scm-disabled')) return;
        const act = item.dataset.act;
        _hideSceneMenu();
        _runSceneAction(act, indices);
    });

    setTimeout(() => {
        document.addEventListener('click', _hideSceneMenu);
        document.addEventListener('contextmenu', _hideSceneMenuOnOutside, true);
    }, 0);
}

async function _runSceneAction(act, indices) {
    if (act === 'agent') {
        notifyAgentContextChanged();
        window.EditorAgentPanel?.openWithCurrentScope();
        return;
    }
    if (!window.electronAPI?.sceneAction) {
        showToast('Scene action IPC unavailable. Restart the app.', 'error');
        return;
    }

    const sceneIds = [];
    const sceneRefs = [];
    const idToArrayIndex = new Map();
    for (const idx of indices) {
        const scene = state.scenes[idx];
        if (!scene) continue;
        const sceneId = getSceneSourceIndex(scene, idx);
        if (!scene.clipId) scene.clipId = createUniqueClipId(scene);
        sceneIds.push(sceneId);
        sceneRefs.push({
            clipId: scene.clipId,
            sourceSceneIndex: sceneId,
            index: sceneId,
        });
        idToArrayIndex.set(String(scene.clipId), idx);
        if (!idToArrayIndex.has(String(sceneId))) idToArrayIndex.set(String(sceneId), idx);
    }
    if (!sceneIds.length) {
        showToast('No valid scene selected', 'error');
        return;
    }

    const kind = act === 'retry' ? 'retry' : act.startsWith('ceo:') ? 'ceo' : '';
    const action = kind === 'ceo' ? act.split(':')[1] : '';
    if (!kind) return;

    mediaLogShow();
    const offProgress = window.electronAPI.onSceneActionProgress?.((evt) => {
        if (!evt || typeof evt !== 'object') return;
        const sceneIndex = Number(evt.sceneIndex);
        const msg = evt.message || '';
        const label = Number.isFinite(sceneIndex) && sceneIndex >= 0 ? `Scene ${sceneIndex}: ` : '';
        // Report lines (box-drawing) go to the Media Log panel only — don't flood toasts.
        const isReportLine = /^\s*[┌│└]/.test(msg) || msg.trim() === '';
        mediaLogAppend(isReportLine ? msg : `${label}${msg}`);
        if (!isReportLine && msg.trim()) {
            showToast(`${label}${msg}`, Number.isFinite(sceneIndex) && sceneIndex < 0 ? 'warning' : 'info');
        }
    });

    let result = null;
    try {
        showToast(kind === 'retry'
            ? `${sceneIds.length} scene${sceneIds.length > 1 ? 's' : ''}: retrying footage in main process…`
            : `${sceneIds.length} scene${sceneIds.length > 1 ? 's' : ''}: CEO ${action}…`, 'info');

        result = await window.electronAPI.sceneAction({
            kind,
            action,
            sceneIndices: sceneIds,
            sceneRefs,
        });
    } catch (e) {
        result = { success: false, ok: 0, fail: sceneIds.length, error: e.message || String(e) };
    } finally {
        if (typeof offProgress === 'function') offProgress();
    }

    const ok = Number(result?.ok || 0);
    const fail = Number(result?.fail || 0);

    if (Array.isArray(result?.scenes)) {
        for (const row of result.scenes) {
            const arrIdx = idToArrayIndex.get(String(row.clipId ?? row.si));
            if (arrIdx === undefined || !state.scenes[arrIdx]) continue;
            if (row.keyword) state.scenes[arrIdx].keyword = row.keyword;
            if (row.sourceHint) state.scenes[arrIdx].sourceHint = row.sourceHint;
            // Retry swapped the file at the same path → bump this scene's cache-bust token
            // so getCachedMediaUrl returns a fresh URL and the preview re-fetches it.
            if (row.reload && Number.isFinite(Number(row.si))) {
                state._assetVersions[Number(row.si)] = Date.now();
            }
            if (row.scene) {
                state.scenes[arrIdx] = {
                    ...row.scene,
                    clipId: row.scene.clipId || state.scenes[arrIdx].clipId,
                    sourceSceneIndex: getSceneSourceIndex(row.scene, getSceneSourceIndex(state.scenes[arrIdx], arrIdx)),
                };
                refreshCompositorScene(arrIdx);
                showToast(`Scene ${row.si}: ${row.change || 'updated'}`, 'success');
            }
        }
    }

    if (kind === 'retry' && ok > 0) {
        // Replacement keeps the same filename; clear URL cache and reload so the
        // compositor does not keep a stale media element around.
        state._mediaUrlCache = {};
        try { await loadPlanIntoCompositor(); } catch (_) {}
    }

    if (result?.error) showToast(result.error, 'error');
    if (Array.isArray(result?.errors)) {
        for (const err of result.errors.slice(0, 3)) {
            showToast(`Scene ${err.si}: ${err.error}`, 'error');
        }
    }

    showNotification('Scene actions', `${ok} done${fail ? `, ${fail} failed` : ''}`, (fail && !ok) ? 'error' : 'success');
}

// ─────────────────────────────────────────────────────────────────────────
// Media Log panel — persistent, scrollable view of retry/media diagnostics
// (per-scene MEDIA REPORT: candidates tried, scores, clickable links, winner).
// ─────────────────────────────────────────────────────────────────────────
let _mediaLogEl = null;
function _escapeHtmlML(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function _mediaLogEnsure() {
    if (_mediaLogEl) return _mediaLogEl;
    const el = document.createElement('div');
    el.id = 'media-log-panel';
    el.innerHTML = `
        <div class="ml-header">
            <span class="ml-title">🎬 Media Log</span>
            <span class="ml-actions">
                <button class="ml-btn ml-clear" title="Clear">Clear</button>
                <button class="ml-btn ml-close" title="Hide">✕</button>
            </span>
        </div>
        <div class="ml-body"></div>`;
    document.body.appendChild(el);
    el.querySelector('.ml-clear').addEventListener('click', () => { el.querySelector('.ml-body').innerHTML = ''; });
    el.querySelector('.ml-close').addEventListener('click', () => { el.classList.add('ml-hidden'); });
    el.querySelector('.ml-body').addEventListener('click', (e) => {
        const a = e.target.closest('a.ml-link');
        if (a) { e.preventDefault(); window.electronAPI?.openExternal?.(a.dataset.url); }
    });
    _mediaLogEl = el;
    return el;
}
function mediaLogShow() { _mediaLogEnsure().classList.remove('ml-hidden'); }
function mediaLogAppend(message) {
    const body = _mediaLogEnsure().querySelector('.ml-body');
    const msg = String(message || '');
    // Turn URLs into clickable links; escape everything else.
    let html = '', last = 0;
    const re = /https?:\/\/[^\s)]+/g;
    let m;
    while ((m = re.exec(msg))) {
        html += _escapeHtmlML(msg.slice(last, m.index));
        html += `<a class="ml-link" href="#" data-url="${_escapeHtmlML(m[0])}">${_escapeHtmlML(m[0])}</a>`;
        last = m.index + m[0].length;
    }
    html += _escapeHtmlML(msg.slice(last));
    const line = document.createElement('div');
    line.className = 'ml-line';
    if (/✅|WINNER|accepted/.test(msg)) line.classList.add('ml-ok');
    else if (/❌|rejected|\bfail|✗|not ready/.test(msg)) line.classList.add('ml-bad');
    else if (/┌──|MEDIA REPORT/.test(msg)) line.classList.add('ml-hdr');
    line.innerHTML = html || '&nbsp;';
    body.appendChild(line);
    while (body.childElementCount > 800) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
}

function refreshCompositorMGs() {
    if (!state.compositorActive || !state.compositor || !state.compositor.isInitialized) return;
    const sg = state.compositor.sceneGraph;
    if (!sg) return;

    // Sync overlay MGs (the _mgs array inside SceneGraph)
    const fps = state.compositor.fps;
    const activeMGs = (state.motionGraphics || []).filter(mg => !mg.disabled);
    sg._mgs = activeMGs.map(mg => {
        const startFrame = Math.round((mg.startTime || 0) * fps);
        const dur = mg.duration || 3;
        const endFrame = Math.round((mg.startTime + dur) * fps);
        return {
            ...mg,
            _startFrame: startFrame,
            _endFrame: endFrame,
            _totalFrames: endFrame - startFrame,
            _animationSpeed: mg.animationSpeed || 1.0,
            overlayShadowStrength: mg.overlayShadowStrength != null ? mg.overlayShadowStrength : state.mgOverlayShadow,
        };
    });

    // Sync fullscreen MG scenes (_scenes that are isMGScene)
    const mgScenes = state.scenes.filter(s => s.isMGScene);
    for (const mgScene of mgScenes) {
        // Clip identity is authoritative; index is only a legacy/source fallback.
        const existing = sg._scenes.find(s => s.isMGScene && (
            (s.clipId && mgScene.clipId && s.clipId === mgScene.clipId) ||
            (!s.clipId && !mgScene.clipId
                && s.index != null && mgScene.index != null && s.index === mgScene.index) ||
            (!s.clipId && !mgScene.clipId
                && s.index == null && Math.abs((s.startTime || 0) - (mgScene.startTime || 0)) < 0.01)
        ));
        if (existing) {
            // Recompute frame range from seconds
            const startFrame = Math.round((mgScene.startTime || 0) * fps);
            const timing = getSceneTiming(mgScene);
            const endFrame = Math.round(timing.endTime * fps);
            // Update all mutable fields including duration, frames, animation speed, and background
            Object.assign(existing, {
                type: mgScene.type, text: mgScene.text, subtext: mgScene.subtext,
                style: mgScene.style, subType: mgScene.subType, animation: mgScene.animation,
                position: mgScene.position,
                data: mgScene.data, mgData: mgScene.mgData,
                mgBackground: mgScene.mgBackground,
                clipId: mgScene.clipId,
                duration: timing.duration,
                durationFrames: timing.durationFrames,
                durationUnit: 'seconds',
                startTime: timing.startTime, endTime: timing.endTime,
                templateContentStartTime: mgScene.templateContentStartTime,
                templateContentEndTime: mgScene.templateContentEndTime,
                templateContentDuration: mgScene.templateContentDuration,
                templateContentOffset: mgScene.templateContentOffset,
                _startFrame: startFrame, _endFrame: endFrame,
                _totalFrames: endFrame - startFrame,
                _animationSpeed: mgScene.animationSpeed || 1.0,
                _listicleItems: mgScene._listicleItems,
                _itemThumbnails: mgScene._itemThumbnails,
                _itemThumbnailUrls: mgScene._itemThumbnailUrls,
                // Map properties
                _mapPolyColor: mgScene._mapPolyColor,
                _mapWaypoints: mgScene._mapWaypoints,
                _mapBigMap: mgScene._mapBigMap,
                _bigMapSize: mgScene._bigMapSize,
                _wpCoords: mgScene._wpCoords,
                _osmBoundaries: mgScene._osmBoundaries,
                _mapZoomSpeed: mgScene._mapZoomSpeed,
                _mapPolySpeed: mgScene._mapPolySpeed,
                _mapEasing: mgScene._mapEasing,
                _mapTiltKfStart: mgScene._mapTiltKfStart,
                _mapTiltKfEnd: mgScene._mapTiltKfEnd,
                _mapZoomKfStart: mgScene._mapZoomKfStart,
                _mapZoomKfEnd: mgScene._mapZoomKfEnd,
                _mapCinematic: mgScene._mapCinematic,
                mapStyle: mgScene.mapStyle,
                mapVariant: mgScene.mapVariant,
                _mapIcons: mgScene._mapIcons,
            });
        }
    }

    // Re-render current frame
    const frame = Math.round((state.currentTime || 0) * fps);
    state.compositor.renderFrame(frame);
}

async function loadPlanIntoCompositor() {
    if (!state.compositor || !state.videoPlan) return;

    try {
        // Build a plan from the processed state so compositor matches the timeline exactly.
        // state.videoPlan has the RAW plan; state.scenes has the processed/carved/reordered scenes.
        // Build scenes list for compositor
        const compositorScenes = state.scenes.filter(s => !s.isMGScene).map((s, i) => ({
            ...s,
            index: getSceneSourceIndex(s, i),
            sourceSceneIndex: getSceneSourceIndex(s, i),
            clipId: s.clipId || createUniqueClipId(s),
            ...getSceneTiming(s),
        }));

        // Build transitions array from adjacent scenes on the same track.
        // The SceneGraph expects { fromSceneIndex, toSceneIndex, type, duration }.
        // The UI stores transitions as per-scene `transitionType` or global `state.transition.style`.
        const transitions = [];
        const globalStyle = state.transition.style || 'cut';
        const globalDuration = state.transition.duration || 0.5;
        const trackGroups = {};
        for (const s of compositorScenes) {
            const tid = s.trackId || 'video-track-1';
            if (!trackGroups[tid]) trackGroups[tid] = [];
            trackGroups[tid].push(s);
        }
        for (const tid of Object.keys(trackGroups)) {
            const sorted = trackGroups[tid].sort((a, b) => a.startTime - b.startTime);
            for (let i = 1; i < sorted.length; i++) {
                const prev = sorted[i - 1];
                const curr = sorted[i];
                // Only add transition if scenes are adjacent (gap < 0.1s)
                if (Math.abs(curr.startTime - prev.endTime) > 0.1) continue;
                let type = curr.transitionType
                    || (globalStyle !== 'auto' ? globalStyle : null)
                    || curr.transition?.type
                    || 'crossfade';
                if (type === 'random') {
                    const seed = curr.index * 7 + 3;
                    const types = state.transition.types.length > 0 ? state.transition.types : ['crossfade'];
                    type = types[seed % types.length];
                }
                if (type === 'cut' || type === 'none') continue;
                // Use AI-assigned duration when in auto mode, else global slider
                const dur = (globalStyle === 'auto' && curr.transition?.duration)
                    ? curr.transition.duration
                    : globalDuration;
                transitions.push({
                    fromClipId: prev.clipId,
                    toClipId: curr.clipId,
                    fromSceneIndex: prev.index,
                    toSceneIndex: curr.index,
                    type,
                    duration: dur,
                });
            }
        }

        console.log(`[Compositor] Built ${transitions.length} transitions (style: ${globalStyle}, duration: ${globalDuration}s)`);
        if (transitions.length > 0) console.log('[Compositor] First transition:', JSON.stringify(transitions[0]));

        const compositorPlan = {
            fps: state.videoPlan.fps || 30,
            totalDuration: state.totalDuration || state.videoPlan.totalDuration,
            scriptContext: state.videoPlan.scriptContext || {},
            scenes: compositorScenes,
            // Fullscreen MG scenes
            mgScenes: state.scenes.filter(s => s.isMGScene).map(s => ({ ...s })),
            // Overlay motion graphics
            motionGraphics: (state.motionGraphics || [])
                .filter(mg => !mg.disabled)
                .map(mg => ({
                    ...mg,
                    overlayShadowStrength: mg.overlayShadowStrength != null ? mg.overlayShadowStrength : state.mgOverlayShadow,
                })),
            // Transitions (built from adjacent scenes above)
            transitions,
        };

        await state.compositor.loadPlan(compositorPlan, async (sceneIndex, ext) => {
            return getCachedMediaUrl(sceneIndex, ext);
        }, async (mediaFile) => {
            // Resolve the media path through the confined asset:// protocol.
            if (window.electronAPI.getFileUrl) {
                return window.electronAPI.getFileUrl(mediaFile).catch(() => null);
            }
            return null;
        });

        // Render current frame after preload so loaded textures are visible immediately
        if (state.compositor.isInitialized) {
            state.compositor.renderAtTime(state.currentTime || 0);
        }
    } catch (e) {
        console.error('[Compositor] Failed to load plan:', e);
    }
}


/**
 * Run WebGL2 export pipeline.
 * Renders all frames via the engine and pipes to FFmpeg via IPC.
 */
async function renderVideoWebGL2() {
    if (!state.compositor || !state.videoPlan) {
        showToast('Compositor not initialized or no plan loaded', 'error');
        return;
    }

    // Ensure compositor is initialized and plan is loaded
    if (!state.compositor.isInitialized) {
        state.compositor.init();
    }
    await loadPlanIntoCompositor();

    const legacyToggle = document.getElementById('legacy-export-toggle');
    const useLegacy = legacyToggle && legacyToggle.checked;
    const fps = state.videoPlan.fps || 30;

    const pipeline = new ExportPipeline(state.compositor);
    state.exportPipeline = pipeline; // Store so cancelProcess() can reach it
    pipeline.onProgress((data) => {
        const mode = useLegacy ? 'Legacy' : 'Optimized';
        updateProgress(data.percent, `[${mode}] Rendering frame ${data.currentFrame}/${data.totalFrames} (${data.fps} fps)`);
    });

    // Run validation hashes before export (logs to console for A/B comparison)
    const totalFrames = state.compositor.totalFrames;
    const testFrames = [0, 100, Math.min(500, totalFrames - 1), totalFrames - 1].filter((f, i, a) => a.indexOf(f) === i);
    console.log(`[WebGL2 Export] Running frame hash validation on frames: ${testFrames.join(', ')}`);
    const hashes = await pipeline.validate(testFrames);
    console.log('[WebGL2 Export] Validation hashes:', JSON.stringify(hashes));

    // In/Out point support: convert seconds to frames
    const { inSec, outSec, startFrame, endFrame } = getFrameAlignedRenderRange(fps);
    const hasRange = state.inPoint !== null || state.outPoint !== null;
    if (hasRange) {
        console.log(`[WebGL2 Export] In/Out range: ${inSec.toFixed(2)}s-${outSec.toFixed(2)}s → frames ${startFrame}-${endFrame}`);
    }

    try {
        const result = await pipeline.start({
            width: 1920,
            height: 1080,
            fps,
            legacy: useLegacy,
            startFrame: hasRange ? startFrame : undefined,
            endFrame: hasRange ? endFrame : undefined,
        });
        return result;
    } finally {
        state.exportPipeline = null;
    }
}

/**
 * Render through the HyperFrames bridge.
 * Generates a standalone HTML/GSAP HyperFrames project from the current
 * processed plan, then renders it through the HyperFrames CLI.
 */
async function renderVideoHyperFrames() {
    if (!state.videoPlan) {
        return { success: false, error: 'No video plan loaded' };
    }
    if (!window.electronAPI?.hyperframesRender) {
        return { success: false, error: 'HyperFrames bridge IPC is not available. Restart the app after updating.' };
    }

    const fps = state.videoPlan.fps || 30;
    const { inSec, outSec } = getFrameAlignedRenderRange(fps);
    const hasRange = state.inPoint !== null || state.outPoint !== null;
    if (hasRange) {
        showToast(`HyperFrames: rendering section ${formatTime(inSec)} → ${formatTime(outSec)}`, 'info');
    }

    updateProgress(8, 'Generating HyperFrames HTML/MG project...');
    return window.electronAPI.hyperframesRender({
        plan: state.videoPlan,
        fps,
        quality: 'standard',
        gpu: true,
        strict: false,
        options: { startSec: inSec, endSec: outSec },
    });
}

async function renderVideo() {
    if (!state.videoPlan || state.isProcessing) return;
    state.isProcessing = true; elements.btnRender.disabled = true; showProgress(true); startTimer();
    let restoreHyperframesPreview = null;
    try {
        // Commit editor state + project settings to every persistence mirror
        // before rendering so a crash cannot reopen a stale timeline.
        const saveResult = await saveProject(true);
        if (!saveResult?.success) throw new Error(saveResult?.error || 'Pre-render project save failed');

        const selectedRenderer = document.getElementById('renderer-select')?.value || 'hyperframes';
        const isHyperFramesRender = selectedRenderer === 'hyperframes';
        updateProgress(5, isHyperFramesRender
            ? 'Starting HyperFrames HTML/MG render...'
            : 'Starting WebGL2 WYSIWYG render...');
        if (isHyperFramesRender) {
            restoreHyperframesPreview = await suspendHyperframesPreviewForRender();
        }
        let result = isHyperFramesRender ? await renderVideoHyperFrames() : await renderVideoWebGL2();
        if (result.success) {
            stopTimer();
            const renderTime = getElapsedString();
            const engineLabel = isHyperFramesRender ? 'HyperFrames' : 'WebGL2';
            updateProgress(100, `✅ Video rendered! (${renderTime})`);
            showToast(`${engineLabel} video rendered in ${renderTime}!`, 'success');
            showNotification('Render Complete', `${engineLabel} video rendered in ${renderTime}`);
            if (isHyperFramesRender && Number(result.motionQa?.repairCount || 0) > 0) {
                showNotification(
                    'Motion QA',
                    `Agent automatically repaired ${result.motionQa.repairCount} animation issue(s) before render`,
                    'success'
                );
            }
            if (result.outputPath) showFinalVideo(result.outputPath);
        } else {
            stopTimer();
            const errorMsg = result.error || 'Render failed';
            if (errorMsg === 'Cancelled' || errorMsg.includes('cancelled') || errorMsg.includes('Cancelled')) {
                updateProgress(0, '⛔ Render cancelled');
                showToast('Render cancelled', 'info');
                showNotification('Render Cancelled', `Stopped after ${getElapsedString()}`, 'cancel');
            } else {
                const shortError = errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg;
                updateProgress(0, `❌ ${errorMsg}`);
                showToast(`Render error: ${shortError}`, 'error');
                showNotification('Render Failed', shortError, 'error');
                console.error('❌ Render error:', errorMsg);
            }
        }
    } catch (e) {
        stopTimer();
        console.error('❌ Render error:', e);
        const errMsg = e.message.length > 100 ? e.message.substring(0, 100) + '...' : e.message;
        showToast(`Render error: ${errMsg}`, 'error');
        showNotification('Render Failed', errMsg, 'error');
        updateProgress(0, `❌ ${e.message}`);
    } finally {
        if (restoreHyperframesPreview) {
            try {
                await restoreHyperframesPreview();
            } catch (error) {
                console.warn('[HyperFrames Preview] Restore after render failed:', error);
                setHyperframesPreviewMode(true).catch(() => {});
            }
        }
        state.isProcessing = false;
        elements.btnRender.disabled = false;
        elements.btnCancel.disabled = false;
        elements.btnCancel.textContent = 'Cancel';
        setTimeout(() => showProgress(false), 5000);
    }
}

async function showFinalVideo(videoPath) {
    try {
        // Stop any existing playback
        stopPlayback();
        cleanupVideoHandlers();

        const url = await window.electronAPI.getFileUrl(videoPath);
        if (url && elements.previewVideo && elements.previewPlaceholder) {
            elements.previewPlaceholder.classList.add('hidden');
            elements.previewVideo.classList.remove('hidden');
            elements.previewVideo.src = url;
            elements.previewVideo.play();
        } else if (url) {
            console.warn('[showFinalVideo] Preview elements not found, skipping video display');
        }
        showToast('Video rendered!', 'success');
    } catch (e) {
        console.error('Failed to show final video:', e);
    }
}

// ========================================
// UI Helpers
// ========================================
function showProgress(show) { elements.progressContainer.classList.toggle('hidden', !show); if (!show) stopTimer(); }
// ── Build Log panel ──────────────────────────────────────────────────
// Consumes structured `build-event` events (phase/scene/note) emitted by the
// pipeline via src/logger.js and renders a clean, phase-grouped, per-scene view
// with expandable detail. The verbose lines stay in the .log file.
const buildLog = {
    phases: new Map(),   // phaseId -> { label, order, rows: Map(key->row), notes: [] }
    _order: 0,
    _icons: { ok: '✅', fail: '❌', warn: '⚠️', timeout: '⏱️', start: '▸', info: '·', done: '✅' },

    reset() {
        this.phases = new Map();
        this._order = 0;
        const body = document.getElementById('build-log-body');
        if (body) body.innerHTML = '';
        const panel = document.getElementById('build-log');
        if (panel) panel.classList.remove('hidden');
    },

    _phase(id, label) {
        let p = this.phases.get(id);
        if (!p) { p = { id, label: label || id, order: this._order++, rows: new Map(), notes: [] }; this.phases.set(id, p); }
        else if (label) p.label = label;
        return p;
    },

    handle(evt) {
        if (!evt || typeof evt !== 'object') return;
        const phaseId = evt.phase || 'phase';
        if (evt.t === 'phase') {
            this._phase(phaseId, evt.label);
        } else if (evt.t === 'scene') {
            const p = this._phase(phaseId);
            const key = 's' + evt.scene;
            p.rows.set(key, { kind: 'scene', scene: evt.scene, status: evt.status, msg: evt.msg, detail: evt.detail });
        } else if (evt.t === 'note') {
            const p = this._phase(phaseId);
            p.rows.set('n' + (p.rows.size), { kind: 'note', scene: evt.scene, status: evt.status || 'info', msg: evt.msg, detail: evt.detail });
        }
        this.render();
    },

    render() {
        const body = document.getElementById('build-log-body');
        if (!body) return;
        const phases = [...this.phases.values()].sort((a, b) => a.order - b.order);
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        let html = '';
        for (const p of phases) {
            const rows = [...p.rows.values()];
            // Per-phase summary counts (mainly meaningful for download).
            const c = { ok: 0, fail: 0, timeout: 0, start: 0 };
            for (const r of rows) if (c[r.status] != null) c[r.status]++;
            const inProg = c.start - c.ok - c.fail - c.timeout;
            const sumBits = [];
            if (c.ok) sumBits.push(`${c.ok} done`);
            if (c.fail) sumBits.push(`${c.fail} failed`);
            if (c.timeout) sumBits.push(`${c.timeout} timed out`);
            if (inProg > 0) sumBits.push(`${inProg} working`);
            const summary = sumBits.length ? sumBits.join(' · ') : '';

            html += `<div class="bl-phase"><div class="bl-phase-head"><span>${esc(p.label)}</span>`
                + (summary ? `<span class="bl-phase-summary">${esc(summary)}</span>` : '') + `</div>`;
            if (rows.length) {
                html += '<div class="bl-rows">';
                for (const r of rows) {
                    // Collapse a scene's "start" once it has a terminal status (handled by Map key reuse).
                    const icon = this._icons[r.status] || '·';
                    const sid = r.scene != null ? `<span class="bl-scene-id">S${r.scene}</span>` : '';
                    const cls = 'bl-' + (r.status || 'info');
                    const hasDetail = !!r.detail;
                    html += `<div class="bl-row ${hasDetail ? 'has-detail' : ''}">`
                        + `<span class="bl-icon ${cls}">${icon}</span>${sid}`
                        + `<span class="bl-msg">${esc(r.msg)}</span></div>`;
                    if (hasDetail) html += `<div class="bl-detail">${esc(r.detail)}</div>`;
                }
                html += '</div>';
            }
            html += '</div>';
        }
        body.innerHTML = html;
        // Click-to-expand detail rows.
        body.querySelectorAll('.bl-row.has-detail').forEach(row => {
            row.onclick = () => row.classList.toggle('open');
        });
        body.scrollTop = body.scrollHeight;
    },
};

function updateProgress(percent, message) {
    // percent < 0 is a sticky-alert signal (e.g. Qwen key exhausted) — don't
    // collapse the progress bar, just surface the message as a toast.
    if (typeof percent === 'number' && percent >= 0) {
        elements.progressFill.style.width = `${percent}%`;
    }
    if (message) {
        elements.progressText.textContent = message;
        if (typeof percent === 'number' && percent < 0 && typeof showToast === 'function') {
            showToast(message, 'warning');
        }
    }
}

// Build / Render timer
let _timerInterval = null;
let _timerStart = 0;
function startTimer() {
    stopTimer();
    _timerStart = Date.now();
    updateTimerDisplay();
    _timerInterval = setInterval(updateTimerDisplay, 1000);
}
function stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}
function updateTimerDisplay() {
    const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${String(m).padStart(2, '0')}m`);
    parts.push(`${String(s).padStart(2, '0')}s`);
    if (elements.progressTimer) elements.progressTimer.textContent = parts.join(' ');
}
function getElapsedString() {
    const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}
// ========================================
// Notification Center (persisted, 3-day max)
// ========================================
const NOTIF_STORAGE_KEY = 'faceless_notifications';
const NOTIF_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function loadNotifications() {
    try {
        const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
        if (!raw) return [];
        const items = JSON.parse(raw);
        const cutoff = Date.now() - NOTIF_MAX_AGE_MS;
        return items.filter(n => n.timestamp > cutoff);
    } catch { return []; }
}

function saveNotifications(items) {
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(items));
}

function addNotification(title, body, type = 'success') {
    const items = loadNotifications();
    items.unshift({ title, body, type, timestamp: Date.now(), read: false });
    // Keep max 50 entries
    if (items.length > 50) items.length = 50;
    saveNotifications(items);
    renderNotifList();
    updateNotifBadge();
}

function renderNotifList() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    const items = loadNotifications();
    if (items.length === 0) {
        list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
        return;
    }
    list.replaceChildren();
    const allowedTypes = new Set(['success', 'error', 'cancel', 'warning', 'info']);
    items.forEach((n, i) => {
        const item = document.createElement('div');
        item.className = `notif-item${n.read ? '' : ' unread'}`;
        item.dataset.notifIndex = String(i);

        const dot = document.createElement('div');
        dot.className = `notif-dot ${allowedTypes.has(n.type) ? n.type : 'info'}`;

        const body = document.createElement('div');
        body.className = 'notif-body';
        const title = document.createElement('div');
        title.className = 'notif-title';
        title.textContent = n.title || '';
        const description = document.createElement('div');
        description.className = 'notif-desc';
        description.textContent = n.body || '';
        body.append(title, description);

        const time = document.createElement('div');
        time.className = 'notif-time';
        time.textContent = formatNotifTime(n.timestamp);

        item.append(dot, body, time);
        list.appendChild(item);
    });
}

function updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    const unread = loadNotifications().filter(n => !n.read).length;
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
}

function markAllRead() {
    const items = loadNotifications();
    items.forEach(n => n.read = true);
    saveNotifications(items);
    updateNotifBadge();
    renderNotifList();
}

function clearAllNotifications() {
    saveNotifications([]);
    renderNotifList();
    updateNotifBadge();
}

function formatNotifTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function setupNotifCenter() {
    const bell = document.getElementById('notif-bell');
    const dropdown = document.getElementById('notif-dropdown');
    const clearBtn = document.getElementById('notif-clear');
    if (!bell || !dropdown) return;

    bell.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !dropdown.classList.contains('hidden');
        if (isOpen) {
            dropdown.classList.add('hidden');
        } else {
            dropdown.classList.remove('hidden');
            markAllRead();
        }
    });

    clearBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAllNotifications();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.notif-center')) {
            dropdown.classList.add('hidden');
        }
    });

    // Initial render
    renderNotifList();
    updateNotifBadge();
}

function showNotification(title, body, type = 'success') {
    // Store in notification center
    addNotification(title, body, type);

    // OS-level notification
    if (window.electronAPI?.showNotification) {
        window.electronAPI.showNotification(title, body);
    } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
    }
    // Also show a persistent banner in-app
    const isCancelled = type === 'cancel';
    document.querySelector('.completion-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = `completion-banner ${isCancelled ? 'banner-cancel' : ''}`;
    const icon = document.createElement('span');
    icon.className = 'completion-icon';
    icon.textContent = isCancelled ? '✕' : '✓';
    const text = document.createElement('div');
    text.className = 'completion-text';
    const heading = document.createElement('strong');
    heading.textContent = title || '';
    const description = document.createElement('span');
    description.textContent = body || '';
    text.append(heading, description);
    const close = document.createElement('button');
    close.className = 'completion-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close notification');
    close.textContent = '×';
    banner.append(icon, text, close);
    document.body.appendChild(banner);
    setTimeout(() => banner.classList.add('show'), 10);
    close.addEventListener('click', () => {
        banner.classList.remove('show');
        setTimeout(() => banner.remove(), 300);
    });
    // Auto-dismiss after 30s
    setTimeout(() => { if (banner.parentNode) { banner.classList.remove('show'); setTimeout(() => banner.remove(), 300); } }, 30000);
}
function showToast(message, type = 'info') {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}
function formatTime(s, precise) {
    if (state.timeline?.rulerSecondsOnly) {
        return precise ? `${s.toFixed(2)}s` : `${Math.floor(s)}s`;
    }
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (precise) {
        // Show M:SS.ff (2 decimal places)
        return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
    }
    return `${m}:${Math.floor(sec).toString().padStart(2, '0')}`;
}

function clearScenes() {
    // Stop playback and clean up
    stopPlayback();
    cleanupVideoHandlers();

    // Reset state
    state.scenes = [];
    state.videoPlan = null;
    window._mgBridgeVideoPlan = null;
    state.currentSceneIndex = 0;
    state.currentTime = 0;
    state.totalDuration = 0;
    state.isPlaying = false;
    state.playbackAnimationFrame = null;
    state.transition.isTransitioning = false;
    state.transition.activeVideoIndex = 0;

    // Clear UI
    elements.sceneList.innerHTML = '<p class="empty-state">No scenes yet</p>';
    elements.timelineContainer.innerHTML = '<div class="timeline-header"><span>Timeline</span><span>0:00</span></div><div class="timeline-empty">Import audio to see timeline</div>';

    // Reset video elements using helper
    if (elements.previewVideo) {
        elements.previewVideo.pause();
        elements.previewVideo.currentTime = 0;
        elements.previewVideo.src = '';
        resetVideoTransitionState(elements.previewVideo);
    }
    if (elements.previewVideoNext) {
        elements.previewVideoNext.pause();
        elements.previewVideoNext.currentTime = 0;
        elements.previewVideoNext.src = '';
        resetVideoTransitionState(elements.previewVideoNext);
    }

    // Hide video container, show placeholder
    if (elements.videoContainer) {
        elements.videoContainer.classList.add('hidden');
        elements.videoContainer.className = 'video-transition-container hidden';
    }
    if (elements.videoControls) {
        elements.videoControls.classList.add('hidden');
    }
    elements.previewPlaceholder.classList.remove('hidden');

    // Reset audio element
    if (elements.previewAudio) {
        elements.previewAudio.pause();
        elements.previewAudio.currentTime = 0;
    }
}

// ========================================
// Style Learner — Reference Style Dropdown + Learn Dialog
// ========================================
async function refreshStyleProfileDropdown() {
    const sel = elements.buildStyleProfile;
    if (!sel || !window.electronAPI?.scanStyleProfiles) return;
    try {
        const profiles = await window.electronAPI.scanStyleProfiles();
        const prevValue = sel.value;
        // Reset, keeping "None"
        sel.innerHTML = '<option value="none">None (AI decides)</option>';
        for (const p of (profiles || [])) {
            const opt = document.createElement('option');
            opt.value = p.path;
            const dur = p.videoDuration ? ` · ${Math.round(p.videoDuration / 60)}min` : '';
            opt.textContent = `${p.name || 'unnamed'}${dur}`;
            sel.appendChild(opt);
        }
        // Restore selection (current value, or pending from loadSettings, or "none")
        const restore = state._pendingStyleProfile || prevValue || 'none';
        if (Array.from(sel.options).some(o => o.value === restore)) {
            sel.value = restore;
        } else {
            sel.value = 'none';
        }
        delete state._pendingStyleProfile;
    } catch (e) {
        console.warn('[StyleLearner] Failed to scan style profiles:', e?.message || e);
    }
}

function setupStyleLearner() {
    if (!elements.btnLearnStyle) return;

    // Save selection on change
    if (elements.buildStyleProfile) {
        elements.buildStyleProfile.addEventListener('change', saveSettings);
    }

    // Open Style Studio (replaces the old inline learn dialog)
    elements.btnLearnStyle.addEventListener('click', async () => {
        try {
            if (window.electronAPI?.openStyleStudio) {
                await window.electronAPI.openStyleStudio();
            } else {
                // Fallback to legacy inline dialog if studio IPC missing
                const dlg = elements.learnStyleDialog;
                if (dlg) dlg.style.display = (dlg.style.display === 'none' ? 'block' : 'none');
            }
        } catch (e) {
            console.error('[StyleStudio] Failed to open:', e);
        }
    });

    // Mode toggle: single vs multi
    if (elements.learnStyleMode) {
        elements.learnStyleMode.addEventListener('change', () => {
            const isMulti = elements.learnStyleMode.value === 'multi';
            if (elements.learnStyleUrl) elements.learnStyleUrl.style.display = isMulti ? 'none' : 'block';
            if (elements.learnStyleUrls) elements.learnStyleUrls.style.display = isMulti ? 'block' : 'none';
            if (elements.learnStyleName) elements.learnStyleName.style.display = isMulti ? 'block' : 'none';
            if (elements.learnStyleBrowse) elements.learnStyleBrowse.style.display = isMulti ? 'none' : '';
        });
    }

    // Cancel
    if (elements.learnStyleCancel) {
        elements.learnStyleCancel.addEventListener('click', () => {
            elements.learnStyleDialog.style.display = 'none';
            elements.learnStyleProgress.style.display = 'none';
            elements.learnStyleUrl.value = '';
            if (elements.learnStyleUrls) elements.learnStyleUrls.value = '';
            if (elements.learnStyleName) elements.learnStyleName.value = '';
        });
    }

    // Browse local file
    if (elements.learnStyleBrowse) {
        elements.learnStyleBrowse.addEventListener('click', async () => {
            if (!window.electronAPI?.pickVideoFile) return;
            try {
                const filePath = await window.electronAPI.pickVideoFile();
                if (filePath) elements.learnStyleUrl.value = filePath;
            } catch (e) {
                console.warn('[StyleLearner] file pick failed:', e?.message || e);
            }
        });
    }

    // Listen to progress events from main process
    if (window.electronAPI?.onLearnStyleProgress) {
        window.electronAPI.onLearnStyleProgress((data) => {
            if (!elements.learnStyleBar || !elements.learnStyleMsg) return;
            const pct = Math.max(0, Math.min(100, data.percent || 0));
            elements.learnStyleBar.style.width = `${pct}%`;
            elements.learnStyleMsg.textContent = data.message || `${pct}%`;
        });
    }

    // Start analysis (single or multi)
    if (elements.learnStyleStart) {
        elements.learnStyleStart.addEventListener('click', async () => {
            const isMulti = elements.learnStyleMode?.value === 'multi';

            if (isMulti) {
                // Multi-video channel learning
                const urlsRaw = (elements.learnStyleUrls?.value || '').trim();
                const urls = urlsRaw.split('\n').map(u => u.trim()).filter(Boolean);
                if (urls.length === 0) {
                    showToast('Enter at least one YouTube URL (one per line)', 'error');
                    return;
                }
                if (!window.electronAPI?.learnStyleMulti) {
                    showToast('Multi-video learning not available', 'error');
                    return;
                }
                const profileName = (elements.learnStyleName?.value || '').trim() || undefined;
                elements.learnStyleProgress.style.display = 'block';
                elements.learnStyleBar.style.width = '0%';
                elements.learnStyleMsg.textContent = `Analyzing ${urls.length} videos...`;
                elements.learnStyleStart.disabled = true;
                try {
                    const result = await window.electronAPI.learnStyleMulti(urls, profileName);
                    if (result && result.success) {
                        elements.learnStyleBar.style.width = '100%';
                        const mergedLabel = result.profile?.mergedFrom ? ` (merged from ${result.profile.mergedFrom} videos)` : '';
                        elements.learnStyleMsg.textContent = `Done: ${result.profile?.name || 'profile'}${mergedLabel}`;
                        showToast(`Channel style learned: ${result.profile?.name || 'profile'}${mergedLabel}`, 'success');
                        await refreshStyleProfileDropdown();
                        if (result.path) {
                            elements.buildStyleProfile.value = result.path;
                            saveSettings();
                        }
                        setTimeout(() => {
                            elements.learnStyleDialog.style.display = 'none';
                            elements.learnStyleProgress.style.display = 'none';
                            elements.learnStyleUrls.value = '';
                            if (elements.learnStyleName) elements.learnStyleName.value = '';
                        }, 2000);
                    } else {
                        const err = (result && result.error) || 'Unknown error';
                        elements.learnStyleMsg.textContent = `Error: ${err}`;
                        showToast(`Multi-learn failed: ${err}`, 'error');
                    }
                } catch (e) {
                    elements.learnStyleMsg.textContent = `Error: ${e.message || e}`;
                    showToast(`Multi-learn error: ${e.message || e}`, 'error');
                } finally {
                    elements.learnStyleStart.disabled = false;
                }
            } else {
                // Single video learning (existing flow)
                const input = (elements.learnStyleUrl.value || '').trim();
                if (!input) {
                    showToast('Enter a YouTube URL or pick a local video file', 'error');
                    return;
                }
                if (!window.electronAPI?.learnStyle) {
                    showToast('Style Learner not available', 'error');
                    return;
                }
                elements.learnStyleProgress.style.display = 'block';
                elements.learnStyleBar.style.width = '0%';
                elements.learnStyleMsg.textContent = 'Starting...';
                elements.learnStyleStart.disabled = true;
                try {
                    const result = await window.electronAPI.learnStyle(input);
                    if (result && result.success) {
                        elements.learnStyleBar.style.width = '100%';
                        elements.learnStyleMsg.textContent = `Done: ${result.profile?.name || 'profile'}`;
                        showToast(`Learned style: ${result.profile?.name || 'profile'}`, 'success');
                        await refreshStyleProfileDropdown();
                        if (result.path) {
                            elements.buildStyleProfile.value = result.path;
                            saveSettings();
                        }
                        setTimeout(() => {
                            elements.learnStyleDialog.style.display = 'none';
                            elements.learnStyleProgress.style.display = 'none';
                            elements.learnStyleUrl.value = '';
                        }, 1500);
                    } else {
                        const err = (result && result.error) || 'Unknown error';
                        elements.learnStyleMsg.textContent = `Error: ${err}`;
                        showToast(`Style learner failed: ${err}`, 'error');
                    }
                } catch (e) {
                    elements.learnStyleMsg.textContent = `Error: ${e.message || e}`;
                    showToast(`Style learner error: ${e.message || e}`, 'error');
                } finally {
                    elements.learnStyleStart.disabled = false;
                }
            }
        });
    }

    // Compare style with current build
    if (elements.btnCompareStyle) {
        elements.btnCompareStyle.addEventListener('click', async () => {
            const profilePath = elements.buildStyleProfile?.value;
            if (!profilePath || profilePath === 'none') {
                showToast('Select a style profile first', 'error');
                return;
            }
            if (!state.videoPlan || !state.videoPlan.scenes?.length) {
                showToast('Load a video plan first (run a build or load a project)', 'error');
                return;
            }
            if (!window.electronAPI?.compareStyle) {
                showToast('Style comparison not available', 'error');
                return;
            }
            try {
                const result = await window.electronAPI.compareStyle(profilePath, state.videoPlan);
                if (result && result.success && elements.styleComparisonText) {
                    elements.styleComparisonText.textContent = result.report;
                    elements.styleComparisonReport.style.display = 'block';
                } else {
                    showToast(`Comparison failed: ${result?.error || 'unknown'}`, 'error');
                }
            } catch (e) {
                showToast(`Comparison error: ${e.message || e}`, 'error');
            }
        });
    }

    // Close comparison report
    if (elements.styleComparisonClose) {
        elements.styleComparisonClose.addEventListener('click', () => {
            if (elements.styleComparisonReport) elements.styleComparisonReport.style.display = 'none';
        });
    }

    // Initial population
    refreshStyleProfileDropdown();

}

const PRODUCTION_MODE_PROFILES = Object.freeze({
    faceless: {
        title: 'Faceless production',
        badge: 'B-roll',
        description: 'Narration drives an agentic edit built from sourced B-roll, motion graphics, transitions, and sound design.',
        steps: ['Narration', 'AI direction', 'Matched media', 'Motion graphics', 'Render'],
        generateLabel: 'Generate Faceless Video',
    },
    talkingHead: {
        title: 'Talking-head production',
        badge: 'Presenter + B-roll',
        description: 'Narration drives the full edit while a recurring presenter appears at selected high-value beats.',
        steps: ['Narration', 'Presenter', 'Supporting B-roll', 'Graphics', 'Render'],
        generateLabel: 'Generate Talking-Head Video',
    },
});

function _syncFastMediaUI() {
    const mode = elements.buildProductionMode?.value || 'faceless';
    const active = !!elements.fastMediaToggle?.checked;
    elements.fastMediaGroup?.classList.toggle('diagnostic-active', active);
    if (elements.fastMediaGroup && active) elements.fastMediaGroup.open = true;
    if (elements.fastMediaHint) {
        elements.fastMediaHint.textContent = active
            ? 'TEST MODE ACTIVE: unique random footage is used. Semantic asset searches, footage relevance vision, icon/subject acquisition, and bespoke overlay authoring are skipped. Stage authoring and Motion QA remain active.'
            : 'OFF for production. One-shot mode uses unique random footage and skips semantic asset searches, footage relevance vision, icon/subject acquisition, and bespoke overlay authoring. Stage authoring and Motion QA remain active. It automatically returns to OFF after launch.';
    }
    if (elements.btnGenerate) {
        const profile = PRODUCTION_MODE_PROFILES[mode] || PRODUCTION_MODE_PROFILES.faceless;
        elements.btnGenerate.textContent = active
            ? 'Run Pipeline Test (Random Media)'
            : profile.generateLabel;
    }
}

function _showSettingsTab(name, { persist = true } = {}) {
    const btns = Array.from(document.querySelectorAll('.settings-tabs .stab-btn'));
    const panels = Array.from(document.querySelectorAll('.stab-panel'));
    const target = btns.find((button) => button.dataset.stab === name && !button.classList.contains('mode-hidden'))
        || btns.find((button) => !button.classList.contains('mode-hidden'));
    if (!target) return;
    btns.forEach((button) => button.classList.toggle('active', button === target));
    panels.forEach((panel) => panel.classList.toggle('active', panel.dataset.stab === target.dataset.stab));
    if (persist) {
        try { localStorage.setItem('faceless-settings-tab', target.dataset.stab); } catch (_) {}
    }
}

function _syncProductionModeUI() {
    const mode = elements.buildProductionMode ? elements.buildProductionMode.value : 'faceless';
    const profile = PRODUCTION_MODE_PROFILES[mode] || PRODUCTION_MODE_PROFILES.faceless;

    document.body.classList.remove('mode-faceless', 'mode-talkingHead');
    document.body.classList.add(`mode-${mode}`);

    if (elements.productionModeSummaryTitle) elements.productionModeSummaryTitle.textContent = profile.title;
    if (elements.productionModeSummaryBadge) elements.productionModeSummaryBadge.textContent = profile.badge;
    if (elements.productionModeSummaryDescription) elements.productionModeSummaryDescription.textContent = profile.description;
    if (elements.productionModeSummarySteps) {
        elements.productionModeSummarySteps.replaceChildren(...profile.steps.map((step) => {
            const item = document.createElement('span');
            item.className = 'mode-step';
            item.textContent = step;
            return item;
        }));
    }

    if (elements.mediaTabLabel) elements.mediaTabLabel.textContent = 'Media';
    if (elements.buildTabLabel) elements.buildTabLabel.textContent = 'Build';
    if (elements.inputSourceHeading) elements.inputSourceHeading.textContent = 'Import narration';
    if (elements.btnGenerate) elements.btnGenerate.textContent = profile.generateLabel;
    if (elements.btnRepeatStep) elements.btnRepeatStep.textContent = 'Repeat Selected Step';
    _syncRepeatStepUI();
    if (elements.buildQuality) {
        const labels = {
            mini: 'Mini (Fast, Images Only)',
            standard: 'Standard (Balanced)',
            pro: 'Pro (Best Quality)',
        };
        for (const option of elements.buildQuality.options) {
            if (labels[option.value]) option.textContent = labels[option.value];
        }
    }
    if (elements.buildQualityHint) {
        elements.buildQualityHint.textContent = 'Controls scene count, transitions, motion-graphics density, and build depth.';
    }
    if (elements.aiInstructionsHint) {
        elements.aiInstructionsHint.textContent = 'Sent to every decision brain — Director, Visual Planner, templates, motion graphics, effects. Highest priority.';
    }

    if (elements.veoAiVideoEnabled) {
        elements.veoAiVideoEnabled.classList.remove('mode-hidden');
        elements.veoAiVideoEnabled.disabled = false;
    }
    if (elements.veoAiVideoToggleRow) elements.veoAiVideoToggleRow.style.cursor = 'pointer';
    if (elements.veoAiVideoTitle) elements.veoAiVideoTitle.textContent = '🎬 AI Video — generate select scenes';
    elements.veoAiVideoModeBadge?.classList.add('hidden');
    if (elements.veoAiVideoDescription) {
        elements.veoAiVideoDescription.textContent = 'Optional hybrid mode: generate selected B-roll scenes instead of downloading them.';
    }
    elements.veoScopeGroup?.classList.remove('mode-hidden');
    _syncVeoRow();

    if (elements.fallbackMediaSettings) {
        elements.fallbackMediaSettings.classList.add('primary-media-settings');
        elements.fallbackMediaSettings.classList.remove('fallback-media-settings');
        if (elements.fallbackMediaSettings.dataset.profile !== 'primary') {
            elements.fallbackMediaSettings.dataset.profile = 'primary';
            elements.fallbackMediaSettings.open = true;
        }
    }

    const activeHidden = document.querySelector('.settings-tabs .stab-btn.active.mode-hidden');
    if (activeHidden) _showSettingsTab('setup');
    _syncAudioGate();
    const previewHint = elements.previewPlaceholder?.querySelector('.small');
    if (previewHint && state.scenes.length === 0) {
        previewHint.textContent = 'Import audio to get started';
    }
    _syncFastMediaUI();
    _syncGenerateAvailability();
}

// Show/hide the presenter-image picker based on production mode + reflect the stored path.
function _syncPresenterRow() {
    if (!elements.presenterImageRow) return;
    const isTH = elements.buildProductionMode && elements.buildProductionMode.value === 'talkingHead';
    elements.presenterImageRow.style.display = isTH ? 'block' : 'none';
    if (elements.presenterImagePath) elements.presenterImagePath.value = state.presenterImage || '';
    // Kling avatar options (resolution + delivery prompt) show only when the toggle is on.
    if (elements.klingAvatarOpts && elements.klingAvatarEnabled) {
        elements.klingAvatarOpts.style.display = elements.klingAvatarEnabled.checked ? 'block' : 'none';
    }
}

// AI Video (Veo) options show only when the toggle is on.
function _syncVeoRow() {
    if (elements.veoAiVideoOpts && elements.veoAiVideoEnabled) {
        elements.veoAiVideoOpts.style.display = elements.veoAiVideoEnabled.checked ? 'block' : 'none';
    }
}

// Settings tabs — click a tab to show its group (no long scroll). Active tab persists.
function _initSettingsTabs() {
    const bar = document.getElementById('settings-tabs');
    if (!bar) return;
    const btns = Array.from(bar.querySelectorAll('.stab-btn'));
    btns.forEach(b => b.addEventListener('click', () => _showSettingsTab(b.dataset.stab)));
    let saved = 'setup';
    try { saved = localStorage.getItem('faceless-settings-tab') || 'setup'; } catch (_) {}
    if (!btns.some(b => b.dataset.stab === saved && !b.classList.contains('mode-hidden'))) saved = 'setup';
    _showSettingsTab(saved, { persist: false });
    _initSettingsKeyScroll();
}

// Keyboard scrolling for the settings panel: click empty space (or a tab) to focus it,
// then Arrow/PageUp/PageDown/Home/End scroll it. Text fields, selects, number inputs and
// sliders keep their own arrow behavior (we don't hijack keys while they're focused).
function _initSettingsKeyScroll() {
    const lp = document.getElementById('left-panel');
    if (!lp || lp.dataset.keyScroll) return;
    lp.dataset.keyScroll = '1';
    lp.setAttribute('tabindex', '0');
    lp.style.outline = 'none';
    lp.addEventListener('mousedown', (e) => {
        if (!e.target.closest('input,select,textarea,button,a,[contenteditable]')) {
            lp.focus({ preventScroll: true });
        }
    });
    lp.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t !== lp) {
            const tag = t.tagName;
            if (tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
            if (tag === 'INPUT') {
                const ty = (t.type || '').toLowerCase();
                if (['range', 'number', 'text', 'search', 'url', 'email', 'password'].includes(ty)) return;
            }
        }
        const pageStep = Math.max(120, lp.clientHeight * 0.9), lineStep = 48;
        switch (e.key) {
            case 'ArrowDown': lp.scrollTop += lineStep; break;
            case 'ArrowUp': lp.scrollTop -= lineStep; break;
            case 'PageDown': lp.scrollTop += pageStep; break;
            case 'PageUp': lp.scrollTop -= pageStep; break;
            case 'Home': lp.scrollTop = 0; break;
            case 'End': lp.scrollTop = lp.scrollHeight; break;
            default: return;
        }
        e.preventDefault();
    });
}

function saveSettings() {
    localStorage.setItem('faceless-settings', JSON.stringify({
        // Element-backed settings come from the schema (single source of truth).
        ...SettingsIO.collect('ls'),
        // State-backed + special settings (no simple element control) stay explicit.
        volume: state.volume,
        footageSources: getEnabledSources(),
        subtitlesEnabled: state.subtitlesEnabled,
        mutedTracks: state.mutedTracks,
        presenterImage: state.presenterImage || '',
        buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
    }));
    // Also trigger .fvp auto-save so settings persist per-project
    triggerAutoSave();
    // Push live project context to the Style Studio agent (main process) so it
    // knows the current video title / niche / instructions even without a .fvp.
    try {
        window.electronAPI?.styleStudioSetProjectContext?.({
            videoTitle: state.videoTitle,
            aiInstructions: state.aiInstructions,
            buildNiche: elements.buildNiche ? elements.buildNiche.value : 'auto',
            buildLanguage: elements.buildLanguage ? elements.buildLanguage.value : 'auto',
            buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
        });
    } catch (_) {}
}

function getEnabledSources() {
    return {
        storyblocks: elements.srcStoryblocks?.checked === true,
        pexels: elements.srcPexels?.checked ?? true,
        pixabay: elements.srcPixabay?.checked ?? true,
        youtube: elements.srcYouTube?.checked ?? true,
        reddit: elements.srcReddit?.checked ?? true,
        bing: elements.srcBing?.checked ?? true,
        brave: elements.srcBrave?.checked ?? true,
    };
}

function getFootageResourceSettings() {
    return {
        clipAnalyzer: elements.clipAnalyzerToggle?.checked !== false,
        footageSources: getEnabledSources(),
    };
}

function updateFootageResourceSummary() {
    if (!elements.footageResourceSummary) return;
    const settings = getFootageResourceSettings();
    const active = Object.entries(settings.footageSources)
        .filter(([, enabled]) => enabled)
        .map(([name]) => ({
            storyblocks: 'Storyblocks',
            pexels: 'Pexels',
            pixabay: 'Pixabay',
            youtube: 'YouTube',
            reddit: 'Reddit',
            bing: 'Bing',
            brave: 'Brave',
        }[name] || name));
    const analyzer = settings.clipAnalyzer ? 'Analyzer on' : 'Analyzer off';
    elements.footageResourceSummary.textContent = `${analyzer} • ${active.length || 0} provider${active.length === 1 ? '' : 's'} active`;
    elements.footageResourceSummary.title = active.length ? active.join(', ') : 'No footage providers enabled';
}

function applyFootageResourceSettings(settings, options = {}) {
    if (!settings) return;
    const sources = settings.footageSources || settings.sources || {};
    if (elements.clipAnalyzerToggle) elements.clipAnalyzerToggle.checked = settings.clipAnalyzer !== false;
    if (elements.srcStoryblocks) elements.srcStoryblocks.checked = sources.storyblocks === true;
    if (elements.srcPexels) elements.srcPexels.checked = sources.pexels !== false;
    if (elements.srcPixabay) elements.srcPixabay.checked = sources.pixabay !== false;
    if (elements.srcYouTube) elements.srcYouTube.checked = sources.youtube !== false;
    if (elements.srcReddit) elements.srcReddit.checked = sources.reddit !== false;
    if (elements.srcBing) elements.srcBing.checked = sources.bing !== false;
    if (elements.srcBrave) elements.srcBrave.checked = sources.brave !== false;
    updateFootageResourceSummary();
    if (options.save) saveSettings();
}

function syncFootageResourcesToMainProcess() {
    updateFootageResourceSummary();
    const sync = window.electronAPI?.footageResourcesSet?.(getFootageResourceSettings());
    if (sync && typeof sync.catch === 'function') sync.catch(() => {});
}

function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem('faceless-settings'));
        if (s) {
            SettingsIO.apply(s, 'ls'); // baseline: restore every element-backed setting from the schema
            if (elements.smartAiToggle) elements.smartAiToggle.checked = s.smartAI !== false;
            elements.aiProvider.value = s.aiProvider || 'bedrock';
            // Sync the restored brain choice into the main process env
            if (window.electronAPI?.setAiProvider && elements.aiProvider.value) {
                window.electronAPI.setAiProvider(elements.aiProvider.value).catch(() => {});
            }
            state.volume = s.volume !== undefined ? s.volume : 1;
            if (elements.volumeSlider) {
                elements.volumeSlider.value = state.volume;
            }
            // Restore Subtitles setting
            state.subtitlesEnabled = s.subtitlesEnabled !== undefined ? s.subtitlesEnabled : false;
            if (elements.subtitlesEnabled) elements.subtitlesEnabled.checked = state.subtitlesEnabled;
            // Title/instructions are project-scoped. Global app settings must
            // never overwrite fields already restored from the active project.
            // Restore Niche Preset
            if (elements.buildNiche && s.buildNiche) elements.buildNiche.value = s.buildNiche;
            if (elements.buildMapStylePack && s.buildMapStylePack) elements.buildMapStylePack.value = s.buildMapStylePack;
            if (elements.buildProductionMode && s.buildProductionMode) elements.buildProductionMode.value = s.buildProductionMode;
            state.presenterImage = s.presenterImage || '';
            if (elements.klingAvatarEnabled) elements.klingAvatarEnabled.checked = !!s.klingAvatar;
            if (elements.klingResolution && s.klingResolution) elements.klingResolution.value = s.klingResolution;
            if (elements.klingAvatarPrompt) elements.klingAvatarPrompt.value = s.klingAvatarPrompt || '';
            if (elements.veoAiVideoEnabled) elements.veoAiVideoEnabled.checked = !!s.veoAiVideo;
            if (elements.veoScope && s.veoScope) elements.veoScope.value = s.veoScope;
            if (elements.veoResolution && s.veoResolution) elements.veoResolution.value = s.veoResolution;
            if (elements.veoBackend && s.veoBackend) elements.veoBackend.value = s.veoBackend;
            if (elements.fastMediaToggle) elements.fastMediaToggle.checked = false;
            _syncPresenterRow();
            _syncVeoRow();
            _syncProductionModeUI();
            if (elements.buildVisionBackend && s.buildVisionBackend) elements.buildVisionBackend.value = s.buildVisionBackend;
            if (elements.buildLanguage && s.buildLanguage) elements.buildLanguage.value = s.buildLanguage;
            if (elements.buildStyleProfile && s.buildStyleProfile) {
                // Defer setting until dropdown is populated
                state._pendingStyleProfile = s.buildStyleProfile;
            }
            // Restore Clip Analyzer toggle
            if (elements.clipAnalyzerToggle) elements.clipAnalyzerToggle.checked = s.clipAnalyzer !== false;
            if (elements.repeatFromStep) elements.repeatFromStep.value = s.repeatFromStep || 'visual-planner';
            if (elements.forceFreshFootage) elements.forceFreshFootage.checked = s.forceFreshFootage === true;
            _syncRepeatStepUI();
            // Restore track mute state
            if (s.mutedTracks) state.mutedTracks = s.mutedTracks;
            // Restore footage source toggles
            if (s.footageSources) {
                if (elements.srcStoryblocks) elements.srcStoryblocks.checked = s.footageSources.storyblocks === true;
                if (elements.srcPexels) elements.srcPexels.checked = s.footageSources.pexels ?? true;
                if (elements.srcPixabay) elements.srcPixabay.checked = s.footageSources.pixabay ?? true;
                if (elements.srcYouTube) elements.srcYouTube.checked = s.footageSources.youtube ?? true;
                if (elements.srcReddit) elements.srcReddit.checked = s.footageSources.reddit ?? true;
                if (elements.srcBing) elements.srcBing.checked = s.footageSources.bing ?? true;
                if (elements.srcBrave) elements.srcBrave.checked = s.footageSources.brave ?? true;
            }
            syncFootageResourcesToMainProcess();
        }
    } catch (e) { }
}

// Apply settings from .fvp project file (same logic as loadSettings but from object, not localStorage)
function applyProjectSettings(s, { projectFieldOverride = null } = {}) {
    if (!s) return;
    try {
        SettingsIO.apply(s, 'fvp'); // baseline: restore every element-backed setting from the schema
        elements.aiProvider.value = s.aiProvider || 'bedrock';
        state.volume = s.volume !== undefined ? s.volume : 1;
        if (elements.volumeSlider) elements.volumeSlider.value = state.volume;
        // Subtitles
        state.subtitlesEnabled = s.subtitlesEnabled !== undefined ? s.subtitlesEnabled : false;
        if (elements.subtitlesEnabled) elements.subtitlesEnabled.checked = state.subtitlesEnabled;
        // Video Title and AI instructions are project-scoped. During a fresh-build
        // reload, the live UI snapshot wins over a stale .fvp settings envelope.
        const hasOverride = projectFieldOverride && typeof projectFieldOverride === 'object';
        const titleValue = hasOverride && Object.prototype.hasOwnProperty.call(projectFieldOverride, 'videoTitle')
            ? projectFieldOverride.videoTitle
            : s.videoTitle;
        const instructionsValue = hasOverride && Object.prototype.hasOwnProperty.call(projectFieldOverride, 'aiInstructions')
            ? projectFieldOverride.aiInstructions
            : s.aiInstructions;
        state.videoTitle = String(titleValue ?? '');
        if (elements.videoTitle) elements.videoTitle.value = state.videoTitle;
        state.aiInstructions = String(instructionsValue ?? '');
        if (elements.aiInstructions) elements.aiInstructions.value = state.aiInstructions;
        // Niche Preset
        if (elements.buildNiche && s.buildNiche) elements.buildNiche.value = s.buildNiche;
        if (elements.buildMapStylePack && s.buildMapStylePack) elements.buildMapStylePack.value = s.buildMapStylePack;
        if (elements.buildProductionMode && s.buildProductionMode) elements.buildProductionMode.value = s.buildProductionMode;
        state.presenterImage = s.presenterImage || '';
        if (elements.klingAvatarEnabled) elements.klingAvatarEnabled.checked = !!s.klingAvatar;
        if (elements.klingResolution && s.klingResolution) elements.klingResolution.value = s.klingResolution;
        if (elements.klingAvatarPrompt) elements.klingAvatarPrompt.value = s.klingAvatarPrompt || '';
        if (elements.veoAiVideoEnabled) elements.veoAiVideoEnabled.checked = !!s.veoAiVideo;
        if (elements.veoScope && s.veoScope) elements.veoScope.value = s.veoScope;
        if (elements.veoResolution && s.veoResolution) elements.veoResolution.value = s.veoResolution;
        if (elements.veoBackend && s.veoBackend) elements.veoBackend.value = s.veoBackend;
        if (elements.fastMediaToggle) elements.fastMediaToggle.checked = false;
        _syncPresenterRow();
        _syncVeoRow();
        _syncProductionModeUI();
        if (elements.buildVisionBackend && s.buildVisionBackend) elements.buildVisionBackend.value = s.buildVisionBackend;
        if (elements.buildLanguage && s.buildLanguage) elements.buildLanguage.value = s.buildLanguage;
        if (elements.repeatFromStep && s.repeatFromStep) elements.repeatFromStep.value = s.repeatFromStep;
        if (elements.forceFreshFootage) elements.forceFreshFootage.checked = s.forceFreshFootage === true;
        _syncRepeatStepUI();
        // Track mute
        if (s.mutedTracks) state.mutedTracks = s.mutedTracks;
        // Footage sources
        if (s.footageSources) {
            if (elements.srcStoryblocks) elements.srcStoryblocks.checked = s.footageSources.storyblocks === true;
            if (elements.srcPexels) elements.srcPexels.checked = s.footageSources.pexels ?? true;
            if (elements.srcPixabay) elements.srcPixabay.checked = s.footageSources.pixabay ?? true;
            if (elements.srcYouTube) elements.srcYouTube.checked = s.footageSources.youtube ?? true;
            if (elements.srcReddit) elements.srcReddit.checked = s.footageSources.reddit ?? true;
            if (elements.srcBing) elements.srcBing.checked = s.footageSources.bing ?? true;
            if (elements.srcBrave) elements.srcBrave.checked = s.footageSources.brave ?? true;
        }
        syncFootageResourcesToMainProcess();
        console.log('✅ Applied project settings from .fvp file');
    } catch (e) {
        console.warn('Could not apply project settings:', e);
    }
}

// Audio import (and therefore building) requires a project, so the build has a real
// home on disk. In the default workspace the drop zone is locked and points the user
// at "New Project"; once a project is open it works normally.
function _requireProject() {
    if (state.hasProject) return true;
    showToast('📁 Create or open a project first — then add narration or a story source', 'info');
    return false;
}

function _syncAudioGate() {
    const dz = elements.dropZone;
    if (!dz || state.audioFile) return; // don't clobber the loaded-audio display
    const lines = dz.querySelectorAll('p');
    const setCopy = (primary, secondary) => {
        if (lines[0]) lines[0].textContent = primary;
        if (lines[1]) lines[1].textContent = secondary;
    };
    if (state.hasProject) {
        dz.classList.remove('locked');
        dz.style.opacity = '';
        dz.style.cursor = 'pointer';
        dz.title = 'Import narration audio';
        setCopy('Drag & drop your voiceover here', 'or click to browse');
    } else {
        dz.classList.add('locked');
        dz.style.opacity = '0.55';
        dz.style.cursor = 'not-allowed';
        dz.title = 'Create or open a project first';
        setCopy('📁 Create or open a project first', 'Import unlocks once you have a project');
    }
}

async function loadProjectInfo() {
    try {
        if (!window.electronAPI.getProjectInfo) return;
        const info = await window.electronAPI.getProjectInfo();
        // A real project has a name; the default workspace does not. Audio import is
        // gated on this — you create/open a project first, then bring in your audio.
        state.hasProject = !!(info && info.projectName);
        _syncAudioGate();
        _syncGenerateAvailability();
        if (info && info.projectName && elements.projectNameLabel) {
            elements.projectNameLabel.textContent = `— ${info.projectName}`;
            elements.projectNameLabel.title = `Project: ${info.projectDir}\nClick to open folder`;
            elements.projectNameLabel.style.cursor = 'pointer';
            elements.projectNameLabel.onclick = () => {
                if (info.projectDir && window.electronAPI.openFile) {
                    window.electronAPI.openFile(info.projectDir);
                }
            };
        } else if (elements.projectNameLabel) {
            // Workspace mode (no named project yet) — Premiere-style. Everything is
            // usable; guide the user to create/open a project when they're ready.
            elements.projectNameLabel.textContent = '— No project · click New Project to start one';
            elements.projectNameLabel.title = 'You are in the default workspace. Create or open a project to save your work.';
            elements.projectNameLabel.style.cursor = 'pointer';
            elements.projectNameLabel.style.opacity = '0.7';
            elements.projectNameLabel.onclick = () => { if (typeof newProject === 'function') newProject(); };
        }
    } catch (e) {
        console.warn('Could not load project info:', e);
    }
}

async function newProject() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }

    if (window.electronAPI.launchNewInstance) {
        showNewProjectDialog();
        return;
    }

    // Compatibility fallback when the project-switch IPC is unavailable.
    resetCurrentProject();
}

async function _saveBeforeProjectSwitch() {
    if (!state.hasProject || !window.electronAPI?.saveProjectFile) {
        return { success: true, skipped: true };
    }
    const result = await saveProject(true);
    if (!result?.success) {
        throw new Error(result?.error || 'Current project could not be saved before switching.');
    }
    return result;
}

function _reloadWorkspaceForProject(projectName = 'project') {
    showToast(`Opening ${projectName} in this workspace...`, 'info');
    window.location.reload();
}

function _finishProjectOpen(result, projectName = 'Project') {
    if (result?.openedIn === 'new-instance') {
        showToast(`${projectName} opened in a new window`, 'success');
        return;
    }
    if (result?.reload === false) {
        showToast(`${projectName} is already open`, 'info');
        return;
    }
    _reloadWorkspaceForProject(projectName);
}

function showNewProjectDialog() {
    const existing = document.getElementById('new-project-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'new-project-dialog';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:26px 30px;width:560px;max-width:90vw;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    dialog.innerHTML = `
        <h2 style="margin:0 0 8px;font-size:1.2rem;color:#e0e0e0;font-weight:600;">New Project</h2>
        <p style="margin:0 0 20px;color:#999;font-size:0.88rem;line-height:1.45;">Choose exactly where the project should live. YTA will create a project marker, an empty timeline, and the project file there.</p>
        <div style="margin-bottom:18px;">
            <label style="display:block;margin-bottom:8px;font-size:0.85rem;color:#aaa;">Folder Behavior</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <label id="np-mode-selected-card" style="display:block;padding:12px;background:#25253a;border:1px solid #656ee8;border-radius:8px;cursor:pointer;">
                    <div style="display:flex;align-items:center;gap:8px;color:#fff;font-size:0.9rem;font-weight:600;">
                        <input type="radio" name="np-location-mode" value="selected-folder" checked />
                        Use selected folder
                    </div>
                    <div style="margin:6px 0 0 24px;color:#aaa;font-size:0.78rem;line-height:1.35;">Best when you already created and named the final project folder. No nested folder.</div>
                </label>
                <label id="np-mode-subfolder-card" style="display:block;padding:12px;background:#171722;border:1px solid #444;border-radius:8px;cursor:pointer;">
                    <div style="display:flex;align-items:center;gap:8px;color:#fff;font-size:0.9rem;font-weight:600;">
                        <input type="radio" name="np-location-mode" value="create-subfolder" />
                        Create a folder inside
                    </div>
                    <div style="margin:6px 0 0 24px;color:#aaa;font-size:0.78rem;line-height:1.35;">Choose a parent location and YTA creates a new folder using the project name.</div>
                </label>
            </div>
        </div>
        <div style="margin-bottom:16px;">
             <label style="display:block;margin-bottom:6px;font-size:0.85rem;color:#aaa;">Project Name</label>
             <input id="np-name" type="text" placeholder="Comes from the selected folder" value="" disabled
                    style="width:100%;padding:10px 12px;background:#12121a;border:1px solid #555;border-radius:6px;color:#fff;font-size:0.95rem;outline:none;box-sizing:border-box;" />
             <div id="np-name-hint" style="margin-top:6px;color:#777;font-size:0.78rem;">In this mode, the selected folder name becomes the project name.</div>
        </div>
        <div style="margin-bottom:20px;">
            <label id="np-location-label" style="display:block;margin-bottom:6px;font-size:0.85rem;color:#aaa;">Final Project Folder</label>
            <div style="display:flex;gap:8px;">
                <input id="np-location" type="text" readonly placeholder="Choose a folder..."
                       style="flex:1;padding:10px 12px;background:#12121a;border:1px solid #555;border-radius:6px;color:#ccc;font-size:0.85rem;outline:none;cursor:pointer;box-sizing:border-box;" />
                <button id="np-browse" style="padding:10px 16px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;cursor:pointer;font-size:0.85rem;white-space:nowrap;">Browse...</button>
            </div>
        </div>
        <div style="margin-bottom:6px;color:#777;font-size:0.76rem;text-transform:uppercase;letter-spacing:0.05em;">Project will be created at</div>
        <div id="np-preview" style="margin-bottom:10px;padding:10px 12px;background:#12121a;border:1px solid #30303f;border-radius:6px;font-size:0.8rem;color:#666;font-family:monospace;word-break:break-all;">Choose a folder...</div>
        <div id="np-status" style="min-height:18px;margin-bottom:14px;color:#ff8f8f;font-size:0.82rem;line-height:1.35;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="np-cancel" style="padding:10px 20px;background:transparent;border:1px solid #555;border-radius:6px;color:#aaa;cursor:pointer;font-size:0.9rem;">Cancel</button>
            <button id="np-create" style="padding:10px 24px;background:#4a6cf7;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:0.9rem;font-weight:600;" disabled>Create Project</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = document.getElementById('np-name');
    const nameHint = document.getElementById('np-name-hint');
    const locationInput = document.getElementById('np-location');
    const locationLabel = document.getElementById('np-location-label');
    const browseBtn = document.getElementById('np-browse');
    const previewEl = document.getElementById('np-preview');
    const statusEl = document.getElementById('np-status');
    const createBtn = document.getElementById('np-create');
    const cancelBtn = document.getElementById('np-cancel');
    const modeInputs = Array.from(dialog.querySelectorAll('input[name="np-location-mode"]'));
    const selectedModeCard = document.getElementById('np-mode-selected-card');
    const subfolderModeCard = document.getElementById('np-mode-subfolder-card');

    let selectedLocation = '';
    let locationMode = 'selected-folder';
    let editableProjectName = 'Untitled Project';
    let busy = false;

    function folderName(folderPath) {
        const cleaned = String(folderPath || '').replace(/[\\/]+$/, '');
        return cleaned.split(/[\\/]/).pop() || cleaned;
    }

    function joinedPath(parent, child) {
        return `${String(parent || '').replace(/[\\/]+$/, '')}\\${child}`;
    }

    function currentProjectName() {
        return locationMode === 'selected-folder'
            ? folderName(selectedLocation)
            : nameInput.value.trim();
    }

    function updateModeCards() {
        const selectedFolderMode = locationMode === 'selected-folder';
        selectedModeCard.style.background = selectedFolderMode ? '#25253a' : '#171722';
        selectedModeCard.style.borderColor = selectedFolderMode ? '#656ee8' : '#444';
        subfolderModeCard.style.background = selectedFolderMode ? '#171722' : '#25253a';
        subfolderModeCard.style.borderColor = selectedFolderMode ? '#444' : '#656ee8';
    }

    function updatePreview() {
        const name = currentProjectName();
        const valid = Boolean(selectedLocation && name);
        if (valid) {
            previewEl.style.color = '#888';
            previewEl.textContent = locationMode === 'selected-folder'
                ? selectedLocation
                : joinedPath(selectedLocation, name);
        } else {
            previewEl.style.color = '#666';
            previewEl.textContent = selectedLocation
                ? 'Enter a project name...'
                : 'Choose a folder...';
        }
        createBtn.disabled = busy || !valid;
        createBtn.style.opacity = createBtn.disabled ? '0.55' : '1';
        createBtn.style.cursor = createBtn.disabled ? 'not-allowed' : 'pointer';
    }

    function applyLocationMode(nextMode) {
        if (locationMode === 'create-subfolder') {
            editableProjectName = nameInput.value.trim() || editableProjectName;
        }
        locationMode = nextMode;
        const selectedFolderMode = locationMode === 'selected-folder';
        nameInput.disabled = selectedFolderMode;
        nameInput.value = selectedFolderMode
            ? folderName(selectedLocation)
            : editableProjectName;
        nameInput.placeholder = selectedFolderMode
            ? 'Comes from the selected folder'
            : 'My Video Project';
        nameInput.style.opacity = selectedFolderMode ? '0.65' : '1';
        nameHint.textContent = selectedFolderMode
            ? 'In this mode, the selected folder name becomes the project name.'
            : 'YTA creates a new folder with this name inside the selected parent location.';
        locationLabel.textContent = selectedFolderMode
            ? 'Final Project Folder'
            : 'Parent Location';
        locationInput.placeholder = selectedFolderMode
            ? 'Choose the final project folder...'
            : 'Choose the parent folder...';
        statusEl.textContent = '';
        updateModeCards();
        updatePreview();
        if (!selectedFolderMode) {
            nameInput.focus();
            nameInput.select();
        }
    }

    function setBusy(nextBusy) {
        busy = nextBusy;
        browseBtn.disabled = busy;
        cancelBtn.disabled = busy;
        modeInputs.forEach((input) => { input.disabled = busy; });
        nameInput.disabled = busy || locationMode === 'selected-folder';
        createBtn.textContent = busy ? 'Creating...' : 'Create Project';
        browseBtn.style.opacity = busy ? '0.55' : '1';
        updatePreview();
    }

    nameInput.addEventListener('input', () => {
        editableProjectName = nameInput.value;
        statusEl.textContent = '';
        updatePreview();
    });

    modeInputs.forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) applyLocationMode(input.value);
        });
    });

    browseBtn.addEventListener('click', async () => {
        const folder = await window.electronAPI.selectFolder(
            locationMode === 'selected-folder'
                ? 'Choose the final project folder'
                : 'Choose the parent folder'
        );
        if (folder) {
            selectedLocation = folder;
            locationInput.value = folder;
            if (locationMode === 'selected-folder') {
                nameInput.value = folderName(folder);
            }
            statusEl.textContent = '';
            updatePreview();
        }
    });

    locationInput.addEventListener('click', () => browseBtn.click());

    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    createBtn.addEventListener('click', async () => {
        const projectName = currentProjectName();
        if (!projectName || !selectedLocation) return;

        setBusy(true);
        statusEl.textContent = '';
        try {
            await _saveBeforeProjectSwitch();
            const result = await window.electronAPI.launchNewInstance({
                projectName,
                location: selectedLocation,
                locationMode,
            });

            if (result && result.success) {
                overlay.remove();
                _finishProjectOpen(result, `Project "${result.projectName || projectName}"`);
                return;
            }
            statusEl.textContent = result?.error || 'Failed to create project.';
        } catch (error) {
            statusEl.textContent = error?.message || 'Failed to create project.';
        } finally {
            if (overlay.isConnected) setBusy(false);
        }
    });

    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !createBtn.disabled) createBtn.click();
        if (e.key === 'Escape') overlay.remove();
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !busy) overlay.remove();
    });

    applyLocationMode('selected-folder');
}

function resetCurrentProject() {
    if (state.audioFile && !confirm('Reset current project? This clears the current work.')) return;

    stopPlayback();
    cleanupVideoHandlers();
    removeAudio();

    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    state.videoTitle = '';
    state.aiInstructions = '';
    if (elements.videoTitle) elements.videoTitle.value = '';
    if (elements.aiInstructions) elements.aiInstructions.value = '';

    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.pause();
            video.currentTime = 0;
            video.src = '';
            video._loadedUrl = null;
            video.classList.remove('active');
        }
    });
    state._trackActiveEl = { '1': 'a', '2': 'a', '3': 'a' };
    [elements.imgTrack1, elements.imgTrack2, elements.imgTrack3].forEach(img => {
        if (img) {
            img.src = '';
            img.classList.remove('active');
        }
    });

    elements.previewPlaceholder.classList.remove('hidden');
    elements.btnRender.disabled = true;
    showProgress(false);
    showToast('New project started', 'success');
}

function showOpenProjectDialog() {
    const existing = document.getElementById('open-project-dialog');
    if (existing) existing.remove();

    const previouslyFocused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const overlay = document.createElement('div');
    overlay.id = 'open-project-dialog';
    overlay.className = 'project-open-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'project-open-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'open-project-title');
    dialog.setAttribute('aria-describedby', 'open-project-description');
    dialog.innerHTML = `
        <div class="project-open-dialog__header">
            <div>
                <h2 id="open-project-title">Open Project</h2>
                <p id="open-project-description">Choose an existing project folder or a saved .fvp file.</p>
            </div>
            <button id="op-close" class="project-open-dialog__close" type="button" aria-label="Close open project dialog" title="Close">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18"></path>
                </svg>
            </button>
        </div>
        <div class="project-open-dialog__options">
            <button id="op-open-folder" class="project-open-option project-open-option--preferred" type="button">
                <span class="project-open-option__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path>
                        <path d="M3.5 9h17"></path>
                    </svg>
                </span>
                <span class="project-open-option__copy">
                    <strong>Open Project Folder</strong>
                    <small>Load a project directory with its media and settings.</small>
                </span>
                <span class="project-open-option__arrow" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>
                </span>
            </button>
            <button id="op-open-file" class="project-open-option" type="button">
                <span class="project-open-option__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <path d="M6 3.5h8l4 4V20H6z"></path>
                        <path d="M14 3.5V8h4"></path>
                        <path d="M9 13h6M9 16h4"></path>
                    </svg>
                </span>
                <span class="project-open-option__copy">
                    <strong>Open .fvp Project File</strong>
                    <small>Load a saved project from a single .fvp file.</small>
                </span>
                <span class="project-open-option__arrow" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>
                </span>
            </button>
        </div>
        <div id="op-status" class="project-open-dialog__status" role="status" aria-live="polite"></div>
        <div class="project-open-dialog__footer">
            <span class="project-open-dialog__hint"><kbd>Esc</kbd> closes this window</span>
            <button id="op-cancel" class="btn btn-secondary project-open-dialog__cancel" type="button">Cancel</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const openFolderBtn = document.getElementById('op-open-folder');
    const openFileBtn = document.getElementById('op-open-file');
    const closeBtn = document.getElementById('op-close');
    const cancelBtn = document.getElementById('op-cancel');
    const statusEl = document.getElementById('op-status');
    let isBusy = false;

    const setStatus = (text = '', tone = '') => {
        statusEl.textContent = text;
        if (tone) {
            statusEl.dataset.tone = tone;
        } else {
            delete statusEl.dataset.tone;
        }
    };

    const setBusy = (busy, text = '') => {
        isBusy = busy;
        openFolderBtn.disabled = busy;
        openFileBtn.disabled = busy;
        closeBtn.disabled = busy;
        cancelBtn.disabled = busy;
        dialog.setAttribute('aria-busy', String(busy));
        overlay.classList.toggle('is-busy', busy);
        setStatus(text, busy ? 'busy' : '');
    };

    const removeDialog = ({ force = false, restoreFocus = true } = {}) => {
        if (isBusy && !force) return;
        window.removeEventListener('keydown', handleDialogKeydown);
        overlay.remove();
        if (restoreFocus && previouslyFocused?.isConnected) {
            previouslyFocused.focus();
        }
    };

    const handleDialogKeydown = (event) => {
        if (!overlay.isConnected) {
            window.removeEventListener('keydown', handleDialogKeydown);
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            removeDialog();
            return;
        }

        if (event.key !== 'Tab') return;
        const focusable = Array.from(dialog.querySelectorAll('button:not(:disabled)'));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const runOpen = async (kind) => {
        const openFolder = window.electronAPI.openExistingProjectFolder;
        const openFile = window.electronAPI.openExistingProjectFile;
        if (!openFolder || !openFile) {
            setStatus('Open project controls are unavailable. Restart the app and try again.', 'error');
            return;
        }
        setBusy(true, kind === 'folder' ? 'Selecting project folder...' : 'Selecting .fvp project file...');
        try {
            await _saveBeforeProjectSwitch();
            const result = kind === 'folder' ? await openFolder() : await openFile();
            if (result && result.success) {
                removeDialog({ force: true, restoreFocus: false });
                _finishProjectOpen(result, 'Project');
                return;
            }
            setBusy(false, '');
            if (result && result.cancelled) return;
            setStatus(result?.error || 'The project could not be opened. Check the path and try again.', 'error');
        } catch (e) {
            setBusy(false, '');
            setStatus(e?.message || 'The project could not be opened. Check the path and try again.', 'error');
        }
    };

    openFolderBtn.addEventListener('click', () => runOpen('folder'));
    openFileBtn.addEventListener('click', () => runOpen('file'));
    closeBtn.addEventListener('click', () => removeDialog());
    cancelBtn.addEventListener('click', () => removeDialog());
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) removeDialog();
    });
    window.addEventListener('keydown', handleDialogKeydown);
    requestAnimationFrame(() => openFolderBtn.focus());
}

async function openExistingProject() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }

    // Prefer custom in-app chooser dialog (no native mode prompt popup)
    if (window.electronAPI.openExistingProjectFolder && window.electronAPI.openExistingProjectFile) {
        showOpenProjectDialog();
        return;
    }

    // Backward compatibility fallback
    if (window.electronAPI.openExistingProject) {
        try {
            await _saveBeforeProjectSwitch();
            const result = await window.electronAPI.openExistingProject();
            if (result && result.success) {
                _finishProjectOpen(result, 'Project');
            }
        } catch (error) {
            showToast(error?.message || 'Failed to open project', 'error');
        }
    }
}

async function refreshApp() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }
    // Auto-save current state before refresh so no work is lost
    if (state.scenes.length > 0 && window.electronAPI.saveProjectFile) {
        try {
            await saveProject();
            console.log('✅ Auto-saved before refresh');
        } catch (e) {
            console.warn('Auto-save before refresh failed:', e.message);
        }
    }
    showToast('Refreshing...', 'info');
    // Reload the window - picks up any file changes without restarting the server
    window.location.reload();
}

// ========================================
// Electron API Fallback
// ========================================
if (!window.electronAPI) {
    window.electronAPI = {
        runBuild: async () => ({ success: true }), runRender: async () => ({ success: true, outputPath: '' }),
        loadVideoPlan: async () => ({
            totalDuration: 30, scenes: [
                { text: 'Welcome to this video...', keyword: 'city skyline', startTime: 0, endTime: 5 },
                { text: 'Today we will discuss...', keyword: 'business meeting', startTime: 5, endTime: 12 },
                { text: 'The most important thing...', keyword: 'success', startTime: 12, endTime: 20 },
                { text: 'Thank you for watching!', keyword: 'sunset ocean', startTime: 20, endTime: 30 }
            ]
        }),
        getSceneVideoPath: async () => null, getSceneMediaPath: async () => null, getFileUrl: async () => null, getAudioPath: async () => null,
        openExistingProject: async () => ({ success: false, cancelled: true }),
        openExistingProjectFolder: async () => ({ success: false, cancelled: true }),
        openExistingProjectFile: async () => ({ success: false, cancelled: true }),
        hyperframesGenerateProject: async () => ({ success: false, error: 'HyperFrames bridge not available' }),
        hyperframesRender: async () => ({ success: false, error: 'HyperFrames bridge not available' }),
        agentPlan: async () => ({ success: false, error: 'Editor Agent is available only in the desktop app' }),
        agentExecute: async () => ({ success: false, error: 'Editor Agent is available only in the desktop app' }),
        agentUndo: async () => ({ success: false, error: 'Editor Agent is available only in the desktop app' }),
        agentRedo: async () => ({ success: false, error: 'Editor Agent is available only in the desktop app' }),
        agentHistory: async () => ({ success: true, undo: [], redo: [] }),
        agentSession: async () => ({ success: false, error: 'Editor Agent memory is available only in the desktop app' }),
        agentNewSession: async () => ({ success: false, error: 'Editor Agent memory is available only in the desktop app' }),
        onAgentProgress: () => () => { },
        onAgentPlanUpdated: () => () => { },
        onBuildProgress: () => { }, onRenderProgress: () => { },
        cancelProcess: async () => ({ success: true, message: 'Cancelled' }),
        showNotification: () => { }
    };
}

document.addEventListener('DOMContentLoaded', init);
