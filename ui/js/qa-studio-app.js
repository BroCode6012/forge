/**
 * QA Studio — Renderer-Side Application
 *
 * Standalone window. Loads video-plan.json, renders each scene to a real video
 * clip (audio + animations + effects) via ExportPipeline with in/out points,
 * then sends each clip to the main-process QA agent through validated IPC.
 *
 * Gemini sees and hears the full composited output — not screenshots.
 * Analysis is read-only until the user explicitly applies reviewed fixes.
 */

(function () {
    'use strict';

    // ── STATE ──────────────────────────────────────────────────────────────
    const state = {
        videoPlan: null,
        projectRevision: 0,
        projectPlanHash: null,
        scenes: [],          // all scenes from plan (footage + templates + MGs)
        projectDir: null,
        compositor: null,
        isRunning: false,
        isCancelled: false,
        activePipeline: null, // current ExportPipeline — cancelled immediately on stop
        results: new Map(),  // sceneIndex → analysis result
        selectedScene: null,
    };

    // ── DOM ────────────────────────────────────────────────────────────────
    const $ = id => document.getElementById(id);
    const els = {
        loadingOverlay:    $('loading-overlay'),
        projectName:       $('project-name'),
        sceneCount:        $('scene-count'),
        sceneList:         $('scene-list'),
        previewCanvas:     $('preview-canvas'),
        previewLabel:      $('preview-label'),
        previewFramesDots: $('preview-frames'),
        analysisEmpty:     $('analysis-empty'),
        analysisContent:   $('analysis-content'),
        progressFill:      $('progress-bar-fill'),
        progressText:      $('progress-text'),
        progressCount:     $('progress-count'),
        btnRun:            $('btn-run'),
        btnStop:           $('btn-stop'),
        btnApply:          $('btn-apply'),
        btnResetQA:        $('btn-reset-qa'),
        readonlyBadge:     $('readonly-badge'),
        providerSelect:    $('qa-provider-select'),
        compositorCanvas:  $('qa-compositor-canvas'),
        // summary stats
        statTotal:    $('stat-total'),
        statAnalyzed: $('stat-analyzed'),
        statPass:     $('stat-pass'),
        statReview:   $('stat-review'),
        statReject:   $('stat-reject'),
        statAvg:      $('stat-avg'),
        issueWatermark: $('issue-watermark'),
        issueFace:      $('issue-face'),
        issueContext:   $('issue-context'),
        issueAnimation: $('issue-animation'),
        issueQuality:   $('issue-quality'),
        issueMg:        $('issue-mg'),
    };

    // ── INIT ───────────────────────────────────────────────────────────────
    async function init() {
        try {
            // Get project info
            const info = await window.electronAPI.getProjectInfo();
            state.projectDir = info?.projectDir || null;
            const projectName = info?.projectName || info?.projectDir?.split(/[\\/]/).pop() || 'Unknown Project';
            els.projectName.textContent = projectName;
            document.title = `QA Studio — ${projectName}`;

            // Init QA Studio log
            if (window.electronAPI?.qaAgentInitLog) {
                await window.electronAPI.qaAgentInitLog();
            }
            window.electronAPI?.onQAReplaceProgress?.((message) => {
                log(`[Replace] ${message}`);
            });

            // Load video plan
            const projectState = await window.electronAPI.loadProjectFile();
            const plan = projectState?.videoPlan || await window.electronAPI.loadVideoPlan();
            if (!plan || !plan.scenes || plan.scenes.length === 0) {
                showError('No video plan found. Build a video first.');
                return;
            }
            state.videoPlan = plan;
            state.projectRevision = Number(projectState?.revision) || 0;
            state.projectPlanHash = projectState?.planHash || null;
            window._mgBridgeVideoPlan = plan; // sync with mg-theme-bridge.js for MG style resolution

            // Collect ALL scenes: footage + templates + MG scenes
            state.scenes = _collectAllScenes(plan);

            // Init compositor (preview scale)
            await _initCompositor(plan);

            // Render scene list
            _renderSceneList();

            // Restore saved QA results (if window was closed mid-analysis)
            await _loadSavedResults();

            _updateSummary();

            // Hide loading
            els.loadingOverlay.style.display = 'none';

            setProgress(0, `Ready — ${state.scenes.length} scenes to review`);
            log(`QA Studio initialized: ${state.scenes.length} scenes, project="${projectName}"`);
            // Update chat context bar once plan is loaded (chat may already be open)
            setTimeout(() => { if (typeof _chatUpdateContextBar === 'function') _chatUpdateContextBar(); }, 0);

        } catch (err) {
            showError(`Initialization failed: ${err.message}`);
            console.error('[QA Studio]', err);
        }
    }

    // ── QA RESULTS PERSISTENCE ──────────────────────────────────────────────
    // Auto-saves after every scene so closing the window never loses work.
    // Results are keyed by sceneIndex and stored in temp/qa-results.json.

    async function _saveResults() {
        if (!window.electronAPI?.saveQAResults || state.results.size === 0) return;
        try {
            const payload = {
                timestamp: Date.now(),
                projectDir: state.projectDir,
                results: Object.fromEntries(state.results),
            };
            await window.electronAPI.saveQAResults(payload);
        } catch (e) {
            console.warn('[QA Save] failed:', e.message);
        }
    }

    async function _loadSavedResults() {
        if (!window.electronAPI?.loadQAResults) return;
        try {
            const resp = await window.electronAPI.loadQAResults();
            if (!resp?.data?.results) return;

            // Only restore if it's the same project
            if (resp.data.projectDir && resp.data.projectDir !== state.projectDir) {
                log('Saved QA results are from a different project — skipping restore');
                return;
            }

            const saved = resp.data.results;
            let restored = 0;
            for (const [key, result] of Object.entries(saved)) {
                const idx = parseInt(key, 10);
                if (isNaN(idx)) continue;
                // Only restore if scene still exists in current plan
                if (!state.scenes.find(s => s.sceneIndex === idx)) continue;
                state.results.set(idx, result);
                _updateSceneCard(idx, result);
                restored++;
            }

            if (restored > 0) {
                log(`♻️ Restored ${restored} saved QA results`);
                _refreshApplyButton();
            }
        } catch (e) {
            console.warn('[QA Load] failed:', e.message);
        }
    }

    // Save on window close
    window.addEventListener('beforeunload', () => { _saveResults(); });

    /**
     * Inject previous QA results + fix history into the scene object
     * so the agent knows what happened in prior analysis rounds.
     */
    function _injectFixHistory(scene) {
        const prevResult = state.results.get(scene.sceneIndex);
        const planScene = scene.source === 'scenes'
            ? state.videoPlan?.scenes?.[scene.arrayIndex]
            : scene.source === 'templateScenes'
                ? state.videoPlan?.templateScenes?.[scene.arrayIndex]
                : null;

        const history = [];

        // Previous analysis result
        if (prevResult && prevResult.verdict) {
            history.push({
                score: prevResult.score,
                verdict: prevResult.verdict,
                issues: prevResult.issues || [],
                watermark: prevResult.watermark || '',
                context: prevResult.context || '',
                fixStrategy: prevResult.fixStrategy || '',
                replacementKeyword: prevResult.replacementKeyword || '',
            });
        }

        // Fix data from video plan
        if (planScene) {
            scene.qaFixCount = planScene.qaFixCount || 0;
            if (planScene.qaFixed) scene.qaWasFixed = true;
            if (planScene.qaReplaced) scene.qaWasReplaced = true;
            if (planScene.qaFixReason) scene.qaLastFixReason = planScene.qaFixReason;
        }

        if (history.length > 0) {
            scene.qaPriorResults = history;
        }
    }

    // ── COLLECT ALL SCENES ─────────────────────────────────────────────────
    function _collectAllScenes(plan) {
        const all = [];
        // mgScenes = fullscreen V3 MGs; motionGraphics = overlay MGs (lowerThird, statCounter, etc.)
        // Both need to be cross-referenced to find what's actually visible on each scene
        const mgScenesArr    = plan.mgScenes      || [];
        const overlayMGsArr  = plan.motionGraphics || [];

        for (let i = 0; i < (plan.scenes || []).length; i++) {
            const s = plan.scenes[i];
            if (s.disabled) continue;

            // Cross-reference: find MGs that BELONG to this scene.
            // Overlay MGs have a sceneIndex field pointing to the scene they were placed for —
            // use that as the primary match to avoid bleed-over from MGs extending into the next scene.
            // Fullscreen V3 MGs (mgScenes) use time overlap since they don't always have sceneIndex.
            const sceneIdx = s.index !== undefined ? s.index : i;
            const midTime  = ((s.startTime || 0) + (s.endTime || 0)) / 2;

            const overlayMGs = overlayMGsArr.filter(mg => {
                if (mg.disabled) return false;
                // Primary: match by sceneIndex if available
                if (mg.sceneIndex !== undefined && mg.sceneIndex !== null) {
                    return mg.sceneIndex === sceneIdx;
                }
                // Fallback: MG starts within this scene's time range
                return (mg.startTime || 0) >= (s.startTime || 0) &&
                       (mg.startTime || 0) <  (s.endTime   || 0);
            });

            const fullscreenMGs = mgScenesArr.filter(mg => {
                if (mg.disabled) return false;
                // Primary: match by sceneIndex if available
                if (mg.sceneIndex !== undefined && mg.sceneIndex !== null) {
                    return mg.sceneIndex === sceneIdx;
                }
                // Fallback: time overlap
                return (mg.startTime || 0) < (s.endTime || 0) &&
                       (mg.endTime   || 0) > (s.startTime || 0);
            });

            const overlappingMGs = [...fullscreenMGs, ...overlayMGs];

            // Primary MG = the one closest to midpoint
            const overlappingMG = overlappingMGs.reduce((best, mg) => {
                if (!best) return mg;
                const bMid = mg.endTime ? (mg.startTime + mg.endTime) / 2 : mg.startTime + (mg.duration || 0) / 2;
                const cMid = best.endTime ? (best.startTime + best.endTime) / 2 : best.startTime + (best.duration || 0) / 2;
                return Math.abs(bMid - midTime) < Math.abs(cMid - midTime) ? mg : best;
            }, null);

            all.push({
                sceneIndex:   s.index !== undefined ? s.index : i,
                arrayIndex:   i,
                source:       'scenes',
                startTime:    s.startTime  || 0,
                endTime:      s.endTime    || 0,
                keyword:      s.keyword    || '',
                narrationText: s.text      || '',
                sceneType:    s.mediaType === 'template' ? 'template' : (s.isMGScene ? 'motion-graphic' : 'footage'),
                mediaType:    s.mediaType  || 'video',       // video / image / template
                sourceHint:   s.sourceHint || '',            // stock / youtube / reddit / web-image
                visualIntent: s.visualIntent || '',          // VP's description of what footage should look like
                effectName:   s.effect || s.effectPreset || 'none',
                framingMode:  (s.framing || s.framingMode || 'fullscreen'),
                // MG distinction: VP suggestion vs confirmed placed
                vpMgHint:     s.mgHint      || '',
                activeMG:     overlappingMG ? _describeMG(overlappingMG) : '',
                activeMGList: overlappingMGs.map(_describeMG),  // all MGs on this scene
                hasMG:        overlappingMG?.mgType || s.mgHint || '',
                trackId:      s.trackId || 'video-track-1',
            });
        }

        for (let i = 0; i < mgScenesArr.length; i++) {
            const s = mgScenesArr[i];
            if (s.disabled) continue;
            all.push({
                sceneIndex:   10000 + i,
                arrayIndex:   i,
                source:       'mgScenes',
                startTime:    s.startTime || 0,
                endTime:      s.endTime   || 0,
                keyword:      s.keyword   || s.mgType || 'MG',
                narrationText: s.text     || '',
                sceneType:    'motion-graphic',
                mediaType:    'motion-graphic',
                sourceHint:   '',
                visualIntent: '',
                effectName:   'none',
                framingMode:  'fullscreen',
                vpMgHint:     '',
                activeMG:     _describeMG(s),
                activeMGList: [_describeMG(s)],
                hasMG:        s.mgType || '',
                trackId:      s.trackId || 'video-track-3',
            });
        }

        // Template scenes (personIntro, factCard, statCard, etc.) — stored separately in templateScenes[]
        const templateScenesArr = plan.templateScenes || [];
        for (let i = 0; i < templateScenesArr.length; i++) {
            const s = templateScenesArr[i];
            if (s.disabled) continue;
            all.push({
                sceneIndex:   20000 + i,
                arrayIndex:   i,
                source:       'templateScenes',
                startTime:    s.startTime || 0,
                endTime:      s.endTime   || 0,
                keyword:      s.type || 'template',
                narrationText: s.text || s.narration || '',
                sceneType:    'template',
                mediaType:    'template',
                sourceHint:   '',
                visualIntent: '',
                effectName:   'none',
                framingMode:  'fullscreen',
                vpMgHint:     s.templateHint || '',
                activeMG:     _describeTemplate(s),
                activeMGList: [_describeTemplate(s)],
                hasMG:        s.templateType || s.type || '',
                trackId:      s.trackId || 'video-track-3',
                // For personIntro: store expected person name SEPARATELY so Gemini
                // must visually identify first, then compare (prevents confirmation bias)
                personIntroExpectedName: (s.type || '').toLowerCase() === 'personintro' ? (s.name || '') : '',
            });
        }

        all.sort((a, b) => a.startTime - b.startTime);

        // Annotate prev/next keywords for surrounding context
        for (let i = 0; i < all.length; i++) {
            all[i].prevKeyword = i > 0              ? all[i - 1].keyword : '';
            all[i].nextKeyword = i < all.length - 1 ? all[i + 1].keyword : '';
        }

        return all;
    }

    // ── PROJECT OVERVIEW FOR AGENT ────────────────────────────────────────
    /**
     * Build a compact project overview that gives the QA agent full awareness
     * of every scene, the video structure, pacing, and prior analysis results.
     * Kept compact to fit Gemini's context window.
     */
    function _buildProjectOverview() {
        const sc = state.videoPlan?.scriptContext || {};
        const scenes = state.scenes || [];
        const totalDuration = scenes.length > 0
            ? scenes[scenes.length - 1].endTime
            : 0;

        // Compact scene table: #idx time keyword [type] [source] [MG] [score] [fix]
        const sceneRows = scenes.map(s => {
            const dur   = (s.endTime - s.startTime).toFixed(1);
            const parts = [`#${s.sceneIndex} ${s.startTime.toFixed(1)}-${s.endTime.toFixed(1)}s (${dur}s) "${s.keyword}"`];
            if (s.sceneType !== 'footage') parts.push(`[${s.sceneType}]`);
            if (s.sourceHint && s.sourceHint !== 'stock') parts.push(`src:${s.sourceHint}`);
            if (s.framingMode && s.framingMode !== 'fullscreen') parts.push(`frame:${s.framingMode}`);
            if (s.activeMG) parts.push(`MG:${s.activeMG.split('|')[0].trim()}`);
            if (s.effectName && s.effectName !== 'none') parts.push(`fx:${s.effectName}`);
            // Prior QA result
            const r = state.results.get(s.sceneIndex);
            if (r && r.verdict !== 'error') {
                parts.push(`→ ${r.score}/10 ${r.verdict}`);
                if (r.issues.length) parts.push(`(${r.issues.join(',')})`);
            }
            // Fix status from plan
            const ps = s.source === 'scenes' ? state.videoPlan?.scenes?.[s.arrayIndex] : null;
            if (ps?.qaFixed)    parts.push('✓fixed');
            if (ps?.qaReplaced) parts.push('🔄replaced');
            if (ps?.qaFixCount > 1) parts.push(`×${ps.qaFixCount}`);
            return parts.join(' ');
        });

        return {
            totalScenes:   scenes.length,
            totalDuration: totalDuration.toFixed(1),
            pacing:        sc.pacing    || 'moderate',
            hook:          sc.hook      || '',
            cta:           sc.cta       || '',
            language:      sc.language  || 'en',
            sections:      sc.sections  || [],
            sceneMap:      sceneRows.join('\n'),
        };
    }

    // ── MG DESCRIPTION ────────────────────────────────────────────────────
    /**
     * Serialize an MG scene object into a human-readable string for the prompt.
     * Includes type, variant, and all text content so Gemini knows exactly what to expect.
     */
    function _describeMG(mg) {
        if (!mg) return '';
        // mgScenes use mgType; motionGraphics use type
        const parts = [`type:${mg.mgType || mg.type || '?'}`];
        if (mg.category) parts.push(`cat:${mg.category}`);
        if (mg.variant)   parts.push(`variant:${mg.variant}`);
        if (mg.text)      parts.push(`text:"${mg.text}"`);
        if (mg.title)     parts.push(`title:"${mg.title}"`);
        if (mg.subtitle)  parts.push(`subtitle:"${mg.subtitle}"`);
        if (mg.subtext)   parts.push(`subtext:"${mg.subtext}"`);
        if (mg.label)     parts.push(`label:"${mg.label}"`);
        if (mg.value !== undefined && mg.value !== null && mg.value !== '') parts.push(`value:${mg.value}`);
        if (mg.data)      parts.push(`data:"${mg.data}"`);
        if (mg.items && mg.items.length) parts.push(`items:[${mg.items.slice(0, 5).map(it => `"${it.text || it.label || it}"`).join(', ')}]`);
        if (mg.stats && mg.stats.length) parts.push(`stats:[${mg.stats.slice(0, 4).map(st => `${st.label}:${st.value}`).join(', ')}]`);
        if (mg.position)  parts.push(`pos:${mg.position}`);
        return parts.join(' | ');
    }

    function _describeTemplate(s) {
        if (!s) return '';
        const parts = [`type:${s.type || '?'}`];
        if (s.variant)   parts.push(`variant:${s.variant}`);
        if (s.style)     parts.push(`style:${s.style}`);
        if (s.title)     parts.push(`title:"${s.title}"`);
        if (s.subtitle)  parts.push(`subtitle:"${s.subtitle}"`);
        // NOTE: name/role intentionally omitted here — passed separately as personIntroExpectedName
        // so Gemini must visually identify the person before comparing (prevents confirmation bias).
        if ((s.type || '').toLowerCase() !== 'personintro') {
            if (s.name)  parts.push(`name:"${s.name}"`);
            if (s.role)  parts.push(`role:"${s.role}"`);
        }
        if (s.fact)      parts.push(`fact:"${s.fact}"`);
        if (s.stat)      parts.push(`stat:"${s.stat}"`);
        if (s.label)     parts.push(`label:"${s.label}"`);
        if (s.value !== undefined && s.value !== null && s.value !== '') parts.push(`value:${s.value}`);
        // Label as search_queries (not items) — these are what we SEARCHED FOR, not what we found.
        // This prevents Gemini from using them as confirmation of the actual person shown.
        if (s.items && s.items.length) {
            const queries = s.items.slice(0, 3).map(it => `"${it.text || it.label || it}"`).join(', ');
            // For personIntro: also hide person-name search queries to prevent confirmation bias
            if ((s.type || '').toLowerCase() !== 'personintro') {
                parts.push(`image_search_queries:[${queries}]`);
            }
        }
        if (s.animation) parts.push(`anim:${s.animation}`);
        return parts.join(' | ');
    }

    // ── COMPOSITOR INIT ────────────────────────────────────────────────────
    async function _initCompositor(plan) {
        const canvas = els.compositorCanvas;
        // Full resolution — ExportPipeline resizes MGRenderer to plan resolution anyway,
        // so keeping 50% causes a mismatch between PBO allocation and actual frame size.
        canvas.width  = plan.width  || 1920;
        canvas.height = plan.height || 1080;

        state.compositor = new Compositor(canvas, {
            preserveDrawingBuffer: true,
            antialias: false,
        });

        const resolveProjectFile = async (filePath) => {
            if (!filePath) return null;
            const value = String(filePath);
            if (/^(https?:|data:|blob:|asset:)/i.test(value)) return value;

            let candidate = value;
            const isAbsolute = /^[a-z]:[\\/]/i.test(candidate)
                || candidate.startsWith('/')
                || candidate.startsWith('\\\\')
                || /^file:/i.test(candidate);
            if (!isAbsolute && state.projectDir) {
                const relative = candidate.replace(/\\/g, '/').replace(/^public\//i, '');
                candidate = `${state.projectDir}/public/${relative}`;
            }
            return window.electronAPI.getFileUrl(candidate).catch(() => null);
        };
        const resolveSceneUrl = async (sceneIndex, extension) => {
            const mediaPath = await window.electronAPI.getSceneMediaPath(sceneIndex, extension);
            return resolveProjectFile(mediaPath);
        };

        // SceneGraph.loadFromPlan only reads plan.mgScenes — it does NOT read plan.templateScenes.
        // The main app merges templateScenes into mgScenes before loading. We must do the same.
        const augmentedPlan = await _augmentPlanForCompositor(plan, resolveProjectFile);

        await state.compositor.loadPlan(augmentedPlan, resolveSceneUrl, resolveProjectFile);
        log('Compositor initialized and plan loaded');
    }

    /**
     * Merge plan.templateScenes into plan.mgScenes with the same shape the main app uses
     * (isMGScene:true, trackId:video-track-3, mediaType:template, mgData unwrapped).
     * SceneGraph.loadFromPlan ignores plan.templateScenes entirely.
     *
     * Also resolves _itemThumbnails → _itemThumbnailUrls using confined asset:// URLs,
     * which is required for MGRenderer to display portrait/context images.
     */
    async function _augmentPlanForCompositor(plan, resolveProjectFile) {
        const templateScenes = plan.templateScenes || [];
        if (templateScenes.length === 0) return plan; // nothing to do

        const publicDir = state.projectDir ? state.projectDir.replace(/\\/g, '/') + '/public' : null;

        const toAssetUrl = async (filePath) => {
            if (!filePath) return null;
            const value = String(filePath);
            if (/^(https?:|data:|blob:|asset:)/i.test(value)) return value;
            // If it's just a filename (tpl-item-0.jpg), prefix with public/.
            const fullPath = value.includes('/') || value.includes('\\')
                ? value
                : (publicDir ? `${publicDir}/${value}` : value);
            return resolveProjectFile(fullPath);
        };

        const extraMGs = await Promise.all(templateScenes.map(async (mg) => {
            const { mgData: _nested, ...mgFlat } = mg;
            let core = mg;
            while (core.mgData) core = core.mgData;
            const startTime = Number(mg.startTime) || 0;
            const endTime = Number(mg.endTime) > startTime
                ? Number(mg.endTime)
                : startTime + (Number(mg.duration) || 4);
            const duration = endTime - startTime;
            const sceneObj = {
                isMGScene:  true,
                trackId:    'video-track-3',
                mediaType:  'template',
                templateType: true,
                startTime,
                endTime,
                duration,
                durationFrames: Math.max(1, Math.round(duration * (plan.fps || 30))),
                durationUnit: 'seconds',
                text:       mg.text    || '',
                subtext:    mg.subtext || mg.subText || '',
                type:       mg.type,
                position:   mg.position  || 'center',
                style:      mg.style     || 'clean',
                keyword:    `Template: ${mg.type}`,
                mgData:     core === mg ? mgFlat : core,
            };
            if (mg.variant)   sceneObj.variant   = mg.variant;
            if (mg.animation) sceneObj.animation = mg.animation;
            if (mg.themeId)   sceneObj.themeId   = mg.themeId;
            if (mg.items)     sceneObj.items      = mg.items;
            if (mg.name)      sceneObj.name       = mg.name;
            if (mg.role)      sceneObj.role       = mg.role;
            if (mg.fact)      sceneObj.fact       = mg.fact;
            if (mg.stat)      sceneObj.stat       = mg.stat;
            if (mg.label)     sceneObj.label      = mg.label;
            if (mg.value !== undefined) sceneObj.value = mg.value;

            // _itemThumbnails — portrait/context image filenames (e.g. tpl-item-0.jpg).
            // MGRenderer uses _itemThumbnailUrls to load them.
            if (core._itemThumbnails) {
                sceneObj._itemThumbnails = core._itemThumbnails;
                sceneObj._itemThumbnailUrls = await Promise.all(core._itemThumbnails.map(toAssetUrl));
                if (sceneObj.mgData) {
                    sceneObj.mgData._itemThumbnails    = core._itemThumbnails;
                    sceneObj.mgData._itemThumbnailUrls = sceneObj._itemThumbnailUrls;
                }
            }

            if (core.articleImageFile) { sceneObj.articleImageFile = core.articleImageFile; if (sceneObj.mgData) sceneObj.mgData.articleImageFile = core.articleImageFile; }
            if (core.mapImageFile)     { sceneObj.mapImageFile = core.mapImageFile; if (sceneObj.mgData) sceneObj.mgData.mapImageFile = core.mapImageFile; }
            return sceneObj;
        }));

        return {
            ...plan,
            mgScenes: [...(plan.mgScenes || []), ...extraMGs],
        };
    }

    // ── SCENE LIST RENDER ──────────────────────────────────────────────────
    function _renderSceneList() {
        els.sceneCount.textContent = `(${state.scenes.length})`;
        els.sceneList.innerHTML = '';

        for (const scene of state.scenes) {
            const card = document.createElement('div');
            card.className = 'scene-card pending';
            card.dataset.sceneIndex = scene.sceneIndex;

            const thumb = document.createElement('div');
            thumb.className = 'scene-thumb-placeholder';
            thumb.id = `thumb-${scene.sceneIndex}`;
            thumb.textContent = scene.sceneType === 'motion-graphic' ? 'MG' : scene.sceneType === 'template' ? 'T' : '';

            // Check plan for already-applied fixes on this scene
            const planScene = scene.source === 'scenes'
                ? state.videoPlan?.scenes?.[scene.arrayIndex]
                : scene.source === 'templateScenes'
                    ? state.videoPlan?.templateScenes?.[scene.arrayIndex]
                    : null;
            const isReplaced = planScene?.qaReplaced;
            const isFixed    = planScene?.qaFixed && !isReplaced;
            const isFlagged  = planScene?.flagForReplacement;

            const info = document.createElement('div');
            info.className = 'scene-card-info';
            const timeStr = `${scene.startTime.toFixed(1)}s`;
            const fixCount = planScene?.qaFixCount || 0;
            const countTag = fixCount > 1 ? ` <span style="color:#f97316;font-size:9px;font-weight:700">×${fixCount}</span>` : '';
            const fixTag = isReplaced ? ` <span style="color:#818cf8;font-size:9px;font-weight:700">🔄 REPLACED${countTag}</span>` :
                           isFixed    ? ` <span style="color:#22c55e;font-size:9px;font-weight:700">✂ FIXED${countTag}</span>` :
                           isFlagged  ? ` <span style="color:#f59e0b;font-size:9px;font-weight:700">⚠ FLAGGED</span>` : '';
            info.innerHTML = `
                <div class="idx">#${scene.sceneIndex} · ${timeStr}${fixTag}</div>
                <div class="kw">${_escHtml(scene.keyword || 'scene')}</div>
                <div class="time">${scene.sceneType}</div>
            `;

            const badge = document.createElement('div');
            badge.className = 'score-badge pending';
            badge.id = `badge-${scene.sceneIndex}`;
            badge.textContent = '·';

            card.appendChild(thumb);
            card.appendChild(info);
            card.appendChild(badge);

            card.addEventListener('click', () => selectScene(scene.sceneIndex));
            els.sceneList.appendChild(card);
        }
    }

    // ── SELECT SCENE ───────────────────────────────────────────────────────
    async function selectScene(sceneIndex) {
        if (state.selectedScene !== null) {
            const prev = els.sceneList.querySelector(`[data-scene-index="${state.selectedScene}"]`);
            if (prev) prev.classList.remove('active');
        }
        state.selectedScene = sceneIndex;

        const card = els.sceneList.querySelector(`[data-scene-index="${sceneIndex}"]`);
        if (card) card.classList.add('active');

        const scene = state.scenes.find(s => s.sceneIndex === sceneIndex);
        if (!scene) return;

        const result = state.results.get(sceneIndex);
        if (result) {
            _renderAnalysis(result, scene);
        } else {
            els.analysisEmpty.style.display = 'flex';
            els.analysisContent.style.display = 'none';
            // Show "Analyze this scene" button in empty state
            _renderAnalyzeButton(scene);
        }

        await _renderPreviewFrame(scene);
    }

    async function _renderPreviewFrame(scene) {
        if (!state.compositor) return;
        try {
            const fps = state.videoPlan?.fps || 30;
            const midTime = (scene.startTime + scene.endTime) / 2;
            const frame = Math.round(midTime * fps);
            state.compositor.renderFrame(frame);
            await _sleep(400);
            state.compositor.renderFrame(frame);

            const dataUrl = state.compositor.canvas.toDataURL('image/jpeg', 0.8);
            const previewCanvas = els.previewCanvas;
            previewCanvas.width = state.compositor.canvas.width;
            previewCanvas.height = state.compositor.canvas.height;
            const ctx = previewCanvas.getContext('2d');
            const img = new Image();
            img.onload = () => ctx.drawImage(img, 0, 0);
            img.src = dataUrl;

            els.previewLabel.textContent = `#${scene.sceneIndex} "${scene.keyword}" @ ${midTime.toFixed(1)}s`;
        } catch (e) {}
    }

    // ── SINGLE SCENE ANALYZE ──────────────────────────────────────────────
    function _renderAnalyzeButton(scene) {
        const existing = els.analysisEmpty.querySelector('.analyze-single-btn');
        if (existing) existing.remove();

        const btn = document.createElement('button');
        btn.className = 'analyze-single-btn';
        btn.textContent = `Analyze scene #${scene.sceneIndex}`;
        btn.style.cssText = 'margin-top:12px;padding:8px 20px;background:var(--accent);color:#11160e;border:none;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;';
        btn.addEventListener('click', () => {
            if (!state.isRunning) runSingleScene(scene.sceneIndex);
        });
        els.analysisEmpty.appendChild(btn);
    }

    async function runSingleScene(sceneIndex) {
        if (state.isRunning) return;
        if (!state.compositor)     { alert('Compositor not ready'); return; }
        if (!window.electronAPI?.qaAgentAnalyzeScene) { alert('QA Studio Agent not available'); return; }
        if (typeof ExportPipeline === 'undefined') { alert('ExportPipeline not loaded'); return; }

        const scene = state.scenes.find(s => s.sceneIndex === sceneIndex);
        if (!scene) return;

        state.isRunning = true;
        state.isCancelled = false;

        // If this scene was previously fixed/replaced, reload the compositor plan so the new
        // file on disk is picked up (GPU texture cache would otherwise show the old content).
        const planScene = scene.source === 'scenes'
            ? state.videoPlan?.scenes?.[scene.arrayIndex]
            : scene.source === 'templateScenes'
                ? state.videoPlan?.templateScenes?.[scene.arrayIndex]
                : null;
        if (planScene?.qaFixed || planScene?.qaReplaced) {
            setProgress(0, 'Reloading compositor for updated scene…');
            try {
                const freshPlan = await window.electronAPI.loadVideoPlan();
                if (freshPlan) {
                    state.videoPlan = freshPlan;
                    window._mgBridgeVideoPlan = freshPlan;
                    state.scenes = _collectAllScenes(freshPlan);
                    await _initCompositor(freshPlan);
                }
            } catch (e) {
                log(`[Reload] Compositor reload failed: ${e.message} — continuing with cached plan`);
            }
        }

        els.btnRun.style.display = 'none';
        els.btnStop.style.display = 'inline-block';
        els.btnStop.disabled = false;
        els.btnStop.textContent = '■ Stop';

        const provider = els.providerSelect.value;
        await window.electronAPI.qaAgentSetProvider(provider);

        const ctx = {
            title:    state.videoPlan?.scriptContext?.title    || state.videoPlan?.scriptContext?.summary || '',
            niche:    state.videoPlan?.scriptContext?.nicheId  || state.videoPlan?.scriptContext?.niche   || '',
            format:   state.videoPlan?.scriptContext?.format   || 'documentary',
            themeId:  state.videoPlan?.scriptContext?.themeId  || state.videoPlan?.scriptContext?.theme   || 'standard',
            entities: state.videoPlan?.scriptContext?.entities || [],
            projectOverview: _buildProjectOverview(),
            styleBlock: state.videoPlan?.scriptContext?.styleBlock || '',
            styleProfile: state.videoPlan?.scriptContext?.styleProfile || null,
        };

        _setSceneBadge(sceneIndex, 'analyzing', '…');
        setProgress(0, `Rendering clip for scene ${sceneIndex} "${scene.keyword}"...`);

        try {
            const clipPath = await _renderSceneClip(scene, (p) => {
                setProgress(null, `Rendering clip: scene ${sceneIndex} — frame ${p.currentFrame || 0}/${p.totalFrames || 0}`);
            });

            if (state.isCancelled) throw new Error('Cancelled');

            setProgress(50, `Analyzing with Gemini: scene ${sceneIndex}...`);
            _captureThumb(scene).catch(() => {});

            // Inject fix history so agent knows what happened before
            _injectFixHistory(scene);

            const result = await window.electronAPI.qaAgentAnalyzeScene(clipPath, scene, ctx);

            if (result) {
                state.results.set(sceneIndex, result);

                // Re-run produced fresh results — clear previous fix status in memory so
                // Apply Fixes can act on the new issues (don't write to disk, just in-memory reset).
                const _ps = scene.source === 'scenes'
                    ? state.videoPlan?.scenes?.[scene.arrayIndex]
                    : scene.source === 'templateScenes'
                        ? state.videoPlan?.templateScenes?.[scene.arrayIndex]
                        : null;
                if (_ps) {
                    delete _ps.qaFixed;
                    delete _ps.qaReplaced;
                }

                _updateSceneCard(sceneIndex, result);
                _renderAnalysis(result, scene);
                _refreshApplyButton();
                _saveResults(); // auto-save after single scene
                log(`Scene ${sceneIndex}: score=${result.score} verdict=${result.verdict}`);
            }

            setProgress(100, `Scene ${sceneIndex} analyzed`);

        } catch (err) {
            if (!state.isCancelled) {
                log(`Scene ${sceneIndex} failed: ${err.message}`);
                _setSceneBadge(sceneIndex, 'pending', '!');
                els.analysisEmpty.style.display = 'flex';
                els.analysisContent.style.display = 'none';
                _renderAnalyzeButton(scene);
                setProgress(null, `Scene ${sceneIndex} failed: ${err.message}`);
            }
        }

        state.isRunning = false;
        state.isCancelled = false;
        els.btnRun.style.display = 'inline-block';
        els.btnStop.style.display = 'none';
        // Show Apply Fixes if any fixable issues exist
        _refreshApplyButton();
        _updateSummary();
    }

    // ── RENDER SCENE CLIP ──────────────────────────────────────────────────
    /**
     * Render a scene to a real video clip (with audio, animations, effects)
     * using ExportPipeline with in/out points.
     * Returns the path to the output MP4.
     */
    async function _renderSceneClip(scene, onRenderProgress) {
        if (!state.compositor) throw new Error('Compositor not ready');

        const fps = state.videoPlan?.fps || 30;
        const startFrame = Math.round(scene.startTime * fps);
        const endFrame   = Math.round(scene.endTime   * fps);

        if (endFrame <= startFrame) throw new Error(`Empty range for scene ${scene.sceneIndex}`);

        const pipeline = new ExportPipeline(state.compositor);
        state.activePipeline = pipeline;
        pipeline.onProgress(p => {
            if (onRenderProgress) onRenderProgress(p);
        });

        const result = await pipeline.start({
            width:  state.videoPlan.width  || 1920,
            height: state.videoPlan.height || 1080,
            fps,
            startFrame,
            endFrame,
            legacy: true,
        });

        state.activePipeline = null;
        if (!result.success) throw new Error(result.error || 'Clip render failed');
        return result.outputPath;
    }

    // ── CAPTURE THUMBNAIL ─────────────────────────────────────────────────
    /**
     * After a render, grab a frame from the compositor at the scene midpoint
     * for the scene list thumbnail.
     */
    async function _captureThumb(scene) {
        if (!state.compositor) return;
        try {
            const fps = state.videoPlan?.fps || 30;
            const midTime = (scene.startTime + scene.endTime) / 2;
            const frame = Math.round(midTime * fps);
            state.compositor.renderFrame(frame);
            await _sleep(200);
            state.compositor.renderFrame(frame);
            const dataUrl = state.compositor.canvas.toDataURL('image/jpeg', 0.7);
            const base64  = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
            _setSceneThumb(scene.sceneIndex, base64);
        } catch (e) {}
    }

    // ── RUN QA ─────────────────────────────────────────────────────────────
    async function runQA() {
        if (state.isRunning) return;
        if (!state.compositor) { alert('Compositor not ready'); return; }
        if (!window.electronAPI?.qaAgentAnalyzeScene) { alert('QA Studio Agent not available'); return; }
        if (typeof ExportPipeline === 'undefined') { alert('ExportPipeline not loaded'); return; }

        state.isRunning = true;
        state.isCancelled = false;

        els.btnRun.style.display = 'none';
        els.btnStop.style.display = 'inline-block';
        els.btnStop.disabled = false;
        els.btnStop.textContent = '■ Stop';

        const provider = els.providerSelect.value;
        await window.electronAPI.qaAgentSetProvider(provider);

        const ctx = {
            title:    state.videoPlan?.scriptContext?.title    || state.videoPlan?.scriptContext?.summary || '',
            niche:    state.videoPlan?.scriptContext?.nicheId  || state.videoPlan?.scriptContext?.niche   || '',
            format:   state.videoPlan?.scriptContext?.format   || 'documentary',
            themeId:  state.videoPlan?.scriptContext?.themeId  || state.videoPlan?.scriptContext?.theme   || 'standard',
            entities: state.videoPlan?.scriptContext?.entities || [],
            projectOverview: _buildProjectOverview(),
            styleBlock: state.videoPlan?.scriptContext?.styleBlock || '',
            styleProfile: state.videoPlan?.scriptContext?.styleProfile || null,
        };

        log(`=== QA Studio Run Start ===`);
        log(`Provider : ${provider}`);
        log(`Title    : ${ctx.title}`);
        log(`Niche    : ${ctx.niche}`);
        log(`Format   : ${ctx.format}`);
        log(`Theme    : ${ctx.themeId}`);
        log(`Entities : ${ctx.entities.join(', ') || '(none)'}`);
        log(`Scenes   : ${state.scenes.length}`);

        // Only reset badges for scenes that haven't been analyzed yet (or had errors)
        for (const scene of state.scenes) {
            const existing = state.results.get(scene.sceneIndex);
            if (!existing || existing.verdict === 'error') {
                _setSceneBadge(scene.sceneIndex, 'pending', '·');
            }
        }
        _updateSummary();

        const total = state.scenes.length;
        let done = 0;

        for (const scene of state.scenes) {
            if (state.isCancelled) {
                log('Cancelled by user');
                break;
            }

            // Skip already-analyzed scenes (resume behaviour — don't re-analyze on restart)
            const existingResult = state.results.get(scene.sceneIndex);
            if (existingResult && existingResult.verdict !== 'error') {
                done++;
                continue;
            }

            const duration = scene.endTime - scene.startTime;
            if (duration <= 0) {
                log(`Scene ${scene.sceneIndex}: zero duration — skipping`);
                done++;
                continue;
            }

            try {
                // Phase 1: Render the clip
                _setSceneBadge(scene.sceneIndex, 'analyzing', '⟳');
                setProgress(
                    Math.round((done / total) * 100),
                    `Rendering clip: scene ${scene.sceneIndex} "${scene.keyword}" (${duration.toFixed(1)}s)`,
                    `${done}/${total}`
                );

                log(`Scene ${scene.sceneIndex}: rendering clip (${scene.startTime.toFixed(1)}s–${scene.endTime.toFixed(1)}s, ${duration.toFixed(1)}s)`);

                const clipPath = await _renderSceneClip(scene, (p) => {
                    setProgress(
                        null,
                        `Rendering clip: scene ${scene.sceneIndex} — frame ${p.currentFrame || 0}/${p.totalFrames || 0}`
                    );
                });

                if (state.isCancelled) break;

                log(`Scene ${scene.sceneIndex}: clip ready → ${clipPath}`);

                // Phase 2: Analyze with Gemini
                _setSceneBadge(scene.sceneIndex, 'analyzing', '…');
                setProgress(
                    null,
                    `Analyzing with Gemini: scene ${scene.sceneIndex} "${scene.keyword}"`,
                    `${done}/${total}`
                );

                // Capture thumbnail while Gemini analyzes (non-blocking feel)
                _captureThumb(scene).catch(() => {});

                // Inject fix history so agent knows what happened before
                _injectFixHistory(scene);

                const result = await window.electronAPI.qaAgentAnalyzeScene(clipPath, scene, ctx);

                if (state.isCancelled) break;

                if (result) {
                    state.results.set(scene.sceneIndex, result);
                    _updateSceneCard(scene.sceneIndex, result);
                    if (state.selectedScene === scene.sceneIndex) {
                        _renderAnalysis(result, scene);
                    }
                    log(`Scene ${scene.sceneIndex}: score=${result.score} verdict=${result.verdict} issues=[${(result.issues || []).join(',')}]`);
                }

            } catch (err) {
                log(`Scene ${scene.sceneIndex} failed: ${err.message}`);
                _setSceneBadge(scene.sceneIndex, 'pending', '!');
                // Store error result
                state.results.set(scene.sceneIndex, {
                    sceneIndex: scene.sceneIndex,
                    score: null,
                    verdict: 'error',
                    error: err.message,
                    issues: [],
                });
                _updateSceneCard(scene.sceneIndex, state.results.get(scene.sceneIndex));
            }

            done++;
            _updateSummary();
            _saveResults(); // auto-save after every scene
        }

        const wasCancelled = state.isCancelled;
        state.isRunning = false;
        state.isCancelled = false;
        els.btnRun.style.display = 'inline-block';
        els.btnStop.style.display = 'none';
        _refreshApplyButton();

        if (!wasCancelled) {
            setProgress(100, `QA complete — ${state.results.size} scenes analyzed`, `${done}/${total}`);
            log(`=== QA Studio Run Complete: ${state.results.size} analyzed ===`);
        } else {
            setProgress(null, `Cancelled after ${done} scenes`, `${done}/${total}`);
        }
        _updateSummary();
    }

    // ── RENDER ANALYSIS ────────────────────────────────────────────────────
    function _renderAnalysis(result, scene) {
        els.analysisEmpty.style.display = 'none';
        els.analysisContent.style.display = 'block';

        const v = result.verdict || 'pass';
        const score = result.score ?? '?';

        if (result.verdict === 'error') {
            els.analysisContent.innerHTML = `
                <div class="analysis-header">
                    <div class="analysis-score-big reject">!</div>
                    <div>
                        <span class="analysis-verdict reject">ERROR</span>
                        <div class="analysis-keyword">${_escHtml(scene.keyword || 'Scene ' + result.sceneIndex)}</div>
                        <div class="analysis-time">#${result.sceneIndex} · ${scene.startTime.toFixed(1)}s–${scene.endTime.toFixed(1)}s</div>
                    </div>
                </div>
                <div class="analysis-recommendation">
                    <div class="label">Error</div>
                    <div class="value" style="color:var(--reject)">${_escHtml(result.error || 'Unknown error')}</div>
                </div>
                <button id="btn-retry-scene" style="margin-top:12px;padding:8px 20px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">↺ Retry Analysis</button>
            `;
            document.getElementById('btn-retry-scene')?.addEventListener('click', () => {
                if (!state.isRunning) {
                    state.results.delete(result.sceneIndex);
                    runSingleScene(result.sceneIndex);
                }
            });
            return;
        }

        const fieldClass = (val, goodVals = ['good', 'ok', 'none', 'clean', 'smooth', 'n/a', 'pass']) => {
            if (val === null || val === undefined) return '';
            const lower = String(val).toLowerCase();
            if (goodVals.some(g => lower.startsWith(g))) return 'ok';
            if (lower.startsWith('poor') || lower.startsWith('bad') || lower.startsWith('reject') || lower.startsWith('broken') || lower.startsWith('jarring') || lower.startsWith('wrong-person') || lower.startsWith('presenter')) return 'bad';
            return 'warn';
        };

        els.analysisContent.innerHTML = `
            <details class="scene-info-block" open>
                <summary class="scene-info-label">SCENE PROPERTIES</summary>
                <div class="scene-info-grid">
                    <div class="si-row"><span class="si-key">Type</span><span class="si-val">${_escHtml(scene.sceneType)}</span></div>
                    <div class="si-row"><span class="si-key">Media</span><span class="si-val">${_escHtml(scene.mediaType || 'video')}</span></div>
                    <div class="si-row"><span class="si-key">Source</span><span class="si-val">${_escHtml(scene.sourceHint || 'stock')}</span></div>
                    <div class="si-row"><span class="si-key">Framing</span><span class="si-val">${_escHtml(scene.framingMode || 'fullscreen')}</span></div>
                    <div class="si-row"><span class="si-key">Effect</span><span class="si-val">${_escHtml(scene.effectName || 'none')}</span></div>
                    <div class="si-row"><span class="si-key">Keyword</span><span class="si-val">${_escHtml(scene.keyword || '—')}</span></div>
                    ${scene.visualIntent ? `<div class="si-row si-full"><span class="si-key">VP Intent</span><span class="si-val">${_escHtml(scene.visualIntent)}</span></div>` : ''}
                    <div class="si-row si-full"><span class="si-key">VP MG Hint</span><span class="si-val">${_escHtml(scene.vpMgHint || 'none')}</span></div>
                    <div class="si-row si-full"><span class="si-key">Active MG</span><span class="si-val ${scene.activeMG ? 'si-highlight' : ''}">${_escHtml(scene.activeMG || 'none')}</span></div>
                </div>
            </details>

            ${result.sceneSummary ? `
            <div class="scene-summary-block">
                <div class="scene-summary-label">AI INTERPRETATION</div>
                <div class="scene-summary-text">${_escHtml(result.sceneSummary)}</div>
            </div>` : ''}

            <div class="analysis-header">
                <div class="analysis-score-big ${v}">${score}</div>
                <div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                        <span class="analysis-verdict ${v}">${v.toUpperCase()}</span>
                        <button id="btn-rerun-analysis" type="button" style="font-size:9px;padding:2px 7px;background:var(--bg4);color:var(--text2);border:1px solid var(--border);border-radius:4px;cursor:pointer;" title="Re-analyze this scene">↺ Re-run</button>
                    </div>
                    <div class="analysis-keyword">${_escHtml(scene.keyword || 'Scene ' + result.sceneIndex)}</div>
                    <div class="analysis-time">#${result.sceneIndex} · ${scene.startTime.toFixed(1)}s–${scene.endTime.toFixed(1)}s · ${scene.sceneType}</div>
                </div>
            </div>

            ${result.issues && result.issues.length > 0 ? `
            <div class="analysis-issues">
                ${result.issues.map(i => `<span class="issue-tag">${_escHtml(i.replace(/_/g, ' '))}</span>`).join('')}
            </div>` : ''}

            <div class="analysis-grid">
                <div class="analysis-field ${fieldClass(result.watermark)}">
                    <div class="label">Watermark</div>
                    <div class="value">${_escHtml(result.watermark || 'none')}${result.fixStrategy === 'zoom' ? `<br><span style="color:#00d4aa;font-size:10px;font-weight:600">🔍 fix: zoom ${result.zoomLevel || 1.1}x</span>` : result.cropFix && result.cropFix !== 'flag' ? `<br><span style="color:#6c63ff;font-size:10px;font-weight:600">✂ fix: ${_escHtml(result.cropFix)}</span>` : result.cropFix === 'flag' ? `<br><span style="color:#f59e0b;font-size:10px;font-weight:600">⚠ too large — flag for replacement</span>` : ''}</div>
                </div>
                <div class="analysis-field ${fieldClass(result.face)}">
                    <div class="label">Face</div>
                    <div class="value">${_escHtml(result.face || 'none')}</div>
                </div>
                ${result.personMatch ? `<div class="analysis-field ${fieldClass(result.personMatch, ['match'])}">
                    <div class="label">Person Match</div>
                    <div class="value">${_escHtml(result.personMatch)}</div>
                </div>` : ''}
                <div class="analysis-field ${fieldClass(result.context)}">
                    <div class="label">Context Match</div>
                    <div class="value">${_escHtml(result.context || '—')}</div>
                </div>
                <div class="analysis-field ${fieldClass(result.audio, ['ok'])}">
                    <div class="label">Audio</div>
                    <div class="value">${_escHtml(result.audio || '—')}</div>
                </div>
                <div class="analysis-field ${fieldClass(result.animation, ['smooth', 'n/a', 'ok'])}">
                    <div class="label">Animation</div>
                    <div class="value">${_escHtml(result.animation || 'n/a')}</div>
                </div>
                <div class="analysis-field ${fieldClass(result.mgText)}">
                    <div class="label">MG Text</div>
                    <div class="value">${_escHtml(result.mgText || '—')}</div>
                </div>
                <div class="analysis-field ${fieldClass(result.quality)}">
                    <div class="label">Quality</div>
                    <div class="value">${_escHtml(result.quality || '—')}</div>
                </div>
                <div class="analysis-field ${fieldClass(result.transition, ['natural', 'clean', 'ok'])}">
                    <div class="label">Edit Point</div>
                    <div class="value">${_escHtml(result.transition || '—')}</div>
                </div>
            </div>

            ${result.recommendation ? `
            <div class="analysis-recommendation">
                <div class="label">Recommendation</div>
                <div class="value">${_escHtml(result.recommendation)}</div>
            </div>` : ''}

            ${result.replacementKeyword ? `
            <div class="analysis-replacement" style="border:1px solid #7c3aed;border-radius:6px;padding:10px 14px;margin-top:8px;background:rgba(124,58,237,0.08)">
                <div class="label" style="color:#a78bfa;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Auto-Replacement Suggestion</div>
                ${result.replacementDiagnosis ? `<div style="color:#c4b5fd;font-size:11px;margin-bottom:6px">🔍 ${_escHtml(result.replacementDiagnosis)}</div>` : ''}
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <span style="background:#4c1d95;color:#ddd6fe;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600">🔑 ${_escHtml(result.replacementKeyword)}</span>
                    ${result.replacementSource ? `<span style="background:#1e1b4b;color:#a5b4fc;padding:3px 10px;border-radius:4px;font-size:11px">📡 ${_escHtml(result.replacementSource)}</span>` : ''}
                </div>
            </div>` : ''}

            ${result.notes ? `
            <div class="analysis-notes">
                <div class="label">Notes</div>
                <div class="value">${_escHtml(result.notes)}</div>
            </div>` : ''}
        `;
        document.getElementById('btn-rerun-analysis')?.addEventListener('click', () => {
            if (!state.isRunning) runSingleScene(result.sceneIndex);
        });
    }

    // ── SCENE CARD UPDATES ─────────────────────────────────────────────────
    function _updateSceneCard(sceneIndex, result) {
        const v = result.verdict || 'pass';
        const score = result.score ?? (v === 'error' ? '!' : '?');
        _setSceneBadge(sceneIndex, v === 'error' ? 'pending' : v, score);

        const card = els.sceneList.querySelector(`[data-scene-index="${sceneIndex}"]`);
        if (card) {
            card.classList.remove('pending', 'analyzing');
            if (v === 'reject') card.style.borderColor = 'var(--reject)';
            else if (v === 'review') card.style.borderColor = 'var(--review)';
        }
    }

    function _setSceneBadge(sceneIndex, cls, text) {
        const badge = $(`badge-${sceneIndex}`);
        if (badge) {
            badge.className = `score-badge ${cls}`;
            badge.textContent = text;
        }
    }

    function _setSceneThumb(sceneIndex, base64) {
        const thumbEl = $(`thumb-${sceneIndex}`);
        if (!thumbEl) return;
        const img = document.createElement('img');
        img.className = 'scene-thumb';
        img.src = `data:image/jpeg;base64,${base64}`;
        img.alt = '';
        thumbEl.replaceWith(img);
    }

    // ── SUMMARY ────────────────────────────────────────────────────────────
    function _updateSummary() {
        const total    = state.scenes.length;
        const analyzed = state.results.size;
        let pass = 0, review = 0, reject = 0, scoreSum = 0, scoreCnt = 0;
        const issueCounts = { watermark: 0, face: 0, context: 0, animation: 0, quality: 0, mg: 0 };

        for (const r of state.results.values()) {
            if (r.verdict === 'pass')   pass++;
            else if (r.verdict === 'review') review++;
            else if (r.verdict === 'reject') reject++;
            if (r.score != null) { scoreSum += r.score; scoreCnt++; }
            for (const issue of (r.issues || [])) {
                if (issue.includes('watermark'))  issueCounts.watermark++;
                else if (issue.includes('face'))      issueCounts.face++;
                else if (issue.includes('context'))   issueCounts.context++;
                else if (issue.includes('animation')) issueCounts.animation++;
                else if (issue.includes('quality'))   issueCounts.quality++;
                else if (issue.includes('mg'))        issueCounts.mg++;
            }
        }

        els.statTotal.textContent    = total;
        els.statAnalyzed.textContent = analyzed;
        els.statPass.textContent     = pass   || '—';
        els.statReview.textContent   = review || '—';
        els.statReject.textContent   = reject || '—';
        els.statAvg.textContent      = scoreCnt ? (scoreSum / scoreCnt).toFixed(1) : '—';

        const setIssue = (el, count) => {
            el.textContent = count;
            el.className = `count${count === 0 ? ' zero' : ''}`;
        };
        setIssue(els.issueWatermark, issueCounts.watermark);
        setIssue(els.issueFace,      issueCounts.face);
        setIssue(els.issueContext,   issueCounts.context);
        setIssue(els.issueAnimation, issueCounts.animation);
        setIssue(els.issueQuality,   issueCounts.quality);
        setIssue(els.issueMg,        issueCounts.mg);
    }

    // ── PROGRESS ───────────────────────────────────────────────────────────
    function setProgress(pct, text, count) {
        if (pct !== null) els.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        if (text)  els.progressText.textContent  = text;
        if (count) els.progressCount.textContent = count;
    }

    // ── UTILS ──────────────────────────────────────────────────────────────
    function _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function _escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function log(...args) {
        if (window.electronAPI?.qaAgentLog) {
            window.electronAPI.qaAgentLog('[App]', ...args).catch(() => {});
        } else {
            console.log('[QA Studio App]', ...args);
        }
    }

    function showError(msg) {
        els.loadingOverlay.innerHTML = `
            <div style="color:var(--reject);font-size:16px">⚠</div>
            <div style="color:var(--text);font-size:14px">${_escHtml(msg)}</div>
            <div style="color:var(--text2);font-size:12px">Close this window and check the main app.</div>
        `;
    }

    // ── APPLY BUTTON VISIBILITY ────────────────────────────────────────────
    function _refreshApplyButton() {
        // Show Apply Fixes button if any scene has unfixed fixable issues.
        // Scenes that were already fixed (qaFixed/qaReplaced) but NOT re-analyzed
        // since the fix are considered resolved — skip them.
        let hasFixable = false;
        for (const [sceneIndex, result] of state.results) {
            if (result.verdict === 'error') continue;
            const scene = state.scenes.find(s => s.sceneIndex === sceneIndex);
            if (!scene) continue;

            // Check if this scene was already fixed in the plan
            const planScene = scene.source === 'scenes'
                ? state.videoPlan?.scenes?.[scene.arrayIndex]
                : scene.source === 'templateScenes'
                    ? state.videoPlan?.templateScenes?.[scene.arrayIndex]
                    : null;
            if (planScene?.qaFixed || planScene?.qaReplaced) continue;

            // Template scenes: show button if wrong-person + replacement keyword available
            if (scene.source === 'templateScenes') {
                if (result.issues?.includes('face_wrong_person') && result.replacementKeyword) {
                    hasFixable = true;
                    break;
                }
                continue;
            }

            // MG scenes have no fixable footage issues — skip
            if (scene.source === 'mgScenes') continue;

            // Footage scenes
            if (scene.source !== 'scenes') continue;

            const hasWatermark     = result.watermark && !result.watermark.toLowerCase().startsWith('none');
            const hasCaptionBar    = result.issues?.includes('caption_bar');
            const hasCenterOverlay = result.issues?.includes('center_overlay');
            const hasContextBad    = result.issues?.includes('context_mismatch');
            const hasWrongPerson   = result.issues?.includes('face_wrong_person');
            const hasReject        = result.verdict === 'reject';

            if (hasWatermark || hasCaptionBar || hasCenterOverlay || hasContextBad || hasWrongPerson || hasReject) {
                hasFixable = true;
                break;
            }
        }
        els.btnApply.style.display = hasFixable ? 'inline-block' : 'none';
    }

    // ── APPLY FIXES ────────────────────────────────────────────────────────

    /**
     * Extract watermark locations named in the WATERMARK field.
     * Returns a Set of location keywords: {'top-left', 'bottom-right', ...}
     */
    function _extractWatermarkLocations(watermarkText) {
        const w = (watermarkText || '').toLowerCase();
        const locs = new Set();
        const candidates = ['top-left','top-right','bottom-left','bottom-right','top','bottom','left','right','center'];
        for (const loc of candidates) {
            if (w.includes(loc)) locs.add(loc);
        }
        return locs;
    }

    /**
     * Parse the AI-provided CROP_FIX string into compositor crop properties.
     * Cross-validates against watermarkText — only applies crops for locations
     * that were actually named in the WATERMARK field (prevents hallucinated crops).
     *
     * Input format: "top-left:10, bottom-right:14"  (one entry per named watermark)
     * Caps per-side crop at 25%.
     */
    function _parseCropFix(cropFixStr, watermarkText) {
        if (!cropFixStr) return null;
        const s = cropFixStr.trim().toLowerCase();
        if (!s || s === 'none' || s === 'flag') return null;

        // Extract locations Gemini actually reported in WATERMARK
        const namedLocs = _extractWatermarkLocations(watermarkText);

        const result = {};
        const MAX_CROP = 25;

        const applySide = (side, pct) => {
            const p = Math.min(MAX_CROP, Math.max(1, pct));
            switch (side) {
                case 'top':          result.cropTop    = Math.max(result.cropTop    || 0, p); break;
                case 'bottom':       result.cropBottom = Math.max(result.cropBottom || 0, p); break;
                case 'left':         result.cropLeft   = Math.max(result.cropLeft   || 0, p); break;
                case 'right':        result.cropRight  = Math.max(result.cropRight  || 0, p); break;
                case 'top-left':     applySide('top', p);    applySide('left', p);   break;
                case 'top-right':    applySide('top', p);    applySide('right', p);  break;
                case 'bottom-left':  applySide('bottom', p); applySide('left', p);   break;
                case 'bottom-right': applySide('bottom', p); applySide('right', p);  break;
            }
        };

        for (const part of s.split(',')) {
            const colonIdx = part.indexOf(':');
            if (colonIdx === -1) continue;
            const loc    = part.slice(0, colonIdx).trim();
            const pctStr = part.slice(colonIdx + 1).trim();
            if (pctStr === 'flag') continue; // individual flag entries → handled separately

            // ── Cross-validation: skip if this location wasn't named in WATERMARK ──
            // Check if any sub-location of this entry matches a named watermark location
            const locParts = loc.includes('-') ? loc.split('-') : [loc]; // top-left → ['top','left']
            const isNamed = namedLocs.has(loc) ||
                            locParts.every(p => [...namedLocs].some(nl => nl.includes(p)));
            if (!isNamed) {
                log(`[CropFix] Skipping "${loc}:${pctStr}" — location not in WATERMARK field`);
                continue;
            }

            const pct = parseInt(pctStr) || 10;
            applySide(loc, pct);
        }

        return Object.keys(result).length > 0 ? result : null;
    }

    // Pre-crop a project media file in-place through the narrow main-process
    // FFmpeg IPC. The renderer never receives process or filesystem access.
    async function _ffmpegPreCrop(mediaFile, crop) {
        const result = await window.electronAPI.qaPreCropMedia({ mediaFile, crop });
        if (!result?.success) {
            throw new Error(result?.error || 'FFmpeg pre-crop failed');
        }
        return result.mediaFile || mediaFile;
    }

    async function applyFixes() {
        if (state.isRunning) return;
        if (state.results.size === 0) { alert('No QA results to apply.'); return; }
        state.isRunning = true;
        els.btnApply.disabled = true;
        els.btnApply.textContent = '⏳ Applying…';

        const cropFixes = [];
        const flagged   = [];
        const templateFixes = []; // portrait image replacements for personIntro wrong-person

        for (const [sceneIndex, result] of state.results) {
            if (result.verdict === 'error') continue;

            const scene = state.scenes.find(s => s.sceneIndex === sceneIndex);
            if (!scene) continue;

            // Handle template scenes (personIntro wrong person → replace portrait image)
            if (scene.source === 'templateScenes') {
                const tplScene = state.videoPlan?.templateScenes?.[scene.arrayIndex];
                if (!tplScene || tplScene.qaFixed) continue;
                if (result.issues?.includes('face_wrong_person') && result.replacementKeyword) {
                    templateFixes.push({ scene, tplScene, result });
                }
                continue;
            }

            // MG scenes have no fixable footage — skip
            if (scene.source === 'mgScenes') continue;

            // Only fix regular footage scenes — not plain MG scenes
            if (scene.source !== 'scenes') continue;

            const planScene0 = state.videoPlan?.scenes?.[scene.arrayIndex];

            // Skip scenes already fixed — they need re-analysis before re-fixing
            if (planScene0?.qaFixed || planScene0?.qaReplaced) continue;

            const fixStrategy = result.fixStrategy || null;
            const hasWatermark = result.watermark && !result.watermark.toLowerCase().startsWith('none');
            const hasCaptionBar = result.issues?.includes('caption_bar') && result.captionCrop;
            const hasCenterOverlay = result.issues?.includes('center_overlay');
            const hasContextMismatch = result.issues?.includes('context_mismatch');

            // Hard replacement cases — context mismatch or center overlay
            if (hasContextMismatch || hasCenterOverlay || fixStrategy === 'flag') {
                const reason = hasContextMismatch ? `context mismatch: ${result.context?.substring(0, 80)}`
                             : hasCenterOverlay   ? `center overlay: ${result.bakedText?.substring(0, 80)}`
                             : `watermark: ${result.watermark?.substring(0, 80)}`;
                flagged.push({ scene, reason });
                continue;
            }

            // Caption bar — crop edge + shift (small bars) or crop + zoom (large bars)
            if (hasCaptionBar && (fixStrategy === 'caption_shift' || fixStrategy === 'scale')) {
                const captionCrop = _parseCropFix(result.captionCrop, result.captionCrop);
                if (captionCrop) {
                    cropFixes.push({ scene, crop: captionCrop, cropFixStr: result.captionCrop,
                                     reason: `caption bar: ${result.bakedText?.substring(0, 80)}`,
                                     fixStrategy, floatingBg: null });
                    continue;
                }
            }

            if (!hasWatermark) continue;

            // Zoom-only strategy — just scale up, no crop
            if (fixStrategy === 'zoom') {
                const zoomLevel = result.zoomLevel || 1.1;
                cropFixes.push({
                    scene, crop: {}, cropFixStr: `zoom ${zoomLevel}x`,
                    reason: result.watermark.substring(0, 100),
                    fixStrategy: 'zoom', zoomLevel,
                    floatingBg: null,
                });
                continue;
            }

            // Floating strategy
            if (fixStrategy === 'floating') {
                cropFixes.push({
                    scene, crop: {}, cropFixStr: 'floating',
                    reason: result.watermark.substring(0, 100),
                    fixStrategy: 'floating',
                    floatingBg: result.floatingBg || 'soft-gray',
                });
                continue;
            }

            // Scale strategy — crop + zoom
            const cropFixStr = result.cropFix || '';
            if (!cropFixStr || cropFixStr === 'flag') {
                flagged.push({ scene, reason: `watermark: ${result.watermark.substring(0, 100)}` });
                continue;
            }
            const crop = _parseCropFix(cropFixStr, result.watermark);
            if (crop) {
                cropFixes.push({ scene, crop, cropFixStr, reason: result.watermark.substring(0, 100), fixStrategy: 'scale', floatingBg: null });
            } else {
                flagged.push({ scene, reason: `watermark: ${result.watermark.substring(0, 100)}` });
            }
        }

        if (cropFixes.length === 0 && flagged.length === 0 && templateFixes.length === 0) {
            state.isRunning = false;
            els.btnApply.disabled = false;
            els.btnApply.textContent = '✓ Apply Fixes';
            alert('No fixable issues found in analyzed scenes.');
            return;
        }

        // Build confirmation message — show actual action, not just AI strategy
        const details = [
            ...cropFixes.map(f => {
                const ps = state.videoPlan.scenes[f.scene.arrayIndex];
                const alreadyFloating = ps?.framing === 'floating' || ps?.framingMode === 'floating';
                if (f.fixStrategy === 'zoom') {
                    return `  🔍 #${f.scene.sceneIndex} "${f.scene.keyword}" → zoom ${f.zoomLevel || 1.1}x (no crop)`;
                } else if (alreadyFloating && Object.keys(f.crop).length > 0) {
                    return `  ✂📁 #${f.scene.sceneIndex} "${f.scene.keyword}" → FFmpeg pre-crop ${f.cropFixStr} (floating — no black bars)`;
                } else if (f.fixStrategy === 'caption_shift') {
                    return `  ✂ #${f.scene.sceneIndex} "${f.scene.keyword}" → caption crop ${f.cropFixStr} + frame shift`;
                } else if (f.fixStrategy === 'floating') {
                    return `  🖼 #${f.scene.sceneIndex} "${f.scene.keyword}" → switch to floating card (${f.floatingBg})`;
                } else {
                    return `  ✂ #${f.scene.sceneIndex} "${f.scene.keyword}" → crop ${f.cropFixStr} + zoom`;
                }
            }),
            ...flagged.map(f => {
                const r = state.results.get(f.scene.sceneIndex);
                const ps = state.videoPlan?.scenes?.[f.scene.arrayIndex];
                return r?.replacementKeyword && ps?.mediaFile
                    ? `  🔄 #${f.scene.sceneIndex} "${f.scene.keyword}" → auto-replace with "${r.replacementKeyword}" via ${r.replacementSource || 'auto'}`
                    : `  ⚠ #${f.scene.sceneIndex} "${f.scene.keyword}" → flag for manual replacement`;
            }),
            ...templateFixes.map(f =>
                `  🖼 #${f.scene.sceneIndex} personIntro portrait → replace with "${f.result.replacementKeyword}" via ${f.result.replacementSource || 'stock'}`
            ),
        ].join('\n');

        const msg = [
            cropFixes.length    ? `${cropFixes.length} crop fix${cropFixes.length > 1 ? 'es' : ''}` : '',
            flagged.length      ? `${flagged.length} flagged` : '',
            templateFixes.length ? `${templateFixes.length} portrait replaced` : '',
        ].filter(Boolean).join(' + ');

        if (!confirm(`Apply QA fixes to video-plan.json?\n\n${details}\n\nThe main app will reflect changes on next refresh.`)) {
            state.isRunning = false;
            els.btnApply.disabled = false;
            els.btnApply.textContent = '✓ Apply Fixes';
            return;
        }

        const totalOps = cropFixes.length + flagged.length + templateFixes.length;
        let doneOps = 0;
        const progress = (msg) => {
            doneOps++;
            const pct = totalOps > 0 ? Math.round((doneOps / totalOps) * 90) : 50;
            setProgress(pct, msg);
        };

        setProgress(5, `Applying ${cropFixes.length} fix${cropFixes.length !== 1 ? 'es' : ''} + ${flagged.length} replacement${flagged.length !== 1 ? 's' : ''}…`);

        // Helper: apply new crop values additively onto an existing plan scene.
        // Adds new amounts to whatever is already there, capped at 40% per side total.
        const MAX_CROP_TOTAL = 40;
        const _additiveCrop = (planScene, newCrop) => {
            for (const side of ['cropTop', 'cropBottom', 'cropLeft', 'cropRight']) {
                if (newCrop[side]) {
                    planScene[side] = Math.min(MAX_CROP_TOTAL, (planScene[side] || 0) + newCrop[side]);
                }
            }
        };

        // Apply AI-specified corrections
        for (const fix of cropFixes) {
            const planScene = state.videoPlan.scenes[fix.scene.arrayIndex];
            if (!planScene) continue;

            const isAlreadyFloating = planScene.framing === 'floating' || planScene.framingMode === 'floating';

            if (isAlreadyFloating && Object.keys(fix.crop).length > 0) {
                // Scene is already floating — pre-crop the source file with FFmpeg
                if (planScene.mediaFile && window.electronAPI?.qaPreCropMedia) {
                    try {
                        setProgress(null, `Scene #${fix.scene.sceneIndex}: FFmpeg pre-crop ${fix.cropFixStr}…`);
                        log(`[Fix] Scene ${fix.scene.sceneIndex} floating → FFmpeg pre-crop ${fix.cropFixStr}`);
                        await _ffmpegPreCrop(planScene.mediaFile, fix.crop);
                        delete planScene.cropTop; delete planScene.cropRight;
                        delete planScene.cropBottom; delete planScene.cropLeft;
                        delete planScene.scale;
                        setProgress(null, `Scene #${fix.scene.sceneIndex}: pre-crop done ✓`);
                    } catch (e) {
                        setProgress(null, `Scene #${fix.scene.sceneIndex}: FFmpeg failed — using shader crop`);
                        log(`[Fix] FFmpeg pre-crop failed for scene ${fix.scene.sceneIndex}: ${e.message} — falling back to shader crop`);
                        _additiveCrop(planScene, fix.crop);
                    }
                } else {
                    _additiveCrop(planScene, fix.crop);
                }
            } else if (fix.fixStrategy === 'zoom') {
                // Zoom only — no crop, just scale up to push edge logos off-frame
                const zoomVal = fix.zoomLevel || 1.1;
                planScene.scale = Math.max(planScene.scale || 1, zoomVal);
                setProgress(null, `Scene #${fix.scene.sceneIndex}: zoom ${zoomVal}x (no crop)`);
                log(`[Fix] Scene ${fix.scene.sceneIndex} "${fix.scene.keyword}" — zoom only ${zoomVal}x`);
            } else if (fix.fixStrategy === 'caption_shift') {
                setProgress(null, `Scene #${fix.scene.sceneIndex}: caption crop ${fix.cropFixStr}…`);
                _additiveCrop(planScene, fix.crop);
                // Compute fill-frame scale + position offset (same as scale strategy)
                const cl2 = planScene.cropLeft || 0, cr2 = planScene.cropRight || 0;
                const ct2 = planScene.cropTop  || 0, cb2 = planScene.cropBottom || 0;
                const sH = (cl2 + cr2) > 0 ? 100 / (100 - cl2 - cr2) : 1;
                const sV = (ct2 + cb2) > 0 ? 100 / (100 - ct2 - cb2) : 1;
                const capScale = parseFloat(Math.min(2.0, Math.max(sH, sV)).toFixed(3));
                if (capScale > 1.0) {
                    planScene.scale = capScale;
                    planScene.posX = parseFloat((capScale * (cr2 - cl2) / 2).toFixed(2));
                    planScene.posY = parseFloat((capScale * (cb2 - ct2) / 2).toFixed(2));
                }
                log(`[Fix] Scene ${fix.scene.sceneIndex} "${fix.scene.keyword}" — caption crop ${fix.cropFixStr} → scale ${capScale} posX=${planScene.posX || 0} posY=${planScene.posY || 0}`);
            } else if (fix.fixStrategy === 'floating') {
                setProgress(null, `Scene #${fix.scene.sceneIndex}: switching to floating card…`);
                planScene.framingMode        = 'floating';
                planScene.floatingBackground = fix.floatingBg || 'soft-gray';
                planScene.floatingAnim       = planScene.floatingAnim || 'fadeScale';
                planScene.floatingShadow     = planScene.floatingShadow ?? 0.5;
                delete planScene.cropTop; delete planScene.cropRight;
                delete planScene.cropBottom; delete planScene.cropLeft;
                delete planScene.scale;
                log(`[Fix] Scene ${fix.scene.sceneIndex} "${fix.scene.keyword}" → floating (${fix.floatingBg})`);
            } else {
                // Scale strategy: add crop additively + compute compensating scale + position offset.
                // With transform-origin:center, asymmetric crops need a translate to center the visible area.
                // Formula: scale = max(100/(100-L-R), 100/(100-T-B))
                //          posX  = scale * (R - L) / 2   (shift toward cropped side)
                //          posY  = scale * (B - T) / 2   (shift toward cropped side)
                _additiveCrop(planScene, fix.crop);
                const cl = planScene.cropLeft   || 0;
                const cr = planScene.cropRight  || 0;
                const ct = planScene.cropTop    || 0;
                const cb = planScene.cropBottom || 0;
                const scaleH = (cl + cr) > 0 ? 100 / (100 - cl - cr) : 1;
                const scaleV = (ct + cb) > 0 ? 100 / (100 - ct - cb) : 1;
                const compScale = parseFloat(Math.min(2.0, Math.max(scaleH, scaleV)).toFixed(3));
                if (compScale > 1.0) {
                    planScene.scale = compScale;
                    // Position offset to center the visible area within the frame
                    planScene.posX = parseFloat((compScale * (cr - cl) / 2).toFixed(2));
                    planScene.posY = parseFloat((compScale * (cb - ct) / 2).toFixed(2));
                }
                log(`[Fix] Scene ${fix.scene.sceneIndex} "${fix.scene.keyword}" — crop T${ct}/B${cb}/L${cl}/R${cr} → scale ${compScale} posX=${planScene.posX || 0} posY=${planScene.posY || 0}`);
            }

            planScene.qaFixed     = true;
            planScene.qaFixReason = fix.reason;
            planScene.qaFixCount  = (planScene.qaFixCount || 0) + 1;
        }

        // Apply flags — auto-replace if QA suggested a keyword, otherwise just flag
        for (const flag of flagged) {
            const planScene = state.videoPlan.scenes[flag.scene.arrayIndex];
            if (!planScene) continue;

            const result = state.results.get(flag.scene.sceneIndex);

            if (result?.replacementKeyword && planScene.mediaFile && window.electronAPI?.qaReplaceSceneMedia) {
                // Auto-replacement: download new footage, overwrite mediaFile in-place
                const mediaType = planScene.mediaType || (planScene.mediaFile?.match(/\.(jpg|jpeg|png|webp)$/i) ? 'image' : 'video');
                const sceneDur  = Math.round((flag.scene.endTime || 10) - (flag.scene.startTime || 0)) || 8;

                setProgress(null, `Scene #${flag.scene.sceneIndex}: downloading "${result.replacementKeyword}" via ${result.replacementSource || 'auto'}…`);
                log(`[Replace] Scene ${flag.scene.sceneIndex} "${flag.scene.keyword}" → downloading "${result.replacementKeyword}" via ${result.replacementSource || 'auto'}…`);

                const replResult = await window.electronAPI.qaReplaceSceneMedia({
                    mediaFile:     planScene.mediaFile,
                    keyword:       result.replacementKeyword,
                    sourceHint:    result.replacementSource || '',
                    mediaType,
                    sceneDuration: sceneDur,
                    scriptContext: state.videoPlan.scriptContext || {},
                });

                if (replResult.success) {
                    setProgress(null, `Scene #${flag.scene.sceneIndex}: replaced ✓`);
                    planScene.qaReplaced         = true;
                    planScene.qaFixed            = true;
                    planScene.qaFixReason        = `Auto-replaced: ${result.replacementKeyword}`;
                    planScene.qaFixCount         = (planScene.qaFixCount || 0) + 1;
                    // Update keyword so compositor and timeline show the new content
                    planScene.keyword            = result.replacementKeyword;
                    planScene.sourceHint         = result.replacementSource || planScene.sourceHint;
                    // Clear the flag — scene is now fixed
                    delete planScene.flagForReplacement;
                    delete planScene.qaReplacementKeyword;
                    delete planScene.qaReplacementSource;
                    delete planScene.qaReplacementDiagnosis;
                    log(`[Replace] ✅ Scene ${flag.scene.sceneIndex} replaced successfully`);
                } else {
                    // Download failed — fall back to flagging for manual replacement
                    planScene.flagForReplacement     = true;
                    planScene.qaReason               = flag.reason;
                    planScene.qaReplacementKeyword   = result.replacementKeyword;
                    planScene.qaReplacementSource    = result.replacementSource || '';
                    planScene.qaReplacementDiagnosis = result.replacementDiagnosis || '';
                    const errMsg = `Scene #${flag.scene.sceneIndex} replacement failed: ${replResult.error}`;
                    setProgress(null, errMsg);
                    log(`[Replace] ⚠ ${errMsg}`);
                    console.error('[QA Apply]', errMsg);
                }
            } else {
                // No replacement keyword — just flag for manual review
                planScene.flagForReplacement     = true;
                planScene.qaReason               = flag.reason;
                if (result?.replacementKeyword) {
                    planScene.qaReplacementKeyword   = result.replacementKeyword;
                    planScene.qaReplacementSource    = result.replacementSource || '';
                    planScene.qaReplacementDiagnosis = result.replacementDiagnosis || '';
                }
                log(`[Fix] Scene ${flag.scene.sceneIndex} "${flag.scene.keyword}" — flagged: ${flag.reason}`);
            }
        }

        // Apply template portrait replacements (personIntro wrong-person)
        for (const fix of templateFixes) {
            const { scene, tplScene, result } = fix;
            const portraitFile = tplScene._itemThumbnails?.[0]; // first item = portrait
            if (!portraitFile || !window.electronAPI?.qaReplaceSceneMedia) {
                log(`[Replace] Scene #${scene.sceneIndex}: no portrait file or replacer unavailable`);
                continue;
            }

            // QA replacer resolves relative paths against the active project's
            // public/temp/assets roots and rejects anything outside them.
            if (typeof portraitFile !== 'string' || !portraitFile.trim()) {
                log(`[Replace] Scene #${scene.sceneIndex}: cannot resolve portrait path for "${portraitFile}"`);
                continue;
            }

            setProgress(null, `Scene #${scene.sceneIndex}: downloading portrait "${result.replacementKeyword}"…`);
            log(`[Replace] Scene #${scene.sceneIndex} personIntro portrait → "${result.replacementKeyword}" via ${result.replacementSource || 'stock'}`);

            const replResult = await window.electronAPI.qaReplaceSceneMedia({
                mediaFile:     portraitFile,
                keyword:       result.replacementKeyword,
                sourceHint:    result.replacementSource || 'stock',
                mediaType:     'image',
                sceneDuration: 5,
                scriptContext: state.videoPlan.scriptContext || {},
            });

            if (replResult.success) {
                tplScene.qaFixed    = true;
                tplScene.qaReplaced = true;
                tplScene.qaFixCount = (tplScene.qaFixCount || 0) + 1;
                tplScene.qaFixReason = `Portrait replaced: ${result.replacementKeyword}`;
                setProgress(null, `Scene #${scene.sceneIndex}: portrait replaced ✓`);
                log(`[Replace] ✅ Scene #${scene.sceneIndex} portrait replaced`);
            } else {
                setProgress(null, `Scene #${scene.sceneIndex}: portrait replacement failed — ${replResult.error}`);
                log(`[Replace] ⚠ Scene #${scene.sceneIndex} portrait failed: ${replResult.error}`);
            }
        }

        try {
            setProgress(95, 'Saving video-plan.json…');
            const saveResult = await window.electronAPI.saveVideoPlan(
                state.videoPlan,
                state.projectRevision,
                state.projectPlanHash
            );
            if (!saveResult?.success) throw new Error(saveResult?.error || 'Unified project save failed');
            state.projectRevision = Number(saveResult.revision) || state.projectRevision;
            state.projectPlanHash = saveResult.planHash || state.projectPlanHash;
            log(`[Fix] Saved video-plan.json — ${cropFixes.length} crops, ${flagged.length} flags`);

            window.electronAPI.pushPlanToMain?.({
                videoPlan: state.videoPlan,
                revision: state.projectRevision,
                planHash: state.projectPlanHash,
            })?.catch?.(() => {});

            if (els.readonlyBadge) {
                els.readonlyBadge.textContent = 'FIXES APPLIED';
                els.readonlyBadge.className = 'writes-badge';
            }

            _renderSceneList();
            _updateSummary();
            setProgress(100, `Done — ${msg}`);
        } catch (err) {
            setProgress(0, `Save failed: ${err.message}`);
            alert(`Failed to save plan: ${err.message}`);
            log(`[Fix] Save failed: ${err.message}`);
        } finally {
            state.isRunning = false;
            els.btnApply.disabled = false;
            els.btnApply.textContent = '✓ Apply Fixes';
            _refreshApplyButton();
        }
    }

    // ── EVENT LISTENERS ────────────────────────────────────────────────────
    els.btnRun.addEventListener('click', runQA);

    els.btnStop.addEventListener('click', () => {
        state.isCancelled = true;
        els.btnStop.disabled = true;
        els.btnStop.textContent = 'Stopping...';
        // Kill the active render immediately — don't wait for it to finish
        if (state.activePipeline) {
            state.activePipeline.cancel();
            state.activePipeline = null;
        }
    });

    els.btnApply.addEventListener('click', applyFixes);

    els.btnResetQA.addEventListener('click', async () => {
        if (state.isRunning) return;
        if (!state.videoPlan?.scenes?.length) return;
        if (!confirm('Remove all QA-applied data (crop, scale, framingMode, flags) from every scene in video-plan.json?\n\nThis lets you re-test from a clean slate.')) return;

        const QA_FIELDS = ['qaFixed','qaFixReason','qaFixCount','qaReason','qaReplaced','flagForReplacement',
                           'qaReplacementKeyword','qaReplacementSource','qaReplacementDiagnosis',
                           'cropTop','cropRight','cropBottom','cropLeft','scale',
                           'framingMode','floatingBackground','floatingAnim','floatingShadow'];
        let cleared = 0;
        for (const scene of state.videoPlan.scenes) {
            const had = QA_FIELDS.some(f => scene[f] !== undefined);
            QA_FIELDS.forEach(f => delete scene[f]);
            if (had) cleared++;
        }
        for (const tpl of (state.videoPlan.templateScenes || [])) {
            const had = QA_FIELDS.some(f => tpl[f] !== undefined);
            QA_FIELDS.forEach(f => delete tpl[f]);
            if (had) cleared++;
        }

        if (cleared === 0) { alert('No QA data found in plan — nothing to reset.'); return; }

        const saveResult = await window.electronAPI.saveVideoPlan(
            state.videoPlan,
            state.projectRevision,
            state.projectPlanHash
        );
        if (!saveResult?.success) throw new Error(saveResult?.error || 'Unified project save failed');
        state.projectRevision = Number(saveResult.revision) || state.projectRevision;
        state.projectPlanHash = saveResult.planHash || state.projectPlanHash;
        window.electronAPI.pushPlanToMain?.({
            videoPlan: state.videoPlan,
            revision: state.projectRevision,
            planHash: state.projectPlanHash,
        })?.catch?.(() => {});
        state.results.clear();
        _saveResults(); // clear saved results file too
        _renderSceneList();
        els.btnApply.style.display = 'none';
        log(`[Reset] Cleared QA data from ${cleared} scene(s) and saved plan`);
    });

    els.providerSelect.addEventListener('change', () => {
        if (window.electronAPI?.qaAgentSetProvider) {
            window.electronAPI.qaAgentSetProvider(els.providerSelect.value).catch(() => {});
        }
    });

    // ── AGENT CHAT ─────────────────────────────────────────────────────────

    const chatEls = {
        panel:      $('chat-panel'),
        toggleBtn:  $('btn-chat'),
        closeBtn:   $('btn-chat-close'),
        contextBar: $('chat-context-bar'),
        messages:   $('chat-messages'),
        input:      $('chat-input'),
        sendBtn:    $('chat-send-btn'),
    };

    const chatState = {
        history: [],
        sending: false,
        open: false,
    };

    function _chatOpen() {
        chatState.open = true;
        chatEls.panel.classList.add('open');
        chatEls.toggleBtn.classList.add('active');
        _chatUpdateContextBar();
        chatEls.input.focus();
    }

    function _chatClose() {
        chatState.open = false;
        chatEls.panel.classList.remove('open');
        chatEls.toggleBtn.classList.remove('active');
    }

    function _chatUpdateContextBar() {
        if (!chatEls.contextBar) return;
        const ctx = state.videoPlan?.scriptContext || {};
        const niche  = ctx.nicheId || ctx.niche || '—';
        const title  = ctx.title   || ctx.summary || '—';
        const qaSize = state.results.size;
        chatEls.contextBar.innerHTML =
            `<span>${_escHtml(title.substring(0, 35))}</span> · niche:<span>${_escHtml(niche)}</span> · qa:<span>${qaSize} analyzed</span>`;
    }

    function _chatAddSys(text) {
        const div = document.createElement('div');
        div.className = 'chat-sys';
        div.textContent = text;
        chatEls.messages.appendChild(div);
        chatEls.messages.scrollTop = chatEls.messages.scrollHeight;
    }

    function _chatAddMsg(role, text) {
        const wrap = document.createElement('div');
        wrap.className = `chat-msg ${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'chat-avatar';
        avatar.textContent = role === 'user' ? 'U' : 'AI';

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        // Escape + inline code + basic newline → <br>
        bubble.innerHTML = _escHtml(text)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');

        wrap.appendChild(avatar);
        wrap.appendChild(bubble);
        chatEls.messages.appendChild(wrap);
        chatEls.messages.scrollTop = chatEls.messages.scrollHeight;
    }

    function _chatAddTyping() {
        const wrap = document.createElement('div');
        wrap.className = 'chat-msg model';
        wrap.id = 'chat-typing';

        const avatar = document.createElement('div');
        avatar.className = 'chat-avatar';
        avatar.textContent = 'AI';

        const indicator = document.createElement('div');
        indicator.className = 'chat-typing';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.className = 'chat-typing-dot';
            indicator.appendChild(dot);
        }

        wrap.appendChild(avatar);
        wrap.appendChild(indicator);
        chatEls.messages.appendChild(wrap);
        chatEls.messages.scrollTop = chatEls.messages.scrollHeight;
        return wrap;
    }

    function _buildProjectContext() {
        const ctx = state.videoPlan?.scriptContext || {};
        const plan = state.videoPlan || {};

        // Build a compact scene list so the agent knows every scene
        const sceneList = state.scenes.map(s => {
            const dur = ((s.endTime || 0) - (s.startTime || 0)).toFixed(1);
            const type = s.templateType ? `template:${s.templateType}` : (s.isMGScene ? 'mg' : 'footage');
            return { i: s.sceneIndex, keyword: s.keyword || '', type, dur: `${dur}s` };
        });

        return {
            title:       ctx.title    || ctx.summary || '',
            nicheId:     ctx.nicheId  || ctx.niche   || '',
            format:      ctx.format   || 'documentary',
            themeId:     ctx.themeId  || ctx.theme   || 'standard',
            language:    ctx.language || 'en',
            entities:    ctx.entities || [],
            totalScenes: state.scenes.length,
            totalDuration: plan.totalDuration || state.totalDuration || 0,
            sceneList,
            qaResults: Array.from(state.results.values()).map(r => ({
                sceneIndex:          r.sceneIndex,
                keyword:             r.keyword             || state.scenes.find(s => s.sceneIndex === r.sceneIndex)?.keyword || '',
                score:               r.score,
                verdict:             r.verdict,
                issues:              r.issues              || [],
                watermark:           r.watermark           || '',
                face:                r.face                || '',
                context:             r.context             || '',
                cropFix:             r.cropFix             || '',
                fixStrategy:         r.fixStrategy         || '',
                zoomLevel:           r.zoomLevel           || null,
                replacementKeyword:  r.replacementKeyword  || '',
                replacementSource:   r.replacementSource   || '',
            })),
        };
    }

    // Confirm chip for an actionable order — resolves true (Apply) / false (Cancel).
    function _chatAddActionChip(summary) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.className = 'chat-sys chat-action-chip';
            wrap.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
            const label = document.createElement('span');
            label.textContent = `⚡ Apply this order?`;
            label.style.cssText = 'flex:1 1 auto';
            const apply = document.createElement('button');
            apply.textContent = 'Apply';
            const cancel = document.createElement('button');
            cancel.textContent = 'Cancel';
            for (const b of [apply, cancel]) b.style.cssText = 'padding:4px 12px;border-radius:6px;cursor:pointer;border:1px solid #4b5563';
            apply.style.background = '#2563eb'; apply.style.color = '#fff';
            const done = (v) => { apply.disabled = true; cancel.disabled = true; wrap.style.opacity = '0.55'; resolve(v); };
            apply.addEventListener('click', () => done(true));
            cancel.addEventListener('click', () => done(false));
            wrap.appendChild(label); wrap.appendChild(apply); wrap.appendChild(cancel);
            chatEls.messages.appendChild(wrap);
            chatEls.messages.scrollTop = chatEls.messages.scrollHeight;
        });
    }

    async function _chatSend() {
        const api = window.electronAPI || {};
        const canAct = typeof api.qaPreviewOrder === 'function';
        if (!window.electronAPI?.qaChatSend && !canAct) {
            _chatAddSys('Agent not available.');
            return;
        }
        const text = chatEls.input.value.trim();
        if (!text || chatState.sending) return;

        chatState.sending = true;
        chatEls.sendBtn.disabled = true;
        chatEls.input.value = '';
        chatEls.input.style.height = 'auto';

        chatState.history.push({ role: 'user', text });
        _chatAddMsg('user', text);
        _chatUpdateContextBar();

        // "undo" shortcut → revert the last applied order.
        if (canAct && typeof api.qaUndo === 'function' && /^undo\b/i.test(text)) {
            try {
                const u = await api.qaUndo();
                _chatAddSys(u && u.success ? '↩️ Reverted the last order — preview refreshed.' : `Undo: ${u && u.error || 'nothing to undo'}`);
            } catch (e) { _chatAddSys(`Undo failed: ${e.message}`); }
            chatState.sending = false; chatEls.sendBtn.disabled = false; chatEls.input.focus();
            return;
        }

        const typing = _chatAddTyping();
        try {
            // Acting-agent router: is this an actionable ORDER or a QUESTION?
            let prev = null;
            if (canAct) { try { prev = await api.qaPreviewOrder(text); } catch (_) { prev = null; } }
            typing.remove();

            if (prev && prev.ok && prev.hasActions) {
                _chatAddMsg('model', `I read that as an order: ${prev.summary}`);
                chatState.history.push({ role: 'model', text: `(order: ${prev.summary})` });
                const go = await _chatAddActionChip(prev.summary);
                if (go) {
                    const t2 = _chatAddTyping();
                    const stopProg = typeof api.onSceneActionProgress === 'function'
                        ? api.onSceneActionProgress(d => { if (d && d.message) _chatAddSys(d.message); }) : null;
                    let res = null;
                    try { res = await api.qaApplyOrder(text); } catch (e) { res = { success: false, error: e.message }; }
                    if (stopProg) stopProg();
                    t2.remove();
                    if (res && res.success) {
                        _chatAddMsg('model', `✅ Done — ${res.perSceneChanged || 0} per-scene · ${res.fixed || 0} enforced${res.footageRedownloaded ? ` · ${res.footageRedownloaded} footage re-download(s)` : ''}${res.flagged ? ` · ${res.flagged} flagged` : ''}. Preview refreshed. Type "undo" to revert.`);
                    } else {
                        _chatAddSys(`Order not applied: ${(res && res.error) || 'unknown error'}`);
                    }
                } else {
                    _chatAddSys('Cancelled — nothing changed.');
                }
            } else if (window.electronAPI?.qaChatSend) {
                // Not an order → normal Q&A.
                const t2 = _chatAddTyping();
                const projectContext = _buildProjectContext();
                const reply = await window.electronAPI.qaChatSend(chatState.history, projectContext);
                t2.remove();
                _chatAddMsg('model', reply);
                chatState.history.push({ role: 'model', text: reply });
            } else {
                _chatAddSys('That did not look like an order I can act on, and the Q&A agent is unavailable.');
            }
        } catch (err) {
            _chatAddSys(`Error: ${err.message}`);
            chatState.history.pop();
        } finally {
            chatState.sending = false;
            chatEls.sendBtn.disabled = false;
            chatEls.input.focus();
        }
    }

    // Auto-open chat if launched via Agent Chat button (?chat=1)
    if (new URLSearchParams(window.location.search).has('chat')) {
        setTimeout(() => _chatOpen(), 300);
    }

    // Toggle chat open/close
    chatEls.toggleBtn?.addEventListener('click', () => {
        if (chatState.open) _chatClose(); else _chatOpen();
    });
    chatEls.closeBtn?.addEventListener('click', _chatClose);

    // Send
    chatEls.sendBtn?.addEventListener('click', _chatSend);
    chatEls.input?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _chatSend(); }
    });
    chatEls.input?.addEventListener('input', () => {
        chatEls.input.style.height = 'auto';
        chatEls.input.style.height = Math.min(chatEls.input.scrollHeight, 80) + 'px';
    });

    // ── START ──────────────────────────────────────────────────────────────
    init();

})();
