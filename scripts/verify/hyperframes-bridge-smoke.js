#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const { generateHyperframesProject } = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-hf-smoke-'));
const projectDir = path.join(smokeRoot, 'project');

try {
    for (const name of ['temp', 'public', 'input']) {
        fs.mkdirSync(path.join(projectDir, name), { recursive: true });
    }
    const smokeImage = new PNG({ width: 8, height: 8 });
    for (let offset = 0; offset < smokeImage.data.length; offset += 4) {
        smokeImage.data[offset] = 48;
        smokeImage.data[offset + 1] = 96;
        smokeImage.data[offset + 2] = 160;
        smokeImage.data[offset + 3] = 255;
    }
    fs.writeFileSync(path.join(projectDir, 'input', 'smoke.png'), PNG.sync.write(smokeImage));

    const plan = {
        audio: null,
        subtitlesEnabled: true,
        captionKaraoke: true,
        captionWordsPerCue: 2,
        captionMaxDuration: 1.2,
        captionStyle: {
            position: 'top',
            background: 'none',
            color: '#ffffff',
            activeColor: '#ef4444',
            fontSize: 38,
        },
        totalDuration: 2,
        fps: 30,
        width: 1920,
        height: 1080,
        scenes: [
            {
                index: 0,
                sourceSceneIndex: 0,
                clipId: 'clip-smoke-a',
                startTime: 0,
                endTime: 1,
                duration: 1,
                text: 'HyperFrames smoke scene A',
                words: [
                    { word: 'HyperFrames', start: 0.05, end: 0.35 },
                    { word: 'smoke', start: 0.36, end: 0.62 },
                    { word: 'scene', start: 0.63, end: 0.82 },
                    { word: 'A', start: 0.83, end: 0.96 },
                ],
                mediaType: 'image',
                mediaFile: 'smoke.png',
                kenBurnsEnabled: false,
                framing: 'cinematic',
                scale: 0.75,
                _effectRecipe: [{
                    id: 'vignette',
                    intensity: 0.3,
                    color: '#000000',
                    userDirected: true,
                }],
                trackId: 'video-track-1',
            },
            {
                index: 0,
                sourceSceneIndex: 0,
                clipId: 'clip-smoke-b',
                startTime: 1,
                endTime: 2,
                duration: 1,
                mediaOffset: 1,
                text: 'HyperFrames smoke scene B',
                mediaType: 'image',
                mediaFile: 'smoke.png',
                kenBurnsSpeed: 1.5,
                trackId: 'video-track-1',
            },
        ],
        mgScenes: [],
        templateScenes: [
            {
                id: 'smoke-stat-card',
                clipId: 'smoke-stat-card',
                type: 'statCard',
                templateType: 'statCard',
                text: '$640 Project Cost',
                subtext: 'Stage visual behind the overlay',
                items: [{ value: '$640', label: 'Project Cost' }],
                sceneIndex: 0,
                startTime: 0.1,
                endTime: 0.9,
                style: 'cinematic',
                styleManual: true,
                variant: 'single',
                subType: 'single',
                variantManual: true,
                animation: 'countUp',
                authoredCompositionMode: 'fixed-renderer',
                agenticComposition: {
                    mode: 'agentic',
                    role: 'template',
                    type: 'stat-card',
                    layout: 'focus-panel',
                    title: '$640 Project Cost',
                    items: [],
                    motion: {
                        entrance: 'fade and rise',
                        speed: 'normal',
                    },
                },
            },
        ],
        motionGraphics: [
            {
                type: 'lowerThird',
                text: '50 Years',
                subtext: 'Numeric directive overlay',
                textStyleRanges: [{
                    match: '50 Years',
                    color: '#ef4444',
                    occurrence: 0,
                    allOccurrences: false,
                }],
                sceneIndex: 0,
                startTime: 0.1,
                endTime: 0.9,
            },
            {
                id: 'smoke-headline',
                clipId: 'smoke-headline',
                type: 'headline',
                text: 'Typed white headline',
                subtext: '',
                sceneIndex: 1,
                startTime: 1.1,
                endTime: 1.9,
                subType: 'typewriter',
                animation: 'typewriter',
                animationManual: true,
                variantManual: true,
                accentRuleVisible: false,
                transparentBackground: true,
                cardStyle: 'transparent',
                colors: {
                    text: '#ffffff',
                    background: 'rgba(0,0,0,0)',
                    surface: 'rgba(0,0,0,0)',
                },
                textColorManual: true,
                _authoredComposition: {
                    html: '<div class="stale-authored-headline">STALE CREAM HEADLINE</div>',
                    css: '.stale-authored-headline{background:#ece0c8;color:#2c2218;}',
                    timeline: 'tl.to(".stale-authored-headline",{opacity:1});',
                },
            },
        ],
        transitions: [
            {
                type: 'wipe-left',
                fromSceneIndex: 0,
                toSceneIndex: 1,
                startTime: 0.7,
                endTime: 1.3,
                duration: 0.6,
            },
        ],
        sfxClips: [],
        scriptContext: { title: 'HyperFrames smoke', themeId: 'standard' },
        themeId: 'standard',
    };

    const result = generateHyperframesProject({
        plan,
        projectDir,
        appRoot: ROOT,
        tempDir: path.join(projectDir, 'temp'),
        publicDir: path.join(projectDir, 'public'),
        inputDir: path.join(projectDir, 'input'),
        outputRoot: path.join(projectDir, 'hyperframes'),
    });

    assert(result?.success === true, 'bridge did not report success');
    assert(fs.existsSync(result.indexPath), 'bridge did not create index.html');
    assert(fs.existsSync(path.join(result.projectDir, 'video-plan.snapshot.json')), 'bridge did not create a plan snapshot');
    assert(fs.existsSync(path.join(result.projectDir, 'hyperframes-motion-manifest.json')), 'bridge did not create the Motion QA manifest');
    assert(fs.existsSync(path.join(result.projectDir, 'vendor', 'gsap.min.js')), 'bridge did not copy the local GSAP runtime');

    const html = fs.readFileSync(result.indexPath, 'utf8');
    assert(html.includes("window.__timelines['yta-hyperframes']"), 'generated project is missing the HyperFrames timeline');
    assert(!html.includes('performance.now('), 'render-safe project still contains the live preview clock');
    assert(!html.includes('/*HF_PREVIEW_START*/'), 'render-safe project still contains the live preview controller');
    assert(html.includes('data-duration="2.000"'), 'generated project has the wrong duration');
    assert(html.includes('data-visible-transition-count="1"'), 'generated project is missing its visible transition diagnostics');
    assert(html.includes('data-motion-transition-count="1"'), 'generated project did not classify the wipe as scene motion');
    const sceneMediaTags = html.match(/<(?:img|video)\b[^>]*class="[^"]*\bhf-scene-media\b[^"]*"[^>]*>/g) || [];
    assert(
        sceneMediaTags.length >= 2,
        'generated project is missing copied scene media'
    );
    assert(
        sceneMediaTags.every(tag => (
            /\bid="[^"]+"/.test(tag)
            && /\bdata-start="[^"]+"/.test(tag)
            && /\bdata-duration="[^"]+"/.test(tag)
            && /\bdata-track-index="[^"]+"/.test(tag)
            && /\bclass="[^"]*\bclip\b/.test(tag)
        )),
        'scene media is missing the direct HyperFrames timing/identity contract'
    );
    const sceneWrapperTags = html.match(/<div\b[^>]*class="[^"]*\bhf-scene-wrap\b[^"]*"[^>]*>/g) || [];
    assert(
        sceneWrapperTags.every(tag => !/\bdata-start=/.test(tag)),
        'timed scene wrapper would freeze nested media during HyperFrames capture'
    );
    const openingSceneWrapper = sceneWrapperTags.find(tag => tag.includes('id="scene-clip-smoke-a"')) || '';
    assert(
        openingSceneWrapper.includes('hf-opening-scene'),
        'the frame-zero scene is missing its immediately-visible opening state'
    );
    assert(
        html.includes('const isOpeningScene = item.start <= 0.001;')
        && html.includes('hfSet(sel, { opacity: 1 }, 0);'),
        'the master timeline still fades the opening scene in from black'
    );
    assert(html.includes('top: 72px; bottom: auto; align-items: flex-start;'), 'caption position setting did not reach the renderer');
    assert(html.includes('padding: 0; background: transparent; border-radius: 0;'), 'caption background setting did not reach the renderer');
    assert(html.includes('font-size: 38px;'), 'caption font-size setting did not reach the renderer');
    assert(html.includes('color: "#ef4444"'), 'karaoke active color did not reach the timeline');
    assert((html.match(/class="hf-cap-word"/g) || []).length === 4, 'karaoke caption words were not emitted');
    assert(html.includes('id="scene-clip-smoke-a-fx-vig"'), 'user-directed vignette was suppressed on a framed clip');
    assert(html.includes('rgba(0,0,0,'), 'user-directed black vignette color did not reach HyperFrames');
    assert(html.includes('id="scene-clip-smoke-a"'), 'first duplicate-source clip has the wrong DOM identity');
    assert(html.includes('id="scene-clip-smoke-b"'), 'second duplicate-source clip has the wrong DOM identity');
    const lowerThirdTag = html.match(/<[^>]+id="mg-\d+-lower-third"[^>]+>/)?.[0] || '';
    const statCardTag = html.match(/<[^>]+id="mg-\d+-stat-card"[^>]+>/)?.[0] || '';
    const lowerThirdTrack = Number(lowerThirdTag.match(/data-track-index="(\d+)"/)?.[1]);
    const statCardTrack = Number(statCardTag.match(/data-track-index="(\d+)"/)?.[1]);
    assert(lowerThirdTag && statCardTag, 'generated project is missing the overlapping stage/overlay graphics');
    assert(lowerThirdTrack > statCardTrack, 'overlay graphic is not layered above its stage visual');
    // ── Same-lane collision guard ──────────────────────────────────────────────
    // Mirrors the HyperFrames CLI lint rule `overlapping_clips_same_track`, which is an
    // ERROR that Motion QA turns into a hard render block. Keep the epsilon equal to the
    // CLI's OVERLAP_EPSILON_SECONDS (1e-6, node_modules/hyperframes/dist/cli.js) or our
    // gate and the CLI's gate can disagree. The CLI groups by the RAW attribute string,
    // so we do too — never emit zero-padded or whitespace-padded track values.
    const timedTrackedClips = (html.match(/<[a-zA-Z][^>]*>/g) || [])
        .map(tag => ({
            id: tag.match(/\bid="([^"]*)"/)?.[1] || '(no id)',
            track: tag.match(/(?<![\w-])data-track-index\s*=\s*"([^"]*)"/)?.[1],
            start: Number(tag.match(/(?<![\w-])data-start\s*=\s*"([^"]*)"/)?.[1]),
            duration: Number(tag.match(/(?<![\w-])data-duration\s*=\s*"([^"]*)"/)?.[1]),
        }))
        .filter(clip => clip.track !== undefined && Number.isFinite(clip.start) && Number.isFinite(clip.duration));
    assert(timedTrackedClips.length >= 8, 'generated project lost its timed, track-indexed clips');
    const clipsByLane = new Map();
    for (const clip of timedTrackedClips) {
        if (!clipsByLane.has(clip.track)) clipsByLane.set(clip.track, []);
        clipsByLane.get(clip.track).push(clip);
    }
    for (const [track, laneClips] of clipsByLane) {
        laneClips.sort((a, b) => a.start - b.start);
        for (let i = 0; i + 1 < laneClips.length; i++) {
            assert(
                laneClips[i].start + laneClips[i].duration - laneClips[i + 1].start <= 1e-6,
                `track ${track} has overlapping clips (${laneClips[i].id} then ${laneClips[i + 1].id}) — HyperFrames lint blocks this render`
            );
        }
    }
    // Structural half of the same guard, because fixture timing alone cannot prove it:
    // allocateGraphicTrack() hands out CONSECUTIVE integers, so a background parked at
    // `wrapperTrack - 1` IS the previous graphic's wrapper lane, and renderAssetFill's
    // template pre-roll starts it 0.12s early, straight into that neighbour's window.
    // Every other data-track-index the bridge emits is >= -10000 (scene media floors
    // exactly there), so the background band below that is provably unreachable.
    const bgMediaTags = html.match(/<(?:img|video)\b[^>]*class="[^"]*\bhf-bg-media\b[^"]*"[^>]*>/g) || [];
    assert(bgMediaTags.length >= 1, 'generated project is missing the stage-visual background media fill');
    const bgMediaTracks = bgMediaTags.map(tag => Number(tag.match(/data-track-index="(-?\d+)"/)?.[1]));
    assert(
        bgMediaTracks.every(track => Number.isInteger(track) && track < -10000),
        'graphic background media left its reserved lane band — it can collide with a graphic wrapper track again'
    );
    assert(
        new Set(bgMediaTracks).size === bgMediaTracks.length,
        'two graphic backgrounds were allocated the same lane'
    );
    assert(lowerThirdTag.includes('data-hf-adaptive-contrast="1"'), 'overlay graphic is missing footage-aware contrast protection');
    assert(lowerThirdTag.includes('data-hf-text-explicit="0"'), 'theme-inherited lower-third color was incorrectly locked');
    // Matched piece by piece, not as one pinned string: attribute order is not a
    // product promise, and asserting it turns every additive markup change into a
    // fake failure. What must hold is that the span is a text range, that it
    // carries the requested words and the requested colour, and that it is
    // locked against the footage-aware contrast pass.
    const styledRangeTag = html.match(/<span[^>]*hf-agentic-text-range[^>]*>/)?.[0] || '';
    assert(
        /data-hf-text-range="50 Years"/.test(styledRangeTag)
            && /data-hf-text-range-color="#ef4444"/.test(styledRangeTag),
        'selective lower-third text color was not rendered as an in-place styled range'
    );
    // The colour is only real if it survives to the screen. Without this lock the
    // in-page contrast pass repaints the span with the theme's own text colour
    // and !important, so the Agent edit is correct everywhere except in the video.
    assert(
        /data-hf-contrast-lock="manual"/.test(styledRangeTag),
        'a deliberately coloured text range is not locked against automatic recoloring — the contrast pass will paint over it'
    );
    assert(
        html.includes('.hf-agentic-text-range { color: var(--hf-text-range-color, currentColor); }'),
        'generated project is missing the selective text-range style contract'
    );
    const headlineTag = html.match(/<[^>]+id="mg-\d+-headline"[^>]+>/)?.[0] || '';
    assert(headlineTag.includes('data-hf-adaptive-contrast="1"'), 'headline is missing footage-aware contrast protection');
    assert(headlineTag.includes('data-hf-text-explicit="1"'), 'explicit headline color was not protected from automatic recoloring');
    assert(headlineTag.includes('hf-card-transparent'), 'transparent headline card state did not reach HyperFrames');
    assert(headlineTag.includes('hf-variant-typewriter'), 'headline typewriter variant did not reach HyperFrames');
    assert(headlineTag.includes('hf-anim-typewriter'), 'headline typewriter animation did not reach HyperFrames');
    assert(headlineTag.includes('hf-no-accent-rule'), 'headline accent-rule removal did not reach HyperFrames');
    assert(headlineTag.includes('--hf-text: #ffffff'), 'headline text color did not reach HyperFrames');
    assert(!html.includes('STALE CREAM HEADLINE'), 'stale authored headline overrode the explicit Agent edit');
    assert(
        html.includes('class="hf-agentic-title hf-agentic-typewriter"'),
        'agentic headline did not emit a typewriter reveal target'
    );
    assert(
        html.includes('.hf-card-transparent .hf-agentic-copy'),
        'transparent cards do not suppress the agentic composition background'
    );
    assert(
        html.includes("item.animation === 'typewriter' || item.variant === 'typewriter'"),
        'HyperFrames runtime is missing typewriter animation dispatch for headline variants'
    );
    assert(!html.includes('<div class="hf-title">$640 Project Cost</div>'), 'single-item stat card must not repeat its value/label as a second title');
    assert(html.includes('<span class="hf-item-value">$640</span>'), 'single-item stat card must keep the hero value');
    assert(html.includes('<span class="hf-item-label">Project Cost</span>'), 'single-item stat card must keep the value label');
    assert(
        html.includes('.hf-template.hf-type-stat-card.hf-variant-single .hf-template-items { display: grid;'),
        'single-item stat cards are still hidden by the generic single-template rule'
    );
    assert(html.includes('.hf-type-lower-third.hf-variant-underline .hf-agentic-copy { justify-self: start; width: fit-content;'), 'underline lower third must stay content-width instead of drawing a frame-wide rule');
    assert(html.includes('padding: 14px 8px 28px'), 'underline lower third must keep clear vertical space between text and its rule');
    assert(html.includes('src="vendor/gsap.min.js"'), 'generated project does not use the local GSAP runtime');
    assert(!html.includes('cdn.jsdelivr.net'), 'generated project still depends on the GSAP CDN');
    assert(html.includes('window.__HF_ADAPTIVE_CONTRAST__'), 'generated project is missing the adaptive-contrast runtime');
    assert(html.includes('window.__HF_ADAPTIVE_CONTRAST_REPORT__'), 'generated project is missing the adaptive-contrast QA report');
    assert(html.includes('.hf-adaptive-protection'), 'generated project is missing bounded contrast-protection styling');
    const generatedPackage = JSON.parse(fs.readFileSync(path.join(result.projectDir, 'package.json'), 'utf8'));
    assert(generatedPackage.scripts?.check, 'generated project is missing the HyperFrames check command');
    assert(generatedPackage.scripts?.keyframes, 'generated project is missing the HyperFrames keyframes command');
    assert(generatedPackage.scripts?.snapshot, 'generated project is missing the HyperFrames snapshot command');
    const hyperframesCli = require.resolve('hyperframes/dist/cli.js');
    const lint = spawnSync(process.execPath, [
        hyperframesCli,
        'lint',
        result.projectDir,
        '--json',
    ], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
    });
    assert(
        lint.status === 0,
        `render-safe HyperFrames lint failed:\n${lint.stderr || lint.stdout}`
    );
    const lintReport = JSON.parse(lint.stdout);
    assert(lintReport.errorCount === 0, 'render-safe HyperFrames lint reported blocking errors');
    const motionManifest = JSON.parse(fs.readFileSync(path.join(result.projectDir, 'hyperframes-motion-manifest.json'), 'utf8'));
    assert(motionManifest.scenes.find((scene) => scene.id === 'scene-clip-smoke-a')?.hasKenBurns === false, 'explicit Ken Burns disable was ignored');
    assert(motionManifest.scenes.find((scene) => scene.id === 'scene-clip-smoke-b')?.hasKenBurns === true, 'Ken Burns speed-enabled still did not animate');
    const headlineManifest = motionManifest.graphics.find((graphic) => graphic.sourceClipId === 'smoke-headline');
    assert(headlineManifest, 'edited headline is missing from the render manifest');
    assert(headlineManifest.authored === false, 'edited headline still rendered through its stale authored composition');
    assert(headlineManifest.fixedRendererOverride === true, 'edited headline did not declare its fixed-renderer override');
    assert(headlineManifest.transparentBackground === true, 'edited headline lost its transparent background in the render manifest');
    assert(headlineManifest.animation === 'typewriter', 'edited headline lost its typewriter animation in the render manifest');
    assert(headlineManifest.textColor === '#ffffff', 'edited headline lost its white text color in the render manifest');
    assert(headlineManifest.textColorExplicit === true, 'edited headline did not preserve explicit-color intent in the render manifest');
    assert(headlineManifest.adaptiveContrast === true, 'edited headline is missing adaptive contrast in the render manifest');
    assert(headlineManifest.accentRuleVisible === false, 'edited headline restored its decorative accent rule');
    const statCardManifest = motionManifest.graphics.find((graphic) => graphic.sourceClipId === 'smoke-stat-card');
    assert(statCardManifest, 'restyled stat card is missing from the render manifest');
    assert(statCardManifest.authored === false, 'restyled stat card still used its stale authored motion');
    assert(statCardManifest.fixedRendererOverride === true, 'restyled stat card did not declare its fixed-renderer override');
    assert(statCardManifest.variant === 'single', 'restyled stat card lost its selected single variant');
    assert(
        statCardManifest.animation === 'countUp',
        `restyled stat card rendered "${statCardManifest.animation}" instead of its fixed-renderer countUp animation`
    );

    const secondResult = generateHyperframesProject({
        plan: {
            ...plan,
            scriptContext: { ...plan.scriptContext, title: 'HyperFrames immediate regeneration' },
        },
        projectDir,
        appRoot: ROOT,
        tempDir: path.join(projectDir, 'temp'),
        publicDir: path.join(projectDir, 'public'),
        inputDir: path.join(projectDir, 'input'),
        outputRoot: path.join(projectDir, 'hyperframes'),
    });
    assert(secondResult.projectDir !== result.projectDir, 'immediate preview regenerations reused the same project directory');
    assert(fs.existsSync(secondResult.indexPath), 'immediate preview regeneration did not create a distinct index.html');

    // ── Reserved-lane regression fixture: captions + overlay transitions ───────
    // The main fixture above cannot prove this on its own — its cues are comfortably
    // spaced and its only transition is scene-motion (no DOM clip). This third plan
    // reproduces, in miniature, the two mechanisms that really shipped a render block:
    //   1. buildCaptionCues() pads any cue shorter than 0.4s UP to 0.4s and does NOT
    //      move the next cue's start ("Go." at 0.05-0.20 becomes 0.05-0.45 while the
    //      next cue still starts at 0.20). Real WhisperX emits words end-to-end, so
    //      there is no gap to absorb the pad.
    //   2. Two overlay transitions are each CENTRED on their cut, so boundaries closer
    //      than (d1+d2)/2 collide — reachable with one cut-at-playhead in the UI, which
    //      deep-clones the scene INCLUDING its transition.
    // While captions shared lane 26 and transitions shared lane 28, both produced the
    // CLI's `overlapping_clips_same_track` (severity ERROR -> Motion QA hard render
    // block). Giving each clip its own reserved lane makes that arithmetically
    // impossible; these assertions fail if anyone re-shares a lane.
    const laneScene = (over) => ({ ...plan.scenes[0], ...over });
    const lanePlan = {
        ...plan,
        totalDuration: 2.5,
        motionGraphics: [],
        mgScenes: [],
        templateScenes: [],
        scenes: [
            laneScene({
                clipId: 'clip-lane-a', startTime: 0, endTime: 1, duration: 1,
                text: 'Go. Next word here',
                words: [
                    { word: 'Go.', start: 0.05, end: 0.2 },
                    { word: 'Next', start: 0.2, end: 0.55 },
                    { word: 'word', start: 0.55, end: 0.75 },
                    { word: 'here', start: 0.75, end: 0.99 },
                ],
            }),
            laneScene({
                clipId: 'clip-lane-b', startTime: 1, endTime: 1.25, duration: 0.25,
                text: 'Beat', words: [{ word: 'Beat', start: 1, end: 1.24 }],
            }),
            laneScene({
                clipId: 'clip-lane-c', startTime: 1.25, endTime: 2.5, duration: 1.25,
                text: 'And on we go',
                words: [
                    { word: 'And', start: 1.25, end: 1.5 },
                    { word: 'on', start: 1.5, end: 1.7 },
                    { word: 'we', start: 1.7, end: 1.9 },
                    { word: 'go', start: 1.9, end: 2.4 },
                ],
            }),
        ],
        // flash-white is an OVERLAY transition (it emits a DOM clip); wipe-left above is
        // scene-motion and emits none. 1.00 and 1.25 are 0.25s apart, well inside the
        // 0.46s default duration, so the two slabs overlap by 0.21s.
        transitions: [
            { type: 'flash-white', fromSceneIndex: 0, toSceneIndex: 1, startTime: 1, duration: 0.46 },
            { type: 'flash-white', fromSceneIndex: 1, toSceneIndex: 2, startTime: 1.25, duration: 0.46 },
        ],
    };
    const laneResult = generateHyperframesProject({
        plan: lanePlan,
        projectDir,
        appRoot: ROOT,
        tempDir: path.join(projectDir, 'temp'),
        publicDir: path.join(projectDir, 'public'),
        inputDir: path.join(projectDir, 'input'),
        outputRoot: path.join(projectDir, 'hyperframes'),
    });
    const laneHtml = fs.readFileSync(laneResult.indexPath, 'utf8');
    // Class tokens are compared EXACTLY, never with \b: `\bhf-transition\b` also matches
    // the inner hf-transition-slab / hf-transition-flare children, because "-" is a word
    // boundary. Only the timed outer clip carries a lane, so require one.
    const laneTagged = (laneHtml.match(/<(?:div|img|video|audio)\b[^>]*>/g) || []).map(tag => ({
        id: tag.match(/\bid="([^"]*)"/)?.[1] || '(no id)',
        classes: (tag.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/),
        track: Number(tag.match(/(?<![\w-])data-track-index\s*=\s*"([^"]*)"/)?.[1]),
        start: Number(tag.match(/(?<![\w-])data-start\s*=\s*"([^"]*)"/)?.[1]),
        duration: Number(tag.match(/(?<![\w-])data-duration\s*=\s*"([^"]*)"/)?.[1]),
    }));
    const laneClips = (cls) => laneTagged
        .filter(c => c.classes.includes(cls)
            && Number.isFinite(c.track) && Number.isFinite(c.start) && Number.isFinite(c.duration))
        .sort((a, b) => a.start - b.start);
    const laneCaptions = laneClips('hf-caption');
    const laneTransitions = laneClips('hf-transition');
    // Guard the fixture itself: if these ever stop reproducing, the assertions below
    // go vacuum-true and silently stop protecting anything. If you deliberately fixed
    // buildCaptionCues to pad WITHOUT overrunning the next cue's start (a legitimate
    // improvement), these are the assertions that will go red — update the fixture to
    // reproduce the collision another way rather than deleting the guard.
    assert(laneCaptions.length >= 4, 'lane fixture stopped emitting caption cues — the regression guard is now vacuous');
    assert(laneTransitions.length === 2, `lane fixture emitted ${laneTransitions.length} overlay transitions, expected 2 — the regression guard is now vacuous`);
    assert(
        laneCaptions.some((c, i) => laneCaptions[i + 1] && c.start + c.duration - laneCaptions[i + 1].start > 1e-6),
        'lane fixture no longer produces the sub-0.4s caption pad overlap it exists to reproduce'
    );
    assert(
        laneTransitions[0].start + laneTransitions[0].duration - laneTransitions[1].start > 1e-6,
        'lane fixture no longer produces the centred-transition overlap it exists to reproduce'
    );
    // The lanes themselves. Integer is load-bearing: the CLI's readTrackValue() silently
    // rewrites a NON-integer to lane 0, which would merge these clips into an unrelated
    // overlap group instead of erroring.
    for (const [label, clips] of [['caption', laneCaptions], ['transition', laneTransitions]]) {
        assert(
            clips.every(c => Number.isInteger(c.track)),
            `${label} clips emitted a non-integer lane — the HyperFrames CLI silently collapses those to lane 0`
        );
        assert(
            new Set(clips.map(c => c.track)).size === clips.length,
            `two ${label} clips share a lane — overlapping ones would hard-fail the render via overlapping_clips_same_track`
        );
    }
    // Band separation, the property that makes it structural rather than lucky:
    // captions take the even offsets below -5e9 and transitions the odd ones, and both
    // sit below every lane the graphic-background floor can ever reach (that floor is
    // -100000 minus a JS array index, so it bottoms out above -4295068295).
    assert(
        laneCaptions.every(c => c.track <= -5000000000 && c.track % 2 === 0),
        'caption cues left their reserved even lane band — they can collide with another emitter again'
    );
    assert(
        laneTransitions.every(c => c.track <= -5000000001 && Math.abs(c.track % 2) === 1),
        'overlay transitions left their reserved odd lane band — they can collide with another emitter again'
    );
    // The reverse direction: nothing OUTSIDE those two families may enter their band.
    // Filter by FAMILY (class token), not by magnitude — a magnitude filter would drop
    // the very lanes it claims to inspect and end up guarding only the empty gap.
    const laneForeign = laneTagged.filter(c => Number.isFinite(c.track)
        && !c.classes.includes('hf-caption') && !c.classes.includes('hf-transition'));
    assert(laneForeign.length > 0, 'lane fixture emitted no non-caption/transition clips — the band-separation guard is now vacuous');
    assert(
        laneForeign.every(c => c.track > -5000000000),
        'a non-caption/non-transition clip entered the reserved caption/transition lane band'
    );

    console.log('[hyperframes-smoke] generated a valid project, timeline, and unique immediate regeneration');
    console.log('✅ HyperFrames bridge smoke passed');
} finally {
    const resolved = path.resolve(smokeRoot);
    const tempRoot = path.resolve(os.tmpdir());
    const safePrefix = tempRoot.endsWith(path.sep) ? tempRoot : tempRoot + path.sep;
    if (!resolved.startsWith(safePrefix) || !path.basename(resolved).startsWith('yta-hf-smoke-')) {
        throw new Error(`Refusing to clean unsafe smoke directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}
