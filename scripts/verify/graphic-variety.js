#!/usr/bin/env node
'use strict';

/**
 * graphic-variety.js — the permanent gate for the MAKERS' self-correction.
 *
 * `video-lint.js` grades the finished sequence and says "this video used the
 * same card five times". This gate guards the other end of the same problem:
 * the code that CHOOSES the cards, so the sameness never gets made in the
 * first place. A judge without a maker fix just produces a well-documented
 * samey video.
 *
 * Both defects it covers were measured, not imagined — see
 * docs/anti-ai-look-baseline.md §3, where `key-takeaway` was 5 of 20 graphics
 * in the real Aug-1 build, the single strongest machine tell on the page:
 *
 *   1. The coverage-rescue picker was a pure duration ladder. Any scene of 3s
 *      or more became a keyTakeaway, every single time, because the function
 *      had no idea what the video had already placed. A monoculture by
 *      construction, not by taste.
 *   2. The AI template selector was handed the already-placed templates and
 *      used only the TIMES inside them, never the types — so it chose every
 *      card blind to every other card. The MG author has had exactly this
 *      awareness (`ALREADY PLACED: …`) for as long as it has existed.
 *
 * A variety fix has a specific failure mode: it can drift into a quota, and a
 * quota is just a different machine tell. So every assertion below checks that
 * the correction comes from THIS VIDEO'S OWN distribution and that the
 * behaviour on an empty video is unchanged, byte for byte.
 *
 * Zero AI, zero network, zero browser. The one AI call in the file is stubbed
 * so the real prompt can be inspected without paying for it.
 *
 * Kill switch: HF_GRAPHIC_VARIETY=0 (project convention).
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

if (String(process.env.HF_GRAPHIC_VARIETY || '').trim() === '0') {
    console.log('graphic-variety: skipped (HF_GRAPHIC_VARIETY=0)');
    process.exit(0);
}

// Capture the prompt the template selector builds WITHOUT calling a model.
//
// ai-templates destructures `callAI` once at module load, so the stub has to be
// installed before that require runs — and once it is, the module holds the
// stub for the life of this process. That is exactly what a gate wants: no
// path through this file can reach a real model, so it can never bill.
const aiProvider = require(path.join(ROOT, 'src', 'brain', 'ai-provider'));
const prompts = [];
aiProvider.callAI = async (prompt) => { prompts.push(String(prompt || '')); return ''; };

const templates = require(path.join(ROOT, 'src', 'agents', 'ai-templates'));
const {
    TEMPLATE_REGISTRY,
    COVERAGE_TEMPLATE_LADDER,
    _pickCoverageTemplateType,
} = templates;

let failures = 0;
function fail(message) {
    console.error(`\n  FAIL  ${message}`);
    failures++;
    process.exitCode = 1;
}
function ok(message) { console.log(`    · ${message}`); }

// ── 1: the ladder is still a duration ladder ───────────────────────────────
// The variety fix must not have quietly become the only rule. A card the scene
// is too short to hold is still ineligible, whatever the distribution says.
{
    const mins = COVERAGE_TEMPLATE_LADDER.map(t => Number(TEMPLATE_REGISTRY[t]?.minDur));
    if (mins.some(m => !Number.isFinite(m) || m <= 0)) {
        fail(`a coverage card has no usable minDur: ${COVERAGE_TEMPLATE_LADDER.join(', ')} → ${mins.join(', ')}`);
    }
    const longest = COVERAGE_TEMPLATE_LADDER[0];
    const tooShort = Number(TEMPLATE_REGISTRY[longest].minDur) - 0.2;
    // Heavily biased against the short cards, so only ineligibility can keep
    // the long one out.
    const biased = { chapterCard: 9, locationCard: 9 };
    if (_pickCoverageTemplateType(tooShort, biased) === longest) {
        fail(`a ${tooShort}s scene was given ${longest}, which needs ${TEMPLATE_REGISTRY[longest].minDur}s — variety overrode the duration floor`);
    } else {
        ok('a scene too short for a card still cannot be given that card, however unused it is');
    }

    const fallbackCard = COVERAGE_TEMPLATE_LADDER[COVERAGE_TEMPLATE_LADDER.length - 1];
    if (_pickCoverageTemplateType(0.1, {}) !== fallbackCard) {
        fail('when nothing fits, the picker no longer hands back the shortest card for the timing guard to reject');
    } else {
        ok('when no card fits at all, the old hand-back is unchanged');
    }
}

// ── 2: an empty video behaves exactly as it did before ─────────────────────
// The whole point of first-wins tie-breaking. If this drifts, the fix has
// started changing videos it had no evidence to change.
{
    const first = _pickCoverageTemplateType(6, {});
    if (first !== 'keyTakeaway') {
        fail(`the first coverage card on an empty video changed from keyTakeaway to ${first} — that is a behaviour change with no measurement behind it`);
    } else {
        ok('the first coverage card on an empty video is still keyTakeaway (behaviour preserved)');
    }
}

// ── 3: the measured defect — four rescues no longer make four of the same ──
{
    const placed = {};
    const picked = [];
    for (let i = 0; i < 6; i++) {
        const type = _pickCoverageTemplateType(6, placed);
        picked.push(type);
        placed[type] = (placed[type] || 0) + 1;
    }
    const distinct = new Set(picked).size;
    if (distinct < COVERAGE_TEMPLATE_LADDER.length) {
        fail(`six coverage rescues produced only ${distinct} distinct card(s): ${picked.join(', ')} — this is the measured 5×key-takeaway defect`);
    } else {
        ok(`six coverage rescues now rotate across all ${distinct} eligible cards: ${picked.join(', ')}`);
    }
    // Counted across every ELIGIBLE card, zeros included — otherwise a picker
    // that returned one card six times would score a perfect spread of 0 and
    // this assertion would congratulate the very defect it exists to catch.
    const counts = {};
    for (const t of COVERAGE_TEMPLATE_LADDER) counts[t] = 0;
    for (const t of picked) counts[t] = (counts[t] || 0) + 1;
    const spread = Math.max(...Object.values(counts)) - Math.min(...Object.values(counts));
    if (spread > 1) {
        fail(`the rotation is lopsided (${JSON.stringify(counts)}) — least-used should never fall more than one behind`);
    } else {
        ok('the rotation stays balanced: least-used never falls more than one card behind');
    }
}

// ── 4: the correction reads the WHOLE video, not just coverage rescues ─────
// This is the part a per-type counter local to the rescue loop would get
// wrong. The tally handed in covers the listicle grid and every earlier direct
// build too, so a video whose AI pass already chose two takeaway cards gets
// something else here without anyone having to say so.
{
    const type = _pickCoverageTemplateType(6, { keyTakeaway: 2 });
    if (type === 'keyTakeaway') {
        fail('a video that had already placed two keyTakeaways was given a third — the picker is not reading the video-wide tally');
    } else {
        ok(`a video already carrying two keyTakeaways gets ${type} instead, with no cap or quota anywhere`);
    }
    // …and the same tally, arranged differently, must move the answer again.
    // A fixed rotation order would pass the test above and fail this one.
    const other = _pickCoverageTemplateType(6, { keyTakeaway: 2, chapterCard: 3 });
    if (other === type) {
        fail(`the picker returned ${other} for two different distributions — it is rotating on a fixed order, not on what the video actually did`);
    } else {
        ok(`change the video's own distribution and the answer changes with it (${type} → ${other})`);
    }
}

// ── 5: the AI selector can now see what is already on screen ───────────────
async function selectorPrompt(existingTemplates) {
    prompts.length = 0;
    const scene = {
        index: 4, startTime: 40, endTime: 46, duration: 6,
        text: 'The reservoir lost four fifths of its volume in a single decade.',
    };
    const candidate = {
        sceneIndex: 4, startTime: 40, endTime: 46, scene,
        hintType: 'statCard', hintContent: '', selectionMode: 'editor-agent-candidate',
    };
    await templates._aiSelectTemplates(
        [candidate], [scene],
        { format: 'documentary', summary: 'water', totalDuration: 120 },
        [], [], existingTemplates, 'standard', 'explainer.nature', 2, ''
    );
    return prompts[0] || '';
}

(async () => {
    const MARKER = 'ALREADY ON SCREEN IN THIS VIDEO';

    const empty = await selectorPrompt([]);
    if (!empty) {
        fail('the template selector never built a prompt — the gate is measuring nothing');
    } else if (empty.includes(MARKER)) {
        fail('a video with nothing placed yet was told what was already on screen — the empty-video prompt is no longer unchanged');
    } else {
        ok('a video with nothing placed yet gets the prompt it always got, unchanged');
    }

    const loaded = await selectorPrompt([
        { type: 'keyTakeaway' }, { type: 'keyTakeaway' }, { type: 'chapterCard' },
    ]);
    if (!loaded.includes(MARKER)) {
        fail('the selector is still choosing cards blind to the cards this video has already placed — the measured defect is unfixed');
    } else {
        ok('the selector is now told what this video has already placed');
    }
    if (!/keyTakeaway\s*×2/.test(loaded)) {
        fail(`the repeat count is missing, so "used once" and "used twice" read the same: ${loaded.split(MARKER)[1]?.split('\n')[0]}`);
    } else {
        ok('the repeated card is named with its count, so the model can tell a habit from a single use');
    }
    if (!/do not use it again/i.test(loaded)) {
        fail('the dominant card is reported but never actually discouraged');
    } else {
        ok('the card this video has leaned on hardest is explicitly discouraged, by name');
    }
    // The line must be evidence, not a rule. If it ever hardcodes WHICH card is
    // over-used, it stops working the moment a video over-uses a different one.
    let followsEvidence = true;
    for (const t of ['keyTakeaway', 'chapterCard', 'locationCard']) {
        const only = await selectorPrompt([{ type: t }, { type: t }]);
        if (!only.includes(`${t} ×2`)) {
            fail(`the over-use warning does not follow the evidence for ${t} — it is pinned to one card type`);
            followsEvidence = false;
            break;
        }
    }
    if (followsEvidence) {
        ok('the warning names whichever card the video actually over-used, not a card chosen in advance');
    }

    if (failures === 0) {
        console.log('graphic-variety: OK — the coverage picker and the template selector both correct against this video\'s own distribution, and an empty video is untouched');
    } else {
        console.error(`graphic-variety: ${failures} failure(s)`);
    }
})();
