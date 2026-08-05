/**
 * MGRenderer.js — Motion Graphics renderer via Canvas2D -> WebGL texture
 * Renders MG overlays to an offscreen canvas, then uploads as a texture.
 *
 * All 14 canvas MG types ported from src/canvas-mg-renderer.js.
 */

class MGRenderer {
    constructor(textureManager, fps) {
        this.textureManager = textureManager;
        this.fps = fps;
        // Offscreen canvas for 2D drawing
        this._canvas = document.createElement('canvas');
        this._canvas.width = 1920;
        this._canvas.height = 1080;
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });
        this._shadowCanvas = document.createElement('canvas');
        this._shadowCanvas.width = 1920;
        this._shadowCanvas.height = 1080;
        this._shadowCtx = this._shadowCanvas.getContext('2d', { willReadFrequently: false });
        // Preview scale (1.0 = full, 0.5 = half-res for faster Canvas2D)
        this._previewScale = 1.0;
        // Cache for loaded map images (mapImageFile → HTMLImageElement)
        this._mapImages = {};
        this._mapImageLoading = {};
        // Cache for loaded map waypoint icons (keyword → HTMLImageElement)
        this._mapIcons = {};
        this._mapIconLoading = {};
        // Cache for loaded explainer images (explainerImageFile → HTMLImageElement)
        this._explainerImages = {};
        this._explainerImageLoading = {};
        // Cache for loaded article images (articleImageFile → HTMLImageElement)
        this._articleImages = {};
        this._articleImageLoading = {};
        // Cache for listicle grid thumbnails (mediaFile → HTMLCanvasElement with extracted frame)
        this._gridThumbs = {};
        this._gridThumbLoading = {};
        this._templateBgFrameCache = {};
        this._templateMedia = {};
        this._templateMediaLoading = {};
        this._templateMediaPromises = {};
        // Underlying V1 media element (video/image) — set by Compositor before renderMG for templates
        this._underlyingMedia = null;

        // ── Registry-driven rendering ──
        // Category renderers: 'mgType' → function(ctx, frame, fps, mg, s, anim, scriptContext)
        // Each category's main dispatcher (handles setup + variant resolution)
        this._categoryRenderers = {
            headline:       (ctx, f, fps, mg, s, a, sc) => this._renderHeadline(ctx, f, fps, mg, s, a),
            lowerThird:     (ctx, f, fps, mg, s, a, sc) => this._renderLowerThird(ctx, f, fps, mg, s, a),
            callout:        (ctx, f, fps, mg, s, a, sc) => this._renderCallout(ctx, f, fps, mg, s, a),
            focusWord:      (ctx, f, fps, mg, s, a, sc) => this._renderFocusWord(ctx, f, fps, mg, s, a),
            statCounter:    (ctx, f, fps, mg, s, a, sc) => this._renderStatCounter(ctx, f, fps, mg, s, a),
            bulletList:     (ctx, f, fps, mg, s, a, sc) => this._renderBulletList(ctx, f, fps, mg, s, a),
            progressBar:    (ctx, f, fps, mg, s, a, sc) => this._renderProgressBar(ctx, f, fps, mg, s, a),
            barChart:       (ctx, f, fps, mg, s, a, sc) => this._renderBarChart(ctx, f, fps, mg, s, a),
            donutChart:     (ctx, f, fps, mg, s, a, sc) => this._renderDonutChart(ctx, f, fps, mg, s, a),
            comparisonCard: (ctx, f, fps, mg, s, a, sc) => this._renderComparisonCard(ctx, f, fps, mg, s, a),
            timeline:       (ctx, f, fps, mg, s, a, sc) => this._renderTimeline(ctx, f, fps, mg, s, a),
            rankingList:    (ctx, f, fps, mg, s, a, sc) => this._renderRankingList(ctx, f, fps, mg, s, a),
            kineticText:    (ctx, f, fps, mg, s, a, sc) => this._renderKineticText(ctx, f, fps, mg, s, a),
            typewriter:     (ctx, f, fps, mg, s, a, sc) => this._renderTypewriter(ctx, f, fps, mg, s, a),
            subscribeCTA:   (ctx, f, fps, mg, s, a, sc) => this._renderSubscribeCTA(ctx, f, fps, mg, s, a),
            mapChart:       (ctx, f, fps, mg, s, a, sc) => { this._ensureMapImage(mg); this._ensureMapIcons(mg); this._renderMapChart(ctx, f, fps, mg, s, a, sc); },
            explainer:      (ctx, f, fps, mg, s, a, sc) => { this._ensureExplainerImage(mg); this._renderExplainer(ctx, f, fps, mg, s, a, sc); },
            articleHighlight: (ctx, f, fps, mg, s, a, sc) => { this._ensureArticleImage(mg); this._renderArticleHighlight(ctx, f, fps, mg, s, a); },
            listicleCounter: (ctx, f, fps, mg, s, a, sc) => this._renderListicleCounter(ctx, f, fps, mg, s, a),
            progressTracker: (ctx, f, fps, mg, s, a, sc) => this._renderProgressTracker(ctx, f, fps, mg, s, a),
            listicleGrid:    (ctx, f, fps, mg, s, a, sc) => { this._ensureGridThumbnails(mg); this._renderListicleGrid(ctx, f, fps, mg, s, a); },
            // Template types (from ai-templates.js)
            // _ensureTemplateMedia loads the scene's video/image for template background (universal)
            // _ensureTemplateBgImage loads the downloaded bg media (video/image fallback)
            chapterCard:     (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._ensureTemplateBgImage(mg); this._renderChapterCard(ctx, f, fps, mg, s, a); },
            locationCard:    (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._ensureTemplateBgImage(mg); this._renderLocationCard(ctx, f, fps, mg, s, a); },
            quoteCard:       (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._renderQuoteCard(ctx, f, fps, mg, s, a); },
            keyTakeaway:     (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._renderKeyTakeaway(ctx, f, fps, mg, s, a); },
            timelineCard:    (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._renderTimelineCard(ctx, f, fps, mg, s, a); },
            factCard:        (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._ensureTemplateBgImage(mg); this._renderFactCard(ctx, f, fps, mg, s, a); },
            imageShowcase:   (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._ensureGridThumbnails(mg); this._renderImageShowcase(ctx, f, fps, mg, s, a); },
            statCard:        (ctx, f, fps, mg, s, a, sc) => { this._ensureTemplateMedia(mg); this._ensureTemplateBgImage(mg); this._renderStatCard(ctx, f, fps, mg, s, a); },
            personIntro:     (ctx, f, fps, mg, s, a, sc) => { this._ensureGridThumbnails(mg); this._renderPersonIntro(ctx, f, fps, mg, s, a); },
            splitScreen:     (ctx, f, fps, mg, s, a, sc) => { this._ensureGridThumbnails(mg); this._renderSplitScreen(ctx, f, fps, mg, s, a); },
            infographic:     (ctx, f, fps, mg, s, a, sc) => { this._ensureGridThumbnails(mg); this._renderInfographic(ctx, f, fps, mg, s, a); },
        };

        // Variant renderers: 'category:variant' → function(ctx, mg, s, anim, a, setup)
        // 'setup' is a category-specific context object (e.g. {bx, by, bw, bh, colors} for lowerThird)
        this._variantRenderers = {
            // Headline variants
            'headline:standard':    (ctx, mg, s, anim, a, p) => this._renderHL_Standard(ctx, mg, s, anim, a, p),
            'headline:stamp':       (ctx, mg, s, anim, a, p) => this._renderHL_Stamp(ctx, mg, s, anim, a, p),
            'headline:typewriter':  (ctx, mg, s, anim, a, p) => this._renderHL_Typewriter(ctx, mg, s, anim, a, p),
            // LowerThird variants
            'lowerThird:bar':       (ctx, mg, s, anim, a, p) => this._renderLT_Bar(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.ls),
            'lowerThird:box':       (ctx, mg, s, anim, a, p) => this._renderLT_Box(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.ls),
            'lowerThird:underline': (ctx, mg, s, anim, a, p) => this._renderLT_Underline(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.ls),
            'lowerThird:banner':    (ctx, mg, s, anim, a, p) => this._renderLT_Banner(ctx, mg, s, anim, a, p.by, p.bw, p.ls),
            'lowerThird:glass':     (ctx, mg, s, anim, a, p) => this._renderLT_Glass(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.ls),
            'lowerThird:split':     (ctx, mg, s, anim, a, p) => this._renderLT_Split(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.ls),
            // Callout variants
            'callout:standard':     (ctx, mg, s, anim, a, p) => this._renderCO_Standard(ctx, mg, s, anim, a, p),
            'callout:minimal':      (ctx, mg, s, anim, a, p) => this._renderCO_Minimal(ctx, mg, s, anim, a, p),
            'callout:accent':       (ctx, mg, s, anim, a, p) => this._renderCO_Accent(ctx, mg, s, anim, a, p),
            // StatCounter variants
            'statCounter:standard': (ctx, mg, s, anim, a, p) => this._renderSC_Standard(ctx, mg, s, anim, a, p),
            'statCounter:ticker':   (ctx, mg, s, anim, a, p) => this._renderSC_Ticker(ctx, mg, s, anim, a, p),
            'statCounter:ring':     (ctx, mg, s, anim, a, p) => this._renderSC_Ring(ctx, mg, s, anim, a, p),
            // Typewriter variants
            'typewriter:standard':  (ctx, mg, s, anim, a, p) => this._renderTW_Standard(ctx, mg, s, anim, a, p),
            'typewriter:naked':     (ctx, mg, s, anim, a, p) => this._renderTW_Naked(ctx, mg, s, anim, a, p),
            // ListicleCounter variants
            'listicleCounter:badge':   (ctx, mg, s, anim, a, p) => this._renderLC_Badge(ctx, mg, s, anim, a, p),
            'listicleCounter:pill':    (ctx, mg, s, anim, a, p) => this._renderLC_Pill(ctx, mg, s, anim, a, p),
            'listicleCounter:ribbon':  (ctx, mg, s, anim, a, p) => this._renderLC_Ribbon(ctx, mg, s, anim, a, p),
            'listicleCounter:minimal': (ctx, mg, s, anim, a, p) => this._renderLC_Minimal(ctx, mg, s, anim, a, p),
            // ProgressTracker variants
            'progressTracker:bar':      (ctx, mg, s, anim, a, p) => this._renderPT_Bar(ctx, mg, s, anim, a, p),
            'progressTracker:dots':     (ctx, mg, s, anim, a, p) => this._renderPT_Dots(ctx, mg, s, anim, a, p),
            'progressTracker:fraction': (ctx, mg, s, anim, a, p) => this._renderPT_Fraction(ctx, mg, s, anim, a, p),
            // ListicleGrid variants
            'listicleGrid:grid':        (ctx, mg, s, anim, a, p) => this._renderLG_Grid(ctx, mg, s, anim, a, p),
            'listicleGrid:strip':       (ctx, mg, s, anim, a, p) => this._renderLG_Strip(ctx, mg, s, anim, a, p),
            'listicleGrid:stack':       (ctx, mg, s, anim, a, p) => this._renderLG_Stack(ctx, mg, s, anim, a, p),
        };

        // Animation computers: 'animType' → function(frame, fps, anim, mg) → state object
        this._animComputers = {
            slideLeft:   (f, fps, anim, mg) => this._computeAnim_slideLeft(f, fps, anim, mg),
            wipeRight:   (f, fps, anim, mg) => this._computeAnim_wipeRight(f, fps, anim, mg),
            popUp:       (f, fps, anim, mg) => this._computeAnim_popUp(f, fps, anim, mg),
            fadeSlide:   (f, fps, anim, mg) => this._computeAnim_fadeSlide(f, fps, anim, mg),
            springScale: (f, fps, anim, mg) => this._computeAnim_springScale(f, fps, anim, mg),
            typewriter:  (f, fps, anim, mg) => this._computeAnim_typewriter(f, fps, anim, mg),
            wordCascade: (f, fps, anim, mg) => this._computeAnim_wordCascade(f, fps, anim, mg),
        };
    }

    // ── Public registration API ──
    // Call these to extend the renderer with new categories, variants, or animations
    // without editing any existing code.

    /**
     * Register a new MG category renderer.
     * @param {string} type - MG type key (e.g. 'myNewType')
     * @param {Function} fn - (ctx, frame, fps, mg, s, anim, scriptContext) => void
     */
    registerCategory(type, fn) {
        this._categoryRenderers[type] = fn;
    }

    /**
     * Register a variant renderer for a category.
     * @param {string} category - MG type key (e.g. 'lowerThird')
     * @param {string} variant - Variant key (e.g. 'military')
     * @param {Function} fn - (ctx, mg, s, anim, animState, setup) => void
     */
    registerVariant(category, variant, fn) {
        this._variantRenderers[`${category}:${variant}`] = fn;
    }

    /**
     * Register an animation computer.
     * @param {string} animType - Animation key (e.g. 'glitchIn')
     * @param {Function} fn - (frame, fps, anim, mg) => state object
     */
    registerAnimation(animType, fn) {
        this._animComputers[animType] = fn;
    }

    /**
     * Set preview scale. Resizes the offscreen canvas.
     * Drawing code still uses 1920x1080 coordinates via ctx.scale().
     */
    setPreviewScale(scale) {
        this._previewScale = Math.max(0.25, Math.min(1.0, scale));
        const w = Math.round(1920 * this._previewScale);
        const h = Math.round(1080 * this._previewScale);
        if (this._canvas.width !== w || this._canvas.height !== h) {
            this._canvas.width = w;
            this._canvas.height = h;
            console.log(`[MGRenderer] Canvas resized to ${w}x${h} (scale: ${this._previewScale})`);
        }
        // Shadow canvas must match so the shadow pass doesn't pack content into the top-left
        // (overlay MGs were rendering small + at 0,0 when shadow canvas stayed at 1920×1080)
        if (this._shadowCanvas && (this._shadowCanvas.width !== w || this._shadowCanvas.height !== h)) {
            this._shadowCanvas.width = w;
            this._shadowCanvas.height = h;
        }
    }

    /**
     * Phase B: resolve the authoritative MapScene + renderAssets for a mapChart MG.
     * New builds attach `_mapScene` end-to-end (compiler → provider → build-video
     * merge-back → video-plan.json → SceneGraph). Old video-plan.json files
     * without `_mapScene` still work via the per-field legacy fallbacks below.
     * A one-shot warning fires the first time the legacy path is taken — but only
     * when called from the actual draw path (`warn: true`). Preload helpers stay
     * silent so the warning can't race ahead of render and mislead debugging.
     */
    _resolveMapData(mg) {
        // Slice 6B: MapScene.renderAssets is the sole source of truth.
        // mg.mgData?._mapScene covers plans loaded from disk where mg was
        // reconstructed from mgData (subType/styling live on mg, map data on
        // mgData._mapScene). A missing _mapScene / _ra at render time is a
        // real error — _renderMapChart logs and bails to fallback bg.
        const ms = mg._mapScene || mg.mgData?._mapScene || null;
        const ra = ms?.renderAssets || null;
        return { ms, ra };
    }

    /**
     * Lazily load a map image for mapChart MGs. Non-blocking.
     * Once loaded, subsequent renders will draw it as background.
     */
    _ensureMapImage(mg) {
        const { ra } = this._resolveMapData(mg);
        // Phase B: filename comes from MapScene.renderAssets when present; the
        // browser-resolved URL still rides on mg (runtime, not build-time data).
        const file = ra?.mapImageFile;
        const url = mg._mapImageUrl;
        if (!file || this._mapImages[file] || this._mapImageLoading[file]) return;
        if (!url) return; // URL not yet resolved by app.js
        this._mapImageLoading[file] = true;
        const img = new Image();
        img.onload = () => {
            this._mapImages[file] = img;
            delete this._mapImageLoading[file];
            console.log(`[MGRenderer] Map image loaded: ${file}`);
        };
        img.onerror = () => {
            delete this._mapImageLoading[file];
            console.warn(`[MGRenderer] Failed to load map image: ${file}`);
        };
        img.src = url;

        // Also load per-waypoint tile images
        const wpTileUrls = mg._wpTileUrls || {};
        for (const key of Object.keys(wpTileUrls)) {
            const wpFile = `__map_wp_${key}.png`;
            if (this._mapImages[wpFile] || this._mapImageLoading[wpFile]) continue;
            this._mapImageLoading[wpFile] = true;
            const wpImg = new Image();
            wpImg.onload = () => {
                this._mapImages[wpFile] = wpImg;
                delete this._mapImageLoading[wpFile];
            };
            wpImg.onerror = () => { delete this._mapImageLoading[wpFile]; };
            wpImg.src = wpTileUrls[key];
        }
    }

    /**
     * Lazily load map waypoint icons. Non-blocking.
     * Uses _mapIcons from build pipeline (file paths) or icon URLs.
     */
    _ensureMapIcons(mg) {
        const { ra } = this._resolveMapData(mg);
        const icons = ra?.icons;
        if (!icons || typeof icons !== 'object') return;
        for (const [name, iconPath] of Object.entries(icons)) {
            const key = `__mapicon_${name}`;
            if (this._mapIcons[key] || this._mapIconLoading[key]) continue;
            this._mapIconLoading[key] = true;
            const img = new Image();
            img.onload = () => {
                this._mapIcons[key] = img;
                delete this._mapIconLoading[key];
            };
            img.onerror = () => { delete this._mapIconLoading[key]; };
            // Remote/data/asset URLs are already browser-safe. Local paths and
            // legacy file: URLs must pass through the confined asset protocol.
            if (/^(https?:|data:|blob:|asset:)/i.test(iconPath)) {
                img.src = iconPath;
            } else if (window.electronAPI?.getFileUrl) {
                window.electronAPI.getFileUrl(iconPath).then(url => { if (url) img.src = url; });
            } else if (!/^(?:[a-z]:[\\/]|\\\\|\/|file:)/i.test(iconPath)) {
                img.src = iconPath;
            } else {
                delete this._mapIconLoading[key];
            }
        }
    }

    /**
     * Lazily load an article screenshot image. Non-blocking.
     */
    _ensureArticleImage(mg) {
        const file = mg.articleImageFile;
        const url = mg._articleImageUrl;
        if (!file || this._articleImages[file] || this._articleImageLoading[file]) return;
        if (!url) return;
        this._articleImageLoading[file] = true;
        const img = new Image();
        img.onload = () => {
            this._articleImages[file] = img;
            delete this._articleImageLoading[file];
            console.log(`[MGRenderer] Article image loaded: ${file}`);
        };
        img.onerror = () => {
            delete this._articleImageLoading[file];
            console.warn(`[MGRenderer] Failed to load article image: ${file}`);
        };
        img.src = url;
    }

    /**
     * Lazily load template background media. Non-blocking.
     */
    _ensureTemplateBgImage(mg) {
        const file = mg.templateBgFile;
        const url = mg._templateBgUrl;
        if (!file || !url) return;
        if (!this._templateBgImages) this._templateBgImages = {};
        if (!this._templateBgLoading) this._templateBgLoading = {};
        if (this._templateBgImages[file] || this._templateBgLoading[file]) return;
        this._templateBgLoading[file] = true;

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
                this._templateBgImages[file] = video;
                delete this._templateBgLoading[file];
                console.log(`[MGRenderer] Template bg loaded (video): ${file}`);
            };
            video.onerror = () => {
                delete this._templateBgLoading[file];
                console.warn(`[MGRenderer] Failed to load template bg: ${file}`);
                if (video.parentNode) video.parentNode.removeChild(video);
            };
            video.src = url;
        } else {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                this._templateBgImages[file] = img;
                delete this._templateBgLoading[file];
                console.log(`[MGRenderer] Template bg loaded (image): ${file}`);
            };
            img.onerror = () => {
                delete this._templateBgLoading[file];
                console.warn(`[MGRenderer] Failed to load template bg: ${file}`);
            };
            img.src = url;
        }
    }

    /**
     * Lazily load a template's scene media (video or image). Non-blocking.
     * This is the footage clip that was downloaded for the scene before it was carved for the template.
     */
    _loadTemplateMedia(mg) {
        const file = mg.templateMediaFile;
        const url = mg._templateMediaUrl;
        if (!file || !url) return Promise.resolve(null);
        if (this._templateMedia[file]) return Promise.resolve(this._templateMedia[file]);
        if (this._templateMediaPromises[file]) return this._templateMediaPromises[file];
        this._templateMediaLoading[file] = true;

        const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(file);
        if (isVideo) {
            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.style.display = 'none';
            document.body.appendChild(video);
            this._templateMediaPromises[file] = new Promise(resolve => {
                let resolved = false;
                const done = (ok) => {
                    if (resolved) return;
                    resolved = true;
                    video.removeEventListener('canplaythrough', onReady);
                    video.removeEventListener('loadeddata', onLoadedData);
                    video.removeEventListener('seeked', onSeeked);
                    video.removeEventListener('error', onError);
                    clearTimeout(timer);
                    delete this._templateMediaLoading[file];
                    delete this._templateMediaPromises[file];
                    if (ok) {
                        this._templateMedia[file] = video;
                        console.log(`[MGRenderer] Template media loaded (video): ${file.split(/[/\\]/).pop()}`);
                        resolve(video);
                    } else {
                        console.warn(`[MGRenderer] Failed to load template media: ${file.split(/[/\\]/).pop()}`);
                        if (video.parentNode) video.parentNode.removeChild(video);
                        resolve(null);
                    }
                };
                const warmToOffset = () => {
                    const warmTime = Math.max(0, Number(mg.templateMediaOffset) || 0);
                    if (video.readyState >= 2 && Math.abs((video.currentTime || 0) - warmTime) <= 0.08) {
                        done(true);
                        return;
                    }
                    try {
                        video.currentTime = Math.min(warmTime, video.duration || warmTime);
                    } catch (e) {
                        done(true);
                    }
                };
                const onReady = warmToOffset;
                const onLoadedData = warmToOffset;
                const onSeeked = () => done(true);
                const onError = () => done(false);
                video.addEventListener('canplaythrough', onReady);
                video.addEventListener('loadeddata', onLoadedData);
                video.addEventListener('seeked', onSeeked);
                video.addEventListener('error', onError);
                const timer = setTimeout(() => {
                    if (video.readyState >= 2 && video.videoWidth > 0) done(true);
                    else done(false);
                }, 15000);
                video.src = url;
                video.load();
            });
            return this._templateMediaPromises[file];
        } else {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            this._templateMediaPromises[file] = new Promise(resolve => {
                img.onload = () => {
                    this._templateMedia[file] = img;
                    delete this._templateMediaLoading[file];
                    delete this._templateMediaPromises[file];
                    console.log(`[MGRenderer] Template media loaded (image): ${file.split(/[/\\]/).pop()}`);
                    resolve(img);
                };
                img.onerror = () => {
                    delete this._templateMediaLoading[file];
                    delete this._templateMediaPromises[file];
                    console.warn(`[MGRenderer] Failed to load template media: ${file.split(/[/\\]/).pop()}`);
                    resolve(null);
                };
                img.src = url;
            });
            return this._templateMediaPromises[file];
        }
    }

    _ensureTemplateMedia(mg) {
        this._loadTemplateMedia(mg);
    }

    async preloadTemplateMedia(templateScenes = [], mediaFileResolver = null) {
        const targets = (templateScenes || []).filter(mg => mg && mg.templateType && mg.templateMediaFile);
        if (targets.length === 0) return 0;

        const jobs = targets.map(async mg => {
            if (!mg._templateMediaUrl && mediaFileResolver) {
                try {
                    mg._templateMediaUrl = await mediaFileResolver(mg.templateMediaFile);
                } catch (e) {}
            }
            if (!mg._templateMediaUrl) return null;
            return this._loadTemplateMedia(mg);
        });
        const loaded = await Promise.all(jobs);
        return loaded.filter(Boolean).length;
    }

    /**
     * Draw a template background with cover-fit + scrim overlay.
     * Priority: underlying V1 video/image → static template bg image → false.
     * Returns true if drawn, false if no source available.
     */
    _drawTemplateBg(ctx, mg, W, H, alpha, options = {}) {
        // Explicit transparent template backgrounds intentionally draw nothing.
        // Return true so template renderers do not paint their solid/grid fallbacks.
        if (this._isTransparentTemplateBackground(mg)) return true;

        // Source priority: template scene media (video/image) → downloaded static bg → false
        let source = null;
        let srcW = 0, srcH = 0;
        let sourceIsSeeking = false;
        let cacheKey = mg.templateMediaFile || mg.templateBgFile || `template-${mg.id || mg._startFrame || 'bg'}`;
        const scrimAlpha = options.scrimAlpha == null ? 1 : options.scrimAlpha;
        const bgAlpha = mg.templateContentStartTime != null ? 1 : alpha;
        const drawScrim = () => {
            if (scrimAlpha <= 0) return;
            const scrim = ctx.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.75);
            scrim.addColorStop(0, 'rgba(0,0,0,0.3)');
            scrim.addColorStop(1, 'rgba(0,0,0,0.65)');
            ctx.globalAlpha = scrimAlpha;
            ctx.fillStyle = scrim;
            ctx.fillRect(0, 0, W, H);
        };
        const drawCached = () => {
            const cached = this._templateBgFrameCache && this._templateBgFrameCache[cacheKey];
            if (!cached) return false;
            ctx.save();
            ctx.globalAlpha = bgAlpha;
            ctx.drawImage(cached, 0, 0, W, H);
            drawScrim();
            ctx.restore();
            return true;
        };

        // 1. Try template's own scene media (video clip or image downloaded for this scene)
        if (this._templateMedia && mg.templateMediaFile) {
            const media = this._templateMedia[mg.templateMediaFile];
            if (media instanceof HTMLVideoElement && media.videoWidth > 0) {
                // Seek video to correct time for this template frame
                // Only seek if not already seeking and delta is large enough
                const offset = mg.templateMediaOffset || 0;
                const localTime = (this._currentRenderFrame || 0) / this.fps;
                const targetTime = offset + localTime;
                if (!media.seeking && Math.abs(media.currentTime - targetTime) > 0.15) {
                    media.currentTime = Math.min(targetTime, media.duration || targetTime);
                }
                sourceIsSeeking = media.seeking;
                // Use video as source even while seeking (shows last decoded frame)
                source = media;
                srcW = media.videoWidth;
                srcH = media.videoHeight;
            } else if (media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0) {
                source = media;
                srcW = media.naturalWidth;
                srcH = media.naturalHeight;
            }
        }

        // 2. Fallback: downloaded template bg media
        if (!source && this._templateBgImages) {
            const bg = this._templateBgImages[mg.templateBgFile];
            if (bg instanceof HTMLVideoElement && bg.videoWidth > 0) {
                cacheKey = mg.templateBgFile || cacheKey;
                const localTime = (this._currentRenderFrame || 0) / this.fps;
                const duration = bg.duration || 0;
                const targetTime = duration > 0.25
                    ? (localTime % Math.max(0.25, duration - 0.1))
                    : localTime;
                if (!bg.seeking && Math.abs(bg.currentTime - targetTime) > 0.15) {
                    bg.currentTime = Math.min(targetTime, duration || targetTime);
                }
                sourceIsSeeking = bg.seeking;
                source = bg;
                srcW = bg.videoWidth;
                srcH = bg.videoHeight;
            } else if (bg instanceof HTMLImageElement && bg.complete && bg.naturalWidth > 0) {
                cacheKey = mg.templateBgFile || cacheKey;
                source = bg;
                srcW = bg.naturalWidth || bg.width;
                srcH = bg.naturalHeight || bg.height;
            }
        }

        if (!source) {
            if (drawCached()) return true;
            return false;
        }
        if (sourceIsSeeking && drawCached()) return true;

        ctx.save();
        ctx.globalAlpha = bgAlpha;

        // Cover-fit
        const scale = Math.max(W / srcW, H / srcH);
        const sw = W / scale;
        const sh = H / scale;
        const sx = (srcW - sw) / 2;
        const sy = (srcH - sh) / 2;
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, W, H);

        if (!sourceIsSeeking && cacheKey) {
            let cached = this._templateBgFrameCache[cacheKey];
            if (!cached) {
                cached = document.createElement('canvas');
                cached.width = W;
                cached.height = H;
                this._templateBgFrameCache[cacheKey] = cached;
            }
            const cctx = cached.getContext('2d');
            cctx.clearRect(0, 0, W, H);
            cctx.drawImage(source, sx, sy, sw, sh, 0, 0, W, H);
        }

        // Cinematic scrim overlay for text readability.
        // Timed-reveal templates can render raw scene media outside the content
        // window so the clip stays visually continuous.
        if (scrimAlpha > 0) {
            const scrim = ctx.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.75);
            scrim.addColorStop(0, 'rgba(0,0,0,0.3)');
            scrim.addColorStop(1, 'rgba(0,0,0,0.65)');
            ctx.globalAlpha = scrimAlpha;
            ctx.fillStyle = scrim;
            ctx.fillRect(0, 0, W, H);
        }

        ctx.restore();
        return true;
    }

    /**
     * Lazily load thumbnails for listicle grid items.
     * Handles both images (jpg/png/webp) and videos (mp4 — extracts frame at 1s).
     */
    _ensureGridThumbnails(mg) {
        const thumbs = mg._itemThumbnails;
        if (!thumbs || !Array.isArray(thumbs)) return;
        const resolvedUrls = mg._itemThumbnailUrls; // Pre-resolved asset:// URLs from app.js

        for (let i = 0; i < thumbs.length; i++) {
            const raw = thumbs[i];
            if (!raw) continue;
            // Strip to just filename for cache key
            const file = raw.replace(/^.*[/\\]/, '');
            if (this._gridThumbs[file] || this._gridThumbLoading[file]) continue;

            this._gridThumbLoading[file] = true;
            // Use pre-resolved asset URL if available, fallback to media/ prefix
            const url = (resolvedUrls && resolvedUrls[i]) || `media/${file}`;
            const isVideo = /\.(mp4|webm|mkv|mov)$/i.test(file);

            if (isVideo) {
                // Extract frame from video at 1s
                const video = document.createElement('video');
                video.crossOrigin = 'anonymous';
                video.muted = true;
                video.preload = 'auto';
                video.onloadeddata = () => {
                    video.currentTime = Math.min(1, video.duration * 0.2);
                };
                video.onseeked = () => {
                    try {
                        const c = document.createElement('canvas');
                        c.width = 320; c.height = 180;
                        const cx = c.getContext('2d');
                        cx.drawImage(video, 0, 0, 320, 180);
                        this._gridThumbs[file] = c;
                        delete this._gridThumbLoading[file];
                        video.src = ''; // release
                    } catch (e) {
                        delete this._gridThumbLoading[file];
                    }
                };
                video.onerror = () => { delete this._gridThumbLoading[file]; };
                video.src = url;
            } else {
                // Load image directly
                const img = new Image();
                img.onload = () => {
                    this._gridThumbs[file] = img;
                    delete this._gridThumbLoading[file];
                };
                img.onerror = () => { delete this._gridThumbLoading[file]; };
                img.src = url;
            }
        }
    }

    /**
     * Get a loaded thumbnail for a media file, or null if not ready yet.
     */
    _getGridThumb(file) {
        if (!file) return null;
        // Look up by stripped filename (thumbnails cached by filename, not full path)
        const name = file.replace(/^.*[/\\]/, '');
        return this._gridThumbs[name] || null;
    }

    /**
     * Lazily load an explainer transparent PNG. Non-blocking.
     */
    _ensureExplainerImage(mg) {
        const file = mg.explainerImageFile;
        const url = mg._explainerImageUrl;
        if (!file || this._explainerImages[file] || this._explainerImageLoading[file]) return;
        if (!url) return; // URL not yet resolved by app.js
        this._explainerImageLoading[file] = true;
        const img = new Image();
        img.onload = () => {
            this._explainerImages[file] = img;
            delete this._explainerImageLoading[file];
            console.log(`[MGRenderer] Explainer image loaded: ${file}`);
        };
        img.onerror = () => {
            delete this._explainerImageLoading[file];
            console.warn(`[MGRenderer] Failed to load explainer image: ${file}`);
        };
        img.src = url;
    }

    _getTemplateContentWindow(mg, localFrame) {
        if (!mg || !mg.templateType) return null;
        const offsetSec = Number(mg.templateContentOffset);
        const durationSec = Number(mg.templateContentDuration);
        if (!Number.isFinite(offsetSec) || !Number.isFinite(durationSec) || durationSec <= 0) return null;

        const startFrame = Math.max(0, Math.round(offsetSec * this.fps));
        const durationFrames = Math.max(1, Math.round(durationSec * this.fps));
        const endFrame = startFrame + durationFrames;

        return {
            active: localFrame >= startFrame && localFrame < endFrame,
            localFrame: Math.max(0, localFrame - startFrame),
            durationSec,
        };
    }

    _renderTemplateBackgroundOnly(ctx, mg, anim) {
        this._ensureTemplateMedia(mg);
        this._ensureTemplateBgImage(mg);
        const W = 1920, H = 1080;
        return this._drawTemplateBg(ctx, mg, W, H, anim.opacity, { scrimAlpha: 0 });
    }

    /**
     * Render a motion graphic for the given local frame.
     * Returns a TextureManager entry { texture, width, height } or null.
     */
    renderMG(mg, localFrame, scriptContext) {
        this._currentRenderFrame = localFrame;
        const ctx = this._ctx;
        const s_ = this._previewScale;
        // Scale canvas context so all drawing code uses 1920x1080 coordinates
        ctx.setTransform(s_, 0, 0, s_, 0, 0);
        ctx.clearRect(0, 0, 1920, 1080);

        const s = this._getStyle(mg, scriptContext);
        const templateWindow = this._getTemplateContentWindow(mg, localFrame);
        const anim = AnimationUtils.computeAnimationState(localFrame, this.fps, {
            ...mg,
            _animationSpeed: mg._animationSpeed || 1.0,
        });

        if (templateWindow && !templateWindow.active) {
            const texId = `mg-${mg.type}-${mg._startFrame || 0}`;
            if (!this._renderTemplateBackgroundOnly(ctx, mg, anim)) {
                return null;
            }
            return this.textureManager.createOrUpdate(texId, this._canvas);
        }

        // Draw MG background if set
        this._renderMGBackground(ctx, mg, anim);

        // Registry-driven dispatch — no switch needed
        const renderer = this._categoryRenderers[mg.type];
        let rendered = false;
        if (renderer) {
            const renderFrame = templateWindow ? templateWindow.localFrame : localFrame;
            const renderMg = templateWindow ? { ...mg, duration: templateWindow.durationSec } : mg;
            const renderAnim = templateWindow
                ? AnimationUtils.computeAnimationState(renderFrame, this.fps, {
                    ...renderMg,
                    _animationSpeed: mg._animationSpeed || 1.0,
                })
                : anim;
            renderer(ctx, renderFrame, this.fps, renderMg, s, renderAnim, scriptContext);
            rendered = true;
        } else if (mg.text) {
            // Fallback: render unknown MG types as a headline so text is visible
            this._renderHeadline(ctx, localFrame, this.fps, mg, s, anim);
            rendered = true;
        }

        if (!rendered) return null;

        // Upload the canvas to a WebGL texture
        const texId = `mg-${mg.type}-${mg._startFrame || 0}`;
        const finalCanvas = this._applyOverlayShadowPass(mg) || this._canvas;
        return this.textureManager.createOrUpdate(texId, finalCanvas);
    }

    // ========================================================================
    // STYLE RESOLUTION (mirrors the app.js getStyledThemeColors + MG_STYLES)
    // ========================================================================

    _getStyle(mg, scriptContext) {
        const styleName = mg.style || 'clean';
        const baseS = (typeof MG_STYLES !== 'undefined' ? MG_STYLES[styleName] : null) || {
            primary: '#3b82f6', accent: '#f59e0b', bg: 'rgba(0,0,0,0.7)',
            text: '#ffffff', textSub: 'rgba(255,255,255,0.75)', glow: false,
        };

        let styled = null;
        if (typeof getStyledThemeColors === 'function') {
            styled = getStyledThemeColors(styleName);
        }
        // When the user manually picks a style from the dropdown, the MG_STYLES
        // preset colors (bold=red/yellow, cinematic=gold/silver, neon=green/magenta)
        // must dominate over the theme's modified colors — otherwise every style
        // just looks like a slightly different tint of the same theme hue and the
        // dropdown appears "stuck".
        // Auto-placed MGs keep the existing behavior (theme dominates) so they
        // blend with the theme's color identity.
        const s = styled
            ? (mg?.styleManual ? { ...styled, ...baseS } : { ...baseS, ...styled })
            : { ...baseS };
        const explicitColors = mg?.colors && typeof mg.colors === 'object'
            ? mg.colors
            : (mg?.mgData?.colors && typeof mg.mgData.colors === 'object'
                ? mg.mgData.colors
                : null);
        if (explicitColors) {
            if (explicitColors.primary) s.primary = explicitColors.primary;
            if (explicitColors.accent) s.accent = explicitColors.accent;
            if (explicitColors.text) s.text = explicitColors.text;
            if (explicitColors.textMuted) s.textSub = explicitColors.textMuted;
            if (explicitColors.surface || explicitColors.background) {
                s.bg = explicitColors.surface || explicitColors.background;
            }
        }
        if (mg?.transparentBackground === true || mg?.cardStyle === 'transparent') {
            s.bg = 'rgba(0,0,0,0)';
        }

        if (typeof getActiveThemeFonts === 'function') {
            const tf = getActiveThemeFonts();
            if (tf) {
                s.fontHeading = tf.heading.replace(/"/g, "'");
                s.fontBody = tf.body.replace(/"/g, "'");
            }
        }
        if (!s.fontHeading) s.fontHeading = 'Arial, sans-serif';
        if (!s.fontBody) s.fontBody = 'Arial, sans-serif';

        // Attach per-theme MG overrides (per-category)
        // Use the UI's active theme (dropdown) first, fall back to scriptContext
        const activeTheme = (typeof _resolveActiveTheme === 'function' && _resolveActiveTheme())
            || scriptContext?.themeId || null;
        if (window._themeTokens && activeTheme) {
            try {
                const tokens = window._themeTokens.getTokens(activeTheme);
                // Full per-category override map
                if (tokens?.chrome?.mgOverrides) {
                    s._mgOverrides = tokens.chrome.mgOverrides;
                }
                // _ltOverride kept for any external code that may read it
                if (tokens?.chrome?.lowerThirdOverride) {
                    s._ltOverride = tokens.chrome.lowerThirdOverride;
                }
            } catch (e) { /* ignore — fallback to style preset */ }
        }

        return s;
    }

    _getCategoryOverride(mg, s, category) {
        const ov = s._mgOverrides?.[category];
        if (!ov) return null;
        return ov;
    }

    _shouldIgnoreThemeVariant(mg, ov) {
        return !!(mg?.styleManual && !mg?.variantManual && ov?.style && mg?.subType === ov.style);
    }

    _shouldIgnoreThemeAnimation(mg, ov) {
        return !!(mg?.styleManual && !mg?.animationManual && ov?.anim && mg?.animation === ov.anim);
    }

    _shouldApplyOverlayShadow(mg) {
        if (!MGRenderer._overlayShadowExcludedTypes) {
            MGRenderer._overlayShadowExcludedTypes = new Set([
                'barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList',
                'mapChart', 'articleHighlight', 'kineticText', 'listicleGrid',
                'chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard',
                'factCard', 'imageShowcase', 'statCard', 'personIntro', 'splitScreen', 'infographic',
            ]);
        }
        return !mg?.isMGScene && !mg?.templateType && !MGRenderer._overlayShadowExcludedTypes.has(mg?.type);
    }

    _getOverlayShadowStrength(mg) {
        const raw = mg?.overlayShadowStrength ?? mg?._overlayShadowStrength;
        const parsed = Number.parseFloat(raw);
        if (!Number.isFinite(parsed)) return 0.55;
        return Math.max(0, Math.min(1, parsed));
    }

    _applyOverlayShadowPass(mg) {
        if (!this._shouldApplyOverlayShadow(mg)) return null;
        const strength = this._getOverlayShadowStrength(mg);
        if (strength <= 0.001) return null;

        const ctx = this._shadowCtx;
        // Identity transform — shadow canvas is sized to match _canvas (1920*s × 1080*s),
        // so we copy pixel-for-pixel and scale shadow params by preview scale to keep
        // the visual weight consistent across Full/Half previews.
        const s_ = this._previewScale || 1.0;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._shadowCanvas.width, this._shadowCanvas.height);
        ctx.globalCompositeOperation = 'source-over';

        // Pass 1 — wide soft halo (ambient occlusion feel)
        ctx.shadowColor = `rgba(0,0,0,${(0.20 + strength * 0.35).toFixed(3)})`;
        ctx.shadowBlur = (24 + strength * 56) * s_;    // 24 → 80 px (in 1920 coords)
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = (6 + strength * 14) * s_;  // 6 → 20 px
        ctx.drawImage(this._canvas, 0, 0);

        // Pass 2 — tighter contact shadow (grounds the card)
        ctx.shadowColor = `rgba(0,0,0,${(0.12 + strength * 0.25).toFixed(3)})`;
        ctx.shadowBlur = (6 + strength * 14) * s_;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = (2 + strength * 4) * s_;
        ctx.drawImage(this._canvas, 0, 0);

        // Final pass — content itself, no shadow
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.drawImage(this._canvas, 0, 0);
        return this._shadowCanvas;
    }

    // ========================================================================
    // MG BACKGROUND RENDERING
    // ========================================================================

    _renderMGBackground(ctx, mg, anim) {
        const bg = mg.mgBackground;
        if (!bg || bg === 'none') return;

        const W = 1920, H = 1080;
        const alpha = Math.min(1, anim.opacity);

        ctx.save();

        if (bg === 'scrim-light') {
            ctx.fillStyle = `rgba(0,0,0,${(0.2 * alpha).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'scrim') {
            ctx.fillStyle = `rgba(0,0,0,${(0.4 * alpha).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'scrim-dark') {
            ctx.fillStyle = `rgba(0,0,0,${(0.6 * alpha).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'solid-black') {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'solid-dark') {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#111111';
            ctx.fillRect(0, 0, W, H);
        } else if (bg.startsWith('gradient:')) {
            const gradientId = bg.replace('gradient:', '');
            const gradients = window.GRADIENT_BACKGROUNDS;
            const css = gradients ? gradients[gradientId] : null;
            if (css) {
                ctx.globalAlpha = alpha;
                this._drawCSSGradientOnCanvas(ctx, css, W, H);
            }
        } else if (bg.startsWith('image:')) {
            const filename = bg.replace('image:', '');
            ctx.globalAlpha = alpha;
            this._drawBgImage(ctx, filename, W, H);
        }

        ctx.restore();
    }

    _isTransparentTemplateBackground(mg = {}) {
        const fields = [
            mg.mgBackground,
            mg.background,
            mg.templateBackground,
            mg.templateBg,
            mg.backgroundMode,
            mg.mgData?.mgBackground,
            mg.mgData?.background,
            mg.mgData?.templateBackground,
            mg.mgData?.templateBg,
            mg.mgData?.backgroundMode,
        ];
        return fields.some(value => {
            if (typeof value !== 'string') return false;
            const mode = value.trim().toLowerCase();
            return mode === 'none'
                || mode === 'transparent'
                || (mode.includes('transparent') && !mode.startsWith('gradient:') && !mode.startsWith('image:'));
        });
    }

    /**
     * Lazily load and draw a background image from assets/backgrounds/.
     * Uses electronAPI.getBackgroundUrl() to resolve a confined asset:// URL.
     */
    _drawBgImage(ctx, filename, W, H) {
        // Check cache
        if (this._bgImages && this._bgImages[filename]) {
            const img = this._bgImages[filename];
            // Cover-fit the image
            const srcA = img.naturalWidth / img.naturalHeight;
            const dstA = W / H;
            let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
            if (srcA > dstA) { sw = sh * dstA; sx = (img.naturalWidth - sw) / 2; }
            else { sh = sw / dstA; sy = (img.naturalHeight - sh) / 2; }
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
            return;
        }

        // Start loading
        if (!this._bgImages) this._bgImages = {};
        if (!this._bgImageLoading) this._bgImageLoading = {};
        if (this._bgImageLoading[filename]) return;

        this._bgImageLoading[filename] = true;
        if (window.electronAPI?.getBackgroundUrl) {
            window.electronAPI.getBackgroundUrl(filename).then(url => {
                if (!url) { delete this._bgImageLoading[filename]; return; }
                const img = new Image();
                img.onload = () => {
                    this._bgImages[filename] = img;
                    delete this._bgImageLoading[filename];
                };
                img.onerror = () => { delete this._bgImageLoading[filename]; };
                img.src = url;
            }).catch(() => { delete this._bgImageLoading[filename]; });
        }
    }

    /**
     * Parse and draw a CSS gradient string onto a Canvas2D context.
     * Supports linear-gradient and radial-gradient with common syntax.
     */
    _drawCSSGradientOnCanvas(ctx, css, W, H) {
        // Split layered gradients (e.g., "repeating-linear-gradient(...), linear-gradient(...)")
        const layers = this._splitGradientLayers(css);
        // Draw back-to-front
        for (let i = layers.length - 1; i >= 0; i--) {
            this._drawSingleGradientOnCanvas(ctx, layers[i].trim(), W, H);
        }
    }

    _splitGradientLayers(css) {
        const layers = [];
        let depth = 0, start = 0;
        for (let i = 0; i < css.length; i++) {
            if (css[i] === '(') depth++;
            else if (css[i] === ')') depth--;
            else if (css[i] === ',' && depth === 0) {
                layers.push(css.slice(start, i));
                start = i + 1;
            }
        }
        layers.push(css.slice(start));
        return layers;
    }

    _drawSingleGradientOnCanvas(ctx, css, W, H) {
        const isRadial = css.startsWith('radial-gradient');
        const isLinear = css.startsWith('linear-gradient') || css.startsWith('repeating-linear-gradient');
        if (!isRadial && !isLinear) return;

        const inner = css.match(/\((.+)\)$/s);
        if (!inner) return;
        const content = inner[1];

        if (isLinear) {
            let angle = 180; // default: top to bottom
            let stopsStr = content;
            const angleMatch = content.match(/^(\d+)deg\s*,\s*/);
            if (angleMatch) {
                angle = parseFloat(angleMatch[1]);
                stopsStr = content.slice(angleMatch[0].length);
            }
            const rad = (angle - 90) * Math.PI / 180;
            const cx = W / 2, cy = H / 2;
            const len = Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad));
            const dx = Math.cos(rad) * len / 2;
            const dy = Math.sin(rad) * len / 2;
            const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
            this._addStops(grad, stopsStr);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);
        } else {
            // Radial gradient
            let cx = W * 0.5, cy = H * 0.5;
            let stopsStr = content;
            const posMatch = content.match(/^ellipse\s+at\s+(\d+)%\s+(\d+)%\s*,\s*/);
            if (posMatch) {
                cx = W * parseFloat(posMatch[1]) / 100;
                cy = H * parseFloat(posMatch[2]) / 100;
                stopsStr = content.slice(posMatch[0].length);
            }
            const radius = Math.max(W, H);
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            this._addStops(grad, stopsStr);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);
        }
    }

    _addStops(grad, stopsStr) {
        const parts = stopsStr.split(/,(?![^(]*\))/);
        const stops = [];
        for (const p of parts) {
            const m = p.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)(%|px)?\s*$/);
            if (m) {
                stops.push({ color: m[1].trim(), pos: parseFloat(m[2]) / 100 });
            } else {
                stops.push({ color: p.trim(), pos: null });
            }
        }
        // Auto-distribute stops without explicit position
        for (let i = 0; i < stops.length; i++) {
            if (stops[i].pos === null) {
                if (i === 0) stops[i].pos = 0;
                else if (i === stops.length - 1) stops[i].pos = 1;
                else {
                    let prev = i - 1, next = i + 1;
                    while (next < stops.length && stops[next].pos === null) next++;
                    const p0 = stops[prev].pos || 0;
                    const p1 = (next < stops.length ? stops[next].pos : 1) || 1;
                    stops[i].pos = p0 + (p1 - p0) * (i - prev) / (next - prev);
                }
            }
        }
        for (const s of stops) {
            try { grad.addColorStop(Math.max(0, Math.min(1, s.pos)), s.color); } catch (e) { /* skip invalid */ }
        }
    }

    // ========================================================================
    // POSITION HELPERS
    // ========================================================================

    static CANVAS_POS = {
        'center':       { anchorX: 0.5, anchorY: 0.5, padX: 0, padY: 0 },
        'bottom-left':  { anchorX: 0, anchorY: 1, padX: 77, padY: -86 },
        'bottom-right': { anchorX: 1, anchorY: 1, padX: -77, padY: -86 },
        'top':          { anchorX: 0.5, anchorY: 0, padX: 0, padY: 54 },
        'top-right':    { anchorX: 1, anchorY: 0, padX: -77, padY: 54 },
        'center-left':  { anchorX: 0, anchorY: 0.5, padX: 96, padY: 0 },
        'top-left':     { anchorX: 0, anchorY: 0, padX: 77, padY: 54 },
        // camelCase aliases (from UI dropdowns)
        'bottomLeft':   { anchorX: 0, anchorY: 1, padX: 77, padY: -86 },
        'bottomRight':  { anchorX: 1, anchorY: 1, padX: -77, padY: -86 },
        'topLeft':      { anchorX: 0, anchorY: 0, padX: 77, padY: 54 },
        'topRight':     { anchorX: 1, anchorY: 0, padX: -77, padY: 54 },
    };

    static _getPosXY(position, contentW, contentH) {
        const a = MGRenderer.CANVAS_POS[position] || MGRenderer.CANVAS_POS['center'];
        const x = a.anchorX * 1920 + a.padX - a.anchorX * contentW;
        const y = a.anchorY * 1080 + a.padY - a.anchorY * contentH;
        return { x, y };
    }

    // ========================================================================
    // DRAWING HELPERS
    // ========================================================================

    static _setFont(ctx, weight, size, family) {
        const fam = (family || 'Arial, sans-serif').replace(/"/g, "'");
        ctx.font = `${weight} ${size}px ${fam}`;
    }

    static _drawTextShadowed(ctx, text, x, y, s, strong) {
        if (s.glow) {
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = strong ? 12 : 8;
            ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 2;
            ctx.fillText(text, x, y);
            ctx.shadowColor = s.primary + (strong ? '90' : '60');
            ctx.shadowBlur = strong ? 30 : 20;
            ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
            ctx.fillText(text, x, y);
            ctx.shadowColor = s.primary + (strong ? '40' : '25');
            ctx.shadowBlur = strong ? 60 : 40;
            ctx.fillText(text, x, y);
        } else {
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = strong ? 24 : 12;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = strong ? 4 : 2;
            ctx.fillText(text, x, y);
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = strong ? 8 : 4;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = strong ? 2 : 1;
            ctx.fillText(text, x, y);
        }
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ctx.fillText(text, x, y);
    }

    static _drawGradientRect(ctx, x, y, w, h, color1, color2, direction) {
        if (!direction) direction = 'horizontal';
        const grad = direction === 'horizontal'
            ? ctx.createLinearGradient(x, y, x + w, y)
            : ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, color1);
        grad.addColorStop(1, color2);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
    }

    static _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    static _parseKeyValuePairs(subtext) {
        if (!subtext || subtext === 'none') return [];
        const raw = subtext.split(',').map(s => s.trim()).filter(Boolean);
        const results = [];
        for (const part of raw) {
            const colonIdx = part.indexOf(':');
            if (colonIdx !== -1) {
                results.push({ label: part.substring(0, colonIdx).trim(), value: part.substring(colonIdx + 1).trim() });
            } else if (results.length > 0 && /^\d+$/.test(part.trim())) {
                results[results.length - 1].value += ',' + part.trim();
            } else if (part.trim()) {
                results.push({ label: part.trim(), value: '0' });
            }
        }
        return results;
    }

    static _wrapTextWords(ctx, text, maxWidth) {
        const words = text.split(/\s+/);
        if (words.length <= 1) return [text];
        const lines = [];
        let currentLine = words[0];
        for (let i = 1; i < words.length; i++) {
            const test = currentLine + ' ' + words[i];
            if (ctx.measureText(test).width <= maxWidth) {
                currentLine = test;
            } else {
                lines.push(currentLine);
                currentLine = words[i];
            }
        }
        lines.push(currentLine);
        return lines;
    }

    // ========================================================================
    // 1. HEADLINE
    // ========================================================================

    _renderHeadline(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'headline');
        const animType = this._resolveAnimation(mg, s, 'headline');
        const colors = this._resolveColors(s, 'headline', mg);
        const ls = this._getHeadlineStyle(mg, s);

        // Shared position computation
        const position = mg.position || 'center';
        const isLeft = position.includes('left');
        const isRight = position.includes('right');

        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize, s.fontHeading);
        const textW = ctx.measureText(mg.text || '').width;
        const contentW = Math.max(800, textW + 40);
        const pos = MGRenderer._getPosXY(position, contentW, 200);

        let cx, textAlign;
        if (isLeft) {
            cx = pos.x + 20;
            textAlign = 'left';
        } else if (isRight) {
            cx = pos.x + contentW - 20;
            textAlign = 'right';
        } else {
            cx = pos.x + contentW / 2;
            textAlign = 'center';
        }
        const cy = pos.y + 100;

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'headline', variant, mg, s, anim, a,
            { cx, cy, textAlign, contentW, colors, ls, frame, fps });

        ctx.restore();
    }

    // ── Headline Variant: STANDARD (spring scale + gradient bar + subtext) ──
    _renderHL_Standard(ctx, mg, s, anim, a, p) {
        const { opacity, isExiting, exitProgress, idleScale } = anim;
        const scale = a.scale || 1;
        const translateY = a.slideY || 0;
        const blur = a.blur || 0;
        const barWidth = (a.barSpring || 0) * 300;
        const subOpacity = isExiting ? exitProgress : (a.subSpring || 0);
        const ls = p.ls;

        ctx.translate(p.cx, p.cy + translateY);
        ctx.scale(scale * idleScale, scale * idleScale);

        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        ctx.fillStyle = ls.textFill || p.colors?.textFill || s.text;
        ctx.textAlign = p.textAlign;
        ctx.textBaseline = 'middle';
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize, s.fontHeading);

        if (a.wordCascade) {
            MGRenderer._drawHeadlineWordCascade(
                ctx,
                mg.text || '',
                0,
                -30,
                ls,
                mg,
                a.wordCascade,
                {
                    outline: ls.outline,
                    outlineWidth: ls.outlineWidth,
                }
            );
        } else {
            // Optional outline stroke (bold style) behind the shadowed fill
            if (ls.outline && ls.outlineWidth > 0) {
                ctx.strokeStyle = ls.outline;
                ctx.lineWidth = ls.outlineWidth;
                ctx.lineJoin = 'round';
                ctx.miterLimit = 2;
                ctx.strokeText(mg.text || '', 0, -30);
            }
            MGRenderer._drawHeadlineText(ctx, mg.text || '', 0, -30, ls, false, mg);
        }

        ctx.filter = 'none';

        if (barWidth > 1) {
            const barX = p.textAlign === 'right' ? -barWidth : p.textAlign === 'center' ? -barWidth / 2 : 0;
            const barC1 = ls.accentFill || p.colors?.accentFill || s.primary;
            const barC2 = ls.accentFill || p.colors?.accentFill || s.accent;
            MGRenderer._drawGradientRect(ctx, barX, 15, barWidth, 4, barC1, barC2);
        }

        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
            ctx.fillStyle = ls.subFill || p.colors?.accentFill || s.accent;
            ctx.textAlign = p.textAlign;
            MGRenderer._drawHeadlineText(ctx, mg.subtext, 0, 50, ls, true);
        }
    }

    // ── Headline Variant: STAMP (bold impact stamp with scale-bounce) ──
    _renderHL_Stamp(ctx, mg, s, anim, a, p) {
        const { opacity, isExiting, exitProgress, idleScale } = anim;
        // Stamp uses an aggressive bounce scale
        const stampScale = a.stampScale || 1;
        const stampAlpha = a.stampAlpha || 1;
        const subOpacity = isExiting ? exitProgress : (a.subSpring || 0);
        const ls = p.ls;
        // Stamp is always bolder and bigger than standard
        const tWeight = '900';
        const tSize = Math.max(ls.titleSize, 82);

        ctx.translate(p.cx, p.cy);
        ctx.scale(stampScale * idleScale, stampScale * idleScale);
        ctx.globalAlpha = Math.min(1, opacity) * stampAlpha;

        const accentColor = ls.accentFill || p.colors?.accentFill || s.primary;
        MGRenderer._setFont(ctx, tWeight, tSize, s.fontHeading);
        ctx.textAlign = p.textAlign;
        ctx.textBaseline = 'middle';

        // Thick stroke outline (accent color by default — hallmark of Stamp)
        ctx.strokeStyle = ls.outline || accentColor;
        ctx.lineWidth = ls.outlineWidth && ls.outlineWidth > 0 ? Math.max(ls.outlineWidth, 6) : 6;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeText(mg.text || '', 0, -20);

        // Shadowed fill on top
        ctx.fillStyle = ls.textFill || p.colors?.textFill || s.text;
        MGRenderer._drawHeadlineText(ctx, mg.text || '', 0, -20, ls, false, mg);

        // Accent line below
        const lineW = ctx.measureText(mg.text || '').width * 0.8;
        const lineX = p.textAlign === 'right' ? -lineW : p.textAlign === 'center' ? -lineW / 2 : 0;
        ctx.fillStyle = accentColor;
        ctx.fillRect(lineX, 25, lineW * Math.min(1, (a.textSpring || 1)), 5);

        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, ls.subWeight, Math.max(ls.subSize, 28), s.fontBody);
            ctx.fillStyle = ls.subFill || p.colors?.accentFill || s.accent;
            ctx.textAlign = p.textAlign;
            MGRenderer._drawHeadlineText(ctx, mg.subtext, 0, 60, ls, true);
        }
    }

    // ── Headline Variant: TYPEWRITER (character-by-character reveal with cursor) ──
    _renderHL_Typewriter(ctx, mg, s, anim, a, p) {
        const { opacity, isExiting, exitProgress, idleScale } = anim;
        const fullText = mg.text || '';
        const revealPct = a.revealProgress || 0;
        const charCount = Math.floor(fullText.length * Math.min(1, revealPct));
        const visibleText = fullText.substring(0, charCount);
        const subOpacity = isExiting ? exitProgress : (a.subSpring || 0);
        const ls = p.ls;
        // Typewriter uses a slightly lighter weight than standard headline
        const tWeight = (ls.titleWeight === '900') ? '700' : ls.titleWeight;
        const tSize = Math.round(ls.titleSize * 0.94);

        ctx.translate(p.cx, p.cy);
        ctx.scale(idleScale, idleScale);

        MGRenderer._setFont(ctx, tWeight, tSize, s.fontHeading);
        ctx.fillStyle = ls.textFill || p.colors?.textFill || s.text;
        ctx.textAlign = p.textAlign;
        ctx.textBaseline = 'middle';
        MGRenderer._drawHeadlineText(ctx, visibleText, 0, -25, ls, false, mg);

        // Blinking cursor
        const cursorW = ctx.measureText(visibleText).width;
        if (revealPct < 1.05) {
            const blink = Math.sin(p.frame * 0.3) > 0;
            if (blink) {
                const cursorX = p.textAlign === 'left' ? cursorW + 4
                    : p.textAlign === 'right' ? 4
                    : cursorW / 2 + 4;
                ctx.fillStyle = ls.accentFill || p.colors?.accentFill || s.primary;
                ctx.fillRect(cursorX, -55, 3, 60);
            }
        }

        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
            ctx.fillStyle = ls.subFill || p.colors?.accentFill || s.accent;
            ctx.textAlign = p.textAlign;
            MGRenderer._drawHeadlineText(ctx, mg.subtext, 0, 50, ls, true);
        }
    }

    // ========================================================================
    // 2. LOWER THIRD
    // ========================================================================

    // ========================================================================
    // 2. LOWER THIRD — Multi-variant dispatcher
    // Variants: bar, box, underline, banner, glass, split
    // Animations: slideLeft, wipeRight, popUp, fadeSlide
    // ========================================================================

    // ── Generic variant dispatcher ──
    // Works for ANY category that has registered variants.
    // Categories without variants simply don't call this.
    //
    // To add variants to a new category (e.g. headline):
    //   1. Add types to MG_REGISTRY['headline'] in mg-registry.js
    //   2. Register variants: this.registerVariant('headline', 'stamp', fn)
    //   3. Define a setup function that returns category-specific context
    //   4. Call _dispatchVariant() from your category's main render method
    //
    _dispatchVariant(ctx, category, variant, mg, s, anim, animState, setup) {
        const key = `${category}:${variant}`;
        const fn = this._variantRenderers[key]
                || this._variantRenderers[`${category}:standard`]
                || this._variantRenderers[`${category}:bar`]; // lowerThird compat
        if (fn) {
            fn(ctx, mg, s, anim, animState, setup);
        }
    }

    // ── Compute animation from registry ──
    _computeAnimation(animType, frame, fps, anim, mg) {
        const computer = this._animComputers[animType] || this._animComputers['slideLeft'];
        return computer ? computer(frame, fps, anim, mg) : {};
    }

    // ── Resolve variant for any category ──
    // Two-knob model: theme has a `variantAvoid` filter list; variant is picked
    // by rotating mg.sceneIndex through (allVariants - variantAvoid). User
    // mg.subType always wins. AI hint (mg._aiVariant) is honored if it's not
    // on the avoid list. Falls back to legacy ov.style if no variantAvoid set.
    _resolveVariant(mg, s, category) {
        const ov = this._getCategoryOverride(mg, s, category);
        const reg = window._mgRegistry?.registry?.[category];

        // 1. User-set in UI props panel wins
        if (mg.subType && !this._shouldIgnoreThemeVariant(mg, ov)) return mg.subType;

        // 2. New Option-C path: variantAvoid + scene-index rotation
        const allVariants = reg?.types ? Object.keys(reg.types) : [];
        if (allVariants.length > 0 && Array.isArray(ov?.variantAvoid)) {
            const pool = allVariants.filter(v => !ov.variantAvoid.includes(v));
            const finalPool = pool.length > 0 ? pool : allVariants;
            // AI hint takes precedence if it survived the avoid filter
            if (mg._aiVariant && finalPool.includes(mg._aiVariant)) return mg._aiVariant;
            // Deterministic per-scene rotation for variety
            const idx = (typeof mg.sceneIndex === 'number' ? mg.sceneIndex : 0);
            return finalPool[Math.abs(idx) % finalPool.length];
        }

        // 3. Legacy back-compat: themeOverride.style (variant lock — pre-refactor)
        if (!mg.styleManual && ov?.style && reg?.types?.[ov.style]) return ov.style;

        // 4. Category-specific style preset fallback (lowerThird)
        if (category === 'lowerThird' && s.lowerThirdStyle) return s.lowerThirdStyle;

        // 5. Registry default
        return reg?.defaultType || 'standard';
    }

    // ── Resolve animation for any category ──
    // Animation is NOT theme-controlled (May 2026 refactor). Source order:
    //   1. mg.animation (user-set in UI)
    //   2. variant's default from registry (types[variant].animation)
    //   3. legacy ov.anim if present (back-compat)
    //   4. style-preset fallback for lowerThird
    //   5. first animation in registry's animations[]
    _resolveAnimation(mg, s, category) {
        const ov = this._getCategoryOverride(mg, s, category);
        if (mg.animation && !this._shouldIgnoreThemeAnimation(mg, ov)) return mg.animation;

        const reg = window._mgRegistry?.registry?.[category];
        const subType = this._resolveVariant(mg, s, category);
        const variantDefault = reg?.types?.[subType]?.animation;
        if (variantDefault) return variantDefault;

        // Legacy back-compat (pre-refactor themes set ov.anim explicitly)
        if (!mg.styleManual && ov?.anim) return ov.anim;
        if (category === 'lowerThird' && s.lowerThirdAnimation) return s.lowerThirdAnimation;

        return reg?.animations?.[0] || 'slideLeft';
    }

    // ── Resolve colors for any category ──
    _resolveColors(s, category, mg) {
        if (mg?.styleManual) return null;
        return s._mgOverrides?.[category]?.colors || null;
    }

    // ── LowerThird setup + dispatch ──
    _renderLowerThird(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'lowerThird');
        const animType = this._resolveAnimation(mg, s, 'lowerThird');
        const ls = this._getLowerThirdStyle(mg, s);

        // Measure text to compute dynamic box width
        const padding = 48;
        const minW = 250, maxW = 900;
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize, s.fontHeading);
        const titleW = ctx.measureText(mg.text || '').width;
        MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
        const subW = mg.subtext ? ctx.measureText(mg.subtext).width : 0;
        const contentW = Math.max(titleW, subW);
        const boxW = Math.max(minW, Math.min(maxW, contentW + padding));
        const boxH = mg.subtext ? 100 : 70;
        const margin = 60;

        const rawPos = typeof mg.position === 'string' ? mg.position : 'bottom-left';
        const pos = rawPos.toLowerCase().replace(/\s+/g, '-');
        let baseX, baseY;
        if (pos.includes('top')) { baseY = margin + 20; }
        else { baseY = 1080 - boxH - margin; }
        if (pos.includes('right')) { baseX = 1920 - boxW - margin; }
        else if (pos === 'center' || pos === 'top' || pos === 'bottom') { baseX = (1920 - boxW) / 2; }
        else { baseX = margin; }

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'lowerThird', variant, mg, s, anim, a,
            { bx: baseX, by: baseY, bw: boxW, bh: boxH, ls });

        ctx.restore();
    }

    // ── Individual animation computers (registered in constructor) ──
    // Each returns an animation state object used by variant renderers.
    // To add a new animation: add a method + register in constructor's _animComputers.

    _computeAnim_slideLeft(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.clipAmount = interpolate(anim.enterSpring, [0, 1], [0, 100]);
        r.barScaleY = springValue(Math.max(0, frame - Math.round((0.18 / speed) * fps)), fps, { damping: 22, stiffness: 108, durationInFrames: Math.round((0.42 / speed) * fps) });
        const td = Math.round((0.24 / speed) * fps);
        r.textSpring = springValue(Math.max(0, frame - td), fps, { damping: 20, stiffness: 92, durationInFrames: Math.round((0.36 / speed) * fps) });
        r.textSlideX = interpolate(r.textSpring, [0, 1], [-10, 0]);
        r.subSpring = springValue(Math.max(0, frame - Math.round((0.42 / speed) * fps)), fps, { damping: 20, stiffness: 92 });
        // Headline compat: provide scale/slideY/bar fields
        r.scale = interpolate(anim.enterSpring, [0, 1], [0.965, 1]);
        r.slideY = r.textSlideX; // slight slide
        r.barSpring = r.barScaleY;
        r.stampScale = r.scale;
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.15], [0, 1], { extrapolateRight: 'clamp' });
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        return r;
    }

    _computeAnim_wipeRight(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.wipeProgress = interpolate(anim.enterSpring, [0, 1], [0, 1]);
        r.clipAmount = interpolate(anim.enterSpring, [0, 1], [0, 100]); // for bar/box clip
        const td = Math.round((0.24 / speed) * fps);
        r.textSpring = springValue(Math.max(0, frame - td), fps, { damping: 18, stiffness: 84, durationInFrames: Math.round((0.36 / speed) * fps) });
        r.textSlideX = interpolate(r.textSpring, [0, 1], [-22, 0]);
        r.barScaleY = springValue(Math.max(0, frame - Math.round((0.14 / speed) * fps)), fps, { damping: 20, stiffness: 108 });
        r.subSpring = springValue(Math.max(0, frame - Math.round((0.42 / speed) * fps)), fps, { damping: 20, stiffness: 92 });
        // Headline compat
        r.scale = interpolate(anim.enterSpring, [0, 1], [0.965, 1]);
        r.slideY = 0;
        r.barSpring = r.textSpring;
        r.stampScale = r.scale;
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.15], [0, 1], { extrapolateRight: 'clamp' });
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        return r;
    }

    _computeAnim_popUp(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.scaleY = springValue(frame, fps, { damping: 14, stiffness: 120, durationInFrames: Math.round((0.5 / speed) * fps) });
        r.scale = r.scaleY;
        r.stampScale = r.scaleY;
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.1], [0, 1], { extrapolateRight: 'clamp' });
        r.slideY = interpolate(r.scaleY, [0, 1], [55, 0]);
        r.clipAmount = 100; // no clip, full reveal
        r.barScaleY = r.scaleY;
        const td = Math.round((0.16 / speed) * fps);
        r.textSpring = springValue(Math.max(0, frame - td), fps, { damping: 18, stiffness: 105, durationInFrames: Math.round((0.36 / speed) * fps) });
        r.textSlideX = 0;
        r.subSpring = springValue(Math.max(0, frame - Math.round((0.3 / speed) * fps)), fps, { damping: 20, stiffness: 92 });
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        r.barSpring = r.textSpring;
        return r;
    }

    _computeAnim_fadeSlide(frame, fps, anim, mg) {
        const { interpolate, springValue } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.fadeIn = interpolate(anim.enterLinear, [0, 0.5], [0, 1], { extrapolateRight: 'clamp' });
        r.slideY = interpolate(anim.enterSpring, [0, 1], [42, 0]);
        r.textSpring = springValue(Math.max(0, frame - Math.round((0.18 / speed) * fps)), fps, { damping: 18, stiffness: 92 });
        r.textSlideX = interpolate(r.textSpring, [0, 1], [20, 0]);
        r.subSpring = interpolate(anim.enterLinear, [0.3, 0.9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        r.barScaleY = r.textSpring; // for bar variant
        r.clipAmount = interpolate(anim.enterSpring, [0, 1], [0, 100]); // clip reveal too
        // Headline compat
        r.scale = interpolate(anim.enterSpring, [0, 1], [0.94, 1]);
        r.barSpring = r.textSpring;
        r.stampScale = r.scale;
        r.stampAlpha = r.fadeIn;
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        return r;
    }

    // ── springScale animation (default for headline:standard) ──
    // Produces: scale, slideY, blur, barSpring, subSpring — used by headline variants
    _computeAnim_springScale(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.scale = anim.isExiting
            ? interpolate(anim.exitProgress, [0, 1], [0.97, 1])
            : interpolate(anim.enterSpring, [0, 1], [0.9, 1]);
        r.slideY = anim.isExiting
            ? interpolate(anim.exitProgress, [0, 1], [-12, 0])
            : interpolate(anim.enterSpring, [0, 1], [22, 0]);
        r.blur = anim.isExiting ? 0 : interpolate(anim.enterLinear, [0, 0.6], [5, 0], { extrapolateRight: 'clamp' });
        const barDelay = Math.round((0.28 / speed) * fps);
        r.barSpring = springValue(Math.max(0, frame - barDelay), fps, {
            damping: 22, stiffness: 92, durationInFrames: Math.round((0.36 / speed) * fps),
        });
        const subDelay = Math.round((0.24 / speed) * fps);
        r.subSpring = anim.isExiting ? anim.exitProgress
            : springValue(Math.max(0, frame - subDelay), fps, { damping: 20, stiffness: 92 });
        r.textSpring = r.barSpring;
        // Stamp-specific: aggressive bounce scale for stamp variant
        r.stampScale = anim.isExiting
            ? interpolate(anim.exitProgress, [0, 1], [0.5, 1])
            : springValue(frame, fps, { damping: 10, stiffness: 160, durationInFrames: Math.round((0.42 / speed) * fps) });
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.15], [0, 1], { extrapolateRight: 'clamp' });
        // Typewriter-specific: character reveal
        const revealDur = Math.round((1.2 / speed) * fps);
        r.revealProgress = Math.min(1.1, frame / Math.max(1, revealDur));
        return r;
    }

    _computeAnim_typewriter(frame, fps, anim, mg) {
        const { interpolate } = AnimationUtils;
        const speed = anim.speed;
        const revealDur = Math.round((1.35 / speed) * fps);
        const revealProgress = Math.min(1.1, frame / Math.max(1, revealDur));
        return {
            scale: 1,
            slideY: 0,
            blur: 0,
            barSpring: revealProgress,
            textSpring: revealProgress,
            subSpring: interpolate(
                revealProgress,
                [0.72, 1],
                [0, 1],
                { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            ),
            stampScale: 1,
            stampAlpha: Math.min(1, revealProgress * 4),
            revealProgress,
        };
    }

    _computeAnim_wordCascade(frame, fps, anim, mg) {
        const { clamp01, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const wordCount = Math.max(
            1,
            String(mg?.text || '').trim().split(/\s+/).filter(Boolean).length
        );
        const staggerFrames = Math.max(1, Math.round((0.11 / speed) * fps));
        const revealFrames = Math.max(1, Math.round((0.44 / speed) * fps));
        const completionFrame = Math.max(
            revealFrames,
            (wordCount - 1) * staggerFrames + revealFrames
        );
        const overall = clamp01(frame / completionFrame);
        return {
            scale: 1,
            slideY: 0,
            blur: 0,
            barSpring: overall,
            textSpring: overall,
            subSpring: interpolate(
                frame,
                [completionFrame * 0.68, completionFrame],
                [0, 1],
                { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            ),
            stampScale: 1,
            stampAlpha: Math.min(1, overall * 4),
            revealProgress: overall,
            wordCascade: {
                frame,
                fps,
                speed,
                staggerFrames,
                revealFrames,
            },
        };
    }

    // ── Variant: BAR (thin vertical gradient bar + text) ──
    // Used by: tech, neutral
    _renderLT_Bar(ctx, mg, s, anim, a, bx, by, bw, bh, ls) {
        const { opacity, isExiting, exitProgress } = anim;
        const slideY = a.slideY || 0;
        by = by + slideY;

        // Clip reveal animation
        const clipW = bw * ((a.clipAmount || 100) / 100);
        ctx.beginPath();
        ctx.rect(bx, by - 20, clipW, bh + 40);
        ctx.clip();

        // Shadow behind everything
        if (ls.shadowBlur > 0) { ctx.shadowColor = ls.shadowColor; ctx.shadowBlur = ls.shadowBlur; ctx.shadowOffsetY = 3; }

        // Dark backing scrim
        ctx.beginPath();
        MGRenderer._roundRect(ctx, bx + ls.barWidth + 4, by - 4, bw - ls.barWidth, bh + 8, [0, ls.radius, ls.radius, 0]);
        ctx.fillStyle = ls.bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Border
        if (ls.borderWidth > 0) {
            ctx.strokeStyle = ls.borderColor;
            ctx.lineWidth = ls.borderWidth;
            ctx.stroke();
        }

        // Accent bar (left edge)
        const accentH = (bh + 8) * (a.barScaleY || 1);
        if (ls.glow) { ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 14; }
        MGRenderer._drawGradientRect(ctx, bx, by + bh / 2 - accentH / 2 - 4, ls.barWidth, accentH, ls.accentFill, ls.accentFill, 'vertical');
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Main text
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize, s.fontHeading);
        ctx.fillStyle = ls.textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || 1);
        if (ls.glow) {
            ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 10;
            MGRenderer._drawStyledText(
                ctx,
                mg.text || '',
                bx + ls.barWidth + 20 + (a.textSlideX || 0),
                by + 10,
                mg
            );
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        } else {
            ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
            MGRenderer._drawStyledText(
                ctx,
                mg.text || '',
                bx + ls.barWidth + 20 + (a.textSlideX || 0),
                by + 10,
                mg
            );
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        }

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
            ctx.fillStyle = ls.subFill;
            ctx.fillText(mg.subtext, bx + ls.barWidth + 20, by + 55);
        }
    }

    // ── Variant: BOX (solid colored background rectangle) ──
    // Used by: corporate
    _renderLT_Box(ctx, mg, s, anim, a, bx, by, bw, bh, ls) {
        const { opacity, isExiting, exitProgress } = anim;
        const hasSub = !!mg.subtext;
        const totalH = hasSub ? bh + 15 : bh - 10;
        const slideY = a.slideY || 0;
        const scaleY = a.scaleY !== undefined ? a.scaleY : 1;

        // Clip for slideLeft entrance
        if (a.clipAmount !== undefined && a.clipAmount < 100) {
            ctx.beginPath();
            ctx.rect(bx - 5, by - 5, (bw + 10) * (a.clipAmount / 100), totalH + 10);
            ctx.clip();
        }

        // Box shadow
        if (ls.shadowBlur > 0) {
            ctx.shadowColor = ls.shadowColor;
            ctx.shadowBlur = ls.shadowBlur;
            ctx.shadowOffsetY = 4;
        }

        // Background box
        ctx.beginPath();
        MGRenderer._roundRect(ctx, bx, by + slideY, bw, totalH * scaleY, ls.radius);
        ctx.fillStyle = ls.bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Border
        if (ls.borderWidth > 0) {
            ctx.strokeStyle = ls.borderColor;
            ctx.lineWidth = ls.borderWidth;
            ctx.stroke();
        }

        // Left accent stripe
        if (ls.glow) { ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 10; }
        ctx.fillStyle = ls.accentFill;
        ctx.fillRect(bx, by + slideY, ls.barWidth, totalH * scaleY);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Main text
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize, s.fontHeading);
        ctx.fillStyle = ls.textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || 1);
        MGRenderer._drawStyledText(
            ctx,
            mg.text || '',
            bx + ls.barWidth + 20 + (a.textSlideX || 0),
            by + slideY + 18,
            mg
        );

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
            ctx.fillStyle = ls.subFill;
            ctx.fillText(mg.subtext, bx + ls.barWidth + 20, by + slideY + 62);
        }
    }

    // ── Variant: UNDERLINE (text with animated gradient underline) ──
    // Used by: nature
    _renderLT_Underline(ctx, mg, s, anim, a, bx, by, bw, bh, ls) {
        const { opacity, isExiting, exitProgress } = anim;
        const slideY = a.slideY || 0;
        const fadeIn = a.fadeIn !== undefined ? a.fadeIn : 1;

        ctx.globalAlpha = Math.min(1, opacity) * fadeIn;

        // Subtle backing scrim for readability
        const textY = by + 10 + slideY;
        ctx.beginPath();
        MGRenderer._roundRect(ctx, bx - 12, textY - 8, bw + 24, bh + 16, ls.radius);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();

        // Main text
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize, s.fontHeading);
        ctx.fillStyle = ls.textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        if (ls.glow) {
            ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 12;
        } else {
            ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 2;
        }
        MGRenderer._drawStyledText(ctx, mg.text || '', bx, textY, mg);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Animated underline
        const textW = ctx.measureText(mg.text || '').width;
        const underlineW = Math.min(textW + 10, bw) * (a.textSpring || 0);
        if (underlineW > 1) {
            if (ls.glow) { ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 8; }
            MGRenderer._drawGradientRect(ctx, bx, textY + ls.titleSize + 8, underlineW, ls.barWidth, ls.accentFill, ls.subFill);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
            ctx.fillStyle = ls.subFill;
            ctx.fillText(mg.subtext, bx, textY + ls.titleSize + 16);
        }
    }

    // ── Variant: BANNER (full-width broadcast bar with accent stripe) ──
    // Used by: crime (red bg, white text)
    _renderLT_Banner(ctx, mg, s, anim, a, baseY, bw, ls) {
        const { opacity, isExiting, exitProgress } = anim;
        const hasSub = !!mg.subtext;
        const bannerH = hasSub ? 80 : 60;
        const stripeH = ls.barWidth;

        // Wipe entrance: clip from left
        const wipe = a.wipeProgress !== undefined ? a.wipeProgress : 1;
        if (wipe < 1) {
            ctx.beginPath();
            ctx.rect(0, baseY - stripeH, 1920 * wipe, bannerH + stripeH + 2);
            ctx.clip();
        }

        // Shadow
        if (ls.shadowBlur > 0) { ctx.shadowColor = ls.shadowColor; ctx.shadowBlur = ls.shadowBlur; }

        // Main banner fill
        ctx.fillStyle = ls.bgFill;
        ctx.fillRect(0, baseY, 1920, bannerH);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Top accent stripe
        if (ls.glow) { ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 10; }
        ctx.fillStyle = ls.accentFill;
        ctx.fillRect(0, baseY - stripeH, 1920, stripeH);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Bottom accent line
        ctx.fillStyle = ls.accentFill + '40';
        ctx.fillRect(0, baseY + bannerH - 1, 1920, 1);

        // Main text
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || 1);
        MGRenderer._setFont(ctx, ls.titleWeight, hasSub ? ls.titleSize - 4 : ls.titleSize, s.fontHeading);
        ctx.fillStyle = ls.textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        MGRenderer._drawStyledText(
            ctx,
            mg.text || '',
            50 + (a.textSlideX || 0),
            baseY + (hasSub ? 8 : 14),
            mg
        );

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
            ctx.fillStyle = ls.subFill;
            ctx.fillText(mg.subtext, 50, baseY + 44);
        }
    }

    // ── Variant: GLASS (frosted semi-transparent box with border) ──
    // Used by: luxury
    _renderLT_Glass(ctx, mg, s, anim, a, bx, by, bw, bh, ls) {
        const { opacity, isExiting, exitProgress } = anim;
        const slideY = a.slideY || 0;
        const fadeIn = a.fadeIn !== undefined ? a.fadeIn : 1;
        const hasSub = !!mg.subtext;
        const totalH = hasSub ? bh + 15 : bh - 10;

        ctx.globalAlpha = Math.min(1, opacity) * fadeIn;

        // Outer glow
        if (ls.glow) { ctx.shadowColor = ls.accentFill + '40'; ctx.shadowBlur = 30; }
        else if (ls.shadowBlur > 0) { ctx.shadowColor = ls.shadowColor; ctx.shadowBlur = ls.shadowBlur; }

        // Glass background
        ctx.beginPath();
        MGRenderer._roundRect(ctx, bx, by + slideY, bw, totalH, ls.radius);
        ctx.fillStyle = ls.bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Border
        ctx.beginPath();
        MGRenderer._roundRect(ctx, bx, by + slideY, bw, totalH, ls.radius);
        ctx.strokeStyle = ls.borderColor;
        ctx.lineWidth = ls.borderWidth;
        ctx.stroke();

        // Inner highlight line at top (frosted glass effect)
        ctx.beginPath();
        ctx.moveTo(bx + ls.radius, by + slideY + 1);
        ctx.lineTo(bx + bw - ls.radius, by + slideY + 1);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Left accent dot/indicator
        if (ls.glow) { ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 12; }
        ctx.beginPath();
        ctx.arc(bx + 20, by + slideY + totalH / 2, 5, 0, Math.PI * 2);
        ctx.fillStyle = ls.accentFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Main text
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize - 2, s.fontHeading);
        ctx.fillStyle = ls.textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || fadeIn);
        if (ls.glow) { ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 8; }
        else { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8; }
        MGRenderer._drawStyledText(
            ctx,
            mg.text || '',
            bx + 36 + (a.textSlideX || 0),
            by + slideY + 16,
            mg
        );
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, ls.subWeight, ls.subSize, s.fontBody);
            ctx.fillStyle = ls.subFill;
            ctx.fillText(mg.subtext, bx + 36, by + slideY + 58);
        }
    }

    // ── Variant: SPLIT (two-tone: colored left label + dark right name) ──
    // Used by: sport
    _renderLT_Split(ctx, mg, s, anim, a, bx, by, bw, bh, ls) {
        const { opacity, isExiting, exitProgress } = anim;
        const slideY = a.slideY || 0;
        const scaleY = a.scaleY !== undefined ? a.scaleY : 1;

        // Measure left label
        MGRenderer._setFont(ctx, ls.titleWeight, 16, s.fontHeading);
        const labelText = (mg.subtext || 'INFO').toUpperCase();
        const labelW = ctx.measureText(labelText).width;
        const leftW = Math.max(80, labelW + 40);

        // Measure right name text
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize - 4, s.fontHeading);
        const nameW = ctx.measureText(mg.text || '').width;
        const rightW = Math.max(120, nameW + 44);
        const totalH = bh - 15;
        const drawY = by + slideY;

        ctx.globalAlpha = Math.min(1, opacity) * scaleY;

        // Shadow
        if (ls.shadowBlur > 0) { ctx.shadowColor = ls.shadowColor; ctx.shadowBlur = ls.shadowBlur; ctx.shadowOffsetY = 4; }

        // Left colored section (rounded left corners)
        ctx.beginPath();
        ctx.moveTo(bx + ls.radius, drawY);
        ctx.lineTo(bx + leftW, drawY);
        ctx.lineTo(bx + leftW, drawY + totalH);
        ctx.lineTo(bx + ls.radius, drawY + totalH);
        ctx.arcTo(bx, drawY + totalH, bx, drawY + totalH - ls.radius, ls.radius);
        ctx.lineTo(bx, drawY + ls.radius);
        ctx.arcTo(bx, drawY, bx + ls.radius, drawY, ls.radius);
        ctx.closePath();
        if (ls.glow) { ctx.shadowColor = ls.accentFill; ctx.shadowBlur = 14; }
        ctx.fillStyle = ls.accentFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Right dark section (rounded right corners)
        ctx.beginPath();
        ctx.moveTo(bx + leftW, drawY);
        ctx.lineTo(bx + leftW + rightW - ls.radius, drawY);
        ctx.arcTo(bx + leftW + rightW, drawY, bx + leftW + rightW, drawY + ls.radius, ls.radius);
        ctx.lineTo(bx + leftW + rightW, drawY + totalH - ls.radius);
        ctx.arcTo(bx + leftW + rightW, drawY + totalH, bx + leftW + rightW - ls.radius, drawY + totalH, ls.radius);
        ctx.lineTo(bx + leftW, drawY + totalH);
        ctx.closePath();
        ctx.fillStyle = ls.bgFill;
        ctx.fill();

        // Border on right section
        if (ls.borderWidth > 0) {
            ctx.strokeStyle = ls.borderColor;
            ctx.lineWidth = ls.borderWidth;
            ctx.stroke();
        }

        // Left label text (uppercase)
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || scaleY);
        MGRenderer._setFont(ctx, '800', 16, s.fontHeading);
        ctx.fillStyle = ls.textFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, bx + leftW / 2, drawY + totalH / 2);

        // Right name text
        MGRenderer._setFont(ctx, ls.titleWeight, ls.titleSize - 4, s.fontHeading);
        ctx.fillStyle = ls.textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        MGRenderer._drawStyledText(
            ctx,
            mg.text || '',
            bx + leftW + 20 + (a.textSlideX || 0),
            drawY + totalH / 2,
            mg
        );
    }

    // ========================================================================
    // 3. STAT COUNTER — dispatcher + 3 variants
    // ========================================================================

    // ── StatCounter setup + dispatch ──
    _renderStatCounter(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames, enterSpring, enterLinear } = anim;

        const variant = this._resolveVariant(mg, s, 'statCounter');
        const colors = this._resolveColors(s, 'statCounter', mg);
        const sc = this._getStatCounterStyle(mg, s);

        // Parse number, prefix, suffix from text
        const numberMatch = (mg.text || '').match(/[\d,.]+/);
        const targetNumber = numberMatch ? parseFloat(numberMatch[0].replace(/,/g, '')) : 0;
        let prefix = (mg.text || '').substring(0, (mg.text || '').indexOf(numberMatch?.[0] || '')).trim();
        let suffix = (mg.text || '').substring((mg.text || '').indexOf(numberMatch?.[0] || '') + (numberMatch?.[0]?.length || 0)).trim();
        const isPercent = suffix.includes('%') || prefix.includes('%');

        // Abbreviate small scaled stats — "1 Million" reads poorly as a bare "1".
        // When the raw number is < 100 AND a scale word is present, attach a short
        // scale suffix (M/B/T/K) to the number and strip the word from prefix/suffix
        // so the label doesn't repeat it.
        let scaleSuffix = '';
        if (targetNumber > 0 && targetNumber < 100) {
            const scaleMap = { thousand: 'K', million: 'M', billion: 'B', trillion: 'T' };
            const scaleRe = /\b(thousand|million|billion|trillion)s?\b/i;
            const sMatch = (mg.text || '').match(scaleRe);
            if (sMatch) {
                scaleSuffix = scaleMap[sMatch[1].toLowerCase()] || '';
                prefix = prefix.replace(scaleRe, '').replace(/\s+/g, ' ').trim();
                suffix = suffix.replace(scaleRe, '').replace(/\s+/g, ' ').trim();
            }
        }

        // Smooth count-up with easeOutQuart (slower decel than cubic)
        const countStart = Math.round(enterFrames * 0.3);
        const countEnd = Math.max(countStart + 1, Math.min(enterFrames + Math.round(fps * 1.5), totalFrames - 15));
        const rawCount = interpolate(frame, [countStart, countEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const easeOutQuart = t => 1 - Math.pow(1 - t, 4);
        const countProgress = easeOutQuart(rawCount);

        const currentNumber = targetNumber % 1 !== 0
            ? (targetNumber * countProgress).toFixed(1)
            : Math.round(targetNumber * countProgress).toLocaleString();

        // Entrance animation — simple scale+fade, no animation computer needed
        const entScale = interpolate(enterSpring, [0, 1], [0.85, 1]);
        const entSlideY = interpolate(enterSpring, [0, 1], [20, 0]);
        const entBlur = interpolate(enterLinear, [0, 0.5], [5, 0], { extrapolateRight: 'clamp' });
        const labelSpring = interpolate(enterLinear, [0.3, 0.8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const scale = entScale * (isExiting ? interpolate(exitProgress, [0, 1], [0.95, 1]) : 1);

        // Box dimensions — measure actual content for ticker variant
        let boxW = 400;
        if (variant === 'ticker') {
            // Short prefix stays with number; long prefix moves to label
            const shortPfx = prefix.length <= 3 ? prefix : '';
            const numText = `${shortPfx}${targetNumber % 1 !== 0 ? targetNumber.toFixed(1) : Math.round(targetNumber).toLocaleString()}${scaleSuffix}`;
            // Build label same way as the ticker renderer
            const extraLbl = prefix.length > 3 ? prefix.trim() : '';
            const baseLbl = suffix || mg.subtext || '';
            const tickerLbl = extraLbl ? (baseLbl ? `${extraLbl} ${baseLbl}` : extraLbl) : baseLbl;

            MGRenderer._setFont(ctx, '900', 72, s.fontHeading);
            const numW = ctx.measureText(numText).width;
            MGRenderer._setFont(ctx, '600', 26, s.fontBody);
            const lblW = tickerLbl ? ctx.measureText(tickerLbl).width : 0;
            // padding(24) + numW + gap(20) + sep + gap(16) + lblW + padding(16)
            boxW = Math.max(300, Math.min(900, numW + Math.min(lblW, 400) + 76));
        }
        const boxH = variant === 'ring' ? 260 : 150;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        this._dispatchVariant(ctx, 'statCounter', variant, mg, s, anim, null, {
            bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors, sc,
            currentNumber, prefix, suffix, scaleSuffix, countProgress, targetNumber, isPercent,
            scale, entSlideY, entBlur, labelSpring, idleScale,
            label: suffix || mg.subtext || '',
        });

        ctx.restore();
    }

    // ── StatCounter variant: Standard (big centered number + label below) ──
    _renderSC_Standard(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, sc, currentNumber, prefix, label, scaleSuffix,
                scale, entSlideY, entBlur, labelSpring, idleScale } = setup;
        const { opacity } = anim;

        const accentFill = colors?.accentFill || sc.accentFill;
        const textFill = colors?.textFill || sc.textFill;
        const numberFill = sc.numberFill || accentFill;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (entBlur > 0.5) ctx.filter = `blur(${entBlur.toFixed(1)}px)`;

        // Number — optional glow pass for neon/elegant
        MGRenderer._setFont(ctx, sc.numberWeight, 96, s.fontHeading);
        ctx.fillStyle = numberFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (sc.glow) {
            ctx.shadowColor = accentFill;
            ctx.shadowBlur = 28;
            ctx.shadowOffsetY = 0;
            ctx.fillText(`${prefix}${currentNumber}${scaleSuffix || ''}`, 0, -10);
        }
        ctx.shadowColor = sc.shadowColor;
        ctx.shadowBlur = sc.shadowBlur;
        ctx.shadowOffsetY = sc.shadowY;
        ctx.fillText(`${prefix}${currentNumber}${scaleSuffix || ''}`, 0, -10);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        ctx.filter = 'none';

        // Label
        if (label) {
            ctx.globalAlpha = Math.min(1, opacity) * labelSpring;
            MGRenderer._setFont(ctx, sc.labelWeight, 28, s.fontBody);
            ctx.fillStyle = textFill;
            ctx.shadowColor = sc.labelShadowColor;
            ctx.shadowBlur = sc.labelShadowBlur;
            ctx.fillText(label, 0, 50);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
    }

    // ── StatCounter variant: Ticker (horizontal card — number left, label right) ──
    _renderSC_Ticker(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, sc, currentNumber, prefix, label, scaleSuffix,
                scale, entSlideY, entBlur, labelSpring, idleScale } = setup;
        const { opacity } = anim;

        const bgFill = colors?.bgFill || sc.bgFill;
        const accentFill = colors?.accentFill || sc.accentFill;
        const textFill = colors?.textFill || sc.textFill;
        const numberFill = sc.numberFill || accentFill;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (entBlur > 0.5) ctx.filter = `blur(${entBlur.toFixed(1)}px)`;

        // Card background
        ctx.shadowColor = sc.shadowColor;
        ctx.shadowBlur = sc.shadowBlur + 2;
        ctx.shadowOffsetY = Math.max(2, sc.shadowY - 1);
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, sc.radius);
        ctx.fillStyle = bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Left accent stripe
        ctx.fillStyle = accentFill;
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, 5, bh, 3);
        ctx.fill();

        ctx.filter = 'none';

        // Ticker layout: big number on left, context label on right
        const shortPrefix = prefix.length <= 3 ? prefix : '';
        const numDisplay = `${shortPrefix}${currentNumber}${scaleSuffix || ''}`;
        const extraLabel = prefix.length > 3 ? prefix.trim() : '';
        const baseLabel = label || '';
        const tickerLabel = extraLabel ? (baseLabel ? `${extraLabel} ${baseLabel}` : extraLabel) : baseLabel;

        // Number on left
        MGRenderer._setFont(ctx, sc.numberWeight, 72, s.fontHeading);
        ctx.fillStyle = numberFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        if (sc.glow) {
            ctx.shadowColor = accentFill;
            ctx.shadowBlur = 18;
            ctx.fillText(numDisplay, -bw / 2 + 24, 0);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
        ctx.fillText(numDisplay, -bw / 2 + 24, 0);

        // Vertical separator
        const numW = ctx.measureText(numDisplay).width;
        const sepX = -bw / 2 + 24 + numW + 20;
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sepX, -bh / 2 + 16);
        ctx.lineTo(sepX, bh / 2 - 16);
        ctx.stroke();

        // Label on right — truncate if too long for remaining space
        if (tickerLabel) {
            ctx.globalAlpha = Math.min(1, opacity) * labelSpring;
            MGRenderer._setFont(ctx, sc.labelWeight, 26, s.fontBody);
            ctx.fillStyle = textFill;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const maxLabelW = bw / 2 - (sepX + 16) + bw / 2 - 16;
            let displayLabel = tickerLabel;
            if (ctx.measureText(displayLabel).width > maxLabelW && maxLabelW > 40) {
                while (displayLabel.length > 3 && ctx.measureText(displayLabel + '...').width > maxLabelW) {
                    displayLabel = displayLabel.slice(0, -1);
                }
                displayLabel += '...';
            }
            ctx.fillText(displayLabel, sepX + 16, 0);
        }
    }

    // ── StatCounter variant: Ring (circular progress arc around number) ──
    _renderSC_Ring(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, sc, currentNumber, prefix, label, scaleSuffix, countProgress,
                targetNumber, isPercent, scale, entSlideY, entBlur, labelSpring, idleScale } = setup;
        const { opacity } = anim;

        const accentFill = colors?.accentFill || sc.accentFill;
        const textFill = colors?.textFill || sc.textFill;
        const numberFill = sc.numberFill || accentFill;

        const cx = bx + bw / 2;
        const cy = by + bh / 2 - 20;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (entBlur > 0.5) ctx.filter = `blur(${entBlur.toFixed(1)}px)`;

        // Ring parameters
        const ringR = 80;
        const ringW = 8;
        const arcFill = isPercent ? countProgress * (targetNumber / 100) : countProgress;

        // Background ring (track)
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = sc.ringTrackColor;
        ctx.lineWidth = ringW;
        ctx.stroke();

        // Progress ring — fills clockwise from top
        if (countProgress > 0) {
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + (Math.PI * 2 * Math.min(1, arcFill));
            ctx.beginPath();
            ctx.arc(0, 0, ringR, startAngle, endAngle);
            if (sc.glow) {
                ctx.shadowColor = accentFill;
                ctx.shadowBlur = 22;
            }
            ctx.strokeStyle = accentFill;
            ctx.lineWidth = ringW;
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        ctx.filter = 'none';

        // Number inside ring
        MGRenderer._setFont(ctx, sc.numberWeight, 64, s.fontHeading);
        ctx.fillStyle = numberFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = sc.shadowColor;
        ctx.shadowBlur = Math.max(6, sc.shadowBlur - 4);
        ctx.fillText(`${prefix}${currentNumber}${scaleSuffix || ''}`, 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Label below ring
        if (label) {
            ctx.globalAlpha = Math.min(1, opacity) * labelSpring;
            MGRenderer._setFont(ctx, sc.labelWeight, 26, s.fontBody);
            ctx.fillStyle = textFill;
            ctx.shadowColor = sc.labelShadowColor;
            ctx.shadowBlur = sc.labelShadowBlur;
            ctx.fillText(label, 0, ringR + 36);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
    }

    // ========================================================================
    // 4. CALLOUT
    // ========================================================================

    // ── Callout setup + dispatch (same pattern as lowerThird) ──
    _renderCallout(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'callout');
        const animType = this._resolveAnimation(mg, s, 'callout');
        const colors = this._resolveColors(s, 'callout', mg);
        const cs = this._getCalloutStyle(mg, s);

        // Measure text for dynamic box sizing (style-aware font)
        MGRenderer._setFont(ctx, cs.titleStyle, cs.titleSize, s.fontHeading);
        const textWidth = Math.min(ctx.measureText(mg.text || '').width + 80, 1920 * 0.7);
        const boxW = Math.max(400, textWidth);
        const boxH = mg.subtext ? 160 : 120;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'callout', variant, mg, s, anim, a,
            { bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors, cs });

        ctx.restore();
    }

    // ── Callout variant: Standard (quote box with decorative quote mark) ──
    _renderCO_Standard(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors, cs } = setup;
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale } = anim;

        const bgFill = colors?.bgFill || cs.bgFill;
        const textFill = colors?.textFill || cs.textFill;
        const accentFill = colors?.accentFill || cs.accentFill;
        const subFill = cs.subFill;

        const scale = (a.scale || 1) * (isExiting ? interpolate(exitProgress, [0, 1], [0.97, 1]) : 1);

        ctx.translate(bx + bw / 2, by + bh / 2 + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);
        if (a.blur > 0.5) ctx.filter = `blur(${a.blur.toFixed(1)}px)`;

        if (cs.glow) {
            ctx.shadowColor = cs.shadowColor;
            ctx.shadowBlur = cs.shadowBlur;
        } else {
            ctx.shadowColor = cs.shadowColor;
            ctx.shadowBlur = cs.shadowBlur;
            ctx.shadowOffsetY = cs.shadowY;
        }
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, cs.radius);
        ctx.fillStyle = bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.strokeStyle = cs.borderColor || accentFill;
        ctx.lineWidth = cs.borderWidth;
        ctx.stroke();

        ctx.filter = 'none';

        // Quote mark with staggered entrance
        ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1) * cs.quoteOpacity;
        MGRenderer._setFont(ctx, '900', cs.quoteSize, s.fontHeading);
        ctx.fillStyle = cs.quoteFill || accentFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('\u201C', -bw / 2 + 20, -bh / 2 - 24);

        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        MGRenderer._setFont(ctx, cs.titleStyle, cs.titleSize, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 4;
        ctx.fillText(mg.text || '', (a.textSlideX || 0), mg.subtext ? -15 : 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1);
            MGRenderer._setFont(ctx, cs.subWeight, cs.subSize, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.fillText(`\u2014 ${mg.subtext}`, 0, bh / 2 - 30);
        }
    }

    // ── Callout variant: Minimal (clean text, thin bottom line, no quote mark) ──
    _renderCO_Minimal(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors, cs } = setup;
        const { isExiting, exitProgress, opacity, idleScale } = anim;

        const textFill = colors?.textFill || cs.textFill;
        const accentFill = colors?.accentFill || cs.accentFill;
        const subFill = cs.subFill;

        const scale = (a.scale || 1) * (isExiting ? 0.97 + exitProgress * 0.03 : 1);

        ctx.translate(bx + bw / 2, by + bh / 2 + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);
        if (a.blur > 0.5) ctx.filter = `blur(${a.blur.toFixed(1)}px)`;

        // Subtle frosted background — barely there
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, cs.radius);
        ctx.fill();

        ctx.filter = 'none';

        // Main text — clean, no italic forced (style controls font style)
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        // Strip "italic " prefix for minimal — minimal styles read cleaner upright
        const cleanWeight = (cs.titleStyle || '600').replace(/^italic\s+/, '');
        MGRenderer._setFont(ctx, cleanWeight, cs.titleSize, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 4;
        ctx.fillText(mg.text || '', (a.textSlideX || 0), mg.subtext ? -15 : 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Animated underline
        const lineW = bw * 0.6 * (a.clipX != null ? a.clipX : (a.subSpring || 1));
        ctx.strokeStyle = accentFill;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-lineW / 2, bh / 2 - 45);
        ctx.lineTo(lineW / 2, bh / 2 - 45);
        ctx.stroke();

        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1);
            MGRenderer._setFont(ctx, cs.subWeight, cs.subSize, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(mg.subtext, 0, bh / 2 - 25);
        }
    }

    // ── Callout variant: Accent (left accent bar, blockquote style) ──
    _renderCO_Accent(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors, cs } = setup;
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale } = anim;

        const bgFill = colors?.bgFill || cs.bgFill;
        const textFill = colors?.textFill || cs.textFill;
        const accentFill = colors?.accentFill || cs.accentFill;
        const subFill = cs.subFill;

        const scale = (a.scale || 1) * (isExiting ? interpolate(exitProgress, [0, 1], [0.97, 1]) : 1);

        ctx.translate(bx + bw / 2, by + bh / 2 + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);
        if (a.blur > 0.5) ctx.filter = `blur(${a.blur.toFixed(1)}px)`;

        // Dark background card
        ctx.shadowColor = cs.shadowColor;
        ctx.shadowBlur = cs.shadowBlur;
        ctx.shadowOffsetY = cs.shadowY;
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, cs.radius);
        ctx.fillStyle = bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Left accent bar — animated height via clipX/subSpring
        const barW = 5;
        const barH = bh * (a.clipX != null ? a.clipX : (a.subSpring || 1));
        ctx.fillStyle = accentFill;
        MGRenderer._roundRect(ctx, -bw / 2, -barH / 2, barW, barH, 3);
        ctx.fill();

        ctx.filter = 'none';

        // Main text — left-aligned, offset from accent bar
        const textX = -bw / 2 + 28;
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        MGRenderer._setFont(ctx, cs.titleStyle, cs.titleSize, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 4;
        ctx.fillText(mg.text || '', textX + (a.textSlideX || 0), mg.subtext ? -15 : 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1);
            MGRenderer._setFont(ctx, cs.subWeight, cs.subSize, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'left';
            ctx.fillText(`\u2014 ${mg.subtext}`, textX, bh / 2 - 30);
        }
    }

    // ========================================================================
    // 5. BULLET LIST
    // ========================================================================

    _renderBulletList(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;

        // Parse items from subtext (label:value pairs) — same as rankingList/barChart/etc.
        let items = MGRenderer._parseKeyValuePairs(mg.subtext);
        // Fallback: split mg.text by commas if no subtext items
        if (items.length === 0 && mg.text) {
            items = (mg.text || '').split(/[,;]|\d+\.\s/).map(t => t.trim()).filter(Boolean)
                .map(t => ({ label: t, value: '' }));
        }
        const staggerDelay = Math.round(fps * 0.25);
        const maxItems = Math.min(items.length, 8);
        const rowH = 55;
        const listW = 1920 * 0.55;
        const titleH = mg.text && items.length > 0 && items[0].label !== mg.text ? 60 : 0;
        const totalH = titleH + maxItems * rowH;
        const dotR = 7;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const pos = MGRenderer._getPosXY(mg.position || 'center-left', listW, totalH);
        ctx.translate(pos.x, pos.y);
        ctx.scale(idleScale, idleScale);

        // Heading (mg.text) — only if different from first item
        if (titleH > 0) {
            MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 6;
            ctx.fillText(mg.text, 0, 0);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        items.slice(0, maxItems).forEach((item, i) => {
            const rowDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
            const rowSpring = springValue(Math.max(0, frame - rowDelay), fps, { damping: 16, stiffness: 120 });
            const slideX = interpolate(rowSpring, [0, 1], [50, 0]);
            const rowBlur = interpolate(rowSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });
            const ry = titleH + i * rowH;

            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : rowSpring);

            ctx.save();
            if (rowBlur > 0.5) ctx.filter = `blur(${rowBlur.toFixed(1)}px)`;

            // Accent bullet dot
            ctx.beginPath();
            ctx.arc(dotR + slideX, ry + rowH / 2, dotR, 0, Math.PI * 2);
            ctx.fillStyle = s.accent;
            ctx.fill();

            // Label text — clean rendering (no glow passes)
            MGRenderer._setFont(ctx, '600', 28, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(item.label, dotR * 2 + 16 + slideX, ry + rowH / 2);

            // Value on the right (if present)
            if (item.value && item.value !== '0') {
                MGRenderer._setFont(ctx, '700', 24, s.fontHeading);
                ctx.fillStyle = s.accent;
                ctx.textAlign = 'right';
                ctx.fillText(item.value, listW + slideX, ry + rowH / 2);
            }

            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Subtle separator line
            if (i < maxItems - 1) {
                ctx.fillStyle = 'rgba(255,255,255,0.08)';
                ctx.fillRect(dotR * 2 + 16 + slideX, ry + rowH - 2, listW - dotR * 2 - 16, 1);
            }

            ctx.filter = 'none';
            ctx.restore();
        });

        ctx.restore();
    }

    // ========================================================================
    // 6. FOCUS WORD
    // ========================================================================

    _renderFocusWord(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterLinear, isExiting, exitProgress, opacity } = anim;
        const speed = mg._animationSpeed || 1.0;

        const snapSpring = springValue(frame, fps, { damping: 20, stiffness: 250, durationInFrames: Math.round((0.4 / speed) * fps) });
        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [1.3, 1])
            : interpolate(snapSpring, [0, 1], [1.8, 1]);
        const blur = isExiting
            ? interpolate(exitProgress, [0, 1], [6, 0])
            : interpolate(enterLinear, [0, 0.3], [8, 0], { extrapolateRight: 'clamp' });
        const letterSpacing = interpolate(snapSpring, [0, 1], [20, 2]);
        const scrimOpacity = interpolate(enterLinear, [0, 0.15], [0, 0.3], { extrapolateRight: 'clamp' }) * (isExiting ? exitProgress : 1);

        ctx.save();

        // Dark scrim overlay
        ctx.fillStyle = `rgba(0,0,0,${scrimOpacity.toFixed(3)})`;
        ctx.fillRect(0, 0, 1920, 1080);

        ctx.globalAlpha = Math.min(1, opacity);
        ctx.translate(1920 / 2, 1080 / 2);
        ctx.scale(scale, scale);
        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        const word = (mg.text || '').toUpperCase();

        const maxTextWidth = 1920 * 0.8;
        let fontSize = 96;
        MGRenderer._setFont(ctx, '900', fontSize, s.fontHeading);
        let lines = MGRenderer._wrapTextWords(ctx, word, maxTextWidth);
        while (lines.length > 2 && fontSize > 48) {
            fontSize -= 4;
            MGRenderer._setFont(ctx, '900', fontSize, s.fontHeading);
            lines = MGRenderer._wrapTextWords(ctx, word, maxTextWidth);
        }

        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const lineHeight = fontSize * 1.1;
        const totalTextHeight = lines.length * lineHeight;
        const startY = -totalTextHeight / 2 + lineHeight / 2;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const lineText = lines[lineIdx];
            const lineY = startY + lineIdx * lineHeight;

            if (letterSpacing > 3) {
                const chars = lineText.split('');
                const charWidths = chars.map(c => ctx.measureText(c).width);
                const totalW = charWidths.reduce((a, b) => a + b, 0) + (chars.length - 1) * letterSpacing;
                let cx = -totalW / 2;
                for (let i = 0; i < chars.length; i++) {
                    const charX = cx + charWidths[i] / 2;
                    if (s.glow) {
                        ctx.shadowColor = s.accent + '40';
                        ctx.shadowBlur = 80;
                        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
                        ctx.fillText(chars[i], charX, lineY);
                        ctx.shadowColor = s.accent + 'cc';
                        ctx.shadowBlur = 40;
                        ctx.fillText(chars[i], charX, lineY);
                    } else {
                        ctx.shadowColor = 'rgba(0,0,0,0.9)';
                        ctx.shadowBlur = 30;
                        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 4;
                        ctx.fillText(chars[i], charX, lineY);
                    }
                    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
                    ctx.fillText(chars[i], charX, lineY);
                    cx += charWidths[i] + letterSpacing;
                }
            } else {
                MGRenderer._drawTextShadowed(ctx, lineText, 0, lineY, s, true);
            }
        }

        ctx.filter = 'none';

        if (mg.subtext) {
            const subOpacity = interpolate(enterLinear, [0.5, 0.75], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
                * (isExiting ? exitProgress : 1);
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '500', 28, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            const subY = startY + lines.length * lineHeight + 20;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, 0, subY, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // 7. PROGRESS BAR
    // ========================================================================

    _renderProgressBar(ctx, frame, fps, mg, s, anim) {
        const { interpolate, easeOutCubic } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;

        // Use animation system — respects user's animation dropdown choice
        const animType = this._resolveAnimation(mg, s, 'progressBar');
        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        const numMatch = (mg.text || '').match(/[\d,.]+/);
        const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
        const label = (mg.text || '').replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';

        const fillStart = Math.round(enterFrames * 0.5);
        const fillEnd = Math.max(fillStart + 1, Math.min(enterFrames + Math.round(fps * 0.3), totalFrames - 15));
        const fillProgress = easeOutCubic(interpolate(frame, [fillStart, fillEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
        const currentPct = Math.round(targetPct * fillProgress);

        const scale = (a.scale || 1) * (isExiting ? interpolate(exitProgress, [0, 1], [0.97, 1]) : 1);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const barW = 1920 * 0.6;
        const pos = MGRenderer._getPosXY(mg.position || 'center', barW, 120);
        const cx = pos.x + barW / 2;
        const cy = pos.y + 60;

        ctx.translate(cx, cy + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);

        // Label — clean rendering
        if (label) {
            MGRenderer._setFont(ctx, '700', 28, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(label, 0, -40);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        const trackW = barW;
        const trackH = 24;
        MGRenderer._roundRect(ctx, -trackW / 2, -trackH / 2, trackW, trackH, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();

        const fillW = trackW * (targetPct * fillProgress / 100);
        if (fillW > 1) {
            MGRenderer._roundRect(ctx, -trackW / 2, -trackH / 2, fillW, trackH, 12);
            const grad = ctx.createLinearGradient(-trackW / 2, 0, -trackW / 2 + fillW, 0);
            grad.addColorStop(0, s.primary);
            grad.addColorStop(1, s.accent);
            ctx.fillStyle = grad;
            if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 16; }
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        // Percentage — clean rendering
        MGRenderer._setFont(ctx, '900', 48, s.fontHeading);
        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 3;
        ctx.fillText(`${currentPct}%`, 0, 45);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        ctx.restore();
    }

    // ========================================================================
    // 8. BAR CHART
    // ========================================================================

    _renderBarChart(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        const items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
        const staggerDelay = Math.round(fps * 0.15);
        const barCount = Math.min(items.length, 6);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const chartW = 1920 * 0.6;
        const chartH = 300;
        const pos = MGRenderer._getPosXY(mg.position || 'center', chartW, chartH + 80);
        const cx = pos.x + chartW / 2;
        const topY = pos.y;

        ctx.translate(cx, topY);
        ctx.scale(idleScale, idleScale);

        // Title — clean rendering
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(mg.text || '', 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        const barAreaW = chartW;
        const barGap = 20;
        const singleBarW = (barAreaW - (barCount - 1) * barGap) / barCount;
        const barAreaTop = 60;
        const barAreaH = chartH;

        for (let i = 0; i < barCount; i++) {
            const item = items[i];
            const barDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
            const barSpring = springValue(Math.max(0, frame - barDelay), fps, { damping: 14, stiffness: 80 });
            const numVal = parseFloat(item.value) || 0;
            const heightPct = (numVal / maxVal);
            const barH = heightPct * barSpring * (barAreaH - 40);
            const bx = -barAreaW / 2 + i * (singleBarW + barGap);
            const by = barAreaTop + barAreaH - barH;

            const valDelay = barDelay + Math.round(fps * 0.2);
            const valOpacity = interpolate(frame, [valDelay, valDelay + Math.round(fps * 0.15)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : valOpacity);
            // Value label — clean rendering
            MGRenderer._setFont(ctx, '700', 24, s.fontHeading);
            ctx.fillStyle = s.accent;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(item.value, bx + singleBarW / 2, by - 6);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            ctx.globalAlpha = Math.min(1, opacity);
            if (barH > 0) {
                const grad = ctx.createLinearGradient(0, by, 0, by + barH);
                grad.addColorStop(0, s.accent);
                grad.addColorStop(1, s.primary);
                ctx.fillStyle = grad;
                MGRenderer._roundRect(ctx, bx, by, singleBarW, barH, 6);
                if (s.glow) { ctx.shadowColor = s.primary + '60'; ctx.shadowBlur = 12; }
                ctx.fill();
                ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            }

            MGRenderer._setFont(ctx, '500', 18, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(item.label, bx + singleBarW / 2, barAreaTop + barAreaH + 8);
        }

        ctx.restore();
    }

    // ========================================================================
    // 9. DONUT CHART
    // ========================================================================

    _renderDonutChart(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        const items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
        const radius = 100;
        const strokeWidth = 30;
        const staggerDelay = Math.round(fps * 0.2);
        const segColors = [s.primary, s.accent, s.primary + 'bb', s.accent + 'bb', s.primary + '88'];

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.95, 1])
            : interpolate(enterSpring, [0, 1], [0.7, 1]);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const pos = MGRenderer._getPosXY(mg.position || 'center', 520, 300);

        ctx.translate(pos.x + 260, pos.y + 150);
        ctx.scale(scale * idleScale, scale * idleScale);

        // Title — clean rendering
        MGRenderer._setFont(ctx, '700', 32, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(mg.text || '', 0, -140);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        let cumulativeAngle = -Math.PI / 2;

        items.slice(0, 5).forEach((item, i) => {
            const pct = (parseFloat(item.value) || 0) / total;
            const segAngle = pct * Math.PI * 2;
            const drawDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
            const drawProgress = easeOutCubic(interpolate(frame, [drawDelay, drawDelay + Math.round(fps * 0.5)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
            const drawAngle = segAngle * drawProgress;

            if (drawAngle > 0.01) {
                ctx.beginPath();
                ctx.arc(-130, 20, radius, cumulativeAngle, cumulativeAngle + drawAngle);
                ctx.strokeStyle = segColors[i % segColors.length];
                ctx.stroke();
            }
            cumulativeAngle += segAngle;
        });

        const centerDelay = Math.round(enterFrames * 0.4);
        const centerOpacity = interpolate(frame, [centerDelay, centerDelay + Math.round(fps * 0.3)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : centerOpacity);
        // Center percentage — clean rendering
        MGRenderer._setFont(ctx, '900', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 4;
        const mainPct = items.length > 0 ? Math.round((parseFloat(items[0].value) || 0) / total * 100) : 0;
        ctx.fillText(`${mainPct}%`, -130, 20);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        items.slice(0, 5).forEach((item, i) => {
            const legendDelay = Math.round(enterFrames * 0.5 + i * Math.round(fps * 0.12));
            const legendOpacity = interpolate(frame, [legendDelay, legendDelay + Math.round(fps * 0.2)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : legendOpacity);

            const ly = -40 + i * 30;
            ctx.beginPath();
            ctx.arc(30, ly, 7, 0, Math.PI * 2);
            ctx.fillStyle = segColors[i % segColors.length];
            ctx.fill();
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.label, 45, ly);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            MGRenderer._setFont(ctx, '600', 20, s.fontBody);
            ctx.fillText(`${item.value}%`, 45 + ctx.measureText(item.label).width + 10, ly);
        });

        ctx.restore();
    }

    // ========================================================================
    // 10. COMPARISON CARD
    // ========================================================================

    _renderComparisonCard(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const parts = (mg.text || '').split(/\s+vs\.?\s+/i);
        const itemA = parts[0] || 'A';
        const itemB = parts[1] || 'B';

        const slideX = isExiting
            ? interpolate(exitProgress, [0, 1], [60, 0])
            : interpolate(enterSpring, [0, 1], [200, 0]);

        const vsDelay = Math.round((0.3 / speed) * fps);
        const vsSpring = springValue(Math.max(0, frame - vsDelay), fps, { damping: 12, stiffness: 150, durationInFrames: Math.round((0.4 / speed) * fps) });

        const subDelay = Math.round((0.5 / speed) * fps);
        const subOpacity = interpolate(frame, [subDelay, subDelay + Math.round((0.3 / speed) * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const boxW = 1920 * 0.35;
        const boxH = 120;
        const gap = 100;
        const totalW = boxW * 2 + gap;
        const pos = MGRenderer._getPosXY(mg.position || 'center', totalW, boxH);
        const cx = pos.x + totalW / 2;
        const cy = pos.y + boxH / 2;

        ctx.translate(cx, cy);
        ctx.scale(idleScale, idleScale);

        // Left box
        ctx.save();
        ctx.translate(-boxW / 2 - gap / 2 - slideX, 0);
        MGRenderer._roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16);
        ctx.fillStyle = s.primary + '25';
        ctx.fill();
        ctx.strokeStyle = s.primary + '40';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Item A text — clean rendering (has card background, no glow needed)
        MGRenderer._setFont(ctx, '800', 42, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 6;
        ctx.fillText(itemA.toUpperCase(), 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        ctx.restore();

        // Right box
        ctx.save();
        ctx.translate(boxW / 2 + gap / 2 + slideX, 0);
        MGRenderer._roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16);
        ctx.fillStyle = s.accent + '25';
        ctx.fill();
        ctx.strokeStyle = s.accent + '40';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Item B text — clean rendering
        MGRenderer._setFont(ctx, '800', 42, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 6;
        ctx.fillText(itemB.toUpperCase(), 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        ctx.restore();

        // VS circle
        ctx.save();
        ctx.scale(vsSpring, vsSpring);
        ctx.beginPath();
        ctx.arc(0, 0, 40, 0, Math.PI * 2);
        const vsGrad = ctx.createLinearGradient(-40, -40, 40, 40);
        vsGrad.addColorStop(0, s.primary);
        vsGrad.addColorStop(1, s.accent);
        ctx.fillStyle = vsGrad;
        if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 24; }
        else { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20; }
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        MGRenderer._setFont(ctx, '900', 28, s.fontHeading);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('VS', 0, 0);
        ctx.restore();

        // Subtext — clean rendering
        if (mg.subtext && mg.subtext !== 'none') {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : subOpacity);
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 3;
            ctx.fillText(mg.subtext, 0, boxH / 2 + 40);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        ctx.restore();
    }

    // ========================================================================
    // 11. TIMELINE
    // ========================================================================

    _renderTimeline(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        let items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const staggerDelay = Math.round(fps * 0.25);
        const lineWidth = interpolate(enterSpring, [0, 1], [0, 100]);

        // If no subtext items, try to extract date range from title text
        if (items.length === 0 && mg.text) {
            const dateMatch = mg.text.match(/(\d{4})s?\s*[\u2192\-\u2013\u2014to]+\s*(\d{4})s?/i);
            if (dateMatch) {
                const startYear = parseInt(dateMatch[1]);
                const endYear = parseInt(dateMatch[2]);
                const span = endYear - startYear;
                const step = span <= 20 ? 5 : span <= 50 ? 10 : 20;
                for (let y = startYear; y <= endYear; y += step) {
                    items.push({ label: String(y) + 's', value: '' });
                }
                if (items.length > 0 && parseInt(items[items.length - 1].label) < endYear) {
                    items.push({ label: String(endYear) + 's', value: '' });
                }
            }
        }

        const tlW = 1920 * 0.80;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        // Center everything on screen
        ctx.translate(960, 540);
        ctx.scale(idleScale, idleScale);

        // Title — clean text shadow, no glow
        if (mg.text) {
            MGRenderer._setFont(ctx, '700', 46, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 8;
            ctx.shadowOffsetY = 2;
            ctx.fillText(mg.text, 0, -120);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        }

        // Thin gradient timeline line
        const lineH = 3;
        const lineW = tlW * lineWidth / 100;
        if (lineW > 0) {
            const lineGrad = ctx.createLinearGradient(-tlW / 2, 0, -tlW / 2 + lineW, 0);
            lineGrad.addColorStop(0, s.primary);
            lineGrad.addColorStop(1, s.accent);
            ctx.fillStyle = lineGrad;
            ctx.fillRect(-tlW / 2, -lineH / 2, lineW, lineH);
        }

        // Markers along the line
        const dotR = 9;
        items.slice(0, 6).forEach((item, i) => {
            const pct = items.length > 1 ? i / (items.length - 1) : 0.5;
            const mx = -tlW / 2 + pct * tlW;
            const markerDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
            const markerSpring = springValue(Math.max(0, frame - markerDelay), fps, { damping: 16, stiffness: 120 });
            const slideY = interpolate(markerSpring, [0, 1], [-12, 0]);

            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : markerSpring);

            // Dot — filled circle with dark ring for contrast against line
            ctx.beginPath();
            ctx.arc(mx, slideY, dotR, 0, Math.PI * 2);
            ctx.fillStyle = s.accent;
            ctx.fill();
            // Dark ring to separate dot from line
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 2;
            ctx.stroke();
            // Subtle outer glow
            if (s.glow) {
                ctx.beginPath();
                ctx.arc(mx, slideY, dotR + 3, 0, Math.PI * 2);
                ctx.strokeStyle = s.accent + '30';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Year/label above the dot
            MGRenderer._setFont(ctx, '700', 25, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 4;
            ctx.fillText(item.label, mx, -dotR - 18 + slideY);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Event text below the dot
            if (item.value) {
                MGRenderer._setFont(ctx, '500', 21, s.fontBody);
                ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.shadowColor = 'rgba(0,0,0,0.6)';
                ctx.shadowBlur = 3;
                const maxEventW = items.length > 1 ? tlW / items.length * 0.85 : tlW * 0.5;
                const eventLines = MGRenderer._wrapTextWords(ctx, item.value, maxEventW);
                for (let li = 0; li < eventLines.length; li++) {
                    ctx.fillText(eventLines[li], mx, dotR + 18 + slideY + li * 26);
                }
                ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            }
        });

        ctx.restore();
    }

    // ========================================================================
    // 11b. TYPEWRITER — dispatcher + 2 variants
    // ========================================================================

    _renderTypewriter(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'typewriter');
        const animType = this._resolveAnimation(mg, s, 'typewriter');
        const colors = this._resolveColors(s, 'typewriter', mg);
        const tw = this._getTypewriterStyle(mg, s);

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        const fullText = mg.text || '';
        const revealPct = a.revealProgress || 0;
        const charCount = Math.floor(fullText.length * Math.min(1, revealPct));
        const visibleText = fullText.substring(0, charCount);

        // Box sizing — style-driven font weight
        MGRenderer._setFont(ctx, tw.textWeight, 42, s.fontHeading);
        const fullW = Math.min(ctx.measureText(fullText).width + 60, 1920 * 0.75);
        const boxW = Math.max(350, fullW);
        const boxH = mg.subtext ? 130 : 90;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'typewriter', variant, mg, s, anim, a, {
            bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors, tw,
            visibleText, fullText, revealPct, charCount,
        });

        ctx.restore();
    }

    // ── Typewriter variant: Standard (dark backdrop + text + cursor) ──
    _renderTW_Standard(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors, tw, visibleText, revealPct } = setup;
        const { interpolate } = AnimationUtils;
        const { opacity, idleScale } = anim;

        const bgFill = colors?.bgFill || tw.bgFill;
        const textFill = colors?.textFill || tw.textFill;
        const accentFill = colors?.accentFill || tw.accentFill;
        const subFill = tw.subFill;

        const cx = bx + bw / 2;
        const cy = by + bh / 2 + (a.slideY || 0);
        ctx.translate(cx, cy);
        ctx.scale(idleScale, idleScale);

        // Card backdrop — style-driven shadow + glow
        if (tw.glow) {
            ctx.shadowColor = accentFill;
            ctx.shadowBlur = tw.cardShadowBlur;
        } else {
            ctx.shadowColor = tw.cardShadowColor;
            ctx.shadowBlur = tw.cardShadowBlur;
        }
        ctx.fillStyle = bgFill;
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, tw.radius);
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Accent bottom line
        ctx.fillStyle = accentFill;
        ctx.fillRect(-bw / 2, bh / 2 - tw.accentLineH, bw, tw.accentLineH);

        // Main text
        MGRenderer._setFont(ctx, tw.textWeight, 42, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = tw.shadowColor;
        ctx.shadowBlur = tw.shadowBlur;
        ctx.shadowOffsetY = tw.shadowY;
        const textX = -bw / 2 + 28;
        const textY = mg.subtext ? -12 : 0;
        ctx.fillText(visibleText, textX, textY);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Blinking cursor
        this._drawTW_Cursor(ctx, textX, textY, visibleText, accentFill, revealPct, a);

        // Subtext
        if (mg.subtext) {
            const subAlpha = interpolate(revealPct, [0.7, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * subAlpha;
            MGRenderer._setFont(ctx, tw.subWeight, 22, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'left';
            ctx.fillText(mg.subtext, textX, bh / 2 - 24);
        }
    }

    // ── Typewriter variant: Naked (no background, just text + cursor + shadow) ──
    _renderTW_Naked(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors, tw, visibleText, revealPct } = setup;
        const { interpolate } = AnimationUtils;
        const { opacity, idleScale } = anim;

        const textFill = colors?.textFill || tw.textFill;
        const accentFill = colors?.accentFill || tw.accentFill;
        const subFill = tw.subFill;

        const cx = bx + bw / 2;
        const cy = by + bh / 2 + (a.slideY || 0);
        ctx.translate(cx, cy);
        ctx.scale(idleScale, idleScale);

        // Main text — no background, stronger shadow for readability
        MGRenderer._setFont(ctx, tw.textWeight, 46, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        // Naked variant needs stronger shadow for readability — double the blur
        ctx.shadowColor = tw.shadowColor;
        ctx.shadowBlur = Math.max(8, tw.shadowBlur * 2);
        ctx.shadowOffsetY = Math.max(2, tw.shadowY + 1);
        const textX = -bw / 2 + 28;
        const textY = mg.subtext ? -12 : 0;
        if (tw.glow) {
            ctx.shadowColor = accentFill;
            ctx.shadowBlur = 18;
            ctx.fillText(visibleText, textX, textY);
            ctx.shadowColor = tw.shadowColor;
            ctx.shadowBlur = Math.max(8, tw.shadowBlur * 2);
        }
        ctx.fillText(visibleText, textX, textY);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Blinking cursor
        this._drawTW_Cursor(ctx, textX, textY, visibleText, accentFill, revealPct, a);

        // Subtext
        if (mg.subtext) {
            const subAlpha = interpolate(revealPct, [0.7, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * subAlpha;
            MGRenderer._setFont(ctx, tw.subWeight, 24, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'left';
            ctx.shadowColor = tw.shadowColor;
            ctx.shadowBlur = Math.max(4, tw.shadowBlur);
            ctx.fillText(mg.subtext, textX, bh / 2 - 24);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
    }

    // ── Shared: typewriter blinking cursor ──
    _drawTW_Cursor(ctx, textX, textY, visibleText, accentFill, revealPct, a) {
        const cursorW = ctx.measureText(visibleText).width;
        const cursorOn = revealPct < 1.05 ? true : Math.sin((a.revealProgress || 0) * 60) > 0;
        if (cursorOn) {
            ctx.fillStyle = accentFill;
            ctx.fillRect(textX + cursorW + 3, textY - 20, 3, 40);
        }
    }

    // ========================================================================
    // 12. RANKING LIST
    // ========================================================================

    _renderRankingList(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        const items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
        const staggerDelay = Math.round(fps * 0.18);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const listW = 1920 * 0.55;
        const rowH = 50;
        const pos = MGRenderer._getPosXY(mg.position || 'center-left', listW, items.length * rowH + 60);

        ctx.translate(pos.x, pos.y);
        ctx.scale(idleScale, idleScale);

        // Title — clean rendering, no glow passes
        MGRenderer._setFont(ctx, '700', 34, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(mg.text || '', 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        items.slice(0, 6).forEach((item, i) => {
            const rowDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
            const rowSpring = springValue(Math.max(0, frame - rowDelay), fps, { damping: 16, stiffness: 120 });
            const slideX = interpolate(rowSpring, [0, 1], [50, 0]);
            const rowBlur = interpolate(rowSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });
            const numVal = parseFloat(item.value) || 0;
            const barDelay = rowDelay + Math.round(fps * 0.15);
            const barRaw = interpolate(frame, [barDelay, barDelay + Math.round(fps * 0.6)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const barWidth = easeOutCubic(barRaw) * (numVal / maxVal) * (listW - 60);
            const isTop = i === 0;
            const ry = 50 + i * rowH;

            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : rowSpring);

            ctx.save();
            if (rowBlur > 0.5) ctx.filter = `blur(${rowBlur.toFixed(1)}px)`;

            // Rank number — clean rendering
            MGRenderer._setFont(ctx, '900', 30, s.fontHeading);
            ctx.fillStyle = isTop ? s.accent : (s.textSub || 'rgba(255,255,255,0.75)');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(`${i + 1}`, 24 + slideX, ry + 20);

            // Label — clean rendering
            MGRenderer._setFont(ctx, '600', 22, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.label, 60 + slideX, ry + 12);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            MGRenderer._setFont(ctx, '700', 20, s.fontHeading);
            ctx.fillStyle = s.accent;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.value, listW + slideX, ry + 12);

            ctx.filter = 'none';

            ctx.fillStyle = 'rgba(255,255,255,0.1)';
            MGRenderer._roundRect(ctx, 60 + slideX, ry + 28, listW - 60, 8, 4);
            ctx.fill();

            if (barWidth > 0) {
                const barGrad = ctx.createLinearGradient(60, 0, 60 + barWidth, 0);
                barGrad.addColorStop(0, isTop ? s.accent : s.primary + '99');
                barGrad.addColorStop(1, isTop ? s.primary : s.primary + '55');
                ctx.fillStyle = barGrad;
                MGRenderer._roundRect(ctx, 60 + slideX, ry + 28, barWidth, 8, 4);
                ctx.fill();
            }

            ctx.restore();
        });

        ctx.restore();
    }

    // ========================================================================
    // 13. KINETIC TEXT
    // ========================================================================

    // ── Style tokens for kineticText (independent of theme `s`) ──
    // RULE: each style uses EITHER a colored glow OR a dark drop shadow, NEVER both.
    // Doing both meant the word got drawn twice with shadow, leaving the letter edges
    // bumpy/smeared (that was the "still looks like that" issue). Styles listed below
    // set exactly one of { glow, dropShadow } and null the other.
    static _KINETIC_TEXT_STYLES = {
        clean: {
            text: '#ffffff',
            glow: null, glowSize: 0,
            dropShadow: 'rgba(0,0,0,0.7)', dropShadowBlur: 10, dropShadowY: 2,
            outline: 'rgba(0,0,0,0.88)', outlineWidth: 3,
            weight: '800', tracking: 0,
        },
        bold: {
            // YouTube/TikTok caption look: thick pure-black outline, no red halo
            text: '#ffffff',
            glow: null, glowSize: 0,
            dropShadow: 'rgba(0,0,0,0.85)', dropShadowBlur: 8, dropShadowY: 3,
            outline: '#000000', outlineWidth: 6,
            weight: '900', tracking: 0,
        },
        minimal: {
            text: 'rgba(255,255,255,0.96)',
            glow: null, glowSize: 0,
            dropShadow: 'rgba(0,0,0,0.4)', dropShadowBlur: 5, dropShadowY: 1,
            outline: null, outlineWidth: 0,
            weight: '500', tracking: 2,
        },
        neon: {
            // The COLOR is the neon. No halo, no rim-light, no edge tint.
            // Saturated green text + dark-green drop shadow for legibility — done.
            text: '#00ffaa',
            glow: null, glowSize: 0,
            dropShadow: 'rgba(0,40,26,0.65)', dropShadowBlur: 6, dropShadowY: 2,
            outline: null, outlineWidth: 0,
            weight: '900', tracking: 1,
        },
        cinematic: {
            text: '#f5ecd0',
            glow: null, glowSize: 0,
            dropShadow: 'rgba(0,0,0,0.78)', dropShadowBlur: 10, dropShadowY: 2,
            outline: 'rgba(0,0,0,0.92)', outlineWidth: 3,
            weight: '700', tracking: 1.5,
        },
        elegant: {
            // Almost invisible purple tint in the shadow. Typography carries the identity.
            text: '#ffffff',
            glow: null, glowSize: 0,
            dropShadow: 'rgba(80,40,140,0.3)', dropShadowBlur: 4, dropShadowY: 2,
            outline: null, outlineWidth: 0,
            weight: '500', tracking: 2.5,
        },
    };

    _getKineticTextStyle(mg, s) {
        // Priority: mg.style (user-set) > theme's styleName > 'clean'
        const themeStyle = s?._mgOverrides?.kineticText?.styleName;
        const name = mg.style || themeStyle || 'clean';
        return MGRenderer._KINETIC_TEXT_STYLES[name] || MGRenderer._KINETIC_TEXT_STYLES.clean;
    }

    _layoutKineticText(ctx, text, ks, fontFamily, options) {
        const words = String(text || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(word => word.toUpperCase());
        if (words.length === 0) return null;

        const { hasAttr = false, variant = 'centered' } = options || {};
        const maxWidth = 1920 * 0.74;
        const maxHeight = hasAttr ? 1080 * 0.38 : 1080 * 0.42;
        const maxRows = words.length <= 3 ? 2 : words.length <= 8 ? 3 : 4;
        const maxFontSize = variant === 'punch'
            ? 122
            : words.length <= 3
                ? 108
                : words.length <= 6
                    ? 96
                    : 82;
        const minFontSize = 50;

        let best = null;
        for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 4) {
            MGRenderer._setFont(ctx, ks.weight, fontSize, fontFamily);
            const gap = Math.round(Math.max(20, Math.min(40, fontSize * 0.18)));
            const rowHeight = Math.round(fontSize * 1.08);
            const attrFontSize = Math.round(Math.max(28, Math.min(56, fontSize * 0.34)));
            const attrMargin = hasAttr ? Math.round(Math.max(18, fontSize * 0.5)) : 0;

            const rows = [];
            let currentEntries = [];
            let currentWidth = 0;

            for (let i = 0; i < words.length; i++) {
                const width = ctx.measureText(words[i]).width;
                const nextWidth = currentEntries.length > 0 ? currentWidth + gap + width : width;
                if (nextWidth > maxWidth && currentEntries.length > 0) {
                    rows.push({ entries: currentEntries, width: currentWidth });
                    currentEntries = [];
                    currentWidth = 0;
                }

                currentEntries.push({ word: words[i], width, index: i });
                currentWidth = currentEntries.length > 1 ? currentWidth + gap + width : width;
            }

            if (currentEntries.length > 0) {
                rows.push({ entries: currentEntries, width: currentWidth });
            }

            const textHeight = rows.length * rowHeight;
            const totalHeight = textHeight + (hasAttr ? attrMargin + attrFontSize * 1.2 : 0);
            const widestRow = rows.reduce((max, row) => Math.max(max, row.width), 0);

            best = {
                words,
                rows,
                fontSize,
                gap,
                rowHeight,
                attrFontSize,
                attrMargin,
                textHeight,
                totalHeight,
                widestRow,
            };

            if (rows.length <= maxRows && widestRow <= maxWidth && totalHeight <= maxHeight) {
                return best;
            }
        }

        return best;
    }

    _renderKineticText(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity } = anim;

        const ks = this._getKineticTextStyle(mg, s);
        const variant = this._resolveVariant(mg, s, 'kineticText');
        const animation = this._resolveAnimation(mg, s, 'kineticText');
        const fontFamily = s.fontHeading;
        const hasAttr = !!(mg.subtext && mg.subtext !== 'none');
        const layout = this._layoutKineticText(ctx, mg.text, ks, fontFamily, { hasAttr, variant });
        if (!layout) return;
        const { rows, fontSize, gap, rowHeight, attrFontSize, attrMargin, textHeight, totalHeight } = layout;

        // Smooth eased curve — cubic-out with a subtle overshoot near the end
        // (avoids the rubbery oscillation of a low-damping spring).
        const easeOut = (t) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
        const easeOutBack = (t) => {
            t = Math.max(0, Math.min(1, t));
            const c1 = 1.32, c3 = c1 + 1;
            return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        };

        const revealFrames = Math.max(8, Math.round(fps * 0.55));
        const staggerFrames = Math.max(3, Math.round(fps * 0.075));

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);
        const cy = 1080 / 2;
        const startY = cy - totalHeight / 2 + rowHeight / 2;

        // Per-variant entry kinematics — returns { sx, sy, scale, alpha, blur }
        const motionFor = (entryIdx, ri, ci) => {
            const local = Math.max(0, frame - entryIdx * staggerFrames);
            const t = Math.min(1, local / revealFrames);
            const easedAlpha = easeOut(t);
            const easedPos = easeOutBack(t);

            let sx = 0, sy = 0, scale = 1, blur = 0, rot = 0, jitterAmp = 0;

            if (animation === 'fadeIn') {
                scale = interpolate(easedPos, [0, 1], [0.92, 1]);
                blur = interpolate(t, [0, 0.6], [4, 0], { extrapolateRight: 'clamp' });
            } else if (animation === 'slideUp') {
                sy = interpolate(easedPos, [0, 1], [60, 0]);
                scale = interpolate(easedPos, [0, 1], [0.96, 1]);
                blur = interpolate(t, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });
            } else {
                // springStagger (default): subtle scale-down from above + fade
                scale = interpolate(easedPos, [0, 1], [1.18, 1]);
                blur = interpolate(t, [0, 0.5], [4, 0], { extrapolateRight: 'clamp' });
            }

            // Variant-specific entry overrides (additive on top of animation)
            if (variant === 'rise') {
                sy = interpolate(easedPos, [0, 1], [80, 0]);
                blur = Math.max(blur, interpolate(t, [0, 0.55], [5, 0], { extrapolateRight: 'clamp' }));
            } else if (variant === 'cascade') {
                sx = interpolate(easedPos, [0, 1], [-120 + ci * 8, 0]);
                sy = interpolate(easedPos, [0, 1], [-30 - ri * 6, 0]);
            } else if (variant === 'punch') {
                scale = interpolate(easedPos, [0, 1], [1.6, 1]);
                blur = interpolate(t, [0, 0.45], [6, 0], { extrapolateRight: 'clamp' });
            } else if (variant === 'stamp') {
                // Ink-stamp slam: rotate-overshoot + scale-down impact
                scale = interpolate(easedPos, [0, 1], [1.45, 1]);
                rot = interpolate(easedPos, [0, 1], [-0.18, 0]);
                blur = interpolate(t, [0, 0.4], [5, 0], { extrapolateRight: 'clamp' });
            } else if (variant === 'wave') {
                // Sin-curve Y offset across words — they ride in like a wave
                const phase = (ci + ri * 2) * 0.6;
                sy = interpolate(easedPos, [0, 1], [60 + Math.sin(phase) * 30, 0]);
                sx = interpolate(easedPos, [0, 1], [Math.cos(phase) * 12, 0]);
            } else if (variant === 'pop') {
                // Bouncy scale per word with strong overshoot
                scale = interpolate(easedPos, [0, 1], [0.35, 1]);
                sy = interpolate(easedPos, [0, 1], [12, 0]);
            }

            // Idle micro-float on long-running scenes (very gentle, no flicker)
            const idle = Math.sin((frame / fps + entryIdx * 0.17) * 2.0) * 1.5;
            sy += idle * easedAlpha;

            // Glitch variant — hard frame-stepped reveal + chromatic aberration.
            // Overrides smooth values above with digital-corruption motion.
            if (variant === 'glitch') {
                const stepFrames = 3;                          // change every 3 frames
                const stepIdx   = Math.floor(local / stepFrames);
                const totalSteps = Math.max(1, Math.ceil(revealFrames / stepFrames));
                const stepT     = Math.min(1, stepIdx / totalSteps);

                const seed = (entryIdx * 9301 + stepIdx * 49297) >>> 0;
                const r1 = (((seed * 1103515245 + 12345) >>> 0) % 100000) / 100000;
                const r2 = (((seed * 1664525   +  1013904223) >>> 0) % 100000) / 100000;
                const r3 = (((seed * 22695477  +  1) >>> 0) % 100000) / 100000;

                const jitter = interpolate(stepT, [0, 0.75], [18, 0], { extrapolateRight: 'clamp' });
                const baseSx = (r1 - 0.5) * jitter * 2;
                const baseSy = (r2 - 0.5) * jitter;

                // 1-in-8 chance of a hard horizontal slice cut during entry
                const sliceChance = (stepT < 0.7 && r3 > 0.875) ? 1 : 0;
                const sliceShift  = sliceChance ? (r2 - 0.5) * 80 : 0;

                const chromaAmount = interpolate(stepT, [0, 0.9], [1, 0], { extrapolateRight: 'clamp' });

                return {
                    sx: baseSx + sliceShift,
                    sy: baseSy,
                    scale: 1 + (r3 - 0.5) * 0.05,
                    alpha: stepT,                              // hard stepped reveal
                    blur: 0,
                    rot: (r3 - 0.5) * 0.035,
                    chroma: chromaAmount,
                };
            }

            return { sx, sy, scale, alpha: easedAlpha, blur, rot };
        };

        // Exit fade (smooth)
        const exitAlpha = isExiting ? Math.pow(exitProgress, 1.2) : 1;

        rows.forEach((row, ri) => {
            let rx = 1920 / 2 - row.width / 2;

            row.entries.forEach((entry, ci) => {
                const m = motionFor(entry.index, ri, ci);
                if (m.alpha <= 0.001) { rx += entry.width + gap; return; }

                ctx.save();
                const baseAlpha = Math.min(1, opacity) * m.alpha * exitAlpha;
                ctx.globalAlpha = baseAlpha;
                ctx.translate(rx + entry.width / 2 + m.sx, startY + ri * rowHeight + m.sy);
                if (m.rot) ctx.rotate(m.rot);
                if (m.scale !== 1) ctx.scale(m.scale, m.scale);
                if (m.blur > 0.4) ctx.filter = `blur(${m.blur.toFixed(1)}px)`;

                // Glitch chromatic-aberration: red + cyan offset copies under main fill
                if (m.chroma > 0.01) {
                    const cx = m.chroma * 16;
                    const cy = m.chroma * 3;
                    const prevComp = ctx.globalCompositeOperation;
                    ctx.globalCompositeOperation = 'lighter';

                    ctx.save();
                    ctx.translate(-cx, -cy);
                    ctx.globalAlpha = baseAlpha * 0.85;
                    this._drawKineticWordTinted(ctx, entry.word, 'rgb(255,40,80)', fontSize, fontFamily, ks.weight);
                    ctx.restore();

                    ctx.save();
                    ctx.translate(cx, cy);
                    ctx.globalAlpha = baseAlpha * 0.85;
                    this._drawKineticWordTinted(ctx, entry.word, 'rgb(40,220,255)', fontSize, fontFamily, ks.weight);
                    ctx.restore();

                    ctx.globalCompositeOperation = prevComp;
                    ctx.globalAlpha = baseAlpha;
                }

                this._drawKineticWord(ctx, entry.word, ks, fontSize, fontFamily);

                ctx.restore();
                rx += entry.width + gap;
            });
        });

        if (hasAttr) {
            const attrDelayFrames = Math.round(revealFrames * 0.35 + Math.max(0, layout.words.length - 1) * staggerFrames);
            const attrProgress = Math.max(0, Math.min(1, (frame - attrDelayFrames) / Math.max(6, Math.round(fps * 0.24))));
            const attrAlpha = easeOut(attrProgress) * exitAlpha;
            if (attrAlpha > 0.001) {
                const attrText = `\u2014 ${mg.subtext}`;
                const attrY = startY + textHeight - rowHeight / 2 + attrMargin + attrFontSize * 0.6;
                ctx.save();
                ctx.globalAlpha = Math.min(1, opacity) * attrAlpha;
                ctx.translate(1920 / 2, attrY + (1 - attrProgress) * 12);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.8)';
                ctx.shadowColor = 'rgba(0,0,0,0.7)';
                ctx.shadowBlur = 18;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 2;
                ctx.font = `italic 600 ${attrFontSize}px ${s.fontBody || fontFamily}`;
                ctx.fillText(attrText, 0, 0);
                ctx.restore();
            }
        }

        ctx.restore();
    }

    // Solid-fill tinted copy used by the glitch variant for RGB-split passes.
    // No shadow, no outline — just the silhouette in a single channel color.
    _drawKineticWordTinted(ctx, word, fillColor, fontSize, fontFamily, weight) {
        MGRenderer._setFont(ctx, weight || '700', fontSize, fontFamily);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = fillColor;
        ctx.fillText(word, 0, 0);
    }

    _drawKineticWord(ctx, word, ks, fontSize, fontFamily) {
        MGRenderer._setFont(ctx, ks.weight, fontSize, fontFamily);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Pick the ONE shadow this style uses (glow XOR dropShadow, see _KINETIC_TEXT_STYLES)
        const shadow = (ks.glow && ks.glowSize > 0)
            ? { color: ks.glow, blur: ks.glowSize, y: 0 }
            : ks.dropShadow
                ? { color: ks.dropShadow, blur: ks.dropShadowBlur, y: ks.dropShadowY || 0 }
                : null;

        // Strategy:
        //   1) If there's an outline, stroke it WITH the shadow attached. Shadow attaches
        //      to the outline shape (which is wider than the fill), so the halo/drop
        //      extends cleanly out from the outer silhouette instead of being re-drawn
        //      on top of a previous pass.
        //   2) Reset shadow, draw the crisp fill on top. No double-draw, no bumpy edges.
        //   3) If there's NO outline, attach the shadow directly to the single fill.

        const hasOutline = !!(ks.outline && ks.outlineWidth > 0);

        if (hasOutline) {
            if (shadow) {
                ctx.shadowColor = shadow.color;
                ctx.shadowBlur = shadow.blur;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = shadow.y;
            }
            ctx.lineWidth = ks.outlineWidth;
            ctx.strokeStyle = ks.outline;
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.strokeText(word, 0, 0);

            // Clear shadow so the fill is crisp
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            ctx.fillStyle = ks.text;
            ctx.fillText(word, 0, 0);
        } else {
            if (shadow) {
                ctx.shadowColor = shadow.color;
                ctx.shadowBlur = shadow.blur;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = shadow.y;
            }
            ctx.fillStyle = ks.text;
            ctx.fillText(word, 0, 0);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        }
    }

    // ========================================================================
    // 14. SUBSCRIBE CTA
    // ========================================================================

    _renderSubscribeCTA(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { totalFrames, opacity } = anim;

        const progress = frame / totalFrames;
        const pulseScale = Math.sin(progress * Math.PI * 4 * 2) * 0.05 + 1;
        const fadeIn = interpolate(frame, [0, Math.round(0.3 * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const fadeOut = interpolate(frame, [totalFrames - Math.round(0.4 * fps), totalFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const alpha = Math.min(fadeIn, fadeOut);

        ctx.save();
        ctx.globalAlpha = Math.min(1, alpha);

        const text = mg.text || 'Subscribe';
        MGRenderer._setFont(ctx, 'bold', 28, s.fontHeading);
        const textW = ctx.measureText(text).width;
        const pillW = textW + 100;
        const pillH = 60;

        const pos = MGRenderer._getPosXY(mg.position || 'bottom-right', pillW, pillH);
        const cx = pos.x + pillW / 2;
        const cy = pos.y + pillH / 2;

        ctx.translate(cx, cy);
        ctx.scale(pulseScale, pulseScale);

        MGRenderer._roundRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, 30);
        const grad = ctx.createLinearGradient(-pillW / 2, 0, pillW / 2, 0);
        grad.addColorStop(0, s.primary);
        grad.addColorStop(1, s.accent);
        ctx.fillStyle = grad;
        if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 20; }
        else { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 12; }
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._setFont(ctx, 'normal', 32, 'Segoe UI Emoji, Arial');
        ctx.fillText('\uD83D\uDD14', -pillW / 2 + 36, 1);
        MGRenderer._setFont(ctx, 'bold', 28, s.fontHeading);
        ctx.fillText(text, 18, 0);

        ctx.restore();
    }

    // ========================================================================
    // 15. MAP CHART
    // ========================================================================

    _renderMapChart(ctx, frame, fps, mg, s, anim, scriptContext) {
        // ── Slice 6B: MapScene.renderAssets is the single source of truth ──
        // The old hydration bridge + mg._map* side-channel fallbacks are gone.
        // If _mapScene / renderAssets is missing we log once and render the
        // fallback-bg path (never crash). Build pipeline is responsible for
        // attaching the MapScene before render.
        const { ms: _mapScene, ra: _ra } = this._resolveMapData(mg);

        if (!_ra) {
            if (!this._mapRaMissingLogged) this._mapRaMissingLogged = new Set();
            const _missingKey = `scene${_mapScene?.sceneIndex ?? mg.sceneIndex ?? '?'}`;
            if (!this._mapRaMissingLogged.has(_missingKey)) {
                this._mapRaMissingLogged.add(_missingKey);
                console.error(`[MGRenderer] map scene=${_mapScene?.sceneIndex ?? mg.sceneIndex ?? '?'} MISSING _mapScene.renderAssets — rendering fallback bg. Build pipeline did not populate MapScene.`);
            }
            const { opacity: _opFb, enterProgress: _epFb } = anim;
            // pal arg is unused inside _renderMapChartFallbackBg (it reads mg.mapStyle directly).
            this._renderMapChartFallbackBg(ctx, mg, 1920, 1080, _opFb, _epFb, null);
            return;
        }

        // ── Read surface: all map data comes from renderAssets. User-tunable UI
        // keyframes (mg._mapZoomSpeed, mg._mapPanXStart, etc.) are NOT MapScene
        // data and continue to read from mg directly.
        const _mapImageFile              = _ra.mapImageFile || null;
        const _mapView                   = _ra.mapView      || null;
        const _mapPins                   = (_ra.mapView && _ra.mapView.pins) || [];
        const _bigMapSize                = _ra.bigMapSize   || null;
        const _mapWaypoints              = _ra.waypoints    || null;
        const _wpCoords                  = _ra.wpCoords     || [];
        const _mapSwarms                 = _ra.swarms       || null;
        const _mapRoutePath              = !!_ra.routePath;
        const _mapRouteGeometry          = _ra.routeGeometry || null;
        const _mapAlternateRouteGeometry = _ra.alternateRouteGeometry || null;
        const _osmBoundaries             = _ra.osmBoundaries || null;
        const { opacity, enterProgress } = anim;
        const W = 1920, H = 1080;
        const elapsed = frame / fps;
        const speed = mg._animationSpeed || 1;
        const totalDuration = (mg._durationFrames || (fps * 5)) / fps;
        const zoomSpd = mg._mapZoomSpeed || 1;
        const polySpd = mg._mapPolySpeed || 1;
        const easingMode = mg._mapEasing || 'cubic';

        // Easing functions
        const _ease = (t, mode) => {
            t = Math.min(1, Math.max(0, t));
            switch (mode) {
                case 'elastic': { const c4 = (2 * Math.PI) / 3; return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1; }
                case 'expo':    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
                case 'linear':  return t;
                default:        return 1 - Math.pow(1 - t, 3); // cubic
            }
        };

        // ── Overlay color palettes per map style ──
        const OVERLAY_STYLES = {
            dark: {
                pin: '#00d4ff', pinGlow: 'rgba(0,212,255,0.35)', pinRing: 'rgba(0,212,255,0.5)',
                label: '#ffffff', labelBg: 'rgba(8,18,35,0.92)',
                route: 'rgba(0,212,255,0.6)', routeGlow: 'rgba(0,212,255,0.18)',
                titleBg: 'rgba(8,18,35,0.88)', titleBorder: '#00d4ff', titleText: '#ffffff',
                vignette: 'rgba(0,0,0,0.35)', dataCard: 'rgba(10,22,45,0.9)',
                rankBadge: '#00d4ff', rankText: '#0b1426',
                highlight: 'rgba(0,212,255,0.12)', highlightRing: 'rgba(0,212,255,0.3)',
            },
            natural: {
                pin: '#f0c040', pinGlow: 'rgba(240,192,64,0.35)', pinRing: 'rgba(240,192,64,0.5)',
                label: '#ffffff', labelBg: 'rgba(12,28,18,0.9)',
                route: 'rgba(240,192,64,0.6)', routeGlow: 'rgba(240,192,64,0.18)',
                titleBg: 'rgba(12,28,18,0.88)', titleBorder: '#90d070', titleText: '#ffffff',
                vignette: 'rgba(0,15,5,0.3)', dataCard: 'rgba(15,35,22,0.9)',
                rankBadge: '#f0c040', rankText: '#12301a',
                highlight: 'rgba(240,192,64,0.1)', highlightRing: 'rgba(240,192,64,0.25)',
            },
            satellite: {
                pin: '#00ffaa', pinGlow: 'rgba(0,255,170,0.35)', pinRing: 'rgba(0,255,170,0.5)',
                label: '#e0f0e8', labelBg: 'rgba(3,8,12,0.92)',
                route: 'rgba(0,255,170,0.55)', routeGlow: 'rgba(0,255,170,0.15)',
                titleBg: 'rgba(3,8,12,0.9)', titleBorder: '#00ffaa', titleText: '#e0f0e8',
                vignette: 'rgba(0,0,0,0.45)', dataCard: 'rgba(5,12,18,0.9)',
                rankBadge: '#00ffaa', rankText: '#030a14',
                highlight: 'rgba(0,255,170,0.1)', highlightRing: 'rgba(0,255,170,0.25)',
            },
            light: {
                pin: '#d04030', pinGlow: 'rgba(208,64,48,0.3)', pinRing: 'rgba(208,64,48,0.45)',
                label: '#1a2a3a', labelBg: 'rgba(255,255,255,0.95)',
                route: 'rgba(208,64,48,0.5)', routeGlow: 'rgba(208,64,48,0.15)',
                titleBg: 'rgba(255,255,255,0.92)', titleBorder: '#2060a0', titleText: '#1a2a3a',
                vignette: 'rgba(100,120,140,0.12)', dataCard: 'rgba(255,255,255,0.94)',
                rankBadge: '#2060a0', rankText: '#ffffff',
                highlight: 'rgba(208,64,48,0.08)', highlightRing: 'rgba(208,64,48,0.2)',
            },
            political: {
                pin: '#b83020', pinGlow: 'rgba(184,48,32,0.35)', pinRing: 'rgba(184,48,32,0.5)',
                label: '#1c1008', labelBg: 'rgba(240,228,208,0.94)',
                route: 'rgba(184,48,32,0.55)', routeGlow: 'rgba(184,48,32,0.15)',
                titleBg: 'rgba(240,228,208,0.92)', titleBorder: '#8b4513', titleText: '#1c1008',
                vignette: 'rgba(60,40,20,0.18)', dataCard: 'rgba(240,228,208,0.92)',
                rankBadge: '#8b4513', rankText: '#f0e8d0',
                highlight: 'rgba(184,48,32,0.08)', highlightRing: 'rgba(184,48,32,0.2)',
            },
        };
        const pal = OVERLAY_STYLES[mg.mapStyle || 'dark'] || OVERLAY_STYLES.dark;

        // ── Polygon color palettes ──
        const POLY_COLORS = {
            dark:      { fill: '#00d4ff', fillEdge: '#0088cc', stroke: '#00d4ff', glow: 'rgba(0,212,255,0.6)' },
            natural:   { fill: '#f0c040', fillEdge: '#c09020', stroke: '#d0a830', glow: 'rgba(240,192,64,0.5)' },
            satellite: { fill: '#00ffaa', fillEdge: '#009966', stroke: '#00ffaa', glow: 'rgba(0,255,170,0.5)' },
            light:     { fill: '#d04030', fillEdge: '#a02820', stroke: '#c03828', glow: 'rgba(208,64,48,0.5)' },
            political: { fill: '#b83020', fillEdge: '#801810', stroke: '#a02818', glow: 'rgba(184,48,32,0.5)' },
        };
        const POLY_COLOR_OVERRIDES = {
            cyan:    { fill: '#00d4ff', fillEdge: '#0088cc', stroke: '#00d4ff', glow: 'rgba(0,212,255,0.6)' },
            red:     { fill: '#ff3030', fillEdge: '#cc1818', stroke: '#ff3030', glow: 'rgba(255,48,48,0.6)' },
            green:   { fill: '#30ff60', fillEdge: '#18cc40', stroke: '#30ff60', glow: 'rgba(48,255,96,0.6)' },
            gold:    { fill: '#f0c040', fillEdge: '#c09020', stroke: '#f0c040', glow: 'rgba(240,192,64,0.6)' },
            magenta: { fill: '#ff40ff', fillEdge: '#cc20cc', stroke: '#ff40ff', glow: 'rgba(255,64,255,0.6)' },
            orange:  { fill: '#ff8020', fillEdge: '#cc6010', stroke: '#ff8020', glow: 'rgba(255,128,32,0.6)' },
            white:   { fill: '#ffffff', fillEdge: '#bbbbbb', stroke: '#ffffff', glow: 'rgba(255,255,255,0.5)' },
            blue:    { fill: '#4080ff', fillEdge: '#2050cc', stroke: '#4080ff', glow: 'rgba(64,128,255,0.6)' },
        };
        const polyColorKey = mg._mapPolyColor || 'auto';
        let polyPal = (polyColorKey !== 'auto' && POLY_COLOR_OVERRIDES[polyColorKey])
            ? POLY_COLOR_OVERRIDES[polyColorKey]
            : (POLY_COLORS[mg.mapStyle || 'dark'] || POLY_COLORS.dark);

        // ── Map Style Pack overrides (neon=no-op, invasions/editorial/geopolitical override slots) ──
        // Pack id resolved at build time via ai-motion-graphics → renderAssets.stylePackId.
        // Registry lives in src/map-style-packs.js (also exposed as window.MAP_STYLE_PACKS).
        let stylePack = null;
        try {
            const packId = (_ra && _ra.stylePackId) || mg.mapStylePack || null;
            const registry = (typeof window !== 'undefined' && window.MAP_STYLE_PACKS) ? window.MAP_STYLE_PACKS : null;
            if (packId && packId !== 'neon' && registry && registry.PACKS && registry.PACKS[packId]) {
                stylePack = registry.PACKS[packId];
            }
        } catch (_) { /* noop */ }
        let stylePackBasemap = null;
        if (stylePack) {
            // Polygon: only override when user hasn't forced a specific color
            if (polyColorKey === 'auto' && stylePack.polygon && Object.keys(stylePack.polygon).length) {
                const pp = stylePack.polygon;
                polyPal = {
                    fill:     pp.fill     || polyPal.fill,
                    fillEdge: pp.fillEdge || polyPal.fillEdge,
                    stroke:   pp.stroke   || polyPal.stroke,
                    glow:     pp.glow     || polyPal.glow,
                };
            }
            // Route / pin / label / title slot overrides — merge onto pal
            if (stylePack.route) {
                if (stylePack.route.color)     pal.route     = stylePack.route.color;
                if (stylePack.route.glowColor) pal.routeGlow = stylePack.route.glowColor;
            }
            if (stylePack.pin) {
                if (stylePack.pin.color)     pal.pin     = stylePack.pin.color;
                if (stylePack.pin.glowColor) pal.pinGlow = stylePack.pin.glowColor;
                if (stylePack.pin.ringColor) pal.pinRing = stylePack.pin.ringColor;
            }
            if (stylePack.label) {
                if (stylePack.label.bg) pal.labelBg = stylePack.label.bg;
                if (stylePack.label.fg) pal.label   = stylePack.label.fg;
            }
            if (stylePack.title) {
                if (stylePack.title.bg)     pal.titleBg     = stylePack.title.bg;
                if (stylePack.title.border) pal.titleBorder = stylePack.title.border;
                if (stylePack.title.text)   pal.titleText   = stylePack.title.text;
            }
            if (stylePack.basemap && (stylePack.basemap.desaturate || stylePack.basemap.darken || stylePack.basemap.contrast)) {
                stylePackBasemap = stylePack.basemap;
            }
        }

        // ── Country coordinates (lon, lat) fallback for pin placement ──
        const MAP_COORDS = {
            'China': [104, 35], 'United States': [-98, 39], 'USA': [-98, 39], 'US': [-98, 39],
            'India': [78, 22], 'Japan': [138, 36], 'Germany': [10.5, 51.2],
            'United Kingdom': [-2, 54], 'UK': [-2, 54], 'France': [2.2, 46.2],
            'Brazil': [-51, -10], 'Italy': [12.5, 42.5], 'Canada': [-106, 56],
            'Russia': [100, 60], 'South Korea': [128, 36], 'Australia': [134, -25],
            'Spain': [-3.7, 40.4], 'Mexico': [-102, 23], 'Indonesia': [118, -2],
            'Norway': [9, 62], 'Turkey': [35, 39], 'Saudi Arabia': [45, 24],
            'South Africa': [25, -29], 'Argentina': [-64, -34], 'Nigeria': [8, 10],
            'Egypt': [30, 27], 'Thailand': [101, 15], 'Vietnam': [108, 16],
            'Taiwan': [121, 24], 'Pakistan': [70, 30], 'Philippines': [122, 13],
            'Iran': [53, 32], 'Iraq': [44, 33], 'Israel': [35, 31.5],
            'Ukraine': [32, 49], 'Poland': [20, 52], 'Sweden': [16, 62],
            'Singapore': [104, 1.3], 'Malaysia': [102, 4], 'Colombia': [-74, 4],
            'Chile': [-71, -33], 'Peru': [-76, -10], 'Venezuela': [-66, 8],
            'Algeria': [3, 28], 'Libya': [18, 27], 'Morocco': [-6, 32],
            'Kenya': [38, 0], 'Ethiopia': [39, 9], 'Tanzania': [35, -6],
            'Congo': [25, -3], 'Angola': [18, -12], 'Ghana': [-1.5, 8],
            'Afghanistan': [66, 34], 'Bangladesh': [90, 24],
            'North Korea': [127, 40], 'Myanmar': [96, 20],
            'New Zealand': [174, -41], 'Finland': [26, 64],
            'Greece': [22, 39], 'Portugal': [-8, 39.5],
            'Netherlands': [5, 52], 'Belgium': [4.4, 50.8],
            'Switzerland': [8.2, 46.8], 'Austria': [14.5, 47.5],
            'Czech Republic': [15.5, 49.8], 'Romania': [25, 46],
            'Hungary': [19, 47], 'Denmark': [10, 56],
            'Cuba': [-79, 22], 'Jamaica': [-77, 18],
            'Qatar': [51, 25.3], 'UAE': [54, 24], 'Kuwait': [48, 29.5],
            'Oman': [57, 21], 'Yemen': [48, 15.5], 'Jordan': [36, 31],
            'Lebanon': [35.8, 33.9], 'Syria': [38, 35],
        };

        // ── Determine map view (center + zoom) ──
        const cinematicMode = mg._mapCinematic || false;
        const sceneVariant = _mapScene?.mapMode === 'region' ? 'regionHighlight' : _mapScene?.mapMode;
        const variant = mg.subType || mg.mapVariant || sceneVariant || 'standard';
        const multiPin = _mapPins.length >= 2;

        // ── Keyframe time (shared by tilt + zoom) ──
        const kfT = Math.min(1, elapsed / totalDuration);
        const kfEased = _ease(kfT, easingMode);

        // ── Projection: single map for everything (big map for waypoints) ──
        const bigMapSize = _bigMapSize;
        const IMG_W = bigMapSize ? bigMapSize.w : W;
        const IMG_H = bigMapSize ? bigMapSize.h : H;
        const mapView = _mapView;

        let toX, toY;
        if (mapView) {
            const TILE_SZ = 512;
            const z = Math.max(2, Math.floor(mapView.zoom));
            const n = Math.pow(2, z);
            const cTileX = ((mapView.lon + 180) / 360) * n;
            const cLatRad = mapView.lat * Math.PI / 180;
            const cTileY = (1 - Math.log(Math.tan(cLatRad) + 1 / Math.cos(cLatRad)) / Math.PI) / 2 * n;
            const originPx = cTileX * TILE_SZ - IMG_W / 2;
            const originPy = cTileY * TILE_SZ - IMG_H / 2;
            toX = (lon) => ((lon + 180) / 360) * n * TILE_SZ - originPx;
            toY = (lat) => { const latR = lat * Math.PI / 180; return (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n * TILE_SZ - originPy; };
        } else {
            toX = (lon) => ((lon + 180) / 360) * W * 0.88 + W * 0.06;
            toY = (lat) => ((90 - lat) / 180) * H * 0.82 + H * 0.06;
        }

        // ═══ WAYPOINT SYSTEM ═══
        // Renamed locals below preserve the original read sites unchanged.
        let _waypoints = _mapWaypoints;
        const _wpPins    = _mapPins;
        let _stopsDrivenCamera = false;

        // Slice 5b: when the provider attached a populated cameraPlan.stops
        // array to _mapScene, feed those stops in as the waypoint source.
        // Stops carry the same per-subject camera intent (lon/lat/zoom/tilt/
        // bearing/orbit/startTime/endTime) but come from the authoritative
        // provider pipeline with coords already geocoded. The build-time
        // USE_CAMERA_PLAN_STOPS flag is the single source of truth — it
        // gates whether stops get written into video-plan.json at build
        // time. At render time we don't re-check process.env (Electron
        // renderer process doesn't have Node env populated); the presence
        // of a valid stops array IS the signal. Stops missing/null/invalid
        // → _waypoints stays pointed at the legacy _mapWaypoints and the
        // bbox-fit fallback runs as before.
        try {
            const _stops = (_mapScene && _mapScene.cameraPlan && Array.isArray(_mapScene.cameraPlan.stops))
                ? _mapScene.cameraPlan.stops : null;
            if (_stops && _stops.length > 0) {
                const _wpsFromStops = _stops
                    .filter(st => st
                        && Number.isFinite(st.lon) && Number.isFinite(st.lat)
                        && Number.isFinite(st.zoom) && st.zoom > 0
                        && Number.isFinite(st.startTime) && Number.isFinite(st.endTime)
                        && st.endTime > st.startTime)
                    .map(st => ({
                        name: st.label || st.subjectId || '',
                        lon: st.lon,
                        lat: st.lat,
                        zoom: st.zoom,
                        tilt: (st.tilt != null && Number.isFinite(st.tilt)) ? st.tilt : null,
                        bearing: (st.bearing != null && Number.isFinite(st.bearing)) ? st.bearing : null,
                        orbit: (st.orbit != null && Number.isFinite(st.orbit)) ? st.orbit : null,
                        startTime: st.startTime,
                        endTime: st.endTime,
                        icon: null,
                    }));
                if (!this._stopsLogged) this._stopsLogged = new Set();
                const _sceneKey = `scene${_mapScene.sceneIndex ?? mg.sceneIndex ?? '?'}`;
                if (_wpsFromStops.length > 0) {
                    _waypoints = _wpsFromStops;
                    _stopsDrivenCamera = true;
                    // Dedupe by compiler-set sceneIndex on _mapScene, not mg.sceneIndex
                    // — mg.sceneIndex is preview-undefined, which collapses every map
                    // scene into a single `scene?` key and suppresses subsequent logs.
                    if (!this._stopsLogged.has(_sceneKey)) {
                        this._stopsLogged.add(_sceneKey);
                        console.log(`[MGRenderer] map scene=${_mapScene.sceneIndex ?? mg.sceneIndex ?? '?'} using cameraPlan.stops (${_wpsFromStops.length} stops, mode=${_mapScene.mapMode || '?'})`);
                    }
                } else {
                    // Stops array was present but every entry failed validation.
                    // Log once so Slice 6 cleanup can spot silent rejections.
                    const _rejectKey = `reject-${_sceneKey}`;
                    if (!this._stopsLogged.has(_rejectKey)) {
                        this._stopsLogged.add(_rejectKey);
                        console.log(`[MGRenderer] map scene=${_mapScene.sceneIndex ?? mg.sceneIndex ?? '?'} cameraPlan.stops REJECTED (${_stops.length} raw stops, 0 passed validation) — falling back to legacy bbox-fit`);
                    }
                }
            } else if (_mapScene && _mapScene.cameraPlan && _mapScene.cameraPlan.stops === null) {
                // Provider explicitly set stops=null (e.g. establish-collapse failed).
                // Not an error — legacy path was always the intended fallback — but log
                // once per scene so Slice 6 cleanup can confirm every map scene's path.
                if (!this._stopsLogged) this._stopsLogged = new Set();
                const _sceneKey = `scene${_mapScene.sceneIndex ?? mg.sceneIndex ?? '?'}`;
                const _nullKey = `null-${_sceneKey}`;
                if (!this._stopsLogged.has(_nullKey)) {
                    this._stopsLogged.add(_nullKey);
                    console.log(`[MGRenderer] map scene=${_mapScene.sceneIndex ?? mg.sceneIndex ?? '?'} cameraPlan.stops=null (provider opted out) — using legacy bbox-fit (mode=${_mapScene.mapMode || '?'})`);
                }
            }
        } catch (err) {
            // Log so we know if a render-time exception silently downgraded to legacy.
            console.log(`[MGRenderer] map scene=${_mapScene?.sceneIndex ?? mg.sceneIndex ?? '?'} cameraPlan.stops threw: ${err?.message || err} — falling back to legacy bbox-fit`);
        }

        // ── Slice 6A: one-shot per-scene summary log ──
        // Confirms for every fullscreen map scene: did renderAssets exist, did stops
        // drive the camera, raw stop count, compiler mode, and whether the legacy
        // side-channel fallback path was used. Deduped by sceneIndex so replay doesn't
        // flood the log. Only emitted for fullscreen map MGs (subType === 'mapChart').
        try {
            if (!this._mapSceneSummaryLogged) this._mapSceneSummaryLogged = new Set();
            const _summaryIdx = _mapScene?.sceneIndex ?? mg.sceneIndex ?? null;
            const _summaryKey = `summary-scene${_summaryIdx ?? '?'}`;
            if (_summaryIdx != null && !this._mapSceneSummaryLogged.has(_summaryKey)) {
                this._mapSceneSummaryLogged.add(_summaryKey);
                const _rawStopCount = Array.isArray(_mapScene?.cameraPlan?.stops)
                    ? _mapScene.cameraPlan.stops.length : 0;
                const _usedRA = !!_ra;
                const _fellBack = !_ra;
                console.log(`[MGRenderer] map scene=${_summaryIdx} summary: usedRenderAssets=${_usedRA} usedStops=${_stopsDrivenCamera} stopCount=${_rawStopCount} mode=${_mapScene?.mapMode || '?'} fellBackToSideChannel=${_fellBack}`);
            }
        } catch (_summaryErr) { /* never let logging break render */ }

        // `_wpCoords` is already resolved at the top — no redeclaration.
        let activeWpIdx = -1, wpTransition = 0, wpCamX = IMG_W / 2, wpCamY = IMG_H / 2;
        let prevWpIdx = -1;

        const hasWaypoints = _waypoints && _waypoints.length > 0;
        const wpPositions = [];
        if (hasWaypoints) {
            for (const wp of _waypoints) {
                // Explicit coordinates (set by the planner for synthetic overview framing) win.
                if (typeof wp.lon === 'number' && typeof wp.lat === 'number') {
                    wpPositions.push({ ...wp, px: toX(wp.lon), py: toY(wp.lat) });
                    continue;
                }
                const wpLower = wp.name.toLowerCase();
                let coord = _wpCoords.find(c => c.name.toLowerCase() === wpLower);
                if (!coord) {
                    let pin = _wpPins.find(p => p.name.toLowerCase() === wpLower);
                    if (!pin) pin = _wpPins.find(p => p.name.toLowerCase().includes(wpLower) || wpLower.includes(p.name.toLowerCase()));
                    if (pin) coord = { lon: pin.lon, lat: pin.lat };
                }
                if (coord) {
                    wpPositions.push({ ...wp, lon: coord.lon, lat: coord.lat, px: toX(coord.lon), py: toY(coord.lat) });
                } else {
                    // Phase C: DROP unresolved waypoints. Silently recentering them
                    // to IMG_W/2, IMG_H/2 hid bad planner/geocoder output behind a
                    // camera re-aim — same class of bug the pin path already kills
                    // by returning null at the fallback site. Downstream gates all
                    // read `wpPositions.length > 0`, so a fully dropped set falls
                    // through to the standard camera path cleanly.
                    if (!this._mapDropWarned) this._mapDropWarned = new Set();
                    const _dropKey = `${mg.sceneIndex ?? 'noidx'}:${wp.name}`;
                    if (!this._mapDropWarned.has(_dropKey)) {
                        this._mapDropWarned.add(_dropKey);
                        console.warn(`[MGRenderer] Dropping unresolved waypoint: "${wp.name}" (scene ${mg.sceneIndex ?? '?'})`);
                    }
                }
            }

            if (wpPositions.length > 0) {
                for (let wi = wpPositions.length - 1; wi >= 0; wi--) {
                    if (elapsed >= wpPositions[wi].startTime) { activeWpIdx = wi; break; }
                }
                if (activeWpIdx < 0) activeWpIdx = 0;
                prevWpIdx = activeWpIdx > 0 ? activeWpIdx - 1 : -1;

                const awp = wpPositions[activeWpIdx];
                const wpElapsed = elapsed - awp.startTime;
                const transitionDur = 1.2 / zoomSpd;
                wpTransition = Math.min(1, wpElapsed / transitionDur);
                const wpEase = _ease(wpTransition, easingMode);

                if (prevWpIdx >= 0 && wpTransition < 1) {
                    const prev = wpPositions[prevWpIdx];
                    wpCamX = prev.px + (awp.px - prev.px) * wpEase;
                    wpCamY = prev.py + (awp.py - prev.py) * wpEase;
                } else {
                    wpCamX = awp.px;
                    wpCamY = awp.py;
                }
            }
        }
        const routeHeldWideFromStops = !!(
            _stopsDrivenCamera
            && _mapScene?.mapMode === 'route'
            && String(_mapScene?.cameraPlan?.framing || '').toLowerCase() === 'held-wide'
            && wpPositions.length >= 2
        );

        // ── Route geometry (decoupled from camera stops) ──
        // Long-route scenes use a single authored corridor camera stop, so
        // wpPositions collapses to 1 and the legacy route-line draw below can't
        // render. _mapRouteGeometry carries the full [{name,lon,lat,startTime,
        // endTime}] sequence so the dashed path stays animated through every
        // original waypoint regardless of how many camera stops we plan.
        const routePathPositions = [];
        if (Array.isArray(_mapRouteGeometry) && _mapRouteGeometry.length >= 2) {
            for (const g of _mapRouteGeometry) {
                if (!g || typeof g.lon !== 'number' || typeof g.lat !== 'number') continue;
                if (!Number.isFinite(g.startTime) || !Number.isFinite(g.endTime)) continue;
                routePathPositions.push({
                    name: g.name || '',
                    lon: g.lon,
                    lat: g.lat,
                    px: toX(g.lon),
                    py: toY(g.lat),
                    startTime: g.startTime,
                    endTime: g.endTime,
                });
            }
        }
        const alternateRoutePathPositions = [];
        if (Array.isArray(_mapAlternateRouteGeometry) && _mapAlternateRouteGeometry.length >= 2) {
            for (const g of _mapAlternateRouteGeometry) {
                if (!g || typeof g.lon !== 'number' || typeof g.lat !== 'number') continue;
                alternateRoutePathPositions.push({
                    name: g.name || '',
                    lon: g.lon,
                    lat: g.lat,
                    px: toX(g.lon),
                    py: toY(g.lat),
                    startTime: Number.isFinite(g.startTime) ? g.startTime : 0,
                    endTime: Number.isFinite(g.endTime) ? g.endTime : totalDuration,
                });
            }
        }

        // ── Camera ──
        let camScale, driftX, driftY, tiltAmount;
        let wpBigMapCamera = false;

        if (hasWaypoints && wpPositions.length > 0) {
            // ═══ WAYPOINT CAMERA ═══
            const globalZS = mg._mapZoomKfStart ?? (bigMapSize ? 1.2 : 0.8);
            const globalZE = mg._mapZoomKfEnd ?? (bigMapSize ? 1.8 : 1.2);
            const awp = wpPositions[activeWpIdx];
            const hasPerWpZoom = wpPositions.some(wp => wp.zoom != null);

            // Route + comparison variants must keep the whole frame readable —
            // cap per-waypoint zoom much tighter than locator/regionHighlight.
            // The AI planner is allowed to send z up to 6.0, which is correct
            // for a single-pin close-up but turns a route into a pinball match
            // between zoomed-in stops and turns a side-by-side comparison into
            // a sequential tour. Clamp route ≤ 1.1, comparison ≤ 1.5.
            const isRoute = variant === 'route';
            const isComparison = variant === 'comparison';
            const wideCap = isRoute ? 1.1 : (isComparison ? 1.5 : null);
            const clampWpZoom = (z) => wideCap != null ? Math.min(z, wideCap) : z;

            if (hasPerWpZoom && bigMapSize) {
                const curZoom = clampWpZoom(awp.zoom ?? globalZS);
                if (prevWpIdx >= 0 && wpTransition < 1) {
                    const prevZoom = clampWpZoom(wpPositions[prevWpIdx].zoom ?? globalZS);
                    camScale = prevZoom + (curZoom - prevZoom) * _ease(wpTransition, easingMode);
                } else {
                    const wpDur = awp.endTime - awp.startTime;
                    const wpLocalT = Math.min(1, (elapsed - awp.startTime) / Math.max(0.1, wpDur));
                    camScale = curZoom + curZoom * 0.05 * wpLocalT;
                }
            } else {
                camScale = globalZS + (globalZE - globalZS) * kfEased;
                if (wideCap != null) camScale = Math.min(camScale, wideCap);
            }

            if (bigMapSize) {
                wpBigMapCamera = true;
                driftX = 0;
                driftY = 0;

                // Stops-driven pan clamp: when the corridor/region stop center
                // sits near the bigmap edge, the visible window would extend
                // beyond the stitched tile coverage and leave a black bar on
                // the short side. Clamp wpCam so the frame always stays inside
                // the map rectangle. (Skip when the scaled map is smaller than
                // the frame — nothing to clamp; camera stays centered.)
                if (_stopsDrivenCamera && camScale > 0) {
                    const halfVisW = (W / 2) / camScale;
                    const halfVisH = (H / 2) / camScale;
                    if (IMG_W >= 2 * halfVisW) {
                        wpCamX = Math.min(IMG_W - halfVisW, Math.max(halfVisW, wpCamX));
                    } else {
                        wpCamX = IMG_W / 2;
                    }
                    if (IMG_H >= 2 * halfVisH) {
                        wpCamY = Math.min(IMG_H - halfVisH, Math.max(halfVisH, wpCamY));
                    } else {
                        wpCamY = IMG_H / 2;
                    }
                }
                if (routeHeldWideFromStops) {
                    const xs = wpPositions.map(p => p.px);
                    const ys = wpPositions.map(p => p.py);
                    const minX = Math.min(...xs), maxX = Math.max(...xs);
                    const minY = Math.min(...ys), maxY = Math.max(...ys);
                    const spanX = Math.max(1, maxX - minX);
                    const spanY = Math.max(1, maxY - minY);
                    const paddedFit = Math.min(W / (spanX * 1.6), H / (spanY * 1.6));
                    const endpointFit = Math.min(W / spanX, H / spanY);
                    const fillScale = Math.max(W / IMG_W, H / IMG_H);
                    let fitScale = Math.max(paddedFit, fillScale);
                    if (fitScale > endpointFit && endpointFit >= fillScale) fitScale = endpointFit;
                    wpCamX = (minX + maxX) / 2;
                    wpCamY = (minY + maxY) / 2;
                    camScale = Math.max(0.25, Math.min(1.3, fitScale));
                    if (!this._heldWideRouteLogged) this._heldWideRouteLogged = new Set();
                    const _sceneKey = `scene${_mapScene?.sceneIndex ?? mg.sceneIndex ?? '?'}`;
                    if (!this._heldWideRouteLogged.has(_sceneKey)) {
                        this._heldWideRouteLogged.add(_sceneKey);
                        console.log(`[MGRenderer] map ${_sceneKey} held-wide route lock: stops=${wpPositions.length} camScale=${camScale.toFixed(3)} wpCam=[${wpCamX.toFixed(0)},${wpCamY.toFixed(0)}]`);
                    }
                }
                // Route + comparison: lock camera to bbox-center of all waypoints
                // and scale to fit. A per-waypoint pan at scale 1.1 clips off the
                // bigmap edges (black bars) because each waypoint sits near the
                // edge of the wide-shot bigmap. These variants are one held
                // wide frame, not a tour — override any interpolation above.
                //
                // Slice 5b: when cameraPlan.stops drives the camera, those stops
                // ARE the authoritative per-subject pan/zoom intent. Skip this
                // bbox-fit override so stops' lon/lat pan and per-stop zoom
                // actually show up on screen. Stops absent → this block runs as
                // before (legacy fallback, unchanged behavior).
                else if (wideCap != null && wpPositions.length > 1 && !_stopsDrivenCamera) {
                    const xs = wpPositions.map(p => p.px);
                    const ys = wpPositions.map(p => p.py);
                    const minX = Math.min(...xs), maxX = Math.max(...xs);
                    const minY = Math.min(...ys), maxY = Math.max(...ys);
                    // Route: wider headroom (1.6) so both endpoints sit well inside
                    // the frame instead of hugging the edges. Comparison keeps 1.4.
                    const headroom = isRoute ? 1.6 : 1.4;
                    const rawSpanX = Math.max(1, maxX - minX);
                    const rawSpanY = Math.max(1, maxY - minY);
                    const paddedFit = Math.min(W / (rawSpanX * headroom), H / (rawSpanY * headroom));
                    const endpointFit = Math.min(W / rawSpanX, H / rawSpanY);
                    const fillScale = Math.max(W / IMG_W, H / IMG_H);
                    const fitScale = Math.min(Math.max(paddedFit, fillScale), endpointFit);
                    // Route: also force-lock wpCamX/Y to bbox-center and camScale
                    // to fitScale (no clamp — fit exactly). The default interpolation
                    // at 3835-3842 tracks the active waypoint pixel, which for long
                    // corridors (Shanghai→Rotterdam) reads as an endpoint tour. A
                    // held bbox-center hold is the editorial intent for routes.
                    if (isRoute) {
                        wpCamX = (minX + maxX) / 2;
                        wpCamY = (minY + maxY) / 2;
                        camScale = fitScale;
                    } else {
                        wpCamX = (minX + maxX) / 2;
                        wpCamY = (minY + maxY) / 2;
                        camScale = Math.min(camScale, fitScale);
                    }
                    if (!this._bboxFitLogged) this._bboxFitLogged = new Set();
                    const _sceneKey = `scene${_mapScene?.sceneIndex ?? mg.sceneIndex ?? '?'}`;
                    if (!this._bboxFitLogged.has(_sceneKey)) {
                        this._bboxFitLogged.add(_sceneKey);
                        console.log(`[MGRenderer] map ${_sceneKey} bbox-fit: variant=${variant} wp=${wpPositions.length} camScale=${camScale.toFixed(3)} wpCam=[${wpCamX.toFixed(0)},${wpCamY.toFixed(0)}] (fit=${fitScale.toFixed(3)})`);
                    }
                }
            } else {
                driftX = (W / 2 - wpCamX);
                driftY = (H / 2 - wpCamY);
            }

            const hasPerWpTilt = wpPositions.some(wp => wp.tilt != null);
            if (hasPerWpTilt) {
                const curTilt = awp.tilt ?? 0;
                if (prevWpIdx >= 0 && wpTransition < 1) {
                    const prevTilt = wpPositions[prevWpIdx].tilt ?? 0;
                    tiltAmount = prevTilt + (curTilt - prevTilt) * _ease(wpTransition, easingMode);
                } else {
                    tiltAmount = curTilt;
                }
            } else {
                const tiltS = mg._mapTiltStart || 0;
                const tiltE2 = mg._mapTiltEnd ?? tiltS;
                tiltAmount = tiltS + (tiltE2 - tiltS) * kfEased;
            }

        } else if (cinematicMode) {
            // ═══ CINEMATIC 3-PHASE CAMERA ═══
            const p1End = 0.20, p2End = 0.50;
            const progress = kfT;
            if (progress <= p1End) {
                const t1 = progress / p1End;
                const e1 = _ease(t1, easingMode);
                camScale = 0.7 + e1 * 0.05;
                driftX = (1 - e1) * 15;
                driftY = (1 - e1) * 8;
                tiltAmount = 0;
            } else if (progress <= p2End) {
                const t2 = (progress - p1End) / (p2End - p1End);
                const e2 = _ease(t2, easingMode);
                camScale = 0.75 + e2 * 0.75;
                driftX = e2 * -10;
                driftY = e2 * -5;
                tiltAmount = e2 * 0.15;
            } else {
                const t3 = (progress - p2End) / (1 - p2End);
                const e3 = _ease(t3, easingMode);
                camScale = 1.5 + e3 * 0.15;
                tiltAmount = 0.15 + e3 * 0.45;
                const orbitAngle = t3 * Math.PI * 0.6;
                const orbitRadius = 30 + e3 * 15;
                driftX = -10 + Math.sin(orbitAngle) * orbitRadius;
                driftY = -5 + Math.cos(orbitAngle) * orbitRadius * 0.4;
            }
        } else {
            // ═══ STANDARD KEYFRAME CAMERA ═══
            const zKfS = mg._mapZoomKfStart ?? 1.0;
            const zKfE = mg._mapZoomKfEnd ?? 1.0;
            camScale = zKfS + (zKfE - zKfS) * kfEased;
            if (variant === 'locator' || variant === 'regionHighlight') {
                const driftT = Math.min(1, elapsed / (0.8 / zoomSpd));
                driftX = (1 - _ease(driftT, easingMode)) * 30;
                driftY = (1 - _ease(driftT, easingMode)) * 18;
            } else if (variant === 'route') {
                const ZOOM_DUR = 1.0 / zoomSpd;
                const panT = Math.min(1, Math.max(0, (elapsed - ZOOM_DUR) / Math.max(1, totalDuration - ZOOM_DUR)));
                const panE = panT * panT * (3 - 2 * panT);
                driftX = panE * 15 - 8;
                driftY = panE * 10 - 5;
            } else {
                const driftT = Math.min(1, elapsed / (1.2 / zoomSpd));
                const dE = _ease(driftT, easingMode);
                driftX = (1 - dE) * 20;
                driftY = (1 - dE) * 12;
            }
            const tiltS = mg._mapTiltStart || 0;
            const tiltE2 = mg._mapTiltEnd ?? tiltS;
            tiltAmount = tiltS + (tiltE2 - tiltS) * kfEased;
        }

        // ── Pan keyframes ──
        const panXS = mg._mapPanXStart || 0;
        const panXE = mg._mapPanXEnd || 0;
        const panYS = mg._mapPanYStart || 0;
        const panYE = mg._mapPanYEnd || 0;
        if (panXS !== 0 || panXE !== 0 || panYS !== 0 || panYE !== 0) {
            driftX += panXS + (panXE - panXS) * kfEased;
            driftY += panYS + (panYE - panYS) * kfEased;
        }

        // ── Per-waypoint bearing & orbit ──
        let bearingDeg = 0;
        if (hasWaypoints && wpPositions.length > 0) {
            const hasPerWpBearing = wpPositions.some(wp => wp.bearing != null || wp.orbit != null);
            if (hasPerWpBearing) {
                const awpCam = wpPositions[activeWpIdx];
                const curBearing = awpCam.bearing ?? 0;
                const curOrbit = awpCam.orbit ?? 0;
                const wpLocalElapsed = elapsed - awpCam.startTime;
                let targetBearing = curBearing + curOrbit * wpLocalElapsed;
                if (prevWpIdx >= 0 && wpTransition < 1) {
                    const prevWp = wpPositions[prevWpIdx];
                    const prevBearing = prevWp.bearing ?? 0;
                    const prevOrbit = prevWp.orbit ?? 0;
                    const prevLocalElapsed = elapsed - prevWp.startTime;
                    const prevTotal = prevBearing + prevOrbit * prevLocalElapsed;
                    bearingDeg = prevTotal + (targetBearing - prevTotal) * _ease(wpTransition, easingMode);
                } else {
                    bearingDeg = targetBearing;
                }
            }
        }
        const bearingRad = bearingDeg * Math.PI / 180;
        const useBearing = Math.abs(bearingDeg) > 0.1;

        // ── 3D PERSPECTIVE TILT ──
        const useTilt = tiltAmount > 0.01;
        const _mainCtx = ctx;

        if (useTilt || useBearing) {
            if (!this._mapOffscreen || this._mapOffscreen.width !== W) {
                this._mapOffscreen = document.createElement('canvas');
                this._mapOffscreen.width = W;
                this._mapOffscreen.height = H;
            }
            this._mapOffscreen.getContext('2d').clearRect(0, 0, W, H);
            ctx = this._mapOffscreen.getContext('2d');
        }

        // ── 1. BACKGROUND: API map image or polygon fallback (with camera animation) ──
        const hasMapImage = _mapImageFile && this._mapImages && this._mapImages[_mapImageFile];

        ctx.save();
        if (wpBigMapCamera) {
            ctx.translate(W / 2, H / 2);
            if (useBearing) ctx.rotate(bearingRad);
            ctx.scale(camScale, camScale);
            ctx.translate(-wpCamX, -wpCamY);
        } else {
            ctx.translate(W / 2 + driftX, H / 2 + driftY);
            if (useBearing) ctx.rotate(bearingRad);
            ctx.scale(camScale, camScale);
            ctx.translate(-W / 2, -H / 2);
        }

        if (hasMapImage) {
            const mapImg = this._mapImages[_mapImageFile];
            ctx.globalAlpha = opacity * Math.min(1, enterProgress * 2);
            // Apply style-pack basemap filter (desaturate/darken/contrast) only to the tile image
            if (stylePackBasemap) {
                const desat    = Number(stylePackBasemap.desaturate) || 0;
                const darken   = Number(stylePackBasemap.darken)     || 0;
                const contrast = Number(stylePackBasemap.contrast)   || 1;
                const parts = [];
                if (desat > 0.001) parts.push(`grayscale(${desat.toFixed(3)})`);
                if (darken > 0.001) parts.push(`brightness(${(1 - darken).toFixed(3)})`);
                if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${contrast.toFixed(3)})`);
                if (parts.length) ctx.filter = parts.join(' ');
            }
            ctx.drawImage(mapImg, 0, 0, IMG_W, IMG_H);
            if (stylePackBasemap) ctx.filter = 'none';
            ctx.globalAlpha = opacity;
        } else {
            this._renderMapChartFallbackBg(ctx, mg, W, H, opacity, enterProgress, pal);
        }

        // ── 2. Gather pin entities (use geocoded pins when available) ──
        // Build geocoded pin lookup from the resolved pin list (set by map-provider geocoding).
        const geocodedPins = {};
        if (Array.isArray(_mapPins)) {
            for (const gp of _mapPins) {
                geocodedPins[gp.name.toLowerCase()] = gp;
            }
        }

        // Parse subtext; keep only items that resolve to a real location.
        // Prose subtext like "World map highlighting the Persian Gulf, with a glowing red marker..."
        // produces garbage labels when comma-split — reject them so the entity fallback can run.
        let items = MGRenderer._parseKeyValuePairs(mg.subtext || '')
            .filter(it => geocodedPins[it.label.toLowerCase()] || MAP_COORDS[it.label]);

        if (items.length === 0 && scriptContext?.entities) {
            items = scriptContext.entities
                .filter(e => MAP_COORDS[e] || geocodedPins[e.toLowerCase()])
                .map(e => ({ label: e, value: '' }));
        }
        if (items.length === 0 && mg.text) {
            const textEntities = Object.keys(MAP_COORDS).filter(name =>
                name.length > 2 && mg.text.toLowerCase().includes(name.toLowerCase())
            );
            items = textEntities.map(e => ({ label: e, value: '' }));
        }

        const pinPositions = items.slice(0, 10).map((item, i) => {
            // Try geocoded pin first, then fallback to hardcoded MAP_COORDS.
            // If neither matches, DROP the item — do not hash-position garbage labels onto the map.
            const geoPin = geocodedPins[item.label.toLowerCase()];
            let x, y, pinType;
            if (geoPin) {
                x = toX(geoPin.lon);
                y = toY(geoPin.lat);
                pinType = geoPin.type || 'country';
            } else {
                const coords = MAP_COORDS[item.label];
                if (coords) {
                    x = toX(coords[0]);
                    y = toY(coords[1]);
                    pinType = 'country';
                } else {
                    return null;
                }
            }
            return { ...item, x, y, i, pinType };
        }).filter(p => p !== null);

        // ── 2b. Country polygon fills (Natural Earth land boundaries — no maritime zones) ──
        const preloaded = mg._countryFeatures || [];
        const countryGeo = window._countryGeoJSON;
        const osmBounds = _osmBoundaries || [];

        const boundaryFeatures = [];
        const _boundaryMatched = new Set(); // lowercased names already covered
        if (preloaded.length > 0) {
            for (const b of preloaded) {
                if (b.feature && b.feature.geometry) {
                    boundaryFeatures.push(b);
                    if (b.name) _boundaryMatched.add(String(b.name).toLowerCase());
                }
            }
        }
        // Match pin labels to Natural Earth features
        if (boundaryFeatures.length === 0 && countryGeo && countryGeo.features) {
            const ALIASES = {
                'usa': 'United States of America', 'us': 'United States of America', 'united states': 'United States of America',
                'uk': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom',
                'uae': 'United Arab Emirates', 'south korea': 'South Korea', 'north korea': 'North Korea',
                'czech republic': 'Czechia', 'czechia': 'Czechia',
            };
            for (const pin of pinPositions) {
                const label = pin.label?.toLowerCase();
                if (!label) continue;
                const resolved = ALIASES[label] || label;
                const feat = countryGeo.features.find(f =>
                    f.properties.name?.toLowerCase() === resolved ||
                    f.properties.nameLong?.toLowerCase() === resolved ||
                    f.properties.name?.toLowerCase() === label ||
                    f.properties.nameLong?.toLowerCase() === label ||
                    f.properties.sov?.toLowerCase() === label
                );
                if (feat && feat.geometry) {
                    boundaryFeatures.push({ name: pin.label, feature: feat });
                    _boundaryMatched.add(label);
                }
            }
        }
        // ── OSM fallback for continents / seas / straits / regions ──
        // Natural Earth only carries country polygons, so subjects like "Asia",
        // "Middle East", "Red Sea", "Bab-el-Mandeb" would leave boundaryFeatures
        // empty and the region variant would render with only a soft halo. The
        // pipeline already fetched OSM boundaries for these — merge them in for
        // any pin (or explicit OSM entry) not already covered by NE. OSM
        // features share the same { name, feature } shape.
        if (osmBounds && osmBounds.length > 0) {
            for (const ob of osmBounds) {
                if (!ob || !ob.feature || !ob.feature.geometry) continue;
                const key = String(ob.name || '').toLowerCase();
                if (_boundaryMatched.has(key)) continue;
                boundaryFeatures.push({ name: ob.name, feature: ob.feature });
                _boundaryMatched.add(key);
            }
        }

        // Helper: build polygon path from GeoJSON coordinates
        const _tracePoly = (polys) => {
            for (const polygon of polys) {
                for (const ring of polygon) {
                    if (ring.length < 3) continue;
                    ctx.moveTo(toX(ring[0][0]), toY(ring[0][1]));
                    for (let ri = 1; ri < ring.length; ri++) ctx.lineTo(toX(ring[ri][0]), toY(ring[ri][1]));
                    ctx.closePath();
                }
            }
        };
        // Helper: compute polygon bounding box in pixel space
        const _polyBounds = (polys) => {
            let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
            for (const polygon of polys) { for (const ring of polygon) { for (const pt of ring) { const px = toX(pt[0]), py = toY(pt[1]); if (px < mnX) mnX = px; if (py < mnY) mnY = py; if (px > mxX) mxX = px; if (py > mxY) mxY = py; } } }
            return { x: mnX, y: mnY, w: mxX - mnX, h: mxY - mnY, cx: (mnX + mxX) / 2, cy: (mnY + mxY) / 2 };
        };

        // Helper: match a name to a waypoint (exact then partial)
        const _findWpMatch = (name) => {
            if (!wpPositions.length) return null;
            const lower = (name || '').toLowerCase();
            let m = wpPositions.find(wp => wp.name.toLowerCase() === lower);
            if (!m) m = wpPositions.find(wp => wp.name.toLowerCase().includes(lower) || lower.includes(wp.name.toLowerCase()));
            return m || null;
        };

        // Per-polygon color cycle for multiple locations
        let POLY_CYCLE = [
            { fill: '#00d4ff', fillEdge: '#0088cc', stroke: '#00d4ff', glow: 'rgba(0,212,255,0.6)' },
            { fill: '#ff6040', fillEdge: '#cc3820', stroke: '#ff6040', glow: 'rgba(255,96,64,0.6)' },
            { fill: '#40ff90', fillEdge: '#20cc60', stroke: '#40ff90', glow: 'rgba(64,255,144,0.6)' },
            { fill: '#f0c040', fillEdge: '#c09020', stroke: '#f0c040', glow: 'rgba(240,192,64,0.6)' },
            { fill: '#a060ff', fillEdge: '#7030cc', stroke: '#a060ff', glow: 'rgba(160,96,255,0.6)' },
            { fill: '#ff40a0', fillEdge: '#cc2070', stroke: '#ff40a0', glow: 'rgba(255,64,160,0.6)' },
            { fill: '#40c0ff', fillEdge: '#2090cc', stroke: '#40c0ff', glow: 'rgba(64,192,255,0.6)' },
            { fill: '#ff8020', fillEdge: '#cc6010', stroke: '#ff8020', glow: 'rgba(255,128,32,0.6)' },
        ];
        // Pack-driven role cycle: [primary, secondary, tertiary] rotated for multi-polygon scenes.
        // Keeps invasions red-vs-blue feel instead of rainbow when the pack defines roles.
        if (stylePack && stylePack.polygon && stylePack.polygon.roles) {
            const roles = stylePack.polygon.roles;
            const packCycle = [];
            if (roles.primary)   packCycle.push(roles.primary);
            if (roles.secondary) packCycle.push(roles.secondary);
            if (roles.tertiary)  packCycle.push(roles.tertiary);
            if (packCycle.length >= 2) POLY_CYCLE = packCycle;
        }
        const usePolyCycle = boundaryFeatures.length > 1 && polyColorKey === 'auto';

        for (let bi = 0; bi < boundaryFeatures.length; bi++) {
            const bf = boundaryFeatures[bi];
            const feat = bf.feature;
            const geom = feat.geometry;
            if (!geom) continue;
            const cpPal = usePolyCycle ? POLY_CYCLE[bi % POLY_CYCLE.length] : polyPal;

            let polyDelay;
            const wpMatch = _findWpMatch(bf.name);
            if (wpPositions.length > 0) {
                if (wpMatch) {
                    polyDelay = wpMatch.startTime + 0.2;
                    if (!bigMapSize) {
                        const wpIdx = wpPositions.indexOf(wpMatch);
                        if (wpIdx !== activeWpIdx && wpIdx !== prevWpIdx) continue;
                    }
                } else {
                    polyDelay = (0.15 + bi * 0.25) / polySpd;
                }
            } else {
                polyDelay = (0.15 + bi * 0.25) / polySpd;
            }
            const polyT = Math.min(1, Math.max(0, (elapsed - polyDelay) / (0.7 / polySpd)));
            if (polyT <= 0) continue;
            const polyEase = _ease(polyT, easingMode);
            const pulse = (Math.sin(elapsed * 1.5 * polySpd + bi * 0.8) + 1) / 2;

            const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
            const bounds = _polyBounds(polys);

            // ── PHASE 1: Mask reveal — circular wipe expanding from polygon center ──
            ctx.save();
            if (polyEase < 1) {
                // Expanding circular clip from center
                const maxR = Math.sqrt(bounds.w * bounds.w + bounds.h * bounds.h) * 0.6;
                const revealR = maxR * polyEase;
                ctx.beginPath();
                ctx.arc(bounds.cx, bounds.cy, revealR, 0, Math.PI * 2);
                ctx.clip();
            }

            // Clip to polygon boundary
            ctx.beginPath();
            _tracePoly(polys);
            ctx.clip('evenodd');

            // ── PHASE 2: Gradient fill (radial gradient from center) ──
            const gradR = Math.max(bounds.w, bounds.h) * 0.7;
            const fillGrad = ctx.createRadialGradient(bounds.cx, bounds.cy, 0, bounds.cx, bounds.cy, gradR);
            fillGrad.addColorStop(0, cpPal.fill);
            fillGrad.addColorStop(1, cpPal.fillEdge);
            ctx.globalAlpha = opacity * polyEase * (0.25 + pulse * 0.08);
            ctx.fillStyle = fillGrad;
            ctx.fillRect(0, 0, IMG_W, IMG_H);

            // Inner highlight shimmer (subtle moving light)
            const shimmerX = bounds.cx + Math.sin(elapsed * 0.7 * polySpd + bi) * bounds.w * 0.3;
            const shimmerY = bounds.cy + Math.cos(elapsed * 0.5 * polySpd + bi) * bounds.h * 0.2;
            const shimGrad = ctx.createRadialGradient(shimmerX, shimmerY, 0, shimmerX, shimmerY, gradR * 0.5);
            shimGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
            shimGrad.addColorStop(1, 'rgba(255,255,255,0.0)');
            ctx.globalAlpha = opacity * polyEase * 0.6;
            ctx.fillStyle = shimGrad;
            ctx.fillRect(0, 0, IMG_W, IMG_H);

            ctx.restore();

            // ── PHASE 3: Progressive stroke animation (border draws on over time) ──
            ctx.save();
            ctx.globalAlpha = opacity * polyEase * (0.5 + pulse * 0.25);
            ctx.strokeStyle = cpPal.stroke;
            ctx.lineWidth = 3;
            ctx.shadowColor = cpPal.glow;
            ctx.shadowBlur = 10 + pulse * 10;

            // Draw partial border based on progress (stroke reveal)
            const strokeProgress = Math.min(1, Math.max(0, (elapsed - polyDelay - 0.2 / polySpd) / (1.0 / polySpd)));
            const strokeEase = _ease(strokeProgress, easingMode);

            if (strokeEase >= 1) {
                // Full border — just draw normally
                ctx.beginPath();
                _tracePoly(polys);
                ctx.stroke();
            } else if (strokeEase > 0) {
                // Progressive draw: use lineDash to reveal portion of border
                // Estimate total perimeter
                let totalLen = 0;
                for (const polygon of polys) { for (const ring of polygon) { for (let ri = 1; ri < ring.length; ri++) { const dx = toX(ring[ri][0]) - toX(ring[ri-1][0]); const dy = toY(ring[ri][1]) - toY(ring[ri-1][1]); totalLen += Math.sqrt(dx*dx + dy*dy); } } }
                const drawLen = totalLen * strokeEase;
                ctx.setLineDash([drawLen, totalLen]);
                ctx.lineDashOffset = 0;
                ctx.beginPath();
                _tracePoly(polys);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Second glow pass (wider, fainter) for neon effect
            if (strokeEase > 0.3) {
                ctx.globalAlpha = opacity * polyEase * pulse * 0.15;
                ctx.lineWidth = 8;
                ctx.shadowBlur = 25;
                ctx.beginPath();
                _tracePoly(polys);
                ctx.stroke();
            }

            ctx.shadowBlur = 0;
            ctx.restore();
            ctx.globalAlpha = opacity;
        }

        // ── 2c. Region halo fallback ──
        // regionHighlight variant with no Natural Earth polygon match (Middle
        // East, Asia, Horn of Africa, Balkans — regional labels larger than a
        // single country) would otherwise show only pin dots on a basemap. Draw
        // a soft translucent halo around the bbox of pins so the region reads
        // as one coherent editorial area, not isolated pins.
        if (variant === 'regionHighlight' && boundaryFeatures.length === 0 && pinPositions.length >= 1) {
            const xs = pinPositions.map(p => p.x);
            const ys = pinPositions.map(p => p.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            const span = Math.max(maxX - minX, maxY - minY);
            const haloR = Math.max(90, span * 0.75 + 60);
            const haloDelay = 0.3;
            const haloT = Math.min(1, Math.max(0, (elapsed - haloDelay) / 0.9));
            if (haloT > 0) {
                const haloE = 1 - Math.pow(1 - haloT, 2);
                ctx.save();
                ctx.globalCompositeOperation = 'source-over';
                // Soft translucent fill
                ctx.globalAlpha = opacity * haloE * 0.16;
                const haloGrad = ctx.createRadialGradient(cx, cy, haloR * 0.2, cx, cy, haloR);
                haloGrad.addColorStop(0, pal.highlight);
                haloGrad.addColorStop(0.6, pal.highlight);
                haloGrad.addColorStop(1, 'transparent');
                ctx.fillStyle = haloGrad;
                ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();
                // Outline ring
                ctx.globalAlpha = opacity * haloE * 0.55;
                ctx.strokeStyle = pal.highlightRing || pal.highlight;
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 6]);
                ctx.lineDashOffset = -elapsed * 10;
                ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();
                ctx.globalAlpha = opacity;
            }
        }

        // ── 3. Radius / impact circles (expanding radar rings + glow) ──
        for (const pin of pinPositions) {
            if (pin.pinType === 'unknown') continue;
            let highlightDelay;
            if (wpPositions.length > 0) {
                const wpMatch = _findWpMatch(pin.label);
                if (wpMatch) {
                    highlightDelay = wpMatch.startTime + 0.3;
                    if (!bigMapSize) {
                        const wpIdx = wpPositions.indexOf(wpMatch);
                        if (wpIdx !== activeWpIdx && wpIdx !== prevWpIdx) continue;
                    }
                } else {
                    highlightDelay = 0.2 + pin.i * 0.12;
                }
            } else {
                highlightDelay = 0.2 + pin.i * 0.12;
            }
            const highlightT = Math.min(1, Math.max(0, (elapsed - highlightDelay) / 0.8));
            if (highlightT <= 0) continue;

            const easeHL = 1 - Math.pow(1 - highlightT, 2);
            const baseRadius = pin.pinType === 'city' ? 40 : pin.pinType === 'landmark' ? 30 : 60;
            const hlRadius = baseRadius * easeHL;
            const pulse = (Math.sin(elapsed * 2 * speed + pin.i) + 1) / 2;

            // Expanding radar ring
            const radarT = ((elapsed * 0.6 * speed + pin.i * 0.4) % 2) / 2;
            const radarR = hlRadius * 0.5 + hlRadius * 1.5 * radarT;
            ctx.globalAlpha = opacity * easeHL * (1 - radarT) * 0.3;
            ctx.strokeStyle = pal.highlightRing;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(pin.x, pin.y, radarR, 0, Math.PI * 2); ctx.stroke();

            // Inner glow
            const outerR = hlRadius + pulse * 12;
            ctx.globalAlpha = opacity * easeHL * 0.5;
            const hlGrad = ctx.createRadialGradient(pin.x, pin.y, hlRadius * 0.2, pin.x, pin.y, outerR);
            hlGrad.addColorStop(0, pal.highlight);
            hlGrad.addColorStop(0.5, pal.highlight);
            hlGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = hlGrad;
            ctx.beginPath(); ctx.arc(pin.x, pin.y, outerR, 0, Math.PI * 2); ctx.fill();

            // Static ring
            ctx.strokeStyle = pal.highlightRing;
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = opacity * easeHL * 0.4;
            ctx.beginPath(); ctx.arc(pin.x, pin.y, hlRadius, 0, Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = opacity;
        }

        // ── 3b. Animated route path (dashed line drawing between waypoints) ──
        // Prefer explicit _mapRouteGeometry when present — it preserves every
        // real waypoint even when camera stops have collapsed to a single
        // corridor-overview shot (long-route path). Falls back to wpPositions
        // for short-route / legacy per-subject stops.
        const _routeSrc = (routePathPositions.length >= 2)
            ? routePathPositions
            : ((hasWaypoints && wpPositions.length >= 2) ? wpPositions : null);
        if (_mapRoutePath && alternateRoutePathPositions.length >= 2) {
            ctx.save();
            const altPts = alternateRoutePathPositions.filter(wp => wp.px != null && wp.py != null);
            if (altPts.length >= 2) {
                let totalAltLen = 0;
                const altSegments = [];
                for (let ri = 1; ri < altPts.length; ri++) {
                    const dx = altPts[ri].px - altPts[ri - 1].px;
                    const dy = altPts[ri].py - altPts[ri - 1].py;
                    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                    altSegments.push({ from: altPts[ri - 1], to: altPts[ri], len });
                    totalAltLen += len;
                }
                const altStart = Math.min(...altPts.map(p => Number(p.startTime)).filter(Number.isFinite), 0);
                const altDur = Math.max(1.4, Math.min(3.2, totalDuration * 0.45));
                const altT = Math.min(1, Math.max(0, (elapsed - altStart - 0.25) / altDur));
                const altE = 1 - Math.pow(1 - altT, 2);
                const drawLen = totalAltLen * altE;
                if (drawLen > 0) {
                    const strokePartial = () => {
                        ctx.beginPath();
                        ctx.moveTo(altPts[0].px, altPts[0].py);
                        let accumulated = 0;
                        for (const seg of altSegments) {
                            const remain = drawLen - accumulated;
                            if (remain <= 0) break;
                            const frac = Math.min(1, remain / seg.len);
                            ctx.lineTo(seg.from.px + (seg.to.px - seg.from.px) * frac, seg.from.py + (seg.to.py - seg.from.py) * frac);
                            accumulated += seg.len;
                            if (frac < 1) break;
                        }
                        ctx.stroke();
                    };
                    ctx.globalAlpha = opacity * 0.22;
                    ctx.strokeStyle = pal.routeGlow || pal.pin;
                    ctx.lineWidth = 10;
                    ctx.setLineDash([]);
                    strokePartial();

                    ctx.globalAlpha = opacity * 0.42;
                    ctx.strokeStyle = pal.pin;
                    ctx.lineWidth = 2.5;
                    ctx.setLineDash([8, 14]);
                    ctx.lineDashOffset = elapsed * 22 * speed;
                    strokePartial();
                    ctx.setLineDash([]);
                }
            }
            ctx.restore();
            ctx.globalAlpha = opacity;
        }
        if (_mapRoutePath && _routeSrc) {
            ctx.save();
            // Build ground-level path through all waypoints in order
            const routePts = _routeSrc.filter(wp => wp.px != null && wp.py != null);
            if (routePts.length >= 2) {
                // Total path length for dash animation
                let totalPathLen = 0;
                const segments = [];
                for (let ri = 1; ri < routePts.length; ri++) {
                    const dx = routePts[ri].px - routePts[ri - 1].px;
                    const dy = routePts[ri].py - routePts[ri - 1].py;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    segments.push({ from: routePts[ri - 1], to: routePts[ri], len });
                    totalPathLen += len;
                }

                // Draw progress: path draws to current active waypoint
                let drawLen = 0;
                for (let ri = 0; ri < segments.length; ri++) {
                    const seg = segments[ri];
                    const toWp = seg.to;
                    // Path draws when we transition TO this waypoint
                    const segDelay = toWp.startTime;
                    const segDur = 0.8 / speed;
                    const segT = Math.min(1, Math.max(0, (elapsed - segDelay) / segDur));
                    if (segT <= 0) break;
                    const segEase = 1 - Math.pow(1 - segT, 2);
                    drawLen += seg.len * segEase;
                }

                if (drawLen > 0) {
                    // Glow layer
                    ctx.globalAlpha = opacity * 0.25;
                    ctx.strokeStyle = pal.routeGlow || pal.pin;
                    ctx.lineWidth = 8;
                    ctx.setLineDash([]);
                    ctx.beginPath();
                    ctx.moveTo(routePts[0].px, routePts[0].py);
                    let accumulated = 0;
                    for (const seg of segments) {
                        const remain = drawLen - accumulated;
                        if (remain <= 0) break;
                        const frac = Math.min(1, remain / seg.len);
                        const ex = seg.from.px + (seg.to.px - seg.from.px) * frac;
                        const ey = seg.from.py + (seg.to.py - seg.from.py) * frac;
                        ctx.lineTo(ex, ey);
                        accumulated += seg.len;
                        if (frac < 1) break;
                    }
                    ctx.stroke();

                    // Dashed main line
                    ctx.globalAlpha = opacity * 0.85;
                    ctx.strokeStyle = pal.pin;
                    ctx.lineWidth = 3;
                    ctx.setLineDash([12, 8]);
                    ctx.lineDashOffset = -elapsed * 30 * speed; // animated marching ants
                    ctx.shadowColor = pal.pin;
                    ctx.shadowBlur = 6;
                    ctx.beginPath();
                    ctx.moveTo(routePts[0].px, routePts[0].py);
                    accumulated = 0;
                    for (const seg of segments) {
                        const remain = drawLen - accumulated;
                        if (remain <= 0) break;
                        const frac = Math.min(1, remain / seg.len);
                        const ex = seg.from.px + (seg.to.px - seg.from.px) * frac;
                        const ey = seg.from.py + (seg.to.py - seg.from.py) * frac;
                        ctx.lineTo(ex, ey);
                        accumulated += seg.len;
                        if (frac < 1) break;
                    }
                    ctx.stroke();
                    ctx.shadowBlur = 0;
                    ctx.setLineDash([]);

                    // Traveling dot at the path head
                    let headAccum = 0;
                    let headX = routePts[0].px, headY = routePts[0].py;
                    for (const seg of segments) {
                        const remain = drawLen - headAccum;
                        if (remain <= 0) break;
                        const frac = Math.min(1, remain / seg.len);
                        headX = seg.from.px + (seg.to.px - seg.from.px) * frac;
                        headY = seg.from.py + (seg.to.py - seg.from.py) * frac;
                        headAccum += seg.len;
                        if (frac < 1) break;
                    }
                    // Pulsing head dot
                    const headPulse = (Math.sin(elapsed * 6) + 1) / 2;
                    const headR = 6 + headPulse * 4;
                    ctx.globalAlpha = opacity * 0.9;
                    const headGrad = ctx.createRadialGradient(headX, headY, 0, headX, headY, headR + 8);
                    headGrad.addColorStop(0, pal.pin);
                    headGrad.addColorStop(1, 'transparent');
                    ctx.fillStyle = headGrad;
                    ctx.beginPath(); ctx.arc(headX, headY, headR + 8, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = '#fff';
                    ctx.beginPath(); ctx.arc(headX, headY, 4, 0, Math.PI * 2); ctx.fill();
                }
            }
            ctx.restore();
            ctx.globalAlpha = opacity;
        }

        // ── 3c. Icon swarms (multiple icons appear simultaneously) ──
        if (_mapSwarms && _mapSwarms.length > 0) {
            const swarmCoords = _wpCoords;
            const swarmPins   = _mapPins;

            for (const sw of _mapSwarms) {
                const swarmT = Math.min(1, Math.max(0, (elapsed - sw.startTime) / Math.max(0.5, sw.endTime - sw.startTime)));
                if (swarmT <= 0) continue;

                for (let li = 0; li < sw.locations.length; li++) {
                    const loc = sw.locations[li];
                    const locLower = (loc.name || '').toLowerCase();

                    // Find coordinates
                    let px, py;
                    let coord = swarmCoords.find(c => c.name.toLowerCase() === locLower);
                    if (!coord) coord = swarmCoords.find(c => c.name.toLowerCase().includes(locLower) || locLower.includes(c.name.toLowerCase()));
                    if (coord) {
                        px = toX(coord.lon); py = toY(coord.lat);
                    } else {
                        let pin = swarmPins.find(p => p.name.toLowerCase() === locLower);
                        if (!pin) pin = swarmPins.find(p => p.name.toLowerCase().includes(locLower) || locLower.includes(p.name.toLowerCase()));
                        if (pin) { px = toX(pin.lon); py = toY(pin.lat); }
                    }
                    if (px == null) continue;

                    // Staggered pop-in: each icon pops 0.12s after the previous
                    const stagger = li * 0.12;
                    const iconDelay = sw.startTime + stagger;
                    const popDur = 0.35;
                    const popT = Math.min(1, Math.max(0, (elapsed - iconDelay) / popDur));
                    if (popT <= 0) continue;

                    // Spring overshoot: scale pops to 1.3 then settles to 1.0
                    const spring = popT < 0.6
                        ? (popT / 0.6) * 1.3
                        : 1.3 - 0.3 * ((popT - 0.6) / 0.4);
                    const iconScale = Math.min(spring, 1.3) * (popT < 1 ? 1 : 1);
                    const iconAlpha = Math.min(1, popT * 2);

                    ctx.save();
                    ctx.globalAlpha = opacity * iconAlpha;
                    ctx.translate(px, py);
                    ctx.scale(iconScale, iconScale);

                    // Try to find the icon image
                    let iconImg = this._mapIcons[`__mapicon_${loc.name}`];
                    if (!iconImg) iconImg = this._mapIcons[`__mapicon_${loc.icon}`];

                    const iconSize = 36;
                    if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
                        // Circular background + icon
                        ctx.shadowColor = pal.pin;
                        ctx.shadowBlur = 12;
                        ctx.fillStyle = 'rgba(10,15,30,0.8)';
                        ctx.beginPath();
                        ctx.arc(0, 0, iconSize / 2 + 4, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.strokeStyle = pal.pin;
                        ctx.lineWidth = 2.5;
                        ctx.beginPath();
                        ctx.arc(0, 0, iconSize / 2 + 4, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.shadowBlur = 0;
                        // Clip + draw icon
                        ctx.beginPath();
                        ctx.arc(0, 0, iconSize / 2 + 2, 0, Math.PI * 2);
                        ctx.clip();
                        ctx.drawImage(iconImg, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
                    } else {
                        // Fallback: colored dot with pulse
                        ctx.shadowColor = pal.pin;
                        ctx.shadowBlur = 14;
                        ctx.fillStyle = pal.pin;
                        ctx.beginPath();
                        ctx.arc(0, 0, 8, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.shadowBlur = 0;
                    }

                    ctx.restore();

                    // Expanding ring on pop-in
                    if (popT < 1) {
                        const ringR = 20 + popT * 30;
                        ctx.globalAlpha = opacity * (1 - popT) * 0.4;
                        ctx.strokeStyle = pal.pin;
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.arc(px, py, ringR, 0, Math.PI * 2);
                        ctx.stroke();
                    }
                }
            }
            ctx.globalAlpha = opacity;
        }

        // ── 4. Flight arcs (progressive reveal + traveling dot) ──
        // Only for route/comparison variants — locator/regionHighlight should NOT draw arcs between pins.
        const _arcVariants = new Set(['route', 'comparison']);
        const _hasSemanticRoutePath = variant === 'route' && (_mapRoutePath || routePathPositions.length >= 2);
        if (_arcVariants.has(variant) && pinPositions.length >= 2 && !_hasSemanticRoutePath) {
            for (let i = 0; i < pinPositions.length - 1; i++) {
                const a = pinPositions[i], b = pinPositions[i + 1];
                const dist = Math.hypot(b.x - a.x, b.y - a.y);
                const arcHeight = dist * 0.35;
                const midX = (a.x + b.x) / 2;
                const midY = (a.y + b.y) / 2 - arcHeight;

                // Progressive arc reveal
                let arcDelay;
                if (wpPositions.length > 0) {
                    const wpB = _findWpMatch(b.label);
                    arcDelay = wpB ? wpB.startTime + 0.3 : 0.8 + i * 0.5;
                } else {
                    arcDelay = 0.8 + i * 0.5;
                }
                const arcDur = 1.0 / speed;
                const arcT = Math.min(1, Math.max(0, (elapsed - arcDelay) / arcDur));
                if (arcT <= 0) continue;
                const arcE = 1 - Math.pow(1 - arcT, 2);

                const SEGS = 60;
                const drawSegs = Math.ceil(SEGS * arcE);

                // Glow layer
                ctx.globalAlpha = opacity * 0.3;
                ctx.strokeStyle = pal.routeGlow;
                ctx.lineWidth = 10;
                ctx.beginPath();
                for (let s = 0; s <= drawSegs; s++) {
                    const t = s / SEGS;
                    const px = (1-t)*(1-t)*a.x + 2*(1-t)*t*midX + t*t*b.x;
                    const py = (1-t)*(1-t)*a.y + 2*(1-t)*t*midY + t*t*b.y;
                    if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.stroke();

                // Main arc
                ctx.globalAlpha = opacity * 0.85;
                ctx.strokeStyle = pal.pin;
                ctx.lineWidth = 3;
                ctx.shadowColor = pal.pin;
                ctx.shadowBlur = 8;
                ctx.beginPath();
                for (let s = 0; s <= drawSegs; s++) {
                    const t = s / SEGS;
                    const px = (1-t)*(1-t)*a.x + 2*(1-t)*t*midX + t*t*b.x;
                    const py = (1-t)*(1-t)*a.y + 2*(1-t)*t*midY + t*t*b.y;
                    if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.stroke();
                ctx.shadowBlur = 0;

                // Traveling dot (after arc fully drawn)
                if (arcE >= 0.99) {
                    const dotT = ((elapsed - arcDelay - arcDur) * 0.5 * speed + i * 0.3) % 1;
                    const dx = (1-dotT)*(1-dotT)*a.x + 2*(1-dotT)*dotT*midX + dotT*dotT*b.x;
                    const dy = (1-dotT)*(1-dotT)*a.y + 2*(1-dotT)*dotT*midY + dotT*dotT*b.y;
                    const tg = ctx.createRadialGradient(dx, dy, 0, dx, dy, 14);
                    tg.addColorStop(0, pal.pin); tg.addColorStop(1, 'transparent');
                    ctx.globalAlpha = opacity * 0.8;
                    ctx.fillStyle = tg; ctx.beginPath(); ctx.arc(dx, dy, 14, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = pal.pin; ctx.shadowColor = pal.pin; ctx.shadowBlur = 12;
                    ctx.beginPath(); ctx.arc(dx, dy, 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
                }
                ctx.globalAlpha = opacity;
            }
        }

        // ── 5. Pin markers with labels ──
        const pinEnterDur = 0.4 / speed;
        for (const pin of pinPositions) {
            let pinDelay;
            if (wpPositions.length > 0) {
                const wpMatch = _findWpMatch(pin.label);
                if (wpMatch) {
                    pinDelay = wpMatch.startTime + 0.5;
                    if (!bigMapSize) {
                        const wpIdx = wpPositions.indexOf(wpMatch);
                        if (wpIdx !== activeWpIdx && wpIdx !== prevWpIdx) continue;
                    }
                } else {
                    pinDelay = 0.5 + pin.i * 0.22;
                }
            } else {
                pinDelay = 0.5 + pin.i * 0.22;
            }
            const pinProgress = Math.min(1, Math.max(0, (elapsed - pinDelay) / pinEnterDur));
            if (pinProgress <= 0) continue;

            const eased = 1 - Math.pow(1 - pinProgress, 3);
            const bounce = pinProgress < 1 ? (1 - pinProgress) * 16 : 0;
            const py = pin.y - bounce;
            const pinAlpha = eased * opacity;
            ctx.globalAlpha = pinAlpha;

            // Expanding ripple rings (continuous pulse after enter)
            if (pinProgress >= 1) {
                const pulse = (Math.sin(elapsed * 3 * speed + pin.i * 1.5) + 1) / 2;
                const pulseR = 20 + pulse * 16;
                ctx.strokeStyle = pal.pinRing;
                ctx.lineWidth = 2;
                ctx.globalAlpha = pinAlpha * (0.15 + pulse * 0.25);
                ctx.beginPath();
                ctx.arc(pin.x, py, pulseR, 0, Math.PI * 2);
                ctx.stroke();
                const pulse2 = (Math.sin(elapsed * 3 * speed + pin.i * 1.5 + Math.PI) + 1) / 2;
                const pulseR2 = 28 + pulse2 * 12;
                ctx.globalAlpha = pinAlpha * (0.08 + pulse2 * 0.14);
                ctx.beginPath();
                ctx.arc(pin.x, py, pulseR2, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = pinAlpha;
            }

            // Glow halo (bigger for cities/landmarks)
            const glowR = pin.pinType === 'city' || pin.pinType === 'landmark' ? 36 : 28;
            const glowGrad = ctx.createRadialGradient(pin.x, py, 0, pin.x, py, glowR);
            glowGrad.addColorStop(0, pal.pinGlow);
            glowGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = glowGrad;
            ctx.beginPath();
            ctx.arc(pin.x, py, glowR, 0, Math.PI * 2);
            ctx.fill();

            // Pin dot or icon — look up by pin label, then try waypoint match
            let iconImg = this._mapIcons[`__mapicon_${pin.label}`];
            if (!iconImg) {
                // Try matching via waypoint: find a waypoint whose name matches this pin
                const wps = _mapWaypoints || [];
                for (const wp of wps) {
                    if (!wp.icon) continue;
                    const wpLow = (wp.name || '').toLowerCase();
                    const pinLow = (pin.label || '').toLowerCase();
                    if (wpLow === pinLow || wpLow.includes(pinLow) || pinLow.includes(wpLow)) {
                        iconImg = this._mapIcons[`__mapicon_${wp.name}`];
                        if (iconImg) break;
                    }
                }
            }
            const pinDotR = pin.pinType === 'city' || pin.pinType === 'landmark' ? 9 : 7;

            if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
                // Draw icon instead of pin dot — circular clipped, with glow
                const iconSize = 40 * eased;
                ctx.save();
                ctx.shadowColor = pal.pin;
                ctx.shadowBlur = 14;
                // Draw circular background
                ctx.fillStyle = 'rgba(10,15,30,0.7)';
                ctx.beginPath();
                ctx.arc(pin.x, py, iconSize / 2 + 4, 0, Math.PI * 2);
                ctx.fill();
                // Draw border ring
                ctx.strokeStyle = pal.pin;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(pin.x, py, iconSize / 2 + 4, 0, Math.PI * 2);
                ctx.stroke();
                ctx.shadowBlur = 0;
                // Clip to circle and draw icon
                ctx.beginPath();
                ctx.arc(pin.x, py, iconSize / 2 + 2, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(iconImg, pin.x - iconSize / 2, py - iconSize / 2, iconSize, iconSize);
                ctx.restore();
            } else {
                // Fallback: standard pin dot
                ctx.fillStyle = pal.pin;
                ctx.shadowColor = pal.pin;
                ctx.shadowBlur = 18;
                ctx.beginPath();
                ctx.arc(pin.x, py, pinDotR * eased, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
            }

            // Outer ring
            ctx.strokeStyle = pal.pin;
            ctx.lineWidth = 2;
            const ringRadius = 14 + (1 - eased) * 14;
            ctx.globalAlpha = pinAlpha * eased;
            ctx.beginPath();
            ctx.arc(pin.x, py, ringRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = pinAlpha;

            // ── Label tag (GEOlayers-style: compact pill, small font, anchored to pin) ──
            const labelText = pin.label || '';
            const valueText = pin.value && pin.value !== '0' ? pin.value : '';
            const font = s.fontFamily || '"Segoe UI", Arial, sans-serif';

            const labelDelay = pinDelay + 0.15;
            const labelT = Math.min(1, Math.max(0, (elapsed - labelDelay) / 0.35));
            const labelEased = 1 - Math.pow(1 - labelT, 3);
            if (labelT <= 0) continue;
            ctx.globalAlpha = pinAlpha * labelEased;

            // Compact label: small font, tight pill shape, offset to the right of pin
            const labelFont = `bold 13px ${font}`;
            ctx.font = labelFont;
            const labelW = ctx.measureText(labelText).width;
            const tagH = 22;
            const tagPad = 8;
            const tagW = labelW + tagPad * 2;
            const tagX = pin.x + 16;
            const tagY = py - tagH / 2 - 2;

            // Thin leader line from pin to tag
            ctx.strokeStyle = pal.pin;
            ctx.lineWidth = 1;
            ctx.globalAlpha = pinAlpha * labelEased * 0.5;
            ctx.beginPath();
            ctx.moveTo(pin.x + pinDotR + 2, py);
            ctx.lineTo(tagX, py - 1);
            ctx.stroke();
            ctx.globalAlpha = pinAlpha * labelEased;

            // Tag background (dark pill with slight transparency)
            ctx.fillStyle = 'rgba(10,15,30,0.75)';
            ctx.shadowColor = 'rgba(0,0,0,0.3)';
            ctx.shadowBlur = 6;
            ctx.shadowOffsetY = 2;
            const tagR = tagH / 2;
            ctx.beginPath();
            ctx.moveTo(tagX + tagR, tagY);
            ctx.lineTo(tagX + tagW - tagR, tagY);
            ctx.arc(tagX + tagW - tagR, tagY + tagR, tagR, -Math.PI / 2, Math.PI / 2);
            ctx.lineTo(tagX + tagR, tagY + tagH);
            ctx.arc(tagX + tagR, tagY + tagR, tagR, Math.PI / 2, -Math.PI / 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Subtle left accent
            ctx.fillStyle = pal.pin;
            ctx.globalAlpha = pinAlpha * labelEased * 0.7;
            ctx.fillRect(tagX + 3, tagY + 4, 2, tagH - 8);
            ctx.globalAlpha = pinAlpha * labelEased;

            // Label text
            ctx.fillStyle = '#e8ecf0';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = labelFont;
            ctx.fillText(labelText, tagX + tagPad, tagY + tagH / 2 + 1);

            // Value (if any) — small, below the tag
            if (valueText) {
                ctx.font = `11px ${font}`;
                ctx.fillStyle = pal.pin;
                ctx.globalAlpha = pinAlpha * labelEased * 0.8;
                ctx.fillText(valueText, tagX + tagPad, tagY + tagH + 12);
            }

            ctx.globalAlpha = 1;
        }

        ctx.restore(); // End camera zoom transform

        // ── Bearing-only (no tilt): composite rotated offscreen ──
        if (useBearing && !useTilt && this._mapOffscreen) {
            ctx = _mainCtx;
            ctx.drawImage(this._mapOffscreen, 0, 0);
        }

        // ── PERSPECTIVE WARP: After Effects-style 3D camera tilt ──
        // Pivot at BOTTOM edge, camera looks down at an angle.
        // Bottom of map stays wide & anchored, top recedes to vanishing point.
        if (useTilt) {
            ctx = _mainCtx;
            const src = this._mapOffscreen;
            const tilt = tiltAmount;
            const STRIPS = 220;
            const srcStripH = H / STRIPS;

            const angle = tilt * 70 * (Math.PI / 180);
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            const focalLen = 1.4;

            const projY = new Float32Array(STRIPS + 1);
            const projScale = new Float32Array(STRIPS + 1);

            for (let i = 0; i <= STRIPS; i++) {
                const t = 1 - (i / STRIPS);
                const z = t * sinA + focalLen;
                const scale = focalLen / z;
                const yProj = t * cosA / z;
                projScale[i] = scale;
                projY[i] = yProj;
            }

            const bottomScreen = H;
            const projMax = projY[0];
            const projMin = projY[STRIPS];
            const projRange = projMax - projMin;
            const visibleH = H;

            const screenY = new Float32Array(STRIPS + 1);
            for (let i = 0; i <= STRIPS; i++) {
                const norm = (projY[i] - projMin) / projRange;
                screenY[i] = bottomScreen - norm * visibleH;
            }

            const bgColor = (mg.mapStyle === 'light' || mg.mapStyle === 'political') ? '#b8c4d0' : '#060a14';
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, W, H);

            for (let i = 0; i < STRIPS; i++) {
                const srcY = i * srcStripH;
                const dstY = screenY[i];
                const dstH = Math.abs(screenY[i + 1] - screenY[i]) + 0.5;
                const avgScale = (projScale[i] + projScale[i + 1]) / 2;
                // Always fill full width — scale source crop wider for narrowed strips
                const dstW = W;
                const srcCropW = W / avgScale; // wider source crop to compensate perspective narrowing
                const srcX = (W - srcCropW) / 2; // center the wider crop

                ctx.drawImage(src, Math.max(0, srcX), srcY, Math.min(srcCropW, W), srcStripH + 1,
                    0, dstY, dstW, dstH);
            }

            const hazeBottom = screenY[0];
            const hazeH = Math.max(hazeBottom * 0.6, 30);
            if (tilt > 0.1) {
                const haze = ctx.createLinearGradient(0, hazeBottom - hazeH * 0.3, 0, hazeBottom + hazeH);
                const hazeBase = (mg.mapStyle === 'light' || mg.mapStyle === 'political') ? '180,190,200' : '8,14,28';
                haze.addColorStop(0, `rgba(${hazeBase},${0.6 * tilt})`);
                haze.addColorStop(0.4, `rgba(${hazeBase},${0.25 * tilt})`);
                haze.addColorStop(1, `rgba(${hazeBase},0)`);
                ctx.fillStyle = haze;
                ctx.fillRect(0, 0, W, hazeBottom + hazeH);
            }

            const floorH = H * 0.04;
            const floor = ctx.createLinearGradient(0, H - floorH, 0, H);
            floor.addColorStop(0, 'rgba(0,0,0,0)');
            floor.addColorStop(1, `rgba(0,0,0,${0.15 * tilt})`);
            ctx.fillStyle = floor;
            ctx.fillRect(0, H - floorH, W, floorH);
        }

        // ── 6. Title bar (OUTSIDE camera transform — stays fixed at top) ──
        const title = mg.text || '';
        if (title) {
            const titleDelay = 0.1;
            const titleT = Math.min(1, Math.max(0, (elapsed - titleDelay) / 0.5));
            const titleEased = 1 - Math.pow(1 - titleT, 3);
            if (titleT > 0) {
                ctx.globalAlpha = opacity * titleEased;
                const font = s.fontFamily || 'Arial';
                ctx.font = `bold 42px ${font}`;
                const titleW = ctx.measureText(title).width;
                const barW = titleW + 80;
                const barH = 68;
                const barX = (W - barW) / 2;
                const barY = 24 - (1 - titleEased) * 30; // Slide down from top

                // Card background with strong shadow
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 20;
                ctx.shadowOffsetY = 5;
                ctx.fillStyle = pal.titleBg;
                ctx.beginPath();
                MGRenderer._roundRect(ctx, barX, barY, barW, barH, 14);
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.shadowOffsetY = 0;

                // Bottom accent line
                ctx.fillStyle = pal.titleBorder;
                ctx.fillRect(barX + 14, barY + barH - 4, barW - 28, 4);

                // Left accent stripe
                ctx.beginPath();
                MGRenderer._roundRect(ctx, barX, barY, 5, barH, 14);
                ctx.fill();
                ctx.fillRect(barX + 2, barY, 5, barH);

                // Title text
                ctx.fillStyle = pal.titleText;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(title, W / 2, barY + barH / 2);

                ctx.globalAlpha = opacity;
            }
        }

        // ── 7. Location indicator — REMOVED per user request (was "N locations"
        //      badge at bottom-left of map). Pin/polygon visuals speak for
        //      themselves; the badge read as debug UI in the final output.

        // ── 8. Vignette overlay ──
        const vignetteGrad = ctx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.7);
        vignetteGrad.addColorStop(0, 'transparent');
        vignetteGrad.addColorStop(1, pal.vignette);
        ctx.fillStyle = vignetteGrad;
        ctx.globalAlpha = opacity;
        ctx.fillRect(0, 0, W, H);

        ctx.globalAlpha = 1;
    }

    /**
     * Polygon fallback background for mapChart when no API map image is available.
     */
    _renderMapChartFallbackBg(ctx, mg, W, H, opacity, enterProgress, pal) {
        // Fallback ocean/land colors per style
        const FALLBACK_BG = {
            dark:      { ocean: '#0b1426', oceanGrad: '#0f1d35', land: '#1c3050', stroke: '#2a4a6e', grid: 'rgba(30,70,120,0.15)', gridAccent: 'rgba(40,90,150,0.25)' },
            natural:   { ocean: '#0e3350', oceanGrad: '#164468', land: '#2e6b3e', stroke: '#3a8050', grid: 'rgba(42,80,56,0.15)', gridAccent: 'rgba(50,100,70,0.25)' },
            satellite: { ocean: '#030a14', oceanGrad: '#081420', land: '#1a2818', stroke: '#253a22', grid: 'rgba(20,45,30,0.12)', gridAccent: 'rgba(30,60,40,0.2)' },
            light:     { ocean: '#c8dff0', oceanGrad: '#d8ecf8', land: '#e8ece8', stroke: '#b8c8b8', grid: 'rgba(150,170,190,0.2)', gridAccent: 'rgba(130,155,180,0.3)' },
            political: { ocean: '#8cb8d8', oceanGrad: '#a0cce8', land: '#e8dcc8', stroke: '#c0a888', grid: 'rgba(140,130,115,0.18)', gridAccent: 'rgba(120,108,90,0.28)' },
        };
        const fb = FALLBACK_BG[mg.mapStyle || 'dark'] || FALLBACK_BG.dark;

        // Ocean gradient
        const oceanGrad = ctx.createLinearGradient(0, 0, 0, H);
        oceanGrad.addColorStop(0, fb.oceanGrad);
        oceanGrad.addColorStop(0.5, fb.ocean);
        oceanGrad.addColorStop(1, fb.oceanGrad);
        ctx.fillStyle = oceanGrad;
        ctx.fillRect(0, 0, W, H);

        // Simplified continent polygons
        const CONTINENTS = [
            [[12,14],[20,12],[28,14],[32,18],[30,22],[34,26],[32,32],[28,38],[26,42],[22,44],[18,42],[14,38],[10,34],[8,28],[10,22],[12,18]],
            [[22,44],[24,46],[26,50],[24,52],[22,50],[20,48]],
            [[24,52],[28,52],[32,54],[34,58],[34,64],[32,72],[30,78],[26,82],[22,78],[20,72],[20,66],[22,58]],
            [[46,14],[50,12],[54,14],[56,18],[54,22],[52,26],[50,28],[48,30],[46,28],[44,24],[44,20],[44,16]],
            [[46,30],[50,28],[54,30],[56,34],[58,40],[58,48],[56,56],[54,62],[50,66],[46,64],[44,58],[42,50],[42,42],[44,36]],
            [[56,26],[60,24],[64,26],[62,30],[58,32],[56,30]],
            [[56,14],[62,10],[68,8],[76,10],[82,14],[86,16],[88,22],[86,28],[82,32],[78,34],[74,36],[70,34],[66,30],[62,26],[58,22],[56,18]],
            [[74,36],[78,38],[82,40],[84,44],[80,48],[76,46],[74,42]],
            [[66,30],[70,34],[68,42],[64,40],[62,34]],
            [[80,58],[86,56],[90,58],[92,62],[90,68],[86,70],[82,68],[80,64]],
            [[82,48],[84,48],[86,50],[84,52],[82,50]],
            [[86,50],[88,50],[90,52],[88,54],[86,52]],
        ];

        const landReveal = Math.min(1, enterProgress * 2.5);
        ctx.globalAlpha = opacity * landReveal;
        ctx.fillStyle = fb.land;
        for (const pts of CONTINENTS) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0] / 100 * W, pts[0][1] / 100 * H);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] / 100 * W, pts[i][1] / 100 * H);
            ctx.closePath();
            ctx.fill();
        }
        ctx.strokeStyle = fb.stroke;
        ctx.lineWidth = 1.5;
        for (const pts of CONTINENTS) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0] / 100 * W, pts[0][1] / 100 * H);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] / 100 * W, pts[i][1] / 100 * H);
            ctx.closePath();
            ctx.stroke();
        }

        // Grid lines
        const toXfb = (lon) => ((lon + 180) / 360) * W * 0.88 + W * 0.06;
        const toYfb = (lat) => ((90 - lat) / 180) * H * 0.82 + H * 0.06;
        const gridReveal = Math.min(1, Math.max(0, enterProgress * 3 - 0.5));
        ctx.globalAlpha = opacity * gridReveal * 0.6;
        ctx.strokeStyle = fb.grid;
        ctx.lineWidth = 0.8;
        for (let lat = -60; lat <= 80; lat += 30) {
            const y = toYfb(lat);
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        for (let lon = -150; lon <= 180; lon += 30) {
            const x = toXfb(lon);
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        ctx.strokeStyle = fb.gridAccent;
        ctx.lineWidth = 1.2;
        const eqY = toYfb(0);
        ctx.beginPath(); ctx.moveTo(0, eqY); ctx.lineTo(W, eqY); ctx.stroke();
        const pmX = toXfb(0);
        ctx.beginPath(); ctx.moveTo(pmX, 0); ctx.lineTo(pmX, H); ctx.stroke();

        ctx.globalAlpha = opacity;
    }

    // ========================================================================
    // EXPLAINER RENDERER
    // ========================================================================

    /**
     * Render an explainer MG: themed gradient background + transparent PNG image + label.
     * Variant/animation resolved via registry.
     */
    _renderExplainer(ctx, frame, fps, mg, s, anim, scriptContext) {
        const W = 1920, H = 1080;
        const { opacity } = anim;
        const speed = mg._animationSpeed || 1;
        const elapsed = frame / fps;

        // ── Resolve variant & animation ──
        const variant = this._resolveVariant(mg, s, 'explainer') || 'standard';
        const animType = this._resolveAnimation(mg, s, 'explainer') || 'fadeSlide';
        const ex = this._getExplainerStyle(mg, s);

        // Explainer is always an overlay card on top of video.
        // center = larger card centered, corner positions = smaller card in corner.
        const isCorner = mg.position && mg.position !== 'center';

        // ── Read custom properties ──
        const imgScaleMult = (mg.explainerImgScale != null ? mg.explainerImgScale : 100) / 100;
        // Theme styleName drives shadow preset; mg.explainerShadow (user) still wins.
        const shadowStyle = mg.explainerShadow || ex.shadowPreset || 'medium';

        ctx.save();
        ctx.globalAlpha = opacity;

        // Theme styleName drives accent; falls back to scene theme primary/accent.
        const primary = ex.accentFill || s.primary || '#3b82f6';
        const accent = s.accent || '#f59e0b';

        // ── Compute card positioning ──
        // All drawing uses local coords (0,0 = card center), then translate+scale to position
        let maxImgW, maxImgH, fontSize, subFontSize;
        let anchorX, anchorY;

        if (isCorner) {
            // Corner: compact card
            maxImgW = 200; maxImgH = 180;
            fontSize = 22; subFontSize = 15;
            const pos = mg.position || 'bottom-right';
            const margin = 60;
            if (pos.includes('left')) { anchorX = margin + maxImgW / 2; }
            else { anchorX = W - margin - maxImgW / 2; }
            if (pos.includes('top')) { anchorY = margin + maxImgH / 2 + 20; }
            else { anchorY = H - margin - 60; }
        } else {
            // Center: larger card
            maxImgW = 350; maxImgH = 300;
            fontSize = 32; subFontSize = 20;
            anchorX = W / 2;
            anchorY = H * 0.45;
        }

        // Card draws at local origin (0,0), transformed to anchor point + scale
        ctx.translate(anchorX, anchorY);
        ctx.scale(imgScaleMult, imgScaleMult);

        // Image area at local (0,0), label below
        const imgAreaCenterX = 0;
        const imgAreaCenterY = 0;
        const labelCenterX = 0;
        const labelY_base = maxImgH / 2 + 25;

        // ── Compute animation state ──
        let imgAlpha = opacity;
        let imgOffsetX = 0, imgOffsetY = 0;
        let imgScale = 1;
        let labelAlpha = opacity;
        let labelOffsetY = 0;

        const enterDur = 0.6 / speed;
        const exitDur = 0.4 / speed;
        const totalDur = (mg.duration || 5);
        const exitStart = totalDur - exitDur;
        const t = elapsed;

        const enterT = Math.min(1, t / enterDur);
        const easeEnter = 1 - Math.pow(1 - enterT, 3);

        let exitT = 0;
        if (t > exitStart) {
            exitT = Math.min(1, (t - exitStart) / exitDur);
        }
        const easeExit = 1 - Math.pow(1 - exitT, 2);

        // Slide direction depends on position for overlay mode
        const slideFromRight = !isCorner || (mg.position || '').includes('right');
        const slideDist = isCorner ? 250 : 400;

        if (animType === 'slideLeft' || variant === 'slideRight') {
            imgOffsetX = (1 - easeEnter) * (slideFromRight ? slideDist : -slideDist);
            imgAlpha = opacity * easeEnter;
            if (exitT > 0) {
                imgOffsetX = easeExit * (slideFromRight ? -slideDist * 0.75 : slideDist * 0.75);
                imgAlpha = opacity * (1 - easeExit);
            }
        } else if (animType === 'popUp') {
            const spring = easeEnter > 0.7 ? 1 + Math.sin((easeEnter - 0.7) / 0.3 * Math.PI) * 0.05 : easeEnter;
            imgScale = 0.3 + spring * 0.7;
            imgAlpha = opacity * Math.min(1, enterT * 2);
            imgOffsetY = (1 - easeEnter) * 80;
            if (exitT > 0) {
                imgScale = 1 - easeExit * 0.3;
                imgAlpha = opacity * (1 - easeExit);
            }
        } else {
            // fadeSlide (default)
            imgAlpha = opacity * easeEnter;
            imgOffsetY = (1 - easeEnter) * 60;
            if (exitT > 0) {
                imgAlpha = opacity * (1 - easeExit);
                imgOffsetY = -easeExit * 40;
            }
        }

        // Label appears slightly after image
        const labelDelay = 0.15 / speed;
        const labelEnterT = Math.min(1, Math.max(0, (t - labelDelay) / enterDur));
        const easeLabelEnter = 1 - Math.pow(1 - labelEnterT, 3);
        labelAlpha = opacity * easeLabelEnter;
        labelOffsetY = (1 - easeLabelEnter) * 30;
        if (exitT > 0) {
            labelAlpha = opacity * (1 - easeExit);
        }

        // ── Draw the image ──
        const imgFile = mg.explainerImageFile;
        const loadedImg = imgFile ? this._explainerImages[imgFile] : null;

        // Shadow presets — `glow` uses the theme's accent color
        const SHADOW_PRESETS = {
            none:   { color: 'transparent', blur: 0, offY: 0 },
            soft:   { color: 'rgba(0,0,0,0.25)', blur: 20, offY: 6 },
            medium: { color: 'rgba(0,0,0,0.5)', blur: 30, offY: 10 },
            heavy:  { color: 'rgba(0,0,0,0.7)', blur: 50, offY: 15 },
            glow:   { color: this._hexToRgba(primary, 0.5), blur: 40, offY: 0 },
        };
        const shadow = SHADOW_PRESETS[shadowStyle] || SHADOW_PRESETS.medium;
        // Style-driven glow on the image when style.glow is true
        if (ex.glow && shadowStyle === ex.shadowPreset && shadowStyle !== 'glow') {
            shadow.color = this._hexToRgba(primary, 0.35);
            shadow.blur = Math.max(shadow.blur, 30);
        }

        if (loadedImg) {
            const natW = loadedImg.naturalWidth || loadedImg.width;
            const natH = loadedImg.naturalHeight || loadedImg.height;
            const scale = Math.min(maxImgW / natW, maxImgH / natH) * imgScale;
            const drawW = natW * scale;
            const drawH = natH * scale;
            const drawX = imgAreaCenterX - drawW / 2 + imgOffsetX;
            const drawY = imgAreaCenterY - drawH / 2 + imgOffsetY;

            ctx.globalAlpha = imgAlpha;
            ctx.shadowColor = shadow.color;
            ctx.shadowBlur = shadow.blur;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = shadow.offY;
            ctx.drawImage(loadedImg, drawX, drawY, drawW, drawH);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        } else {
            // Placeholder: pulsing circle with "Loading..."
            ctx.globalAlpha = imgAlpha * 0.4;
            const pulseR = (isCorner ? 40 : 60) + Math.sin(elapsed * 2) * 10;
            ctx.beginPath();
            ctx.arc(imgAreaCenterX + imgOffsetX, imgAreaCenterY + imgOffsetY, pulseR * imgScale, 0, Math.PI * 2);
            ctx.fillStyle = primary;
            ctx.fill();

            ctx.globalAlpha = imgAlpha * 0.6;
            MGRenderer._setFont(ctx, '400', isCorner ? 14 : 18, s.fontBody);
            ctx.fillStyle = '#ffffff';
            const dots = '.'.repeat(1 + Math.floor(elapsed * 2) % 3);
            ctx.textAlign = 'center';
            ctx.fillText('Loading' + dots, imgAreaCenterX + imgOffsetX, imgAreaCenterY + imgOffsetY + pulseR * imgScale + 25);
        }

        // ── Draw the label ──
        const labelText = mg.explainerLabel || mg.text || '';
        const subText = mg.subtext || '';
        if (labelText) {
            ctx.globalAlpha = labelAlpha;
            const labelY = labelY_base + labelOffsetY;

            MGRenderer._setFont(ctx, ex.titleWeight, fontSize, s.fontHeading);
            ctx.textAlign = 'center';
            const titleW = ctx.measureText(labelText).width;
            MGRenderer._setFont(ctx, ex.subWeight, subFontSize, s.fontBody);
            const subW = subText ? ctx.measureText(subText).width : 0;
            const pillW = Math.max(titleW, subW) + (isCorner ? 40 : 60);
            const pillH = subText ? (isCorner ? 70 : 90) : (isCorner ? 45 : 60);
            const pillX = labelCenterX - pillW / 2;
            const pillY = labelY - pillH / 2;

            // Style-driven pill bg + radius
            ctx.fillStyle = ex.pillBg;
            const pillR = ex.pillRadius;
            ctx.beginPath();
            ctx.moveTo(pillX + pillR, pillY);
            ctx.lineTo(pillX + pillW - pillR, pillY);
            ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + pillR);
            ctx.lineTo(pillX + pillW, pillY + pillH - pillR);
            ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - pillR, pillY + pillH);
            ctx.lineTo(pillX + pillR, pillY + pillH);
            ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - pillR);
            ctx.lineTo(pillX, pillY + pillR);
            ctx.quadraticCurveTo(pillX, pillY, pillX + pillR, pillY);
            ctx.closePath();
            ctx.fill();

            // Accent line — style-driven height
            ctx.fillStyle = primary;
            ctx.fillRect(pillX + 12, pillY, pillW - 24, ex.accentLineH);

            // Title
            MGRenderer._setFont(ctx, ex.titleWeight, fontSize, s.fontHeading);
            ctx.fillStyle = ex.textFill || s.text || '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const titleY = subText ? pillY + pillH * 0.38 : pillY + pillH / 2;
            ctx.fillText(labelText, labelCenterX, titleY);

            if (subText) {
                MGRenderer._setFont(ctx, ex.subWeight, subFontSize, s.fontBody);
                ctx.fillStyle = ex.subFill || s.textSub || 'rgba(255,255,255,0.75)';
                ctx.fillText(subText, labelCenterX, pillY + pillH * 0.7);
            }
        }

        ctx.restore();
    }

    // ========================================================================
    // 17. ARTICLE HIGHLIGHT
    // ========================================================================

    _renderArticleHighlight(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { enterSpring, isExiting, exitProgress, opacity } = anim;
        const elapsed = frame / fps;
        const dur = mg.duration || 7;

        const articleImg = mg.articleImageFile ? this._articleImages[mg.articleImageFile] : null;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        if (articleImg) {
            // ── IMAGE MODE: article screenshot with highlight boxes ──
            const blurAmt = Math.max(0, 12 - elapsed * 12);
            const cardScale = 1 + elapsed * 0.01;
            const rotY = elapsed / dur * 6;

            // Center the image within 1920x1080 maintaining aspect ratio
            const imgAR = articleImg.naturalWidth / articleImg.naturalHeight;
            const maxW = 1920 * 0.85;
            const maxH = 1080 * 0.85;
            let drawW, drawH;
            if (imgAR > maxW / maxH) {
                drawW = maxW;
                drawH = maxW / imgAR;
            } else {
                drawH = maxH;
                drawW = maxH * imgAR;
            }
            const drawX = (1920 - drawW) / 2;
            const drawY = (1080 - drawH) / 2;

            ctx.translate(960, 540);
            ctx.scale(cardScale, cardScale);
            ctx.translate(-960, -540);

            // Card shadow
            ctx.shadowColor = 'rgba(0,0,0,0.35)';
            ctx.shadowBlur = 80;
            ctx.shadowOffsetY = 20;

            // Rounded clip for the card
            MGRenderer._roundRect(ctx, drawX, drawY, drawW, drawH, 12);
            ctx.clip();

            // Draw the article image
            ctx.drawImage(articleImg, drawX, drawY, drawW, drawH);

            // Reset shadow for overlays
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Yellow highlighter sweep boxes
            const hlBoxes = mg.highlightBoxes || [];
            for (let bi = 0; bi < hlBoxes.length; bi++) {
                const b = hlBoxes[bi];
                const yOff = (bi % 2 === 0) ? 0.3 : -0.2;
                const rot = (bi % 2 === 0) ? -0.3 : 0.4;
                const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - bi * 0.3) / 0.5));
                const sweepEased = 1 - Math.pow(1 - sweepProg, 2.5);
                if (sweepEased > 0) {
                    const bx = drawX + (b.x - 1) / 100 * drawW;
                    const by = drawY + (b.y + yOff) / 100 * drawH;
                    const bw = (b.w + 2) / 100 * drawW;
                    const bh = Math.max(b.h, 3.8) / 100 * drawH;
                    ctx.save();
                    ctx.translate(bx + bw / 2, by + bh / 2);
                    ctx.rotate(rot * Math.PI / 180);
                    // Clip to reveal sweep
                    const visibleW = bw * sweepEased;
                    ctx.beginPath();
                    ctx.rect(-bw / 2, -bh / 2, visibleW, bh);
                    ctx.clip();
                    ctx.fillStyle = 'rgba(255,230,0,0.38)';
                    MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 3);
                    ctx.fill();
                    ctx.restore();
                }
            }

            // Vignette overlay
            const vigGrad = ctx.createRadialGradient(960, 540, 200, 960, 540, 900);
            vigGrad.addColorStop(0, 'transparent');
            vigGrad.addColorStop(1, 'rgba(0,0,0,0.35)');
            ctx.fillStyle = vigGrad;
            ctx.fillRect(drawX, drawY, drawW, drawH);
        } else {
            // ── CARD MODE: generated article card ──
            const rawSub = mg.subtext || '';
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
                rawExcerpt = rawSub.trim();
            }

            // Strip ** markdown markers for plain text
            const cleanExcerpt = rawExcerpt.replace(/\*\*([^*]+)\*\*/g, '$1');

            // Extract highlight phrases
            const highlightPhrases = [];
            rawExcerpt.replace(/\*\*([^*]+)\*\*/g, (_, p) => highlightPhrases.push(p));
            if (highlightPhrases.length === 0 && cleanExcerpt.length > 0) {
                cleanExcerpt.replace(/\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?/gi, (m) => {
                    if (highlightPhrases.length < 3) highlightPhrases.push(m.trim());
                });
            }

            const blurAmt = Math.max(0, 12 - elapsed * 12);
            const cardScale = 1 + elapsed * 0.01;
            const enterDur = 0.4;
            const enterDone = elapsed >= enterDur;

            ctx.translate(960, 540);
            ctx.scale(cardScale, cardScale);
            ctx.translate(-960, -540);

            // Card dimensions
            const cardW = 1920 * 0.65;
            const cardH = 1080 * 0.65;
            const cardX = (1920 - cardW) / 2;
            const cardY = (1080 - cardH) / 2;

            // Card background
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 60;
            ctx.shadowOffsetY = 10;
            MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, 16);
            ctx.fillStyle = '#1a1a2e';
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            let yPos = cardY + 50;

            // Source
            if (artSource) {
                MGRenderer._setFont(ctx, '700', 20, s.fontBody);
                ctx.fillStyle = s.primary || '#3b82f6';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(artSource.toUpperCase(), cardX + 40, yPos);
                yPos += 40;
            }

            // Headline
            MGRenderer._setFont(ctx, '800', 44, s.fontHeading);
            ctx.fillStyle = s.text || '#ffffff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            const headlineLines = MGRenderer._wrapTextWords(ctx, mg.text || '', cardW - 80);
            for (const line of headlineLines) {
                ctx.fillText(line, cardX + 40, yPos);
                yPos += 56;
            }
            yPos += 10;

            // Separator line with animation
            const sepW = enterDone ? cardW - 80 : (cardW - 80) * (elapsed / enterDur);
            const sepGrad = ctx.createLinearGradient(cardX + 40, 0, cardX + 40 + sepW, 0);
            sepGrad.addColorStop(0, s.primary || '#3b82f6');
            sepGrad.addColorStop(1, s.accent || '#f59e0b');
            ctx.fillStyle = sepGrad;
            ctx.fillRect(cardX + 40, yPos, sepW, 3);
            yPos += 25;

            // Byline
            const byline = (artAuthor ? `By ${artAuthor}` : '') +
                (artAuthor && artDate ? '  ·  ' : '') + artDate;
            if (byline) {
                MGRenderer._setFont(ctx, '500', 20, s.fontBody);
                ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.6)';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(byline, cardX + 40, yPos);
                yPos += 36;
            }

            // Excerpt with highlight sweep
            if (cleanExcerpt) {
                yPos += 10;
                MGRenderer._setFont(ctx, '400', 24, s.fontBody);
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';

                const excerptLines = MGRenderer._wrapTextWords(ctx, `\u201C${cleanExcerpt}\u201D`, cardW - 80);
                for (let li = 0; li < excerptLines.length; li++) {
                    const lineText = excerptLines[li];
                    const lineY = yPos + li * 34;

                    // Draw highlight sweep behind matching phrases
                    for (let hi = 0; hi < highlightPhrases.length; hi++) {
                        const phrase = highlightPhrases[hi];
                        const idx = lineText.indexOf(phrase);
                        if (idx === -1) continue;
                        const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - hi * 0.4) / 0.5));
                        const sweepEased = 1 - Math.pow(1 - sweepProg, 2);
                        if (sweepEased > 0) {
                            const beforeW = ctx.measureText(lineText.substring(0, idx)).width;
                            const phraseW = ctx.measureText(phrase).width;
                            ctx.fillStyle = 'rgba(255,230,0,0.3)';
                            ctx.fillRect(cardX + 40 + beforeW, lineY - 2, phraseW * sweepEased, 30);
                        }
                    }

                    ctx.fillStyle = 'rgba(255,255,255,0.85)';
                    ctx.fillText(lineText, cardX + 40, lineY);
                }
            }
        }

        ctx.restore();
    }

    /**
     * Convert hex color to rgba string.
     */
    _hexToRgba(hex, alpha) {
        if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
        const h = hex.replace('#', '');
        if (h.length < 6) return `rgba(0,0,0,${alpha})`;
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    // ========================================================================
    // LISTICLE COUNTER — 4 variants (badge, pill, ribbon, minimal)
    // ========================================================================

    _renderListicleCounter(ctx, frame, fps, mg, s, anim) {
        const { interpolate, springValue } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale, enterFrames, enterSpring, enterLinear } = anim;

        const variant = this._resolveVariant(mg, s, 'listicleCounter');
        const colors = this._resolveColors(s, 'listicleCounter', mg);
        const cs = this._getCounterStyle(mg, s);

        // Parse "#3 Title" → number="3", title="Title"
        const match = (mg.text || '').match(/^#?(\d+)\s*(.*)/);
        const number = match ? match[1] : (mg.text || '?');
        const title = match ? match[2].trim() : (mg.subtext || '');

        // Animation type from dropdown
        const animationType = mg.animation || 'popUp';

        // Compute entrance based on animation type
        let entScale = 1, entSlideX = 0, entSlideY = 0, entRotation = 0;
        const titleReveal = interpolate(enterLinear, [0.3, 0.8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

        switch (animationType) {
            case 'popUp':
                entScale = interpolate(enterSpring, [0, 1], [0.5, 1]);
                entSlideY = interpolate(enterSpring, [0, 1], [40, 0]);
                break;
            case 'slideLeft':
                entScale = interpolate(enterSpring, [0, 1], [0.9, 1]);
                entSlideX = interpolate(enterSpring, [0, 1], [-300, 0]);
                break;
            case 'wipeRight':
                entScale = interpolate(enterSpring, [0, 1], [0.95, 1]);
                entSlideX = interpolate(enterSpring, [0, 1], [300, 0]);
                break;
            case 'fadeSlide':
                entSlideY = interpolate(enterSpring, [0, 1], [-50, 0]);
                break;
            case 'springScale':
                entScale = interpolate(enterSpring, [0, 1], [0.0, 1]);
                entRotation = interpolate(enterSpring, [0, 1], [-10, 0]) * Math.PI / 180;
                break;
            default:
                entScale = interpolate(enterSpring, [0, 1], [0.5, 1]);
                entSlideY = interpolate(enterSpring, [0, 1], [40, 0]);
        }

        const userScale = mg.scale || 1.3; // default 1.3 — bigger than before
        const scale = entScale * userScale * (isExiting ? interpolate(exitProgress, [0, 1], [0.9, 1]) : 1);

        // Measure for sizing — use actual render font sizes
        MGRenderer._setFont(ctx, '900', 48, s.fontHeading);
        const numW = ctx.measureText(number).width;
        MGRenderer._setFont(ctx, '700', 32, s.fontBody);
        const titleW = title ? ctx.measureText(title).width : 0;

        // Bigger boxes — readable on 1920x1080
        const badgeSize = 80; // circle/square for number
        const padding = 24;
        const titlePad = title ? titleW + 40 : 0;
        const boxW = variant === 'ribbon' ? Math.max(320, badgeSize + titlePad + 60) :
                     variant === 'pill' ? Math.max(300, 90 + titlePad + 30) :
                     variant === 'minimal' ? Math.max(260, numW + titlePad + 50) :
                     /* badge */ Math.max(280, badgeSize + titlePad + 30);
        const boxH = variant === 'ribbon' ? 90 : variant === 'minimal' ? 80 : 100;

        const pos = MGRenderer._getPosXY(mg.position || 'bottomLeft', boxW, boxH);

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        this._dispatchVariant(ctx, 'listicleCounter', variant, mg, s, anim, null, {
            bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors, cs,
            number, title, scale, entSlideX, entSlideY, entRotation, titleReveal, idleScale,
        });

        ctx.restore();
    }

    // ── Badge: Circle with number + dark panel with title ──
    _renderLC_Badge(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, cs, number, title, scale, entSlideX, entSlideY, entRotation, titleReveal, idleScale } = setup;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx + (entSlideX || 0), cy + (entSlideY || 0));
        if (entRotation) ctx.rotate(entRotation);
        ctx.scale(scale * idleScale, scale * idleScale);

        // Shadow
        if (cs.shadowBlur > 0) { ctx.shadowColor = cs.shadowColor; ctx.shadowBlur = cs.shadowBlur; ctx.shadowOffsetY = 3; }

        // Dark backing panel
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, cs.radius);
        ctx.fillStyle = cs.bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Border
        if (cs.borderWidth > 0) {
            ctx.strokeStyle = cs.borderColor;
            ctx.lineWidth = cs.borderWidth;
            ctx.stroke();
        }

        // Badge circle
        const badgeR = 36;
        const badgeCX = -bw / 2 + 52;
        if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 14; }
        ctx.beginPath();
        ctx.arc(badgeCX, 0, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = cs.accentFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Accent ring
        ctx.lineWidth = cs.borderWidth + 1;
        ctx.strokeStyle = cs.accentFill;
        ctx.stroke();

        // Number inside badge
        MGRenderer._setFont(ctx, cs.numberWeight, cs.numberSize, s.fontHeading);
        ctx.fillStyle = cs.numberFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;
        ctx.fillText(number, badgeCX, 2);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Title beside badge (clip reveal)
        if (title && titleReveal > 0) {
            ctx.save();
            const titleX = badgeCX + badgeR + 18;
            ctx.beginPath();
            ctx.rect(titleX, -bh / 2, (bw / 2 - badgeR - 18 + bw / 2 - 52) * titleReveal, bh);
            ctx.clip();
            MGRenderer._setFont(ctx, cs.titleWeight, cs.titleSize, s.fontBody);
            ctx.fillStyle = cs.textFill;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 8; }
            ctx.fillText(title, titleX, 2);
            ctx.restore();
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ── Pill: Rounded capsule with accent number section + title ──
    _renderLC_Pill(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, cs, number, title, scale, entSlideX, entSlideY, entRotation, titleReveal, idleScale } = setup;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx + (entSlideX || 0), cy + (entSlideY || 0));
        if (entRotation) ctx.rotate(entRotation);
        ctx.scale(scale * idleScale, scale * idleScale);

        const r = bh / 2;

        // Shadow
        if (cs.shadowBlur > 0) { ctx.shadowColor = cs.shadowColor; ctx.shadowBlur = cs.shadowBlur; ctx.shadowOffsetY = 3; }

        // Pill background
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, r);
        ctx.fillStyle = cs.bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Border
        if (cs.borderWidth > 0) {
            ctx.strokeStyle = cs.borderColor;
            ctx.lineWidth = cs.borderWidth;
            ctx.stroke();
        }

        // Number section (left, accent bg)
        const numSectionW = 80;
        ctx.save();
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, numSectionW, bh, [r, 0, 0, r]);
        ctx.clip();
        if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 10; }
        ctx.fillStyle = cs.accentFill;
        ctx.fillRect(-bw / 2, -bh / 2, numSectionW, bh);
        ctx.restore();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Number
        MGRenderer._setFont(ctx, cs.numberWeight, cs.numberSize, s.fontHeading);
        ctx.fillStyle = cs.numberFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(number, -bw / 2 + numSectionW / 2, 2);

        // Title (clip reveal)
        if (title && titleReveal > 0) {
            ctx.save();
            const titleX = -bw / 2 + numSectionW + 16;
            ctx.beginPath();
            ctx.rect(titleX, -bh / 2, (bw - numSectionW - 16) * titleReveal, bh);
            ctx.clip();
            MGRenderer._setFont(ctx, cs.titleWeight, cs.titleSize, s.fontBody);
            ctx.fillStyle = cs.textFill;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 8; }
            ctx.fillText(title, titleX, 2);
            ctx.restore();
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ── Ribbon: Flag shape with dark backing + accent stripe ──
    _renderLC_Ribbon(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, cs, number, title, scale, entSlideX, entSlideY, entRotation, titleReveal, idleScale } = setup;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx + (entSlideX || 0), cy + (entSlideY || 0));
        if (entRotation) ctx.rotate(entRotation);
        ctx.scale(scale * idleScale, scale * idleScale);

        const hw = bw / 2;
        const hh = bh / 2;

        // Shadow
        if (cs.shadowBlur > 0) { ctx.shadowColor = cs.shadowColor; ctx.shadowBlur = cs.shadowBlur; ctx.shadowOffsetY = 3; }

        // Ribbon shape (trapezoid with notch on right)
        ctx.beginPath();
        ctx.moveTo(-hw, -hh);
        ctx.lineTo(hw - 18, -hh);
        ctx.lineTo(hw, 0);
        ctx.lineTo(hw - 18, hh);
        ctx.lineTo(-hw, hh);
        ctx.closePath();
        ctx.fillStyle = cs.bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Border
        if (cs.borderWidth > 0) {
            ctx.strokeStyle = cs.borderColor;
            ctx.lineWidth = cs.borderWidth;
            ctx.stroke();
        }

        // Top accent stripe
        if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 10; }
        ctx.fillStyle = cs.accentFill;
        ctx.fillRect(-hw, -hh, bw, 5);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Number
        MGRenderer._setFont(ctx, cs.numberWeight, cs.numberSize, s.fontHeading);
        ctx.fillStyle = cs.accentFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`#${number}`, -hw + 20, 2);

        // Title
        if (title && titleReveal > 0) {
            ctx.save();
            const numEndX = -hw + 20 + ctx.measureText(`#${number}`).width + 16;
            ctx.beginPath();
            ctx.rect(numEndX, -hh, (hw - 18 - numEndX + hw) * titleReveal, bh);
            ctx.clip();
            MGRenderer._setFont(ctx, cs.titleWeight, cs.titleSize, s.fontBody);
            ctx.fillStyle = cs.textFill;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 8; }
            ctx.fillText(title, numEndX, 2);
            ctx.restore();
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ── Minimal: Number + underline + title, with subtle dark backing ──
    _renderLC_Minimal(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, cs, number, title, scale, entSlideX, entSlideY, entRotation, titleReveal, idleScale } = setup;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx + (entSlideX || 0), cy + (entSlideY || 0));
        if (entRotation) ctx.rotate(entRotation);
        ctx.scale(scale * idleScale, scale * idleScale);

        // Shadow
        if (cs.shadowBlur > 0) { ctx.shadowColor = cs.shadowColor; ctx.shadowBlur = cs.shadowBlur; ctx.shadowOffsetY = 2; }

        // Subtle dark backing
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -bw / 2 - 8, -bh / 2, bw + 16, bh, cs.radius);
        ctx.fillStyle = cs.bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Border
        if (cs.borderWidth > 0) {
            ctx.strokeStyle = cs.borderColor;
            ctx.lineWidth = cs.borderWidth;
            ctx.stroke();
        }

        // Number
        MGRenderer._setFont(ctx, cs.numberWeight, cs.numberSize, s.fontHeading);
        ctx.fillStyle = cs.accentFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 12; }
        else { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8; }
        const numText = `#${number}`;
        const numW = ctx.measureText(numText).width;
        ctx.fillText(numText, -bw / 2 + 8, -2);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Accent underline
        if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 6; }
        ctx.fillStyle = cs.accentFill;
        ctx.fillRect(-bw / 2 + 8, 22, (numW + 4) * titleReveal, 3);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Title
        if (title && titleReveal > 0) {
            ctx.save();
            const titleX = -bw / 2 + 8 + numW + 16;
            ctx.beginPath();
            ctx.rect(titleX, -bh / 2, (bw - numW - 16) * titleReveal, bh);
            ctx.clip();
            MGRenderer._setFont(ctx, cs.titleWeight, cs.titleSize, s.fontBody);
            ctx.fillStyle = cs.textFill;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            if (cs.glow) { ctx.shadowColor = cs.accentFill; ctx.shadowBlur = 8; }
            ctx.fillText(title, titleX, -2);
            ctx.restore();
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ========================================================================
    // PROGRESS TRACKER — 3 variants (bar, dots, fraction)
    // ========================================================================

    _renderProgressTracker(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale, enterSpring, enterLinear } = anim;

        const variant = this._resolveVariant(mg, s, 'progressTracker');
        const colors = this._resolveColors(s, 'progressTracker', mg);

        // Parse "2/5" or "Item 2 of 5" → current=2, total=5
        const fracMatch = (mg.text || '').match(/(\d+)\s*(?:\/|of)\s*(\d+)/i);
        const current = fracMatch ? parseInt(fracMatch[1]) : 1;
        const total = fracMatch ? parseInt(fracMatch[2]) : 5;
        const progress = total > 0 ? current / total : 0;

        // Entrance animation
        const entScale = interpolate(enterSpring, [0, 1], [0.8, 1]);
        const entSlideY = interpolate(enterSpring, [0, 1], [20, 0]);
        const fillReveal = interpolate(enterLinear, [0.2, 0.9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

        const scale = entScale * (isExiting ? interpolate(exitProgress, [0, 1], [0.9, 1]) : 1);

        const boxW = variant === 'dots' ? Math.max(280, total * 44 + 60) :
                     variant === 'fraction' ? 220 : 340;
        const boxH = variant === 'dots' ? 64 : variant === 'fraction' ? 72 : 56;

        const pos = MGRenderer._getPosXY(mg.position || 'topRight', boxW, boxH);

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        this._dispatchVariant(ctx, 'progressTracker', variant, mg, s, anim, null, {
            bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors,
            current, total, progress, scale, entSlideY, fillReveal, idleScale,
        });

        ctx.restore();
    }

    // ── Bar: Horizontal progress bar with segments ──
    _renderPT_Bar(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, current, total, progress, scale, entSlideY, fillReveal, idleScale } = setup;
        const accentFill = colors?.accentFill || s.primary;
        const trackFill = colors?.trackFill || 'rgba(255,255,255,0.2)';
        const textFill = colors?.textFill || '#ffffff';

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);

        // Dark backing panel
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -bw / 2 - 6, -bh / 2, bw + 12, bh, 12);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fill();

        const barW = bw - 30;
        const barH = 12;

        // Track background
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -barW / 2, -4, barW, barH, 6);
        ctx.fillStyle = trackFill;
        ctx.fill();

        // Filled portion (animated reveal)
        const fillW = barW * progress * fillReveal;
        if (fillW > 0) {
            ctx.beginPath();
            MGRenderer._roundRect(ctx, -barW / 2, -4, fillW, barH, 6);
            ctx.fillStyle = accentFill;
            ctx.fill();
        }

        // Segment markers
        if (total > 1 && total <= 20) {
            for (let i = 1; i < total; i++) {
                const segX = -barW / 2 + (barW * i / total);
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.fillRect(segX - 0.5, -4, 1, barH);
            }
        }

        // Label below bar
        MGRenderer._setFont(ctx, '700', 20, s.fontBody);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`${current} / ${total}`, 0, barH / 2 + 6);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ── Dots: Row of circles, filled up to current ──
    _renderPT_Dots(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, current, total, scale, entSlideY, fillReveal, idleScale } = setup;
        const accentFill = colors?.accentFill || s.primary;
        const trackFill = colors?.trackFill || 'rgba(255,255,255,0.25)';

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);

        // Dark backing pill
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -bw / 2 - 6, -bh / 2, bw + 12, bh, bh / 2);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fill();

        const dotR = 13;
        const gap = 38;
        const totalW = (total - 1) * gap;
        const startX = -totalW / 2;

        const revealedCount = Math.round(total * fillReveal);

        for (let i = 0; i < total; i++) {
            const dx = startX + i * gap;
            const filled = i < current && i < revealedCount;

            ctx.beginPath();
            ctx.arc(dx, 0, filled ? dotR : dotR - 3, 0, Math.PI * 2);
            ctx.fillStyle = filled ? accentFill : trackFill;
            ctx.fill();

            // Current dot gets ring
            if (i === current - 1 && i < revealedCount) {
                ctx.lineWidth = 3;
                ctx.strokeStyle = accentFill;
                ctx.beginPath();
                ctx.arc(dx, 0, dotR + 4, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ── Fraction: Large "2/5" display ──
    _renderPT_Fraction(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, current, total, scale, entSlideY, fillReveal, idleScale } = setup;
        const accentFill = colors?.accentFill || s.primary;
        const textFill = colors?.textFill || '#ffffff';

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);

        // Dark backing circle/pill
        ctx.beginPath();
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fill();

        // Current number (large, accent color)
        MGRenderer._setFont(ctx, '900', 48, s.fontHeading);
        ctx.fillStyle = accentFill;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;
        ctx.fillText(String(current), -8, 2);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Slash
        MGRenderer._setFont(ctx, '700', 38, s.fontHeading);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.textAlign = 'center';
        ctx.fillText('/', 0, 2);

        // Total number (smaller, dimmer)
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = textFill;
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = Math.min(prevAlpha, 0.6);
        ctx.textAlign = 'left';
        ctx.fillText(String(total), 8, 3);
        ctx.globalAlpha = prevAlpha;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ========================================================================
    // LISTICLE GRID — 3 variants (grid, strip, stack)
    // Fullscreen overview showing all list items at once
    // ========================================================================

    // ========================================================================
    // LOWER THIRD STYLE TOKENS — Controls visual look per style dropdown.
    // ========================================================================
    static _LOWER_THIRD_STYLES = {
        clean: {
            bgFill: 'rgba(12,20,40,0.82)', accentFill: '#3b82f6', textFill: '#ffffff',
            subFill: '#93c5fd', borderColor: 'rgba(59,130,246,0.2)', borderWidth: 1.5,
            shadowColor: 'rgba(0,0,0,0.4)', shadowBlur: 12, radius: 10,
            titleWeight: '700', titleSize: 36, subWeight: '500', subSize: 22,
            glow: false, barWidth: 4,
        },
        bold: {
            bgFill: 'rgba(40,8,8,0.88)', accentFill: '#ef4444', textFill: '#ffffff',
            subFill: '#fca5a5', borderColor: 'rgba(239,68,68,0.3)', borderWidth: 2.5,
            shadowColor: 'rgba(239,68,68,0.25)', shadowBlur: 16, radius: 6,
            titleWeight: '900', titleSize: 38, subWeight: '700', subSize: 24,
            glow: false, barWidth: 6,
        },
        minimal: {
            bgFill: 'rgba(0,0,0,0.35)', accentFill: '#94a3b8', textFill: 'rgba(255,255,255,0.92)',
            subFill: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
            shadowColor: 'none', shadowBlur: 0, radius: 6,
            titleWeight: '500', titleSize: 34, subWeight: '400', subSize: 20,
            glow: false, barWidth: 2,
        },
        neon: {
            bgFill: 'rgba(0,6,14,0.86)', accentFill: '#00ff88', textFill: '#ffffff',
            subFill: '#66ffbb', borderColor: 'rgba(0,255,136,0.3)', borderWidth: 1.5,
            shadowColor: 'rgba(0,255,136,0.35)', shadowBlur: 24, radius: 10,
            titleWeight: '800', titleSize: 36, subWeight: '600', subSize: 22,
            glow: true, barWidth: 4,
        },
        cinematic: {
            bgFill: 'rgba(12,8,0,0.85)', accentFill: '#d4af37', textFill: '#f5ecd0',
            subFill: '#c8a944', borderColor: 'rgba(212,175,55,0.2)', borderWidth: 1,
            shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 18, radius: 4,
            titleWeight: '600', titleSize: 34, subWeight: '400', subSize: 21,
            glow: false, barWidth: 3,
        },
        elegant: {
            bgFill: 'rgba(10,4,22,0.82)', accentFill: '#8b5cf6', textFill: '#ffffff',
            subFill: '#c4b5fd', borderColor: 'rgba(139,92,246,0.2)', borderWidth: 1.5,
            shadowColor: 'rgba(139,92,246,0.18)', shadowBlur: 20, radius: 16,
            titleWeight: '400', titleSize: 34, subWeight: '300', subSize: 21,
            glow: true, barWidth: 3,
        },
    };

    _getLowerThirdStyle(mg, s) {
        // Priority: mg.style (user-set) > theme's styleName > 'clean'
        const themeStyle = s?._mgOverrides?.lowerThird?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        const resolved = {
            ...(MGRenderer._LOWER_THIRD_STYLES[styleName] || MGRenderer._LOWER_THIRD_STYLES.clean),
        };
        const colors = mg?.colors && typeof mg.colors === 'object'
            ? mg.colors
            : (mg?.mgData?.colors && typeof mg.mgData.colors === 'object'
                ? mg.mgData.colors
                : {});
        if (colors.surface || colors.background) resolved.bgFill = colors.surface || colors.background;
        if (colors.primary || colors.accent) resolved.accentFill = colors.primary || colors.accent;
        if (colors.text) resolved.textFill = colors.text;
        if (colors.textMuted) resolved.subFill = colors.textMuted;
        if (mg?.transparentBackground === true || mg?.cardStyle === 'transparent') {
            resolved.bgFill = 'rgba(0,0,0,0)';
            resolved.borderColor = 'rgba(0,0,0,0)';
            resolved.borderWidth = 0;
            resolved.shadowColor = 'transparent';
            resolved.shadowBlur = 0;
        }
        return resolved;
    }

    // ========================================================================
    // HEADLINE STYLE TOKENS — per-style text shadow, color, weight, glow.
    // Parallels _LOWER_THIRD_STYLES / _COUNTER_STYLES. Selected by mg.style.
    // ========================================================================
    static _HEADLINE_STYLES = {
        clean: {
            textFill: '#ffffff', subFill: null, accentFill: null,
            shadowColor: 'rgba(0,0,0,0.85)', shadowBlur: 24, shadowY: 4,
            subShadowColor: 'rgba(0,0,0,0.7)', subShadowBlur: 12, subShadowY: 2,
            glow: false, glowColor: null, glowBlur: 0,
            titleWeight: '900', titleSize: 72, subWeight: '500', subSize: 26,
            outline: null, outlineWidth: 0,
        },
        bold: {
            textFill: '#ffffff', subFill: '#fca5a5', accentFill: '#ef4444',
            shadowColor: 'rgba(0,0,0,0.9)', shadowBlur: 20, shadowY: 5,
            subShadowColor: 'rgba(0,0,0,0.75)', subShadowBlur: 10, subShadowY: 2,
            glow: false, glowColor: null, glowBlur: 0,
            titleWeight: '900', titleSize: 76, subWeight: '700', subSize: 28,
            outline: '#000000', outlineWidth: 5,
        },
        minimal: {
            textFill: 'rgba(255,255,255,0.96)', subFill: 'rgba(255,255,255,0.7)', accentFill: null,
            shadowColor: 'rgba(0,0,0,0.4)', shadowBlur: 6, shadowY: 1,
            subShadowColor: 'rgba(0,0,0,0.3)', subShadowBlur: 4, subShadowY: 1,
            glow: false, glowColor: null, glowBlur: 0,
            titleWeight: '500', titleSize: 68, subWeight: '400', subSize: 22,
            outline: null, outlineWidth: 0,
        },
        neon: {
            textFill: '#ffffff', subFill: '#66ffbb', accentFill: '#00ff88',
            shadowColor: 'rgba(0,0,0,0.8)', shadowBlur: 14, shadowY: 2,
            subShadowColor: 'rgba(0,0,0,0.6)', subShadowBlur: 8, subShadowY: 1,
            glow: true, glowColor: '#00ff88', glowBlur: 30,
            titleWeight: '800', titleSize: 72, subWeight: '600', subSize: 26,
            outline: null, outlineWidth: 0,
        },
        cinematic: {
            textFill: '#f5ecd0', subFill: '#c8a944', accentFill: '#d4af37',
            shadowColor: 'rgba(0,0,0,0.85)', shadowBlur: 22, shadowY: 4,
            subShadowColor: 'rgba(0,0,0,0.7)', subShadowBlur: 10, subShadowY: 2,
            glow: false, glowColor: null, glowBlur: 0,
            titleWeight: '700', titleSize: 70, subWeight: '400', subSize: 25,
            outline: null, outlineWidth: 0,
        },
        elegant: {
            textFill: '#ffffff', subFill: '#c4b5fd', accentFill: '#8b5cf6',
            shadowColor: 'rgba(80,40,140,0.45)', shadowBlur: 18, shadowY: 3,
            subShadowColor: 'rgba(80,40,140,0.3)', subShadowBlur: 10, subShadowY: 2,
            glow: true, glowColor: '#8b5cf6', glowBlur: 22,
            titleWeight: '500', titleSize: 68, subWeight: '300', subSize: 24,
            outline: null, outlineWidth: 0,
        },
    };

    _getHeadlineStyle(mg, s) {
        // Priority: mg.style (user-set) > theme's styleName > 'clean'
        const themeStyle = s?._mgOverrides?.headline?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        return MGRenderer._HEADLINE_STYLES[styleName] || MGRenderer._HEADLINE_STYLES.clean;
    }

    static _normalizeTextRangeColor(value) {
        const text = String(value == null ? '' : value).trim().toLowerCase();
        const aliases = {
            red: '#ef4444', crimson: '#dc2626', scarlet: '#f43f5e',
            orange: '#f97316', amber: '#f59e0b', yellow: '#eab308',
            lime: '#84cc16', green: '#22c55e', emerald: '#10b981',
            teal: '#14b8a6', cyan: '#06b6d4', blue: '#3b82f6',
            indigo: '#6366f1', purple: '#8b5cf6', violet: '#7c3aed',
            pink: '#ec4899', rose: '#f43f5e', white: '#ffffff',
            black: '#000000', gray: '#6b7280', grey: '#6b7280',
            silver: '#c0c0c0', gold: '#f59e0b', brown: '#92400e',
        };
        if (aliases[text]) return aliases[text];
        if (/^#[0-9a-f]{3,4}$/i.test(text) || /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) {
            return text;
        }
        if (/^(?:rgba?|hsla?)\(\s*[-\d.%]+\s*(?:,\s*[-\d.%]+\s*){2}(?:,\s*[-\d.%]+\s*)?\)$/i.test(text)) {
            return text;
        }
        return '';
    }

    static _styledTextSegments(value, mg) {
        const text = String(value == null ? '' : value);
        const sourceRanges = mg?.textStyleRanges || mg?.mgData?.textStyleRanges;
        if (!text || !Array.isArray(sourceRanges) || !sourceRanges.length) {
            return [{ text, color: '' }];
        }
        const lower = text.toLocaleLowerCase();
        const intervals = [];
        sourceRanges.slice(0, 64).forEach((range, order) => {
            const match = String(range?.match ?? range?.text ?? range?.phrase ?? '').trim();
            const color = MGRenderer._normalizeTextRangeColor(
                range?.color ?? range?.textColor ?? range?.fill
            );
            if (!match || !color) return;
            const needle = match.toLocaleLowerCase();
            const indexes = [];
            let fromIndex = 0;
            while (fromIndex <= lower.length - needle.length) {
                const index = lower.indexOf(needle, fromIndex);
                if (index < 0) break;
                indexes.push(index);
                fromIndex = index + Math.max(1, needle.length);
            }
            const rawOccurrence = Number(range?.occurrence);
            const occurrence = Number.isInteger(rawOccurrence) && rawOccurrence >= 0
                ? rawOccurrence
                : 0;
            const selected = range?.allOccurrences === true || rawOccurrence === -1
                ? indexes
                : (indexes[occurrence] == null ? [] : [indexes[occurrence]]);
            selected.forEach((start) => intervals.push({
                start,
                end: start + needle.length,
                color,
                order,
            }));
        });
        intervals.sort((left, right) => (
            left.start - right.start
            || left.order - right.order
            || right.end - left.end
        ));
        const segments = [];
        let cursor = 0;
        for (const interval of intervals) {
            if (interval.start < cursor || interval.end <= interval.start) continue;
            if (interval.start > cursor) {
                segments.push({ text: text.slice(cursor, interval.start), color: '' });
            }
            segments.push({
                text: text.slice(interval.start, interval.end),
                color: interval.color,
            });
            cursor = interval.end;
        }
        if (cursor < text.length) segments.push({ text: text.slice(cursor), color: '' });
        return segments.length ? segments : [{ text, color: '' }];
    }

    static _drawStyledText(ctx, text, x, y, mg) {
        const segments = MGRenderer._styledTextSegments(text, mg);
        if (!segments.some((segment) => segment.color)) {
            ctx.fillText(text, x, y);
            return;
        }
        const originalAlign = ctx.textAlign;
        const originalFill = ctx.fillStyle;
        const totalWidth = ctx.measureText(text).width;
        let cursorX = x;
        if (originalAlign === 'center') cursorX -= totalWidth / 2;
        else if (originalAlign === 'right' || originalAlign === 'end') cursorX -= totalWidth;
        ctx.textAlign = 'left';
        for (const segment of segments) {
            ctx.fillStyle = segment.color || originalFill;
            ctx.fillText(segment.text, cursorX, y);
            cursorX += ctx.measureText(segment.text).width;
        }
        ctx.textAlign = originalAlign;
        ctx.fillStyle = originalFill;
    }

    // Paint headline text with per-style shadow/glow/outline. `isSub` switches
    // to the lighter subtext shadow tokens. Clears shadow at end, then paints a
    // final crisp fill on top to keep letter edges sharp.
    static _drawHeadlineText(ctx, text, x, y, ls, isSub, mg = null) {
        const blur = isSub ? ls.subShadowBlur : ls.shadowBlur;
        const color = isSub ? ls.subShadowColor : ls.shadowColor;
        const offY = isSub ? ls.subShadowY : ls.shadowY;

        if (ls.glow && !isSub && ls.glowColor && ls.glowBlur > 0) {
            ctx.shadowColor = color || 'rgba(0,0,0,0.85)';
            ctx.shadowBlur = blur || 20;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = offY || 0;
            MGRenderer._drawStyledText(ctx, text, x, y, mg);
            ctx.shadowColor = ls.glowColor;
            ctx.shadowBlur = ls.glowBlur;
            ctx.shadowOffsetY = 0;
            MGRenderer._drawStyledText(ctx, text, x, y, mg);
            ctx.shadowBlur = ls.glowBlur * 1.8;
            MGRenderer._drawStyledText(ctx, text, x, y, mg);
        } else if (blur > 0) {
            ctx.shadowColor = color || 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = blur;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = offY || 0;
            MGRenderer._drawStyledText(ctx, text, x, y, mg);
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        MGRenderer._drawStyledText(ctx, text, x, y, mg);
    }

    static _drawHeadlineWordCascade(ctx, text, x, y, ls, mg, cascade, options = {}) {
        const source = String(text || '');
        const matches = [...source.matchAll(/\S+/g)];
        if (!matches.length) return;

        const originalAlpha = ctx.globalAlpha;
        const originalAlign = ctx.textAlign;
        const totalWidth = ctx.measureText(source).width;
        const left = originalAlign === 'center'
            ? x - totalWidth / 2
            : (originalAlign === 'right' || originalAlign === 'end' ? x - totalWidth : x);
        const fontHeight = Math.max(36, Number(ls?.titleSize) || 72);

        matches.forEach((match, index) => {
            const localFrame = Number(cascade.frame) - index * Number(cascade.staggerFrames);
            const t = Math.max(
                0,
                Math.min(1, localFrame / Math.max(1, Number(cascade.revealFrames)))
            );
            if (t <= 0) return;

            const eased = 1 - Math.pow(1 - t, 3);
            const prefixWidth = ctx.measureText(source.slice(0, match.index)).width;
            const wordWidth = Math.max(1, ctx.measureText(match[0]).width);
            const wordLeft = left + prefixWidth;
            const wordCenter = wordLeft + wordWidth / 2;
            const rise = (1 - eased) * 42;
            const scale = 0.88 + eased * 0.12;

            ctx.save();
            ctx.beginPath();
            ctx.rect(
                wordLeft - 18,
                y - fontHeight,
                wordWidth + 36,
                fontHeight * 2.15
            );
            ctx.clip();
            ctx.globalAlpha = originalAlpha * t;
            ctx.translate(wordCenter, y);
            ctx.scale(scale, scale);
            ctx.translate(-wordCenter, -y + rise);

            if (options.outline && Number(options.outlineWidth) > 0) {
                ctx.strokeStyle = options.outline;
                ctx.lineWidth = Number(options.outlineWidth);
                ctx.lineJoin = 'round';
                ctx.miterLimit = 2;
                ctx.strokeText(source, x, y);
            }
            MGRenderer._drawHeadlineText(ctx, source, x, y, ls, false, mg);
            ctx.restore();
        });

        ctx.globalAlpha = originalAlpha;
        ctx.textAlign = originalAlign;
    }

    // ========================================================================
    // COUNTER STYLE TOKENS — Controls listicle counter badge/pill/ribbon/minimal look.
    // Separate from MG overlay styles and template styles.
    // ========================================================================
    static _COUNTER_STYLES = {
        clean: {
            bgFill: 'rgba(15,23,42,0.85)', accentFill: '#3b82f6', textFill: '#ffffff',
            numberFill: '#ffffff', borderColor: 'rgba(59,130,246,0.3)', borderWidth: 2,
            shadowColor: 'rgba(0,0,0,0.4)', shadowBlur: 10, radius: 16,
            numberWeight: '900', numberSize: 44, titleWeight: '700', titleSize: 30,
            glow: false,
        },
        bold: {
            bgFill: 'rgba(50,10,10,0.9)', accentFill: '#ef4444', textFill: '#ffffff',
            numberFill: '#ffffff', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 3,
            shadowColor: 'rgba(239,68,68,0.3)', shadowBlur: 14, radius: 8,
            numberWeight: '900', numberSize: 48, titleWeight: '800', titleSize: 32,
            glow: false,
        },
        minimal: {
            bgFill: 'rgba(0,0,0,0.45)', accentFill: '#94a3b8', textFill: 'rgba(255,255,255,0.9)',
            numberFill: '#ffffff', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
            shadowColor: 'none', shadowBlur: 0, radius: 10,
            numberWeight: '600', numberSize: 40, titleWeight: '400', titleSize: 28,
            glow: false,
        },
        neon: {
            bgFill: 'rgba(0,8,16,0.88)', accentFill: '#00ff88', textFill: '#ffffff',
            numberFill: '#000000', borderColor: 'rgba(0,255,136,0.35)', borderWidth: 2,
            shadowColor: 'rgba(0,255,136,0.4)', shadowBlur: 22, radius: 12,
            numberWeight: '900', numberSize: 46, titleWeight: '700', titleSize: 30,
            glow: true,
        },
        cinematic: {
            bgFill: 'rgba(15,10,0,0.88)', accentFill: '#d4af37', textFill: '#f0e6c8',
            numberFill: '#1a1000', borderColor: 'rgba(212,175,55,0.25)', borderWidth: 1.5,
            shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 16, radius: 6,
            numberWeight: '800', numberSize: 44, titleWeight: '600', titleSize: 30,
            glow: false,
        },
        elegant: {
            bgFill: 'rgba(12,4,24,0.85)', accentFill: '#8b5cf6', textFill: '#ffffff',
            numberFill: '#ffffff', borderColor: 'rgba(139,92,246,0.25)', borderWidth: 1.5,
            shadowColor: 'rgba(139,92,246,0.2)', shadowBlur: 18, radius: 20,
            numberWeight: '700', numberSize: 42, titleWeight: '300', titleSize: 28,
            glow: true,
        },
    };

    /** Resolve counter style tokens — counter-only, never touches MG or template styles */
    _getCounterStyle(mg, s) {
        // Priority: mg.style (user-set) > theme's styleName > 'clean'
        const themeStyle = s?._mgOverrides?.listicleCounter?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        return MGRenderer._COUNTER_STYLES[styleName] || MGRenderer._COUNTER_STYLES.clean;
    }

    // ========================================================================
    // TEMPLATE STYLE TOKENS — Completely separate from MG overlay styles.
    // Controls: colors, card shape, border, shadow, font weights, glow.
    // ========================================================================
    static _TEMPLATE_STYLES = {
        clean: {
            accent: '#3b82f6', accentText: '#ffffff', cardBg: 'rgba(20,30,60,0.85)',
            cardBorder: 'rgba(255,255,255,0.08)', cardRadius: 12, cardShadow: 'rgba(0,0,0,0.3)',
            cardShadowBlur: 8, titleWeight: '700', titleSize: 52, labelSize: 30, bodySize: 26, numberSize: 28,
            barWidth: 5, gridBg: 'rgba(0,0,10,0.92)', gridLine: 'rgba(255,255,255,0.05)',
            glow: false, fontOverride: null,
        },
        bold: {
            accent: '#ef4444', accentText: '#ffffff', cardBg: 'rgba(40,10,10,0.9)',
            cardBorder: 'rgba(239,68,68,0.3)', cardRadius: 6, cardShadow: 'rgba(239,68,68,0.2)',
            cardShadowBlur: 12, titleWeight: '900', titleSize: 58, labelSize: 34, bodySize: 28, numberSize: 32,
            barWidth: 8, gridBg: 'rgba(10,0,0,0.94)', gridLine: 'rgba(239,68,68,0.08)',
            glow: false, fontOverride: null,
        },
        minimal: {
            accent: '#94a3b8', accentText: '#0f172a', cardBg: 'rgba(255,255,255,0.06)',
            cardBorder: 'rgba(255,255,255,0.12)', cardRadius: 8, cardShadow: 'none',
            cardShadowBlur: 0, titleWeight: '400', titleSize: 46, labelSize: 28, bodySize: 24, numberSize: 24,
            barWidth: 2, gridBg: 'rgba(0,0,0,0.4)', gridLine: 'rgba(255,255,255,0.03)',
            glow: false, fontOverride: null,
        },
        neon: {
            accent: '#00ff88', accentText: '#000000', cardBg: 'rgba(0,10,20,0.88)',
            cardBorder: 'rgba(0,255,136,0.25)', cardRadius: 10, cardShadow: 'rgba(0,255,136,0.3)',
            cardShadowBlur: 20, titleWeight: '800', titleSize: 54, labelSize: 30, bodySize: 26, numberSize: 30,
            barWidth: 4, gridBg: 'rgba(0,0,15,0.92)', gridLine: 'rgba(0,255,136,0.06)',
            glow: true, fontOverride: null,
        },
        cinematic: {
            accent: '#d4af37', accentText: '#1a1000', cardBg: 'rgba(20,15,5,0.9)',
            cardBorder: 'rgba(212,175,55,0.2)', cardRadius: 4, cardShadow: 'rgba(0,0,0,0.5)',
            cardShadowBlur: 15, titleWeight: '600', titleSize: 50, labelSize: 30, bodySize: 26, numberSize: 28,
            barWidth: 3, gridBg: 'rgba(10,8,0,0.94)', gridLine: 'rgba(212,175,55,0.05)',
            glow: false, fontOverride: null,
        },
        elegant: {
            accent: '#8b5cf6', accentText: '#ffffff', cardBg: 'rgba(15,5,30,0.85)',
            cardBorder: 'rgba(139,92,246,0.2)', cardRadius: 16, cardShadow: 'rgba(139,92,246,0.15)',
            cardShadowBlur: 18, titleWeight: '300', titleSize: 48, labelSize: 28, bodySize: 24, numberSize: 26,
            barWidth: 3, gridBg: 'rgba(10,0,25,0.9)', gridLine: 'rgba(139,92,246,0.05)',
            glow: true, fontOverride: null,
        },
    };

    /** Resolve template style tokens — template-only, never touches MG styles.
     *  Optional `category` lets the theme override apply (e.g. listicleGrid). */
    _getTemplateStyle(mg, s, category) {
        const themeStyle = category && s?._mgOverrides?.[category]?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        const ts = MGRenderer._TEMPLATE_STYLES[styleName] || MGRenderer._TEMPLATE_STYLES.clean;
        return {
            ...ts,
            text: s.text || '#ffffff',
            textSub: s.textSub || 'rgba(255,255,255,0.7)',
            fontHeading: s.fontHeading || 'Arial, sans-serif',
            fontBody: s.fontBody || 'Arial, sans-serif',
        };
    }

    // ========================================================================
    // CALLOUT STYLE TOKENS — quote-box look. Drives text color, accent stripe,
    // shadow/glow, italic-vs-roman, decorative quote-mark opacity.
    // ========================================================================
    static _CALLOUT_STYLES = {
        clean: {
            bgFill: 'rgba(12,20,40,0.82)', textFill: '#ffffff', accentFill: '#3b82f6',
            subFill: 'rgba(255,255,255,0.75)', borderColor: 'rgba(59,130,246,0.25)', borderWidth: 2,
            shadowColor: 'rgba(0,0,0,0.4)', shadowBlur: 16, shadowY: 4, radius: 12,
            titleStyle: 'italic 600', titleSize: 34, subWeight: '500', subSize: 20,
            quoteFill: null, quoteSize: 64, quoteOpacity: 0.6,
            glow: false,
        },
        bold: {
            bgFill: 'rgba(40,8,8,0.88)', textFill: '#ffffff', accentFill: '#ef4444',
            subFill: '#fca5a5', borderColor: 'rgba(239,68,68,0.35)', borderWidth: 3,
            shadowColor: 'rgba(239,68,68,0.28)', shadowBlur: 18, shadowY: 5, radius: 6,
            titleStyle: '900', titleSize: 36, subWeight: '700', subSize: 22,
            quoteFill: null, quoteSize: 68, quoteOpacity: 0.75,
            glow: false,
        },
        minimal: {
            bgFill: 'rgba(0,0,0,0.35)', textFill: 'rgba(255,255,255,0.94)', accentFill: '#94a3b8',
            subFill: 'rgba(255,255,255,0.6)', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
            shadowColor: 'none', shadowBlur: 0, shadowY: 0, radius: 6,
            titleStyle: '500', titleSize: 32, subWeight: '400', subSize: 19,
            quoteFill: null, quoteSize: 56, quoteOpacity: 0.35,
            glow: false,
        },
        neon: {
            bgFill: 'rgba(0,8,16,0.86)', textFill: '#ffffff', accentFill: '#00ff88',
            subFill: '#66ffbb', borderColor: 'rgba(0,255,136,0.3)', borderWidth: 2,
            shadowColor: 'rgba(0,255,136,0.35)', shadowBlur: 24, shadowY: 0, radius: 10,
            titleStyle: 'italic 700', titleSize: 34, subWeight: '600', subSize: 20,
            quoteFill: null, quoteSize: 64, quoteOpacity: 0.8,
            glow: true,
        },
        cinematic: {
            bgFill: 'rgba(15,10,2,0.86)', textFill: '#f5ecd0', accentFill: '#d4af37',
            subFill: '#c8a944', borderColor: 'rgba(212,175,55,0.22)', borderWidth: 1.5,
            shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 18, shadowY: 4, radius: 4,
            titleStyle: 'italic 600', titleSize: 32, subWeight: '400', subSize: 20,
            quoteFill: null, quoteSize: 70, quoteOpacity: 0.55,
            glow: false,
        },
        elegant: {
            bgFill: 'rgba(12,4,24,0.82)', textFill: '#ffffff', accentFill: '#8b5cf6',
            subFill: '#c4b5fd', borderColor: 'rgba(139,92,246,0.22)', borderWidth: 1.5,
            shadowColor: 'rgba(139,92,246,0.2)', shadowBlur: 22, shadowY: 3, radius: 18,
            titleStyle: 'italic 500', titleSize: 32, subWeight: '300', subSize: 20,
            quoteFill: null, quoteSize: 64, quoteOpacity: 0.55,
            glow: true,
        },
    };

    _getCalloutStyle(mg, s) {
        const themeStyle = s?._mgOverrides?.callout?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        return MGRenderer._CALLOUT_STYLES[styleName] || MGRenderer._CALLOUT_STYLES.clean;
    }

    // ========================================================================
    // STAT COUNTER STYLE TOKENS — drives big-number weight, accent, shadow/glow,
    // ticker card chrome (bg + accent stripe). Sizes stay variant-driven.
    // ========================================================================
    static _STATCOUNTER_STYLES = {
        clean: {
            bgFill: 'rgba(15,23,42,0.85)', textFill: '#ffffff', accentFill: '#3b82f6',
            numberFill: null, subFill: 'rgba(255,255,255,0.78)',
            numberWeight: '900', labelWeight: '600',
            shadowColor: 'rgba(0,0,0,0.85)', shadowBlur: 12, shadowY: 4,
            labelShadowColor: 'rgba(0,0,0,0.7)', labelShadowBlur: 4,
            stripeColor: null, ringTrackColor: 'rgba(255,255,255,0.1)',
            radius: 10, glow: false,
        },
        bold: {
            bgFill: 'rgba(40,8,8,0.9)', textFill: '#ffffff', accentFill: '#ef4444',
            numberFill: null, subFill: '#fca5a5',
            numberWeight: '900', labelWeight: '800',
            shadowColor: 'rgba(0,0,0,0.9)', shadowBlur: 14, shadowY: 6,
            labelShadowColor: 'rgba(0,0,0,0.8)', labelShadowBlur: 5,
            stripeColor: null, ringTrackColor: 'rgba(255,255,255,0.12)',
            radius: 6, glow: false,
        },
        minimal: {
            bgFill: 'rgba(0,0,0,0.4)', textFill: 'rgba(255,255,255,0.94)', accentFill: '#94a3b8',
            numberFill: '#ffffff', subFill: 'rgba(255,255,255,0.6)',
            numberWeight: '600', labelWeight: '400',
            shadowColor: 'rgba(0,0,0,0.4)', shadowBlur: 6, shadowY: 1,
            labelShadowColor: 'rgba(0,0,0,0.3)', labelShadowBlur: 2,
            stripeColor: null, ringTrackColor: 'rgba(255,255,255,0.08)',
            radius: 8, glow: false,
        },
        neon: {
            bgFill: 'rgba(0,8,16,0.88)', textFill: '#ffffff', accentFill: '#00ff88',
            numberFill: null, subFill: '#66ffbb',
            numberWeight: '900', labelWeight: '700',
            shadowColor: 'rgba(0,0,0,0.7)', shadowBlur: 10, shadowY: 2,
            labelShadowColor: 'rgba(0,0,0,0.5)', labelShadowBlur: 4,
            stripeColor: null, ringTrackColor: 'rgba(0,255,136,0.12)',
            radius: 10, glow: true,
        },
        cinematic: {
            bgFill: 'rgba(15,10,2,0.88)', textFill: '#f5ecd0', accentFill: '#d4af37',
            numberFill: null, subFill: '#c8a944',
            numberWeight: '800', labelWeight: '600',
            shadowColor: 'rgba(0,0,0,0.85)', shadowBlur: 18, shadowY: 4,
            labelShadowColor: 'rgba(0,0,0,0.7)', labelShadowBlur: 6,
            stripeColor: null, ringTrackColor: 'rgba(212,175,55,0.12)',
            radius: 4, glow: false,
        },
        elegant: {
            bgFill: 'rgba(12,4,24,0.85)', textFill: '#ffffff', accentFill: '#8b5cf6',
            numberFill: null, subFill: '#c4b5fd',
            numberWeight: '700', labelWeight: '400',
            shadowColor: 'rgba(80,40,140,0.45)', shadowBlur: 16, shadowY: 3,
            labelShadowColor: 'rgba(80,40,140,0.3)', labelShadowBlur: 6,
            stripeColor: null, ringTrackColor: 'rgba(139,92,246,0.12)',
            radius: 16, glow: true,
        },
    };

    _getStatCounterStyle(mg, s) {
        const themeStyle = s?._mgOverrides?.statCounter?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        return MGRenderer._STATCOUNTER_STYLES[styleName] || MGRenderer._STATCOUNTER_STYLES.clean;
    }

    // ========================================================================
    // TYPEWRITER STYLE TOKENS — drives backdrop, text color, accent line/cursor,
    // shadow weight. Naked variant ignores bgFill (no backdrop).
    // ========================================================================
    static _TYPEWRITER_STYLES = {
        clean: {
            bgFill: 'rgba(0,0,0,0.65)', textFill: '#ffffff', accentFill: '#3b82f6',
            subFill: 'rgba(255,255,255,0.78)',
            textWeight: '700', subWeight: '500',
            shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 4, shadowY: 0,
            cardShadowColor: 'rgba(0,0,0,0.4)', cardShadowBlur: 12,
            accentLineH: 3, radius: 8, glow: false,
        },
        bold: {
            bgFill: 'rgba(40,8,8,0.9)', textFill: '#ffffff', accentFill: '#ef4444',
            subFill: '#fca5a5',
            textWeight: '900', subWeight: '700',
            shadowColor: 'rgba(0,0,0,0.85)', shadowBlur: 6, shadowY: 2,
            cardShadowColor: 'rgba(239,68,68,0.25)', cardShadowBlur: 14,
            accentLineH: 5, radius: 4, glow: false,
        },
        minimal: {
            bgFill: 'rgba(0,0,0,0.35)', textFill: 'rgba(255,255,255,0.94)', accentFill: '#94a3b8',
            subFill: 'rgba(255,255,255,0.6)',
            textWeight: '500', subWeight: '400',
            shadowColor: 'rgba(0,0,0,0.3)', shadowBlur: 2, shadowY: 0,
            cardShadowColor: 'none', cardShadowBlur: 0,
            accentLineH: 2, radius: 6, glow: false,
        },
        neon: {
            bgFill: 'rgba(0,8,16,0.86)', textFill: '#ffffff', accentFill: '#00ff88',
            subFill: '#66ffbb',
            textWeight: '800', subWeight: '600',
            shadowColor: 'rgba(0,0,0,0.7)', shadowBlur: 4, shadowY: 0,
            cardShadowColor: 'rgba(0,255,136,0.3)', cardShadowBlur: 18,
            accentLineH: 3, radius: 8, glow: true,
        },
        cinematic: {
            bgFill: 'rgba(15,10,2,0.85)', textFill: '#f5ecd0', accentFill: '#d4af37',
            subFill: '#c8a944',
            textWeight: '600', subWeight: '400',
            shadowColor: 'rgba(0,0,0,0.7)', shadowBlur: 6, shadowY: 2,
            cardShadowColor: 'rgba(0,0,0,0.5)', cardShadowBlur: 14,
            accentLineH: 2, radius: 4, glow: false,
        },
        elegant: {
            bgFill: 'rgba(12,4,24,0.82)', textFill: '#ffffff', accentFill: '#8b5cf6',
            subFill: '#c4b5fd',
            textWeight: '500', subWeight: '300',
            shadowColor: 'rgba(80,40,140,0.4)', shadowBlur: 6, shadowY: 2,
            cardShadowColor: 'rgba(139,92,246,0.2)', cardShadowBlur: 18,
            accentLineH: 2, radius: 14, glow: true,
        },
    };

    _getTypewriterStyle(mg, s) {
        const themeStyle = s?._mgOverrides?.typewriter?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        return MGRenderer._TYPEWRITER_STYLES[styleName] || MGRenderer._TYPEWRITER_STYLES.clean;
    }

    // ========================================================================
    // EXPLAINER STYLE TOKENS — drives pill backdrop, accent line, text color,
    // shadow preset key (resolves into SHADOW_PRESETS inside renderer).
    // ========================================================================
    static _EXPLAINER_STYLES = {
        clean: {
            pillBg: 'rgba(0,0,0,0.65)', textFill: '#ffffff', accentFill: '#3b82f6',
            subFill: 'rgba(255,255,255,0.78)',
            titleWeight: '700', subWeight: '400',
            pillRadius: 12, accentLineH: 3,
            shadowPreset: 'medium', glow: false,
        },
        bold: {
            pillBg: 'rgba(40,8,8,0.88)', textFill: '#ffffff', accentFill: '#ef4444',
            subFill: '#fca5a5',
            titleWeight: '900', subWeight: '700',
            pillRadius: 6, accentLineH: 5,
            shadowPreset: 'heavy', glow: false,
        },
        minimal: {
            pillBg: 'rgba(0,0,0,0.4)', textFill: 'rgba(255,255,255,0.94)', accentFill: '#94a3b8',
            subFill: 'rgba(255,255,255,0.6)',
            titleWeight: '500', subWeight: '400',
            pillRadius: 8, accentLineH: 1,
            shadowPreset: 'soft', glow: false,
        },
        neon: {
            pillBg: 'rgba(0,8,16,0.86)', textFill: '#ffffff', accentFill: '#00ff88',
            subFill: '#66ffbb',
            titleWeight: '800', subWeight: '600',
            pillRadius: 10, accentLineH: 3,
            shadowPreset: 'glow', glow: true,
        },
        cinematic: {
            pillBg: 'rgba(15,10,2,0.85)', textFill: '#f5ecd0', accentFill: '#d4af37',
            subFill: '#c8a944',
            titleWeight: '600', subWeight: '400',
            pillRadius: 4, accentLineH: 2,
            shadowPreset: 'heavy', glow: false,
        },
        elegant: {
            pillBg: 'rgba(12,4,24,0.82)', textFill: '#ffffff', accentFill: '#8b5cf6',
            subFill: '#c4b5fd',
            titleWeight: '500', subWeight: '300',
            pillRadius: 16, accentLineH: 2,
            shadowPreset: 'glow', glow: true,
        },
    };

    _getExplainerStyle(mg, s) {
        const themeStyle = s?._mgOverrides?.explainer?.styleName;
        const styleName = mg.style || themeStyle || 'clean';
        return MGRenderer._EXPLAINER_STYLES[styleName] || MGRenderer._EXPLAINER_STYLES.clean;
    }

    _renderListicleGrid(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;

        const variant = this._resolveVariant(mg, s, 'listicleGrid');
        const ts = this._getTemplateStyle(mg, s, 'listicleGrid');

        // Parse items: prioritize _listicleItems (most reliable), then subtext, then text
        let items = [];

        // 1. Direct listicle items (attached by generateListicleGridMG)
        if (mg._listicleItems && mg._listicleItems.length > 0) {
            items = mg._listicleItems.map(item => ({
                label: item.title || item.displayLabel || `Item ${item.itemNumber}`,
                value: String(item.itemNumber),
            }));
        }

        // 2. Subtext key:value pairs (comma-separated "Label:1, Label:2, ...")
        if (items.length === 0) {
            items = MGRenderer._parseKeyValuePairs(mg.subtext);
        }

        // 3. Fallback: split text by commas/semicolons/newlines
        if (items.length === 0 && mg.text) {
            items = (mg.text || '').split(/[,;]|\n/).map(t => t.trim()).filter(Boolean)
                .map((t, i) => {
                    const numMatch = t.match(/^#?(\d+)[.:)]\s*(.*)/);
                    return numMatch
                        ? { label: numMatch[2] || t, value: numMatch[1] }
                        : { label: t, value: String(i + 1) };
                });
        }

        const maxItems = Math.min(items.length, 8);
        const title = mg.text && !mg.text.match(/^#?\d/) ? mg.text : '';

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        // Collect loaded thumbnails for each item
        const thumbFiles = mg._itemThumbnails || [];
        const thumbs = items.slice(0, maxItems).map((_, i) => this._getGridThumb(thumbFiles[i]));

        const animationType = mg.animation || 'staggerSlide';

        this._dispatchVariant(ctx, 'listicleGrid', variant, mg, s, anim, null, {
            items: items.slice(0, maxItems), maxItems, title, thumbs, ts,
            frame, fps, enterFrames, isExiting, exitProgress, idleScale,
            hasMgBackground: !!(mg.mgBackground && mg.mgBackground !== 'none'),
            animationType,
        });

        ctx.restore();
    }

    /**
     * Compute per-card animation state for listicle grid templates.
     * Returns { offsetX, offsetY, scaleX, scaleY, alpha, rotation } for a single card.
     * @param {string} animationType - 'staggerSlide' | 'cascade' | 'flipIn'
     * @param {number} spring - spring progress 0→1
     * @param {number} i - card index
     * @param {number} maxItems - total items
     * @param {boolean} isExiting - exit phase
     * @param {number} exitProgress - exit 1→0
     * @param {string} variant - 'grid'|'strip'|'stack' for direction hints
     */
    _computeCardAnim(animationType, spring, i, maxItems, isExiting, exitProgress, variant) {
        const { interpolate } = AnimationUtils;
        const alpha = isExiting ? exitProgress : spring;

        switch (animationType) {
            case 'cascade': {
                // Cards cascade from top with increasing rotation
                const offsetY = interpolate(spring, [0, 1], [-200 - i * 40, 0]);
                const rotation = interpolate(spring, [0, 1], [-8 + i * 2, 0]) * Math.PI / 180;
                const scale = interpolate(spring, [0, 1], [0.7, 1]);
                return { offsetX: 0, offsetY, scaleX: scale, scaleY: scale, alpha, rotation };
            }
            case 'flipIn': {
                // Cards flip in with scaleY (simulated 3D flip via vertical squash)
                const scaleY = interpolate(spring, [0, 1], [0, 1]);
                const scaleX = interpolate(spring, [0, 1], [0.6, 1]);
                const offsetY = interpolate(spring, [0, 1], [30, 0]);
                return { offsetX: 0, offsetY, scaleX, scaleY, alpha, rotation: 0 };
            }
            case 'staggerSlide':
            default: {
                // Default: slide in from sides (grid), bottom (strip), left (stack)
                let offsetX = 0, offsetY = 0;
                if (variant === 'strip') {
                    offsetY = interpolate(spring, [0, 1], [60, 0]);
                } else if (variant === 'stack') {
                    offsetX = interpolate(spring, [0, 1], [-100, 0]);
                } else {
                    // Grid: alternate left/right columns
                    offsetX = interpolate(spring, [0, 1], [(i % 2 === 0 ? -80 : 80), 0]);
                }
                return { offsetX, offsetY, scaleX: 1, scaleY: 1, alpha, rotation: 0 };
            }
        }
    }

    // ── Grid: 2-column card grid with numbers ──
    // All visuals driven by template style tokens (setup.ts) — completely separate from MG styles
    _renderLG_Grid(ctx, mg, s, anim, _a, setup) {
        const { springValue, interpolate } = AnimationUtils;
        const { items, maxItems, title, frame, fps, enterFrames, isExiting, exitProgress, idleScale, thumbs, ts } = setup;

        const W = 1920, H = 1080;

        // Background (skip if mgBackground is set — drawn by _renderMGBackground)
        if (!setup.hasMgBackground) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        // Subtle grid pattern
        ctx.strokeStyle = ts.gridLine;
        ctx.lineWidth = 1;
        const gridSize = 60;
        for (let x = 0; x < W; x += gridSize) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let y = 0; y < H; y += gridSize) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        // Title
        let titleBottom = 120;
        if (title) {
            const titleSpring = springValue(Math.max(0, frame - Math.round(enterFrames * 0.05)), fps, { damping: 14, stiffness: 100 });
            const titleSlideY = interpolate(titleSpring, [0, 1], [-40, 0]);
            ctx.save();
            ctx.globalAlpha *= (isExiting ? exitProgress : titleSpring);
            MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize, ts.fontHeading);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 20; }
            else { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10; }
            ctx.fillText(title, W / 2, 90 + titleSlideY);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Accent underline
            const titleW = ctx.measureText(title).width;
            ctx.fillStyle = ts.accent;
            ctx.fillRect(W / 2 - titleW / 2, 120 + titleSlideY, titleW * titleSpring, ts.barWidth);
            ctx.restore();
            titleBottom = 160;
        }

        // Check if any thumbnails are available
        const hasThumbs = thumbs && thumbs.some(t => t);

        // Grid layout: 2 columns
        const cols = maxItems <= 3 ? 1 : 2;
        const rows = Math.ceil(maxItems / cols);
        const cardW = cols === 1 ? 800 : 680;
        const cardH = hasThumbs ? 160 : 90;
        const gapX = 40;
        const gapY = hasThumbs ? 24 : 18;
        const totalGridW = cols * cardW + (cols - 1) * gapX;
        const totalGridH = rows * cardH + (rows - 1) * gapY;
        const startX = (W - totalGridW) / 2;
        const startY = titleBottom + (H - titleBottom - totalGridH) / 2 - 20;

        const staggerDelay = Math.round(fps * 0.18);

        for (let i = 0; i < maxItems; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const cx = startX + col * (cardW + gapX);
            const cy = startY + row * (cardH + gapY);

            const cardDelay = Math.round(enterFrames * 0.15 + i * staggerDelay);
            const cardSpring = springValue(Math.max(0, frame - cardDelay), fps, { damping: 15, stiffness: 130 });
            const ca = this._computeCardAnim(setup.animationType, cardSpring, i, maxItems, isExiting, exitProgress, 'grid');

            ctx.save();
            ctx.globalAlpha = Math.min(1, idleScale) * ca.alpha;

            // Apply transform around card center
            const ctrX = cx + cardW / 2;
            const ctrY = cy + cardH / 2;
            ctx.translate(ctrX + ca.offsetX, ctrY + ca.offsetY);
            if (ca.rotation !== 0) ctx.rotate(ca.rotation);
            if (ca.scaleX !== 1 || ca.scaleY !== 1) ctx.scale(ca.scaleX, ca.scaleY);
            ctx.translate(-ctrX, -ctrY);

            // Card shadow
            if (ts.cardShadowBlur > 0) {
                ctx.shadowColor = ts.cardShadow;
                ctx.shadowBlur = ts.cardShadowBlur;
                ctx.shadowOffsetY = 4;
            }

            // Card background
            ctx.beginPath();
            MGRenderer._roundRect(ctx, cx, cy, cardW, cardH, ts.cardRadius);
            ctx.fillStyle = ts.cardBg;
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

            // Card border
            if (ts.cardBorder && ts.cardBorder !== 'none') {
                ctx.strokeStyle = ts.cardBorder;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                MGRenderer._roundRect(ctx, cx, cy, cardW, cardH, ts.cardRadius);
                ctx.stroke();
            }

            // Left accent bar
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 12; }
            ctx.fillStyle = ts.accent;
            MGRenderer._roundRect(ctx, cx, cy, ts.barWidth, cardH, [ts.cardRadius, 0, 0, ts.cardRadius]);
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Thumbnail (if available)
            const thumb = thumbs && thumbs[i];
            const thumbW = hasThumbs ? 150 : 0;
            const thumbPad = hasThumbs ? 10 : 0;
            if (thumb) {
                const tw = thumbW - thumbPad * 2;
                const th = cardH - thumbPad * 2;
                const tx = cx + ts.barWidth + 10;
                const ty = cy + thumbPad;
                ctx.save();
                ctx.beginPath();
                MGRenderer._roundRect(ctx, tx, ty, tw, th, Math.max(4, ts.cardRadius - 4));
                ctx.clip();
                const srcAspect = (thumb.videoWidth || thumb.naturalWidth || thumb.width) / (thumb.videoHeight || thumb.naturalHeight || thumb.height);
                const dstAspect = tw / th;
                let sx = 0, sy = 0, sw = thumb.width, sh = thumb.height;
                if (srcAspect > dstAspect) { sw = sh * dstAspect; sx = (thumb.width - sw) / 2; }
                else { sh = sw / dstAspect; sy = (thumb.height - sh) / 2; }
                ctx.drawImage(thumb, sx, sy, sw, sh, tx, ty, tw, th);
                ctx.restore();
                ctx.fillStyle = 'rgba(0,0,0,0.12)';
                ctx.beginPath();
                MGRenderer._roundRect(ctx, tx, ty, tw, th, Math.max(4, ts.cardRadius - 4));
                ctx.fill();
            }

            const contentX = cx + ts.barWidth + 10 + (hasThumbs ? thumbW : 0);

            // Number badge
            const badgeSize = 52;
            const badgeX = contentX + 12;
            const badgeY = cy + (cardH - badgeSize) / 2;
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 16; }
            ctx.beginPath();
            MGRenderer._roundRect(ctx, badgeX, badgeY, badgeSize, badgeSize, ts.cardRadius);
            ctx.fillStyle = ts.accent;
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            MGRenderer._setFont(ctx, '900', ts.numberSize, ts.fontHeading);
            ctx.fillStyle = ts.accentText;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(items[i].value || String(i + 1), badgeX + badgeSize / 2, badgeY + badgeSize / 2);

            // Item label
            MGRenderer._setFont(ctx, '600', ts.labelSize, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const labelX = badgeX + badgeSize + 16;
            const maxLabelW = cardW - (labelX - cx) - 16;
            ctx.save();
            ctx.beginPath();
            ctx.rect(labelX, cy, maxLabelW, cardH);
            ctx.clip();
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 6; }
            ctx.fillText(items[i].label, labelX, cy + cardH / 2);
            ctx.restore();

            ctx.restore();
        }
    }

    // ── Strip: Horizontal row of boxes ──
    // All visuals driven by template style tokens (setup.ts)
    _renderLG_Strip(ctx, mg, s, anim, _a, setup) {
        const { springValue, interpolate } = AnimationUtils;
        const { items, maxItems, title, frame, fps, enterFrames, isExiting, exitProgress, idleScale, thumbs, ts } = setup;

        const W = 1920, H = 1080;

        if (!setup.hasMgBackground) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        // Horizontal grid lines
        ctx.strokeStyle = ts.gridLine;
        ctx.lineWidth = 1;
        for (let y = 0; y < H; y += 80) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        // Title
        let titleBottom = H * 0.28;
        if (title) {
            const titleSpring = springValue(Math.max(0, frame - Math.round(enterFrames * 0.05)), fps, { damping: 14, stiffness: 100 });
            ctx.save();
            ctx.globalAlpha *= (isExiting ? exitProgress : titleSpring);
            MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize, ts.fontHeading);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 20; }
            else { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10; }
            ctx.fillText(title, W / 2, H * 0.2);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            ctx.restore();
            titleBottom = H * 0.32;
        }

        const hasThumbs = thumbs && thumbs.some(t => t);

        const gap = 20;
        const maxBoxW = Math.min(280, (W - 120 - (maxItems - 1) * gap) / maxItems);
        const boxH = hasThumbs ? 380 : 300;
        const totalStripW = maxItems * maxBoxW + (maxItems - 1) * gap;
        const startX = (W - totalStripW) / 2;
        const centerY = titleBottom + (H - titleBottom - boxH) / 2;

        const staggerDelay = Math.round(fps * 0.15);

        for (let i = 0; i < maxItems; i++) {
            const bx = startX + i * (maxBoxW + gap);

            const cardDelay = Math.round(enterFrames * 0.1 + i * staggerDelay);
            const cardSpring = springValue(Math.max(0, frame - cardDelay), fps, { damping: 14, stiffness: 140 });
            const ca = this._computeCardAnim(setup.animationType, cardSpring, i, maxItems, isExiting, exitProgress, 'strip');

            ctx.save();
            ctx.globalAlpha = ca.alpha;

            // Apply transform around box center
            const ctrX = bx + maxBoxW / 2;
            const ctrY = centerY + boxH / 2;
            ctx.translate(ctrX + ca.offsetX, ctrY + ca.offsetY);
            if (ca.rotation !== 0) ctx.rotate(ca.rotation);
            if (ca.scaleX !== 1 || ca.scaleY !== 1) ctx.scale(ca.scaleX, ca.scaleY);
            ctx.translate(-ctrX, -ctrY);

            const drawY = centerY;

            // Card shadow + background
            if (ts.cardShadowBlur > 0) { ctx.shadowColor = ts.cardShadow; ctx.shadowBlur = ts.cardShadowBlur; ctx.shadowOffsetY = 4; }
            ctx.beginPath();
            MGRenderer._roundRect(ctx, bx, drawY, maxBoxW, boxH, ts.cardRadius);
            ctx.fillStyle = ts.cardBg;
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

            // Card border
            if (ts.cardBorder && ts.cardBorder !== 'none') {
                ctx.strokeStyle = ts.cardBorder;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                MGRenderer._roundRect(ctx, bx, drawY, maxBoxW, boxH, ts.cardRadius);
                ctx.stroke();
            }

            // Top accent stripe
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 10; }
            ctx.save();
            ctx.beginPath();
            MGRenderer._roundRect(ctx, bx, drawY, maxBoxW, ts.barWidth, [ts.cardRadius, ts.cardRadius, 0, 0]);
            ctx.clip();
            ctx.fillStyle = ts.accent;
            ctx.fillRect(bx, drawY, maxBoxW, ts.barWidth);
            ctx.restore();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Thumbnail
            const thumb = thumbs && thumbs[i];
            let contentY = drawY + 14;
            if (hasThumbs) {
                const thumbH = 110;
                const thumbPad = 10;
                const tx = bx + thumbPad;
                const ty = drawY + ts.barWidth + 6;
                const tw = maxBoxW - thumbPad * 2;
                if (thumb) {
                    ctx.save();
                    ctx.beginPath();
                    MGRenderer._roundRect(ctx, tx, ty, tw, thumbH, Math.max(4, ts.cardRadius - 4));
                    ctx.clip();
                    const srcAspect = (thumb.videoWidth || thumb.naturalWidth || thumb.width) / (thumb.videoHeight || thumb.naturalHeight || thumb.height);
                    const dstAspect = tw / thumbH;
                    let sx = 0, sy = 0, sw = thumb.width, sh = thumb.height;
                    if (srcAspect > dstAspect) { sw = sh * dstAspect; sx = (thumb.width - sw) / 2; }
                    else { sh = sw / dstAspect; sy = (thumb.height - sh) / 2; }
                    ctx.drawImage(thumb, sx, sy, sw, sh, tx, ty, tw, thumbH);
                    ctx.restore();
                } else {
                    ctx.fillStyle = 'rgba(255,255,255,0.04)';
                    ctx.beginPath();
                    MGRenderer._roundRect(ctx, tx, ty, tw, thumbH, Math.max(4, ts.cardRadius - 4));
                    ctx.fill();
                }
                contentY = ty + thumbH + 8;
            }

            // Big number
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 14; }
            MGRenderer._setFont(ctx, '900', 48, ts.fontHeading);
            ctx.fillStyle = ts.accent;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(items[i].value || String(i + 1), bx + maxBoxW / 2, contentY + 30);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Separator line
            ctx.fillStyle = ts.cardBorder || 'rgba(255,255,255,0.1)';
            ctx.fillRect(bx + 20, contentY + 60, maxBoxW - 40, 1);

            // Item label (wrapped)
            MGRenderer._setFont(ctx, '500', 20, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const label = items[i].label;
            const wrapW = maxBoxW - 24;
            const words = label.split(' ');
            let line = '';
            let lineY = contentY + 72;
            for (const word of words) {
                const test = line ? `${line} ${word}` : word;
                if (ctx.measureText(test).width > wrapW && line) {
                    ctx.fillText(line, bx + maxBoxW / 2, lineY);
                    line = word;
                    lineY += 26;
                    if (lineY > drawY + boxH - 20) break;
                } else { line = test; }
            }
            if (line && lineY <= drawY + boxH - 20) ctx.fillText(line, bx + maxBoxW / 2, lineY);

            ctx.restore();
        }
    }

    // ── Stack: Vertical stacked bars sliding in from left ──
    // All visuals driven by template style tokens (setup.ts)
    _renderLG_Stack(ctx, mg, s, anim, _a, setup) {
        const { springValue, interpolate } = AnimationUtils;
        const { items, maxItems, title, frame, fps, enterFrames, isExiting, exitProgress, idleScale, thumbs, ts } = setup;

        const W = 1920, H = 1080;

        if (!setup.hasMgBackground) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        // Subtle diagonal grid
        ctx.strokeStyle = ts.gridLine;
        ctx.lineWidth = 1;
        for (let i = -H; i < W + H; i += 100) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + H, H); ctx.stroke();
        }

        // Title on left side
        let contentTop = 100;
        if (title) {
            const titleSpring = springValue(Math.max(0, frame - Math.round(enterFrames * 0.05)), fps, { damping: 14, stiffness: 100 });
            ctx.save();
            ctx.globalAlpha *= (isExiting ? exitProgress : titleSpring);
            const titleSlideX = interpolate(titleSpring, [0, 1], [-60, 0]);
            MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize - 6, ts.fontHeading);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 20; }
            else { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10; }
            ctx.fillText(title, 120 + titleSlideX, 80);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Accent underline
            const tw = ctx.measureText(title).width;
            ctx.fillStyle = ts.accent;
            ctx.fillRect(120 + titleSlideX, 106, tw * titleSpring, ts.barWidth);
            ctx.restore();
            contentTop = 140;
        }

        const hasThumbs = thumbs && thumbs.some(t => t);

        const barH = hasThumbs ? 80 : 64;
        const gap = 12;
        const totalStackH = maxItems * barH + (maxItems - 1) * gap;
        const startY = contentTop + (H - contentTop - totalStackH) / 2 - 10;
        const barMaxW = W * 0.75;
        const barStartX = 120;

        const staggerDelay = Math.round(fps * 0.2);

        for (let i = 0; i < maxItems; i++) {
            const by = startY + i * (barH + gap);

            const barDelay = Math.round(enterFrames * 0.12 + i * staggerDelay);
            const barSpring = springValue(Math.max(0, frame - barDelay), fps, { damping: 15, stiffness: 120 });
            const ca = this._computeCardAnim(setup.animationType, barSpring, i, maxItems, isExiting, exitProgress, 'stack');

            ctx.save();
            ctx.globalAlpha = ca.alpha;

            // Apply transform around bar center
            const ctrX = barStartX + barMaxW / 2;
            const ctrY = by + barH / 2;
            ctx.translate(ctrX + ca.offsetX, ctrY + ca.offsetY);
            if (ca.rotation !== 0) ctx.rotate(ca.rotation);
            if (ca.scaleX !== 1 || ca.scaleY !== 1) ctx.scale(ca.scaleX, ca.scaleY);
            ctx.translate(-ctrX, -ctrY);

            const bx = barStartX;

            // Bar wipe reveal (clip from left)
            const wipeProgress = AnimationUtils.interpolate(barSpring, [0, 1], [0, 1]);
            const barW = barMaxW * wipeProgress;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, bx, by, barW, barH, ts.cardRadius);
            ctx.clip();

            // Bar shadow + background
            if (ts.cardShadowBlur > 0) { ctx.shadowColor = ts.cardShadow; ctx.shadowBlur = ts.cardShadowBlur; ctx.shadowOffsetY = 3; }
            ctx.beginPath();
            MGRenderer._roundRect(ctx, bx, by, barMaxW, barH, ts.cardRadius);
            ctx.fillStyle = ts.cardBg;
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

            // Bar border
            if (ts.cardBorder && ts.cardBorder !== 'none') {
                ctx.strokeStyle = ts.cardBorder;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                MGRenderer._roundRect(ctx, bx, by, barMaxW, barH, ts.cardRadius);
                ctx.stroke();
            }

            // Left accent block
            const accentW = 56;
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 10; }
            ctx.fillStyle = ts.accent;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, bx, by, accentW, barH, [ts.cardRadius, 0, 0, ts.cardRadius]);
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Number in accent block
            MGRenderer._setFont(ctx, '900', ts.numberSize, ts.fontHeading);
            ctx.fillStyle = ts.accentText;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(items[i].value || String(i + 1), bx + accentW / 2, by + barH / 2);

            // Thumbnail (small square after accent block)
            const thumb = thumbs && thumbs[i];
            let labelStartX = bx + accentW + 20;
            if (hasThumbs) {
                const thumbSize = barH - 12;
                const tx = bx + accentW + 8;
                const ty = by + 6;
                if (thumb) {
                    ctx.save();
                    ctx.beginPath();
                    MGRenderer._roundRect(ctx, tx, ty, thumbSize, thumbSize, Math.max(4, ts.cardRadius - 4));
                    ctx.clip();
                    const srcAspect = (thumb.videoWidth || thumb.naturalWidth || thumb.width) / (thumb.videoHeight || thumb.naturalHeight || thumb.height);
                    let sx = 0, sy = 0, sw = thumb.width, sh = thumb.height;
                    if (srcAspect > 1) { sw = sh; sx = (thumb.width - sw) / 2; }
                    else { sh = sw; sy = (thumb.height - sh) / 2; }
                    ctx.drawImage(thumb, sx, sy, sw, sh, tx, ty, thumbSize, thumbSize);
                    ctx.restore();
                } else {
                    ctx.fillStyle = 'rgba(255,255,255,0.04)';
                    ctx.beginPath();
                    MGRenderer._roundRect(ctx, tx, ty, thumbSize, thumbSize, Math.max(4, ts.cardRadius - 4));
                    ctx.fill();
                }
                labelStartX = tx + thumbSize + 14;
            }

            // Item label
            MGRenderer._setFont(ctx, '600', ts.labelSize - 2, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 4; }
            ctx.fillText(items[i].label, labelStartX, by + barH / 2);

            ctx.restore();
        }
    }

    // ============================================================
    // TEMPLATE RENDERERS (from ai-templates.js pipeline)
    // ============================================================

    /**
     * Chapter Card — bold section header with accent bar and subtitle.
     * Used for documentary/explainer section transitions.
     */
    _renderChapterCard(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const hasMgBg = mg.mgBackground && mg.mgBackground !== 'none';

        if (!hasMgBg) {
            if (!this._drawTemplateBg(ctx, mg, W, H, 1)) {
                ctx.fillStyle = ts.gridBg;
                ctx.fillRect(0, 0, W, H);
            }
        }

        const enterFrames = Math.round(fps * 1.2);
        const mainSpring = springValue(frame, fps, { damping: 14, stiffness: 80 });
        const exitDur = Math.round(fps * 0.5);
        const totalFrames = Math.round((mg.duration || 4) * fps);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        // Accent bar (vertical, left side)
        const barW = ts.barWidth * 3;
        const barH = 220;
        const barX = W * 0.12;
        const barY = H / 2 - barH / 2;
        const barScale = interpolate(mainSpring, [0, 1], [0, 1]);
        ctx.fillStyle = ts.accent;
        ctx.fillRect(barX, barY + barH * (1 - barScale) / 2, barW, barH * barScale);

        // Glow effect on bar
        if (ts.glow) {
            ctx.shadowColor = ts.accent;
            ctx.shadowBlur = 30;
            ctx.fillRect(barX, barY + barH * (1 - barScale) / 2, barW, barH * barScale);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        }

        // Title text
        const textX = barX + barW + 40;
        const textSlide = interpolate(mainSpring, [0, 1], [80, 0]);
        const textSpring = springValue(Math.max(0, frame - Math.round(fps * 0.15)), fps, { damping: 16, stiffness: 100 });

        ctx.save();
        ctx.globalAlpha *= textSpring;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize + 8, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 12;
        ctx.fillText(mg.text || '', textX + textSlide, H / 2 - 30);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // Subtitle
        if (mg.subText || mg.subtext) {
            const subSpring = springValue(Math.max(0, frame - Math.round(fps * 0.3)), fps, { damping: 16, stiffness: 100 });
            const subSlide = interpolate(subSpring, [0, 1], [50, 0]);
            ctx.globalAlpha = Math.min(anim.opacity, exitAlpha) * subSpring;
            MGRenderer._setFont(ctx, '400', ts.labelSize + 2, ts.fontBody);
            ctx.fillStyle = ts.textSub || 'rgba(255,255,255,0.7)';
            ctx.fillText(mg.subText || mg.subtext || '', textX + subSlide, H / 2 + 30);
        }
        ctx.restore();

        // Horizontal accent line under text
        const lineW = interpolate(mainSpring, [0, 1], [0, W * 0.45]);
        ctx.fillStyle = ts.accent;
        ctx.globalAlpha *= 0.3;
        ctx.fillRect(textX, H / 2 + 60, lineW, 2);

        ctx.restore();
    }

    /**
     * Location Card — pin icon + location name + region subtitle.
     * Used when introducing a new geographic location.
     */
    _renderLocationCard(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const hasMgBg = mg.mgBackground && mg.mgBackground !== 'none';

        if (!hasMgBg) {
            if (!this._drawTemplateBg(ctx, mg, W, H, 1)) {
                ctx.fillStyle = ts.gridBg;
                ctx.fillRect(0, 0, W, H);
            }
        }

        const mainSpring = springValue(frame, fps, { damping: 12, stiffness: 90 });
        const totalFrames = Math.round((mg.duration || 3) * fps);
        const exitDur = Math.round(fps * 0.4);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        // Card background
        const cardW = 700;
        const cardH = 200;
        const cardX = (W - cardW) / 2;
        const cardY = (H - cardH) / 2;
        const cardScale = interpolate(mainSpring, [0, 1], [0.85, 1]);

        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(cardScale, cardScale);
        ctx.translate(-W / 2, -H / 2);

        // Card shape
        ctx.fillStyle = ts.cardBg;
        if (ts.cardShadow !== 'none') {
            ctx.shadowColor = ts.cardShadow;
            ctx.shadowBlur = ts.cardShadowBlur;
        }
        ctx.beginPath();
        MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, ts.cardRadius);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // Card border
        ctx.strokeStyle = ts.cardBorder;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, ts.cardRadius);
        ctx.stroke();

        // Pin icon (circle + triangle)
        const pinX = cardX + 60;
        const pinY = cardY + cardH / 2 - 15;
        ctx.fillStyle = ts.accent;
        ctx.beginPath();
        ctx.arc(pinX, pinY, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(pinX - 12, pinY + 10);
        ctx.lineTo(pinX + 12, pinY + 10);
        ctx.lineTo(pinX, pinY + 35);
        ctx.closePath();
        ctx.fill();
        // White dot center
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(pinX, pinY, 7, 0, Math.PI * 2);
        ctx.fill();

        // Location name
        const locTextX = pinX + 50;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize - 8, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(mg.text || '', locTextX, cardY + cardH / 2 - 20);

        // Region subtitle
        if (mg.subText || mg.subtext) {
            MGRenderer._setFont(ctx, '400', ts.labelSize - 2, ts.fontBody);
            ctx.fillStyle = ts.textSub || 'rgba(255,255,255,0.6)';
            ctx.fillText(mg.subText || mg.subtext || '', locTextX, cardY + cardH / 2 + 20);
        }

        ctx.restore(); // cardScale
        ctx.restore(); // main
    }

    /**
     * Quote Card — large quotation marks + quote text + attribution.
     * Used for notable quotes that deserve visual emphasis.
     */
    _renderQuoteCard(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);

        const mainSpring = springValue(frame, fps, { damping: 14, stiffness: 80 });
        const totalFrames = Math.round((mg.duration || 5) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;
        const transparentBg = this._isTransparentTemplateBackground(mg);

        // Background: template media (video/image) → static bg → solid fill
        if (!this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exitAlpha))) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        // Large quotation mark (opening)
        const quoteSpring = springValue(frame, fps, { damping: 10, stiffness: 120 });
        const quoteScale = interpolate(quoteSpring, [0, 1], [0.5, 1]);
        const quoteSlideY = interpolate(quoteSpring, [0, 1], [40, 0]);

        ctx.save();
        ctx.translate(W * 0.15, H * 0.3 + quoteSlideY);
        ctx.scale(quoteScale, quoteScale);
        ctx.fillStyle = ts.accent;
        ctx.globalAlpha *= 0.4;
        MGRenderer._setFont(ctx, '900', 180, 'Georgia, serif');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('\u201C', 0, 0);
        ctx.restore();

        // Quote text
        const textSpring = springValue(Math.max(0, frame - Math.round(fps * 0.2)), fps, { damping: 14, stiffness: 90 });
        const textAlpha = textSpring;
        const textSlideY = interpolate(textSpring, [0, 1], [30, 0]);

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha) * textAlpha;
        const quoteText = mg.text || '';
        MGRenderer._setFont(ctx, '500', Math.min(ts.titleSize, 44), ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 10;

        // Word wrap the quote
        const maxW = W * 0.6;
        const lines = MGRenderer._wrapTextWords(ctx, quoteText, maxW);
        const lineH = (ts.titleSize || 44) + 8;
        const startY = H / 2 - (lines.length * lineH) / 2 + textSlideY;
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], W / 2, startY + i * lineH);
        }
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // Attribution (subText)
        if (mg.subText || mg.subtext) {
            const attrSpring = springValue(Math.max(0, frame - Math.round(fps * 0.5)), fps, { damping: 16, stiffness: 100 });
            ctx.globalAlpha = Math.min(anim.opacity, exitAlpha) * attrSpring;
            MGRenderer._setFont(ctx, '400', ts.labelSize, ts.fontBody);
            ctx.fillStyle = ts.accent;
            const attrSlide = interpolate(attrSpring, [0, 1], [20, 0]);
            ctx.fillText(`\u2014 ${mg.subText || mg.subtext}`, W / 2, startY + lines.length * lineH + 30 + attrSlide);
        }
        ctx.restore();

        // Closing quotation mark
        ctx.save();
        ctx.translate(W * 0.8, H * 0.6 + quoteSlideY);
        ctx.scale(quoteScale, quoteScale);
        ctx.fillStyle = ts.accent;
        ctx.globalAlpha *= 0.25;
        MGRenderer._setFont(ctx, '900', 180, 'Georgia, serif');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('\u201D', 0, 0);
        ctx.restore();

        ctx.restore();
    }

    /**
     * Key Takeaway — highlight box with check/star icon + point text.
     * Used in conclusion sections for summary points.
     */
    _renderKeyTakeaway(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const totalFrames = Math.round((mg.duration || 4) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        // Background: template media (video/image) → static bg → solid fill
        if (!this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exitAlpha))) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        const mainSpring = springValue(frame, fps, { damping: 12, stiffness: 90 });

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        // Card
        const cardW = 900;
        const cardH = 240;
        const cardX = (W - cardW) / 2;
        const cardY = (H - cardH) / 2;
        const cardSlide = interpolate(mainSpring, [0, 1], [60, 0]);

        ctx.save();
        ctx.translate(0, cardSlide);

        // Card shadow + fill. Transparent template backgrounds are pure overlays:
        // text/accent only, no dark backing rectangle.
        if (!transparentBg) {
            if (ts.cardShadow !== 'none') {
                ctx.shadowColor = ts.cardShadow;
                ctx.shadowBlur = ts.cardShadowBlur + 5;
            }
            ctx.fillStyle = ts.cardBg;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, ts.cardRadius);
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        }

        // Accent left edge
        ctx.fillStyle = ts.accent;
        ctx.beginPath();
        MGRenderer._roundRect(ctx, cardX, cardY, 6, cardH, ts.cardRadius);
        ctx.fill();

        // Card border
        if (!transparentBg) {
            ctx.strokeStyle = ts.cardBorder;
            ctx.lineWidth = 1;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, ts.cardRadius);
            ctx.stroke();
        }

        // Star/key icon
        const iconX = cardX + 60;
        const iconY = cardY + cardH / 2;
        const iconSpring = springValue(Math.max(0, frame - Math.round(fps * 0.1)), fps, { damping: 10, stiffness: 150 });
        const iconScale = interpolate(iconSpring, [0, 1], [0, 1]);

        ctx.save();
        ctx.translate(iconX, iconY);
        ctx.scale(iconScale, iconScale);
        // Draw star
        ctx.fillStyle = ts.accent;
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
            const angle = (i * 72 - 90) * Math.PI / 180;
            const innerAngle = ((i * 72) + 36 - 90) * Math.PI / 180;
            const outerR = 22, innerR = 10;
            if (i === 0) ctx.moveTo(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
            else ctx.lineTo(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
            ctx.lineTo(Math.cos(innerAngle) * innerR, Math.sin(innerAngle) * innerR);
        }
        ctx.closePath();
        ctx.fill();
        if (ts.glow) {
            ctx.shadowColor = ts.accent;
            ctx.shadowBlur = 15;
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        }
        ctx.restore();

        // Takeaway text
        const textX = iconX + 55;
        const textSpring = springValue(Math.max(0, frame - Math.round(fps * 0.2)), fps, { damping: 14, stiffness: 100 });
        const textSlide = interpolate(textSpring, [0, 1], [40, 0]);

        ctx.save();
        ctx.globalAlpha *= textSpring;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize - 6, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 8;

        // Wrap text within card
        const maxTextW = cardW - (textX - cardX) - 40;
        const lines = MGRenderer._wrapTextWords(ctx, mg.text || '', maxTextW);
        const lineH = (ts.titleSize - 6) + 6;
        const textStartY = cardY + cardH / 2 - (lines.length * lineH) / 2 - 10 + textSlide;
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], textX, textStartY + i * lineH);
        }
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // Sub text
        if (mg.subText || mg.subtext) {
            MGRenderer._setFont(ctx, '400', ts.labelSize - 2, ts.fontBody);
            ctx.fillStyle = ts.textSub || 'rgba(255,255,255,0.6)';
            ctx.fillText(mg.subText || mg.subtext || '', textX, textStartY + lines.length * lineH + 10);
        }
        ctx.restore();

        ctx.restore(); // cardSlide
        ctx.restore(); // main
    }

    /**
     * Timeline Card — vertical line with date/event nodes.
     * Used for chronological event sequences.
     */
    _renderTimelineCard(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);

        const totalFrames = Math.round((mg.duration || 5) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        // Background: template media (video/image) → static bg → solid fill
        if (!this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exitAlpha))) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        // Parse items: "date: event; date: event" or from mg.items array
        let events = [];
        if (mg.items && mg.items.length > 0) {
            events = mg.items.map(item => {
                if (typeof item === 'string') {
                    const colonIdx = item.indexOf(':');
                    if (colonIdx > 0) return { date: item.substring(0, colonIdx).trim(), event: item.substring(colonIdx + 1).trim() };
                    return { date: '', event: item };
                }
                return { date: item.date || '', event: item.event || item.label || '' };
            });
        } else if (mg.subText || mg.subtext) {
            const parts = (mg.subText || mg.subtext || '').split(';');
            events = parts.map(p => {
                const colonIdx = p.indexOf(':');
                if (colonIdx > 0) return { date: p.substring(0, colonIdx).trim(), event: p.substring(colonIdx + 1).trim() };
                return { date: '', event: p.trim() };
            }).filter(e => e.event);
        }

        if (events.length === 0) {
            events = [{ date: '', event: mg.text || 'Event' }];
        }

        // Title
        const titleSpring = springValue(frame, fps, { damping: 14, stiffness: 100 });
        if (mg.text) {
            ctx.save();
            ctx.globalAlpha *= titleSpring;
            MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize - 4, ts.fontHeading);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 10;
            ctx.fillText(mg.text, W / 2, 80);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.restore();
        }

        // Vertical timeline line
        const lineX = W * 0.35;
        const lineTop = 140;
        const lineBottom = H - 80;
        const lineGrow = interpolate(titleSpring, [0, 1], [0, lineBottom - lineTop]);

        ctx.fillStyle = ts.accent;
        ctx.globalAlpha *= 0.4;
        ctx.fillRect(lineX - 1.5, lineTop, 3, lineGrow);
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        // Event nodes
        const maxEvents = Math.min(events.length, 6);
        const nodeGap = (lineBottom - lineTop) / Math.max(maxEvents, 1);
        const staggerDelay = Math.round(fps * 0.15);

        for (let i = 0; i < maxEvents; i++) {
            const event = events[i];
            const nodeY = lineTop + nodeGap * (i + 0.5);
            const nodeDelay = Math.round(fps * 0.3 + i * staggerDelay);
            const nodeSpring = springValue(Math.max(0, frame - nodeDelay), fps, { damping: 14, stiffness: 120 });
            const nodeScale = interpolate(nodeSpring, [0, 1], [0, 1]);
            const nodeSlide = interpolate(nodeSpring, [0, 1], [30, 0]);

            ctx.save();
            ctx.globalAlpha = Math.min(anim.opacity, exitAlpha) * nodeSpring;

            // Node circle
            ctx.fillStyle = ts.accent;
            ctx.beginPath();
            ctx.arc(lineX, nodeY, 8 * nodeScale, 0, Math.PI * 2);
            ctx.fill();
            if (ts.glow) {
                ctx.shadowColor = ts.accent;
                ctx.shadowBlur = 12;
                ctx.fill();
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
            }

            // Date label (left of line)
            if (event.date) {
                MGRenderer._setFont(ctx, '700', ts.labelSize - 2, ts.fontHeading);
                ctx.fillStyle = ts.accent;
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(event.date, lineX - 30 - nodeSlide, nodeY);
            }

            // Event text (right of line)
            MGRenderer._setFont(ctx, '500', ts.labelSize, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(event.event, lineX + 30 + nodeSlide, nodeY);

            ctx.restore();
        }

        ctx.restore();
    }

    /**
     * Fact Card — split-screen info panel.
     * Fact Card — 4 layout variants, each with matched entry animations.
     *   splitPanel: image left | dark panel right with staggered bullets (slides from right)
     *   overlay:    full bg image | centered semi-transparent card floats up
     *   sidebar:    image fills 75% | narrow dark strip on right with compact bullets
     *   numbered:   full darkened bg | large accent numbers beside each bullet
     */
    _renderFactCard(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'factCard') || 'splitPanel';
        switch (variant) {
            case 'overlay':   return this._renderFactCard_overlay(ctx, frame, fps, mg, s, anim);
            case 'sidebar':   return this._renderFactCard_sidebar(ctx, frame, fps, mg, s, anim);
            case 'numbered':  return this._renderFactCard_numbered(ctx, frame, fps, mg, s, anim);
            default:          return this._renderFactCard_splitPanel(ctx, frame, fps, mg, s, anim);
        }
    }

    // ── Shared helpers for all factCard variants ──

    /** Parse items array from mg, returns array of strings */
    _factCardItems(mg) {
        const raw = mg.items || mg._items || [];
        return raw.slice(0, 6).map(item =>
            typeof item === 'string' ? item : (item.text || item.event || '')
        ).filter(Boolean);
    }

    /** Compute exit state shared across all factCard variants */
    _factCardExit(frame, fps, mg) {
        const { interpolate } = AnimationUtils;
        const durSec = (mg.endTime && mg.startTime) ? (mg.endTime - mg.startTime) : (mg.duration > 100 ? mg.duration / fps : mg.duration || 5);
        const totalFrames = Math.round(durSec * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const t = isExiting ? (frame - (totalFrames - exitDur)) : 0;
        return {
            alpha: isExiting ? interpolate(t, [0, exitDur], [1, 0]) : 1,
            slide: isExiting ? interpolate(t, [0, exitDur], [0, 80]) : 0,
            scaleOut: isExiting ? interpolate(t, [0, exitDur], [1, 0.96]) : 1,
        };
    }

    // ── VARIANT: splitPanel ──
    // Image left half | dark panel slides in from right with staggered bullets
    _renderFactCard_splitPanel(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const exit = this._factCardExit(frame, fps, mg);
        const items = this._factCardItems(mg);

        // Left half: background image
        const panelX = W * 0.5;
        const hasBg = this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exit.alpha));
        if (!hasBg) {
            const leftGrad = ctx.createLinearGradient(0, 0, panelX, 0);
            leftGrad.addColorStop(0, 'rgba(15,15,20,0.95)');
            leftGrad.addColorStop(1, 'rgba(15,15,20,0.6)');
            ctx.fillStyle = leftGrad;
            ctx.fillRect(0, 0, panelX, H);
        }

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exit.alpha);

        // Panel slides from right
        const panelSpring = springValue(frame, fps, { damping: 14, stiffness: 70 });
        const panelSlideX = interpolate(panelSpring, [0, 1], [W * 0.3, 0]) + exit.slide;
        ctx.save();
        ctx.translate(panelSlideX, 0);

        // Dark panel background
        const panelGrad = ctx.createLinearGradient(panelX, 0, W, 0);
        panelGrad.addColorStop(0, 'rgba(10,10,15,0.97)');
        panelGrad.addColorStop(1, 'rgba(20,20,30,0.92)');
        ctx.fillStyle = panelGrad;
        ctx.fillRect(panelX, 0, W - panelX, H);

        // Accent line on left edge of panel
        const accentGrad = ctx.createLinearGradient(panelX, H * 0.15, panelX, H * 0.85);
        accentGrad.addColorStop(0, 'transparent');
        accentGrad.addColorStop(0.2, ts.accent);
        accentGrad.addColorStop(0.8, ts.accent);
        accentGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = accentGrad;
        ctx.fillRect(panelX, H * 0.15, 3, H * 0.7);

        // Title
        const titleDelay = Math.round(fps * 0.2);
        const titleSpring = springValue(Math.max(0, frame - titleDelay), fps, { damping: 14, stiffness: 100 });
        const titleSlide = interpolate(titleSpring, [0, 1], [40, 0]);
        const titleX = panelX + 60;
        const titleY = H * 0.18;
        const maxTitleW = (W - panelX) - 120;

        ctx.save();
        ctx.globalAlpha *= titleSpring;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize + 4, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 10;
        const titleLines = MGRenderer._wrapTextWords(ctx, mg.text || '', maxTitleW);
        const titleLineH = (ts.titleSize + 4) + 8;
        for (let i = 0; i < titleLines.length; i++) {
            ctx.fillText(titleLines[i], titleX, titleY + titleSlide + i * titleLineH);
        }
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Accent underline
        const underY = titleY + titleLines.length * titleLineH + 15;
        const underSpring = springValue(Math.max(0, frame - titleDelay - Math.round(fps * 0.1)), fps, { damping: 12, stiffness: 90 });
        const underW = interpolate(underSpring, [0, 1], [0, Math.min(maxTitleW * 0.4, 200)]);
        ctx.fillStyle = ts.accent;
        ctx.fillRect(titleX, underY, underW, 3);
        if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 12; ctx.fillRect(titleX, underY, underW, 3); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }
        ctx.restore();

        // Bullets
        this._factCardDrawBullets(ctx, frame, fps, ts, items, titleX, underY + 40, maxTitleW - 40, 58, anim);

        ctx.restore(); // panelSlideX
        ctx.restore(); // globalAlpha
    }

    // ── VARIANT: overlay ──
    // Full bg image | centered semi-transparent floating card with title + bullets
    _renderFactCard_overlay(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const exit = this._factCardExit(frame, fps, mg);
        const items = this._factCardItems(mg);

        // Full background image
        const hasBg = this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exit.alpha));
        if (!hasBg) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exit.alpha);

        // Card dimensions — centered, 60% width, dynamic height
        const cardW = W * 0.6;
        const cardX = (W - cardW) / 2;
        const cardPad = 50;
        const maxTextW = cardW - cardPad * 2;

        // Measure title height for card sizing
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize, ts.fontHeading);
        const titleLines = MGRenderer._wrapTextWords(ctx, mg.text || '', maxTextW);
        const titleBlockH = titleLines.length * (ts.titleSize + 8) + 20;

        MGRenderer._setFont(ctx, '500', ts.bodySize + 2, ts.fontBody);
        let bulletBlockH = 0;
        for (let i = 0; i < items.length; i++) {
            const lines = MGRenderer._wrapTextWords(ctx, items[i], maxTextW - 35);
            bulletBlockH += Math.max(1, lines.length) * (ts.bodySize + 6) + 16;
        }
        const cardH = Math.min(H * 0.78, titleBlockH + bulletBlockH + cardPad * 2 + 10);
        const cardY = (H - cardH) / 2;

        // Card entry: float up + fade
        const cardSpring = springValue(frame, fps, { damping: 16, stiffness: 60 });
        const cardSlideY = interpolate(cardSpring, [0, 1], [60, 0]);
        const cardScale = interpolate(cardSpring, [0, 1], [0.95, 1]);

        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(cardScale * exit.scaleOut, cardScale * exit.scaleOut);
        ctx.translate(-W / 2, -H / 2 + cardSlideY);

        // Card background — rounded rect with glass effect
        ctx.fillStyle = 'rgba(8,8,14,0.88)';
        MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, ts.cardRadius + 4);
        ctx.fill();

        // Card border glow
        ctx.strokeStyle = ts.accent + '30';
        ctx.lineWidth = 1.5;
        MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, ts.cardRadius + 4);
        ctx.stroke();

        // Title
        const titleDelay = Math.round(fps * 0.15);
        const titleSpring = springValue(Math.max(0, frame - titleDelay), fps, { damping: 14, stiffness: 100 });
        const titleX = cardX + cardPad;
        let curY = cardY + cardPad;

        ctx.save();
        ctx.globalAlpha *= titleSpring;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8;
        const titleSlide = interpolate(titleSpring, [0, 1], [20, 0]);
        for (let i = 0; i < titleLines.length; i++) {
            ctx.fillText(titleLines[i], titleX + titleSlide, curY + i * (ts.titleSize + 8));
        }
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        curY += titleBlockH;

        // Accent divider
        const divSpring = springValue(Math.max(0, frame - titleDelay - Math.round(fps * 0.1)), fps, { damping: 12, stiffness: 90 });
        const divW = interpolate(divSpring, [0, 1], [0, Math.min(maxTextW * 0.35, 180)]);
        ctx.fillStyle = ts.accent;
        ctx.fillRect(titleX, curY - 10, divW, 3);
        ctx.restore();

        // Bullets with stagger
        curY += 10;
        const staggerDelay = Math.round(fps * 0.2);
        for (let i = 0; i < items.length && i < 6; i++) {
            const itemDelay = Math.round(fps * 0.35) + i * staggerDelay;
            const itemSpring = springValue(Math.max(0, frame - itemDelay), fps, { damping: 14, stiffness: 110 });
            const itemSlide = interpolate(itemSpring, [0, 1], [25, 0]);

            ctx.save();
            ctx.globalAlpha *= itemSpring;

            // Accent dot
            ctx.fillStyle = ts.accent;
            ctx.beginPath();
            ctx.arc(titleX + 5, curY + (ts.bodySize + 2) / 2, 4 * itemSpring, 0, Math.PI * 2);
            ctx.fill();

            // Text
            MGRenderer._setFont(ctx, '500', ts.bodySize + 2, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 4;
            const bulletLines = MGRenderer._wrapTextWords(ctx, items[i], maxTextW - 35);
            for (let j = 0; j < bulletLines.length; j++) {
                ctx.fillText(bulletLines[j], titleX + 22 + itemSlide, curY + j * (ts.bodySize + 6));
            }
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            curY += Math.max(1, bulletLines.length) * (ts.bodySize + 6) + 16;
            ctx.restore();
        }

        ctx.restore(); // card transform
        ctx.restore(); // globalAlpha
    }

    // ── VARIANT: sidebar ──
    // Image fills 75% | narrow dark sidebar on right with compact stacked bullets
    _renderFactCard_sidebar(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const exit = this._factCardExit(frame, fps, mg);
        const items = this._factCardItems(mg);

        // Sidebar dimensions
        const sideW = Math.round(W * 0.28);
        const sideX = W - sideW;

        // Full background image (covers everything, sidebar overlaps)
        const hasBg = this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exit.alpha));
        if (!hasBg) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exit.alpha);

        // Sidebar slides in from right edge
        const sideSpring = springValue(frame, fps, { damping: 18, stiffness: 65 });
        const sideSlide = interpolate(sideSpring, [0, 1], [sideW + 20, 0]) + exit.slide;

        ctx.save();
        ctx.translate(sideSlide, 0);

        // Sidebar background — dark with soft left edge fade
        const sideGrad = ctx.createLinearGradient(sideX - 40, 0, sideX + 30, 0);
        sideGrad.addColorStop(0, 'rgba(8,8,14,0)');
        sideGrad.addColorStop(1, 'rgba(8,8,14,0.94)');
        ctx.fillStyle = sideGrad;
        ctx.fillRect(sideX - 40, 0, sideW + 40, H);

        // Solid core
        ctx.fillStyle = 'rgba(8,8,14,0.94)';
        ctx.fillRect(sideX + 20, 0, sideW - 20, H);

        // Accent strip on left edge
        ctx.fillStyle = ts.accent;
        ctx.fillRect(sideX + 18, H * 0.08, 2, H * 0.84);

        // Title — compact, inside sidebar
        const padX = sideX + 38;
        const maxW = sideW - 56;
        const titleDelay = Math.round(fps * 0.2);
        const titleSpring = springValue(Math.max(0, frame - titleDelay), fps, { damping: 14, stiffness: 100 });

        let curY = H * 0.1;
        ctx.save();
        ctx.globalAlpha *= titleSpring;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize - 8, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8;
        const titleLines = MGRenderer._wrapTextWords(ctx, mg.text || '', maxW);
        const titleLineH = (ts.titleSize - 8) + 6;
        const titleSlide = interpolate(titleSpring, [0, 1], [20, 0]);
        for (let i = 0; i < titleLines.length; i++) {
            ctx.fillText(titleLines[i], padX, curY + titleSlide + i * titleLineH);
        }
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        curY += titleLines.length * titleLineH + 18;

        // Short accent underline
        const uSpring = springValue(Math.max(0, frame - titleDelay - Math.round(fps * 0.1)), fps, { damping: 12, stiffness: 90 });
        ctx.fillStyle = ts.accent;
        ctx.fillRect(padX, curY, interpolate(uSpring, [0, 1], [0, Math.min(maxW * 0.5, 140)]), 2);
        curY += 24;
        ctx.restore();

        // Compact bullets — tighter spacing for narrow strip
        const bulletGap = 48;
        const staggerDelay = Math.round(fps * 0.22);
        for (let i = 0; i < items.length && i < 6; i++) {
            const itemDelay = Math.round(fps * 0.45) + i * staggerDelay;
            const itemSpring = springValue(Math.max(0, frame - itemDelay), fps, { damping: 14, stiffness: 110 });
            const itemSlide = interpolate(itemSpring, [0, 1], [15, 0]);

            ctx.save();
            ctx.globalAlpha *= itemSpring;

            // Small accent dash instead of dot
            ctx.fillStyle = ts.accent;
            ctx.fillRect(padX, curY + (ts.bodySize - 2) / 2, 10, 2);

            // Text
            MGRenderer._setFont(ctx, '500', ts.bodySize - 2, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            const bulletLines = MGRenderer._wrapTextWords(ctx, items[i], maxW - 24);
            for (let j = 0; j < bulletLines.length; j++) {
                ctx.fillText(bulletLines[j], padX + 18 + itemSlide, curY + j * (ts.bodySize + 2));
            }
            curY += Math.max(1, bulletLines.length) * (ts.bodySize + 2) + (bulletGap - (ts.bodySize + 2));
            ctx.restore();
        }

        ctx.restore(); // sideSlide
        ctx.restore(); // globalAlpha
    }

    // ── VARIANT: numbered ──
    // Full darkened bg | large accent numbers + editorial bullet layout
    _renderFactCard_numbered(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const exit = this._factCardExit(frame, fps, mg);
        const items = this._factCardItems(mg);

        // Full bg with heavy darken for readability
        const hasBg = this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exit.alpha) * 0.45);
        if (!hasBg) {
            ctx.fillStyle = ts.gridBg;
            ctx.fillRect(0, 0, W, H);
        }
        // Dark overlay scrim
        ctx.fillStyle = 'rgba(5,5,10,0.7)';
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exit.alpha);

        // Title — top-center, bold
        const titleSpring = springValue(frame, fps, { damping: 14, stiffness: 80 });
        const titleSlideY = interpolate(titleSpring, [0, 1], [40, 0]);
        const maxTitleW = W * 0.7;

        ctx.save();
        ctx.globalAlpha *= titleSpring;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize + 6, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 12;
        const titleLines = MGRenderer._wrapTextWords(ctx, mg.text || '', maxTitleW);
        const titleLineH = (ts.titleSize + 6) + 8;
        const titleY = H * 0.1;
        for (let i = 0; i < titleLines.length; i++) {
            ctx.fillText(titleLines[i], W / 2, titleY + titleSlideY + i * titleLineH);
        }
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Center accent line below title
        const underY = titleY + titleLines.length * titleLineH + 12;
        const underSpring = springValue(Math.max(0, frame - Math.round(fps * 0.15)), fps, { damping: 12, stiffness: 90 });
        const underW = interpolate(underSpring, [0, 1], [0, 160]);
        ctx.fillStyle = ts.accent;
        ctx.fillRect(W / 2 - underW / 2, underY, underW, 3);
        ctx.restore();

        // Numbered bullets — two-column if 5+ items, single column if fewer
        const startY = underY + 45;
        const cols = items.length >= 5 ? 2 : 1;
        const colW = cols === 2 ? W * 0.4 : W * 0.65;
        const colStartX = cols === 2 ? [W * 0.08, W * 0.52] : [W * 0.175];
        const rowsPerCol = Math.ceil(items.length / cols);
        const rowGap = cols === 2 ? 72 : 80;
        const numSize = ts.titleSize - 4;
        const staggerDelay = Math.round(fps * 0.18);

        for (let i = 0; i < items.length && i < 6; i++) {
            const col = Math.floor(i / rowsPerCol);
            const row = i % rowsPerCol;
            const itemDelay = Math.round(fps * 0.35) + i * staggerDelay;
            const itemSpring = springValue(Math.max(0, frame - itemDelay), fps, { damping: 14, stiffness: 100 });

            const x = colStartX[col];
            const y = startY + row * rowGap;

            ctx.save();
            ctx.globalAlpha *= itemSpring;

            // Large accent number
            const numSpring = springValue(Math.max(0, frame - itemDelay), fps, { damping: 10, stiffness: 140 });
            const numScale = interpolate(numSpring, [0, 1], [0.5, 1]);
            ctx.save();
            ctx.translate(x + numSize / 2, y + numSize / 2);
            ctx.scale(numScale, numScale);
            ctx.translate(-(x + numSize / 2), -(y + numSize / 2));
            MGRenderer._setFont(ctx, '800', numSize, ts.fontHeading);
            ctx.fillStyle = ts.accent;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 14; }
            ctx.fillText(String(i + 1), x + numSize / 2, y);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            ctx.restore();

            // Bullet text — right of number
            const textX = x + numSize + 16;
            const slideX = interpolate(itemSpring, [0, 1], [20, 0]);
            MGRenderer._setFont(ctx, '500', ts.bodySize + 2, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 4;
            const bulletLines = MGRenderer._wrapTextWords(ctx, items[i], colW - numSize - 24);
            for (let j = 0; j < bulletLines.length; j++) {
                ctx.fillText(bulletLines[j], textX + slideX, y + 4 + j * (ts.bodySize + 6));
            }
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            ctx.restore();
        }

        ctx.restore(); // globalAlpha
    }

    /** Shared bullet renderer for factCard variants that use dot-style bullets */
    _factCardDrawBullets(ctx, frame, fps, ts, items, bulletX, startY, maxW, gap, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const staggerDelay = Math.round(fps * 0.25);
        const dotRadius = 5;

        for (let i = 0; i < items.length && i < 6; i++) {
            const itemDelay = Math.round(fps * 0.5) + i * staggerDelay;
            const itemSpring = springValue(Math.max(0, frame - itemDelay), fps, { damping: 14, stiffness: 110 });
            const itemSlide = interpolate(itemSpring, [0, 1], [30, 0]);
            const itemY = startY + i * gap;

            ctx.save();
            ctx.globalAlpha *= itemSpring;

            // Dot with pop
            const dotSpring = springValue(Math.max(0, frame - itemDelay + Math.round(fps * 0.05)), fps, { damping: 10, stiffness: 200 });
            const dotScale = interpolate(dotSpring, [0, 1], [0, 1]);
            ctx.fillStyle = ts.accent;
            ctx.beginPath();
            ctx.arc(bulletX + dotRadius, itemY + 10, dotRadius * dotScale, 0, Math.PI * 2);
            ctx.fill();
            if (ts.glow) { ctx.shadowColor = ts.accent; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }

            // Text
            MGRenderer._setFont(ctx, '500', ts.bodySize + 2, ts.fontBody);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 6;
            const textX = bulletX + dotRadius * 2 + 18 + itemSlide;
            const bulletLines = MGRenderer._wrapTextWords(ctx, items[i], maxW);
            const bulletLineH = (ts.bodySize + 2) + 4;
            for (let j = 0; j < bulletLines.length; j++) {
                ctx.fillText(bulletLines[j], textX, itemY + j * bulletLineH);
            }
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            ctx.restore();
        }
    }

    /**
     * Image Showcase — dual images with typewriter title.
     * Two images slide in from opposite sides, feathered edges, title types letter by letter.
     */
    _renderImageShowcase(ctx, frame, fps, mg, s, anim) {
        // Route to collage variant if selected
        const variant = mg.subType || 'standard';
        if (variant === 'collage') {
            return this._renderImageShowcaseCollage(ctx, frame, fps, mg, s, anim);
        }

        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const totalFrames = Math.round((mg.duration || 5) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        // Dark background
        ctx.fillStyle = ts.gridBg || '#111115';
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        // --- Typewriter title at top ---
        const title = mg.text || '';
        const typewriterDur = Math.round(fps * 1.8); // 1.8s to type full title
        const charsVisible = Math.min(title.length, Math.floor((frame / typewriterDur) * title.length));
        const displayTitle = title.substring(0, charsVisible);
        const cursorVisible = frame < typewriterDur + Math.round(fps * 0.5) && Math.floor(frame / (fps * 0.3)) % 2 === 0;

        const titleY = H * 0.1;
        MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize + 10, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 10;

        // Draw typed text + cursor
        const titleText = displayTitle + (cursorVisible ? '|' : '');
        ctx.fillText(titleText, W / 2, titleY);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // --- Two images ---
        const items = mg.items || [];
        const thumbs = mg._itemThumbnails || [];
        const imgW = 580;
        const imgH = 640;
        const imgY = H * 0.19;
        const gap = 40;
        const leftImgX = W / 2 - gap / 2 - imgW;
        const rightImgX = W / 2 + gap / 2;

        // Slide animations (from opposite sides)
        const imgDelay = Math.round(fps * 0.6);
        const leftSpring = springValue(Math.max(0, frame - imgDelay), fps, { damping: 14, stiffness: 70 });
        const rightSpring = springValue(Math.max(0, frame - imgDelay - Math.round(fps * 0.15)), fps, { damping: 14, stiffness: 70 });

        const leftSlide = interpolate(leftSpring, [0, 1], [-W * 0.4, 0]);
        const rightSlide = interpolate(rightSpring, [0, 1], [W * 0.4, 0]);
        const leftAlpha = leftSpring;
        const rightAlpha = rightSpring;

        // Exit slide
        const exitSlideL = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [0, -200]) : 0;
        const exitSlideR = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [0, 200]) : 0;

        const imgPositions = [
            { x: leftImgX + leftSlide + exitSlideL, y: imgY, alpha: leftAlpha },
            { x: rightImgX + rightSlide + exitSlideR, y: imgY, alpha: rightAlpha },
        ];

        for (let i = 0; i < 2; i++) {
            const pos = imgPositions[i];
            const file = thumbs[i];
            const thumbKey = file ? file.replace(/^.*[/\\]/, '') : null;
            const img = thumbKey ? this._gridThumbs[thumbKey] : null;

            ctx.save();
            ctx.globalAlpha *= pos.alpha;

            // Rounded rectangle clip
            ctx.beginPath();
            MGRenderer._roundRect(ctx, pos.x, pos.y, imgW, imgH, 12);
            ctx.clip();

            if (img) {
                // Draw image with cover-fit
                const iw = img.naturalWidth || img.width || imgW;
                const ih = img.naturalHeight || img.height || imgH;
                const scale = Math.max(imgW / iw, imgH / ih);
                const sw = imgW / scale;
                const sh = imgH / scale;
                const sx = (iw - sw) / 2;
                const sy = (ih - sh) / 2;
                ctx.drawImage(img, sx, sy, sw, sh, pos.x, pos.y, imgW, imgH);
            } else {
                // Placeholder
                ctx.fillStyle = 'rgba(40,40,50,0.8)';
                ctx.fillRect(pos.x, pos.y, imgW, imgH);
                MGRenderer._setFont(ctx, '400', 16, ts.fontBody);
                ctx.fillStyle = 'rgba(255,255,255,0.3)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(items[i] || 'Loading...', pos.x + imgW / 2, pos.y + imgH / 2);
            }

            // Feathered edge blur (gradient overlays on edges)
            const featherW = 40;
            // Left edge
            const lGrad = ctx.createLinearGradient(pos.x, pos.y, pos.x + featherW, pos.y);
            lGrad.addColorStop(0, ts.gridBg || '#111115');
            lGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = lGrad;
            ctx.fillRect(pos.x, pos.y, featherW, imgH);
            // Right edge
            const rGrad = ctx.createLinearGradient(pos.x + imgW - featherW, pos.y, pos.x + imgW, pos.y);
            rGrad.addColorStop(0, 'transparent');
            rGrad.addColorStop(1, ts.gridBg || '#111115');
            ctx.fillStyle = rGrad;
            ctx.fillRect(pos.x + imgW - featherW, pos.y, featherW, imgH);
            // Top edge
            const tGrad = ctx.createLinearGradient(pos.x, pos.y, pos.x, pos.y + featherW);
            tGrad.addColorStop(0, ts.gridBg || '#111115');
            tGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = tGrad;
            ctx.fillRect(pos.x, pos.y, imgW, featherW);
            // Bottom edge
            const bGrad = ctx.createLinearGradient(pos.x, pos.y + imgH - featherW, pos.x, pos.y + imgH);
            bGrad.addColorStop(0, 'transparent');
            bGrad.addColorStop(1, ts.gridBg || '#111115');
            ctx.fillStyle = bGrad;
            ctx.fillRect(pos.x, pos.y + imgH - featherW, imgW, featherW);

            ctx.restore();

            // Subtle border (outside clip)
            ctx.strokeStyle = ts.cardBorder || 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, pos.x, pos.y, imgW, imgH, 12);
            ctx.stroke();
        }

        ctx.restore();
    }

    // ── IMAGE SHOWCASE: COLLAGE VARIANT ──
    // Images drop in with random rotation, staggered, piling on top of each other
    // like scattered photos on a desk. Title overlays at bottom.

    _renderImageShowcaseCollage(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const totalFrames = Math.round((mg.duration || 6) * fps);
        const exitDur = Math.round(fps * 0.6);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        // Dark background
        ctx.fillStyle = ts.gridBg || '#111115';
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        const thumbs = mg._itemThumbnails || [];
        const items = mg.items || [];
        const count = Math.min(thumbs.length || items.length, 3);

        // Deterministic "random" layout per card — seeded from mg text hash
        const seed = (mg.text || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const _rng = (i) => {
            const x = Math.sin(seed * 9301 + i * 4973) * 49297;
            return x - Math.floor(x);
        };

        // Generate scatter positions for each photo
        // Photos are arranged in a loose pile around the center
        const imgW = 420, imgH = 500;
        const centerX = W / 2, centerY = H * 0.42;
        const scatterRadius = 220;

        const cards = [];
        for (let i = 0; i < count; i++) {
            const angle = _rng(i * 3) * Math.PI * 2;
            const dist = scatterRadius * (0.3 + _rng(i * 3 + 1) * 0.7);
            const rotation = (_rng(i * 3 + 2) - 0.5) * 0.5; // -14° to +14°

            cards.push({
                x: centerX + Math.cos(angle) * dist - imgW / 2,
                y: centerY + Math.sin(angle) * dist * 0.5 - imgH / 2, // compress Y spread
                rotation,
                delay: i * 0.3, // stagger: 0s, 0.3s, 0.6s
            });
        }

        // Render each photo card (back to front — later cards on top)
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const file = thumbs[i];
            const thumbKey = file ? file.replace(/^.*[/\\]/, '') : null;
            const img = thumbKey ? this._gridThumbs[thumbKey] : null;

            // Spring animation: drop from above with bounce
            const delayFrames = Math.round(card.delay * fps);
            const spring = springValue(Math.max(0, frame - delayFrames), fps, { damping: 10, stiffness: 50 });
            const dropY = interpolate(spring, [0, 1], [-400, 0]);
            const rotationSpring = interpolate(spring, [0, 1], [card.rotation * 3, card.rotation]); // exaggerated rotation on entry
            const cardAlpha = spring;

            // Exit: cards scatter outward
            let exitX = 0, exitY = 0, exitRot = 0;
            if (isExiting) {
                const exitT = interpolate(frame - (totalFrames - exitDur), [0, exitDur], [0, 1]);
                const eased = exitT * exitT;
                exitX = (card.x - centerX + imgW / 2) * eased * 1.5;
                exitY = eased * 300;
                exitRot = card.rotation * eased * 4;
            }

            ctx.save();
            ctx.globalAlpha *= cardAlpha;

            // Position and rotate around card center
            const cx = card.x + imgW / 2 + exitX;
            const cy = card.y + imgH / 2 + dropY + exitY;
            ctx.translate(cx, cy);
            ctx.rotate(rotationSpring + exitRot);
            ctx.translate(-imgW / 2, -imgH / 2);

            // White photo border (polaroid-style)
            const border = 8;
            const borderBottom = 40; // thicker bottom border like a polaroid
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 20;
            ctx.shadowOffsetY = 8;
            ctx.fillStyle = '#f5f0e8'; // off-white paper color
            MGRenderer._roundRect(ctx, -border, -border, imgW + border * 2, imgH + border + borderBottom, 4);
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Image clip
            ctx.beginPath();
            MGRenderer._roundRect(ctx, 0, 0, imgW, imgH, 2);
            ctx.clip();

            if (img) {
                const iw = img.naturalWidth || img.width || imgW;
                const ih = img.naturalHeight || img.height || imgH;
                const scale = Math.max(imgW / iw, imgH / ih);
                const sw = imgW / scale;
                const sh = imgH / scale;
                const sx = (iw - sw) / 2;
                const sy = (ih - sh) / 2;
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, imgW, imgH);
            } else {
                ctx.fillStyle = 'rgba(60,55,50,0.8)';
                ctx.fillRect(0, 0, imgW, imgH);
                MGRenderer._setFont(ctx, '400', 14, ts.fontBody);
                ctx.fillStyle = 'rgba(255,255,255,0.3)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(items[i] || 'Loading...', imgW / 2, imgH / 2);
            }

            ctx.restore();
        }

        // --- Title bar at bottom ---
        const title = mg.text || '';
        if (title) {
            const titleDelay = Math.round(fps * (count * 0.3 + 0.5));
            const titleSpring = springValue(Math.max(0, frame - titleDelay), fps, { damping: 12, stiffness: 60 });
            const titleSlideY = interpolate(titleSpring, [0, 1], [60, 0]);

            ctx.save();
            ctx.globalAlpha *= titleSpring;

            // Semi-transparent bar
            const barY = H * 0.85;
            const barH = 80;
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.fillRect(0, barY + titleSlideY, W, barH);

            // Title text
            MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize + 4, ts.fontHeading);
            ctx.fillStyle = ts.text || '#fff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 8;
            ctx.fillText(title, W / 2, barY + barH / 2 + titleSlideY);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;

            ctx.restore();
        }

        ctx.restore();
    }

    // ── STAT CARD — icon + big number + label infographic ──
    // Variants: sideBySide (2 stats horizontal), stacked (2 stats vertical),
    //           single (1 big stat centered), triple (3 stats in a row)

    /** Parse stat items from mg.items. Each item: "iconHint number label" */
    _statCardItems(mg) {
        const raw = mg.items || mg._items || [];
        const KNOWN_ICONS = new Set([
            'energy','shield','home','money','people','globe','chart','clock',
            'building','car','health','tech',
        ]);
        return raw.slice(0, 3).map(item => {
            const text = typeof item === 'string' ? item : (item.text || item.event || '');
            if (!text) return null;
            // Parse: "iconHint number label". iconHint is any word (known or not —
            // VP sometimes hallucinates e.g. "country_eg"; we tolerate and fall back
            // to the 'chart' icon rather than garbling the number slot). Number can
            // be $-prefixed and M/K/B/% suffixed (e.g., "-$500M", "340K", "-45%").
            const match = text.match(/^(?:([a-z_][a-z0-9_]*)\s+)?([<>~±+\-]?\$?\d[\d,.]*\s*[%kKmMbB]?)\s*(.*)/i);
            if (match) {
                const rawIcon = (match[1] || '').toLowerCase();
                const icon = KNOWN_ICONS.has(rawIcon) ? rawIcon : 'chart';
                return { icon, number: match[2].trim(), label: (match[3] || '').trim() };
            }
            // No number at all — treat whole string as label, not as number.
            return { icon: 'chart', number: '', label: text };
        }).filter(Boolean);
    }

    /** Draw a simple icon by name */
    _drawStatIcon(ctx, icon, cx, cy, size, color) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = size * 0.06;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const r = size * 0.45;

        switch (icon) {
            case 'energy': {
                // Lightning bolt
                ctx.beginPath();
                ctx.moveTo(cx + r * 0.15, cy - r);
                ctx.lineTo(cx - r * 0.4, cy + r * 0.05);
                ctx.lineTo(cx + r * 0.05, cy + r * 0.05);
                ctx.lineTo(cx - r * 0.15, cy + r);
                ctx.lineTo(cx + r * 0.4, cy - r * 0.05);
                ctx.lineTo(cx - r * 0.05, cy - r * 0.05);
                ctx.closePath();
                ctx.fill();
                break;
            }
            case 'shield': {
                // Shield with house
                ctx.beginPath();
                ctx.moveTo(cx, cy - r);
                ctx.quadraticCurveTo(cx + r, cy - r * 0.7, cx + r, cy);
                ctx.quadraticCurveTo(cx + r, cy + r * 0.8, cx, cy + r);
                ctx.quadraticCurveTo(cx - r, cy + r * 0.8, cx - r, cy);
                ctx.quadraticCurveTo(cx - r, cy - r * 0.7, cx, cy - r);
                ctx.closePath();
                ctx.stroke();
                // Inner house
                const hs = r * 0.4;
                ctx.beginPath();
                ctx.moveTo(cx, cy - hs * 0.6);
                ctx.lineTo(cx + hs, cy + hs * 0.2);
                ctx.lineTo(cx + hs * 0.6, cy + hs * 0.2);
                ctx.lineTo(cx + hs * 0.6, cy + hs * 0.7);
                ctx.lineTo(cx - hs * 0.6, cy + hs * 0.7);
                ctx.lineTo(cx - hs * 0.6, cy + hs * 0.2);
                ctx.lineTo(cx - hs, cy + hs * 0.2);
                ctx.closePath();
                ctx.fill();
                break;
            }
            case 'home': {
                // House
                ctx.beginPath();
                ctx.moveTo(cx, cy - r * 0.8);
                ctx.lineTo(cx + r, cy);
                ctx.lineTo(cx + r * 0.7, cy);
                ctx.lineTo(cx + r * 0.7, cy + r * 0.7);
                ctx.lineTo(cx - r * 0.7, cy + r * 0.7);
                ctx.lineTo(cx - r * 0.7, cy);
                ctx.lineTo(cx - r, cy);
                ctx.closePath();
                ctx.fill();
                break;
            }
            case 'money': {
                // Dollar circle
                ctx.beginPath();
                ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
                ctx.stroke();
                MGRenderer._setFont(ctx, '700', size * 0.5, 'Arial');
                ctx.fillStyle = color;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('$', cx, cy);
                break;
            }
            case 'people': {
                // Two people silhouette
                ctx.beginPath();
                ctx.arc(cx - r * 0.25, cy - r * 0.35, r * 0.25, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(cx - r * 0.25, cy + r * 0.35, r * 0.45, Math.PI, 0);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(cx + r * 0.35, cy - r * 0.25, r * 0.2, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(cx + r * 0.35, cy + r * 0.4, r * 0.35, Math.PI, 0);
                ctx.fill();
                break;
            }
            case 'clock': {
                ctx.beginPath();
                ctx.arc(cx, cy, r * 0.75, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(cx, cy - r * 0.45);
                ctx.moveTo(cx, cy);
                ctx.lineTo(cx + r * 0.35, cy + r * 0.1);
                ctx.stroke();
                break;
            }
            default: {
                // Generic chart bars
                const bw = r * 0.35;
                const gap = r * 0.12;
                ctx.fillRect(cx - bw * 1.5 - gap, cy, bw, -r * 0.5);
                ctx.fillRect(cx - bw * 0.5, cy, bw, -r * 0.9);
                ctx.fillRect(cx + bw * 0.5 + gap, cy, bw, -r * 0.7);
                // Baseline
                ctx.fillRect(cx - r, cy, r * 2, size * 0.04);
                break;
            }
        }
        ctx.restore();
    }

    _renderStatCard(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'statCard') || 'sideBySide';
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const totalFrames = Math.round((mg.duration || 5) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        // Background
        if (!this._drawTemplateBg(ctx, mg, W, H, Math.min(anim.opacity, exitAlpha))) {
            // Soft gradient background
            const bgGrad = ctx.createLinearGradient(0, 0, W, H);
            bgGrad.addColorStop(0, ts.gridBg || '#1a1a2e');
            bgGrad.addColorStop(1, ts.cardBg || '#16213e');
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, 0, W, H);
        }

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        const items = this._statCardItems(mg);
        if (items.length === 0) {
            ctx.restore();
            return;
        }

        // Title at top
        const title = mg.text || '';
        if (title) {
            const titleSpring = springValue(frame, fps, { damping: 14, stiffness: 100 });
            const titleSlide = interpolate(titleSpring, [0, 1], [30, 0]);
            ctx.save();
            ctx.globalAlpha *= titleSpring;
            MGRenderer._setFont(ctx, ts.titleWeight, ts.titleSize - 4, ts.fontHeading);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = 10;
            ctx.fillText(title, W / 2, 80 + titleSlide);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.restore();
        }

        // Layout stat blocks based on variant and item count
        const count = Math.min(items.length, variant === 'triple' ? 3 : variant === 'single' ? 1 : 2);
        const isVertical = variant === 'stacked';
        const blockW = isVertical ? 700 : Math.min(500, (W - 200) / count);
        const blockH = isVertical ? 220 : 450;
        const iconSize = isVertical ? 70 : 120;
        const numberSize = isVertical ? 72 : 110;
        const labelSize = isVertical ? 26 : 32;

        const totalW = isVertical ? blockW : (blockW * count + 80 * (count - 1));
        const startX = (W - totalW) / 2;
        const centerY = title ? H * 0.52 : H * 0.48;

        for (let i = 0; i < count; i++) {
            const item = items[i];
            const delay = Math.round(fps * 0.15 * i);
            const itemSpring = springValue(Math.max(0, frame - delay), fps, { damping: 12, stiffness: 80 });
            const itemScale = interpolate(itemSpring, [0, 1], [0.7, 1]);
            const itemAlpha = itemSpring;

            // Position
            let bx, by;
            if (isVertical) {
                bx = startX + blockW / 2;
                by = centerY + (i - (count - 1) / 2) * (blockH + 30);
            } else {
                bx = startX + i * (blockW + 80) + blockW / 2;
                by = centerY;
            }

            ctx.save();
            ctx.globalAlpha *= itemAlpha;
            ctx.translate(bx, by);
            ctx.scale(itemScale, itemScale);

            // Subtle card background
            const cardW2 = blockW - 20;
            const cardH2 = isVertical ? blockH - 10 : blockH - 40;
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            MGRenderer._roundRect(ctx, -cardW2 / 2, -cardH2 / 2, cardW2, cardH2, 24);
            ctx.fill();

            // Border
            ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, -cardW2 / 2, -cardH2 / 2, cardW2, cardH2, 24);
            ctx.stroke();

            if (isVertical) {
                // Horizontal layout: icon left, number+label right
                const iconCx = -cardW2 / 2 + 70;
                this._drawStatIcon(ctx, item.icon, iconCx, 0, iconSize, ts.accent);

                // Number
                MGRenderer._setFont(ctx, '800', numberSize * 0.7, ts.fontHeading);
                ctx.fillStyle = ts.text;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.shadowColor = 'rgba(0,0,0,0.3)';
                ctx.shadowBlur = 8;

                // Count-up animation
                const countFrame = Math.max(0, frame - delay);
                const countDur = Math.round(fps * 1.2);
                const countProgress = Math.min(1, countFrame / countDur);
                const eased = 1 - Math.pow(1 - countProgress, 3);
                const numText = this._animateStatNumber(item.number, eased);
                ctx.fillText(numText, iconCx + 60, -12);

                // Label
                MGRenderer._setFont(ctx, '400', labelSize, ts.fontBody);
                ctx.fillStyle = ts.textSub || 'rgba(255,255,255,0.65)';
                ctx.fillText(item.label, iconCx + 60, 28);
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
            } else {
                // Vertical layout: icon top, number middle, label bottom
                const iconY = -cardH2 / 2 + 80;
                this._drawStatIcon(ctx, item.icon, 0, iconY, iconSize, ts.accent);

                // Accent glow behind icon
                if (ts.glow) {
                    ctx.save();
                    ctx.globalAlpha *= 0.15;
                    ctx.beginPath();
                    ctx.arc(0, iconY, iconSize * 0.8, 0, Math.PI * 2);
                    ctx.fillStyle = ts.accent;
                    ctx.fill();
                    ctx.restore();
                }

                // Number with count-up
                const countFrame = Math.max(0, frame - delay);
                const countDur = Math.round(fps * 1.2);
                const countProgress = Math.min(1, countFrame / countDur);
                const eased = 1 - Math.pow(1 - countProgress, 3);
                const numText = this._animateStatNumber(item.number, eased);

                MGRenderer._setFont(ctx, '800', numberSize, ts.fontHeading);
                ctx.fillStyle = ts.text;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.shadowColor = 'rgba(0,0,0,0.4)';
                ctx.shadowBlur = 12;
                ctx.fillText(numText, 0, iconY + iconSize * 0.7 + 55);

                // Label
                MGRenderer._setFont(ctx, '400', labelSize, ts.fontBody);
                ctx.fillStyle = ts.textSub || 'rgba(255,255,255,0.65)';
                ctx.shadowColor = 'rgba(0,0,0,0.2)';
                ctx.shadowBlur = 6;
                const labelLines = MGRenderer._wrapTextWords(ctx, item.label, cardW2 - 40);
                const labelStartY = iconY + iconSize * 0.7 + 55 + numberSize * 0.6 + 15;
                for (let li = 0; li < labelLines.length; li++) {
                    ctx.fillText(labelLines[li], 0, labelStartY + li * (labelSize + 6));
                }
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
            }

            ctx.restore();
        }

        ctx.restore();
    }

    // ── PERSON INTRO — portrait + name + role + context image ──
    // Phase 1: Portrait slides in from left + name types in
    // Phase 2: Role/date fades in below name
    // Phase 3: Context image appears on the right (if available)

    _renderPersonIntro(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const totalFrames = Math.round((mg.duration || 6) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;

        // Background: soft warm tone
        const bgGrad = ctx.createLinearGradient(0, 0, W, H);
        bgGrad.addColorStop(0, ts.gridBg || '#1a1a2e');
        bgGrad.addColorStop(1, ts.cardBg || '#16213e');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.globalAlpha = Math.min(anim.opacity, exitAlpha);

        const thumbs = mg._itemThumbnails || [];
        const items = mg.items || [];
        const personName = mg.text || '';
        const role = mg.subText || mg.subtext || '';

        // ── Phase 1: Portrait image (left side) ──
        const portraitSpring = springValue(frame, fps, { damping: 12, stiffness: 70 });
        const portraitSlideX = interpolate(portraitSpring, [0, 1], [-200, 0]);
        const portraitAlpha = portraitSpring;

        const portraitW = 480;
        const portraitH = H * 0.75;
        const portraitX = 80 + portraitSlideX;
        const portraitY = (H - portraitH) / 2;

        ctx.save();
        ctx.globalAlpha *= portraitAlpha;

        // Try to draw portrait image
        const portraitThumb = thumbs[0];
        const portraitKey = portraitThumb ? portraitThumb.replace(/^.*[/\\]/, '') : null;
        const portraitImg = portraitKey ? this._gridThumbs?.[portraitKey] : null;

        if (portraitImg) {
            // Draw portrait with rounded corners and subtle shadow
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = 30;
            ctx.shadowOffsetX = 10;
            ctx.shadowOffsetY = 10;

            ctx.beginPath();
            MGRenderer._roundRect(ctx, portraitX, portraitY, portraitW, portraitH, 16);
            ctx.clip();

            // Cover-fit the image
            const img = portraitImg;
            const imgW = img.width || img.videoWidth || portraitW;
            const imgH = img.height || img.videoHeight || portraitH;
            const scale = Math.max(portraitW / imgW, portraitH / imgH);
            const drawW = imgW * scale;
            const drawH = imgH * scale;
            const drawX = portraitX + (portraitW - drawW) / 2;
            const drawY = portraitY + (portraitH - drawH) / 2;
            ctx.drawImage(img, drawX, drawY, drawW, drawH);

            // Subtle bottom gradient for blending
            const fadeGrad = ctx.createLinearGradient(portraitX, portraitY + portraitH - 100, portraitX, portraitY + portraitH);
            fadeGrad.addColorStop(0, 'transparent');
            fadeGrad.addColorStop(1, 'rgba(0,0,0,0.3)');
            ctx.fillStyle = fadeGrad;
            ctx.fillRect(portraitX, portraitY + portraitH - 100, portraitW, 100);

            ctx.restore();
        } else {
            // Placeholder silhouette
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            MGRenderer._roundRect(ctx, portraitX, portraitY, portraitW, portraitH, 16);
            ctx.fill();

            // Simple person silhouette
            const cx = portraitX + portraitW / 2;
            const cy = portraitY + portraitH * 0.35;
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.beginPath();
            ctx.arc(cx, cy, 60, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(cx, cy + 130, 80, 60, 0, Math.PI, 0);
            ctx.fill();
        }
        ctx.restore();

        // ── Phase 2: Name + Role (right side, staggered) ──
        const nameDelay = Math.round(fps * 0.4);
        const nameSpring = springValue(Math.max(0, frame - nameDelay), fps, { damping: 14, stiffness: 90 });
        const nameSlideY = interpolate(nameSpring, [0, 1], [50, 0]);

        const textX = portraitX + portraitW + 80;
        const textMaxW = W - textX - 80;

        // Name — big bold
        ctx.save();
        ctx.globalAlpha *= nameSpring;
        MGRenderer._setFont(ctx, '900', 72, ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 12;

        // Typewriter effect for name
        const typewriterDur = Math.round(fps * 1.0);
        const nameFrame = Math.max(0, frame - nameDelay);
        const charsVisible = Math.min(personName.length, Math.floor((nameFrame / typewriterDur) * personName.length));
        const displayName = personName.substring(0, charsVisible).toUpperCase();

        const nameY = H * 0.22 + nameSlideY;
        const nameLines = MGRenderer._wrapTextWords(ctx, displayName, textMaxW);
        const nameLineH = 82;
        for (let i = 0; i < nameLines.length; i++) {
            ctx.fillText(nameLines[i], textX, nameY + i * nameLineH);
        }

        // Typing cursor
        if (nameFrame < typewriterDur + Math.round(fps * 0.5) && Math.floor(nameFrame / (fps * 0.25)) % 2 === 0) {
            const lastLine = nameLines[nameLines.length - 1] || '';
            const cursorX = textX + ctx.measureText(lastLine).width + 4;
            const cursorY = nameY + (nameLines.length - 1) * nameLineH;
            ctx.fillStyle = ts.accent;
            ctx.fillRect(cursorX, cursorY + 5, 4, 65);
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.restore();

        // Role/title — smaller, delayed more
        const roleDelay = Math.round(fps * 1.2);
        const roleSpring = springValue(Math.max(0, frame - roleDelay), fps, { damping: 14, stiffness: 100 });

        if (role) {
            ctx.save();
            ctx.globalAlpha *= roleSpring;
            MGRenderer._setFont(ctx, '400', 32, ts.fontBody);
            ctx.fillStyle = ts.textSub || 'rgba(255,255,255,0.7)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            const roleY = nameY + nameLines.length * nameLineH + 20 + interpolate(roleSpring, [0, 1], [20, 0]);
            ctx.fillText(role, textX, roleY);

            // Accent line above role
            const lineSpring = springValue(Math.max(0, frame - roleDelay - Math.round(fps * 0.1)), fps, { damping: 12, stiffness: 120 });
            const lineW = interpolate(lineSpring, [0, 1], [0, Math.min(ctx.measureText(role).width, textMaxW)]);
            ctx.fillStyle = ts.accent;
            ctx.fillRect(textX, roleY - 12, lineW, 3);

            ctx.restore();
        }

        // ── Phase 3: Context image (right side, below name) ──
        const contextDelay = Math.round(fps * 2.0);
        const contextSpring = springValue(Math.max(0, frame - contextDelay), fps, { damping: 12, stiffness: 60 });

        const contextThumb = thumbs[1];
        const contextKey = contextThumb ? contextThumb.replace(/^.*[/\\]/, '') : null;
        const contextImg = contextKey ? this._gridThumbs?.[contextKey] : null;

        if (contextImg || contextThumb) {
            const contextAlpha = contextSpring;
            const contextScale = interpolate(contextSpring, [0, 1], [0.85, 1]);
            const contextW = 520;
            const contextH = 320;
            const contextX = textX + 20;
            const contextY = H * 0.55;

            ctx.save();
            ctx.globalAlpha *= contextAlpha;
            ctx.translate(contextX + contextW / 2, contextY + contextH / 2);
            ctx.scale(contextScale, contextScale);
            ctx.translate(-(contextX + contextW / 2), -(contextY + contextH / 2));

            if (contextImg) {
                // Rounded frame with shadow
                ctx.save();
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 20;
                ctx.shadowOffsetX = 5;
                ctx.shadowOffsetY = 5;

                // Frame border
                ctx.fillStyle = 'rgba(255,255,255,0.15)';
                ctx.beginPath();
                MGRenderer._roundRect(ctx, contextX - 4, contextY - 4, contextW + 8, contextH + 8, 14);
                ctx.fill();

                ctx.beginPath();
                MGRenderer._roundRect(ctx, contextX, contextY, contextW, contextH, 12);
                ctx.clip();

                const cImg = contextImg;
                const cImgW = cImg.width || cImg.videoWidth || contextW;
                const cImgH = cImg.height || cImg.videoHeight || contextH;
                const cScale = Math.max(contextW / cImgW, contextH / cImgH);
                const cDrawW = cImgW * cScale;
                const cDrawH = cImgH * cScale;
                ctx.drawImage(cImg, contextX + (contextW - cDrawW) / 2, contextY + (contextH - cDrawH) / 2, cDrawW, cDrawH);

                // Subtle vignette
                const vig = ctx.createRadialGradient(contextX + contextW / 2, contextY + contextH / 2, contextW * 0.3, contextX + contextW / 2, contextY + contextH / 2, contextW * 0.7);
                vig.addColorStop(0, 'transparent');
                vig.addColorStop(1, 'rgba(0,0,0,0.2)');
                ctx.fillStyle = vig;
                ctx.fillRect(contextX, contextY, contextW, contextH);

                ctx.restore();
            } else {
                // Placeholder
                ctx.fillStyle = 'rgba(255,255,255,0.06)';
                ctx.beginPath();
                MGRenderer._roundRect(ctx, contextX, contextY, contextW, contextH, 12);
                ctx.fill();
            }

            // Date/year label above context image (from items[1] if it contains a year)
            const contextDesc = typeof items[1] === 'string' ? items[1] : '';
            const yearMatch = contextDesc.match(/\b(1[5-9]\d{2}|20[0-2]\d)\b/);
            if (yearMatch) {
                const yearSpring = springValue(Math.max(0, frame - contextDelay - Math.round(fps * 0.3)), fps, { damping: 10, stiffness: 120 });
                ctx.save();
                ctx.globalAlpha *= yearSpring;
                MGRenderer._setFont(ctx, '900', 64, ts.fontHeading);
                ctx.fillStyle = ts.text;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                ctx.shadowColor = 'rgba(0,0,0,0.4)';
                ctx.shadowBlur = 10;
                ctx.fillText(yearMatch[0], contextX + 10, contextY - 10);
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
                ctx.restore();
            }

            ctx.restore();
        }

        ctx.restore();
    }

    // ========================================================================
    // SPLIT SCREEN — Two images/videos side by side with labels
    // ========================================================================

    _renderSplitScreen(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const totalFrames = Math.round((mg.duration || 6) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;
        const variant = (mg.subType || 'vertical');

        // Parse items: "Left Label; Right Label"
        let items = [];
        if (mg.items) {
            items = (typeof mg.items === 'string' ? mg.items.split(';') : mg.items).map(i => (typeof i === 'string' ? i.trim() : i.label || i));
        }
        const leftLabel = items[0] || 'A';
        const rightLabel = items[1] || 'B';

        // Thumbnail images — _ensureGridThumbnails stores on this._gridThumbs
        // (renderer-wide cache), keyed by filename. Resolve per-slot via _itemThumbnails
        // so we don't accidentally pick a thumb that belongs to a different scene.
        const itemThumbs = mg._itemThumbnails || [];
        const getImg = (idx) => {
            const f = itemThumbs[idx];
            if (!f) return null;
            const key = f.replace(/^.*[/\\]/, '');
            return this._gridThumbs?.[key] || null;
        };
        const leftImg = getImg(0);
        const rightImg = getImg(1);

        ctx.save();
        ctx.globalAlpha = exitAlpha;

        // Background
        ctx.fillStyle = ts.gridBg || 'rgba(0,0,10,0.95)';
        ctx.fillRect(0, 0, W, H);

        const gap = variant === 'diagonal' ? 0 : 8;
        const halfW = (W - gap) / 2;

        // Animation: panels slide inward
        const enterDur = Math.round(fps * 0.6);
        const leftSpring = springValue(frame, fps, { damping: 12, stiffness: 100, durationInFrames: enterDur });
        const rightSpring = springValue(Math.max(0, frame - Math.round(fps * 0.08)), fps, { damping: 12, stiffness: 100, durationInFrames: enterDur });
        const leftSlide = isExiting ? interpolate(exitAlpha, [0, 1], [-halfW, 0]) : interpolate(leftSpring, [0, 1], [-halfW, 0]);
        const rightSlide = isExiting ? interpolate(exitAlpha, [0, 1], [halfW, 0]) : interpolate(rightSpring, [0, 1], [halfW, 0]);

        // ── LEFT PANEL ──
        ctx.save();
        if (variant === 'diagonal') {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(W * 0.55, 0);
            ctx.lineTo(W * 0.45, H);
            ctx.lineTo(0, H);
            ctx.clip();
        } else {
            ctx.beginPath();
            ctx.rect(0, 0, halfW, H);
            ctx.clip();
        }
        ctx.translate(leftSlide, 0);

        if (leftImg && leftImg.complete && (leftImg.naturalWidth || leftImg.videoWidth)) {
            const imgW = leftImg.naturalWidth || leftImg.videoWidth || halfW;
            const imgH = leftImg.naturalHeight || leftImg.videoHeight || H;
            const sc = Math.max(halfW / imgW, H / imgH);
            const dw = imgW * sc, dh = imgH * sc;
            ctx.drawImage(leftImg, (halfW - dw) / 2, (H - dh) / 2, dw, dh);
        } else {
            ctx.fillStyle = s.primary + '30';
            ctx.fillRect(0, 0, halfW, H);
        }

        // Darken bottom for label
        const leftGrad = ctx.createLinearGradient(0, H * 0.6, 0, H);
        leftGrad.addColorStop(0, 'transparent');
        leftGrad.addColorStop(1, 'rgba(0,0,0,0.75)');
        ctx.fillStyle = leftGrad;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();

        // ── RIGHT PANEL ──
        ctx.save();
        if (variant === 'diagonal') {
            ctx.beginPath();
            ctx.moveTo(W * 0.55, 0);
            ctx.lineTo(W, 0);
            ctx.lineTo(W, H);
            ctx.lineTo(W * 0.45, H);
            ctx.clip();
        } else {
            ctx.beginPath();
            ctx.rect(halfW + gap, 0, halfW, H);
            ctx.clip();
        }
        ctx.translate(rightSlide, 0);

        if (rightImg && rightImg.complete && (rightImg.naturalWidth || rightImg.videoWidth)) {
            const imgW = rightImg.naturalWidth || rightImg.videoWidth || halfW;
            const imgH = rightImg.naturalHeight || rightImg.videoHeight || H;
            const sc = Math.max(halfW / imgW, H / imgH);
            const dw = imgW * sc, dh = imgH * sc;
            const ox = variant === 'diagonal' ? W * 0.45 : halfW + gap;
            ctx.drawImage(rightImg, ox + (halfW - dw) / 2, (H - dh) / 2, dw, dh);
        } else {
            const ox = variant === 'diagonal' ? W * 0.45 : halfW + gap;
            ctx.fillStyle = s.accent + '30';
            ctx.fillRect(ox, 0, halfW, H);
        }

        const rightGrad = ctx.createLinearGradient(0, H * 0.6, 0, H);
        rightGrad.addColorStop(0, 'transparent');
        rightGrad.addColorStop(1, 'rgba(0,0,0,0.75)');
        ctx.fillStyle = rightGrad;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();

        // ── CENTER DIVIDER ──
        if (variant === 'diagonal') {
            // Diagonal divider line with glow
            ctx.save();
            ctx.globalAlpha = exitAlpha * 0.9;
            ctx.strokeStyle = ts.accent;
            ctx.lineWidth = 4;
            ctx.shadowColor = ts.accent;
            ctx.shadowBlur = 16;
            ctx.beginPath();
            ctx.moveTo(W * 0.55, 0);
            ctx.lineTo(W * 0.45, H);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.restore();
        } else if (gap > 0) {
            ctx.fillStyle = ts.accent;
            ctx.shadowColor = ts.accent;
            ctx.shadowBlur = 12;
            ctx.fillRect(halfW, 0, gap, H);
            ctx.shadowBlur = 0;
        }

        // ── LABELS ──
        const labelDelay = Math.round(fps * 0.4);
        const labelSpring = springValue(Math.max(0, frame - labelDelay), fps, { damping: 10, stiffness: 120, durationInFrames: Math.round(fps * 0.5) });
        const labelY = H - 80;

        ctx.save();
        ctx.globalAlpha = exitAlpha * labelSpring;

        // Left label — pill
        MGRenderer._setFont(ctx, '700', 32, ts.fontHeading);
        const leftW = ctx.measureText(leftLabel).width + 40;
        const pillH = 48;
        const pillR = pillH / 2;
        const leftPillX = halfW / 2 - leftW / 2;

        ctx.fillStyle = ts.cardBg;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 8;
        MGRenderer._roundRect(ctx, leftPillX, labelY - pillH / 2, leftW, pillH, pillR);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Left accent bar
        ctx.fillStyle = s.primary || ts.accent;
        ctx.fillRect(leftPillX + 8, labelY - pillH / 2 + 8, 3, pillH - 16);

        ctx.fillStyle = ts.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(leftLabel, halfW / 2, labelY);

        // Right label — pill
        const rightW = ctx.measureText(rightLabel).width + 40;
        const rightOff = variant === 'diagonal' ? W * 0.725 : halfW + gap + halfW / 2;
        const rightPillX = rightOff - rightW / 2;

        ctx.fillStyle = ts.cardBg;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 8;
        MGRenderer._roundRect(ctx, rightPillX, labelY - pillH / 2, rightW, pillH, pillR);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = s.accent || ts.accent;
        ctx.fillRect(rightPillX + 8, labelY - pillH / 2 + 8, 3, pillH - 16);

        ctx.fillStyle = ts.text;
        ctx.fillText(rightLabel, rightOff, labelY);
        ctx.restore();

        // ── TITLE (top center) ──
        if (mg.text) {
            const titleDelay = Math.round(fps * 0.25);
            const titleSpring = springValue(Math.max(0, frame - titleDelay), fps, { damping: 10, stiffness: 120, durationInFrames: Math.round(fps * 0.4) });
            ctx.save();
            ctx.globalAlpha = exitAlpha * titleSpring;
            MGRenderer._setFont(ctx, ts.titleWeight || '700', 44, ts.fontHeading);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 6;
            ctx.fillText(mg.text, W / 2, 60);
            ctx.shadowBlur = 0;
            ctx.restore();
        }

        // ── VS badge (center) ──
        if (variant !== 'reveal') {
            const vsDelay = Math.round(fps * 0.5);
            const vsSpring = springValue(Math.max(0, frame - vsDelay), fps, { damping: 12, stiffness: 150, durationInFrames: Math.round(fps * 0.4) });
            ctx.save();
            ctx.globalAlpha = exitAlpha * vsSpring;
            ctx.translate(W / 2, H / 2);
            ctx.scale(vsSpring, vsSpring);
            ctx.beginPath();
            ctx.arc(0, 0, 36, 0, Math.PI * 2);
            const vsGrad = ctx.createLinearGradient(-36, -36, 36, 36);
            vsGrad.addColorStop(0, s.primary || ts.accent);
            vsGrad.addColorStop(1, s.accent || ts.accent);
            ctx.fillStyle = vsGrad;
            ctx.shadowColor = ts.accent;
            ctx.shadowBlur = 20;
            ctx.fill();
            ctx.shadowBlur = 0;
            MGRenderer._setFont(ctx, '900', 24, ts.fontHeading);
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('VS', 0, 0);
            ctx.restore();
        }

        ctx.restore();
    }

    // ========================================================================
    // INFOGRAPHIC — Multi-item layout with icons, images, titles, values
    // ========================================================================

    _renderInfographic(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const W = 1920, H = 1080;
        const ts = this._getTemplateStyle(mg, s);
        const totalFrames = Math.round((mg.duration || 8) * fps);
        const exitDur = Math.round(fps * 0.5);
        const isExiting = frame > totalFrames - exitDur;
        const exitAlpha = isExiting ? interpolate(frame - (totalFrames - exitDur), [0, exitDur], [1, 0]) : 1;
        const variant = (mg.subType || 'grid');

        // Parse items: "Title | Value | image query" separated by semicolons
        let items = [];
        if (mg.items) {
            const rawItems = typeof mg.items === 'string' ? mg.items.split(';') : mg.items;
            for (const raw of rawItems) {
                const str = typeof raw === 'string' ? raw.trim() : '';
                if (!str) continue;
                const parts = str.split('|').map(p => p.trim());
                items.push({
                    title: parts[0] || '',
                    value: parts[1] || '',
                    imageQuery: parts[2] || parts[0] || '',
                });
            }
        }
        if (items.length === 0) return;
        const count = items.length;

        // Thumbnail images — _ensureGridThumbnails stores on this._gridThumbs
        // (renderer-wide cache), keyed by filename. Resolve per-slot via _itemThumbnails
        // so each card gets its OWN image, not whatever happened to land at thumbKeys[i].
        const itemThumbs = mg._itemThumbnails || [];
        const getImg = (idx) => {
            const f = itemThumbs[idx];
            if (!f) return null;
            const key = f.replace(/^.*[/\\]/, '');
            return this._gridThumbs?.[key] || null;
        };

        ctx.save();
        ctx.globalAlpha = exitAlpha;

        // Background
        ctx.fillStyle = ts.gridBg || 'rgba(0,0,10,0.95)';
        ctx.fillRect(0, 0, W, H);

        // Subtle grid lines
        ctx.strokeStyle = ts.gridLine || 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        for (let gx = 0; gx < W; gx += 120) {
            ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
        }
        for (let gy = 0; gy < H; gy += 120) {
            ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
        }

        // ── Title ──
        if (mg.text) {
            const titleDelay = Math.round(fps * 0.15);
            const titleSpring = springValue(Math.max(0, frame - titleDelay), fps, { damping: 10, stiffness: 120, durationInFrames: Math.round(fps * 0.5) });
            ctx.save();
            ctx.globalAlpha = exitAlpha * titleSpring;
            MGRenderer._setFont(ctx, ts.titleWeight || '700', 44, ts.fontHeading);
            ctx.fillStyle = ts.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 4;
            ctx.fillText(mg.text, W / 2, 60);
            ctx.shadowBlur = 0;

            // Accent underline
            const titleW = ctx.measureText(mg.text).width;
            ctx.fillStyle = ts.accent;
            ctx.globalAlpha = exitAlpha * titleSpring * 0.6;
            ctx.fillRect(W / 2 - titleW / 2, 86, titleW * titleSpring, 3);
            ctx.restore();
        }

        // ── Layout items ──
        const topY = 120;
        const availH = H - topY - 40;
        const availW = W - 120;

        if (variant === 'horizontal') {
            // Horizontal strip — items in a row
            const itemW = Math.min(300, availW / count);
            const itemH = availH * 0.85;
            const totalItemW = itemW * count + 20 * (count - 1);
            const startX = (W - totalItemW) / 2;

            for (let i = 0; i < count; i++) {
                const item = items[i];
                const staggerDelay = Math.round(fps * (0.2 + i * 0.12));
                const itemSpring = springValue(Math.max(0, frame - staggerDelay), fps, { damping: 10, stiffness: 100, durationInFrames: Math.round(fps * 0.5) });
                if (itemSpring <= 0) continue;

                const ix = startX + i * (itemW + 20);
                const iy = topY + (availH - itemH) / 2;
                const slideY = interpolate(itemSpring, [0, 1], [40, 0]);

                ctx.save();
                ctx.globalAlpha = exitAlpha * itemSpring;
                ctx.translate(ix, iy + slideY);

                this._drawInfographicItem(ctx, item, itemW, itemH, i, ts, s, getImg(i), frame, fps);

                ctx.restore();
            }
        } else {
            // Grid variant: 2-3 columns
            const cols = count <= 3 ? count : count <= 4 ? 2 : 3;
            const rows = Math.ceil(count / cols);
            const gapX = 24, gapY = 20;
            const itemW = (availW - gapX * (cols - 1)) / cols;
            const itemH = Math.min(280, (availH - gapY * (rows - 1)) / rows);
            const totalGridW = cols * itemW + (cols - 1) * gapX;
            const totalGridH = rows * itemH + (rows - 1) * gapY;
            const startX = (W - totalGridW) / 2;
            const startY = topY + (availH - totalGridH) / 2;

            for (let i = 0; i < count; i++) {
                const item = items[i];
                const col = i % cols;
                const row = Math.floor(i / cols);
                const staggerDelay = Math.round(fps * (0.2 + i * 0.1));
                const itemSpring = springValue(Math.max(0, frame - staggerDelay), fps, { damping: 10, stiffness: 100, durationInFrames: Math.round(fps * 0.5) });
                if (itemSpring <= 0) continue;

                const ix = startX + col * (itemW + gapX);
                const iy = startY + row * (itemH + gapY);
                const slideY = interpolate(itemSpring, [0, 1], [30, 0]);

                ctx.save();
                ctx.globalAlpha = exitAlpha * itemSpring;
                ctx.translate(ix, iy + slideY);

                this._drawInfographicItem(ctx, item, itemW, itemH, i, ts, s, getImg(i), frame, fps);

                ctx.restore();
            }
        }

        // Connecting lines between items (grid variant only)
        if (variant === 'grid' && count >= 2) {
            // Central vertical line
            ctx.save();
            const lineDelay = Math.round(fps * 0.6);
            const lineT = Math.min(1, Math.max(0, (frame - lineDelay) / (fps * 0.4)));
            if (lineT > 0) {
                ctx.globalAlpha = exitAlpha * lineT * 0.15;
                ctx.strokeStyle = ts.accent;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 6]);
                ctx.beginPath();
                ctx.moveTo(W / 2, topY + 20);
                ctx.lineTo(W / 2, topY + availH * lineT - 20);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.restore();
        }

        ctx.restore();
    }

    /** Draw a single infographic item card */
    _drawInfographicItem(ctx, item, cardW, cardH, index, ts, s, img, frame, fps) {
        const ACCENT_COLORS = [
            s.primary || ts.accent,
            s.accent || '#ef4444',
            '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
        ];
        const accentColor = ACCENT_COLORS[index % ACCENT_COLORS.length];
        const imgSize = Math.min(cardH * 0.5, 120);
        const hasImage = !!img;

        // Card background
        ctx.fillStyle = ts.cardBg;
        ctx.shadowColor = ts.cardShadow || 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = ts.cardShadowBlur || 8;
        MGRenderer._roundRect(ctx, 0, 0, cardW, cardH, ts.cardRadius || 12);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Accent left strip
        ctx.fillStyle = accentColor;
        ctx.fillRect(0, 12, 4, cardH - 24);

        // Top accent line
        ctx.fillStyle = accentColor;
        ctx.globalAlpha *= 0.4;
        ctx.fillRect(16, 0, cardW - 32, 2);
        ctx.globalAlpha /= 0.4;

        // Content layout: image on left (if available), text on right
        const textX = hasImage ? imgSize + 24 : 20;
        const textW = cardW - textX - 16;

        // Image thumbnail (circular)
        if (hasImage) {
            if (img.complete && (img.naturalWidth || img.videoWidth)) {
                const cx = 16 + imgSize / 2;
                const cy = cardH / 2;
                const radius = imgSize / 2 - 4;

                // Circle clip + draw
                ctx.save();
                ctx.beginPath();
                ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                ctx.clip();
                const iw = img.naturalWidth || img.videoWidth || imgSize;
                const ih = img.naturalHeight || img.videoHeight || imgSize;
                const sc = Math.max(imgSize / iw, imgSize / ih);
                ctx.drawImage(img, cx - (iw * sc) / 2, cy - (ih * sc) / 2, iw * sc, ih * sc);
                ctx.restore();

                // Circle border
                ctx.strokeStyle = accentColor;
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Index number (small, top-right)
        MGRenderer._setFont(ctx, '700', 16, ts.fontBody);
        ctx.fillStyle = accentColor;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(`#${index + 1}`, cardW - 12, 10);

        // Title
        MGRenderer._setFont(ctx, '700', Math.min(28, ts.labelSize || 28), ts.fontHeading);
        ctx.fillStyle = ts.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const titleY = hasImage ? cardH * 0.35 : cardH * 0.38;
        // Truncate title to fit
        let titleText = item.title;
        while (ctx.measureText(titleText).width > textW && titleText.length > 5) {
            titleText = titleText.slice(0, -2) + '…';
        }
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 3;
        ctx.fillText(titleText, textX, titleY);
        ctx.shadowBlur = 0;

        // Value (big, bold, accent color)
        if (item.value) {
            MGRenderer._setFont(ctx, '800', Math.min(36, ts.titleSize ? ts.titleSize - 8 : 36), ts.fontHeading);
            ctx.fillStyle = accentColor;
            ctx.textBaseline = 'middle';
            const valY = hasImage ? cardH * 0.65 : cardH * 0.65;
            ctx.shadowColor = accentColor + '40';
            ctx.shadowBlur = 8;
            ctx.fillText(item.value, textX, valY);
            ctx.shadowBlur = 0;
        }
    }

    /** Animate a stat number string with count-up effect */
    _animateStatNumber(numStr, progress) {
        // Extract numeric part and prefix/suffix
        const match = numStr.match(/^([<>~±+\-]?)(\d[\d,.]*)(%?)$/);
        if (!match) return numStr;
        const prefix = match[1];
        const numPart = match[2].replace(/,/g, '');
        const suffix = match[3];
        const targetNum = parseFloat(numPart);
        if (isNaN(targetNum)) return numStr;
        const currentNum = targetNum * progress;
        // Format with commas if original had them
        const hasCommas = match[2].includes(',');
        let formatted;
        if (numPart.includes('.')) {
            const decimals = numPart.split('.')[1].length;
            formatted = currentNum.toFixed(decimals);
        } else {
            formatted = Math.round(currentNum).toString();
        }
        if (hasCommas) {
            formatted = formatted.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }
        return prefix + formatted + suffix;
    }

    /**
     * Cleanup resources.
     */
    destroy() {
        this._canvas = null;
        this._ctx = null;
    }
}

window.MGRenderer = MGRenderer;
