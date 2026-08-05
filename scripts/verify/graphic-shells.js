#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const {
    GRAPHIC_SHELL_VALUES,
    contextualGraphicShell,
    getGraphicShellCapabilities,
    normalizeGraphicShell,
    parseGraphicShellInstruction,
} = require(path.join(ROOT, 'src', 'render', 'graphic-shells'));
const {
    buildMotionDirectorPrompt,
    normalizeMotionDirectorSpec,
} = require(path.join(ROOT, 'src', 'render', 'hyperframes-motion-director'));
const graphicsCapability = require(path.join(
    ROOT,
    'src',
    'agents',
    'editor-supervisor',
    'capabilities',
    'graphics'
));
const {
    editScopedGraphicProperties,
} = require(path.join(
    ROOT,
    'src',
    'agents',
    'editor-supervisor',
    'workers',
    'graphics-editor'
));
const {
    generateHyperframesProject,
} = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));

function findBrowser() {
    const candidates = [
        process.env.HYPERFRAMES_BROWSER_PATH,
        process.env.PRODUCER_HEADLESS_SHELL_PATH,
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function writeSolidPng(filePath, color) {
    const image = new PNG({ width: 320, height: 180 });
    for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = color[0];
        image.data[offset + 1] = color[1];
        image.data[offset + 2] = color[2];
        image.data[offset + 3] = 255;
    }
    fs.writeFileSync(filePath, PNG.sync.write(image));
}

function structuralSnapshot(shell) {
    return Object.fromEntries(
        Object.keys(GRAPHIC_SHELL_VALUES).map((dimension) => [dimension, shell[dimension]])
    );
}

async function inspectShell(page, id, time) {
    return page.evaluate(({ id: graphicId, time: requestedTime }) => {
        window.__HF_PREVIEW__.seek(requestedTime);
        if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();
        const root = document.getElementById(graphicId);
        const target = root?.querySelector('.hf-shell-target');
        if (!root || !target) return null;
        const style = getComputedStyle(target);
        const before = getComputedStyle(target, '::before');
        const after = getComputedStyle(target, '::after');
        const rect = target.getBoundingClientRect();
        return {
            rootClass: root.className,
            surface: root.dataset.hfShellSurface,
            accent: root.dataset.hfShellAccent,
            geometry: root.dataset.hfShellGeometry,
            hierarchy: root.dataset.hfShellHierarchy,
            width: root.dataset.hfShellWidth,
            emphasis: root.dataset.hfShellEmphasis,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            borderLeftWidth: parseFloat(style.borderLeftWidth) || 0,
            borderBottomWidth: parseFloat(style.borderBottomWidth) || 0,
            borderTopWidth: parseFloat(style.borderTopWidth) || 0,
            borderRadius: style.borderRadius,
            clipPath: style.clipPath,
            beforeContent: before.content,
            beforeWidth: parseFloat(before.width) || 0,
            afterContent: after.content,
            afterWidth: parseFloat(after.width) || 0,
            afterHeight: parseFloat(after.height) || 0,
            rect: {
                width: rect.width,
                height: rect.height,
            },
        };
    }, { id, time });
}

async function main() {
    // The fallback chooser is content/context driven. Graphic type itself must
    // not secretly map to a structural preset.
    const sharedContext = {
        id: 'same-context',
        text: 'Maya Chen',
        subtext: 'Chief Engineer',
        safeZone: 'bottom-left',
        layout: 'lower-third',
        mood: 'clean editorial identity',
    };
    const lowerThirdShell = contextualGraphicShell({
        ...sharedContext,
        type: 'lowerThird',
    });
    const headlineShell = contextualGraphicShell({
        ...sharedContext,
        type: 'headline',
    });
    assert.deepStrictEqual(
        structuralSnapshot(lowerThirdShell),
        structuralSnapshot(headlineShell),
        'automatic shell selection must not be hard-coded by graphic type'
    );

    const denseShell = contextualGraphicShell({
        id: 'dense-context',
        text: 'This longer explanation contains enough information that readability needs a calm protected surface across the frame',
        subtext: 'Supporting context with another detailed line',
        items: ['one', 'two', 'three', 'four'],
        safeZone: 'center',
        layout: 'evidence-board',
        mood: 'calm documentary',
    });
    assert.notDeepStrictEqual(
        structuralSnapshot(denseShell),
        structuralSnapshot(lowerThirdShell),
        'materially different content context should produce a different structure'
    );
    assert.strictEqual(denseShell.width, 'wide');

    const arbitraryCombination = normalizeGraphicShell({
        surface: 'outline',
        accent: 'bracket',
        geometry: 'rounded',
        hierarchy: 'stacked',
        width: 'compact',
        emphasis: 'strong',
    }, {
        id: 'custom-combination',
        text: 'A combination that is not a named recipe',
        subtext: 'Live capability composition',
        manual: true,
    });
    assert.deepStrictEqual(structuralSnapshot(arbitraryCombination), {
        surface: 'outline',
        accent: 'bracket',
        geometry: 'rounded',
        hierarchy: 'stacked',
        width: 'compact',
        emphasis: 'strong',
    });
    assert.strictEqual(arbitraryCombination.preset, 'custom');

    const preservedIntent = normalizeGraphicShell({
        surface: 'solid',
        accent: 'rail',
        geometry: 'rounded',
        hierarchy: 'stacked',
        width: 'compact',
        emphasis: 'strong',
    }, {
        text: 'Explicit edit state wins',
        transparentBackground: true,
        accentRuleVisible: false,
    });
    assert.strictEqual(preservedIntent.surface, 'none');
    assert.strictEqual(preservedIntent.accent, 'none');

    const parsed = parseGraphicShellInstruction(
        'make this a compact open structure with a vertical accent and rounded corners'
    );
    assert.ok(parsed, 'fast parser did not understand a compositional structure request');
    assert.strictEqual(parsed.surface, 'none');
    assert.strictEqual(parsed.accent, 'rail');
    assert.strictEqual(parsed.geometry, 'rounded');
    assert.strictEqual(parsed.width, 'compact');
    assert.strictEqual(parsed.hierarchy, undefined);
    assert.strictEqual(parsed.emphasis, undefined);

    const compoundRemoval = parseGraphicShellInstruction(
        'remove the decorative accent bar and make it without a background'
    );
    assert.strictEqual(compoundRemoval.surface, 'none');
    assert.strictEqual(compoundRemoval.accent, 'none');

    const capabilities = getGraphicShellCapabilities(sharedContext);
    assert.strictEqual(capabilities.structuralOnly, true);
    assert.strictEqual(capabilities.colorsOwnedByTheme, true);
    assert.deepStrictEqual(capabilities.dimensions, GRAPHIC_SHELL_VALUES);
    assert.ok(capabilities.recommended.length >= 2);

    const manifest = graphicsCapability.manifest();
    assert.deepStrictEqual(
        manifest.vocabulary.graphicShells.dimensions,
        GRAPHIC_SHELL_VALUES,
        'Editor Agent did not expose the live shell dimensions'
    );
    const propertyTool = graphicsCapability.tools().find((tool) => tool.action === 'edit-properties');
    assert.ok(
        propertyTool?.args?.properties?.graphicShell,
        'Editor Agent edit-properties schema is missing graphicShell'
    );
    const selectedScope = {
        kind: 'visual',
        label: 'Selected lower third',
        visualRefs: [{
            id: 'agent-shell-target',
            type: 'lowerThird',
            startTime: 0.5,
            endTime: 2.5,
        }],
    };
    const fastRequestText = 'make this a compact open structure with a vertical accent and rounded corners';
    const fastPlan = graphicsCapability.planFast({
        text: fastRequestText,
        directives: {},
        request: {
            text: fastRequestText,
            originalText: fastRequestText,
            scope: selectedScope,
        },
    });
    assert.deepStrictEqual(
        fastPlan.operations[0].args.graphicShell,
        {
            surface: 'none',
            accent: 'rail',
            geometry: 'rounded',
            width: 'compact',
        },
        'fast Agent routing changed dimensions the user did not request'
    );
    const smartOperation = graphicsCapability.normalizeInvocation({
        action: 'edit-properties',
        args: {
            targetType: 'lowerThird',
            targetIds: ['agent-shell-target'],
            graphicShell: arbitraryCombination,
        },
    }, {
        request: {
            text: 'use a custom structural composition',
            originalText: 'use a custom structural composition',
            scope: selectedScope,
        },
    });
    assert.deepStrictEqual(
        structuralSnapshot(smartOperation.args.graphicShell),
        structuralSnapshot(arbitraryCombination),
        'Smart Agent invocation did not preserve an arbitrary live-capability combination'
    );

    const directorEnvelope = {
        id: 'motion-director-shell',
        role: 'overlay',
        type: 'headline',
        text: 'Motion Director structure',
        subtext: 'Chosen from live dimensions',
        visualIntent: 'clean technical explanation',
        existingLayout: 'center-stack',
        existingSafeZone: 'center',
        existingVariant: 'standard',
        existingStyle: 'clean',
        existingAnimation: 'fadeSlide',
        existingShell: null,
        existingShellManual: false,
        transparentBackground: false,
        accentRuleVisible: true,
        variants: ['standard', 'stamp', 'typewriter'],
        shellCapabilities: capabilities,
    };
    const normalizedDirector = normalizeMotionDirectorSpec({
        layout: 'center-stack',
        safeZone: 'center',
        density: 'standard',
        textStrategy: 'headline',
        title: 'Motion Director structure',
        subtitle: 'Chosen from live dimensions',
        shell: {
            surface: 'outline',
            accent: 'bracket',
            geometry: 'rounded',
            hierarchy: 'stacked',
            width: 'compact',
            emphasis: 'strong',
        },
    }, directorEnvelope);
    assert.deepStrictEqual(
        structuralSnapshot(normalizedDirector.shell),
        structuralSnapshot(arbitraryCombination)
    );
    const prompt = buildMotionDirectorPrompt({
        projectContext: { title: 'Shell verification' },
        style: { themeId: 'modern' },
        items: [directorEnvelope],
    });
    assert.ok(prompt.includes('"shellCapabilities"'));
    assert.ok(prompt.includes('not from a fixed graphic-type template'));
    assert.ok(prompt.includes('transparentBackground is true'));

    const editPlan = {
        totalDuration: 4,
        fps: 30,
        scenes: [{ index: 0, clipId: 'clip-shell', startTime: 0, endTime: 4 }],
        motionGraphics: [{
            id: 'agent-shell-target',
            type: 'lowerThird',
            startTime: 0.5,
            duration: 2,
            text: 'Agent shell target',
            subtext: 'Existing transparent state',
            transparentBackground: true,
            cardStyle: 'transparent',
            accentRuleVisible: false,
        }],
        mgScenes: [],
        templateScenes: [],
    };
    const editResult = editScopedGraphicProperties(editPlan, {
        ...selectedScope,
    }, {
        targetType: 'lowerThird',
        targetIds: ['agent-shell-target'],
        graphicShell: arbitraryCombination,
    });
    assert.strictEqual(editResult.changed, 1);
    const editedGraphic = editPlan.motionGraphics[0];
    assert.strictEqual(editedGraphic.graphicShellManual, true);
    assert.deepStrictEqual(
        structuralSnapshot(editedGraphic.graphicShell),
        structuralSnapshot(arbitraryCombination)
    );
    assert.strictEqual(editedGraphic.transparentBackground, false);
    assert.strictEqual(editedGraphic.accentRuleVisible, true);
    const beforePartialEdit = structuralSnapshot(editedGraphic.graphicShell);
    const partialEdit = editScopedGraphicProperties(editPlan, selectedScope, {
        targetType: 'lowerThird',
        targetIds: ['agent-shell-target'],
        graphicShell: { accent: 'none' },
    });
    assert.strictEqual(partialEdit.changed, 1);
    assert.deepStrictEqual(
        {
            ...structuralSnapshot(editedGraphic.graphicShell),
            accent: beforePartialEdit.accent,
        },
        beforePartialEdit,
        'a partial shell edit changed unrelated structural dimensions'
    );
    assert.strictEqual(editedGraphic.graphicShell.accent, 'none');
    assert.strictEqual(editedGraphic.accentRuleVisible, false);

    const uiHtml = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
    const uiCss = fs.readFileSync(path.join(ROOT, 'ui', 'css', 'style.css'), 'utf8');
    const uiJs = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'app.js'), 'utf8');
    assert.ok(uiHtml.includes('id="mg-shell"'));
    assert.ok(uiHtml.includes('../src/render/graphic-shells.js'));
    assert.ok(uiCss.includes('.mg-shell-enabled .mg-shell-copy'));
    assert.ok(uiJs.includes('_populateMgShellDropdown'));
    assert.ok(uiJs.includes('graphicShellClassNames'));

    const browserPath = findBrowser();
    assert.ok(browserPath, 'Chrome or Edge is required for graphic-shell browser verification');

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-graphic-shells-'));
    const projectDir = path.join(testRoot, 'project');
    let browser;
    try {
        for (const name of ['temp', 'public', 'input']) {
            fs.mkdirSync(path.join(projectDir, name), { recursive: true });
        }
        writeSolidPng(path.join(projectDir, 'input', 'shell-bg.png'), [72, 88, 108]);

        const plan = {
            audio: null,
            totalDuration: 8,
            fps: 30,
            width: 1280,
            height: 720,
            scenes: [
                {
                    index: 0,
                    clipId: 'shell-scene-a',
                    startTime: 0,
                    endTime: 2,
                    duration: 2,
                    mediaType: 'image',
                    mediaFile: 'shell-bg.png',
                    fitMode: 'cover',
                    trackId: 'video-track-1',
                },
                {
                    index: 1,
                    clipId: 'shell-scene-b',
                    startTime: 2,
                    endTime: 4,
                    duration: 2,
                    mediaType: 'image',
                    mediaFile: 'shell-bg.png',
                    fitMode: 'cover',
                    trackId: 'video-track-1',
                },
                {
                    index: 2,
                    clipId: 'shell-scene-c',
                    startTime: 4,
                    endTime: 6,
                    duration: 2,
                    mediaType: 'image',
                    mediaFile: 'shell-bg.png',
                    fitMode: 'cover',
                    trackId: 'video-track-1',
                },
                {
                    index: 3,
                    clipId: 'shell-scene-d',
                    startTime: 6,
                    endTime: 8,
                    duration: 2,
                    mediaType: 'image',
                    mediaFile: 'shell-bg.png',
                    fitMode: 'cover',
                    trackId: 'video-track-1',
                },
            ],
            motionGraphics: [
                {
                    id: 'custom-overlay-shell',
                    clipId: 'custom-overlay-shell',
                    type: 'lowerThird',
                    text: 'Custom structural composition',
                    subtext: 'Theme colors remain independent',
                    startTime: 0.2,
                    endTime: 1.8,
                    position: 'bottom-left',
                    graphicShell: arbitraryCombination,
                    graphicShellManual: true,
                },
                {
                    id: 'protected-overlay-shell',
                    clipId: 'protected-overlay-shell',
                    type: 'headline',
                    text: 'Preserve explicit transparency',
                    startTime: 2.2,
                    endTime: 3.8,
                    position: 'center',
                    transparentBackground: true,
                    cardStyle: 'transparent',
                    accentRuleVisible: false,
                    graphicShell: {
                        surface: 'solid',
                        accent: 'rail',
                        geometry: 'rounded',
                        hierarchy: 'single',
                        width: 'compact',
                        emphasis: 'strong',
                    },
                },
                {
                    id: 'safe-layout-overlay',
                    clipId: 'safe-layout-overlay',
                    type: 'headline',
                    text: 'A deliberately long fallback headline that must remain inside the frame without relying on a custom component layout',
                    subtext: 'Universal Motion QA fallback',
                    startTime: 6.3,
                    endTime: 7.7,
                    position: 'center',
                    motionQaSafeLayout: true,
                    motionQaSafeLayoutReason: 'verification fixture',
                },
                {
                    id: 'safe-stat-overlay',
                    clipId: 'safe-stat-overlay',
                    type: 'statCounter',
                    text: '200 years',
                    subtext: 'The cooling industry has known since 1930',
                    startTime: 4.2,
                    endTime: 5.8,
                    position: 'bottom-right',
                    motionQaSafeLayout: true,
                    motionQaSafeLayoutReason: 'verification fixture',
                    agenticComposition: {
                        role: 'overlay',
                        type: 'stat-counter',
                        layout: 'data-focus',
                        safeZone: 'bottom-right',
                        density: 'compact',
                    },
                },
            ],
            mgScenes: [
                {
                    id: 'comparison-shell-guard',
                    clipId: 'comparison-shell-guard',
                    type: 'comparisonCard',
                    text: 'Surface Air Temperature vs Underground Soil Temperature',
                    subtext: 'the soil temperature stays between 54 and 56 degrees every single day of every single year.',
                    startTime: 6.2,
                    endTime: 7.8,
                    graphicShell: {
                        surface: 'outline',
                        accent: 'none',
                        geometry: 'square',
                        hierarchy: 'stacked',
                        width: 'compact',
                        emphasis: 'balanced',
                    },
                    agenticComposition: {
                        role: 'fullscreen',
                        type: 'comparison-card',
                        layout: 'split-panel',
                        density: 'compact',
                        title: 'Surface Air vs Underground Soil',
                        subtitle: 'Soil temperature: 54–56°F year-round',
                        items: [
                            { label: 'Surface Air', value: 'Variable' },
                            { label: 'Underground Soil', value: '54–56°F' },
                        ],
                    },
                },
                {
                    id: 'safe-comparison-fallback',
                    clipId: 'safe-comparison-fallback',
                    type: 'comparisonCard',
                    text: 'Earth Tube vs Standard AC',
                    subtext: 'Earth tube COP 28.7 versus standard AC COP 3.5',
                    startTime: 2.2,
                    endTime: 3.8,
                    motionQaSafeLayout: true,
                    motionQaSafeLayoutReason: 'repeated vision defect',
                    agenticComposition: {
                        role: 'fullscreen',
                        type: 'comparison-card',
                        layout: 'split-panel',
                        density: 'compact',
                        items: [
                            { label: 'Earth Tube', value: '28.7 COP' },
                            { label: 'Standard AC', value: '3.5 COP' },
                        ],
                    },
                },
            ],
            templateScenes: [{
                id: 'stage-shell',
                clipId: 'stage-shell',
                type: 'chapterCard',
                templateType: 'chapterCard',
                text: 'Dedicated stage structure',
                subtext: 'The same shell contract reaches cards',
                startTime: 4.2,
                endTime: 5.8,
                graphicShell: {
                    surface: 'none',
                    accent: 'underline',
                    geometry: 'square',
                    hierarchy: 'stacked',
                    width: 'compact',
                    emphasis: 'balanced',
                },
                graphicShellManual: true,
            }],
            transitions: [],
            sfxClips: [],
            scriptContext: {
                title: 'Graphic shell verification',
                themeId: 'modern',
            },
            themeId: 'modern',
        };

        const generated = generateHyperframesProject({
            plan,
            projectDir,
            appRoot: ROOT,
            tempDir: path.join(projectDir, 'temp'),
            publicDir: path.join(projectDir, 'public'),
            inputDir: path.join(projectDir, 'input'),
            outputRoot: path.join(projectDir, 'hyperframes'),
            options: { preview: true },
        });
        assert.strictEqual(generated.success, true);

        const html = fs.readFileSync(generated.indexPath, 'utf8');
        assert.ok(html.includes('.hf-shell-enabled .hf-shell-target'));
        assert.ok(html.includes('var(--hf-primary)'));
        assert.ok(html.includes('var(--hf-accent)'));
        assert.ok(html.includes('hf-chapter-copy hf-shell-target'));

        const motionManifest = JSON.parse(fs.readFileSync(
            path.join(generated.projectDir, 'hyperframes-motion-manifest.json'),
            'utf8'
        ));
        const customEntry = motionManifest.graphics.find((entry) => (
            entry.sourceClipId === 'custom-overlay-shell'
        ));
        const protectedEntry = motionManifest.graphics.find((entry) => (
            entry.sourceClipId === 'protected-overlay-shell'
        ));
        const stageEntry = motionManifest.graphics.find((entry) => (
            entry.sourceClipId === 'stage-shell'
        ));
        const comparisonEntry = motionManifest.graphics.find((entry) => (
            entry.sourceClipId === 'comparison-shell-guard'
        ));
        const safeEntry = motionManifest.graphics.find((entry) => (
            entry.sourceClipId === 'safe-layout-overlay'
        ));
        const safeStatEntry = motionManifest.graphics.find((entry) => (
            entry.sourceClipId === 'safe-stat-overlay'
        ));
        const safeComparisonEntry = motionManifest.graphics.find((entry) => (
            entry.sourceClipId === 'safe-comparison-fallback'
        ));
        assert.ok(customEntry?.graphicShellApplied);
        assert.ok(protectedEntry?.graphicShellApplied);
        assert.ok(stageEntry?.graphicShellApplied);
        assert.ok(comparisonEntry?.graphicShellApplied);
        assert.strictEqual(safeEntry?.safeLayout, true);
        assert.strictEqual(safeEntry?.graphicShellApplied, false);
        assert.strictEqual(safeStatEntry?.safeLayout, true);
        assert.strictEqual(safeComparisonEntry?.safeLayout, true);
        assert.strictEqual(comparisonEntry.componentOwnsLayout, true);
        assert.strictEqual(comparisonEntry.graphicShell.width, 'wide');
        assert.deepStrictEqual(
            structuralSnapshot(customEntry.graphicShell),
            structuralSnapshot(arbitraryCombination)
        );
        assert.strictEqual(protectedEntry.graphicShell.surface, 'none');
        assert.strictEqual(protectedEntry.graphicShell.accent, 'none');
        assert.strictEqual(stageEntry.graphicShell.accent, 'underline');

        browser = await puppeteer.launch({
            executablePath: browserPath,
            headless: 'new',
            defaultViewport: { width: 1280, height: 720 },
            args: [
                '--allow-file-access-from-files',
                '--disable-gpu-sandbox',
                '--no-sandbox',
            ],
        });
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(`${pathToFileURL(generated.indexPath).href}?preview=1`, {
            waitUntil: 'load',
            timeout: 30_000,
        });
        await page.waitForFunction(() => Boolean(window.__HF_PREVIEW__), {
            timeout: 15_000,
        });

        const customProof = await inspectShell(page, customEntry.id, 1);
        assert.ok(customProof, 'custom overlay shell has no rendered target');
        assert.strictEqual(customProof.surface, 'outline');
        assert.strictEqual(customProof.accent, 'bracket');
        assert.ok(customProof.borderTopWidth > 0, 'outline surface did not render');
        assert.ok(customProof.beforeWidth > 0, 'bracket accent did not render');
        assert.ok(customProof.rect.width > 20 && customProof.rect.height > 20);

        const protectedProof = await inspectShell(page, protectedEntry.id, 3);
        assert.ok(protectedProof, 'protected overlay shell has no rendered target');
        assert.strictEqual(protectedProof.surface, 'none');
        assert.strictEqual(protectedProof.accent, 'none');
        assert.strictEqual(protectedProof.backgroundColor, 'rgba(0, 0, 0, 0)');
        assert.strictEqual(protectedProof.borderLeftWidth, 0);
        assert.strictEqual(protectedProof.borderBottomWidth, 0);

        const stageProof = await inspectShell(page, stageEntry.id, 5);
        assert.ok(stageProof, 'dedicated card shell has no rendered target');
        assert.strictEqual(stageProof.accent, 'underline');
        // The underline accent used to be a border-bottom on the target, and this
        // assertion used to read borderBottomWidth. It is a short ::after rule now,
        // deliberately: a border-bottom spans the whole box, and a full-width bar
        // welded to the edge of a text block is the single most recognisable
        // generated-design tell. Asserting the old mechanism would have pinned the
        // exact thing we set out to remove, so the assertion moved to the property
        // that actually matters — the accent renders, and it is a RULE, not chrome.
        assert.ok(stageProof.afterWidth > 0 && stageProof.afterHeight > 0,
            'dedicated card underline did not render');
        assert.ok(stageProof.afterHeight <= 4,
            `underline accent is ${stageProof.afterHeight}px tall — that is a bar, not a rule`);
        assert.ok(stageProof.afterWidth < stageProof.rect.width * 0.9,
            'underline accent spans the full card — it must read as a mark, not an edge');
        assert.strictEqual(stageProof.borderBottomWidth, 0,
            'underline accent must not also draw a border; that is two marks for one accent');

        const comparisonProof = await inspectShell(page, comparisonEntry.id, 7);
        assert.ok(comparisonProof, 'comparison card has no rendered shell target');
        assert.ok(
            comparisonProof.rootClass.includes('hf-component-layout-owned'),
            'comparison card did not declare component layout ownership'
        );
        assert.ok(comparisonProof.rect.width > 900, 'compact shell still narrowed the comparison component');
        const comparisonGeometry = await page.evaluate((id) => {
            const root = document.getElementById(id);
            const wrap = root?.querySelector('.hf-comparison-wrap');
            const note = root?.querySelector('.hf-comparison-note');
            const sides = [...(root?.querySelectorAll('.hf-compare-side') || [])];
            if (!root || !wrap || sides.length !== 2) return null;
            const wrapStyle = getComputedStyle(wrap);
            return {
                wrapPosition: wrapStyle.position,
                wrapWidth: wrap.clientWidth,
                wrapScrollWidth: wrap.scrollWidth,
                sideRects: sides.map((side) => {
                    const rect = side.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, width: rect.width };
                }),
                note: note?.textContent || '',
                rawNarrationPresent: root.textContent.includes('every single day of every single year'),
            };
        }, comparisonEntry.id);
        assert.ok(comparisonGeometry, 'comparison geometry could not be inspected');
        assert.strictEqual(comparisonGeometry.wrapPosition, 'relative');
        assert.ok(
            comparisonGeometry.wrapScrollWidth <= comparisonGeometry.wrapWidth + 4,
            `comparison grid overflowed its component (${comparisonGeometry.wrapScrollWidth} > ${comparisonGeometry.wrapWidth})`
        );
        assert.ok(comparisonGeometry.sideRects.every((rect) => rect.width > 300), 'comparison columns collapsed');
        assert.strictEqual(comparisonGeometry.note, 'Soil temperature: 54–56°F year-round');
        assert.strictEqual(comparisonGeometry.rawNarrationPresent, false, 'raw narration leaked into visible comparison copy');

        const safeGeometry = await page.evaluate(({ id, time }) => {
            window.__HF_PREVIEW__.seek(time);
            if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();
            const root = document.getElementById(id);
            const card = root?.querySelector('.hf-safe-layout-overlay');
            if (!root || !card) return null;
            return {
                enabled: root.dataset.hfSafeLayout,
                width: card.clientWidth,
                scrollWidth: card.scrollWidth,
                height: card.clientHeight,
                scrollHeight: card.scrollHeight,
                text: card.textContent.replace(/\s+/g, ' ').trim(),
            };
        }, { id: safeEntry.id, time: 7 });
        assert.ok(safeGeometry, 'universal safe-layout fallback did not render');
        assert.strictEqual(safeGeometry.enabled, '1');
        assert.ok(safeGeometry.scrollWidth <= safeGeometry.width + 4, 'safe fallback overflowed horizontally');
        assert.ok(safeGeometry.scrollHeight <= safeGeometry.height + 4, 'safe fallback overflowed vertically');
        assert.ok(safeGeometry.text.includes('Universal Motion QA fallback'));

        const safeStatGeometry = await page.evaluate(({ id, time }) => {
            window.__HF_PREVIEW__.seek(time);
            if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();
            const root = document.getElementById(id);
            const card = root?.querySelector('.hf-safe-stat-overlay');
            const value = root?.querySelector('.hf-safe-stat-value');
            if (!root || !card || !value) return null;
            const rootRect = root.getBoundingClientRect();
            return {
                rootClass: root.className,
                rootRect: { left: rootRect.left, right: rootRect.right, width: rootRect.width },
                cardOverflowX: card.scrollWidth - card.clientWidth,
                cardOverflowY: card.scrollHeight - card.clientHeight,
                valueOverflowY: value.scrollHeight - value.clientHeight,
                text: card.textContent.replace(/\s+/g, ' ').trim(),
            };
        }, { id: safeStatEntry.id, time: 5 });
        assert.ok(safeStatGeometry, 'safe stat-counter fallback did not render');
        assert.ok(!safeStatGeometry.rootClass.includes('hf-agentic '), 'safe stat fallback inherited the full-frame agentic layout');
        assert.ok(safeStatGeometry.rootRect.width < 1400, 'safe stat fallback ignored its bounded overlay zone');
        assert.ok(safeStatGeometry.rootRect.right < 1920, 'safe stat fallback escaped the right safe margin');
        assert.ok(safeStatGeometry.cardOverflowX <= 4 && safeStatGeometry.cardOverflowY <= 4, 'safe stat card overflowed');
        assert.ok(safeStatGeometry.valueOverflowY <= 4, 'safe stat value glyphs were clipped');
        assert.ok(safeStatGeometry.text.includes('200') && safeStatGeometry.text.includes('years'));

        const safeComparisonGeometry = await page.evaluate(({ id, time }) => {
            window.__HF_PREVIEW__.seek(time);
            if (typeof window.__hfFlushSync === 'function') window.__hfFlushSync();
            const root = document.getElementById(id);
            const grid = root?.querySelector('.hf-comparison-wrap');
            const sides = [...(root?.querySelectorAll('.hf-compare-side') || [])];
            if (!root || !grid || sides.length !== 2) return null;
            return {
                overflowX: grid.scrollWidth - grid.clientWidth,
                overflowY: grid.scrollHeight - grid.clientHeight,
                sideWidths: sides.map(side => side.getBoundingClientRect().width),
                text: root.textContent.replace(/\s+/g, ' ').trim(),
            };
        }, { id: safeComparisonEntry.id, time: 3 });
        assert.ok(safeComparisonGeometry, 'safe comparison fallback did not use the comparison renderer');
        assert.ok(safeComparisonGeometry.overflowX <= 4 && safeComparisonGeometry.overflowY <= 4);
        assert.ok(safeComparisonGeometry.sideWidths.every(width => width > 250));
        assert.ok(safeComparisonGeometry.text.includes('Earth Tube'));
        assert.ok(safeComparisonGeometry.text.includes('Standard AC'));
        assert.deepStrictEqual(pageErrors, [], `graphic-shell preview raised browser errors: ${pageErrors.join('; ')}`);

        console.log('Graphic shell intelligence, Agent capability, and rendered output passed');
    } finally {
        if (browser) await browser.close().catch(() => {});
        const resolved = path.resolve(testRoot);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-graphic-shells-')) {
            throw new Error(`Refusing to clean unsafe graphic-shell directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
