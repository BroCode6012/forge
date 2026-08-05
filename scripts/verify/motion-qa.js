#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    applyDiagnosticRepairs,
    applyManifestTimingRepairs,
    applyVisionRepairs,
    ensureRenderSafeProject,
    listSnapshotFrameNames,
    prepareMotionPlan,
    resolveMotionQaNodeRuntime,
} = require('../../src/agents/workers/motion-qa-agent');
const {
    buildBrief,
    visualDurationSeconds,
} = require('../../src/agents/workers/composition-author');

const originalFlag = process.env.HF_MOTION_QA;
delete process.env.HF_MOTION_QA;

try {
    const plan = {
        fps: 30,
        totalDuration: 10,
        scenes: [
            { index: 0, startTime: 0, endTime: 5 },
            { index: 1, startTime: 5, endTime: 10 },
        ],
        motionGraphics: [
            {
                type: 'lowerThird',
                text: 'A readable lower third with several important words',
                startTime: 0.5,
                endTime: 1.1,
                duration: 0.6,
                position: 'bottom-left',
                agenticComposition: { motion: { speed: 0.2, stagger: 0.2 } },
            },
            {
                type: 'callout',
                text: 'The next overlay',
                startTime: 3.2,
                endTime: 4.8,
                duration: 1.6,
                position: 'bottom-left',
            },
        ],
        mgScenes: [],
        templateScenes: [],
    };

    const preflight = prepareMotionPlan(plan);
    assert.ok(preflight.repairs.length > 0, 'short/slow motion should be repaired');
    assert.ok(plan.motionGraphics[0].endTime > 1.1, 'readable hold should extend when the scene has room');
    assert.ok(plan.motionGraphics[0].endTime <= plan.motionGraphics[1].startTime - 0.079, 'repair must not collide with the next same-zone overlay');
    assert.ok(plan.motionGraphics[0].animationSpeed >= 0.65, 'unsafe slow motion speed should be clamped');
    assert.strictEqual(plan.motionGraphics[0].durationUnit, 'seconds');
    assert.strictEqual(plan.motionGraphics[0].durationFrames, Math.round(plan.motionGraphics[0].duration * 30));

    const manualPlan = {
        fps: 30,
        totalDuration: 5,
        scenes: [{ index: 0, startTime: 0, endTime: 5 }],
        motionGraphics: [{
            type: 'callout',
            text: 'Manual timing',
            startTime: 1,
            endTime: 1.4,
            duration: 0.4,
            timingManual: true,
            animationManual: true,
            animationSpeed: 0.3,
        }],
        mgScenes: [],
        templateScenes: [],
    };
    const manualBefore = JSON.stringify(manualPlan.motionGraphics[0]);
    const manualResult = prepareMotionPlan(manualPlan);
    assert.strictEqual(JSON.stringify(manualPlan.motionGraphics[0]), manualBefore, 'manual motion/timing must be preserved');
    assert.ok(manualResult.findings.some((finding) => finding.code === 'visual_window_too_short'), 'unsafe manual timing should be reported');

    const partialRangePlan = {
        fps: 30,
        totalDuration: 14,
        scenes: [{ index: 0, startTime: 0, endTime: 14 }],
        motionGraphics: [],
        mgScenes: [],
        templateScenes: [{
            type: 'statCard',
            text: '$300 System',
            startTime: 0,
            endTime: 0.113333,
            duration: 0.113333,
            animationSpeed: 0.3,
            _renderRangeClip: {
                sourceStartTime: 13.72,
                sourceEndTime: 23.18,
                sourceDuration: 9.46,
                sourceOffset: 9.346667,
                visibleDuration: 0.113333,
                clippedAtStart: true,
                clippedAtEnd: false,
            },
        }],
    };
    const partialBefore = JSON.stringify(partialRangePlan.templateScenes[0]);
    const partialResult = prepareMotionPlan(partialRangePlan);
    assert.notStrictEqual(partialResult.status, 'fail', 'an intentional In-marker visual fragment must not fail Motion QA');
    assert.strictEqual(
        JSON.stringify(partialRangePlan.templateScenes[0]),
        partialBefore,
        'Motion QA must not stretch or retime an intentional range fragment'
    );
    assert.ok(
        !partialResult.findings.some((finding) => finding.code === 'visual_window_too_short'),
        'range fragments must not be treated as newly-authored tiny graphics'
    );

    const strictTinyPlan = JSON.parse(JSON.stringify(partialRangePlan));
    delete strictTinyPlan.templateScenes[0]._renderRangeClip;
    strictTinyPlan.templateScenes[0].timingManual = true;
    strictTinyPlan.templateScenes[0].animationManual = true;
    const strictTinyResult = prepareMotionPlan(strictTinyPlan);
    assert.ok(
        strictTinyResult.findings.some((finding) => finding.code === 'visual_window_too_short'),
        'full-render Motion QA must remain strict for genuinely tiny graphics'
    );

    const semanticPlan = {
        fps: 30,
        totalDuration: 9,
        scenes: [
            { index: 0, originalIndex: 0, startTime: 0, endTime: 1.5 },
            { index: 1, originalIndex: 1, startTime: 5, endTime: 9 },
        ],
        motionGraphics: [{
            type: 'lowerThird',
            text: '$1,250 Project Cost',
            startTime: 4.9,
            endTime: 7.2,
            duration: 2.3,
            position: 'bottom-left',
        }],
        mgScenes: [],
        templateScenes: [{
            type: 'statCard',
            text: '$1,250 Project Cost',
            items: [{ value: '$1,250', label: 'Project Cost' }],
            startTime: 1.5,
            endTime: 5,
            duration: 3.5,
            _authoredComposition: {
                html: '<div><strong>$1,250</strong><footer>$1,250 Project Cost</footer></div>',
                css: '',
                timeline: 'tl.to("#x", {opacity:1})',
            },
        }],
    };
    const semanticResult = prepareMotionPlan(semanticPlan);
    assert.strictEqual(semanticPlan.motionGraphics[0].disabled, true, 'adjacent stage/overlay treatments of the same fact should collapse to one');
    assert.strictEqual(semanticPlan.templateScenes[0]._authoredComposition, undefined, 'an authored stat that repeats its hero fact should fall back to the deterministic renderer');
    assert.ok(semanticResult.repairs.some(repair => repair.code === 'semantic_duplicate_suppressed'), 'semantic duplicate repair must be reported');
    assert.ok(semanticResult.repairs.some(repair => repair.code === 'authored_semantic_duplicate_fallback'), 'authored internal duplicate repair must be reported');

    const ownerlessStagePlan = {
        fps: 30,
        totalDuration: 8,
        scenes: [
            { index: 0, startTime: 0, endTime: 2 },
            { index: 1, startTime: 4, endTime: 8 },
        ],
        motionGraphics: [],
        mgScenes: [],
        templateScenes: [{
            type: 'chapterCard',
            text: 'A deliberately dense ownerless stage visual',
            startTime: 2,
            endTime: 2.5,
            duration: 0.5,
        }],
    };
    prepareMotionPlan(ownerlessStagePlan);
    assert.strictEqual(ownerlessStagePlan.templateScenes[0].endTime, 2.5, 'ownerless stage QA must not extend across a carved timeline gap');

    const timingPlan = {
        fps: 30,
        totalDuration: 6,
        scenes: [{ index: 0, startTime: 0, endTime: 6 }],
        motionGraphics: [{ type: 'headline', startTime: 1, endTime: 5, duration: 4 }],
        mgScenes: [],
        templateScenes: [],
    };
    const timingRepairs = applyManifestTimingRepairs(timingPlan, {
        graphics: [{
            id: 'mg-0-headline',
            sourceGroup: 'motionGraphics',
            sourceIndex: 0,
            start: 1,
            duration: 2.25,
            timingClamped: true,
        }],
    });
    assert.strictEqual(timingRepairs.length, 1);
    assert.strictEqual(timingPlan.motionGraphics[0].endTime, 3.25);
    assert.strictEqual(timingPlan.motionGraphics[0].durationFrames, 68);

    const authoredPlan = {
        fps: 30,
        totalDuration: 5,
        scenes: [{ index: 0, startTime: 0, endTime: 5 }],
        motionGraphics: [],
        mgScenes: [{
            type: 'statCard',
            startTime: 0,
            endTime: 4,
            _authoredComposition: { html: '<div></div>', css: '', timeline: 'tl.to("#x", {opacity:1})' },
            _authoredAssets: [{ token: '__HF_ASSET_0__' }],
        }],
        templateScenes: [],
    };
    const diagnosticRepairs = applyDiagnosticRepairs(
        authoredPlan,
        {
            graphics: [{
                id: 'mg-0-stat-card',
                sourceGroup: 'mgScenes',
                sourceIndex: 0,
                authored: true,
            }],
        },
        [{
            code: 'element_outside_frame',
            selector: '#mg-0-stat-card',
            message: 'Element is outside the composition frame',
        }]
    );
    assert.strictEqual(diagnosticRepairs.length, 1);
    assert.strictEqual(authoredPlan.mgScenes[0]._authoredComposition, undefined, 'broken authored motion should safely fall back');
    assert.strictEqual(authoredPlan.mgScenes[0]._authoredAssets, undefined);
    assert.strictEqual(authoredPlan.mgScenes[0].motionQaSafeLayout, true, 'broken authored motion should enter the universal safe layout');
    assert.strictEqual(diagnosticRepairs[0].code, 'safe_layout_fallback');

    const fixedRendererPlan = {
        fps: 30,
        totalDuration: 5,
        scenes: [{ index: 0, startTime: 0, endTime: 5 }],
        motionGraphics: [],
        mgScenes: [{
            type: 'comparisonCard',
            text: 'Surface Air Temperature vs Underground Soil Temperature',
            startTime: 0,
            endTime: 4,
        }],
        templateScenes: [],
    };
    const visionFallbacks = applyVisionRepairs(
        fixedRendererPlan,
        {
            graphics: [{
                id: 'mg-0-comparison-card',
                sourceGroup: 'mgScenes',
                sourceIndex: 0,
                authored: false,
            }],
        },
        {
            repairs: [{
                id: 'mg-0-comparison-card',
                action: 'fallback-safe-layout',
                reason: 'Comparison columns overflow their shell',
            }],
        }
    );
    assert.strictEqual(visionFallbacks.length, 1, 'vision must repair a non-authored broken composition');
    assert.strictEqual(fixedRendererPlan.mgScenes[0].motionQaSafeLayout, true);
    assert.strictEqual(fixedRendererPlan.mgScenes[0].authoredCompositionMode, 'fixed-renderer');
    assert.strictEqual(fixedRendererPlan.mgScenes[0].agenticComposition.density, 'compact');

    const repeatedVisionPlan = {
        fps: 30,
        totalDuration: 5,
        scenes: [{ index: 0, startTime: 0, endTime: 5 }],
        motionGraphics: [],
        mgScenes: [{
            type: 'comparisonCard',
            text: 'Earth Tube vs Standard AC',
            startTime: 1,
            endTime: 4,
            agenticComposition: {
                motion: { speed: 1.2 },
            },
        }],
        templateScenes: [],
    };
    const repeatedVisionManifest = {
        graphics: [{
            id: 'mg-0-comparison-card',
            sourceGroup: 'mgScenes',
            sourceIndex: 0,
            authored: true,
        }],
    };
    const repeatedProposal = {
        repairs: [{
            id: 'mg-0-comparison-card',
            action: 'slow-down',
            reason: 'Hero text is still settling',
        }],
    };
    const firstVisionPass = applyVisionRepairs(
        repeatedVisionPlan,
        repeatedVisionManifest,
        repeatedProposal
    );
    assert.strictEqual(firstVisionPass[0].code, 'vision_motion_slowed_down');
    const secondVisionPass = applyVisionRepairs(
        repeatedVisionPlan,
        repeatedVisionManifest,
        repeatedProposal
    );
    assert.strictEqual(secondVisionPass[0].code, 'vision_repeated_defect_safe_fallback');
    assert.strictEqual(repeatedVisionPlan.mgScenes[0].motionQaSafeLayout, true);
    assert.strictEqual(repeatedVisionPlan.mgScenes[0].authoredCompositionMode, 'fixed-renderer');

    const contrastPlan = {
        fps: 30,
        totalDuration: 5,
        scenes: [{ index: 0, startTime: 0, endTime: 5 }],
        motionGraphics: [{
            id: 'contrast-lower-third',
            type: 'lowerThird',
            text: 'Low contrast copy',
            startTime: 0.5,
            endTime: 3,
        }],
        mgScenes: [],
        templateScenes: [],
    };
    const contrastRepairs = applyDiagnosticRepairs(
        contrastPlan,
        {
            graphics: [{
                id: 'mg-0-lower-third',
                sourceClipId: 'contrast-lower-third',
                sourceGroup: 'motionGraphics',
                sourceIndex: 0,
                authored: false,
            }],
        },
        [{
            code: 'insufficient_contrast',
            section: 'contrast',
            elementId: 'contrast-lower-third',
            message: 'Text contrast is below the required ratio',
        }]
    );
    assert.strictEqual(contrastRepairs.length, 1, 'contrast diagnostics must create one bounded readability repair');
    assert.strictEqual(contrastPlan.motionGraphics[0].adaptiveContrast, true);
    assert.strictEqual(contrastPlan.motionGraphics[0].contrastProtection, 'strong');
    assert.strictEqual(contrastRepairs[0].code, 'contrast_protection_forced');

    const durationOnlyGraphic = {
        type: 'statCounter',
        text: '200 years',
        startTime: 24.46,
        duration: 2.7,
    };
    assert.strictEqual(
        visualDurationSeconds(durationOnlyGraphic),
        2.7,
        'authored graphics without endTime must use their explicit duration'
    );
    assert.strictEqual(
        buildBrief({ scenes: [], scriptContext: {} }, durationOnlyGraphic, 0, 'overlay').duration,
        2.7,
        'Composition Author must receive the same duration the renderer uses'
    );
    assert.strictEqual(
        visualDurationSeconds(partialRangePlan.templateScenes[0]),
        9.46,
        'Composition Author must validate a partial fragment against the original visual duration'
    );

    const renderSafeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-motion-qa-render-safe-'));
    try {
        const indexPath = path.join(renderSafeDir, 'index.html');
        fs.writeFileSync(indexPath, [
            '<script>',
            'window.__timelines = {};',
            '/*HF_PREVIEW_START*/',
            'const liveClock = performance.now();',
            '/*HF_PREVIEW_END*/',
            '</script>',
        ].join('\n'));
        const safety = ensureRenderSafeProject({ projectDir: renderSafeDir, indexPath });
        const cleaned = fs.readFileSync(indexPath, 'utf8');
        assert.strictEqual(safety.previewRuntimeRemoved, true);
        assert.strictEqual(safety.nondeterministicClockRemaining, false);
        assert.ok(cleaned.includes('window.__timelines = {};'), 'render-safe cleanup removed the actual composition');
        assert.ok(!cleaned.includes('performance.now()'), 'render-safe cleanup left the preview clock in the composition');
    } finally {
        const resolved = path.resolve(renderSafeDir);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-motion-qa-render-safe-')) {
            throw new Error(`Refusing to clean unsafe render-safe test directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }

    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-motion-qa-frames-'));
    try {
        for (const name of ['frame-00.png', 'frame-01.jpg', 'contact-sheet.jpg', 'preview.png']) {
            fs.writeFileSync(path.join(snapshotDir, name), '');
        }
        assert.deepStrictEqual(
            listSnapshotFrameNames(snapshotDir),
            ['frame-00.png', 'frame-01.jpg'],
            'proof-frame discovery must never treat the contact sheet or preview image as a timeline frame'
        );
    } finally {
        const resolved = path.resolve(snapshotDir);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-motion-qa-frames-')) {
            throw new Error(`Refusing to clean unsafe Motion QA test directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }

    const mainSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'main.js'), 'utf8');
    const appSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ui', 'js', 'app.js'), 'utf8');
    const explicitNodeRuntime = resolveMotionQaNodeRuntime(process.execPath);
    assert.strictEqual(explicitNodeRuntime.command, process.execPath, 'Motion QA must honor the validated Node executable');
    assert.ok(mainSource.includes("stage: 'preview-preflight'"), 'HyperFrames preview must run Motion QA before generating');
    assert.ok(mainSource.includes("source: 'motion-qa-preview'"), 'preview Motion QA repairs must be pushed back into the editor');
    assert.ok(mainSource.includes("payload?.options?.persistMotionQa !== false"), 'preview Motion QA persistence must support read-only Agent refreshes');
    assert.ok(appSource.includes('_applyStructuralPlanRepairs(plan)'), 'editor must structurally apply preview Motion QA repairs');
    assert.ok(appSource.includes('persistMotionQa: false'), 'Agent plan refreshes must not create hidden Motion QA revisions');
    assert.ok(appSource.includes('pendingRefreshOptions'), 'queued HyperFrames refreshes must preserve the Agent read-only QA policy');
    assert.ok(appSource.includes('projectHydrating: false'), 'renderer must track project hydration');
    assert.ok(appSource.includes('if (state.projectHydrating) return;'), 'autosave must be suppressed while the authoritative project is hydrating');
    assert.ok(appSource.includes('if (result.planHash) state.projectPlanHash = result.planHash;'), 'preview response must synchronize authoritative project metadata');
    assert.ok(appSource.includes('Discarded a stale autosave after an authoritative QA update'), 'superseded QA autosaves must be discarded safely');
    assert.ok(
        appSource.includes('suspendHyperframesPreviewForRender'),
        'the live HyperFrames preview must release browser/GPU resources during render preflight'
    );
    assert.ok(
        mainSource.includes("const _v2InProcessGpuEnabled = /^(1|true|on)$/i.test"),
        'the crash-prone in-process GPU mode must remain explicit opt-in'
    );
    const motionQaSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'agents', 'workers', 'motion-qa-agent.js'), 'utf8');
    assert.ok(
        motionQaSource.includes("flagOff('HF_MOTION_QA_CONTRAST')"),
        'HyperFrames contrast diagnostics must be enabled by default with an explicit emergency opt-out'
    );
    assert.ok(
        motionQaSource.includes('PRODUCER_BROWSER_GPU_MODE: diagnosticBrowserGpuMode'),
        'Motion QA browser diagnostics must set an explicit, switchable browser GPU profile'
    );
    assert.ok(
        motionQaSource.includes("flagOff('HF_MOTION_QA_BROWSER_GPU') ? 'software' : 'hardware'"),
        'Motion QA diagnostics must run on the real GPU by default with an explicit emergency opt-out'
    );
    assert.ok(
        motionQaSource.includes('async function auditGraphicLayout'),
        'Motion QA must measure rendered graphic overflow/clipping in the browser'
    );
    assert.ok(
        motionQaSource.includes("const fractions = duration < 0.8 ? [0.5] : [0.2, 0.52, 0.82]"),
        'Motion QA must inspect entrance, hero, and late phases instead of one midpoint'
    );
    assert.ok(
        motionQaSource.includes("'layout_stage_collapsed'"),
        'Motion QA must reject collapsed full-frame agentic/template stages'
    );
    assert.ok(
        motionQaSource.includes("'layout_safe_zone_mismatch'"),
        'Motion QA must verify that rendered copy respects its declared safe zone'
    );
    assert.ok(
        motionQaSource.includes("'layout_readable_text_outside_frame'"),
        'Motion QA must inspect all readable text, not only legacy fixed-renderer classes'
    );
    assert.ok(
        motionQaSource.includes("numeric(process.env.HF_MOTION_QA_PASSES, 3)"),
        'Motion QA must reserve a final verification pass after automatic repairs'
    );
    assert.ok(
        motionQaSource.includes('runVision: !quick && pass < passLimit'),
        'the final Motion QA pass must be deterministic verification, not a new unrepairable vision verdict'
    );
    assert.ok(
        motionQaSource.includes('extending verification to pass'),
        'Motion QA must extend verification when a deterministic defect is first revealed on the planned final pass'
    );

    console.log('✅ agentic Motion QA contract checks passed');
} finally {
    if (originalFlag === undefined) delete process.env.HF_MOTION_QA;
    else process.env.HF_MOTION_QA = originalFlag;
}
