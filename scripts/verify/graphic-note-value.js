#!/usr/bin/env node
'use strict';

/**
 * GATE: the small line under a headline has to earn its place on screen.
 *
 * Two defects, both taken from a real shipped video:
 *
 *   1. RESTATEMENT. Headline "Earth Tube COP 28 vs Conventional AC COP 3",
 *      note underneath it "28 versus 3." Same two numbers, same comparison,
 *      said twice. Half the card carried zero information.
 *   2. LIFTED NARRATION. A note that opened with "and in Holmes County, Ohio
 *      right where those Amish farms sit, …" — a clause cut out of the middle
 *      of the voiceover, conjunction and all. Nobody writes a screen line that
 *      way; it is the clearest possible sign the copy was never authored for
 *      the eye.
 *
 * The rule pinned here: a note is dropped only when it adds NOTHING — no
 * number and no word the headline did not already carry. Anything with one new
 * figure, place or name survives untouched. And a lifted clause loses its
 * leading conjunction so it reads as a written line.
 *
 * Both directions are tested. A gate that only checked "the note disappeared"
 * would be satisfied by a renderer that had stopped drawing notes at all, and
 * that would be a far worse video than the one this fixes.
 *
 * The raw/display split is tested too: item lists are parsed out of the same
 * subtext field, so silencing it as DISPLAY copy must never cost the graphic
 * its STRUCTURE.
 *
 * Kill switch: HF_NOTE_VALUE_VERIFY=0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

if (/^(0|false|off|no)$/i.test(String(process.env.HF_NOTE_VALUE_VERIFY || '').trim())) {
    console.log('graphic-note-value: SKIPPED (HF_NOTE_VALUE_VERIFY=0)');
    process.exit(0);
}

const { generateHyperframesProject } = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));

const failures = [];
let checks = 0;

function check(ok, message) {
    checks++;
    if (!ok) failures.push(message);
}

const roots = [];

/** Push one plan through the real bridge and hand back the generated HTML. */
function renderPlan(mgScenes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-hf-note-'));
    roots.push(root);
    const projectDir = path.join(root, 'project');
    for (const name of ['temp', 'public', 'input']) {
        fs.mkdirSync(path.join(projectDir, name), { recursive: true });
    }
    const plan = {
        audio: null,
        subtitlesEnabled: false,
        totalDuration: 6,
        fps: 30,
        width: 1920,
        height: 1080,
        scenes: [{
            index: 0,
            sourceSceneIndex: 0,
            clipId: 'clip-note',
            startTime: 0,
            endTime: 6,
            duration: 6,
            text: 'Underlying footage scene',
            mediaType: 'color',
            kenBurnsEnabled: false,
            framing: 'cinematic',
            trackId: 'video-track-1',
        }],
        mgScenes,
        motionGraphics: [],
        templateScenes: [],
        transitions: [],
        sfxClips: [],
        scriptContext: { title: 'Note value', themeId: 'standard' },
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
    if (!result || result.success !== true || !fs.existsSync(result.indexPath)) {
        throw new Error('bridge did not produce an index.html for the note fixture');
    }
    return fs.readFileSync(result.indexPath, 'utf8');
}

function mg(extra) {
    return {
        type: 'comparisonCard',
        startTime: 1,
        endTime: 5,
        duration: 4,
        trackId: 'video-track-3',
        ...extra,
    };
}

try {
    // ── 1. The exact restatement that shipped ─────────────────────────────
    {
        const html = renderPlan([mg({
            text: 'Earth Tube COP 28 vs Conventional AC COP 3',
            subtext: '28 versus 3.',
        })]);
        check(!/28 versus 3/.test(html),
            'the note that only repeats the headline\'s own numbers is on screen again');
        check(/Earth Tube COP 28/.test(html) && /Conventional AC COP 3/.test(html),
            'silencing the note also cost the card the headline it was under');
    }

    // ── 2. A note that adds real information must SURVIVE ─────────────────
    // Without this, "drop notes that repeat" could be satisfied by dropping
    // every note, which would strip the cards of their only supporting line.
    {
        const html = renderPlan([mg({
            text: 'Holmes County Ground Temp vs Surface Temp',
            subtext: 'and in Holmes County, Ohio the soil stays between 54 and 56 degrees all year.',
        })]);
        check(/54 and 56 degrees/.test(html),
            'a note carrying figures the headline never mentioned was thrown away');
        check(!/>\s*and in Holmes County/i.test(html),
            'the note still opens with the conjunction it was cut out of the narration with');
        check(/In Holmes County/.test(html),
            'stripping the leading conjunction mangled the rest of the sentence');
    }

    // ── 3. New words count as new information, not just new numbers ───────
    {
        const html = renderPlan([mg({
            type: 'factCard',
            text: 'Solar output',
            subtext: 'Measured at the Nevada test site.',
        })]);
        check(/Measured at the Nevada test site/.test(html),
            'a note whose words are all new to the headline was dropped');
    }

    // ── 4. A word-for-word echo of the headline goes — in EVERY slot ──────
    // The echo used to survive by changing clothes: silenced as a note, it came
    // straight back as a one-row "list", because a fact card parses its items
    // out of the same sentence when it has no real ones.
    {
        const html = renderPlan([mg({
            type: 'factCard',
            text: 'Cooling costs fell 40%',
            subtext: 'Cooling costs fell 40%.',
        })]);
        check(/class="hf-title">Cooling costs fell 40%</.test(html),
            'the card lost the headline it is supposed to state');
        check(!/class="hf-subtitle">Cooling costs fell 40%/.test(html),
            'the headline is repeated word-for-word as the note underneath it');
        check(!/class="hf-item-label">Cooling costs fell 40%/.test(html),
            'the repeated line came back as a one-row list instead of a note');
    }

    // ── 5. Silencing DISPLAY copy must not cost the graphic its STRUCTURE ─
    // Item lists are parsed out of the same subtext field. A card whose note
    // adds nothing must still render every item that note contained.
    {
        const html = renderPlan([mg({
            type: 'listicleGrid',
            text: 'Alpha Beta Charlie',
            subtext: 'Alpha; Beta; Charlie',
        })]);
        for (const item of ['Alpha', 'Beta', 'Charlie']) {
            check(html.includes(item),
                `the item "${item}" vanished when its source line was silenced as display copy`);
        }
    }

    // ── 6. Source anchors: the raw/display split must stay wired ──────────
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'render', 'hyperframes-bridge.js'), 'utf8');
    const bridgeCode = bridgeSrc
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
        .join('\n');

    const wired = (bridgeCode.match(/visualNote\(rawSubtext, text\)/g) || []).length;
    check(wired === 3,
        `every place the renderer derives display copy must run it through visualNote — found ${wired} of 3`);

    check(!/parseItemsFromText\(subtext \|\| text\)/.test(bridgeCode),
        'an item list is being parsed out of the DISPLAY note again instead of the raw field');
    check(!/renderTemplateFallbackBg\(id, type, text \|\| subtext\)/.test(bridgeCode),
        'the fallback background label reads the DISPLAY note again instead of the raw field');
} catch (err) {
    failures.push(`fixture crashed: ${err && err.message ? err.message : err}`);
} finally {
    for (const root of roots) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
}

if (failures.length) {
    console.error(`graphic-note-value: FAILED (${failures.length}/${checks})`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log(`graphic-note-value: OK (${checks} checks)`);
