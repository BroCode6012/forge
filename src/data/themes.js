(() => {
/**
 * Theme System — Visual layer only
 *
 * Themes control VISUAL presentation:
 * - Color palette (primary, secondary, accent, text)
 * - Font families (heading, body)
 * - Motion graphics visual style (clean, bold, neon, etc.)
 * - Transition visual preferences
 * - Overlay visual preferences
 * - Background canvas styling
 *
 * Themes do NOT control content strategy (MG type selection, footage priority,
 * pacing). That's handled by the Niche system (src/niches.js).
 *
 * The AI Director picks a niche, and each niche has a defaultTheme.
 * User can override the theme independently.
 */

// ============================================================
// THEME DEFINITIONS
// ============================================================

const THEMES = {
    // ── CRIME ── Dark, moody, high-contrast. For: crime, military/geopolitics
    crime: {
        id: 'crime',
        name: 'Crime / Dark',
        description: 'Dark, moody, high-contrast visuals — crime, military, geopolitics',

        background: 'dark',
        canvasBackground: 'vignette',
        mgStyle: 'cinematic',

        colors: {
            primary: '#dc143c',
            secondary: '#1a1a1a',
            accent: '#ffd700',
            text: '#FFFFFF',
            background: '#000000',
            shadow: 'rgba(220, 20, 60, 0.4)'
        },

        fonts: {
            heading: 'Oswald, "Bebas Neue", Impact, sans-serif',
            body: '"Barlow Condensed", Lato, Arial, sans-serif',
            headingWeight: '700'   // Oswald's heaviest real cut; 900 would be faked
        },

        transitions: {
            primary: ['push-left', 'wipe-left', 'blur-dissolve', 'whip-left'],
            secondary: ['crossfade', 'dip-black', 'flash-white', 'fire-burn'],
            avoid: ['spin-settle', 'light-sweep', 'glitch']
        },

        overlays: {
            preferred: ['grain', 'dust', 'scratch', 'damage', 'vignette', 'film', 'noise'],
            avoid: ['lightleak', 'bokeh', 'paper'],
            effects: ['grain', 'dust', 'vignette'],
            blendMode: 'screen',
            intensity: { min: 0.25, max: 0.55 }
        },

        effectParams: {
            grain:        { intensity: 0.18, scale: 1.2 },
            dust:         { intensity: 0.12, density: 0.4 },
            vignette:     { intensity: 0.7, radius: 0.35, softness: 0.55 },
        }
    },

    // ── HISTORY ── Elegant, warm, cinematic. For: history, luxury, biography
    history: {
        id: 'history',
        name: 'History / Elegant',
        description: 'Warm, cinematic, elegant — history, luxury, biography',

        background: 'warm',
        canvasBackground: 'softGlow',
        mgStyle: 'elegant',

        colors: {
            primary: '#d4af37',
            secondary: '#1a1a1a',
            accent: '#c0c0c0',
            text: '#FFFFFF',
            background: '#0a0a0a',
            shadow: 'rgba(212, 175, 55, 0.4)'
        },

        fonts: {
            heading: '"Playfair Display", Cinzel, Georgia, serif',
            body: 'Lora, "Libre Baskerville", "Times New Roman", serif'
        },

        transitions: {
            primary: ['crossfade', 'blur-dissolve', 'light-sweep'],
            secondary: ['dip-black', 'wipe-up', 'push-up', 'fire-burn'],
            avoid: ['glitch', 'whip-left', 'whip-right', 'zoom-punch', 'spin-settle', 'flash-white']
        },

        overlays: {
            preferred: ['lightleak', 'bokeh', 'film', 'dust', 'grain'],
            avoid: ['crt', 'vhs', 'glitch', 'damage', 'scanline', 'scratch'],
            effects: ['lightLeak', 'blurVignette', 'grain'],
            blendMode: 'screen',
            intensity: { min: 0.15, max: 0.4 }
        },

        effectParams: {
            grain:        { intensity: 0.10, scale: 1.5 },
            lightLeak:    { intensity: 0.18, warmth: 0.8 },
            blurVignette: { intensity: 0.45, radius: 0.50, blurAmount: 4.0 },
        }
    },

    // ── MODERN ── Vibrant, energetic, bold. For: tech, sport, news
    modern: {
        id: 'modern',
        name: 'Modern / Vibrant',
        description: 'Bold, vibrant, high-energy — tech, sport, news',

        background: 'tech-grid',
        canvasBackground: 'energyBurst',
        mgStyle: 'bold',

        colors: {
            primary: '#00ccff',
            secondary: '#ff4500',
            accent: '#00ff88',
            text: '#FFFFFF',
            background: '#0a0a0a',
            shadow: 'rgba(0, 204, 255, 0.4)'
        },

        fonts: {
            heading: '"Bebas Neue", Oswald, "Fjalla One", Impact, sans-serif',
            body: '"Roboto Condensed", "Barlow Condensed", Arial, sans-serif',
            headingWeight: '400'   // Bebas Neue is a single-weight display face
        },

        transitions: {
            primary: ['push-left', 'whip-left', 'zoom-punch', 'wipe-left'],
            secondary: ['zoom-pull', 'flash-white', 'glitch', 'lens-flare'],
            avoid: ['dip-black', 'spin-settle']
        },

        overlays: {
            preferred: ['grain', 'dust', 'lightleak', 'scanline', 'digital'],
            avoid: ['paper', 'bokeh', 'crt', 'vhs'],
            effects: ['grain', 'chromatic', 'dust'],
            blendMode: 'screen',
            intensity: { min: 0.2, max: 0.5 }
        },

        effectParams: {
            grain:     { intensity: 0.14, scale: 1.0 },
            chromatic: { intensity: 0.006, angle: 0.0 },
            dust:      { intensity: 0.10, density: 0.3 },
        }
    },

    // ── MINIMAL ── Understated, organic, calm. For: nature, food/health, motivation
    minimal: {
        id: 'minimal',
        name: 'Minimal / Organic',
        description: 'Understated, earthy, calm — nature, food, motivation',

        background: 'nature',
        canvasBackground: 'organicNoise',
        mgStyle: 'minimal',

        colors: {
            primary: '#8B4513',
            secondary: '#228B22',
            accent: '#87CEEB',
            text: '#FFFFFF',
            background: '#1a1a1a',
            shadow: 'rgba(0, 0, 0, 0.6)'
        },

        fonts: {
            heading: '"Libre Baskerville", Merriweather, Georgia, serif',
            body: 'Karla, "Source Sans Pro", "Segoe UI", sans-serif',
            headingWeight: '700'   // Libre Baskerville ships 400/700 only
        },

        transitions: {
            primary: ['crossfade', 'blur-dissolve', 'push-up'],
            secondary: ['wipe-up', 'light-sweep'],
            avoid: ['glitch', 'flash-white', 'whip-left', 'whip-right', 'zoom-punch', 'spin-settle', 'dip-black']
        },

        overlays: {
            preferred: ['dust', 'lightleak', 'film', 'grain', 'bokeh', 'blur'],
            avoid: ['crt', 'vhs', 'glitch', 'scanline', 'digital'],
            effects: ['grain', 'lightLeak', 'blurVignette'],
            blendMode: 'screen',
            intensity: { min: 0.12, max: 0.35 }
        },

        effectParams: {
            grain:        { intensity: 0.08, scale: 1.8 },
            lightLeak:    { intensity: 0.12, warmth: 0.6 },
            blurVignette: { intensity: 0.35, radius: 0.55, blurAmount: 3.0 },
        }
    },

    // ── STANDARD ── Clean, professional, versatile. For: business, education, diy, general
    standard: {
        id: 'standard',
        name: 'Standard / Clean',
        description: 'Clean, professional, versatile — business, education, general',

        background: 'neutral',
        canvasBackground: 'gridLines',
        mgStyle: 'clean',

        colors: {
            primary: '#0066cc',
            secondary: '#333333',
            accent: '#00cc66',
            text: '#FFFFFF',
            background: '#1a1a1a',
            shadow: 'rgba(0, 0, 0, 0.4)'
        },

        fonts: {
            heading: '"Work Sans", Oswald, Arial, sans-serif',
            body: '"Source Sans Pro", "Segoe UI", Arial, sans-serif'
        },

        transitions: {
            primary: ['push-left', 'crossfade', 'wipe-left', 'zoom-pull'],
            secondary: ['blur-dissolve', 'push-up', 'zoom-punch'],
            avoid: ['glitch', 'spin-settle', 'flash-white', 'whip-left', 'whip-right']
        },

        overlays: {
            preferred: ['paper', 'lightleak', 'blur', 'bokeh', 'grain'],
            avoid: ['crt', 'vhs', 'glitch', 'damage', 'scratch', 'scanline'],
            effects: ['blurVignette', 'lightLeak', 'grain'],
            blendMode: 'soft-light',
            intensity: { min: 0.1, max: 0.3 }
        },

        effectParams: {
            grain:        { intensity: 0.06, scale: 2.0 },
            lightLeak:    { intensity: 0.10, warmth: 0.5 },
            blurVignette: { intensity: 0.30, radius: 0.60, blurAmount: 2.5 },
        }
    },

    // ── WARM EDITORIAL ── Light cream/paper canvas, burnt orange + browns,
    // serif headings. For: food, DIY, crafts, homestead, traditional topics.
    'warm-editorial': {
        id: 'warm-editorial',
        name: 'Warm Editorial / Paper',
        description: 'Light cream paper, burnt orange, serif warmth — food, DIY, crafts, tradition',

        background: 'neutral',
        canvasBackground: 'organicNoise',
        mgStyle: 'editorial-light',

        colors: {
            primary: '#c2571b',
            secondary: '#7a4a21',
            accent: '#a8662e',
            text: '#2c2218',
            background: '#ece0c8',  // warm cream, deepened from #f3ecdd so cards read as paper, not stark blank canvas
            shadow: 'rgba(92, 64, 38, 0.35)'
        },

        fonts: {
            heading: '"Playfair Display", "Libre Baskerville", Georgia, serif',
            body: 'Spectral, "Source Sans Pro", Georgia, serif'
        },

        transitions: {
            primary: ['crossfade', 'blur-dissolve', 'push-left', 'light-sweep'],
            secondary: ['wipe-up', 'zoom-pull'],
            avoid: ['glitch', 'flash-white', 'whip-left', 'whip-right', 'spin-settle']
        },

        overlays: {
            preferred: ['paper', 'grain', 'lightleak', 'dust', 'film'],
            avoid: ['crt', 'vhs', 'glitch', 'scanline', 'digital', 'neon'],
            effects: ['grain', 'lightLeak'],
            blendMode: 'multiply',
            intensity: { min: 0.08, max: 0.25 }
        },

        effectParams: {
            grain:     { intensity: 0.07, scale: 1.6 },
            lightLeak: { intensity: 0.10, warmth: 0.85 },
        }
    },

    // ── LUXURY ── Deep black, gold, champagne serif. For: luxury, wealth,
    // high-end lifestyle, premium brands.
    luxury: {
        id: 'luxury',
        name: 'Luxury / Gold',
        description: 'Deep black, soft gold, champagne serif — wealth, premium, high-end',

        background: 'dark',
        canvasBackground: 'subtleGradient',
        mgStyle: 'minimal',

        colors: {
            primary: '#d4b46a',
            secondary: '#8a7240',
            accent: '#f0e3bc',
            text: '#f5efe2',
            background: '#0b0a07',
            shadow: 'rgba(0, 0, 0, 0.7)'
        },

        fonts: {
            heading: '"Playfair Display", "Libre Baskerville", Georgia, serif',
            body: '"Source Sans Pro", "Work Sans", "Segoe UI", sans-serif'
        },

        transitions: {
            primary: ['crossfade', 'blur-dissolve', 'light-sweep'],
            secondary: ['dip-black', 'zoom-pull'],
            avoid: ['glitch', 'whip-left', 'whip-right', 'flash-white', 'spin-settle']
        },

        overlays: {
            preferred: ['bokeh', 'lightleak', 'dust', 'grain', 'blur'],
            avoid: ['crt', 'vhs', 'glitch', 'scanline', 'damage'],
            effects: ['bloom', 'vignette', 'grain'],
            blendMode: 'screen',
            intensity: { min: 0.1, max: 0.3 }
        },

        effectParams: {
            grain:        { intensity: 0.05, scale: 2.2 },
            lightLeak:    { intensity: 0.12, warmth: 0.8 },
            blurVignette: { intensity: 0.4, radius: 0.5, blurAmount: 3.0 },
        }
    },

    // ── NATURE ── Deep forest greens, moss accents, cream text. For:
    // wildlife, environment, outdoors, ocean.
    nature: {
        id: 'nature',
        name: 'Nature / Forest',
        description: 'Deep forest green, moss and leaf accents — wildlife, environment, outdoors',

        background: 'nature',
        canvasBackground: 'organicNoise',
        mgStyle: 'minimal',

        colors: {
            primary: '#3fae6a',
            secondary: '#2c6e49',
            accent: '#b7d77a',
            text: '#f2f7ec',
            background: '#0e1f16',
            shadow: 'rgba(4, 16, 10, 0.65)'
        },

        fonts: {
            heading: '"Libre Baskerville", "Playfair Display", Georgia, serif',
            body: 'Lora, "Libre Baskerville", Georgia, serif',
            headingWeight: '700'   // Libre Baskerville ships 400/700 only
        },

        transitions: {
            primary: ['crossfade', 'blur-dissolve', 'light-sweep'],
            secondary: ['wipe-up', 'push-up'],
            avoid: ['glitch', 'flash-white', 'whip-left', 'whip-right', 'zoom-punch', 'spin-settle']
        },

        overlays: {
            preferred: ['dust', 'lightleak', 'bokeh', 'grain', 'film'],
            avoid: ['crt', 'vhs', 'glitch', 'scanline', 'digital'],
            effects: ['grain', 'lightLeak', 'blurVignette'],
            blendMode: 'screen',
            intensity: { min: 0.1, max: 0.3 }
        },

        effectParams: {
            grain:        { intensity: 0.07, scale: 1.8 },
            lightLeak:    { intensity: 0.11, warmth: 0.55 },
            blurVignette: { intensity: 0.32, radius: 0.55, blurAmount: 2.8 },
        }
    },
};

// ============================================================
// BACKGROUND CANVAS URLS (Stock footage sources)
// ============================================================

// These will be downloaded and cached in assets/backgrounds/
// Similar to overlay-manager.js, but for background textures
const BACKGROUND_SOURCES = {
    'tech-grid': {
        name: 'Tech Grid Animation',
        keywords: ['tech grid animation loop', 'digital matrix background', 'cyber circuit pattern'],
        duration: 10,
        opacity: 0.15,
        preferredType: 'pattern',  // tech looks best with 3D grid patterns
        blurAmount: 25,
        cssGradient: 'radial-gradient(ellipse at center, #0a1628 0%, #000000 100%)'
    },
    'nature': {
        name: 'Nature Texture',
        keywords: ['nature texture loop', 'organic pattern background', 'earth tone gradient'],
        duration: 10,
        opacity: 0.20,
        preferredType: 'blur',  // natural footage looks great blurred
        blurAmount: 30,
        cssGradient: 'radial-gradient(ellipse at center, #1a2a1a 0%, #0a0a0a 100%)'
    },
    'dark': {
        name: 'Dark Gradient',
        keywords: ['dark gradient loop', 'black smoke texture', 'noir atmosphere'],
        duration: 10,
        opacity: 0.25,
        preferredType: 'blur',  // cinematic blur for crime/dark
        blurAmount: 25,
        cssGradient: 'radial-gradient(ellipse at center, #1a1a2a 0%, #000000 100%)'
    },
    'light': {
        name: 'Light Gradient',
        keywords: ['light gradient loop', 'soft white texture', 'clean background'],
        duration: 10,
        opacity: 0.15,
        preferredType: 'pattern',  // corporate/clean looks good with subtle patterns
        blurAmount: 30,
        cssGradient: 'radial-gradient(ellipse at center, #2a2a3a 0%, #1a1a1a 100%)'
    },
    'warm': {
        name: 'Warm Gradient',
        keywords: ['warm gradient loop', 'golden texture', 'luxury background'],
        duration: 10,
        opacity: 0.18,
        preferredType: 'blur',  // luxury = elegant blur
        blurAmount: 28,
        cssGradient: 'radial-gradient(ellipse at center, #2a1a0a 0%, #0a0a0a 100%)'
    },
    'neutral': {
        name: 'Neutral Gradient',
        keywords: ['gray gradient loop', 'neutral texture', 'subtle background'],
        duration: 10,
        opacity: 0.12,
        preferredType: 'blur',  // safe default
        blurAmount: 25,
        cssGradient: 'radial-gradient(ellipse at center, #1a1a1a 0%, #0a0a0a 100%)'
    }
};

// ============================================================
// BUILT-IN BACKGROUND LIBRARY (CSS gradient backgrounds)
// These are rendered as <div> backgrounds — no image files needed.
// User can ALSO add .png/.jpg/.mp4 files to assets/backgrounds/
// ============================================================

const BACKGROUND_LIBRARY = {
    'dark-gradient': {
        name: 'Dark Gradient',
        css: 'radial-gradient(ellipse at 50% 40%, #1a1a2e 0%, #0a0a14 60%, #000000 100%)',
        themes: ['crime', 'modern', 'standard'],
        mood: ['dark', 'dramatic', 'mysterious'],
    },
    'blue-minimal': {
        name: 'Blue Minimal',
        css: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        themes: ['modern', 'standard'],
        mood: ['calm', 'professional', 'cool'],
    },
    'dark-blue': {
        name: 'Dark Blue',
        css: 'radial-gradient(ellipse at 50% 50%, #0f2027 0%, #203a43 40%, #2c5364 100%)',
        themes: ['modern', 'standard', 'crime'],
        mood: ['calm', 'professional', 'dark'],
    },
    'green-gradient': {
        name: 'Green Gradient',
        css: 'linear-gradient(160deg, #0f3443 0%, #34e89e 100%)',
        themes: ['minimal', 'modern'],
        mood: ['calm', 'energetic', 'bright'],
    },
    'warm-sunset': {
        name: 'Warm Sunset',
        css: 'linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #fda085 100%)',
        themes: ['history', 'minimal'],
        mood: ['warm', 'energetic', 'bright'],
    },
    'midnight': {
        name: 'Midnight',
        css: 'radial-gradient(ellipse at 30% 50%, #1a0a2e 0%, #0a0014 50%, #000000 100%)',
        themes: ['crime', 'history'],
        mood: ['dark', 'dramatic', 'mysterious'],
    },
    'cream': {
        name: 'Cream',
        css: 'linear-gradient(180deg, #fdf6e3 0%, #ede0c8 50%, #d4c5a9 100%)',
        themes: ['minimal', 'standard', 'history'],
        mood: ['warm', 'calm', 'bright'],
    },
    'grid-texture': {
        name: 'Grid Texture',
        css: 'repeating-linear-gradient(0deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), repeating-linear-gradient(90deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 100%)',
        themes: ['modern', 'standard'],
        mood: ['professional', 'dark', 'cool'],
    },
    'red-dark': {
        name: 'Red Dark',
        css: 'radial-gradient(ellipse at 50% 50%, #2a0a0a 0%, #1a0505 50%, #0a0000 100%)',
        themes: ['crime', 'modern'],
        mood: ['dramatic', 'dark', 'energetic'],
    },
    'purple-haze': {
        name: 'Purple Haze',
        css: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #3a1c71 100%)',
        themes: ['modern', 'history'],
        mood: ['dramatic', 'cool', 'mysterious'],
    },
    'noir': {
        name: 'Noir',
        css: 'radial-gradient(ellipse at 50% 30%, #1a1a1a 0%, #0a0a0a 40%, #000000 100%)',
        themes: ['crime', 'standard'],
        mood: ['dark', 'dramatic', 'mysterious'],
    },
    'ocean-deep': {
        name: 'Ocean Deep',
        css: 'linear-gradient(180deg, #0c3547 0%, #0a2a3a 40%, #051a2a 100%)',
        themes: ['minimal', 'modern', 'standard'],
        mood: ['calm', 'cool', 'professional'],
    },
    // Soft/solid backgrounds (ideal for floating frame)
    'soft-beige': {
        name: 'Soft Beige',
        css: 'linear-gradient(180deg, #e8dcc8 0%, #d4c5a9 50%, #c4b494 100%)',
        themes: ['history', 'standard', 'minimal'],
        mood: ['warm', 'calm', 'bright'],
    },
    'warm-white': {
        name: 'Warm White',
        css: 'linear-gradient(180deg, #f5f0e8 0%, #ebe3d5 50%, #ddd3c0 100%)',
        themes: ['minimal', 'standard', 'history'],
        mood: ['warm', 'bright', 'calm'],
    },
    'soft-gray': {
        name: 'Soft Gray',
        css: 'linear-gradient(180deg, #d0d0d0 0%, #b8b8b8 50%, #a0a0a0 100%)',
        themes: ['minimal', 'modern', 'standard'],
        mood: ['calm', 'professional', 'cool'],
    },
    'slate': {
        name: 'Slate',
        css: 'linear-gradient(180deg, #2c3e50 0%, #1a252f 50%, #0e171f 100%)',
        themes: ['crime', 'modern', 'standard'],
        mood: ['dark', 'professional', 'cool'],
    },
    'warm-charcoal': {
        name: 'Warm Charcoal',
        css: 'linear-gradient(180deg, #3a3530 0%, #2a2520 50%, #1a1510 100%)',
        themes: ['crime', 'history', 'standard'],
        mood: ['dark', 'warm', 'dramatic'],
    },
    'paper': {
        name: 'Paper',
        css: 'linear-gradient(180deg, #f0ead6 0%, #e6dcc6 50%, #d6ccb2 100%)',
        themes: ['history', 'minimal', 'standard'],
        mood: ['warm', 'calm', 'bright'],
    },
};

// ============================================================
// THEME BACKGROUND ASSETS — Auto-discovered from assets/backgrounds/
// Naming convention: "{themeId}--{name}.ext" → assigned to that theme.
// Files without a theme prefix are universal (available to all themes).
// Step 5.1 uses getThemeBackgrounds() to find assets for the active theme.
// ============================================================

const _hasNodeRuntime = typeof module !== 'undefined' && module.exports;
const _fs = _hasNodeRuntime ? require('fs') : null;
const _path = _hasNodeRuntime ? require('path') : null;
const _bgDir = _path ? _path.join(__dirname, '..', '..', 'assets', 'backgrounds') : null;
const _supportedBgExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.webm', '.mov']);
const _validThemes = new Set(['crime', 'history', 'modern', 'minimal', 'standard', 'warm-editorial', 'luxury', 'nature']);

/**
 * Scan assets/backgrounds/ and return filenames for a given theme.
 * Matches files starting with "{themeId}--". Caches results.
 * @param {string} themeId
 * @returns {string[]} Array of filenames (e.g. ['history--V1.jpg', 'history--V2.jpg'])
 */
let _bgScanCache = null;
function getThemeBackgrounds(themeId) {
    if (!_bgScanCache) {
        _bgScanCache = {};
        if (_fs && _path && _bgDir && _fs.existsSync(_bgDir)) {
            const files = _fs.readdirSync(_bgDir).filter(f => {
                const ext = _path.extname(f).toLowerCase();
                return _supportedBgExts.has(ext) && !f.startsWith('.');
            });
            for (const f of files) {
                const dashIdx = f.indexOf('--');
                if (dashIdx > 0) {
                    const prefix = f.substring(0, dashIdx).toLowerCase();
                    if (_validThemes.has(prefix)) {
                        if (!_bgScanCache[prefix]) _bgScanCache[prefix] = [];
                        _bgScanCache[prefix].push(f);
                    }
                }
            }
        }
    }
    return _bgScanCache[themeId] || [];
}

/**
 * Get backgrounds matching a theme and mood
 * @param {string} themeId - Theme identifier
 * @param {string} mood - Optional mood filter
 * @returns {Array} Matching background entries [{id, name, css}]
 */
function getMatchingBackgrounds(themeId, mood) {
    const results = [];
    for (const [id, bg] of Object.entries(BACKGROUND_LIBRARY)) {
        const themeMatch = bg.themes.includes(themeId);
        const moodMatch = !mood || bg.mood.includes(mood);
        if (themeMatch || moodMatch) {
            results.push({ id, ...bg, score: (themeMatch ? 2 : 0) + (moodMatch ? 1 : 0) });
        }
    }
    // Sort by relevance (theme match + mood match)
    results.sort((a, b) => b.score - a.score);
    return results;
}

// ============================================================
// TRANSITION LIBRARY (21 Types)
// ============================================================

/**
 * Comprehensive transition definitions with properties and SFX
 * Each transition has:
 * - id: unique identifier
 * - name: display name
 * - category: smooth | energetic | dramatic | glitchy
 * - duration: default duration in ms
 * - intensity: low | medium | high (visual impact)
 * - sfx: sound effect file name (optional)
 */
const TRANSITION_LIBRARY = {
    // SMOOTH (Cinematic, documentary)
    fade: {
        id: 'fade',
        name: 'Fade',
        category: 'smooth',
        duration: 500,
        intensity: 'low',
        sfx: null // Silent transition
    },
    fade_to_black: {
        id: 'fade_to_black',
        name: 'Fade To Black',
        category: 'smooth',
        duration: 400,
        intensity: 'medium',
        sfx: null
    },
    dissolve: {
        id: 'dissolve',
        name: 'Dissolve',
        category: 'smooth',
        duration: 600,
        intensity: 'low',
        sfx: null
    },
    crossfade: {
        id: 'crossfade',
        name: 'Cross Fade',
        category: 'smooth',
        duration: 500,
        intensity: 'low',
        sfx: null
    },
    crossBlur: {
        id: 'crossBlur',
        name: 'Cross Blur',
        category: 'smooth',
        duration: 650,
        intensity: 'medium',
        sfx: 'whoosh-soft.mp3'
    },
    ripple: {
        id: 'ripple',
        name: 'Ripple',
        category: 'smooth',
        duration: 700,
        intensity: 'medium',
        sfx: 'water-ripple.mp3'
    },
    blur: {
        id: 'blur',
        name: 'Blur',
        category: 'smooth',
        duration: 550,
        intensity: 'low',
        sfx: null
    },
    luma: {
        id: 'luma',
        name: 'Luma Fade',
        category: 'smooth',
        duration: 600,
        intensity: 'medium',
        sfx: null
    },

    // ENERGETIC (Listicle, fast-paced)
    wipe: {
        id: 'wipe',
        name: 'Wipe',
        category: 'energetic',
        duration: 400,
        intensity: 'medium',
        sfx: 'swipe.mp3'
    },
    slide: {
        id: 'slide',
        name: 'Slide',
        category: 'energetic',
        duration: 450,
        intensity: 'medium',
        sfx: 'slide.mp3'
    },
    zoom: {
        id: 'zoom',
        name: 'Zoom',
        category: 'energetic',
        duration: 400,
        intensity: 'high',
        sfx: 'zoom-in.mp3'
    },
    push: {
        id: 'push',
        name: 'Push',
        category: 'energetic',
        duration: 450,
        intensity: 'medium',
        sfx: 'push.mp3'
    },
    swipe: {
        id: 'swipe',
        name: 'Swipe',
        category: 'energetic',
        duration: 350,
        intensity: 'high',
        sfx: 'swipe-fast.mp3'
    },

    // DRAMATIC (Crime, action, sports)
    flash: {
        id: 'flash',
        name: 'Flash',
        category: 'dramatic',
        duration: 300,
        intensity: 'high',
        sfx: 'camera-flash.mp3'
    },
    directionalBlur: {
        id: 'directionalBlur',
        name: 'Directional Blur',
        category: 'dramatic',
        duration: 500,
        intensity: 'high',
        sfx: 'whoosh-fast.mp3'
    },
    colorFade: {
        id: 'colorFade',
        name: 'Color Fade',
        category: 'dramatic',
        duration: 550,
        intensity: 'medium',
        sfx: null
    },
    spin: {
        id: 'spin',
        name: 'Spin',
        category: 'dramatic',
        duration: 600,
        intensity: 'high',
        sfx: 'spin.mp3'
    },

    // GLITCHY (Tech, cyberpunk)
    glitch: {
        id: 'glitch',
        name: 'Glitch',
        category: 'glitchy',
        duration: 400,
        intensity: 'high',
        sfx: 'glitch.mp3'
    },
    pixelate: {
        id: 'pixelate',
        name: 'Pixelate',
        category: 'glitchy',
        duration: 450,
        intensity: 'high',
        sfx: 'digital-glitch.mp3'
    },
    mosaic: {
        id: 'mosaic',
        name: 'Mosaic',
        category: 'glitchy',
        duration: 500,
        intensity: 'medium',
        sfx: 'pixelate.mp3'
    },

    // ELEGANT (Luxury, fashion)
    reveal: {
        id: 'reveal',
        name: 'Reveal',
        category: 'smooth',
        duration: 700,
        intensity: 'low',
        sfx: null
    },
    filmBurn: {
        id: 'filmBurn',
        name: 'Film Burn',
        category: 'smooth',
        duration: 600,
        intensity: 'medium',
        sfx: null
    },

    // CINEMATIC (Film-style transitions)
    cameraFlash: {
        id: 'cameraFlash',
        name: 'Camera Flash',
        category: 'dramatic',
        duration: 350,
        intensity: 'high',
        sfx: 'camera-shutter.mp3'
    },
    flare: {
        id: 'flare',
        name: 'Lens Flare',
        category: 'cinematic',
        duration: 600,
        intensity: 'medium',
        sfx: 'lens-flare.mp3'
    },
    lightLeak: {
        id: 'lightLeak',
        name: 'Light Leak',
        category: 'cinematic',
        duration: 650,
        intensity: 'medium',
        sfx: null
    },
    vignetteBlink: {
        id: 'vignetteBlink',
        name: 'Vignette Blink',
        category: 'cinematic',
        duration: 400,
        intensity: 'high',
        sfx: 'blink.mp3'
    },
    filmGrain: {
        id: 'filmGrain',
        name: 'Film Grain',
        category: 'cinematic',
        duration: 550,
        intensity: 'low',
        sfx: 'film-projector.mp3'
    },
    shadowWipe: {
        id: 'shadowWipe',
        name: 'Shadow Wipe',
        category: 'cinematic',
        duration: 500,
        intensity: 'medium',
        sfx: 'whoosh-dark.mp3'
    },
    ink: {
        id: 'ink',
        name: 'Ink Bleed',
        category: 'cinematic',
        duration: 700,
        intensity: 'medium',
        sfx: null
    },

    // DYNAMIC (Sports, action, news)
    whip: {
        id: 'whip',
        name: 'Whip Pan',
        category: 'energetic',
        duration: 300,
        intensity: 'high',
        sfx: 'whip-pan.mp3'
    },
    bounce: {
        id: 'bounce',
        name: 'Bounce',
        category: 'energetic',
        duration: 400,
        intensity: 'high',
        sfx: 'bounce.mp3'
    },
    shutterSlice: {
        id: 'shutterSlice',
        name: 'Shutter Slice',
        category: 'energetic',
        duration: 350,
        intensity: 'high',
        sfx: 'shutter.mp3'
    },
    zoomBlur: {
        id: 'zoomBlur',
        name: 'Zoom Blur',
        category: 'energetic',
        duration: 400,
        intensity: 'high',
        sfx: 'zoom-whoosh.mp3'
    },
    splitWipe: {
        id: 'splitWipe',
        name: 'Split Wipe',
        category: 'energetic',
        duration: 450,
        intensity: 'medium',
        sfx: 'swipe.mp3'
    },

    // ORGANIC (Nature, soft transitions)
    morph: {
        id: 'morph',
        name: 'Morph',
        category: 'smooth',
        duration: 800,
        intensity: 'low',
        sfx: null
    },
    dreamFade: {
        id: 'dreamFade',
        name: 'Dream Fade',
        category: 'smooth',
        duration: 750,
        intensity: 'low',
        sfx: null
    },
    prismShift: {
        id: 'prismShift',
        name: 'Prism Shift',
        category: 'cinematic',
        duration: 500,
        intensity: 'medium',
        sfx: 'prism.mp3'
    },

    // TECH / GLITCHY (Extended)
    dataMosh: {
        id: 'dataMosh',
        name: 'Data Mosh',
        category: 'glitchy',
        duration: 400,
        intensity: 'high',
        sfx: 'data-corrupt.mp3'
    },
    scanline: {
        id: 'scanline',
        name: 'Scanline',
        category: 'glitchy',
        duration: 450,
        intensity: 'medium',
        sfx: 'digital-glitch.mp3'
    },
    rgbSplit: {
        id: 'rgbSplit',
        name: 'RGB Split',
        category: 'glitchy',
        duration: 350,
        intensity: 'high',
        sfx: 'glitch.mp3'
    },
    static: {
        id: 'static',
        name: 'TV Static',
        category: 'glitchy',
        duration: 400,
        intensity: 'high',
        sfx: 'tv-static.mp3'
    },

    // CAMERA MOTION (Mister Horse-style pans & whips)
    panLeft: {
        id: 'panLeft',
        name: 'Pan Left',
        category: 'energetic',
        duration: 400,
        intensity: 'medium',
        sfx: 'whoosh-soft.mp3'
    },
    panRight: {
        id: 'panRight',
        name: 'Pan Right',
        category: 'energetic',
        duration: 400,
        intensity: 'medium',
        sfx: 'whoosh-soft.mp3'
    },
    panUp: {
        id: 'panUp',
        name: 'Pan Up',
        category: 'energetic',
        duration: 400,
        intensity: 'medium',
        sfx: 'whoosh-soft.mp3'
    },
    panDown: {
        id: 'panDown',
        name: 'Pan Down',
        category: 'energetic',
        duration: 400,
        intensity: 'medium',
        sfx: 'whoosh-soft.mp3'
    },
    whipPan: {
        id: 'whipPan',
        name: 'Whip Pan',
        category: 'energetic',
        duration: 300,
        intensity: 'high',
        sfx: 'whip-pan.mp3'
    },
    zoomOut: {
        id: 'zoomOut',
        name: 'Zoom Out',
        category: 'energetic',
        duration: 450,
        intensity: 'high',
        sfx: 'zoom-in.mp3'
    },
    zoomRotate: {
        id: 'zoomRotate',
        name: 'Zoom Rotate',
        category: 'dramatic',
        duration: 500,
        intensity: 'high',
        sfx: 'spin.mp3'
    },

    // LIGHT LEAKS (Mister Horse-style warm/cool washes)
    warmLeak: {
        id: 'warmLeak',
        name: 'Warm Light Leak',
        category: 'cinematic',
        duration: 600,
        intensity: 'medium',
        sfx: null
    },
    coolLeak: {
        id: 'coolLeak',
        name: 'Cool Light Leak',
        category: 'cinematic',
        duration: 600,
        intensity: 'medium',
        sfx: null
    },

    // SHAPES (Mister Horse-style geometric wipes)
    diagonalStripes: {
        id: 'diagonalStripes',
        name: 'Diagonal Stripes',
        category: 'energetic',
        duration: 400,
        intensity: 'high',
        sfx: 'swipe.mp3'
    },
    rectangles: {
        id: 'rectangles',
        name: 'Rectangles',
        category: 'energetic',
        duration: 450,
        intensity: 'high',
        sfx: 'shutter.mp3'
    },
    diamonds: {
        id: 'diamonds',
        name: 'Diamond Wipe',
        category: 'energetic',
        duration: 450,
        intensity: 'medium',
        sfx: 'swipe.mp3'
    },
    blinds: {
        id: 'blinds',
        name: 'Blinds',
        category: 'energetic',
        duration: 400,
        intensity: 'medium',
        sfx: 'shutter.mp3'
    },
    circles: {
        id: 'circles',
        name: 'Circle Wipe',
        category: 'smooth',
        duration: 500,
        intensity: 'medium',
        sfx: null
    },

    // LUMA VARIANTS
    lumaFade: {
        id: 'lumaFade',
        name: 'Luma Fade',
        category: 'smooth',
        duration: 600,
        intensity: 'medium',
        sfx: null
    },
    lumaDark: {
        id: 'lumaDark',
        name: 'Luma Dark',
        category: 'dramatic',
        duration: 600,
        intensity: 'medium',
        sfx: null
    }
};

/**
 * SFX file paths (relative to assets/sfx/)
 * These are downloaded/cached similar to overlays and backgrounds
 */
const TRANSITION_SFX_SOURCES = {
    'whoosh-soft.mp3': {
        keywords: ['soft whoosh transition sound', 'gentle air swoosh', 'smooth transition sfx'],
        duration: 1.0
    },
    'whoosh-fast.mp3': {
        keywords: ['fast whoosh sound effect', 'quick swoosh', 'speed transition'],
        duration: 0.5
    },
    'swipe.mp3': {
        keywords: ['swipe sound effect', 'screen swipe audio', 'transition swipe'],
        duration: 0.4
    },
    'swipe-fast.mp3': {
        keywords: ['fast swipe sound', 'quick screen transition', 'rapid swipe audio'],
        duration: 0.3
    },
    'slide.mp3': {
        keywords: ['slide transition sound', 'smooth slide audio', 'screen slide sfx'],
        duration: 0.5
    },
    'push.mp3': {
        keywords: ['push transition sound', 'impact transition', 'push sound effect'],
        duration: 0.4
    },
    'zoom-in.mp3': {
        keywords: ['zoom in sound effect', 'camera zoom audio', 'zoom transition'],
        duration: 0.4
    },
    'camera-flash.mp3': {
        keywords: ['camera flash sound', 'photo flash audio', 'flash transition sfx'],
        duration: 0.3
    },
    'glitch.mp3': {
        keywords: ['digital glitch sound', 'tech glitch audio', 'glitch transition'],
        duration: 0.4
    },
    'digital-glitch.mp3': {
        keywords: ['digital error sound', 'pixelated glitch', 'tech malfunction audio'],
        duration: 0.5
    },
    'pixelate.mp3': {
        keywords: ['pixelation sound effect', 'digital pixelate', 'mosaic transition'],
        duration: 0.5
    },
    'water-ripple.mp3': {
        keywords: ['water ripple sound', 'ripple effect audio', 'water drop ripple'],
        duration: 0.7
    },
    'spin.mp3': {
        keywords: ['spin transition sound', 'rotation audio', 'spinning whoosh'],
        duration: 0.6
    },
    'camera-shutter.mp3': {
        keywords: ['camera shutter click sound', 'DSLR shutter', 'photo snap sound effect'],
        duration: 0.4
    },
    'lens-flare.mp3': {
        keywords: ['lens flare sound effect', 'light flare audio', 'cinematic flare whoosh'],
        duration: 0.6
    },
    'blink.mp3': {
        keywords: ['eye blink sound effect', 'quick blink audio', 'fast shutter blink'],
        duration: 0.3
    },
    'film-projector.mp3': {
        keywords: ['film projector sound', 'old movie reel', 'vintage film audio'],
        duration: 0.6
    },
    'whoosh-dark.mp3': {
        keywords: ['dark whoosh sound', 'shadow sweep audio', 'heavy whoosh transition'],
        duration: 0.5
    },
    'whip-pan.mp3': {
        keywords: ['whip pan sound effect', 'fast camera pan', 'whip swish audio'],
        duration: 0.3
    },
    'bounce.mp3': {
        keywords: ['bounce sound effect', 'elastic bounce', 'pop bounce audio'],
        duration: 0.4
    },
    'shutter.mp3': {
        keywords: ['mechanical shutter sound', 'camera shutter slice', 'fast shutter audio'],
        duration: 0.3
    },
    'zoom-whoosh.mp3': {
        keywords: ['zoom whoosh sound', 'fast zoom in audio', 'speed zoom transition'],
        duration: 0.4
    },
    'prism.mp3': {
        keywords: ['prism light sound', 'crystal chime audio', 'glass prism shimmer'],
        duration: 0.5
    },
    'data-corrupt.mp3': {
        keywords: ['data corruption sound', 'digital destroy audio', 'byte error glitch'],
        duration: 0.4
    },
    'tv-static.mp3': {
        keywords: ['tv static noise', 'television static sound', 'white noise burst'],
        duration: 0.5
    }
};

// ============================================================
// DESIGN TOKENS
// ============================================================
// Normalized, reusable design tokens per theme. These unify all
// visual properties (colors, typography, MG chrome, overlays)
// into a single structured object for consistent consumption.
//
// Consumers can use getThemeTokens(themeId) instead of manually
// reading theme.colors.primary, theme.fonts.heading, etc.
//
// MG_STYLE_PRESETS replaces the duplicated MG_STYLES in app.js.

/**
 * MG style presets — visual chrome for each MG style.
 * These are style-level (not theme-level) settings that control
 * how MG chrome (backgrounds, borders, shadows, glow) is rendered.
 */
const MG_STYLE_PRESETS = {
    clean: {
        bg: 'rgba(0,0,0,0.7)',
        glow: false,
        borderRadius: 12,
        strokeWidth: 2,
        shadowStyle: 'soft',       // soft | hard | none | glow
        shadowBlur: 8,
        shadowOffsetY: 2,
        cardStyle: 'filled',       // filled | outline | glass
        lowerThirdStyle: 'bar',    // bar | box | underline | banner | glass | split
        lowerThirdAnimation: 'slideLeft', // slideLeft | wipeRight | popUp | fadeSlide
        chartBarRadius: 4,
        modifier: { saturate: 1.0, brighten: 0, tintHue: null },
    },
    bold: {
        bg: 'rgba(10,10,10,0.92)',
        glow: false,
        borderRadius: 8,
        strokeWidth: 3,
        shadowStyle: 'hard',
        shadowBlur: 12,
        shadowOffsetY: 4,
        cardStyle: 'filled',
        lowerThirdStyle: 'split',
        lowerThirdAnimation: 'popUp',
        chartBarRadius: 2,
        modifier: { saturate: 1.3, brighten: 15, tintHue: null },
    },
    minimal: {
        bg: 'rgba(0,0,0,0.35)',
        glow: false,
        borderRadius: 16,
        strokeWidth: 1,
        shadowStyle: 'none',
        shadowBlur: 4,
        shadowOffsetY: 1,
        cardStyle: 'outline',
        lowerThirdStyle: 'underline',
        lowerThirdAnimation: 'fadeSlide',
        chartBarRadius: 6,
        modifier: { saturate: 0.4, brighten: 40, tintHue: null },
    },
    'editorial-light': {
        bg: 'rgba(247,241,229,0.94)',
        glow: false,
        borderRadius: 10,
        strokeWidth: 1,
        shadowStyle: 'soft',
        shadowBlur: 18,
        shadowOffsetY: 6,
        cardStyle: 'filled',
        lowerThirdStyle: 'underline',
        lowerThirdAnimation: 'fadeSlide',
        chartBarRadius: 4,
        modifier: { saturate: 0.9, brighten: -10, tintHue: null },
    },
    neon: {
        bg: 'rgba(0,0,15,0.85)',
        glow: true,
        borderRadius: 12,
        strokeWidth: 2,
        shadowStyle: 'glow',
        shadowBlur: 30,
        shadowOffsetY: 0,
        cardStyle: 'outline',
        lowerThirdStyle: 'bar',
        lowerThirdAnimation: 'slideLeft',
        chartBarRadius: 4,
        modifier: { saturate: 1.6, brighten: 50, tintHue: null },
    },
    cinematic: {
        bg: 'rgba(0,0,0,0.92)',
        glow: false,
        borderRadius: 10,
        strokeWidth: 2,
        shadowStyle: 'hard',
        shadowBlur: 24,
        shadowOffsetY: 4,
        cardStyle: 'filled',
        lowerThirdStyle: 'banner',
        lowerThirdAnimation: 'wipeRight',
        chartBarRadius: 3,
        modifier: { saturate: 0.8, brighten: -10, tintHue: 40 },
    },
    elegant: {
        bg: 'rgba(10,0,25,0.82)',
        glow: true,
        borderRadius: 14,
        strokeWidth: 1,
        shadowStyle: 'glow',
        shadowBlur: 16,
        shadowOffsetY: 4,
        cardStyle: 'glass',
        lowerThirdStyle: 'glass',
        lowerThirdAnimation: 'fadeSlide',
        chartBarRadius: 6,
        modifier: { saturate: 1.1, brighten: 10, tintHue: 280 },
    },
};

// ── Per-theme MG overrides ──
// Two-knob model (May 2026 refactor):
//   • styleName    — theme picks ONE style from the per-MG style dict
//                    (clean/bold/minimal/neon/cinematic/elegant). Drives font
//                    weight, text color, shadow, glow, outline. Brand identity.
//   • variantAvoid — variant pool filter. Renderer picks variant by rotating
//                    through (allVariants - variantAvoid) using mg.sceneIndex.
//                    Themes shape the vocabulary; scene-rotation provides
//                    variety across scenes. User mg.subType always wins.
//   • colors       — preserved for back-compat: a few renderers read
//                    `ov.colors` directly (LowerThird tints, counter accents).
//                    New consumers should prefer styleName.
//
// Animation is NOT theme-controlled — always read from the variant's default
// in MG_REGISTRY[type].types[variant].animation. See _resolveAnimation.
const MG_THEME_OVERRIDES = {
    crime: {
        // Dark/red/cinematic — bold style, avoid soft variants.
        headline:        { styleName: 'bold',      variantAvoid: ['typewriter'] },
        lowerThird:      { styleName: 'bold',      variantAvoid: ['underline', 'glass'], colors: { bgFill: '#cc0000', textFill: '#ffffff', accentFill: '#ffffff' } },
        callout:         { styleName: 'bold',      variantAvoid: ['minimal'],            colors: { bgFill: 'rgba(30,0,0,0.85)', textFill: '#ffffff', accentFill: '#cc0000' } },
        statCounter:     { styleName: 'bold',      variantAvoid: ['ring'],               colors: { bgFill: 'rgba(30,0,0,0.8)', textFill: '#ffffff', accentFill: '#cc0000' } },
        typewriter:      { styleName: 'bold',      variantAvoid: ['naked'],              colors: { bgFill: 'rgba(30,0,0,0.85)', textFill: '#ffffff', accentFill: '#cc0000' } },
        kineticText:     { styleName: 'bold',      variantAvoid: ['glitch', 'wave'] },
        explainer:       { styleName: 'bold',      variantAvoid: [] },
        listicleCounter: { styleName: 'bold',      variantAvoid: ['minimal'],            colors: { bgFill: '#cc0000', textFill: '#ffffff', accentFill: '#ffd700', numberFill: '#ffffff' } },
        progressTracker: { styleName: 'bold',      variantAvoid: ['fraction'],           colors: { bgFill: 'rgba(30,0,0,0.8)', textFill: '#ffffff', accentFill: '#cc0000', trackFill: 'rgba(255,255,255,0.15)' } },
        listicleGrid:    { styleName: 'bold',      variantAvoid: [],                     colors: { bgFill: 'rgba(20,0,0,0.92)', textFill: '#ffffff', accentFill: '#cc0000', cardFill: 'rgba(60,0,0,0.85)', numberFill: '#ffd700', gridLine: 'rgba(204,0,0,0.15)' } },
    },
    history: {
        // Warm/gold/cinematic — cinematic style, avoid loud variants.
        headline:        { styleName: 'cinematic', variantAvoid: ['stamp'] },
        lowerThird:      { styleName: 'cinematic', variantAvoid: ['banner', 'split'], colors: { bgFill: 'rgba(20,10,5,0.7)', textFill: '#ffffff', accentFill: '#d4af37' } },
        callout:         { styleName: 'cinematic', variantAvoid: ['accent'],          colors: { bgFill: 'rgba(20,10,5,0.75)', textFill: '#f5f0e0', accentFill: '#d4af37' } },
        statCounter:     { styleName: 'cinematic', variantAvoid: [],                  colors: { bgFill: 'rgba(20,10,5,0.7)', textFill: '#f5f0e0', accentFill: '#d4af37' } },
        typewriter:      { styleName: 'cinematic', variantAvoid: [],                  colors: { bgFill: 'rgba(20,10,5,0.8)', textFill: '#f5f0e0', accentFill: '#d4af37' } },
        kineticText:     { styleName: 'cinematic', variantAvoid: ['glitch', 'punch'] },
        explainer:       { styleName: 'cinematic', variantAvoid: [] },
        listicleCounter: { styleName: 'cinematic', variantAvoid: ['ribbon'],          colors: { bgFill: 'rgba(20,10,5,0.75)', textFill: '#f5f0e0', accentFill: '#d4af37', numberFill: '#d4af37' } },
        progressTracker: { styleName: 'cinematic', variantAvoid: [],                  colors: { bgFill: 'rgba(20,10,5,0.6)', textFill: '#f5f0e0', accentFill: '#d4af37', trackFill: 'rgba(212,175,55,0.2)' } },
        listicleGrid:    { styleName: 'cinematic', variantAvoid: ['strip'],           colors: { bgFill: 'rgba(10,5,0,0.9)', textFill: '#f5f0e0', accentFill: '#d4af37', cardFill: 'rgba(30,20,10,0.8)', numberFill: '#d4af37', gridLine: 'rgba(212,175,55,0.1)' } },
    },
    modern: {
        // Cyan/orange/digital — neon style, avoid traditional variants.
        headline:        { styleName: 'neon',      variantAvoid: ['standard'] },
        lowerThird:      { styleName: 'neon',      variantAvoid: ['glass', 'banner'], colors: { bgFill: '#00ccff', textFill: '#ffffff', accentFill: '#ff4500' } },
        callout:         { styleName: 'neon',      variantAvoid: [],                  colors: { bgFill: 'rgba(0,0,0,0.5)', textFill: '#ffffff', accentFill: '#00ccff' } },
        statCounter:     { styleName: 'neon',      variantAvoid: [],                  colors: { bgFill: 'rgba(0,10,20,0.85)', textFill: '#ffffff', accentFill: '#00ccff' } },
        typewriter:      { styleName: 'neon',      variantAvoid: [],                  colors: { bgFill: null, textFill: '#ffffff', accentFill: '#00ccff' } },
        kineticText:     { styleName: 'neon',      variantAvoid: ['cinematic'] },
        explainer:       { styleName: 'neon',      variantAvoid: [] },
        listicleCounter: { styleName: 'neon',      variantAvoid: [],                  colors: { bgFill: '#00ccff', textFill: '#ffffff', accentFill: '#ff4500', numberFill: '#ffffff' } },
        progressTracker: { styleName: 'neon',      variantAvoid: [],                  colors: { bgFill: 'rgba(0,10,20,0.85)', textFill: '#ffffff', accentFill: '#00ccff', trackFill: 'rgba(0,204,255,0.15)' } },
        listicleGrid:    { styleName: 'neon',      variantAvoid: [],                  colors: { bgFill: 'rgba(0,5,15,0.92)', textFill: '#ffffff', accentFill: '#00ccff', cardFill: 'rgba(0,20,40,0.85)', numberFill: '#ff4500', gridLine: 'rgba(0,204,255,0.12)' } },
    },
    minimal: {
        // Sparse — minimal style, avoid every heavy/loud variant.
        headline:        { styleName: 'minimal',   variantAvoid: ['stamp'] },
        lowerThird:      { styleName: 'minimal',   variantAvoid: ['banner', 'split', 'glass'], colors: null },
        callout:         { styleName: 'minimal',   variantAvoid: ['accent'],                   colors: null },
        statCounter:     { styleName: 'minimal',   variantAvoid: [],                           colors: null },
        typewriter:      { styleName: 'minimal',   variantAvoid: [],                           colors: null },
        kineticText:     { styleName: 'minimal',   variantAvoid: ['stamp', 'glitch', 'wave', 'pop', 'punch'] },
        explainer:       { styleName: 'minimal',   variantAvoid: [] },
        listicleCounter: { styleName: 'minimal',   variantAvoid: ['ribbon'],                   colors: null },
        progressTracker: { styleName: 'minimal',   variantAvoid: [],                           colors: null },
        listicleGrid:    { styleName: 'minimal',   variantAvoid: [],                           colors: null },
    },
    standard: {
        // Neutral default — clean style, no avoids (open variant pool).
        headline:        { styleName: 'clean',     variantAvoid: [] },
        lowerThird:      { styleName: 'clean',     variantAvoid: [], colors: { bgFill: '#0055aa', textFill: '#ffffff', accentFill: '#00cc66' } },
        callout:         { styleName: 'clean',     variantAvoid: [], colors: { bgFill: 'rgba(0,0,0,0.75)', textFill: '#ffffff', accentFill: '#0055aa' } },
        statCounter:     { styleName: 'clean',     variantAvoid: [], colors: { bgFill: 'rgba(0,0,0,0.75)', textFill: '#ffffff', accentFill: '#0055aa' } },
        typewriter:      { styleName: 'clean',     variantAvoid: [], colors: { bgFill: 'rgba(0,0,0,0.75)', textFill: '#ffffff', accentFill: '#0055aa' } },
        kineticText:     { styleName: 'clean',     variantAvoid: [] },
        explainer:       { styleName: 'clean',     variantAvoid: [] },
        listicleCounter: { styleName: 'clean',     variantAvoid: [], colors: { bgFill: '#0055aa', textFill: '#ffffff', accentFill: '#00cc66', numberFill: '#ffffff' } },
        progressTracker: { styleName: 'clean',     variantAvoid: [], colors: { bgFill: 'rgba(0,0,0,0.75)', textFill: '#ffffff', accentFill: '#0055aa', trackFill: 'rgba(0,85,170,0.2)' } },
        listicleGrid:    { styleName: 'clean',     variantAvoid: [], colors: { bgFill: 'rgba(0,0,10,0.92)', textFill: '#ffffff', accentFill: '#0055aa', cardFill: 'rgba(0,10,30,0.85)', numberFill: '#00cc66', gridLine: 'rgba(0,85,170,0.12)' } },
    },
};

// ── Per-theme Template overrides ──
// Controls which template variant/animation is used for each template type per theme.
const TEMPLATE_THEME_OVERRIDES = {
    crime: {
        chapterCard:    { variant: 'cinematic', animation: 'wipeRight' },
        quoteCard:      { variant: 'standard',  animation: 'fadeSlide' },
        locationCard:   { variant: 'cinematic', animation: 'fadeSlide' },
        keyTakeaway:    { variant: 'cinematic', animation: 'springScale' },
        comparisonCard: { variant: 'split',     animation: 'flipIn' },
        timelineCard:   { variant: 'cinematic', animation: 'cascade' },
        factCard:       { variant: 'splitPanel', animation: 'slideRight' },
        imageShowcase:  { variant: 'collage', animation: 'scatterDrop' },
        statCard:       { variant: 'sideBySide', animation: 'countUp' },
        personIntro:    { variant: 'standard',  animation: 'slideRight' },
    },
    history: {
        chapterCard:     { variant: 'standard',  animation: 'fadeSlide' },
        quoteCard:       { variant: 'cinematic', animation: 'fadeSlide' },
        locationCard:    { variant: 'minimal',   animation: 'fadeSlide' },
        keyTakeaway:     { variant: 'standard',  animation: 'fadeSlide' },
        comparisonCard:  { variant: 'standard',  animation: 'staggerSlide' },
        timelineCard:    { variant: 'standard',  animation: 'cascade' },
        factCard:        { variant: 'numbered',   animation: 'staggerSlide' },
        imageShowcase:   { variant: 'collage',  animation: 'scatterDrop' },
        statCard:        { variant: 'stacked',    animation: 'countUp' },
        personIntro:     { variant: 'cinematic',  animation: 'fadeSlide' },
    },
    modern: {
        chapterCard:     { variant: 'minimal',   animation: 'springScale' },
        quoteCard:       { variant: 'minimal',   animation: 'popUp' },
        locationCard:    { variant: 'minimal',   animation: 'slideLeft' },
        keyTakeaway:     { variant: 'standard',  animation: 'springScale' },
        comparisonCard:  { variant: 'split',     animation: 'flipIn' },
        timelineCard:    { variant: 'minimal',   animation: 'staggerSlide' },
        factCard:        { variant: 'overlay',    animation: 'fadeUp' },
        imageShowcase:   { variant: 'minimal',   animation: 'slideOpposite' },
        statCard:        { variant: 'sideBySide', animation: 'fadeScale' },
        personIntro:     { variant: 'minimal',   animation: 'springScale' },
    },
    minimal: {
        chapterCard:     { variant: 'minimal',   animation: 'fadeSlide' },
        quoteCard:       { variant: 'minimal',   animation: 'fadeSlide' },
        locationCard:    { variant: 'minimal',   animation: 'fadeSlide' },
        keyTakeaway:     { variant: 'minimal',   animation: 'fadeSlide' },
        comparisonCard:  { variant: 'standard',  animation: 'staggerSlide' },
        timelineCard:    { variant: 'minimal',   animation: 'staggerSlide' },
        factCard:        { variant: 'sidebar',    animation: 'slideRight' },
        imageShowcase:   { variant: 'minimal',   animation: 'fadeSlide' },
        statCard:        { variant: 'single',     animation: 'countUp' },
        personIntro:     { variant: 'minimal',   animation: 'fadeSlide' },
    },
    standard: {
        chapterCard:     { variant: 'standard',  animation: 'fadeSlide' },
        quoteCard:       { variant: 'standard',  animation: 'popUp' },
        locationCard:    { variant: 'standard',  animation: 'slideLeft' },
        keyTakeaway:     { variant: 'standard',  animation: 'springScale' },
        comparisonCard:  { variant: 'standard',  animation: 'staggerSlide' },
        timelineCard:    { variant: 'standard',  animation: 'cascade' },
        factCard:        { variant: 'splitPanel', animation: 'slideRight' },
        imageShowcase:   { variant: 'standard',  animation: 'slideOpposite' },
        statCard:        { variant: 'sideBySide', animation: 'countUp' },
        personIntro:     { variant: 'standard',  animation: 'slideRight' },
    },
};

// Backward-compatible accessor for existing code
const LOWER_THIRD_THEME_OVERRIDES = {};
for (const [themeId, cats] of Object.entries(MG_THEME_OVERRIDES)) {
    if (cats.lowerThird) LOWER_THIRD_THEME_OVERRIDES[themeId] = cats.lowerThird;
}

/**
 * Build a complete design token set for a theme.
 * Merges theme colors/fonts with MG style preset chrome.
 *
 * @param {string} themeId
 * @returns {Object} Full token set
 */
function getThemeTokens(themeId) {
    const theme = THEMES[themeId] || THEMES.standard;
    const stylePreset = MG_STYLE_PRESETS[theme.mgStyle] || MG_STYLE_PRESETS.clean;
    const mod = stylePreset.modifier;

    return {
        // ---- Identity ----
        themeId: theme.id,
        mgStyle: theme.mgStyle,

        // ---- Colors ----
        colors: {
            // Core palette (from theme)
            primary: theme.colors.primary,
            secondary: theme.colors.secondary,
            accent: theme.colors.accent,
            textPrimary: theme.colors.text,
            textSecondary: _textSecondaryFor(theme.colors),
            background: theme.colors.background,
            surface: stylePreset.bg,
            stroke: theme.colors.primary,
            shadow: theme.colors.shadow,

            // Modifier-adjusted colors for MG rendering
            mgPrimary: _applyModifier(theme.colors.primary, mod),
            mgAccent: _applyModifier(theme.colors.accent, mod),
        },

        // ---- Typography ----
        typography: {
            headingFont: theme.fonts.heading,
            bodyFont: theme.fonts.body,
            captionFont: theme.fonts.body,       // caption uses body font stack
            statFont: theme.fonts.heading,       // stats use heading font (bold/display)

            // Weight is capped by what each family really ships, so a theme may
            // override the house default. Asking 900 of a family whose heaviest
            // real cut is 700 does not produce a heavier face: the browser
            // smears the 700 outlines to synthesise one, and that fake bold is
            // one of the tells that makes generated video look generated. A
            // crisp real 700 beats a faked 900.
            //
            // Overrides exist only where the family is genuinely capped
            // upstream (Oswald 700, Bebas Neue 400, Libre Baskerville 700).
            // scripts/verify/theme-font-contract.js fails if any slot asks for
            // a weight with no matching file in assets/fonts.
            headingWeight: theme.fonts.headingWeight || '900',
            bodyWeight: theme.fonts.bodyWeight || '500',
            captionWeight: theme.fonts.captionWeight || '400',
            statWeight: theme.fonts.headingWeight || '900',   // stats ride the heading face
            emphasisWeight: theme.fonts.emphasisWeight || '700',
        },

        // ---- MG Chrome ----
        chrome: {
            bg: stylePreset.bg,
            glow: stylePreset.glow,
            borderRadius: stylePreset.borderRadius,
            strokeWidth: stylePreset.strokeWidth,
            shadowStyle: stylePreset.shadowStyle,
            shadowBlur: stylePreset.shadowBlur,
            shadowOffsetY: stylePreset.shadowOffsetY,
            cardStyle: stylePreset.cardStyle,
            lowerThirdStyle: stylePreset.lowerThirdStyle,
            lowerThirdAnimation: stylePreset.lowerThirdAnimation || 'slideLeft',
            lowerThirdOverride: LOWER_THIRD_THEME_OVERRIDES[theme.id] || null,
            mgOverrides: MG_THEME_OVERRIDES[theme.id] || {},
            chartBarRadius: stylePreset.chartBarRadius,
        },

        // ---- Transitions ----
        transitions: {
            primary: theme.transitions.primary,
            secondary: theme.transitions.secondary,
            avoid: theme.transitions.avoid,
        },

        // ---- Overlays ----
        overlays: {
            preferred: theme.overlays.preferred,
            avoid: theme.overlays.avoid,
            effects: theme.overlays.effects,
            effectParams: theme.effectParams || {},
            blendMode: theme.overlays.blendMode,
            intensityMin: theme.overlays.intensity.min,
            intensityMax: theme.overlays.intensity.max,
        },

        // ---- Background ----
        background: {
            type: theme.background,
            canvasPattern: theme.canvasBackground,
        },

        // ---- Templates ----
        templates: {
            overrides: TEMPLATE_THEME_OVERRIDES[theme.id] || {},
        },

        // ---- Raw modifier (for consumers that apply their own) ----
        modifier: mod,
    };
}

// Color modifier utility (same logic as app.js applyMGStyleModifier)
function _applyModifier(hexColor, mod) {
    if (!hexColor || !mod) return hexColor;
    try {
        const hsl = _hexToHSL(hexColor);
        let { h, s, l } = hsl;
        s = Math.min(100, s * (mod.saturate || 1));
        l = Math.max(5, Math.min(95, l + (mod.brighten || 0)));
        if (mod.tintHue !== null && mod.tintHue !== undefined) h = h * 0.5 + mod.tintHue * 0.5;
        return _hslToHex(h, s, l);
    } catch (e) { return hexColor; }
}

function _hexToHSL(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

function _hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    const toH = x => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toH(f(0))}${toH(f(8))}${toH(f(4))}`;
}

// Convert shadow RGBA to a lighter textSub color
// Secondary text derives from the PRIMARY text color so light themes get a
// soft dark tone (white-on-cream was unreadable) and dark themes keep soft white.
function _textSecondaryFor(colors = {}) {
    const m = String(colors.text || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return 'rgba(255,255,255,0.7)';
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',0.72)';
}

function _rgbaToTextSub(rgba) {
    // If shadow is themed (e.g. cyan glow), derive a matching textSub
    // Otherwise use standard white semi-transparent
    return 'rgba(255,255,255,0.7)';
}

/**
 * Get all MG style preset names
 * @returns {string[]}
 */
function getMGStylePresetNames() {
    return Object.keys(MG_STYLE_PRESETS);
}

/**
 * Get a single MG style preset
 * @param {string} styleName
 * @returns {Object}
 */
function getMGStylePreset(styleName) {
    return MG_STYLE_PRESETS[styleName] || MG_STYLE_PRESETS.clean;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Theme selection is visual-only. Niche detection lives in src/niches.js.
// Auto mode uses a guarded resolver: each niche has a safe allowlist, then
// tone/mood/topic signals choose among the existing five themes.

const AUTO_THEME_ALLOWLIST = {
    general: ['standard', 'modern', 'minimal'],

    explainer: ['standard', 'modern', 'minimal', 'history', 'warm-editorial'],
    'explainer.nature': ['nature', 'minimal', 'warm-editorial', 'standard'],
    'explainer.crime': ['crime', 'history', 'standard'],
    'explainer.business': ['standard', 'modern'],
    'explainer.luxury': ['luxury', 'history', 'standard'],
    'explainer.sport': ['modern', 'standard'],
    'explainer.history': ['history', 'crime', 'standard'],
    'explainer.motivation': ['minimal', 'warm-editorial', 'modern', 'standard'],
    'explainer.food': ['warm-editorial', 'minimal', 'standard'],
    'explainer.diy': ['warm-editorial', 'standard', 'minimal'],
    'explainer.military': ['crime', 'history', 'modern', 'standard'],
    'explainer.tech': ['modern', 'standard'],
    'explainer.politics': ['standard', 'modern', 'crime', 'history'],

    news: ['modern', 'standard'],
    'news.politics': ['standard', 'modern', 'crime'],
    'news.celebrity': ['modern', 'standard', 'history'],
    'news.economy': ['standard', 'modern'],
    'news.military': ['crime', 'modern', 'standard'],
    'news.tech': ['modern', 'standard'],
    'news.sport': ['modern', 'standard'],
};

const THEME_SIGNAL_RULES = [
    {
        theme: 'crime',
        weight: 4,
        label: 'dark/investigative/conflict signal',
        terms: ['crime', 'murder', 'detective', 'mystery', 'investigation', 'forensic', 'courtroom', 'suspect', 'war', 'conflict', 'missile', 'strike', 'attack', 'threat', 'invasion', 'terror', 'surveillance', 'classified'],
    },
    {
        theme: 'warm-editorial',
        weight: 4,
        label: 'craft/tradition/homestead signal',
        terms: ['recipe', 'cooking', 'baking', 'farm', 'farming', 'homestead', 'craft', 'handmade', 'woodworking', 'amish', 'traditional', 'vintage', 'artisan', 'garden', 'kitchen', 'diy', 'restore', 'restoration'],
    },
    {
        theme: 'luxury',
        weight: 4,
        label: 'luxury/wealth/premium signal',
        terms: ['luxury', 'billionaire', 'millionaire', 'yacht', 'mansion', 'private jet', 'wealth', 'exclusive', 'premium', 'high-end', 'rolex', 'penthouse', 'fortune'],
    },
    {
        theme: 'nature',
        weight: 4,
        label: 'nature/wildlife/environment signal',
        terms: ['wildlife', 'forest', 'ocean', 'animals', 'species', 'ecosystem', 'jungle', 'safari', 'predator', 'nature', 'climate', 'wilderness', 'habitat'],
    },
    {
        theme: 'history',
        weight: 4,
        label: 'archival/history/elegant signal',
        terms: ['history', 'historical', 'ancient', 'medieval', 'century', 'empire', 'civilization', 'dynasty', 'archival', 'archive', 'biography', 'heritage', 'legacy', 'luxury', 'premium', 'elegant', 'royal'],
    },
    {
        theme: 'modern',
        weight: 4,
        label: 'urgent/tech/sports/high-energy signal',
        terms: ['breaking', 'urgent', 'today', 'live', 'launch', 'release', 'update', 'viral', 'technology', 'tech', 'ai', 'cyber', 'software', 'semiconductor', 'sports', 'sport', 'football', 'championship', 'fast-paced', 'dynamic'],
    },
    {
        theme: 'minimal',
        weight: 4,
        label: 'calm/organic/wellness signal',
        terms: ['nature', 'wildlife', 'forest', 'ocean', 'organic', 'calm', 'peaceful', 'food', 'nutrition', 'health', 'wellness', 'motivation', 'mindset', 'inspirational', 'slow', 'gentle'],
    },
    {
        theme: 'standard',
        weight: 4,
        label: 'professional/policy/business signal',
        terms: ['business', 'finance', 'economy', 'market', 'corporate', 'company', 'strategy', 'analysis', 'policy', 'government', 'diplomacy', 'education', 'explainer', 'professional', 'neutral'],
    },
];

function getAllowedThemesForNiche(nicheId) {
    const id = String(nicheId || 'general');
    const exact = AUTO_THEME_ALLOWLIST[id];
    if (exact) return exact.filter(themeId => THEMES[themeId]);

    const parent = id.split('.')[0];
    const parentAllowed = AUTO_THEME_ALLOWLIST[parent] || AUTO_THEME_ALLOWLIST.general;
    return parentAllowed.filter(themeId => THEMES[themeId]);
}

function resolveThemeForContext(scriptContext = {}, niche = {}, directorsBrief = {}) {
    const override = directorsBrief.themeOverride;
    if (override && override !== 'auto' && THEMES[override]) {
        return {
            themeId: override,
            source: 'user',
            reason: 'user override',
            allowedThemes: getAllowedThemesForNiche(scriptContext.nicheId || niche.id),
            scores: { [override]: 999 },
        };
    }

    const nicheId = scriptContext.nicheId || niche.id || 'general';
    const allowedThemes = getAllowedThemesForNiche(nicheId);
    const fallbackTheme = _safeThemeInAllowlist(niche.defaultTheme || 'standard', allowedThemes);
    const scores = {};
    const reasons = {};

    allowedThemes.forEach((themeId, idx) => {
        scores[themeId] = idx === 0 ? 2 : 0;
        reasons[themeId] = idx === 0 ? ['niche baseline'] : [];
    });
    if (scores[fallbackTheme] != null) {
        scores[fallbackTheme] += 1;
        reasons[fallbackTheme].push(`niche.defaultTheme=${fallbackTheme}`);
    }

    const text = _themeSignalText(scriptContext);
    for (const rule of THEME_SIGNAL_RULES) {
        if (scores[rule.theme] == null) continue;
        const hits = _countThemeTermHits(text, rule.terms);
        if (hits > 0) {
            const boost = rule.weight + Math.min(3, hits - 1);
            scores[rule.theme] += boost;
            reasons[rule.theme].push(`${rule.label} (${hits})`);
        }
    }

    _applyThemeContextBoosts(scores, reasons, scriptContext, nicheId);

    const themeId = allowedThemes
        .slice()
        .sort((a, b) => (scores[b] - scores[a]) || (allowedThemes.indexOf(a) - allowedThemes.indexOf(b)))[0]
        || fallbackTheme;

    return {
        themeId,
        source: 'auto-resolver',
        reason: (reasons[themeId] || []).join('; ') || 'niche baseline',
        allowedThemes,
        scores,
    };
}

function _safeThemeInAllowlist(themeId, allowedThemes) {
    if (themeId && allowedThemes.includes(themeId)) return themeId;
    return allowedThemes[0] || 'standard';
}

function _themeSignalText(scriptContext = {}) {
    return [
        scriptContext.summary,
        scriptContext.theme,
        scriptContext.tone,
        scriptContext.mood,
        scriptContext.pacing,
        scriptContext.eventType,
        scriptContext.format,
        ...(Array.isArray(scriptContext.entities) ? scriptContext.entities : []),
        ...(Array.isArray(scriptContext.mainPoints) ? scriptContext.mainPoints : []),
    ].filter(Boolean).join(' ').toLowerCase();
}

function _applyThemeContextBoosts(scores, reasons, scriptContext = {}, nicheId = '') {
    const text = _themeSignalText(scriptContext);
    const eventType = String(scriptContext.eventType || '').toLowerCase();
    const tone = String(scriptContext.tone || '').toLowerCase();
    const pacing = String(scriptContext.pacing || '').toLowerCase();

    const add = (themeId, points, reason) => {
        if (scores[themeId] == null) return;
        scores[themeId] += points;
        reasons[themeId].push(reason);
    };

    if (nicheId.startsWith('news') || eventType.includes('ongoing') || /\b(breaking|urgent|live|today)\b/.test(text)) {
        add('modern', 3, 'current/breaking treatment');
    }
    if (/\b(business|economy|market|corporate|finance|policy|analysis)\b/.test(text) || nicheId.includes('business') || nicheId.includes('economy')) {
        add('standard', 3, 'professional information treatment');
    }
    if (/\b(war|conflict|attack|missile|crime|murder|investigation|threat)\b/.test(text) || tone.includes('dark')) {
        add('crime', 3, 'serious risk/dark treatment');
    }
    if (/\b(history|historical|ancient|archival|biography|heritage|legacy|luxury|premium)\b/.test(text)) {
        add('history', 3, 'archival/elegant treatment');
    }
    if (/\b(nature|wildlife|food|health|wellness|motivation|calm|organic)\b/.test(text) || pacing === 'slow') {
        add('minimal', 3, 'calm/organic treatment');
    }
    if (/\b(tech|technology|ai|cyber|sports|sport|dynamic|fast)\b/.test(text) || pacing === 'fast') {
        add('modern', 2, 'high-energy treatment');
    }

    if (nicheId === 'explainer.politics' && !/\b(breaking|urgent|war|attack|missile)\b/.test(text)) {
        add('standard', 2, 'serious policy explainer baseline');
    }
    if (nicheId === 'explainer.military' && /\b(history|historical|cold war|world war|ancient|archival)\b/.test(text)) {
        add('history', 5, 'military history treatment');
    }
    if (nicheId === 'explainer.motivation' && /\b(grind|hustle|discipline|high energy|fast)\b/.test(text)) {
        add('modern', 10, 'energetic motivation treatment');
    }
}

function _countThemeTermHits(text, terms) {
    let hits = 0;
    for (const term of terms) {
        if (_themeTextHasTerm(text, term)) hits++;
    }
    return hits;
}

function _themeTextHasTerm(text, term) {
    const raw = String(term || '').trim().toLowerCase();
    if (!raw) return false;
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^[a-z0-9]/i.test(raw) ? '\\b' : '';
    const right = /[a-z0-9]$/i.test(raw) ? '\\b' : '';
    return new RegExp(`${left}${escaped}${right}`, 'i').test(text);
}

/**
 * Get theme object by ID
 * @param {string} themeId - Theme identifier
 * @returns {Object} Theme object
 */
function getTheme(themeId) {
    return THEMES[themeId] || THEMES.standard;
}

/**
 * Get all available theme IDs
 * @returns {Array<string>} Array of theme IDs
 */
function getThemeIds() {
    return Object.keys(THEMES);
}

/**
 * Get all themes (for UI dropdown)
 * @returns {Array<Object>} Array of theme objects with id, name, description
 */
function getAllThemes() {
    return Object.values(THEMES).map(t => ({
        id: t.id,
        name: t.name,
        description: t.description
    }));
}

/**
 * Get background source info for a theme
 * @param {string} themeId - Theme identifier
 * @returns {Object} Background source info
 */
function getBackgroundSource(themeId) {
    const theme = getTheme(themeId);
    return BACKGROUND_SOURCES[theme.background] || BACKGROUND_SOURCES.neutral;
}

// ============================================================
// EXPORTS
// ============================================================

const THEME_API = {
    THEMES,
    BACKGROUND_SOURCES,
    BACKGROUND_LIBRARY,
    getThemeBackgrounds,
    TRANSITION_LIBRARY,
    TRANSITION_SFX_SOURCES,
    MG_STYLE_PRESETS,
    MG_THEME_OVERRIDES,
    LOWER_THIRD_THEME_OVERRIDES,
    TEMPLATE_THEME_OVERRIDES,
    getTheme,
    getThemeIds,
    getAllThemes,
    getAllowedThemesForNiche,
    resolveThemeForContext,
    getBackgroundSource,
    getMatchingBackgrounds,
    getThemeTokens,
    getMGStylePreset,
    getMGStylePresetNames,
    applyModifier: _applyModifier,
};
if (typeof module !== 'undefined' && module.exports) {
    module.exports = THEME_API;
}
if (typeof window !== 'undefined') {
    window._themeTokens = {
        getTokens: THEME_API.getThemeTokens,
        getStylePreset: THEME_API.getMGStylePreset,
        stylePresetNames: THEME_API.getMGStylePresetNames(),
        themeIds: THEME_API.getThemeIds(),
        applyModifier: THEME_API.applyModifier,
    };
}
})();
