#!/usr/bin/env node
'use strict';

/**
 * slop-lint.js — the permanent anti-AI-look gate.
 *
 * Generates a real HyperFrames project from a fixture plan and runs the
 * deterministic slop checker (src/render/hf-slop-lint.js) over the page the
 * engine actually ships. Zero AI, zero network, zero browser.
 *
 * The point of generating rather than reading the source template is that the
 * base stylesheet is assembled from several pieces at build time (background
 * packs, adaptive contrast, grain, font faces). Linting the source string would
 * check something no viewer ever sees.
 *
 * This gate is at ZERO for hard errors. It is not a report — a report you can
 * ignore is not a fix. Warnings are printed and do not block, because they need
 * human judgement by definition.
 *
 * Kill switch: HF_SLOP_LINT=0 (project convention — every subsystem has one).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { generateHyperframesProject } = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));
const { scanStyleText, slopLint, buildThemeContract } = require(path.join(ROOT, 'src', 'render', 'hf-slop-lint'));
const { getThemeTokens } = require(path.join(ROOT, 'src', 'data', 'themes'));

if (String(process.env.HF_SLOP_LINT || '').trim() === '0') {
    console.log('slop-lint: skipped (HF_SLOP_LINT=0)');
    process.exit(0);
}

function fail(message) {
    console.error(`\n  FAIL  ${message}`);
    process.exitCode = 1;
}

const lintRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-slop-lint-'));
const projectDir = path.join(lintRoot, 'project');

/**
 * A structurally complete plan that CARRIES GRAPHICS.
 *
 * A page ships styling from three different places, and they are NOT emitted on
 * the same condition:
 *
 *   1. the engine's own base stylesheet (hyperframes-bridge.js) — always;
 *   2. the graphic-shell layer (graphic-shells.js — surface / accent / geometry
 *      / hierarchy) via buildGraphicShellCss(), which takes no arguments and is
 *      called unconditionally, so it is on the page even with zero graphics;
 *   3. per-item authored-composition CSS — only exists when items exist.
 *
 * So the graphics here are NOT what pulls the shell layer in; layer 2 arrives
 * either way. They are here for layer 3, and because a fixture that never walks
 * the graphic path cannot catch a regression on it — the generator would happily
 * produce a page whose graphic emitters never ran, and the gate would pass by
 * describing something no viewer receives.
 *
 * The rule this encodes: a gate must lint the page a VIEWER gets, not the
 * smallest page the generator will agree to produce.
 *
 * Two graphics, deliberately of different types: shell selection is scored per
 * graphic from its own text, density and type, so a single specimen would pin
 * one recipe and hide the rest of the table.
 */
const plan = {
    audio: null,
    totalDuration: 4,
    fps: 30,
    width: 1920,
    height: 1080,
    subtitlesEnabled: false,
    scriptContext: { title: 'slop lint fixture', themeId: 'standard' },
    scenes: [
        {
            index: 0,
            sourceSceneIndex: 0,
            clipId: 'clip-slop-a',
            startTime: 0,
            endTime: 2,
            duration: 2,
            text: 'Slop lint fixture scene',
            trackId: 'video-track-1',
        },
        {
            index: 1,
            sourceSceneIndex: 1,
            clipId: 'clip-slop-b',
            startTime: 2,
            endTime: 4,
            duration: 2,
            text: 'Slop lint fixture scene two',
            trackId: 'video-track-1',
        },
    ],
    motionGraphics: [
        {
            id: 'slop-mg-a',
            clipId: 'slop-mg-a',
            type: 'lowerThird',
            subType: 'bar',
            text: 'Slop lint fixture graphic',
            subtext: 'Forces the graphic-shell stylesheet onto the page',
            sceneIndex: 0,
            startTime: 0.1,
            endTime: 1.9,
        },
        {
            id: 'slop-mg-b',
            clipId: 'slop-mg-b',
            type: 'callout',
            subType: 'standard',
            text: 'A second graphic so shell selection is exercised',
            subtext: 'Different type, different shell signals',
            sceneIndex: 1,
            startTime: 2.1,
            endTime: 3.9,
        },
    ],
    mgScenes: [],
    templateScenes: [],
    overlayScenes: [],
    transitions: [],
    sfxClips: [],
};

let indexPath = null;
try {
    for (const name of ['temp', 'public', 'input']) {
        fs.mkdirSync(path.join(projectDir, name), { recursive: true });
    }

    const result = generateHyperframesProject({
        plan,
        projectDir,
        appRoot: ROOT,
        tempDir: path.join(projectDir, 'temp'),
        publicDir: path.join(projectDir, 'public'),
        inputDir: path.join(projectDir, 'input'),
        outputRoot: path.join(projectDir, 'hyperframes'),
    });

    if (!result || result.success !== true || !result.indexPath || !fs.existsSync(result.indexPath)) {
        fail('could not generate a HyperFrames page to lint');
    } else {
        indexPath = result.indexPath;
    }
} catch (err) {
    fail(`generator threw: ${err && err.message ? err.message : err}`);
}

if (indexPath) {
    const html = fs.readFileSync(indexPath, 'utf8');
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);

    if (!styles.length) {
        fail('generated page contained no <style> block — the lint would pass vacuously');
    }

    const findings = [];
    for (const css of styles) findings.push(...(scanStyleText(css).findings || []));

    const errors = findings.filter(f => f.severity === 'error');
    const warns = findings.filter(f => f.severity === 'warn');

    const byRule = {};
    for (const f of findings) byRule[f.id] = (byRule[f.id] || 0) + 1;

    if (warns.length) {
        console.log(`slop-lint: ${warns.length} warning(s) (advisory, not blocking)`);
        for (const w of warns.slice(0, 24)) {
            console.log(`    ~ ${w.id} [line ${w.line}] ${w.snippet}`);
        }
    }

    if (errors.length) {
        console.error(`\nslop-lint: ${errors.length} hard finding(s) in the page the engine ships.`);
        console.error('These are the patterns that make generated design look generated.');
        console.error('Fix the CSS in src/render/hyperframes-bridge.js — do not soften the rule.\n');
        for (const e of errors) {
            console.error(`    x ${e.id} [line ${e.line}] ${e.snippet}`);
            console.error(`      ${e.why}${e.hint ? `. ${e.hint}` : ''}`);
        }
        fail(`${errors.length} slop finding(s); expected 0`);
    } else {
        console.log(`slop-lint: OK — 0 hard findings across ${styles.length} style block(s)`);
        if (Object.keys(byRule).length) console.log(`    advisory counts: ${JSON.stringify(byRule)}`);
    }
}

try {
    fs.rmSync(lintRoot, { recursive: true, force: true });
} catch { /* temp dir cleanup is best-effort */ }

// ── Theme contract ─────────────────────────────────────────────────────────
//
// The three contract rules are INERT above. That is correct — the engine's
// base stylesheet is theme-agnostic by design, it spends var(--hf-*) rather
// than literals, and there is no single theme to hold it to.
//
// Which means the section above proves nothing about them. If all three rules
// were deleted tomorrow, everything above would still print OK. So they get
// their own proof, run against the eight REAL themes rather than a mock: a
// mock theme would let the contract pass while the actual shipped themes
// declare something it cannot parse.
//
// Three properties, each of which has a specific way of silently breaking:
//   1. it CATCHES drift            — otherwise the gate is decoration
//   2. it PASSES a theme's own CSS — otherwise it blocks every good comp and
//                                    someone disables it within a week
//   3. it goes QUIET without a theme — otherwise it starts failing the engine
//                                    stylesheet in the section above

const THEME_IDS = ['standard', 'crime', 'history', 'modern', 'minimal', 'warm-editorial', 'luxury', 'nature'];
const CONTRACT_RULES = ['off-theme-font', 'off-theme-color', 'off-theme-radius'];

/** A composition that drifts on all three axes at once, on any theme. */
const DRIFTING_CSS = `
.ns-card { font-family: Inter, sans-serif; background: #6366f1; border-radius: 28px; }
.ns-badge { font: 700 32px/1.2 Georgia, serif; color: #22d3ee; }
`;

function contractHits(css, theme) {
    const res = slopLint({ css, html: '', timeline: '' }, { theme });
    return res.findings.filter(f => CONTRACT_RULES.includes(f.id));
}

let contractOk = true;
const contractNotes = [];

for (const themeId of THEME_IDS) {
    const theme = getThemeTokens(themeId);
    if (!theme) { fail(`theme "${themeId}" no longer resolves — the contract has nothing to enforce`); contractOk = false; continue; }

    const k = buildThemeContract(theme);
    if (!k || !k.fonts.size || !k.hues.length || !k.radii.length) {
        fail(`theme "${themeId}" yields an empty contract (fonts ${k ? k.fonts.size : 0}, hues ${k ? k.hues.length : 0}, radii ${k ? k.radii.length : 0}) — a contract that declares nothing permits everything`);
        contractOk = false;
        continue;
    }

    // 1. Drift is caught, on every axis.
    const caught = new Set(contractHits(DRIFTING_CSS, theme).map(f => f.id));
    const missed = CONTRACT_RULES.filter(id => !caught.has(id));
    if (missed.length) {
        fail(`theme "${themeId}": drifting composition slipped past ${missed.join(', ')}`);
        contractOk = false;
    }

    // 2. A composition written FROM the theme's own declared values passes.
    //    Includes the shapes the contract must never object to: a circle, a
    //    pill, a square corner, and a near-black scrim.
    const compliantCss = `
.ns-card { font-family: var(--hf-heading-font); background: var(--hf-surface); border-radius: var(--hf-radius); }
.ns-note { font-family: ${theme.typography.bodyFont}; color: ${theme.colors.textPrimary}; border-radius: ${k.radii[0]}px; }
.ns-rule { background: ${theme.colors.accent}; border-radius: 50%; }
.ns-plate { background: rgba(2,6,23,0.72); border-radius: 0; }
.ns-pill { border-radius: 999px; }
`;
    const falsePositives = contractHits(compliantCss, theme);
    if (falsePositives.length) {
        fail(`theme "${themeId}": the theme's OWN values were flagged — ${falsePositives.map(f => `${f.id} (${f.snippet})`).join('; ')}`);
        contractOk = false;
    }

    // 3. The radius rule is directional. Squarer than the theme is an
    //    editorial choice the author makes constantly and correctly; rounder
    //    than the theme is the squircle drift. Getting this backwards would
    //    teach the author to soften every corner — the exact opposite of the
    //    point — and every comp would still pass, so nothing else would catch it.
    const harder = contractHits(`.ns-a { border-radius: 2px; }`, theme).filter(f => f.id === 'off-theme-radius');
    if (harder.length) {
        fail(`theme "${themeId}": a 2px radius was flagged — the rule must only object to corners ROUNDER than the theme`);
        contractOk = false;
    }
    const rounder = contractHits(`.ns-a { border-radius: ${Math.max(...k.radii) + 40}px; }`, theme).filter(f => f.id === 'off-theme-radius');
    if (!rounder.length) {
        fail(`theme "${themeId}": a radius ${Math.max(...k.radii) + 40}px well over the theme's ${Math.max(...k.radii)}px was not flagged`);
        contractOk = false;
    }

    contractNotes.push(`${themeId}: ${k.fonts.size} face(s), ${k.hues.length} hue(s), radius ${k.radii[0]}px`);
}

// 4. Inert without a theme — this is what lets the section above lint the
//    engine's theme-agnostic stylesheet with the very same function.
const noTheme = contractHits(DRIFTING_CSS, null);
if (noTheme.length) {
    fail(`the contract rules fired with no theme supplied (${noTheme.map(f => f.id).join(', ')}) — they must be inert, or the engine stylesheet check above becomes meaningless`);
    contractOk = false;
}

if (contractOk) {
    console.log(`slop-lint: theme contract OK — ${THEME_IDS.length} themes enforce fonts + palette + radius`);
    for (const n of contractNotes) console.log(`    · ${n}`);
}

// ── Surviving the codec ────────────────────────────────────────────────────
//
// Three rules about what YouTube's encoder does to a frame after it leaves
// here. They are inert on the engine stylesheet above for the same reason the
// contract rules are — it declares var(--hf-*), not literals — so they need
// their own proof, and it has to run in both directions.
//
// A rule that fires on a bad fixture proves only that it fires. The failure
// that actually costs something is the opposite one: a contrast or stroke rule
// tuned tight enough to flag ordinary good typography gets switched off within
// a week and then protects nothing. So every rule below is required to be
// silent on a fixture built the right way, and — for contrast — on the eight
// real themes' own text-on-background pairs.

const CODEC_RULES = ['low-contrast-on-video', 'hairline-weight', 'video-unsafe-saturation'];
let codecOk = true;
const codecNotes = [];

function codecHits(css, ids) {
    const res = slopLint({ css, html: '', timeline: '' }, {});
    const want = ids || CODEC_RULES;
    return res.findings.filter(f => want.includes(f.id));
}

function expectFires(label, css, ruleId) {
    const hits = codecHits(css, [ruleId]);
    if (!hits.length) {
        fail(`${ruleId} stayed silent on ${label} — the rule is decoration`);
        codecOk = false;
        return null;
    }
    codecNotes.push(`${ruleId} fires on ${label}: ${hits[0].snippet}`);
    return hits[0];
}

function expectSilent(label, css, ruleId) {
    const hits = codecHits(css, [ruleId]);
    if (hits.length) {
        fail(`${ruleId} flagged ${label} — ${hits.map(h => h.snippet).join('; ')}`);
        codecOk = false;
        return false;
    }
    codecNotes.push(`${ruleId} stays quiet on ${label}`);
    return true;
}

// 1. Contrast. Grey-on-grey body copy is the classic way to lose text to the
//    encoder; white on near-black is the way to keep it.
expectFires('grey body copy on a grey panel',
    `.ns-a { font-size: 30px; color: #8a8a8a; background-color: #6f6f6f; }`,
    'low-contrast-on-video');
expectSilent('white body copy on a near-black panel',
    `.ns-a { font-size: 30px; color: #ffffff; background-color: #101418; }`,
    'low-contrast-on-video');

// The large-text carve-out has to be real in BOTH directions, or it is either
// a loophole that lets weak headlines through or a second body-copy rule.
const CARVE_OUT = `color: #7a7a7a; background-color: #2b2b2b;`;   // ~3.5:1
expectSilent('a 96px headline at 3.5:1 (over the 3.0 display floor)',
    `.ns-a { font-size: 96px; ${CARVE_OUT} }`, 'low-contrast-on-video');
expectFires('the SAME colours at 26px (under the 4.5 body floor)',
    `.ns-a { font-size: 26px; ${CARVE_OUT} }`, 'low-contrast-on-video');

// Blocks that declare a colour but no background depend on an ancestor this
// parser cannot see. Guessing there would invent findings on almost every
// composition, so the rule must decline to judge.
expectSilent('a block with a text colour but no background of its own',
    `.ns-a { font-size: 24px; color: #909090; }`, 'low-contrast-on-video');
expectSilent('text over a fully transparent background (it is sitting on footage)',
    `.ns-a { font-size: 24px; color: #909090; background-color: rgba(0,0,0,0); }`,
    'low-contrast-on-video');

// A translucent panel is the case worth getting right: on a web page the
// backdrop is known, here it is whatever the clip happens to be.
expectFires('pale text on a panel at 25% opacity (the footage shows through)',
    `.ns-a { font-size: 28px; color: #cfcfcf; background-color: rgba(255,255,255,0.25); }`,
    'low-contrast-on-video');

// The eight real themes must pass their own primary text on their own
// background. If one does not, that is a finding about the theme, not a
// tuning problem — and it should stop the gate rather than be smoothed over.
for (const themeId of THEME_IDS) {
    const theme = getThemeTokens(themeId);
    if (!theme) continue;
    const css = `.ns-a { font-size: 30px; color: ${theme.colors.textPrimary}; background-color: ${theme.colors.background}; }`;
    const hits = codecHits(css, ['low-contrast-on-video']);
    if (hits.length) {
        fail(`theme "${themeId}" fails its own body-contrast floor — ${hits[0].snippet}`);
        codecOk = false;
    }
}

// 2. Stroke survival. The measure is size x weight, so the same weight has to
//    be fine on a headline and fatal on a caption — that is the whole point of
//    not writing "weight <= 200".
expectFires('24px at weight 200 (draws like 12px regular)',
    `.ns-a { font-size: 24px; font-weight: 200; }`, 'hairline-weight');
expectSilent('110px at weight 200 (draws like 55px regular — good display typography)',
    `.ns-a { font-size: 110px; font-weight: 200; }`, 'hairline-weight');
expectSilent('28px at weight 500',
    `.ns-a { font-size: 28px; font-weight: 500; }`, 'hairline-weight');
expectSilent('a thin weight with no size in the block (size is inherited, so it is unknowable)',
    `.ns-a { font-weight: 200; }`, 'hairline-weight');

// 3. Chroma subsampling. Scoped to fine detail on purpose — the identical
//    colour as a large fill is safe, and a rule that flagged both would be
//    telling the author never to use red.
expectFires('saturated magenta as text',
    `.ns-a { color: #ff00aa; }`, 'video-unsafe-saturation');
expectFires('saturated red as a 1px hairline',
    `.ns-a { border: 1px solid #ff0022; }`, 'video-unsafe-saturation');
expectSilent('the same magenta as a full panel fill',
    `.ns-a { background-color: #ff00aa; }`, 'video-unsafe-saturation');
expectSilent('the same red as a 6px bar',
    `.ns-a { border-left: 6px solid #ff0022; }`, 'video-unsafe-saturation');
expectSilent('a muted brick red as text',
    `.ns-a { color: #a35c52; }`, 'video-unsafe-saturation');
expectSilent('saturated teal as text (nowhere near the red/magenta band)',
    `.ns-a { color: #00c8b4; }`, 'video-unsafe-saturation');

// 3b. The palette exemption, measured against the two themes that actually
//     anchor a hue inside the risky band. Without it the rule would argue with
//     a deliberate brand decision on every graphic that used the theme colour;
//     with it made too broad, it would stop catching anything at all — so both
//     directions are asserted on the same theme.
for (const [themeId, own, invented] of [['crime', '#dc143c', '#ff00aa'], ['modern', '#ff4500', '#ff0066']]) {
    const theme = getThemeTokens(themeId);
    const ownHits = slopLint({ css: `.ns-a { color: ${own}; }`, html: '', timeline: '' }, { theme })
        .findings.filter(f => f.id === 'video-unsafe-saturation');
    if (ownHits.length) {
        fail(`video-unsafe-saturation flagged ${themeId}'s own anchor colour ${own} — the rule must not argue with the theme`);
        codecOk = false;
    }
    const inventedHits = slopLint({ css: `.ns-a { color: ${invented}; }`, html: '', timeline: '' }, { theme })
        .findings.filter(f => f.id === 'video-unsafe-saturation');
    if (!inventedHits.length) {
        fail(`video-unsafe-saturation missed the off-palette ${invented} under theme ${themeId} — the exemption has swallowed the rule`);
        codecOk = false;
    }
    if (!ownHits.length && inventedHits.length) {
        codecNotes.push(`video-unsafe-saturation permits ${themeId}'s own ${own} but still catches an invented ${invented}`);
    }
}

// 4. All three must be exercised, or a rule could be deleted and this section
//    would still print OK.
const exercised = new Set(codecNotes.map(n => n.split(' ')[0]));
for (const id of CODEC_RULES) {
    if (!exercised.has(id)) { fail(`${id} was never exercised by this section`); codecOk = false; }
}

if (codecOk) {
    console.log(`slop-lint: codec survival OK — ${CODEC_RULES.length} rules fire on unsafe values, stay quiet on safe ones and on all ${THEME_IDS.length} themes' own text`);
    for (const n of codecNotes) console.log(`    · ${n}`);
}

// ── Wash vs paper (off-theme-surface) ──────────────────────────────────────
//
// The rule that closed the loophole this gate had from the day it shipped:
// off-theme-color skips any literal under MIN_TEST_CHROMA, on the grounds that
// a low-chroma literal is a scrim or a hairline rather than a design decision.
// True for a hairline. Catastrophically false for a SURFACE — it meant a card
// painted the wrong colour was caught while a card painted flat neutral slate,
// the single most machine-made-looking surface there is, was waved through.
// Every built-in fullscreen card in the engine sat in that blind spot.
//
// Unlike the contract rules this one is live on the engine stylesheet above, so
// it is not "inert and therefore unproven". What is unproven up there is the
// part that makes it usable: the WASH/PAPER discriminator. Full-bleed shades
// that let footage through are legitimate and must stay neutral; if they were
// flagged, the only way to a green gate would be tinting every scrim, which
// would wreck the footage the whole product exists to show. So the rule is
// required to be silent on four separate shapes of legitimate wash, and the
// same fixture is then MUTATED into paper to prove the silence is discrimination
// rather than a rule that simply never fires on anything full-bleed.

const { resolveColor, colorTokenOf } = require(path.join(ROOT, 'src', 'render', 'hf-slop-lint'));

let surfaceOk = true;
const surfaceNotes = [];

function surfaceHits(css) {
    return slopLint({ css, html: '', timeline: '' }, {})
        .findings.filter(f => f.id === 'off-theme-surface');
}

function surfaceFires(label, css) {
    const hits = surfaceHits(css);
    if (!hits.length) {
        fail(`off-theme-surface stayed silent on ${label} — the rule is decoration`);
        surfaceOk = false;
        return;
    }
    surfaceNotes.push(`fires on ${label}`);
}

function surfaceSilent(label, css) {
    const hits = surfaceHits(css);
    if (hits.length) {
        fail(`off-theme-surface flagged ${label} — ${hits.map(h => h.snippet).join('; ')}`);
        surfaceOk = false;
        return;
    }
    surfaceNotes.push(`stays quiet on ${label}`);
}

// 1. The core judgement, both ways.
surfaceFires('a bounded card painted a fixed slate',
    `.ns-card { background: #0f172a; border-radius: 12px; padding: 24px; }`);
surfaceSilent('the same card painted from the theme',
    `.ns-card { background: color-mix(in srgb, var(--hf-surface), transparent 12%); border-radius: 12px; padding: 24px; }`);

// 2. Wash vs paper. Same colour, same full-bleed box — the ONLY difference is
//    whether footage can get through and whether the box builds a layout. Both
//    directions matter: a rule that flagged the scrim would force every shade in
//    the engine to be tinted, and a rule that skipped the slab would be back to
//    waving through exactly the surfaces it was written for.
const BLEED = 'position: absolute; inset: 0;';
surfaceSilent('a full-bleed scrim with a transparent stop (the footage reads through it)',
    `.ns-scrim { ${BLEED} background: linear-gradient(90deg, rgba(2,6,23,0.72), transparent); }`);
surfaceFires('a full-bleed OPAQUE slab in the same place (nothing shows through — that is paint)',
    `.ns-slab { ${BLEED} background: #0f172a; }`);

// 3. Padding is deliberately NOT structure. A full-bleed scrim routinely pads
//    its caption off the frame edge, and counting that as "builds a layout"
//    false-positived the engine's own bottom-up gradient. A gap is different:
//    it spaces CHILDREN, which is a thing only paper does. Asserting both on one
//    fixture is what stops the next person from folding padding back in.
const SCRIM_GRADIENT = 'background: linear-gradient(to top, rgba(2,6,23,0.86), transparent);';
surfaceSilent('a full-bleed scrim that merely pads its caption off the frame edge',
    `.ns-pad { ${BLEED} padding: 0 0 120px; ${SCRIM_GRADIENT} }`);
surfaceFires('the SAME scrim once it lays out children with a grid gap (now it is paper)',
    `.ns-paper { ${BLEED} display: grid; gap: 28px; ${SCRIM_GRADIENT} }`);

// 4. Full-bleed is a property of the ELEMENT, but CSS spreads one element across
//    many rules. Judging each rule alone made every modifier class look like a
//    bounded box — that is how a 30% wash over footage got reported as a card.
surfaceSilent('a wash whose inset lives on the base class and whose paint lives on a modifier',
    `.ns-shade { ${BLEED} }\n.ns-shade.ns-blur { background: linear-gradient(90deg, rgba(2,6,23,0.7), transparent); }`);
surfaceSilent('a wash whose inset was declared in a comma-separated selector list',
    `.ns-p, .ns-q { ${BLEED} }\n.ns-wrap .ns-p { padding-bottom: 120px; ${SCRIM_GRADIENT} }`);

// 5. A value is not off-theme just because it contains a literal — `color-mix(…
//    var(--hf-bg), #000 14%)` spends one as a darkening AMOUNT. But treating
//    "mentions a theme var" as a blanket pass let a real one through: the split
//    comparison divider was themed at both ends and slate in the middle, which
//    is precisely the seam the eye lands on. Both halves of that distinction.
surfaceSilent('a literal used as a darkening amount inside color-mix',
    `.ns-tint { background: color-mix(in srgb, var(--hf-bg), #000 14%); }`);
surfaceFires('a literal standing on its own as a gradient stop between two theme tokens',
    `.ns-gutter { background: linear-gradient(90deg, var(--hf-primary), #1e293b, var(--hf-accent)); }`);

// 6. Two exemptions that are about what the element IS, not how it is painted.
surfaceSilent('the letterbox void behind a contained clip (object-fit means it is a media element)',
    `.ns-media { object-fit: contain; background: #050505; }`);
surfaceSilent('the composition root itself (there is nothing layered behind the video frame)',
    `#yta-hyperframes { background: #050505; }`);
surfaceSilent('a film-stock effect layer (its colour IS the effect)',
    `.hf-fx-bleach-bypass { background: #101820; }`);

if (surfaceOk) {
    console.log('slop-lint: surface theming OK — off-theme-surface separates washes from paper');
    for (const n of surfaceNotes) console.log(`    · ${n}`);
}

// ── color-mix() resolution ─────────────────────────────────────────────────
//
// Found while chasing what looked like a contrast bug and turned out to be the
// checker lying: it reported white-on-#b9c2cc at 1.8:1 for a caption plate that
// actually measures about 18:1. Two stacked faults, and either alone is enough
// to blind the colour rules across the whole sheet, because color-mix() is the
// syntax nearly every themed surface in the engine is now written in.
//
//   a) resolveColor had no color-mix branch, so the var() scan grabbed whichever
//      theme slot the mix happened to name and reported THAT as the colour. A
//      near-black matte mixed 10% toward the primary was read as the primary at
//      full strength.
//   b) colorTokenOf tested var() before the function pattern — and its function
//      pattern was not bracket-balanced, so a nested mix was chopped at the
//      first `)`.
//
// A checker that mis-reads its own stylesheet's dominant syntax is not checking
// those surfaces at all, and it fails SILENTLY — it keeps printing findings, they
// are just about colours nothing on screen is painted. Hence explicit assertions
// on the resolver rather than on a rule's verdict.

let mixOk = true;
const mixNotes = [];
const mixCtx = { vars: new Map([['--hf-primary', '#b9c2cc'], ['--hf-bg', '#0e0e10']]) };

function expectMix(label, value, check) {
    const got = resolveColor(value, mixCtx);
    const problem = check(got);
    if (problem) {
        fail(`color-mix resolution wrong for ${label} — ${problem}`);
        mixOk = false;
        return;
    }
    mixNotes.push(`${label} → rgb(${Math.round(got.color.r)},${Math.round(got.color.g)},${Math.round(got.color.b)}) @ ${got.color.a.toFixed(2)}`);
}

// The exact shape that caused the false report. 10% toward a light grey leaves
// a near-black plate; reading it as the grey is the bug.
expectMix('a near-black plate mixed 10% toward the primary',
    'color-mix(in srgb, #000000, var(--hf-primary) 10%)',
    r => {
        if (!r || !r.color) return 'did not resolve at all';
        if (r.color.r > 60) return `resolved to rgb(${Math.round(r.color.r)},…) — that is the primary at full strength, the mix was discarded`;
        return null;
    });

// Nesting: the caption plate's real value. The inner mix must survive being an
// argument, and the outer `transparent` share must land as alpha, not as black.
expectMix('the caption plate — a mix inside a mix, then 36% toward transparent',
    'color-mix(in srgb, color-mix(in srgb, #000000, var(--hf-primary) 10%), transparent 36%)',
    r => {
        if (!r || !r.color) return 'did not resolve at all';
        if (r.color.r > 60) return `resolved to rgb(${Math.round(r.color.r)},…) — the inner mix was lost`;
        if (Math.abs(r.color.a - 0.64) > 0.02) return `alpha ${r.color.a.toFixed(2)}, expected about 0.64`;
        return null;
    });

// Weights are read, not assumed. 90% toward red must come out red — a resolver
// that silently returned the first argument would pass every test above, since
// both of those start from black.
expectMix('90% toward red (proves the weight is read, not the first argument returned)',
    'color-mix(in srgb, #000000, #ff0000 90%)',
    r => {
        if (!r || !r.color) return 'did not resolve at all';
        if (r.color.r < 200) return `red channel ${Math.round(r.color.r)} — the weight was ignored`;
        return null;
    });

// The tokenizer must hand the resolver a BALANCED construct. Chopping at the
// first `)` yields a string that parses as something else entirely.
const nested = 'color-mix(in srgb, color-mix(in srgb, #000000, var(--hf-primary) 10%), transparent 36%)';
const token = colorTokenOf(nested);
if (!token || !/^color-mix\s*\(/i.test(token)) {
    fail(`colorTokenOf returned ${JSON.stringify(token)} for a nested color-mix — it must return the whole construct, not the inner var()`);
    mixOk = false;
} else if ((token.match(/\(/g) || []).length !== (token.match(/\)/g) || []).length) {
    fail(`colorTokenOf returned an unbalanced token ${JSON.stringify(token)} — it closed on the first ')' instead of the matching one`);
    mixOk = false;
} else {
    mixNotes.push('colorTokenOf returns the whole balanced construct for a nested mix');
}

// And the end-to-end proof: the contrast rule must now read that plate correctly.
// This is the assertion that would have caught the original false report.
const plateCss = `:root { --hf-primary: #b9c2cc; }
.ns-cap { font-size: 30px; color: #ffffff; background-color: color-mix(in srgb, #000000, var(--hf-primary) 10%); }`;
const plateHits = slopLint({ css: plateCss, html: '', timeline: '' }, {})
    .findings.filter(f => f.id === 'low-contrast-on-video');
if (plateHits.length) {
    fail(`low-contrast-on-video still misreads a near-black caption plate — ${plateHits[0].snippet}`);
    mixOk = false;
} else {
    mixNotes.push('low-contrast-on-video no longer misreports white on a near-black themed plate');
}

if (mixOk) {
    console.log('slop-lint: color-mix resolution OK — nested mixes and weights are evaluated, not guessed');
    for (const n of mixNotes) console.log(`    · ${n}`);
}
