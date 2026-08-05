'use strict';

const fs = require('fs');
const path = require('path');

const projectStore = require('../project/project-store');
const timelineContract = require('../project/timeline-contract');
const {
    clearAuthoredComposition,
} = require('../render/authored-composition-policy');

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function visualCollections(plan) {
    return [
        ...(Array.isArray(plan?.motionGraphics) ? plan.motionGraphics : []),
        ...(Array.isArray(plan?.mgScenes) ? plan.mgScenes : []),
        ...(Array.isArray(plan?.templateScenes) ? plan.templateScenes : []),
    ];
}

function clearQaSafeLayout(target) {
    if (!target || typeof target !== 'object') return;
    const wasQaFallback = target.motionQaSafeLayout === true
        || target._motionQaSafeLayout === true
        || /^motion-qa/i.test(String(target.authoredCompositionReason || ''));
    delete target.motionQaSafeLayout;
    delete target._motionQaSafeLayout;
    delete target.motionQaSafeLayoutReason;
    delete target._motionQaSafeLayoutReason;
    if (wasQaFallback) {
        if (target.authoredCompositionMode === 'fixed-renderer') delete target.authoredCompositionMode;
        if (/^motion-qa/i.test(String(target.authoredCompositionReason || ''))) {
            delete target.authoredCompositionReason;
        }
    }
}

function resetGraphicForRebuild(graphic) {
    if (!graphic || typeof graphic !== 'object') return;
    clearAuthoredComposition(graphic);
    for (const target of [graphic, graphic.mgData]) {
        if (!target || typeof target !== 'object') continue;
        clearQaSafeLayout(target);
        delete target._motionQaVisionAttempts;
        for (const field of [
            '_hfTiming',
            '_hfVisual',
            '_hfResolvedGraphicShell',
            '_hfGraphicShellApplied',
            '_hfAuthoredTimeline',
            '_hfAuthoredOffset',
            '_authoredRendered',
        ]) {
            delete target[field];
        }
    }
}

function logger(log) {
    const call = (method, message) => {
        if (log && typeof log[method] === 'function') log[method](message);
        else if (typeof log === 'function') log(message);
        else console.log(message);
    };
    return {
        step: (message) => call('step', message),
        info: (message) => call('info', message),
        ok: (message) => call('ok', message),
        warn: (message) => call('warn', message),
    };
}

async function rebuildMotionGraphicsOnly({
    projectDir,
    appRoot = path.resolve(__dirname, '..', '..'),
    log = console,
    verify = true,
    browserPath,
    dependencies = {},
} = {}) {
    if (!projectDir) throw new Error('Motion-graphics rebuild requires a project directory');
    const root = path.resolve(projectDir);
    const publicDir = path.join(root, 'public');
    const tempDir = path.join(root, 'temp');
    const inputDir = path.join(root, 'input');
    const out = logger(log);

    const loaded = projectStore.reconcileProjectState({
        projectDir: root,
        publicDir,
        tempDir,
    });
    if (!loaded?.videoPlan) {
        throw new Error('No existing video plan was found. Run a normal build first.');
    }

    const originalPlan = cloneJson(loaded.videoPlan);
    const workingPlan = cloneJson(loaded.videoPlan);
    const graphics = visualCollections(workingPlan);
    if (!graphics.length) {
        throw new Error('The saved build has no motion graphics or templates to rebuild.');
    }

    fs.mkdirSync(tempDir, { recursive: true });
    projectStore.atomicWriteJson(
        path.join(tempDir, 'video-plan.before-motion-graphics-rebuild.json'),
        originalPlan
    );

    out.step('Step MG-R1: Resetting generated graphic compositions');
    graphics.forEach(resetGraphicForRebuild);
    delete workingPlan.motionQa;
    out.ok(`Prepared ${graphics.length} existing graphic(s); scenes and media remain untouched`);

    const applyMotionDirector = dependencies.applyMotionDirector
        || require('../render/hyperframes-motion-director').applyHyperframesMotionDirector;
    out.step('Step MG-R2: Rebuilding HyperFrames motion compositions');
    try {
        const directed = await applyMotionDirector({
            motionGraphics: workingPlan.motionGraphics || [],
            mgScenes: workingPlan.mgScenes || [],
            templateScenes: workingPlan.templateScenes || [],
            scenes: workingPlan.scenes || [],
            scriptContext: workingPlan.scriptContext || {},
            style: {
                mgStyle: workingPlan.mgStyle || 'clean',
                mapStyle: workingPlan.mapStyle || 'dark',
                themeId: workingPlan.scriptContext?.themeId || workingPlan.themeId || 'standard',
            },
            log,
        });
        workingPlan.motionGraphics = directed?.motionGraphics || workingPlan.motionGraphics || [];
        workingPlan.mgScenes = directed?.mgScenes || workingPlan.mgScenes || [];
        workingPlan.templateScenes = directed?.templateScenes || workingPlan.templateScenes || [];
        out.ok('Motion Director refreshed the existing graphic composition contracts');
    } catch (error) {
        out.warn(`Motion Director refresh failed (${error.message}); deterministic composition rules will be used`);
    }

    const authorPlanCompositions = dependencies.authorPlanCompositions
        || require('../agents/workers/composition-author').authorPlanCompositions;
    out.step('Step MG-R3: Rebuilding authored graphic layouts');
    const authorResult = await authorPlanCompositions(workingPlan, {
        projectDir: root,
        graphicsOnly: true,
        openMode: false,
        log: (message) => out.info(message),
    });
    out.ok(`Composition Author prepared ${authorResult?.authored || 0}/${authorResult?.eligible || 0} eligible graphic(s)`);

    let qaResult = null;
    if (verify) {
        const { generateHyperframesProject } = dependencies.generateHyperframesProject
            ? { generateHyperframesProject: dependencies.generateHyperframesProject }
            : require('../render/hyperframes-bridge');
        const {
            resolveMotionQaNodeRuntime,
            runMotionQa,
        } = dependencies.motionQa || require('../agents/workers/motion-qa-agent');
        const nodeRuntime = resolveMotionQaNodeRuntime();

        out.step('Step MG-R4: Rendering proof frames and verifying graphic geometry');
        qaResult = await runMotionQa({
            plan: workingPlan,
            appRoot,
            reportDir: publicDir,
            browserPath,
            nodePath: nodeRuntime.command,
            quick: false,
            log: (message) => out.info(message),
            generateProject: async () => generateHyperframesProject({
                plan: workingPlan,
                projectDir: root,
                appRoot,
                tempDir,
                publicDir,
                inputDir,
                outputRoot: path.join(root, 'hyperframes'),
                options: {
                    graphicsOnlyQa: true,
                },
            }),
        });
        if (qaResult.hardFail) {
            const first = (qaResult.report?.findings || []).find((finding) => finding.severity === 'error');
            throw new Error(`Motion-graphics QA blocked the rebuild${first?.message ? `: ${first.message}` : ''}`);
        }
        out.ok(`Motion QA ${String(qaResult.report?.status || 'pass').toUpperCase()}: ${qaResult.report?.repairCount || 0} automatic repair(s)`);
    } else {
        const { prepareMotionPlan } = dependencies.prepareMotionPlan
            ? { prepareMotionPlan: dependencies.prepareMotionPlan }
            : require('../agents/workers/motion-qa-agent');
        const preflight = prepareMotionPlan(workingPlan, {
            log: (message) => out.info(message),
        });
        workingPlan.motionQa = {
            version: preflight.version || 3,
            status: preflight.status,
            stage: 'graphics-only-preflight',
            checkedVisuals: preflight.checked || 0,
            repairCount: (preflight.repairs || []).length,
            findingCount: (preflight.findings || []).length,
        };
    }

    // Publish only the graphic arrays and QA metadata. Every upstream artifact
    // (scene planning, footage, audio, transitions, SFX, captions and settings)
    // comes from the exact saved plan that entered this operation.
    let finalPlan = originalPlan;
    finalPlan.motionGraphics = workingPlan.motionGraphics || [];
    finalPlan.mgScenes = workingPlan.mgScenes || [];
    finalPlan.templateScenes = workingPlan.templateScenes || [];
    visualCollections(finalPlan).forEach((graphic) => {
        delete graphic._motionQaVisionAttempts;
        if (graphic.mgData && typeof graphic.mgData === 'object') {
            delete graphic.mgData._motionQaVisionAttempts;
        }
    });
    finalPlan.motionQa = workingPlan.motionQa || qaResult?.report || null;
    finalPlan.motionGraphicsRebuild = {
        version: 1,
        completedAt: new Date().toISOString(),
        sourcePlanHash: loaded.planHash || null,
        preservedPlanning: true,
        preservedMedia: true,
        graphicCount: visualCollections(finalPlan).length,
        qaStatus: qaResult?.report?.status || finalPlan.motionQa?.status || 'preflight',
        qaRepairCount: qaResult?.report?.repairCount || finalPlan.motionQa?.repairCount || 0,
    };
    finalPlan = timelineContract.withContinuityHolds(finalPlan);

    const saved = projectStore.saveProjectState({
        projectDir: root,
        publicDir,
        tempDir,
        preferredFvpPath: loaded.fvpPath,
        settings: loaded.settings || {},
        videoPlan: finalPlan,
        revision: loaded.revision || 0,
        expectedRevision: loaded.revision || 0,
    });
    out.ok(`Published graphics-only rebuild without re-running planning or media (revision ${saved.revision})`);

    return {
        success: true,
        plan: finalPlan,
        saved,
        qa: qaResult?.report || finalPlan.motionQa || null,
        graphicCount: visualCollections(finalPlan).length,
    };
}

module.exports = {
    clearQaSafeLayout,
    rebuildMotionGraphicsOnly,
    resetGraphicForRebuild,
    visualCollections,
};
