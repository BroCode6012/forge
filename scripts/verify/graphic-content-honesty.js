#!/usr/bin/env node
'use strict';

/**
 * GATE: a fixed-renderer graphic may only draw what it was actually given.
 *
 * The renderer used to invent content whenever the copy did not fit the
 * structure it had been asked for. The worst case shipped in a real video: a
 * comparison brief whose headline named nothing to compare still painted a
 * full-screen split reading "Option A" — VS — "Option B". Nobody wrote those
 * words, nobody reviewed them, and they filled the frame with zero information.
 * The same reflex produced "Item 3" labels, a "Map data" chip on an empty map,
 * and a card whose only headline was its own machine name ("comparison-card").
 *
 * The rule this gate pins: DEGRADE THE STRUCTURE, NEVER INVENT THE CONTENT.
 * A comparison with fewer than two real sides is not a comparison — it becomes
 * a plain statement of the copy it does have. A graphic with no copy at all
 * paints nothing rather than a decorated box around a placeholder.
 *
 * Both directions are tested, because a gate that only checks the negative
 * would be satisfied by a renderer that had stopped drawing comparisons
 * altogether. Real two-sided comparisons must still render as comparisons.
 *
 * This is behavioural: every case is a real plan pushed through the real
 * bridge, and the assertions read the HTML it generated. Source-text anchors
 * are checked too, but only for the things HTML cannot show (that the honest
 * `ok` answer exists and that no placeholder literal survives anywhere).
 *
 * Kill switch: HF_GRAPHIC_HONESTY_VERIFY=0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

if (/^(0|false|off|no)$/i.test(String(process.env.HF_GRAPHIC_HONESTY_VERIFY || '').trim())) {
    console.log('graphic-content-honesty: SKIPPED (HF_GRAPHIC_HONESTY_VERIFY=0)');
    process.exit(0);
}

const { generateHyperframesProject } = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));

// Match the MARKUP, not the stylesheet: every generated page carries the full
// CSS, so a bare /hf-compare-side/ would match `.hf-compare-side { … }` and
// report a VS split on a page that never drew one.
const HAS_VS_SPLIT = /class="hf-compare-side"/;

const failures = [];
let checks = 0;

function check(ok, message) {
    checks++;
    if (!ok) failures.push(message);
}

const roots = [];

/**
 * Push one plan through the real bridge and hand back the generated HTML.
 * A 6s footage scene sits underneath so a suppressed graphic can never be
 * mistaken for a hole in the video — that is the whole reason suppression is
 * safe here rather than dropping the graphic from the timeline.
 */
function renderPlan(mgScenes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-hf-honesty-'));
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
            clipId: 'clip-honesty',
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
        scriptContext: { title: 'Content honesty', themeId: 'standard' },
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
        throw new Error('bridge did not produce an index.html for the honesty fixture');
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

const allHtml = [];

try {
    // ── 1. A comparison with nothing to compare ───────────────────────────
    // The exact shape that shipped "Option A vs Option B" in a real video.
    {
        const html = renderPlan([mg({
            text: 'The ground stays the same temperature all year',
            subtext: 'Six feet down, the soil never swings with the seasons.',
        })]);
        allHtml.push(html);
        check(!HAS_VS_SPLIT.test(html),
            'a comparison with no two sides still drew the VS split');
        check(html.includes('The ground stays the same temperature all year'),
            'the degraded comparison lost the headline it actually had');
    }

    // ── 2. A real two-sided comparison must STILL be a comparison ─────────
    // Without this, "never invent sides" could be satisfied by never drawing
    // a comparison at all. Taken verbatim from the 2026-08-05 build.
    {
        const html = renderPlan([mg({
            text: 'Surface Temperature vs 6 Feet Underground',
            subtext: 'Below six feet the ground temperature locks in.',
        })]);
        allHtml.push(html);
        check(HAS_VS_SPLIT.test(html),
            'a genuine "A vs B" headline no longer renders as a comparison');
        check(html.includes('Surface Temperature') && html.includes('6 Feet Underground'),
            'the comparison dropped one of its two real sides');
    }

    // ── 3. Two sides can also come from items, not just the word "vs" ─────
    {
        const html = renderPlan([mg({
            text: 'Cooling efficiency',
            items: [{ label: 'Earth tube' }, { label: 'Conventional AC' }],
        })]);
        allHtml.push(html);
        check(HAS_VS_SPLIT.test(html),
            'two real items no longer count as two comparison sides');
        check(html.includes('Earth tube') && html.includes('Conventional AC'),
            'the item-driven comparison lost its labels');
    }

    // ── 4. Motion QA safe layout obeys the same rule ──────────────────────
    // Safe layout is the path a graphic takes when Motion QA has already
    // rejected its animation — the most likely place for a bad card to slip
    // out, and historically a second copy of the same placeholder bug.
    {
        const html = renderPlan([mg({
            text: 'The ground stays the same temperature all year',
            subtext: 'Six feet down, the soil never swings with the seasons.',
            motionQaSafeLayout: true,
            motionQaSafeLayoutReason: 'honesty fixture',
        })]);
        allHtml.push(html);
        check(!/safe-comparison-grid/.test(html),
            'the safe-layout path still drew a VS split with no two sides');
        check(/data-hf-safe-layout="1"/.test(html),
            'the safe-layout fixture did not take the safe-layout path at all');
    }
    {
        const html = renderPlan([mg({
            text: 'Surface Temperature vs 6 Feet Underground',
            motionQaSafeLayout: true,
            motionQaSafeLayoutReason: 'honesty fixture',
        })]);
        allHtml.push(html);
        check(/safe-comparison-grid/.test(html),
            'the safe-layout path stopped rendering genuine comparisons');
    }

    // ── 5. No copy at all ⇒ draw nothing, not a card wearing its type name ─
    {
        const html = renderPlan([mg({ text: '', subtext: '' })]);
        allHtml.push(html);
        check(/data-hf-empty="1"/.test(html),
            'a graphic with no text, no subtext and no items did not suppress itself');
        check(!/>\s*comparison-card\s*</.test(html),
            'the renderer printed a graphic type name as if it were a headline');
        check(html.includes('Underlying footage scene') || /hf-scene/.test(html),
            'suppressing an empty graphic also removed the footage underneath it');
    }

    // ── 6. No invented string may appear in ANY generated page ────────────
    const BANNED = [
        [/Option A/, '"Option A" placeholder'],
        [/Option B/, '"Option B" placeholder'],
        [/Map data/, '"Map data" placeholder chip'],
        [/>Item \d+</, '"Item N" fabricated list label'],
    ];
    for (const html of allHtml) {
        for (const [pattern, label] of BANNED) {
            check(!pattern.test(html), `a generated page still contains the ${label}`);
        }
    }

    // ── 7. Source anchors for what HTML cannot show ───────────────────────
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'render', 'hyperframes-bridge.js'), 'utf8');
    // Comments are stripped first. The rules that killed these placeholders are
    // documented in the source BY NAMING them, so a raw text search would be
    // permanently tripped by its own explanation.
    const bridgeCode = bridgeSrc
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
        .join('\n');
    check(!/'Option A'|"Option A"|'Option B'|"Option B"/.test(bridgeCode),
        'the Option A/Option B placeholder literals are back in the bridge source');
    check(!/`Item \$\{index \+ 1\}`/.test(bridgeCode),
        'the fabricated `Item N` label is back in normalizeItem');
    check(!/'Map data'/.test(bridgeCode),
        'the fabricated "Map data" chip is back in buildFallbackMap');

    const comparisonFn = bridgeSrc.slice(
        bridgeSrc.indexOf('function comparisonContent('),
        bridgeSrc.indexOf('function normalizeItem(')
    );
    check(comparisonFn.length > 0, 'could not locate comparisonContent in the bridge');
    check(/ok:\s*Boolean\(left && right\)/.test(comparisonFn),
        'comparisonContent no longer reports honestly whether it has two real sides');

    // Both call sites must gate on that answer — not one of them.
    const gated = (bridgeSrc.match(/if \(comparison && comparison\.ok\)/g) || []).length;
    check(gated === 2,
        `expected both comparison call sites to gate on comparison.ok, found ${gated}`);
} catch (err) {
    failures.push(`fixture crashed: ${err && err.message ? err.message : err}`);
} finally {
    for (const root of roots) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
}

if (failures.length) {
    console.error(`graphic-content-honesty: FAILED (${failures.length}/${checks})`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log(`graphic-content-honesty: OK (${checks} checks)`);
