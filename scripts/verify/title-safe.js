#!/usr/bin/env node
/**
 * title-safe.js — proves the pixel linter's title-safe rule measures YouTube's
 * player and not a television from 1985.
 *
 * The rule this guards (`hf-visual-lint.js`) is the only check in the project
 * that catches a failure the author can NEVER see: a graphic that is perfectly
 * composed inside 1920x1080 and still unreadable, because YouTube paints its
 * progress bar, control row and mobile title bar on top of the frame after it
 * leaves here. The preview does not draw those, so nothing else will ever
 * notice.
 *
 * Which makes the tuning the whole risk. Set the bands too generously and every
 * lower-third in the project gets flagged — a rule that argues with correct
 * design is switched off inside a week and then protects nothing. Set them too
 * tightly and text keeps shipping under the scrubber. So every case below is
 * asserted in BOTH directions on the same geometry, and the well-made
 * lower-third is the most important assertion in the file: it is the one that
 * fails if someone "improves" the rule by copying the broadcast 5% margin.
 *
 * Needs headless Chrome. Skips loudly (exit 0) without it, exactly as the
 * module itself fails open — a machine with no browser must not turn a green
 * gate red, but it must also not pretend it verified anything.
 *
 * Kill switch: HF_TITLE_SAFE_VERIFY=0
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { visualLint, closeVisualLint, TITLE_SAFE } = require(path.join(ROOT, 'src', 'render', 'hf-visual-lint'));

if (String(process.env.HF_TITLE_SAFE_VERIFY || '').trim() === '0') {
    console.log('title-safe: SKIPPED (HF_TITLE_SAFE_VERIFY=0)');
    process.exit(0);
}

let failed = 0;
function fail(msg) { console.error(`\n  FAIL  ${msg}\n`); failed++; process.exitCode = 1; }
function ok(msg) { console.log(`    · ${msg}`); }

// ── Sanity on the numbers themselves ───────────────────────────────────────
//
// Cheap, browser-free, and it catches the specific regression this file exists
// to prevent: someone replacing the measured player bands with the flat
// broadcast margin. A 5% TV-safe rule would be 54px top and 96px on each side.
if (!TITLE_SAFE || !Number.isFinite(TITLE_SAFE.bottomPx)) {
    fail('hf-visual-lint no longer exports TITLE_SAFE — the bands cannot be verified');
} else {
    if (!(TITLE_SAFE.bottomPx > TITLE_SAFE.topPx)) {
        fail(`the bottom band (${TITLE_SAFE.bottomPx}px) is not heavier than the top (${TITLE_SAFE.topPx}px) — YouTube's controls live at the bottom, so a symmetric rule is measuring the wrong player`);
    } else ok(`bands are player-shaped: bottom ${TITLE_SAFE.bottomPx}px > top ${TITLE_SAFE.topPx}px > sides ${TITLE_SAFE.edgePx}px`);
    if (!(TITLE_SAFE.edgePx < TITLE_SAFE.topPx)) {
        fail(`the side margin (${TITLE_SAFE.edgePx}px) is not lighter than the top — YouTube never crops horizontally, so wide side margins are a TV rule with no reason to be here`);
    } else ok('side margin stays the lightest — nothing is cropped horizontally on YouTube');
    if (TITLE_SAFE.bottomLine !== 1080 - TITLE_SAFE.bottomPx) {
        fail(`bottomLine ${TITLE_SAFE.bottomLine} does not match 1080 - ${TITLE_SAFE.bottomPx} — the two constants have drifted apart`);
    }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const CSS = `
.ns-box { position:absolute; font-family: Georgia, serif; font-size: 40px; color:#fff; }
.ns-plate { position:absolute; background:#111; }
`;
const TL = `tl.set('.ns-box',{opacity:0}); tl.to('.ns-box',{opacity:1,duration:0.4});`;

/** left/top/width in px → an absolutely positioned line of text. */
function box(left, top, text, extra = '') {
    return `<div class="ns-box" style="left:${left}px; top:${top}px; ${extra}">${text}</div>`;
}

async function run(label, html, css = CSS) {
    const res = await visualLint({ html, css, timeline: TL }, 'ns', 4, { kind: 'fullscreen' });
    if (res.skipped) return null;
    return res.errors.filter(e => /title bar|controls|frame edge/.test(e));
}

(async () => {
    const probe = await run('probe', box(400, 400, 'Probe'));
    if (probe === null) {
        console.log('title-safe: SKIPPED — headless Chrome unavailable, so the pixel rule could not be exercised');
        console.log('    (the module fails open the same way; this is a capability gap, not a pass)');
        await closeVisualLint();
        process.exit(0);
    }

    const cases = [
        // [label, html, mustFire, why this case exists]
        ['text sitting on the progress bar',
            box(200, 1010, 'Sat on the scrubber'), true,
            'this is the failure the rule exists for'],

        ['a well-made lower-third at 880px',
            box(140, 880, 'Dr. Elena Marsh') + box(140, 940, 'Marine biologist'), false,
            'THE load-bearing assertion — a broadcast 5% rule would flag this correct design'],

        ['text just clearing the band at 995px',
            box(200, 940, 'Just clear'), false,
            'the boundary must be usable, not merely defined'],

        ['text under the mobile title bar',
            box(200, 20, 'Under the title bar'), true,
            'the top band is lighter but real'],

        ['a headline starting at 120px',
            box(200, 120, 'A normal headline'), false,
            'normal top placement must never be touched'],

        ['text hugging the left edge',
            box(8, 500, 'Hugging the edge'), true,
            'rounded corners and phone cut-ins eat this'],

        ['text at a comfortable 120px inset',
            box(120, 500, 'Comfortable inset'), false,
            'a 5% TV margin would be 96px, so 120px must pass under any sane rule'],

        ['a full-bleed panel with no text in it',
            `<div class="ns-plate" style="left:0; top:0; width:1920px; height:1080px;"></div>` + box(300, 400, 'Headline over a bleed'), false,
            'panels and imagery may bleed — only text is governed'],
    ];

    for (const [label, html, mustFire, why] of cases) {
        const hits = await run(label, html);
        if (hits === null) continue;
        if (mustFire && !hits.length) {
            fail(`${label}: nothing was flagged — ${why}`);
        } else if (!mustFire && hits.length) {
            fail(`${label}: flagged "${hits[0]}" — ${why}`);
        } else {
            ok(`${label}: ${mustFire ? `caught — ${hits[0].slice(0, 96)}` : 'left alone'}`);
        }
    }

    // A graphic that already overflows the frame gets the sharper overflow
    // message instead. Two errors for one mistake just crowds the repair round,
    // and the author fixes the overflow anyway.
    const overflowing = await visualLint(
        { html: box(200, 1200, 'Off the bottom of the world'), css: CSS, timeline: TL },
        'ns', 4, { kind: 'fullscreen' }
    );
    if (!overflowing.skipped) {
        const safeHits = overflowing.errors.filter(e => /controls|title bar|frame edge/.test(e));
        const overflowHits = overflowing.errors.filter(e => /overflows/.test(e));
        if (!overflowHits.length) {
            fail('text pushed off the bottom of the frame was not reported as overflow at all');
        } else if (safeHits.length) {
            fail(`already-overflowing text got a title-safe error too (${safeHits[0]}) — one mistake should produce one message`);
        } else {
            ok('already-overflowing text gets the overflow message only, not both');
        }
    }

    await closeVisualLint();

    if (!failed) {
        console.log(`title-safe: OK — text is held out of YouTube's own chrome (bottom ${TITLE_SAFE.bottomPx}px / top ${TITLE_SAFE.topPx}px / sides ${TITLE_SAFE.edgePx}px) without touching correct low-third design`);
    }
    process.exit(failed ? 1 : 0);
})().catch(async (err) => {
    // An unexpected throw is a real failure — unlike a missing browser, which
    // is handled above.
    console.error(`\n  FAIL  title-safe threw: ${err && err.stack ? err.stack : err}\n`);
    try { await closeVisualLint(); } catch (_) { /* noop */ }
    process.exit(1);
});
